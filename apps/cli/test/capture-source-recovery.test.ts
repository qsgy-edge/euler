import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import { CaptureRun, DEFAULT_BUDGET } from '@euler/core';
import type { HostAdapter, ModelReply } from '@euler/core';
import { createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

const route = { provider: 'synthetic', model: 'capture-fixture', route: 'synthetic-capture', authNamespace: 'synthetic', capability: 'standard' as const };
const budget = { ...DEFAULT_BUDGET, maxModelAttempts: 8, maxToolCalls: 2, maxTotalTokens: 100000, contextLimit: 20000 };
const worker = fileURLToPath(new URL('./support/capture-source-crash.ts', import.meta.url));
const artifacts = join('artifacts', `capture-source-crash-${process.platform}-${Date.now()}`);

for (const callId of ['find', 'read']) for (const boundary of ['before', 'after'])
  test(`a real verifier crash ${boundary} source ${callId} reservation commits result and charge together`, async () => {
    const sandbox = createSandbox(), directory = join(artifacts, `${callId}-${boundary}`);
    mkdirSync(directory, { recursive: true });
    let probe: ReturnType<typeof openProbe> | undefined;
    try {
      const child = spawnSync(process.execPath, [worker, sandbox.root, callId, boundary], { encoding: 'utf8', timeout: 20000 });
      assert.ifError(child.error);
      assert(child.signal === 'SIGKILL' || child.status !== 0);
      assert.doesNotMatch(child.stderr, /Error:|ERR_/);
      const checkpoint = JSON.parse(child.stdout);
      assert.equal(checkpoint.boundary, boundary); assert.equal(checkpoint.callId, callId);
      writeFileSync(join(directory, 'process.json'), JSON.stringify({ command: [process.execPath, worker, sandbox.root, callId, boundary],
        code: child.status, signal: child.signal, checkpoint }, null, 2));
      cpSync(sandbox.root, join(directory, 'interrupted'), { recursive: true });
      await setTimeout(1050);
      probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
      const job = probe.store.listCaptureJobs(probe.activity)[0]!;
      const lease = probe.store.claimCaptureJob(probe.activity, job.jobId, budget, 10000)!;
      assert(lease);
      const run = new CaptureRun(probe.store, lease, probe.archive, { proposer: [route], verifier: [route] });
      const before = probe.store.requestStatus(lease.activity, run.runId).attempts.length;
      let request = run.nextModel()!;
      assert(request);
      const ack = probe.archive.lookup(checkpoint.eventId)!;
      assert.equal(probe.archive.read(ack).text, checkpoint.output);
      if (callId === 'find') {
        const attempt = run.startModel(request, request.payload);
        assert(run.maySend(attempt.attemptId, request.payload));
        run.finishModel(attempt.attemptId, { text: '', calls: [{ id: 'read', name: 'source.expand',
          arguments: { eventId: sandbox.fixture.eventId, offset: 0, limit: 4096 } }], stop: 'tools' });
        request = run.nextModel()!;
      }
      const results = JSON.parse(request.payload).p2.flatMap((step: { results: unknown[] }) => step.results);
      assert.deepEqual(results.map((result: { outcome: string }) => result.outcome), ['success', 'success']);
      assert.equal(JSON.parse(results[1].modelResult).text, '记住：项目测试应保留完整原始日志');
      assert.equal(probe.archive.events().filter(event => event.role === 'tool').length, 2);
      assert.equal(probe.store.requestStatus(lease.activity, run.runId).attempts.length, before + (callId === 'find' ? 1 : 0));
      assert.equal(probe.transport.count, 0);
      probe.close(); probe = undefined;
      cpSync(sandbox.root, join(directory, 'recovered'), { recursive: true });
      assert(readFileSync(join(directory, 'recovered/session.jsonl')).subarray(0,
        readFileSync(join(directory, 'interrupted/session.jsonl')).length).equals(readFileSync(join(directory, 'interrupted/session.jsonl'))));
    } finally { probe?.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
  });

test('a verifier resumes its original source result without spending the same call budget again', () => {
  const sandbox = createSandbox(), probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const input = probe.archive.append(randomUUID(), '记住：项目测试应保留完整原始日志');
    const job = probe.store.queueOwnerCapture(probe.activity, input);
    let lease = probe.store.claimCaptureJob(probe.activity, job.jobId, budget, 30000)!;
    const config = { proposer: [route], verifier: [route] };
    let run = new CaptureRun(probe.store, lease, probe.archive, config);
    const deliver = (reply: ModelReply) => {
      const request = run.nextModel()!;
      assert(request);
      const attempt = run.startModel(request, request.payload);
      assert(run.maySend(attempt.attemptId, request.payload));
      run.finishModel(attempt.attemptId, reply);
    };
    deliver({ text: JSON.stringify({ type: 'decision', content: '项目测试应保留完整原始日志' }), calls: [], stop: 'end' });
    lease = probe.store.claimCaptureJob(probe.activity, job.jobId, budget, 30000)!;
    const archive = probe.archive;
    let interrupted = false;
    const source: HostAdapter['source'] = {
      lookup: archive.lookup.bind(archive), read: archive.read.bind(archive), expand: archive.expand.bind(archive),
      append(eventId: string, text: string | (() => string), role: 'user' | 'assistant' | 'tool' = 'user') {
        if (role === 'tool' && !interrupted) { interrupted = true; throw new Error('archive-not-started'); }
        return archive.append(eventId, text, role);
      },
    };
    run = new CaptureRun(probe.store, lease, source, config);
    assert.throws(() => deliver({ text: '', calls: [{ id: 'find', name: 'source.search', arguments: { query: '原始日志' } }], stop: 'tools' }), /archive-not-started/);
    assert.equal(archive.events().filter(event => event.role === 'tool').length, 0);
    run = new CaptureRun(probe.store, lease, archive, config);
    deliver({ text: '', calls: [{ id: 'read', name: 'source.expand', arguments: { eventId: input.eventId, offset: 0, limit: 4096 } }], stop: 'tools' });
    const request = run.nextModel()!;
    const payload = JSON.parse(request.payload);
    const results = payload.p2.flatMap((step: { results: unknown[] }) => step.results);
    assert.equal(results.length, 2);
    assert.equal(results[1].outcome, 'success', results[1].modelResult);
    assert.equal(JSON.parse(results[1].modelResult).text, '记住：项目测试应保留完整原始日志');
    assert.equal(JSON.parse(results[0].modelResult).results[0].ref.eventId, input.eventId);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
