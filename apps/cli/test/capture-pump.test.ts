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
    }, { proposer: [route], verifier: [route] });
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
