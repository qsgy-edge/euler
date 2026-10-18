import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { CaptureRun, DEFAULT_BUDGET } from '@euler/core';
import type { ModelReply } from '@euler/core';
import { createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

const budget = { ...DEFAULT_BUDGET, contextLimit: 20000, maxTotalTokens: 100000, maxModelAttempts: 8 };
const route = { provider: 'fake', model: 'test', route: 'fixture', authNamespace: 'synthetic', capability: 'standard' as const };
for (const invalidation of ['sealed','recovery-gap','revoked'] as const) {
  for (const phase of ['proposer','verifier','tool'] as const) {
    test(`a successful late ${phase} reply after ${invalidation} is retained without memory or tool effects`, () => {
      const sandbox = createSandbox(), probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
      try {
        const source = probe.archive.append(randomUUID(), '记住：仅处理合成信息');
        const job = probe.store.queueOwnerCapture(probe.activity, source);
        let lease = probe.store.claimCaptureJob(probe.activity, job.jobId, budget, 30000)!;
        let run = new CaptureRun(probe.store, lease, probe.archive, { proposer: [route], verifier: [route] });
        const send = () => {
          const request = run.nextModel()!;
          const attempt = run.startModel(request, request.payload);
          assert.equal(run.maySend(attempt.attemptId, request.payload), true);
          probe.transport.send(request.payload, attempt);
          return attempt;
        };
        const candidate: ModelReply = { text: JSON.stringify({ type: 'decision', content: '仅处理合成信息' }), stop: 'end', calls: [] };
        if (phase !== 'proposer') {
          run.finishModel(send().attemptId, candidate);
          lease = probe.store.claimCaptureJob(probe.activity, job.jobId, budget, 30000)!;
          run = new CaptureRun(probe.store, lease, probe.archive, { proposer: [route], verifier: [route] });
          run.finishModel(send().attemptId, { text: '', stop: 'tools', calls: [{ id: 'search', name: 'source.search',
            arguments: { query: '合成信息' } }] });
          run.finishModel(send().attemptId, { text: '', stop: 'tools', calls: [{ id: 'read', name: 'source.expand',
            arguments: { eventId: source.eventId, offset: 0, limit: 4096 } }] });
        }
        const before = probe.store.readCaptureJob(probe.activity, job.jobId).record;
        const toolEvents = probe.archive.events().filter(event => event.role === 'tool').length;
        const attempt = send();
        if (invalidation === 'sealed') probe.store.sealRequestRun(lease.activity, run.runId);
        else if (invalidation === 'recovery-gap') probe.store.markRequestRecoveryGap(lease.activity, run.runId);
        else probe.store.revokeRequestRun(lease.activity, run.runId);
        assert.throws(() => phase === 'proposer'
          ? probe.store.captureProposedMemory(lease, { type: 'decision', content: '仅处理合成信息' })
          : phase === 'verifier' ? probe.store.completeCaptureVerification(lease, { result: 'pass', evidence: [source] })
            : probe.store.expandCaptureSource(lease, { ref: source, offset: 0, limit: 4096 }), /late-model-result/);
        const late: ModelReply = phase === 'proposer' ? candidate : phase === 'verifier'
          ? { text: JSON.stringify({ result: 'pass', evidence: [source] }), calls: [], stop: 'end' }
          : { text: '', stop: 'tools', calls: [{ id: 'late-read', name: 'source.expand', arguments: { eventId: source.eventId, offset: 0, limit: 4096 } }] };
        run.finishModel(attempt.attemptId, late);
        assert.deepEqual(probe.store.readCaptureJob(probe.activity, job.jobId).record, before);
        assert.equal(probe.archive.events().filter(event => event.role === 'tool').length, toolEvents);
        assert(probe.archive.lookup(attempt.attemptId), 'retain the actual late response');
        const status = probe.store.requestStatus(lease.activity, run.runId);
        assert.equal(status.attempts.at(-1)!.outcome, 'received');
        assert.equal(status.events.some(event => event.kind === 'run-recovery-gap'), invalidation === 'recovery-gap');
        assert.equal(run.status().stage, 'blocked');
        assert.equal(run.status().reason, 'late-model-result');
        assert.equal(run.nextModel(), null);
      } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
    });
  }
}
