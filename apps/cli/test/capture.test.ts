import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { DEFAULT_BUDGET } from '@euler/core';
import { createSandbox, createSandboxSession, bindingOf, resourcesOf } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';
import { approvedSourceUnit } from './support/source-publication.ts';

test('a verifier can use only the section published to its project, retaining the original source across restart', () => {
  const sandbox = createSandbox(), origin = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  const targetBinding = { ...bindingOf(sandbox), sessionId: randomUUID(), projectId: randomUUID() };
  createSandboxSession(sandbox, targetBinding);
  let target = openProbe(sandbox, undefined, undefined, targetBinding, undefined, true);
  try {
    const section = 'APPROVED_SHARED_EVIDENCE';
    const prefix = 'PRIVATE_PREFIX\n';
    const source = origin.archive.append(randomUUID(), `${prefix}${section}\nPRIVATE_SUFFIX`, 'assistant');
    const unpublished = origin.archive.append(randomUUID(), 'PRIVATEUNPUBLISHEDONLY', 'assistant');
    const unit = origin.store.publishSourceUnit(origin.activity, approvedSourceUnit(origin, { ref: source, projectId: targetBinding.projectId,
      kind: 'report-section', offset: Array.from(prefix).length, length: Array.from(section).length }));
    origin.store.drainSourceProjection(origin.activity);
    const job = target.store.queueOwnerCapture(target.activity, target.archive.append(randomUUID(), '记住：需要独立核对共享证据'));
    let lease = target.store.claimCaptureJob(target.activity, job.jobId, DEFAULT_BUDGET, 30000)!;
    target.store.captureProposedMemory(lease, { type: 'insight', content: '获准的共享区段可作为验证证据' });
    lease = target.store.claimCaptureJob(target.activity, job.jobId, DEFAULT_BUDGET, 30000)!;
    const page = target.store.searchCaptureSources(lease, section);
    assert.equal(page.results.length, 1);
    assert.equal(page.results[0]!.unitId, unit.unitId);
    assert.equal(page.results[0]!.ref.binding.projectId, sandbox.fixture.projectId);
    assert.doesNotMatch(JSON.stringify(page), /PRIVATE_PREFIX|PRIVATE_SUFFIX/);
    assert.equal(target.store.searchCaptureSources(lease, 'PRIVATEUNPUBLISHEDONLY').results.length, 0);
    assert.throws(() => target.store.expandCaptureSource(lease, { ref: source, offset: 0, limit: 4096 }), /verification-source-not-discovered/);
    assert.throws(() => target.store.completeCaptureVerification(lease, { result: 'pass', evidence: [unpublished] }), /independent-evidence/);
    const expanded = target.store.expandCaptureSource(lease, { ref: source, offset: unit.offset, limit: 4096 });
    assert.equal(expanded.text, section);
    const verified = target.store.completeCaptureVerification(lease, { result: 'pass', evidence: [expanded.ref] });
    assert.equal(verified.record!.verification, 'verified');
    assert.equal(verified.record!.lifecycle, 'candidate');
    assert.equal(verified.record!.scope.id, targetBinding.projectId);
    target.close(); target = openProbe(sandbox, undefined, undefined, targetBinding, undefined, true);
    const inspection = target.store.inspectMemory(target.activity, verified.record!.recordId);
    assert.equal(inspection.record.verification, 'verified');
    assert.equal(target.store.readCaptureJob(target.activity, job.jobId).stage, 'complete');
    writeFileSync(resourcesOf(sandbox).source.path, 'corrupted original archive\n');
    assert.throws(() => target.store.inspectMemory(target.activity, verified.record!.recordId), /archive-integrity|source-evidence-gap/);
  } finally { target.close(); origin.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

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
