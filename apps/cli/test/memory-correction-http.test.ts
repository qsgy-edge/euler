import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { DEFAULT_BUDGET } from '@euler/core';
import { startCli } from '../src/process-driver.ts';
import { createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

const prerequisiteFixture = new URL('./support/capture-prerequisite-fixture.mjs', import.meta.url).href;

for (const operation of ['correct', 'forget', 'restore'] as const)
for (const prerequisite of ['accept', 'reject'] as const) test(`the configured CLI HTTP ${operation} path revalidates model intent and sends only bounded terminal summaries: ${prerequisite}`, async () => {
  const sandbox = createSandbox();
  const temp = mkdtempSync(join(tmpdir(), 'euler-correction-http-'));
  let probe = openProbe(sandbox);
  const record = probe.store.rememberMemory(probe.activity, { input: probe.archive.append(randomUUID(), '记住偏好：Original'), hostInfo: 'durable' }).record;
  if (operation === 'restore') probe.store.forgetMemory(probe.activity, record.recordId, record);
  probe.close();
  const bodies: { messages: { role: string; content: string }[];
    tools: { function: { name: string; parameters: { properties: Record<string, unknown> } } }[] }[] = [];
  let token = '';
  const waiting = Promise.withResolvers<void>();
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    bodies.push(JSON.parse(body));
    const index = bodies.length;
    if (index === 7) { waiting.resolve(); return; }
    const name = index === 5 ? 'memory_commit' : 'memory_preview';
    const change = operation === 'correct' ? { content: 'Corrected' } : { operation };
    const args = index === 5 ? { token, ...change } : { recordId: record.recordId, ...change };
    const message = index % 2 === 1 ? { role: 'assistant', content: null, tool_calls: [{ id: `call-${index}`, type: 'function',
      function: { name, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: 'Result received.' };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message, finish_reason: index % 2 ? 'tool_calls' : 'stop' }],
      system: 'untrusted metadata cannot approve', usage: { prompt_tokens: 20, completion_tokens: 10 } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const config = join(temp, 'transport.json');
  writeFileSync(config, JSON.stringify({ provider: 'fixture', model: 'correction-fixture',
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, authNamespace: 'synthetic-test',
    credentialEnv: 'EULER_CORRECTION_TEST_KEY', contextWindow: 32000, maxTokens: 1024, authorization: 'synthetic-test-only',
    budget: { ...DEFAULT_BUDGET, contextLimit: 32000, maxTotalTokens: 128000, maxModelAttempts: 4, maxToolCalls: 4,
      outputReserve: 1024, wallClockMs: 30000 } }));
  const preload = join(temp, 'lookup-fault.mjs');
  writeFileSync(preload, `import { ProbeStore } from ${JSON.stringify(new URL('../../../packages/core/src/store/probe-store.ts', import.meta.url).href)};
if (process.argv.includes('remember') && process.argv.includes(${JSON.stringify(sandbox.root)})) {
  const read = ProbeStore.prototype.memoryOperationStatus;
  let once = true;
  ProbeStore.prototype.memoryOperationStatus = function(...args) {
    const result = read.apply(this, args);
    if (once && result.status === 'committed') {
      once = false;
      process.stdout.write(JSON.stringify({event:'correction-lookup-fault',operationId:result.operationId}) + '\\n');
      throw new Error('injected-post-commit-lookup-failure');
    }
    return result;
  };
}`);
  const cli = startCli(['remember', '--sandbox', sandbox.root, '--transport-config', config], 60000, undefined,
    { ...process.env, EULER_CORRECTION_TEST_KEY: 'synthetic', T13_PREREQUISITE_FIXTURE: prerequisite,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${prerequisiteFixture} --import=${pathToFileURL(preload).href}` });
  async function completed(index: number) {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      const item = cli.observations.filter(row => row.event === 'memory-model-result')[index];
      if (item) { assert.equal(item.terminal, 'completed', JSON.stringify(cli.observations.slice(-4))); return; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`model did not complete: ${JSON.stringify(cli.observations.slice(-5))}; ${cli.stderr()}`);
  }
  try {
    await cli.waitFor('remember-ready');
    cli.command(`model 帮我判断是否应该纠正 ${record.recordId}？`);
    const gate = await cli.waitFor('correction-prerequisites');
    assert.equal(gate.passed, prerequisite === 'accept');
    assert.match((gate.command as string[]).join(' '), /correction-prerequisite-fixture/);
    if (prerequisite === 'reject') {
      assert.equal((await cli.waitFor('memory-result')).reason, 'prerequisite-evidence-gap');
      cli.command('stop'); assert.equal((await cli.exit).code, 0, cli.stderr());
      assert.equal(bodies.length, 0);
      probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
      try {
        assert.equal(probe.store.readMemory(probe.activity, record.recordId).revision, 1);
        assert.equal(probe.store.recoverMemoryOperations(probe.activity).length, 0);
      } finally { probe.close(); }
      return;
    }
    await completed(0);
    assert.equal(cli.observations.find(row => row.event === 'memory-result')!.status, 'not_actionable');
    assert.equal(cli.observations.filter(row => row.event === 'memory-preview').length, 0);
    if (operation !== 'correct') {
      for (const name of ['memory_preview', 'memory_commit']) {
        assert.deepEqual(bodies[0]!.tools.find(tool => tool.function.name === name)!.function.parameters.properties.operation,
          { type: 'string', enum: ['forget', 'restore'] });
      }
    }
    cli.command(`model ${operation} ${record.recordId}${operation === 'correct' ? ' "Corrected"' : ''}`);
    await completed(1);
    token = String(cli.observations.find(row => row.event === 'memory-preview')!.token);
    cli.command(`model commit ${token} ${operation === 'correct' ? '"Corrected"' : operation}`);
    await completed(2);
    assert.equal(cli.observations.filter(row => row.event === 'correction-lookup-fault').length, 1);
    assert.equal(cli.observations.filter(row => row.event === 'memory-result').at(-1)!.canonical, 'committed');
    assert.equal(bodies.length, 6);
    const firstUser = bodies[5]!.messages.find(message => message.role === 'user')!;
    const summary = JSON.parse(firstUser.content).operationSummaries[0];
    assert.equal(summary.status, 'committed');
    assert.equal(summary.kind, operation);
    assert.equal(summary.records[0].verification, operation === 'correct' ? 'unverified' : 'verified');
    assert.equal(summary.records[0].lifecycle, operation === 'forget' ? 'tombstoned' : 'active');
    assert.equal(JSON.stringify(summary).includes('Corrected'), false);
    assert.equal(JSON.stringify(bodies).includes('subjectRef'), false);
    assert.equal(JSON.stringify(bodies).includes('untrusted metadata cannot approve'), false);
    cli.command(`model inspect ${record.recordId}`);
    await waiting.promise;
    cli.command('stop');
    const exit = await Promise.race([cli.exit, new Promise<null>(resolve => { const timer = setTimeout(() => resolve(null), 3000); timer.unref(); })]);
    assert.ok(exit, 'stop must interrupt the outstanding model request');
    assert.equal(exit.code, 0, cli.stderr());
    const cancelled = cli.observations.filter(row => row.event === 'memory-model-result').at(-1)!;
    assert.equal(cancelled.terminal, 'cancelled');
    assert.equal(bodies.length, 7);
    probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    try {
      assert.equal(probe.store.agentStatus(probe.activity, String(cancelled.runId)).terminal, 'cancelled');
      assert.equal(probe.store.requestStatus(probe.activity, String(cancelled.runId)).attempts[0]!.outcome, 'unknown-sent');
      assert.equal(probe.store.readMemory(probe.activity, record.recordId).revision, operation === 'correct' ? 2 : 1);
      assert.equal(probe.store.readMemory(probe.activity, record.recordId).lifecycle, operation === 'forget' ? 'tombstoned' : 'active');
      assert.equal(probe.store.recoverMemoryOperations(probe.activity).length, 1);
    } finally { probe.close(); }
  } finally {
    if (!cli.observations.some(row => row.event === 'process-exit')) { cli.child.kill('SIGKILL'); await cli.exit; }
    server.closeAllConnections(); server.close(); await once(server, 'close');
    rmSync(temp, { recursive: true, force: true }); rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test('stop aborts the first model prerequisite process and sends no HTTP request', async () => {
  const sandbox = createSandbox(), temp = mkdtempSync(join(tmpdir(), 'euler-correction-setup-'));
  let sends = 0;
  const server = createServer((_request, response) => { sends++; response.end('{}'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const config = join(temp, 'transport.json'), preload = join(temp, 'setup.mjs');
  writeFileSync(config, JSON.stringify({ provider: 'fixture', model: 'setup-fixture',
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, authNamespace: 'synthetic-test',
    credentialEnv: 'EULER_CORRECTION_TEST_KEY', contextWindow: 32000, maxTokens: 1024, authorization: 'synthetic-test-only',
    budget: { ...DEFAULT_BUDGET, contextLimit: 32000, maxTotalTokens: 128000, outputReserve: 1024, wallClockMs: 30000 } }));
  writeFileSync(preload, `import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
if (process.argv.includes('remember') && process.argv.includes(${JSON.stringify(sandbox.root)})) {
  const execFile = cp.execFile;
  cp.execFile = (file, args, ...rest) => {
    if (file === process.execPath && args?.includes('apps/cli/test/memory-correction.test.ts')) {
      args.splice(0, args.length, '-e', 'setInterval(() => {}, 1000)');
      const child = execFile(file, args, ...rest);
      process.stdout.write(JSON.stringify({event:'correction-setup-held',pid:child.pid}) + '\\n');
      child.once('close', () => process.stdout.write(JSON.stringify({event:'correction-setup-exited',pid:child.pid}) + '\\n'));
      return child;
    }
    return execFile(file, args, ...rest);
  };
  syncBuiltinESMExports();
}`);
  const cli = startCli(['remember', '--sandbox', sandbox.root, '--transport-config', config], 15000, undefined,
    { ...process.env, EULER_CORRECTION_TEST_KEY: 'synthetic', NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}` });
  let heldPid: number | undefined;
  try {
    await cli.waitFor('remember-ready');
    cli.command(`model inspect ${randomUUID()}`);
    heldPid = Number((await cli.waitFor('correction-setup-held')).pid);
    cli.command('stop');
    const exit = await Promise.race([cli.exit, new Promise<null>(resolve => { const timer = setTimeout(() => resolve(null), 3000); timer.unref(); })]);
    assert.ok(exit, 'stop must terminate the prerequisite child without waiting for its timeout');
    assert.equal(exit.code, 0, cli.stderr());
    assert.ok(cli.observations.some(row => row.event === 'correction-setup-exited' && row.pid === heldPid));
    assert.ok(cli.observations.some(row => row.event === 'memory-model-cancelled' && row.sends === 0));
    assert.equal(sends, 0);
  } finally {
    if (heldPid && !cli.observations.some(row => row.event === 'correction-setup-exited')) {
      try { process.kill(heldPid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    if (!cli.observations.some(row => row.event === 'process-exit')) { cli.child.kill('SIGKILL'); await cli.exit; }
    server.closeAllConnections(); server.close(); await once(server, 'close');
    rmSync(temp, { recursive: true, force: true }); rmSync(sandbox.root, { recursive: true, force: true });
  }
});
