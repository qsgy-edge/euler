import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
import { startCli } from '../src/process-driver.ts';
import { verifiedCandidate } from './support/memory-evolution.ts';

const cli = (...args: string[]) => execFileSync(process.execPath, ['apps/cli/src/main.ts', ...args], { encoding: 'utf8', timeout: 20000 });

test('agent refuses a pending Info registration failure and resumes after durable recovery', () => {
  const sandbox = createSandbox();
  try {
    const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    try {
      const record = verifiedCandidate(probe, '本项目保存原始日志').record!;
      probe.store.promoteMemory(probe.activity, record.recordId, record);
    } finally { probe.close(); }
    const db = new DatabaseSync(resourcesOf(sandbox).store.path);
    try { db.exec("CREATE TRIGGER fail_info BEFORE INSERT ON host_info_batches BEGIN SELECT RAISE(ABORT,'injected-info-failure'); END"); }
    finally { db.close(); }
    const blocked = spawnSync(process.execPath, ['apps/cli/src/main.ts', 'agent', '--sandbox', sandbox.root, '--scenario', 'plain'],
      { encoding: 'utf8', timeout: 20000 });
    assert.equal(blocked.error, undefined);
    const events = blocked.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(events.some(event => event.event === 'info-error'));
    const result = events.find(event => event.event === 'agent-result');
    assert.equal(result.fixtureProviderCount, 0);
    assert.deepEqual(result.ledger.attempts, []);
    assert.equal(result.status.terminal, 'failed');
    assert.equal(blocked.status, 1);
    const restored = new DatabaseSync(resourcesOf(sandbox).store.path);
    try { restored.exec('DROP TRIGGER fail_info'); } finally { restored.close(); }
    const recovered = cli('agent', '--sandbox', sandbox.root, '--scenario', 'plain').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(recovered.find(event => event.event === 'agent-result').fixtureProviderCount, 1);
    assert.equal(recovered.filter(event => event.event === 'info-notice').length, 1);
    assert.ok(recovered.findIndex(event => event.event === 'info-notice') < recovered.findIndex(event => event.event === 'agent-result'));
    const reopened = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    try { assert.deepEqual(reopened.store.listHostInfo(reopened.activity).map(info => info.delivery), ['delivered']); }
    finally { reopened.close(); }
  } finally { rmSync(sandbox.root, { recursive: true, force: true }); }
});
test('agent rechecks Info for a batch committed while the first HTTP response is in flight', async () => {
  const sandbox = createSandbox(), configRoot = mkdtempSync(join(tmpdir(), 'euler-agent-info-'));
  const payloads: string[] = [];
  let receiverError: unknown;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      try {
        payloads.push(Buffer.concat(chunks).toString('utf8'));
        if (payloads.length === 1) {
          const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
          try {
            const record = verifiedCandidate(probe, '本项目保存原始日志').record!;
            probe.store.promoteMemory(probe.activity, record.recordId, record);
          } finally { probe.close(); }
          const db = new DatabaseSync(resourcesOf(sandbox).store.path);
          try { db.exec("CREATE TRIGGER fail_info BEFORE INSERT ON host_info_batches BEGIN SELECT RAISE(ABORT,'injected-late-info-failure'); END"); }
          finally { db.close(); }
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        const message = payloads.length === 1
          ? { role: 'assistant', content: null, tool_calls: [{ id: 'echo', type: 'function', function: { name: 'controlled_echo', arguments: '{"text":"fixture"}' } }] }
          : { role: 'assistant', content: 'READY' };
        response.end(JSON.stringify({ model: 'agent-info-test', choices: [{ message, finish_reason: payloads.length === 1 ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 10 } }));
      } catch (error) { receiverError = error; response.writeHead(500); response.end('{}'); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const configPath = join(configRoot, 'transport.json');
    writeFileSync(configPath, JSON.stringify({ provider: 'synthetic-http', model: 'agent-info-test',
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, authNamespace: 'synthetic-http', credentialEnv: 'T14_INFO_TEST_TOKEN',
      contextWindow: 32000, maxTokens: 1024, budget: AGENT_BUDGET, authorization: 'synthetic-test-only' }));
    const child = await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
      execFile(process.execPath, ['apps/cli/src/main.ts', 'agent', '--scenario', 'real', '--sandbox', sandbox.root, '--transport-config', configPath],
        { encoding: 'utf8', timeout: 150000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, T14_INFO_TEST_TOKEN: 'SYNTHETIC-INFO-TOKEN' } },
        (error, stdout, stderr) => resolve({ code: error ? typeof error.code === 'number' ? error.code : null : 0, stdout, stderr }));
    });
    assert.equal(receiverError, undefined);
    assert.equal(child.code, 1, child.stderr);
    const events = child.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(events.some(event => event.event === 'info-error' && event.reason === 'injected-late-info-failure'));
    const result = events.find(event => event.event === 'agent-result');
    assert.equal(payloads.length, 1);
    assert.equal(result.networkCount, 1);
    assert.equal(result.status.terminal, 'failed');
    assert.deepEqual(result.ledger.attempts.map((attempt: { outcome: string; payloadHash: string }) => [attempt.outcome, attempt.payloadHash]),
      [['received', sha256(payloads[0]!)]]);
    assert.equal(result.status.tools[0].result.outcome, 'success');
    const db = new DatabaseSync(resourcesOf(sandbox).store.path);
    try { db.exec('DROP TRIGGER fail_info'); } finally { db.close(); }
    const recovered = cli('agent', '--sandbox', sandbox.root, '--scenario', 'plain').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(recovered.filter(event => event.event === 'info-notice').length, 1);
    assert.equal(recovered.find(event => event.event === 'agent-result').fixtureProviderCount, 1);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(sandbox.root, { recursive: true, force: true }); rmSync(configRoot, { recursive: true, force: true });
  }
});

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

for (const command of ['capture-drain', 'agent', 'remember']) test(`${command} worker waits for Info recovery before HTTP and resumes the queued job`, async () => {
  const sandbox = createSandbox(), configRoot = mkdtempSync(join(tmpdir(), 'euler-capture-info-'));
  const payloads: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      payloads.push(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ model: 'capture-info-test', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'null' } }] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let jobId: string;
  try {
    const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    try {
      const record = verifiedCandidate(probe, '本项目合成验证使用 TypeScript').record!;
      probe.store.promoteMemory(probe.activity, record.recordId, record);
      const source = probe.archive.append(randomUUID(), '记住：一条等待独立验证的合成事实');
      jobId = probe.store.queueOwnerCapture(probe.activity, source).jobId;
    } finally { probe.close(); }
    const configPath = join(configRoot, 'transport.json');
    writeFileSync(configPath, JSON.stringify({ provider: 'synthetic-http', model: 'capture-info-test',
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, authNamespace: 'synthetic-http', credentialEnv: 'T14_CAPTURE_INFO_TOKEN',
      contextWindow: 32000, maxTokens: 1024, budget: AGENT_BUDGET, authorization: 'synthetic-test-only', captureCapability: 'standard' }));
    const mutate = (sql: string) => {
      const db = new DatabaseSync(resourcesOf(sandbox).store.path);
      try { db.exec(sql); } finally { db.close(); }
    };
    const run = async () => {
      const child = startCli([command, '--sandbox', sandbox.root, '--capture-config', configPath,
        ...(command === 'agent' ? ['--scenario', 'plain'] : [])], 150000, undefined,
      { ...process.env, T14_CAPTURE_INFO_TOKEN: 'SYNTHETIC-CAPTURE-INFO-TOKEN' });
      try {
        await child.waitFor('capture-queue');
        if (command === 'remember') child.command('stop');
        await child.waitFor('process-exit');
        return child.observations;
      } finally {
        if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill();
        await child.exit;
      }
    };
    mutate("CREATE TRIGGER fail_info BEFORE INSERT ON host_info_batches BEGIN SELECT RAISE(ABORT,'injected-worker-info-failure'); END");
    const waiting = await run();
    assert.ok(waiting.some(event => event.event === 'info-error'));
    assert.equal(payloads.length, 0);
    const queue = waiting.find(event => event.event === 'capture-queue')!.jobs as { jobId: string; stage: string; reason: string }[];
    assert.equal(queue.find(job => job.jobId === jobId)!.reason, 'host-info-recovery-required');
    const failedDb = new DatabaseSync(resourcesOf(sandbox).store.path, { readOnly: true });
    try {
      assert.equal(failedDb.prepare("SELECT count(*) AS n FROM request_attempts a JOIN request_runs r ON r.run_id=a.run_id JOIN execution_streams s ON s.stream_id=r.stream_id WHERE s.owner_kind='job'").get()!.n, 0);
      assert.equal(failedDb.prepare('SELECT count(*) AS n FROM host_info_batches').get()!.n, 0);
    } finally { failedDb.close(); }
    mutate('DROP TRIGGER fail_info');
    const resumed = await run();
    assert.ok(resumed.some(event => event.event === 'info-notice'));
    assert.ok(payloads.length > 0);
    const reopened = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    try {
      assert.equal(reopened.store.readCaptureJob(reopened.activity, jobId).stage, 'complete');
      assert.deepEqual(reopened.store.listHostInfo(reopened.activity).map(info => info.delivery), ['delivered']);
    } finally { reopened.close(); }
    const db = new DatabaseSync(resourcesOf(sandbox).store.path, { readOnly: true });
    try {
      const attempts = db.prepare("SELECT a.payload_hash,a.outcome FROM request_attempts a JOIN request_runs r ON r.run_id=a.run_id JOIN execution_streams s ON s.stream_id=r.stream_id WHERE s.owner_kind='job'").all();
      assert.equal(attempts.length, payloads.length);
      assert.ok(attempts.every(attempt => attempt.outcome === 'received'));
      for (const payload of payloads) assert.ok(attempts.some(attempt => attempt.payload_hash === sha256(payload)));
    } finally { db.close(); }
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(sandbox.root, { recursive: true, force: true }); rmSync(configRoot, { recursive: true, force: true });
  }
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
