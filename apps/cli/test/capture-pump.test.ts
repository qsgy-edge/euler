import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { CaptureRun, DEFAULT_BUDGET } from '@euler/core';
import { openProbe } from '../src/probe.ts';
import { createSandbox } from '../src/sandbox.ts';
import { pumpCapture } from '../src/agent-pump.ts';

const budget = { ...DEFAULT_BUDGET, contextLimit: 20000, maxTotalTokens: 100000, maxModelAttempts: 8 };
const route = { provider: 'synthetic', model: 'test', route: 'synthetic', authNamespace: 'synthetic', capability: 'standard' as const };
test('a capture archive failure remains observable with its original code after restart', async () => {
  const sandbox = createSandbox();
  let probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const input = probe.archive.append(randomUUID(), '记住：只使用合成证据');
    const job = probe.store.queueOwnerCapture(probe.activity, input);
    const lease = probe.store.claimCaptureJob(probe.activity, job.jobId, budget, 30000)!;
    const run = new CaptureRun(probe.store, lease, {
      lookup: probe.archive.lookup.bind(probe.archive), read: probe.archive.read.bind(probe.archive), expand: probe.archive.expand.bind(probe.archive),
      append() { throw new Error('archive-limit'); },
    }, { proposer: [route], verifier: [route] }, undefined, 'capture-counting@1');
    await assert.rejects(pumpCapture(run, { async *stream(request, _signal, send) {
      const attempt = send(request.payload); probe.transport.send(request.payload, attempt);
      yield { kind: 'complete', reply: { text: 'null', calls: [], stop: 'end' } };
    } }), /archive-limit/);
    probe.close(); probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    const status = probe.store.readCaptureJob(probe.activity, job.jobId);
    assert.equal(status.stage, 'unknown'); assert.equal(status.reason, 'archive-limit');
    const ledger = probe.store.reconcileCaptureJob(probe.activity, job.jobId);
    assert.equal(ledger.attempts.length, 1); assert.equal(ledger.attempts[0]!.outcome, 'unknown-sent');
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('capture pauses before a send when Info recovery fails and resumes the same verification budget', async () => {
  const sandbox = createSandbox();
  let probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const source = probe.archive.append(randomUUID(), '记住：本项目保留原始日志');
    const job = probe.store.queueOwnerCapture(probe.activity, source);
    const proposer = probe.store.claimCaptureJob(probe.activity, job.jobId, budget, 30000)!;
    probe.store.captureProposedMemory(proposer, { type: 'decision', content: '本项目保留原始日志' });
    const lease = probe.store.claimCaptureJob(probe.activity, job.jobId, budget, 30000)!;
    const deadline = probe.store.captureRuntime(lease).deadline;
    const run = new CaptureRun(probe.store, lease, probe.archive, { proposer: [route], verifier: [route] }, undefined, 'capture-counting@1');
    let recovered = true;
    const waiting = await pumpCapture(run, {
      recoverInfo: () => recovered,
      async *stream(request, _signal, send) {
        const attempt = send(request.payload); probe.transport.send(request.payload, attempt);
        recovered = false;
        yield { kind: 'complete', reply: { text: '', calls: [{ id: 'search', name: 'source.search', arguments: { query: '原始日志' } }], stop: 'tools' } };
      },
    });
    assert.equal(waiting.stage, 'verifying'); assert.equal(waiting.reason, 'host-info-recovery-required');
    assert.equal(probe.transport.count, 1);
    const firstAttempt = probe.store.requestStatus(lease.activity, run.runId).attempts[0]!;
    assert.equal(firstAttempt.outcome, 'received');
    probe.close(); probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    const nextLease = probe.store.claimCaptureJob(probe.activity, job.jobId, budget, 30000)!;
    assert.equal(probe.store.captureRuntime(nextLease).deadline, deadline);
    const next = new CaptureRun(probe.store, nextLease, probe.archive, { proposer: [route], verifier: [route] }, undefined, 'capture-counting@1');
    assert.equal(next.runId, run.runId);
    const finished = await pumpCapture(next, {
      recoverInfo: () => true,
      async *stream(request, _signal, send) {
        const attempt = send(request.payload); probe.transport.send(request.payload, attempt);
        const payload = JSON.parse(request.payload);
        yield { kind: 'complete', reply: payload.p2.length === 1
          ? { text: '', calls: [{ id: 'expand', name: 'source.expand', arguments: { eventId: source.eventId, offset: 0, limit: 4096 } }], stop: 'tools' }
          : { text: JSON.stringify({ result: 'pass', evidence: [source] }), calls: [], stop: 'end' } };
      },
    });
    assert.equal(finished.stage, 'complete'); assert.equal(finished.record!.lifecycle, 'active');
    const attempts = probe.store.requestStatus(nextLease.activity, next.runId).attempts;
    assert.equal(attempts.length, 3); assert.equal(attempts[0]!.attemptId, firstAttempt.attemptId);
    assert.ok(attempts.every(attempt => attempt.outcome === 'received'));
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('actual provider usage blocks fallback before assembly and store admission', () => {
  const sandbox = createSandbox(), probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const input = probe.archive.append(randomUUID(), '记住：所有验证保留日志');
    const job = probe.store.queueOwnerCapture(probe.activity, input);
    const lease = probe.store.claimCaptureJob(probe.activity, job.jobId, budget, 30000)!;
    const run = new CaptureRun(probe.store, lease, probe.archive, { proposer: [route, { ...route, model: 'fallback' }], verifier: [route] });
    const request = run.nextModel()!;
    const attempt = run.startModel(request, request.payload);
    assert(run.maySend(attempt.attemptId, request.payload)); probe.transport.send(request.payload, attempt);
    run.finishModel(attempt.attemptId, { text: 'malformed', calls: [], stop: 'end', usage: { input: budget.maxTotalTokens, output: 1 } });
    assert.throws(() => probe.store.startRequestAttempt(lease.activity, { runId: run.runId, assemblyId: request.assemblyId,
      payloadHash: request.payloadHash, byteLength: Buffer.byteLength(request.payload), adapterVersion: 'capture-adapter@1' }), /token-budget-exhausted/);
    assert.equal(run.nextModel(), null);
    assert.equal(run.status().reason, 'capture-budget-exhausted');
    assert.equal(probe.transport.count, 1);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
