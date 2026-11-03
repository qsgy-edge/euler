import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { scopeCaptureResponder } from './support/scope-capture-http.ts';
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

test('ordinary CLI continues an unbound raw owner agreement after binding without asking for agreement again', async () => {
  const sandbox = createSessionSandbox(randomUUID(), randomUUID()), directory = mkdtempSync(join(tmpdir(), 'euler-scope-agreement-'));
  const clients: ReturnType<typeof startCli>[] = [];
  let requests = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume the actual foreground request. */ }
    requests++;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '建议记住偏好：T55 agreed examples stay concise.' }, finish_reason: 'stop' }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const start = (args: string[]) => {
    const cli = startCli(['session', '--sandbox', sandbox.root, ...args], 150000, undefined,
      { ...process.env, EULER_SCOPE_TEST_KEY: 'synthetic-scope-only' });
    clients.push(cli); return cli;
  };
  try {
    const config = join(directory, 'route.json');
    writeFileSync(config, JSON.stringify({ provider: 'fixture', model: 'scope-agreement',
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, authNamespace: 'synthetic',
      credentialEnv: 'EULER_SCOPE_TEST_KEY', contextWindow: 32000, maxTokens: 1024, authorization: 'synthetic-test-only', budget: AGENT_BUDGET }));
    const cli = start(['--transport-config', config]); await cli.waitFor('session-ready');
    await sendCommand(cli, 'Propose a synthetic preference to remember.', 'session-result');
    const agreement = '  同意  ';
    const pending = await sendCommand(cli, agreement, 'remember-result');
    assert.equal(pending.reason, 'scope-unresolved');
    const bind = '/bind ' + JSON.stringify({ projectId: randomUUID(), root: null });
    await sendCommand(cli, bind, 'session-bound');
    await sendCommand(cli, '/drain', 'session-drained');
    const page = await sendCommand(cli, '/memory concise', 'session-memory');
    assert.deepEqual((page.results as { unitId: string }[]).map(item => item.unitId), [pending.recordId], JSON.stringify({ page, errors: cli.observations.filter(item => item.event === 'capture-error') }));
    assert.equal((await sendCommand(cli, `source ${pending.recordId}`, 'memory-source')).text, agreement);
    assert.equal(((await sendCommand(cli, '/info', 'info-list')).rows as unknown[]).length, 1);
    assert.equal(requests, 1);
    cli.command('/exit'); assert.equal((await cli.exit).code, 0);
    const reopened = start([]); await reopened.waitFor('session-ready');
    await sendCommand(reopened, bind, 'session-bound');
    await sendCommand(reopened, '/drain', 'session-drained');
    assert.deepEqual(((await sendCommand(reopened, '/memory concise', 'session-memory')).results as { unitId: string }[]).map(item => item.unitId), [pending.recordId]);
    assert.equal(((await sendCommand(reopened, '/info', 'info-list')).rows as unknown[]).length, 1);
    assert.equal(requests, 1);
    reopened.command('/exit'); assert.equal((await reopened.exit).code, 0);
  } finally {
    for (const cli of clients) if (cli.child.exitCode === null && cli.child.signalCode === null) { cli.child.kill(); await cli.exit; }
    server.closeAllConnections(); const closed = once(server, 'close'); server.close(); await closed;
    rmSync(sandbox.root, { recursive: true, force: true }); rmSync(directory, { recursive: true, force: true });
  }
});

test('ordinary CLI resumes untyped capture through HTTP proposal and independent raw-source verification after binding', async () => {
  const sandbox = createSessionSandbox(randomUUID(), randomUUID()), directory = mkdtempSync(join(tmpdir(), 'euler-scope-http-'));
  const clients: ReturnType<typeof startCli>[] = [], requests: string[] = [];
  const claim = 'T55 rawscope verification keeps original evidence.';
  const server = createServer(scopeCaptureResponder(claim, body => { requests.push(body); }));
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
