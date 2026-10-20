import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_BUDGET } from '@euler/core';
import { startCli } from '../src/process-driver.ts';
import { createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

test('the configured CLI HTTP path revalidates model intent and sends only bounded terminal summaries', async () => {
  const sandbox = createSandbox();
  const temp = mkdtempSync(join(tmpdir(), 'euler-correction-http-'));
  let probe = openProbe(sandbox);
  const record = probe.store.rememberMemory(probe.activity, { input: probe.archive.append(randomUUID(), '记住偏好：Original'), hostInfo: 'durable' }).record;
  probe.close();
  const bodies: { messages: { role: string; content: string }[] }[] = [];
  let token = '';
  const waiting = Promise.withResolvers<void>();
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    bodies.push(JSON.parse(body));
    const index = bodies.length;
    if (index === 7) { waiting.resolve(); return; }
    const name = index === 5 ? 'memory_commit' : 'memory_preview';
    const args = index === 5 ? { token, content: 'Corrected' } : { recordId: record.recordId, content: 'Corrected' };
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
  const cli = startCli(['remember', '--sandbox', sandbox.root, '--transport-config', config], 60000, undefined,
    { ...process.env, EULER_CORRECTION_TEST_KEY: 'synthetic' });
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
    const gate = await cli.waitFor('correction-prerequisites'); assert.equal(gate.passed, true);
    await completed(0);
    assert.equal(cli.observations.find(row => row.event === 'memory-result')!.status, 'not_actionable');
    assert.equal(cli.observations.filter(row => row.event === 'memory-preview').length, 0);
    cli.command(`model correct ${record.recordId} "Corrected"`);
    await completed(1);
    token = String(cli.observations.find(row => row.event === 'memory-preview')!.token);
    cli.command(`model commit ${token} "Corrected"`);
    await completed(2);
    assert.equal(bodies.length, 6);
    const firstUser = bodies[5]!.messages.find(message => message.role === 'user')!;
    const summary = JSON.parse(firstUser.content).operationSummaries[0];
    assert.equal(summary.status, 'committed');
    assert.equal(summary.records[0].verification, 'unverified');
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
      assert.equal(probe.store.readMemory(probe.activity, record.recordId).revision, 2);
      assert.equal(probe.store.recoverMemoryOperations(probe.activity).length, 1);
    } finally { probe.close(); }
  } finally {
    if (!cli.observations.some(row => row.event === 'process-exit')) { cli.child.kill('SIGKILL'); await cli.exit; }
    server.closeAllConnections(); server.close(); await once(server, 'close');
    rmSync(temp, { recursive: true, force: true }); rmSync(sandbox.root, { recursive: true, force: true });
  }
});
