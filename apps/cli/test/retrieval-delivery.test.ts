import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
import { createServer } from 'node:http';
import test from 'node:test';
import { AgentRun, sha256 } from '@euler/core';
import type { Model } from '@earendil-works/pi-ai';
import { bindingOf, createSandbox } from '../src/sandbox.ts';
import { openMaintenanceStore } from '../src/backup.ts';
import { openProbe } from '../src/probe.ts';
import { readPurgeCarriers } from '../src/purge.ts';
import { HttpModelTransport } from '../src/model-transport.ts';
import { pumpAgent } from '../src/agent-pump.ts';
import { retrievalBudget, retrievalFixture as fixture } from './support/retrieval-fixture.ts';

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
