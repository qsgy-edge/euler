import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { SourceAck } from '@euler/core';
import { AGENT_BUDGET } from '../src/agent-cli.ts';
import { startCli, sendCommand } from '../src/process-driver.ts';
import { createSandbox, createSessionSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';
import { deliverMemoryInfo, openOwnerInfo, OwnerMemoryHost } from '../src/owner-memory.ts';

test('background continuation requires an available durable Info carrier even before the first activation', () => {
  const sandbox = createSandbox(), probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    rmSync(join(sandbox.root, 'owner-info.jsonl'));
    assert.equal(deliverMemoryInfo(sandbox, probe), false);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('an existing Host detects a missing Info carrier before its first background activation', () => {
  const sandbox = createSandbox(), probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const host = new OwnerMemoryHost(probe, openOwnerInfo(sandbox, probe), 'success', false);
    assert.notEqual(host.log, null);
    rmSync(join(sandbox.root, 'owner-info.jsonl'));
    assert.equal(host.deliver(), false);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('ordinary CLI resumes untyped capture through HTTP proposal and independent raw-source verification after binding', async () => {
  const sandbox = createSessionSandbox(randomUUID(), randomUUID()), directory = mkdtempSync(join(tmpdir(), 'euler-scope-http-'));
  const clients: ReturnType<typeof startCli>[] = [], requests: string[] = [];
  const claim = 'T55 rawscope verification keeps original evidence.';
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    requests.push(body);
    const { messages } = JSON.parse(body);
    const tail = JSON.parse(messages.at(-1).content);
    const results = messages.filter((message: { role: string }) => message.role === 'tool')
      .map((message: { content: string }) => JSON.parse(JSON.parse(message.content).result));
    const expanded = results.find((result: { ref?: SourceAck; text?: string }) => result.ref && typeof result.text === 'string');
    const search = results.find((result: { results?: unknown[] }) => result.results);
    const call = tail.intent.step === 'proposer' || expanded ? null : search
      ? { name: 'source_expand', arguments: JSON.stringify({ eventId: search.results[0].ref.eventId, offset: 0, limit: 4096 }) }
      : { name: 'source_search', arguments: JSON.stringify({ query: 'rawscope' }) };
    const content = call ? null : tail.intent.step === 'proposer'
      ? JSON.stringify({ type: 'decision', content: claim }) : JSON.stringify({ result: 'pass', evidence: [expanded.ref] });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content,
      ...(call ? { tool_calls: [{ id: 'scope-' + requests.length, type: 'function', function: call }] } : {}) },
      finish_reason: call ? 'tool_calls' : 'stop' }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const start = (args: string[]) => {
    const cli = startCli(['session', '--sandbox', sandbox.root, ...args], 150000, undefined,
      { ...process.env, EULER_SCOPE_TEST_KEY: 'synthetic-scope-only' });
    clients.push(cli); return cli;
  };
  try {
    const initial = start([]); await initial.waitFor('session-ready');
    await sendCommand(initial, '记住：' + claim, 'remember-result');
    await sendCommand(initial, '/bind ' + JSON.stringify({ projectId: randomUUID(), root: null }), 'session-bound');
    initial.command('/exit'); assert.equal((await initial.exit).code, 0);
    const config = join(directory, 'route.json');
    writeFileSync(config, JSON.stringify({ provider: 'fixture', model: 'scope-capture',
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, authNamespace: 'synthetic',
      credentialEnv: 'EULER_SCOPE_TEST_KEY', contextWindow: 32000, maxTokens: 1024, authorization: 'synthetic-test-only',
      captureCapability: 'standard', budget: { ...AGENT_BUDGET, maxModelAttempts: 8, maxTotalTokens: 256000 } }));
    const active = start(['--capture-config', config]); await active.waitFor('session-ready');
    const drained = await sendCommand(active, '/drain', 'session-drained');
    const job = (drained.capture as { record: { recordId: string; lifecycle: string; source: SourceAck }; stage: string }[])[0]!;
    assert.equal(job.record?.lifecycle, 'active', JSON.stringify(drained));
    assert.equal(job.record.source.binding.projectId, null);
    assert.equal(requests.length, 4);
    assert.equal(((await sendCommand(active, '/memory rawscope', 'session-memory')).results as unknown[]).length, 1);
    assert.equal(((await sendCommand(active, '/info', 'info-list')).rows as unknown[]).length, 1);
    active.command('/exit'); assert.equal((await active.exit).code, 0);
    const reopened = start([]); await reopened.waitFor('session-ready');
    await sendCommand(reopened, '/drain', 'session-drained');
    assert.equal(((await sendCommand(reopened, '/memory rawscope', 'session-memory')).results as { unitId: string }[])[0]!.unitId, job.record.recordId);
    assert.equal(((await sendCommand(reopened, '/info', 'info-list')).rows as unknown[]).length, 1);
    assert.equal(requests.length, 4);
    reopened.command('/exit'); assert.equal((await reopened.exit).code, 0);
  } finally {
    for (const cli of clients) if (cli.child.exitCode === null && cli.child.signalCode === null) { cli.child.kill(); await cli.exit; }
    server.closeAllConnections(); const closed = once(server, 'close'); server.close(); await closed;
    rmSync(sandbox.root, { recursive: true, force: true }); rmSync(directory, { recursive: true, force: true });
  }
});
