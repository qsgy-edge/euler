import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { AgentRun, CaptureRun, DEFAULT_BUDGET } from '@euler/core';
import { pumpCapture } from '../src/agent-pump.ts';
import { createSandbox, bindingOf } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

const budget = { ...DEFAULT_BUDGET, contextLimit: 20000, maxTotalTokens: 100000, maxModelAttempts: 8 };
const route = { provider: 'fake', model: 'test', route: 'fixture', authNamespace: 'synthetic', capability: 'standard' as const };
for (const invalidation of ['lease-expired','run-sealed','pump-failed','recovery-gap'] as const) {
  test(`live capture permits foreground work only in its owning Store until ${invalidation}`, async context => {
    const sandbox = createSandbox(), probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    let release!: () => void, arrived!: () => void;
    const response = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { arrived = resolve; });
    let pumping: Promise<unknown> | undefined;
    try {
      const source = probe.archive.append(randomUUID(), '记住：合成数据');
      const job = probe.store.queueOwnerCapture(probe.activity, source);
      const lease = probe.store.claimCaptureJob(probe.activity, job.jobId, budget, 5000)!;
      const run = new CaptureRun(probe.store, lease, probe.archive, { proposer: [route], verifier: [route] });
      pumping = pumpCapture(run, { async *stream(request, _signal, send) {
        const attempt = send(request.payload); probe.transport.send(request.payload, attempt); arrived();
        await response; throw new Error('test-reply-lost');
      } }).catch(error => error);
      await started;
      const foreign = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
      try { assert.throws(() => foreign.store.authorizeRequestRun(foreign.activity, randomUUID(), { budget, intent: null, relatedRunId: null }), /request-recovery-required/); }
      finally { foreign.close(); }
      const foreground = probe.store.authorizeRequestRun(probe.activity, randomUUID(), { budget, intent: null, relatedRunId: null });
      probe.store.sealRequestRun(probe.activity, foreground.runId);
      if (invalidation === 'lease-expired') {
        const now = Date.now(); context.mock.method(Date, 'now', () => now + 5001);
      } else if (invalidation === 'run-sealed') probe.store.sealRequestRun(lease.activity, run.runId);
      else if (invalidation === 'recovery-gap') probe.store.markRequestRecoveryGap(lease.activity, run.runId);
      else { release(); await pumping; }
      assert.throws(() => probe.store.authorizeRequestRun(probe.activity, randomUUID(), { budget, intent: null, relatedRunId: null }), /request-recovery-required/);
    } finally { context.mock.restoreAll(); release?.(); await pumping; probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
  });
}

test('capture yields at a settled response boundary without losing its job or attempt history', async () => {
  const sandbox = createSandbox(), probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const source = probe.archive.append(randomUUID(), '记住：合成数据');
    const job = probe.store.queueOwnerCapture(probe.activity, source);
    const lease = probe.store.claimCaptureJob(probe.activity, job.jobId, budget, 30000)!;
    const config = { proposer: [route], verifier: [route] };
    const run = new CaptureRun(probe.store, lease, probe.archive, config);
    const { capability: _capability, ...foregroundRoute } = route;
    const foreground = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive }, foregroundRoute, budget);
    const before = probe.store.requestStatus(lease.activity, run.runId);
    assert.equal(run.nextModel(), null);
    assert.equal(run.status().reason, 'foreground-run-active');
    assert.equal(probe.store.requestStatus(lease.activity, run.runId).attempts.length, before.attempts.length);
    foreground.cancel();
    const nextLease = probe.store.claimCaptureJob(probe.activity, job.jobId, budget, 30000)!;
    const resumed = new CaptureRun(probe.store, nextLease, probe.archive, config);
    assert.equal(resumed.runId, run.runId);
    assert.notEqual(resumed.nextModel(), null);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
