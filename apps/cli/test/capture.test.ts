import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { DEFAULT_BUDGET } from '@euler/core';
import { createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

test('an untyped owner capture keeps its durable identity and scope across restart', () => {
  const sandbox = createSandbox();
  let probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const source = probe.archive.append(randomUUID(), '记住：本项目的验证步骤需要保留原始日志');
    const queued = probe.store.queueOwnerCapture(probe.activity, source);
    const job = probe.store.readCaptureJob(probe.activity, queued.jobId);
    assert.equal(job.jobId, queued.jobId);
    assert.equal(job.stage, 'pending');
    assert.equal(job.reason, 'memory-type-required');
    assert.deepEqual(job.range, [source]);
    assert.deepEqual(job.scope, { kind: 'project', id: sandbox.fixture.projectId, resolved: true });
    assert.equal(job.ownerId, sandbox.fixture.ownerId);
    assert.equal(job.record, null);
    probe.close();
    probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    assert.deepEqual(probe.store.readCaptureJob(probe.activity, queued.jobId), job);
    assert.equal(probe.store.queueOwnerCapture(probe.activity, source).jobId, queued.jobId);
    assert.deepEqual(probe.store.listCaptureJobs(probe.activity).map(item => item.jobId), [queued.jobId]);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('a capture lease belongs to its durable job and only its holder can commit the candidate', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const source = probe.archive.append(randomUUID(), '记住：本项目的验证步骤需要保留原始日志');
    const queued = probe.store.queueOwnerCapture(probe.activity, source);
    let lease = probe.store.claimCaptureJob(probe.activity, queued.jobId, DEFAULT_BUDGET, 30000)!;
    const stream = probe.store.readStream(lease.activity, lease.activity.streamId);
    assert.equal(stream.ownerKind, 'job');
    assert.equal(stream.ownerId, queued.jobId);
    assert.equal(probe.store.claimCaptureJob(probe.activity, queued.jobId, DEFAULT_BUDGET, 30000), null);
    assert.throws(() => probe.store.captureProposedMemory({ ...lease, token: randomUUID() },
      { type: 'decision', content: '本项目的验证步骤需要保留原始日志' }), /capture-lease-stale/);
    const captured = probe.store.captureProposedMemory(lease,
      { type: 'decision', content: '本项目的验证步骤需要保留原始日志' });
    assert.equal(captured.record!.lifecycle, 'candidate');
    assert.equal(captured.record!.verification, 'unverified');
    assert.deepEqual(captured.record!.source, source);
    assert.equal(captured.stage, 'verifying');
    assert.throws(() => probe.store.searchCaptureSources(lease, '原始日志'), /capture-lease-stale/);
    lease = probe.store.claimCaptureJob(probe.activity, queued.jobId, DEFAULT_BUDGET, 30000)!;
    assert.equal(probe.store.searchMemories(probe.activity, { query: '原始日志' }).results.length, 0);
    assert.throws(() => probe.store.completeCaptureVerification(lease, { result: 'pass', evidence: [source] }),
      /verification-independent-evidence-required/);
    const hits = probe.store.searchCaptureSources(lease, '验证步骤').results;
    assert.deepEqual(hits.map(hit => hit.ref.eventId), [source.eventId]);
    const evidence = probe.store.expandCaptureSource(lease, { ref: hits[0]!.ref, offset: 0, limit: 4096 });
    assert.equal(evidence.text, '记住：本项目的验证步骤需要保留原始日志');
    const verified = probe.store.completeCaptureVerification(lease, { result: 'pass', evidence: [evidence.ref] });
    assert.equal(verified.stage, 'complete');
    assert.equal(verified.record!.verification, 'verified');
    assert.equal(verified.record!.lifecycle, 'candidate');
    assert.deepEqual(probe.store.inspectMemory(probe.activity, verified.record!.recordId).history.map(event => event.kind),
      ['capture', 'verify']);
    assert.equal(probe.store.searchMemories(probe.activity, { query: '原始日志' }).results.length, 0);
    assert.deepEqual(probe.store.listHostInfo(probe.activity), []);
    const correction = probe.archive.append(randomUUID(), '更正：原始日志还需要保留测试环境');
    const corrected = probe.store.correctMemory(probe.activity, verified.record!.recordId, verified.record!, correction,
      '原始日志需要保留测试环境').record;
    const recheck = probe.store.queueMemoryVerification(probe.activity, corrected.recordId, corrected);
    assert.equal(recheck.record!.headEventId, corrected.headEventId);
    const recheckLease = probe.store.claimCaptureJob(probe.activity, recheck.jobId, DEFAULT_BUDGET, 30000)!;
    probe.store.searchCaptureSources(recheckLease, '原始日志');
    probe.store.expandCaptureSource(recheckLease, { ref: correction, offset: 0, limit: 4096 });
    const laterInput = probe.archive.append(randomUUID(), '再次更正：只保留测试环境');
    const later = probe.store.correctMemory(probe.activity, corrected.recordId, corrected, laterInput, '只保留测试环境').record;
    assert.throws(() => probe.store.completeCaptureVerification(recheckLease, { result: 'pass', evidence: [correction] }), /memory-stale/);
    assert.equal(probe.store.inspectMemory(probe.activity, later.recordId).record.headEventId, later.headEventId);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
