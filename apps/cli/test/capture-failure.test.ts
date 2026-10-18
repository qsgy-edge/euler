import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { CaptureRun, DEFAULT_BUDGET } from '@euler/core';
import type { CaptureFailure, ModelReply } from '@euler/core';
import { createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

const primary = { provider: 'synthetic', model: 'primary', route: 'synthetic-capture', authNamespace: 'synthetic', capability: 'standard' as const };
const fallback = { ...primary, model: 'fallback' };
function scenario(action: (value: { probe: ReturnType<typeof openProbe>; run: CaptureRun; jobId: string;
  deliver(reply: ModelReply, failure?: CaptureFailure): { model: string }; source: ReturnType<ReturnType<typeof openProbe>['archive']['append']> }) => void): void {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const source = probe.archive.append(randomUUID(), '记住：所有验证使用原始日志');
    const job = probe.store.queueOwnerCapture(probe.activity, source);
    const lease = probe.store.claimCaptureJob(probe.activity, job.jobId,
      { ...DEFAULT_BUDGET, maxModelAttempts: 8, contextLimit: 20000, maxTotalTokens: 100000 }, 30000)!;
    let run = new CaptureRun(probe.store, lease, probe.archive, { proposer: [primary, fallback], verifier: [primary, fallback] });
    action({ probe, run, jobId: job.jobId, source, deliver(reply, failure) {
      let request = run.nextModel();
      if (!request && run.status().stage === 'verifying') {
        const next = probe.store.claimCaptureJob(probe.activity, job.jobId,
          { ...DEFAULT_BUDGET, maxModelAttempts: 8, contextLimit: 20000, maxTotalTokens: 100000 }, 30000)!;
        run = new CaptureRun(probe.store, next, probe.archive, { proposer: [primary, fallback], verifier: [primary, fallback] });
        request = run.nextModel();
      }
      assert(request);
      const attempt = run.startModel(request, request.payload);
      assert(run.maySend(attempt.attemptId, request.payload));
      probe.transport.send(request.payload, attempt);
      run.finishModel(attempt.attemptId, reply, failure ? { failure } : {});
      return JSON.parse(request.payload);
    } });
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
}

for (const failure of ['temporary-unavailable','timeout','rate-limit','permanent'] as const) test(`Host-observed ${failure} follows only the configured permitted fallback`, () => {
  scenario(({ probe, run, deliver }) => {
    deliver({ text: 'Provider request failed.', calls: [], stop: 'error' }, failure);
    if (failure === 'permanent') { assert.equal(run.nextModel(), null); assert.equal(probe.transport.count, 1); }
    else { assert.equal(deliver({ text: 'null', calls: [], stop: 'end' }).model, 'fallback'); assert.equal(probe.transport.count, 2); }
  });
});

for (const verdict of ['block', 'evidence-gap'] as const) test(`protocol fallback never retries a Verifier ${verdict}`, () => {
  scenario(({ probe, run, jobId, deliver }) => {
    assert.equal(deliver({ text: 'malformed JSON', calls: [], stop: 'end' }).model, 'primary');
    assert.equal(deliver({ text: JSON.stringify({ type: 'decision', content: '验证使用原始日志' }), calls: [], stop: 'end' }).model, 'fallback');
    deliver({ text: JSON.stringify({ result: verdict, evidence: [], reason: 'source-insufficient' }), calls: [], stop: 'end' });
    assert.equal(run.nextModel(), null);
    assert.equal(probe.transport.count, 3);
    const status = probe.store.readCaptureJob(probe.activity, jobId);
    assert.equal(status.stage, 'blocked');
    assert.equal(status.reason, 'source-insufficient');
    assert.equal(status.record!.verification, 'unverified');
  });
});

test('an unknown request remains inspectable and cannot be resent by a new drain', () => {
  scenario(({ probe, run, jobId }) => {
    const request = run.nextModel()!;
    const attempt = run.startModel(request, request.payload);
    assert(run.maySend(attempt.attemptId, request.payload));
    probe.transport.send(request.payload, attempt);
    run.fail();
    assert.equal(probe.store.readCaptureJob(probe.activity, jobId).stage, 'unknown');
    const observation = probe.store.reconcileCaptureJob(probe.activity, jobId);
    assert.equal(observation.attempts[0]!.outcome, 'unknown-sent');
    assert.equal(JSON.parse(observation.events.at(-1)!.payload).evidence.outcome, 'received');
    assert.equal(run.nextModel(), null);
    assert.equal(probe.transport.count, 1);
  });
});
