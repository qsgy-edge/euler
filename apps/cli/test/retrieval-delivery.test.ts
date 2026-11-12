import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { AgentRun, sha256, type RequestStatus } from '@euler/core';
import type { Model } from '@earendil-works/pi-ai';
import { bindingOf, createSandbox, createSandboxSession, createSessionSandbox } from '../src/sandbox.ts';
import { AGENT_BUDGET } from '../src/agent-cli.ts';
import { openMaintenanceStore } from '../src/backup.ts';
import { openProbe } from '../src/probe.ts';
import { sendCommand, startCli } from '../src/process-driver.ts';
import { readPurgeCarriers } from '../src/purge.ts';
import { HttpModelTransport } from '../src/model-transport.ts';
import { pumpAgent } from '../src/agent-pump.ts';
import { retrievalBudget, retrievalFixture as fixture } from './support/retrieval-fixture.ts';
import { approvedSourceUnit } from './support/source-publication.ts';

test('retrieval receipts stay outside model data while actual frozen delivery gets a bound selection', () => {
  const f = fixture();
  try {
    const result = f.search();
    assert.equal(JSON.parse(result.modelResult).retrieval, undefined);
    f.run.finishTool('find-memory', result.modelResult, result.outcome);
    const receipt = f.run.status().tools[0]!.result!.retrieval!;
    assert.equal(receipt.schema, 'memory-retrieval-tool@1');
    assert.equal(receipt.resultHash, sha256(result.modelResult));
    const next = f.run.nextModel()!;
    assert.equal(next.payload.includes('memory-retrieval@1'), false);
    assert.equal(next.payload.includes('memory-delivery@1'), false);
    assert.equal(next.payload.includes(f.record.content), true);
    const assemblies = f.probe.store.requestStatus(f.probe.activity, f.run.runId).assemblies;
    assert.ok(assemblies[0]!.selection.every(item => item.retrieval === undefined));
    const selected = assemblies[1]!.selection.find(item => item.retrieval)!;
    assert.equal(selected.retrieval!.queryHash, sha256('Juniper'));
    assert.equal(selected.retrieval!.resultHash, sha256(result.modelResult));
    assert.equal(selected.retrieval!.returned[0]!.recordId, f.record.recordId);
    assert.equal(selected.retrieval!.returned[0]!.measurement.tokens, 'unsupported');
    const forged = structuredClone(assemblies[1]!);
    forged.selection.find(item => item.retrieval)!.retrieval!.resultHash = '0'.repeat(64);
    assert.throws(() => f.probe.store.appendRequestAssembly(f.probe.activity, { ...forged, payload: next.payload }), /assembly-retrieval-mismatch/);
  } finally { f.close(); }
});

test('a returned retrieval cancelled before the next assembly is recorded without a delivery selection', () => {
  const f = fixture();
  try {
    const result = f.search();
    assert.throws(() => f.run.finishTool('find-memory', result.modelResult + ' '), /retrieval-result-mismatch/);
    f.run.finishTool('find-memory', result.modelResult, result.outcome);
    f.run.cancel();
    const ledger = f.probe.store.requestStatus(f.probe.activity, f.run.runId);
    assert.equal(f.run.status().tools[0]!.result!.retrieval!.returned.length, 1);
    assert.equal(ledger.assemblies.length, 1);
    assert.ok(ledger.assemblies.every(assembly => assembly.selection.every(item => item.retrieval === undefined)));
    assert.equal(f.run.nextModel(), null);
  } finally { f.close(); }
});

test('actual HTTP tool bytes match retrieval delivery while audit metadata stays outside the wire request', async () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox, retrievalBudget, undefined, undefined, undefined, true);
  const bodies: string[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    bodies.push(body);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: bodies.length === 1
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'http-memory', type: 'function',
        function: { name: 'memory_search', arguments: '{"query":"Juniper"}' } }] }
      : { role: 'assistant', content: 'Use the local compiler.' }, finish_reason: bodies.length === 1 ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 999, completion_tokens: 5 } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const record = probe.store.rememberMemory(probe.activity, {
      input: probe.archive.append(randomUUID(), '记住偏好：Juniper uses the local compiler'), hostInfo: 'durable',
    }).record;
    probe.store.drainSearchProjection(probe.activity);
    const model: Model<'openai-completions'> = { api: 'openai-completions', provider: 'fixture', id: 'retrieval-http', name: 'Fixture',
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: retrievalBudget.contextLimit, maxTokens: 1024 };
    const transport = new HttpModelTransport(model, retrievalBudget, () => 'synthetic-header');
    const run = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive,
      encode: request => transport.encode(request) },
    { provider: model.provider, model: model.id, route: model.baseUrl, authNamespace: 'synthetic' }, retrievalBudget);
    run.receive(randomUUID(), 'Find the Juniper compiler preference');
    await pumpAgent(run, { stream: (request, signal, send) => transport.stream(request, signal, send),
      async execute() { throw new Error('unexpected Host tool'); } });
    assert.equal(run.status().terminal, 'completed'); assert.equal(bodies.length, 2);
    const ledger = probe.store.requestStatus(probe.activity, run.runId);
    for (const [ordinal, body] of bodies.entries()) {
      assert.equal(ledger.attempts[ordinal]!.payloadHash, sha256(body));
      assert.equal(ledger.attempts[ordinal]!.byteLength, Buffer.byteLength(body));
      assert.doesNotMatch(body, /memory-retrieval@1|memory-delivery@1|utf8-json-search-result@1/);
    }
    const wire = JSON.parse(bodies[1]!);
    const tool = wire.messages.find((message: { role: string }) => message.role === 'tool');
    const modelResult = JSON.parse(tool.content).result;
    const delivery = ledger.assemblies[1]!.selection.find(item => item.retrieval)!.retrieval!;
    assert.equal(delivery.resultHash, sha256(modelResult));
    assert.equal(delivery.returned[0]!.recordId, record.recordId);
    assert.equal(delivery.returned[0]!.resultHash, sha256(JSON.stringify(JSON.parse(modelResult).results[0])));
    assert.equal(delivery.returned[0]!.measurement.tokens, 'unsupported');
    assert.equal(delivery.returned[0]!.measurement.cost, 'unknown');
  } finally {
    server.closeAllConnections(); server.close(); await once(server, 'close');
    probe.close(); rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test('ordinary CLI delivers single-Han memory and published sources within the current grant', async t => {
  const sandbox = createSessionSandbox(randomUUID(), randomUUID());
  t.after(() => rmSync(sandbox.root, { recursive: true, force: true }));
  const allowed = randomUUID(), other = randomUUID();
  const seed = (projectId: string, text: string) => {
    const binding = { ...bindingOf(sandbox), projectId, sessionId: randomUUID(), branchId: randomUUID() };
    createSandboxSession(sandbox, binding);
    const probe = openProbe(sandbox, undefined, undefined, binding, undefined, true);
    try {
      const input = probe.archive.append(randomUUID(), `记住决定：${text}`, 'user');
      const record = probe.store.rememberMemory(probe.activity, { input, hostInfo: 'durable' }).record!;
      const ref = probe.archive.append(randomUUID(), `${text}\n榆树-UNPUBLISHED-TAIL`, 'assistant');
      const unit = probe.store.publishSourceUnit(probe.activity, approvedSourceUnit(probe, {
        ref, projectId, kind: 'source', offset: 0, length: Array.from(text).length,
      }));
      probe.store.drainSearchProjection(probe.activity);
      probe.store.drainSourceProjection(probe.activity);
      return { recordId: record.recordId, unitId: unit.unitId };
    } finally { probe.close(); }
  };
  const granted = seed(allowed, '河岸标识为榆'), excluded = seed(other, '榆桥-EXCLUDED-PROJECT');
  const args = { query: '榆', mode: 'single-han' };
  const bodies: string[] = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    bodies.push(body);
    const toolCalls = bodies.length === 1 ? [
      { id: 'literal-memory', type: 'function', function: { name: 'memory_search', arguments: JSON.stringify(args) } },
      { id: 'literal-source', type: 'function', function: { name: 'source_search', arguments: JSON.stringify({ ...args, scope: 'project' }) } },
    ] : [];
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: toolCalls.length ? null : 'Checked.',
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const path = join(sandbox.root, 'literal-route.json');
  writeFileSync(path, JSON.stringify({ provider: 'fixture', model: 'literal-loopback', baseUrl: `http://127.0.0.1:${address.port}/v1`,
    authNamespace: 'synthetic', credentialEnv: 'EULER_LITERAL_TEST_KEY', contextWindow: 32000, maxTokens: 1024,
    authorization: 'synthetic-test-only', budget: AGENT_BUDGET }));
  const cli = startCli(['session', '--sandbox', sandbox.root, '--transport-config', path], 150000, undefined,
    { ...process.env, EULER_LITERAL_TEST_KEY: 'synthetic-literal-header' });
  try {
    await cli.waitFor('session-ready');
    await sendCommand(cli, '/task Check the authorized riverbank label', 'session-task');
    const grant = await sendCommand(cli, '/grant ' + JSON.stringify({ projectIds: [allowed], targets: {}, maxResults: 16, maxBytes: 65536 }), 'session-grant');
    const result = await sendCommand(cli, 'Find the previously recorded riverbank label and published source.', 'session-result');
    assert.equal(result.terminal, 'completed');
    assert.equal(bodies.length, 2);
    assert.doesNotMatch(bodies[0]!, /河岸标识为榆/);
    const { tools } = JSON.parse(bodies[0]!);
    for (const name of ['memory_search', 'source_search']) {
      const tool = tools.find((item: { function: { name: string } }) => item.function.name === name);
      assert.deepEqual(tool.function.parameters.properties.mode.enum, ['single-han']);
    }
    assert.doesNotMatch(bodies[1]!, /EXCLUDED-PROJECT|UNPUBLISHED-TAIL/);
    assert.ok(!bodies[1]!.includes(excluded.recordId) && !bodies[1]!.includes(excluded.unitId));
    const toolResult = (id: string) => {
      const { messages } = JSON.parse(bodies[1]!);
      const envelope = JSON.parse(messages.find((message: { tool_call_id?: string }) => message.tool_call_id === id).content);
      assert.equal(envelope.outcome, 'success', envelope.result);
      return { raw: envelope.result as string, results: JSON.parse(envelope.result).results as { unitId: string; exposureMode?: string }[] };
    };
    const memory = toolResult('literal-memory'), source = toolResult('literal-source');
    assert.deepEqual(memory.results.map(hit => [hit.unitId, hit.exposureMode]), [[granted.recordId, 'reference_only']]);
    assert.deepEqual(source.results.map(hit => hit.unitId), [granted.unitId]);
    const tail = JSON.parse(JSON.parse(bodies[1]!).messages.findLast((message: { role: string }) => message.role === 'user').content);
    const [recovery] = tail.sourceRecovery.items;
    assert.equal(recovery.recordId, granted.recordId);
    assert.equal(recovery.excerpt.text, '记住决定：河岸标识为榆');
    assert.equal(recovery.excerpt.excerptHash, sha256(recovery.excerpt.text));
    const ledger = result.ledger as RequestStatus;
    assert.equal(ledger.attempts[1]!.payloadHash, sha256(bodies[1]!));
    const delivery = ledger.assemblies[1]!.selection.find(item => item.retrieval)!.retrieval!;
    assert.equal(delivery.resultHash, sha256(memory.raw));
    assert.deepEqual(delivery.returned.map(hit => hit.recordId), [granted.recordId]);
    const ids = (results: unknown) => (results as { unitId: string }[]).map(hit => hit.unitId);
    assert.deepEqual(ids((await sendCommand(cli, '/memory-han 榆', 'session-memory')).results), [granted.recordId]);
    assert.deepEqual(ids((await sendCommand(cli, '/source-search-han 榆', 'session-sources')).results), [granted.unitId]);
    await sendCommand(cli, '/revoke ' + grant.grantId, 'session-grant-revoked');
    assert.deepEqual((await sendCommand(cli, '/memory-han 榆', 'session-memory')).results, []);
    assert.deepEqual((await sendCommand(cli, '/source-search-han 榆', 'session-sources')).results, []);
    assert.equal(bodies.length, 2);
  } finally {
    cli.command('/exit'); cli.child.stdin.end(); await cli.exit;
    server.closeAllConnections(); server.close(); await once(server, 'close');
  }
});

test('candidate traces survive reopen and backup while purge includes an omitted candidate without deleting its sibling', () => {
  const sandbox = createSandbox();
  try {
    const child = spawnSync(process.execPath, ['apps/cli/test/support/retrieval-ledger-worker.ts', sandbox.root], { encoding: 'utf8', timeout: 15000 });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    const saved = JSON.parse(child.stdout.trim());
    assert.match(saved.receiptHash, /^[a-f0-9]{64}$/); assert.match(saved.selectionHash, /^[a-f0-9]{64}$/);
    const store = openMaintenanceStore(sandbox), coordinator = randomUUID();
    try {
      store.beginMaintenance(coordinator);
      const maintenance = store.acquireMaintenance(coordinator);
      assert.equal(maintenance.acquired, true, JSON.stringify(maintenance));
      const preview = store.previewPurge(coordinator, saved.omittedId, readPurgeCarriers(sandbox, store, coordinator));
      assert.deepEqual(preview.manifest.records.map(record => record.recordId), [saved.omittedId]);
      assert.ok(preview.manifest.database.some(item => item.table === 'request_events' && item.count > 0));
      assert.ok(preview.manifest.database.some(item => item.table === 'request_assemblies' && item.count > 0));
      assert.equal(store.cancelPurge(coordinator).status, 'cancelled');
    } finally { store.close(); }
  } finally { rmSync(sandbox.root, { recursive: true, force: true }); }
});
