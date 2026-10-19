import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { sha256 } from '@euler/core';
import { AGENT_BUDGET } from '../src/agent-cli.ts';
import { createSandbox, resourcesOf } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

const cli = (...args: string[]) => execFileSync(process.execPath, ['apps/cli/src/main.ts', ...args], { encoding: 'utf8', timeout: 20000 });
test('ordinary Agent and remember jobs persist the missing route reason without attempts or synthetic job injection', () => {
  const sandbox = createSandbox();
  try {
    cli('agent', '--sandbox', sandbox.root, '--scenario', 'tool');
    execFileSync(process.execPath, ['apps/cli/src/main.ts', 'remember', '--sandbox', sandbox.root],
      { input: '记住：验证需要原始日志\nstop\n', encoding: 'utf8', timeout: 20000 });
    cli('capture-drain', '--sandbox', sandbox.root);
    const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    try {
      const jobs = probe.store.listCaptureJobs(probe.activity);
      assert.equal(jobs.length, 3);
      assert(jobs.every(job => job.stage === 'pending' && job.reason === 'capture-route-unavailable' && job.record === null));
      assert(jobs.every(job => job.source.eventId !== 'ca710000-0000-4000-8000-000000000001'));
    } finally { probe.close(); }
  } finally { rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('the configured worker consumes ordinary jobs at startup and agent_end over the real HTTP boundary', async () => {
  const sandbox = createSandbox(), configRoot = mkdtempSync(join(tmpdir(), 'euler-capture-config-'));
  const payloads: string[] = [];
  let receiverError: unknown;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      try {
        assert.equal(request.headers.authorization, 'Bearer SYNTHETIC-CAPTURE-TOKEN');
        const bytes = Buffer.concat(chunks).toString('utf8'); payloads.push(bytes);
        const payload = JSON.parse(bytes);
        const input = JSON.parse(payload.messages.find((message: { role: string }) => message.role === 'user').content);
        let content = '', calls: { id: string; type: string; function: { name: string; arguments: string } }[] = [];
        const call = (id: string, name: string, args: unknown) => [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }];
        if (input.intent.step === 'proposer') content = input.input.includes('记住：验证需要原始日志')
          ? JSON.stringify({ type: 'decision', content: '验证需要原始日志' }) : 'null';
        else {
          const results = payload.messages.filter((message: { role: string }) => message.role === 'tool')
            .map((message: { content: string }) => JSON.parse(JSON.parse(message.content).result));
          if (results.length === 0) calls = call('search', 'source_search', { query: '原始日志' });
          else if (results.length === 1) calls = call('expand', 'source_expand', { eventId: results[0].results[0].ref.eventId, offset: 0, limit: 4096 });
          else content = JSON.stringify({ result: 'pass', evidence: [results[1].ref] });
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ model: 'capture-http-test', choices: [{ finish_reason: calls.length ? 'tool_calls' : 'stop',
          message: { role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}) } }], usage: { prompt_tokens: 100, completion_tokens: 100 } }));
      } catch (error) { receiverError = error; response.writeHead(500); response.end('{}'); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    execFileSync(process.execPath, ['apps/cli/src/main.ts', 'remember', '--sandbox', sandbox.root],
      { input: '记住：验证需要原始日志\nstop\n', encoding: 'utf8', timeout: 20000 });
    const configPath = join(configRoot, 'transport.json');
    writeFileSync(configPath, JSON.stringify({ provider: 'synthetic-http', model: 'capture-http-test',
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, authNamespace: 'synthetic-http', credentialEnv: 'T13_TEST_TOKEN',
      contextWindow: 32000, maxTokens: 1024, budget: { ...AGENT_BUDGET, maxModelAttempts: 8 }, authorization: 'synthetic-test-only', captureCapability: 'standard' }));
    const env = { ...process.env, T13_TEST_TOKEN: 'SYNTHETIC-CAPTURE-TOKEN' };
    const result = await promisify(execFile)(process.execPath,
      ['apps/cli/src/main.ts', 'agent', '--sandbox', sandbox.root, '--scenario', 'tool', '--capture-config', configPath],
      { encoding: 'utf8', env, timeout: 150000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(receiverError, undefined);
    const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert(events.findIndex(item => item.event === 'agent-result') < events.findIndex(item => item.event === 'capture-prerequisites'));
    const prerequisites = events.find(item => item.event === 'capture-prerequisites');
    assert.equal(prerequisites?.passed, true); assert.equal(prerequisites?.exitCode, 0);
    assert.equal(prerequisites?.command[1], '--test');
    assert.equal(payloads.length, 6);
    await promisify(execFile)(process.execPath, ['apps/cli/src/main.ts', 'capture-drain', '--sandbox', sandbox.root, '--capture-config', configPath],
      { encoding: 'utf8', env, timeout: 20000 });
    assert.equal(payloads.length, 6);
    const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    try {
      const jobs = probe.store.listCaptureJobs(probe.activity);
      assert.equal(jobs.length, 3); assert(jobs.every(job => job.stage === 'complete'));
      const record = jobs.find(job => job.record)?.record;
      assert.equal(record?.content, '验证需要原始日志'); assert.equal(record?.verification, 'verified'); assert.equal(record?.lifecycle, 'active');
      const info = probe.store.listHostInfo(probe.activity);
      assert.equal(info.length, 1); assert.equal(info[0]!.delivery, 'delivered');
      assert.ok(events.some(event => event.event === 'info-notice' && event.batchId === info[0]!.batchId));
    } finally { probe.close(); }
    const db = new DatabaseSync(resourcesOf(sandbox).store.path, { readOnly: true });
    try {
      const attempts = db.prepare("SELECT a.payload_hash,s.owner_id FROM request_attempts a JOIN request_runs r ON r.run_id=a.run_id JOIN execution_streams s ON s.stream_id=r.stream_id WHERE s.owner_kind='job'").all();
      assert.equal(attempts.length, payloads.length);
      for (const bytes of payloads) assert(attempts.some(attempt => attempt.payload_hash === sha256(bytes)));
      for (const attempt of attempts) assert(db.prepare('SELECT 1 FROM capture_jobs WHERE job_id=?').get(String(attempt.owner_id)));
    } finally { db.close(); }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(sandbox.root, { recursive: true, force: true }); rmSync(configRoot, { recursive: true, force: true }); }
});
