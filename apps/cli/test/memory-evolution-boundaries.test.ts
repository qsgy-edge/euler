import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { CaptureRun } from '@euler/core';
import { bindingOf, createSandbox, createSandboxSession, resourcesOf } from '../src/sandbox.ts';
import { approvedSourceUnit } from './support/source-publication.ts';
import { openProbe } from '../src/probe.ts';
import { evolutionBudget, observedFact, pairedCanary, verifiedCandidate } from './support/memory-evolution.ts';

test('an independently established older claim remains superseded without replacing the active claim', () => {
  const sandbox = createSandbox(), probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const first = verifiedCandidate(probe, '本项目当前的默认语言是中文').record!;
    const active = probe.store.promoteMemory(probe.activity, first.recordId, first).record;
    const second = verifiedCandidate(probe, '本项目此前的默认语言是英文');
    probe.store.promoteMemory(probe.activity, second.record!.recordId, second.record!);
    for (const relation of ['same-claim','distinct','supersedes','superseded-by']) {
      const lease = probe.store.claimCaptureJob(probe.activity, second.jobId, evolutionBudget, 30000)!;
      assert.equal(probe.store.captureComparison(lease)!.relation, relation);
      probe.store.searchCaptureSources(lease, '本项目');
      for (const ref of [first.source, second.source]) probe.store.expandCaptureSource(lease, { ref, offset: 0, limit: 4096 });
      probe.store.completeCaptureVerification(lease, { result: relation === 'superseded-by' ? 'pass' : 'block', evidence: [first.source, second.source] });
    }
    const older = probe.store.readCaptureJob(probe.activity, second.jobId);
    assert.equal(older.reason, 'superseded-claim');
    assert.equal(older.record!.lifecycle, 'superseded');
    assert.equal(older.record!.verification, 'verified');
    assert.deepEqual(probe.store.listEligibleMemories(probe.activity).map(record => record.recordId), [active.recordId]);
    assert.equal(probe.store.registerHostInfo(probe.activity).pending.length, 1);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('losing an additional comparison proof revokes eligibility even when both primary claim sources survive', () => {
  const sandbox = createSandbox(), probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const first = verifiedCandidate(probe, '本项目 Windows 使用 PowerShell').record!;
    probe.store.promoteMemory(probe.activity, first.recordId, first);
    const second = verifiedCandidate(probe, '本项目 Linux 使用 Bash');
    const text = '公开比较来源：本项目两个环境互相独立';
    const extra = probe.archive.append(randomUUID(), text, 'assistant');
    probe.store.publishSourceUnit(probe.activity, approvedSourceUnit(probe, { ref: extra, projectId: sandbox.fixture.projectId,
      kind: 'report-section', offset: 0, length: Array.from(text).length }));
    probe.store.drainSourceProjection(probe.activity);
    probe.store.promoteMemory(probe.activity, second.record!.recordId, second.record!);
    for (const relation of ['same-claim','distinct']) {
      const lease = probe.store.claimCaptureJob(probe.activity, second.jobId, evolutionBudget, 30000)!;
      assert.equal(probe.store.captureComparison(lease)!.relation, relation);
      probe.store.searchCaptureSources(lease, '本项目');
      for (const ref of [first.source, second.source, extra]) probe.store.expandCaptureSource(lease, { ref, offset: 0, limit: 4096 });
      probe.store.completeCaptureVerification(lease, { result: relation === 'distinct' ? 'pass' : 'block', evidence: [first.source, second.source, extra] });
    }
    assert.equal(probe.store.listEligibleMemories(probe.activity).length, 2);
    const path = resourcesOf(sandbox).source.path;
    writeFileSync(path, readFileSync(path, 'utf8').replace(text, '公开比较来源：本项目环境尚未确认'));
    assert.deepEqual(probe.store.listEligibleMemories(probe.activity).map(record => record.recordId), [first.recordId]);
    assert.equal(probe.store.readMemory(probe.activity, second.record!.recordId).verification, 'stale');
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('a changed comparison peer invalidates the prepared request before any send', () => {
  const sandbox = createSandbox(), probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const first = verifiedCandidate(probe, '本项目保存原始日志').record!;
    const active = probe.store.promoteMemory(probe.activity, first.recordId, first).record;
    const second = verifiedCandidate(probe, '本项目保存完整测试日志');
    probe.store.promoteMemory(probe.activity, second.record!.recordId, second.record!);
    const lease = probe.store.claimCaptureJob(probe.activity, second.jobId, evolutionBudget, 30000)!;
    const route = { provider: 'synthetic', model: 'comparison', route: 'local', authNamespace: 'synthetic', capability: 'standard' as const };
    const run = new CaptureRun(probe.store, lease, probe.archive, { proposer: [route], verifier: [route] }, undefined, 'capture-counting@1');
    const request = run.nextModel()!;
    const correction = probe.archive.append(randomUUID(), '更正：本项目仅保存错误日志');
    probe.store.correctMemory(probe.activity, active.recordId, active, correction, '本项目仅保存错误日志');
    assert.throws(() => run.startModel(request, request.payload), /intent-stale/);
    assert.equal(probe.transport.count, 0);
    assert.equal(probe.store.requestStatus(lease.activity, run.runId).attempts.length, 0);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('a stale tombstone still blocks a same-claim paraphrase from activating', () => {
  const sandbox = createSandbox(), probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const first = verifiedCandidate(probe, '本项目保存原始日志').record!;
    const active = probe.store.promoteMemory(probe.activity, first.recordId, first).record;
    const feedback = probe.archive.append(randomUUID(), JSON.stringify({ schema: 'memory-feedback@1', kind: 'user_wrong',
      recordId: active.recordId, revisionId: active.revisionId, headEventId: active.headEventId }), 'user');
    const stale = probe.store.recordMemoryFeedback(probe.activity, active.recordId, active, feedback).record;
    probe.store.forgetMemory(probe.activity, stale.recordId, stale);
    const second = verifiedCandidate(probe, '本项目保留原始测试日志');
    assert.equal(probe.store.promoteMemory(probe.activity, second.record!.recordId, second.record!).reason, 'comparison-evidence-required');
    const lease = probe.store.claimCaptureJob(probe.activity, second.jobId, evolutionBudget, 30000)!;
    assert.equal(probe.store.captureComparison(lease)!.peer.lifecycle, 'tombstoned');
    probe.store.searchCaptureSources(lease, '本项目');
    probe.store.searchCaptureSources(lease, 'memory-feedback');
    for (const ref of [first.source, second.source, feedback]) probe.store.expandCaptureSource(lease, { ref, offset: 0, limit: 4096 });
    assert.throws(() => probe.store.completeCaptureVerification(lease, { result: 'pass', evidence: [first.source, second.source, feedback] }), /comparison-ineligible/);
    assert.deepEqual(probe.store.listEligibleMemories(probe.activity), []);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

for (const kind of ['user_wrong','user_stale','safety_violation']) test(
  'a new paraphrase cannot bypass unresolved ' + kind + ' feedback', () => {
  const sandbox = createSandbox(), probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const first = verifiedCandidate(probe, '本项目保存原始日志').record!;
    const active = probe.store.promoteMemory(probe.activity, first.recordId, first).record;
    const feedback = probe.archive.append(randomUUID(), JSON.stringify({ schema: 'memory-feedback@1', kind,
      recordId: active.recordId, revisionId: active.revisionId, headEventId: active.headEventId }), 'user');
    probe.store.recordMemoryFeedback(probe.activity, active.recordId, active, feedback);
    const second = verifiedCandidate(probe, '本项目保留完整原始日志');
    const promotion = probe.store.promoteMemory(probe.activity, second.record!.recordId, second.record!);
    assert.equal(promotion.status, 'blocked');
    const lease = probe.store.claimCaptureJob(probe.activity, second.jobId, evolutionBudget, 30000)!;
    const comparison = probe.store.captureComparison(lease)!;
    assert.equal(comparison.peer.recordId, active.recordId);
    probe.store.searchCaptureSources(lease, '本项目');
    probe.store.searchCaptureSources(lease, 'memory-feedback');
    for (const ref of [first.source, second.source, feedback]) probe.store.expandCaptureSource(lease, { ref, offset: 0, limit: 4096 });
    assert.throws(() => probe.store.completeCaptureVerification(lease, { result: 'pass', evidence: [first.source, second.source] }),
      /verification-independent-evidence-required/);
    assert.throws(() => probe.store.completeCaptureVerification(lease, { result: 'pass', evidence: [first.source, second.source, feedback] }),
      /comparison-ineligible/);
    assert.deepEqual(probe.store.listEligibleMemories(probe.activity), []);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('an evidence-gap reverification retains its unresolved safety feedback on the next approval', () => {
  const sandbox = createSandbox();
  let probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const candidate = verifiedCandidate(probe, '本项目保存原始日志').record!;
    const active = probe.store.promoteMemory(probe.activity, candidate.recordId, candidate).record;
    const feedback = probe.archive.append(randomUUID(), JSON.stringify({ schema: 'memory-feedback@1', kind: 'safety_violation',
      recordId: active.recordId, revisionId: active.revisionId, headEventId: active.headEventId }), 'user');
    let current = probe.store.recordMemoryFeedback(probe.activity, active.recordId, active, feedback).record;
    for (let attempt = 0; attempt < 2; attempt++) {
      const approval = probe.archive.append(randomUUID(), JSON.stringify({ schema: 'memory-reverification-approval@1',
        recordId: current.recordId, revisionId: current.revisionId, headEventId: current.headEventId, sourceHash: current.source.hash }), 'user');
      const job = probe.store.queueMemoryVerification(probe.activity, current.recordId, current, approval);
      assert.ok(job.range.some(ref => ref.eventId === feedback.eventId));
      const lease = probe.store.claimCaptureJob(probe.activity, job.jobId, evolutionBudget, 30000)!;
      probe.store.searchCaptureSources(lease, '本项目');
      probe.store.searchCaptureSources(lease, 'memory-');
      for (const ref of job.range) probe.store.expandCaptureSource(lease, { ref, offset: 0, limit: 4096 });
      const evidence = attempt ? job.range.filter(ref => ref.eventId !== feedback.eventId) : job.range;
      const result = probe.store.completeCaptureVerification(lease, { result: attempt ? 'pass' : 'evidence-gap', evidence });
      assert.equal(result.stage, 'blocked');
      current = result.record!;
      probe.close(); probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    }
    assert.deepEqual(probe.store.listEligibleMemories(probe.activity), []);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('independently credible generic and platform-specific contradictions isolate both overlapping records', () => {
  const sandbox = createSandbox(), probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const first = verifiedCandidate(probe, '本项目所有环境都保存原始日志').record!;
    probe.store.promoteMemory(probe.activity, first.recordId, first);
    const second = verifiedCandidate(probe, '本项目 Windows 环境不保存原始日志', { appliesTo: ['platform:win32'] });
    probe.store.promoteMemory(probe.activity, second.record!.recordId, second.record!);
    for (const relation of ['same-claim','distinct','supersedes','superseded-by','conflict']) {
      const lease = probe.store.claimCaptureJob(probe.activity, second.jobId, evolutionBudget, 30000)!;
      assert.equal(probe.store.captureComparison(lease)!.relation, relation);
      probe.store.searchCaptureSources(lease, '本项目');
      for (const ref of [first.source, second.source]) probe.store.expandCaptureSource(lease, { ref, offset: 0, limit: 4096 });
      probe.store.completeCaptureVerification(lease, { result: relation === 'conflict' ? 'pass' : 'block', evidence: [first.source, second.source] });
    }
    assert.equal(probe.store.readMemory(probe.activity, first.recordId).verification, 'conflicted');
    assert.equal(probe.store.readMemory(probe.activity, second.record!.recordId).verification, 'conflicted');
    assert.deepEqual(probe.store.listEligibleMemories(probe.activity), []);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

for (const kind of ['user_wrong','negative_transfer']) for (const expired of [false, true]) test(
  'ordinary supersession feedback restores only a currently eligible previous: ' + kind + ', expired=' + expired, t => {
  const sandbox = createSandbox(), probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const validUntil = new Date(Date.now() + 60_000).toISOString();
    const first = verifiedCandidate(probe, '本项目保存原始日志', { validUntil }).record!;
    const previous = probe.store.promoteMemory(probe.activity, first.recordId, first).record;
    const second = verifiedCandidate(probe, '本项目现决定保存详细原始日志');
    probe.store.promoteMemory(probe.activity, second.record!.recordId, second.record!);
    for (const relation of ['same-claim','distinct','supersedes']) {
      const lease = probe.store.claimCaptureJob(probe.activity, second.jobId, evolutionBudget, 30000)!;
      assert.equal(probe.store.captureComparison(lease)!.relation, relation);
      probe.store.searchCaptureSources(lease, '本项目');
      for (const ref of [first.source, second.source]) probe.store.expandCaptureSource(lease, { ref, offset: 0, limit: 4096 });
      probe.store.completeCaptureVerification(lease, { result: relation === 'supersedes' ? 'pass' : 'block', evidence: [first.source, second.source] });
    }
    const current = probe.store.readCaptureJob(probe.activity, second.jobId).record!;
    const pairs = kind === 'negative_transfer' ? pairedCanary(probe, sandbox, current, bindingOf(sandbox)) : undefined;
    if (expired) t.mock.method(Date, 'now', () => Date.parse(validUntil) + 1);
    const feedback = probe.archive.append(randomUUID(), JSON.stringify({ schema: 'memory-feedback@1', kind,
      recordId: current.recordId, revisionId: current.revisionId, headEventId: current.headEventId, ...(pairs ? { pairs } : {}) }), 'user');
    const result = probe.store.recordMemoryFeedback(probe.activity, current.recordId, current, feedback);
    assert.equal(result.record.recordId, current.recordId);
    assert.equal(result.record.verification, kind === 'negative_transfer' ? 'verified' : 'stale');
    assert.deepEqual(probe.store.listEligibleMemories(probe.activity).map(record => record.recordId), expired ? [] : [previous.recordId]);
    assert.equal(probe.store.registerHostInfo(probe.activity).pending.length, expired ? 2 : 3);
    assert.equal(probe.store.recordMemoryFeedback(probe.activity, current.recordId, current, feedback).status, 'no_op');
    assert.equal(probe.store.registerHostInfo(probe.activity).pending.length, expired ? 2 : 3);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

for (const sameContent of [false, true]) test('a forgotten fact permits an independently verified later period without restoring its tombstone: sameContent=' + sameContent, t => {
  const sandbox = createSandbox(), probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const now = Date.now();
    t.mock.timers.enable({ apis: ['Date'], now });
    const split = new Date(now + 60_000).toISOString();
    const before = { validFrom: new Date(now - 60_000).toISOString(), validUntil: split };
    const content = '本项目合成资源状态为 A';
    const original = observedFact(probe, sandbox, content, before);
    const first = verifiedCandidate(probe, content, { ...before, type: 'fact', evidence: [original] }).record!;
    assert.equal(first.verification, 'verified');
    const active = probe.store.promoteMemory(probe.activity, first.recordId, first).record;
    const forgotten = probe.store.forgetMemory(probe.activity, active.recordId, active).record;
    t.mock.timers.tick(60_001);
    const after = { validFrom: split, validUntil: new Date(Date.parse(split) + 60_000).toISOString() };
    const nextContent = sameContent ? content : '本项目合成资源状态为 B';
    const observation = observedFact(probe, sandbox, nextContent, after);
    const second = verifiedCandidate(probe, nextContent, { ...after, type: 'fact', evidence: [observation] });
    assert.equal(second.record!.verification, 'verified');
    probe.store.promoteMemory(probe.activity, second.record!.recordId, second.record!);
    for (const relation of ['same-claim','distinct','supersedes']) {
      const lease = probe.store.claimCaptureJob(probe.activity, second.jobId, evolutionBudget, 30000)!;
      assert.equal(probe.store.captureComparison(lease)!.relation, relation);
      probe.store.searchCaptureSources(lease, '本项目');
      for (const ref of [first.source, second.source, original, observation]) probe.store.expandCaptureSource(lease, { ref, offset: 0, limit: 4096 });
      probe.store.completeCaptureVerification(lease, { result: relation === 'supersedes' ? 'pass' : 'block', evidence: [first.source, second.source, original, observation] });
    }
    assert.equal(probe.store.readMemory(probe.activity, first.recordId).headEventId, forgotten.headEventId);
    assert.deepEqual(probe.store.listEligibleMemories(probe.activity).map(record => record.recordId), [second.record!.recordId]);
    assert.equal(probe.store.registerHostInfo(probe.activity).pending.length, 2);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('source invalidation restores an independent previous without requiring the revoked replacement proof', () => {
  const sandbox = createSandbox();
  let probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const first = verifiedCandidate(probe, '本项目保存原始日志').record!;
    probe.store.promoteMemory(probe.activity, first.recordId, first);
    const binding = { ...bindingOf(sandbox), sessionId: randomUUID() };
    createSandboxSession(sandbox, binding);
    probe.close(); probe = openProbe(sandbox, undefined, undefined, binding, undefined, true);
    const second = verifiedCandidate(probe, '本项目现决定保存详细原始日志');
    probe.store.promoteMemory(probe.activity, second.record!.recordId, second.record!);
    for (const relation of ['same-claim','distinct','supersedes']) {
      const lease = probe.store.claimCaptureJob(probe.activity, second.jobId, evolutionBudget, 30000)!;
      probe.store.searchCaptureSources(lease, '本项目');
      for (const ref of [first.source, second.source]) probe.store.expandCaptureSource(lease, { ref, offset: 0, limit: 4096 });
      probe.store.completeCaptureVerification(lease, { result: relation === 'supersedes' ? 'pass' : 'block', evidence: [first.source, second.source] });
    }
    const path = sandbox.root + '/session-' + binding.sessionId + '.jsonl';
    writeFileSync(path, readFileSync(path, 'utf8').replace('记住：本项目现决定保存详细原始日志', '记住：本项目没有保存详细原始日志'));
    assert.equal(probe.store.revalidateMemory(probe.activity, second.record!.recordId).reason, 'source-invalidated');
    assert.deepEqual(probe.store.listEligibleMemories(probe.activity).map(record => record.recordId), [first.recordId]);
    assert.equal(probe.store.registerHostInfo(probe.activity).pending.length, 3);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('contradictions with disjoint platforms or effective periods cannot create a conflict set', () => {
  const sandbox = createSandbox(), probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const left = verifiedCandidate(probe, '本项目 Windows 保存日志', { appliesTo: ['platform:win32'] }).record!;
    const right = verifiedCandidate(probe, '本项目 Linux 不保存日志', { appliesTo: ['platform:linux'] }).record!;
    assert.throws(() => probe.store.conflictMemory(probe.activity, left.recordId, left, right.recordId, right), /invalid-conflict/);
    const before = verifiedCandidate(probe, '本项目旧有效期保存日志', { validUntil: '2000-01-01T00:00:00.000Z' }).record!;
    const after = verifiedCandidate(probe, '本项目新有效期不保存日志', { validFrom: '2000-01-01T00:00:00.000Z' }).record!;
    assert.throws(() => probe.store.conflictMemory(probe.activity, before.recordId, before, after.recordId, after), /invalid-conflict/);
    for (const record of [left,right,before,after]) assert.equal(probe.store.readMemory(probe.activity, record.recordId).hash, record.hash);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('the real owner CLI archives exact feedback, refuses an old head and excludes the invalidated memory from ask', () => {
  const sandbox = createSandbox();
  let probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const first = verifiedCandidate(probe, '本项目保存原始日志').record!;
    const active = probe.store.promoteMemory(probe.activity, first.recordId, first).record;
    probe.close();
    const output = execFileSync(process.execPath, ['apps/cli/src/main.ts','remember','--sandbox',sandbox.root], { encoding: 'utf8', timeout: 20000,
      input: `feedback ${active.recordId} ${active.headEventId} wrong\nfeedback ${active.recordId} ${active.headEventId} helpful\nask 本项目日志怎么处理？\nstop\n` });
    probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    const events = output.trim().split('\n').map(line => JSON.parse(line));
    const result = events.find(event => event.event === 'memory-feedback-result');
    assert.equal(result.verification, 'stale');
    assert.equal(result.level, 'warning');
    assert.ok(events.some(event => event.event === 'command-error' && event.reason === 'memory-stale'));
    assert.deepEqual(events.find(event => event.event === 'ask-result').selected, []);
    const feedback = probe.store.readMemoryFeedback(probe.activity, active.recordId).events.filter(event => event.kind === 'user_wrong');
    assert.equal(feedback.length, 1);
    assert.equal(probe.archive.events().filter(event => event.text.startsWith('feedback ')).length, 1);
  } finally { try { probe.close(); } catch {} rmSync(sandbox.root, { recursive: true, force: true }); }
});
