import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { CaptureRun } from '@euler/core';
import { bindingOf, createSandbox, createSandboxSession, resourcesOf } from '../src/sandbox.ts';
import { approvedSourceUnit } from './support/source-publication.ts';
import { openProbe } from '../src/probe.ts';
import { compareCandidate, evolutionBudget, observedFact, pairedCanary, verifiedCandidate } from './support/memory-evolution.ts';

for (const firstRelation of ['same-claim','conflict'] as const) test('new evidence extends an existing conflict group with ' + firstRelation + ' first', () => {
  const sandbox = createSandbox();
  let probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const first = verifiedCandidate(probe, '本项目本周期保存原始日志');
    probe.store.promoteMemory(probe.activity, first.record!.recordId, first.record!);
    const second = verifiedCandidate(probe, '本项目本周期不保存原始日志');
    probe.store.promoteMemory(probe.activity, second.record!.recordId, second.record!);
    assert.equal(compareCandidate(probe, second.jobId, 'conflict').reason, 'credible-conflict');
    const peers = [first, second].map(job => probe.store.readMemory(probe.activity, job.record!.recordId))
      .sort((left, right) => left.recordId.localeCompare(right.recordId));
    const same = peers[firstRelation === 'same-claim' ? 0 : 1]!;
    const candidate = verifiedCandidate(probe, same.recordId === first.record!.recordId
      ? '本项目本周期保留原始日志' : '本项目本周期不保留原始日志');
    probe.store.promoteMemory(probe.activity, candidate.record!.recordId, candidate.record!);
    for (let index = 0; index < peers.length; index++) {
      const compared = compareCandidate(probe, candidate.jobId, peers[index]!.recordId === same.recordId ? 'same-claim' : 'conflict');
      assert.equal(compared.stage, index === 0 ? 'comparing' : 'blocked');
      assert.equal(compared.reason, index === 0 ? 'comparison-evidence-required' : 'credible-conflict');
      const members = [...peers, candidate.record!].map(record => probe.store.readMemory(probe.activity, record.recordId));
      assert.ok(members.every(record => record.verification === 'conflicted' && record.conflictSetId === members[0]!.conflictSetId));
      assert.deepEqual(probe.store.listEligibleMemories(probe.activity), []);
      probe.store.drainSearchProjection(probe.activity, 128);
      assert.ok(probe.store.searchMemories(probe.activity, { query: '本项目' }).results.every(hit => hit.kind === 'status'));
      probe.close(); probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    }
    const history = probe.store.inspectMemory(probe.activity, same.recordId).history;
    const corroboration = history.filter(event => event.kind === 'corroborate');
    assert.equal(corroboration.length, 1);
    assert.deepEqual(JSON.parse(corroboration[0]!.payload).source, candidate.source);
    assert.throws(() => probe.session.prepare(randomUUID(), '本项目如何保留日志？',
      [probe.store.readMemory(probe.activity, candidate.record!.recordId)]), /assembly-evidence-gap/);
    assert.equal(probe.transport.count, 0);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

for (const mutation of ['none','wrong','forget','correct']) test('duplicate evidence resolves canonically and retains the ' + mutation + ' barrier', () => {
  const sandbox = createSandbox(), probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const drafts = ['本项目测试保留原始日志','本项目测试保存原始日志'].map(content => {
      const source = probe.archive.append(randomUUID(), '记住：' + content);
      const queued = probe.store.queueOwnerCapture(probe.activity, source);
      const lease = probe.store.claimCaptureJob(probe.activity, queued.jobId, evolutionBudget, 30000)!;
      return probe.store.captureProposedMemory(lease, { type: 'decision', content });
    }).sort((left, right) => right.record!.recordId.localeCompare(left.record!.recordId));
    for (const [index, draft] of drafts.entries()) {
      const lease = probe.store.claimCaptureJob(probe.activity, draft.jobId, evolutionBudget, 30000)!;
      probe.store.searchCaptureSources(lease, '本项目');
      probe.store.expandCaptureSource(lease, { ref: draft.source, offset: 0, limit: 4096 });
      const job = probe.store.completeCaptureVerification(lease, { result: 'pass', evidence: [draft.source] });
      probe.store.promoteMemory(probe.activity, job.record!.recordId, job.record!);
      if (index) {
        const comparison = probe.store.claimCaptureJob(probe.activity, job.jobId, evolutionBudget, 30000)!;
        probe.store.searchCaptureSources(comparison, '本项目');
        for (const ref of drafts.map(item => item.source)) probe.store.expandCaptureSource(comparison, { ref, offset: 0, limit: 4096 });
        const duplicate = probe.store.completeCaptureVerification(comparison, { result: 'pass', evidence: drafts.map(item => item.source) });
        assert.equal(duplicate.reason, 'claim-corroborated');
      }
    }
    const canonical = probe.store.readMemory(probe.activity, drafts[0]!.record!.recordId);
    const third = verifiedCandidate(probe, '本项目测试留存原始日志');
    probe.store.promoteMemory(probe.activity, third.record!.recordId, third.record!);
    const lease = probe.store.claimCaptureJob(probe.activity, third.jobId, evolutionBudget, 30000)!;
    const input = probe.store.captureComparison(lease)!;
    assert.equal(input.peer.recordId, canonical.recordId);
    probe.store.searchCaptureSources(lease, '本项目');
    for (const ref of [canonical.source, third.source]) probe.store.expandCaptureSource(lease, { ref, offset: 0, limit: 4096 });
    assert.equal(probe.store.completeCaptureVerification(lease, { result: 'pass', evidence: [canonical.source, third.source] }).reason, 'claim-corroborated');
    assert.deepEqual(probe.store.listEligibleMemories(probe.activity).map(record => record.recordId), [canonical.recordId]);
    assert.notEqual(probe.store.readMemory(probe.activity, canonical.recordId).headEventId, canonical.headEventId);
    assert.equal(probe.store.registerHostInfo(probe.activity).pending.length, 1);
    const current = probe.store.readMemory(probe.activity, canonical.recordId);
    if (mutation === 'wrong') {
      const feedback = probe.archive.append(randomUUID(), JSON.stringify({ schema: 'memory-feedback@1', kind: 'user_wrong',
        recordId: current.recordId, revisionId: current.revisionId, headEventId: current.headEventId }), 'user');
      probe.store.recordMemoryFeedback(probe.activity, current.recordId, current, feedback);
    } else if (mutation === 'forget') probe.store.forgetMemory(probe.activity, current.recordId, current);
    else if (mutation === 'correct') {
      const input = probe.archive.append(randomUUID(), '更正：本项目仅保留错误日志');
      probe.store.correctMemory(probe.activity, current.recordId, current, input, '本项目仅保留错误日志');
    }
    if (mutation !== 'none') {
      const fourth = verifiedCandidate(probe, '本项目测试原始日志全部保留');
      probe.store.promoteMemory(probe.activity, fourth.record!.recordId, fourth.record!);
      assert.throws(() => compareCandidate(probe, fourth.jobId, 'same-claim'), /comparison-ineligible/);
      assert.deepEqual(probe.store.listEligibleMemories(probe.activity), []);
    }
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

for (const loss of ['delete','change']) test('a lost canonical source does not block duplicate projection recovery: ' + loss, () => {
  const sandbox = createSandbox();
  const firstBinding = { ...bindingOf(sandbox), sessionId: randomUUID() };
  createSandboxSession(sandbox, firstBinding);
  let probe = openProbe(sandbox, undefined, undefined, firstBinding, undefined, true);
  try {
    const first = verifiedCandidate(probe, '本项目保存原始日志').record!;
    probe.store.promoteMemory(probe.activity, first.recordId, first);
    const next = { ...firstBinding, sessionId: randomUUID() };
    createSandboxSession(sandbox, next); probe.close();
    probe = openProbe(sandbox, undefined, undefined, next, undefined, true);
    const duplicate = verifiedCandidate(probe, '本项目保留原始日志');
    probe.store.promoteMemory(probe.activity, duplicate.record!.recordId, duplicate.record!);
    assert.equal(compareCandidate(probe, duplicate.jobId, 'same-claim').reason, 'claim-corroborated');
    const path = sandbox.root + '/session-' + firstBinding.sessionId + '.jsonl';
    if (loss === 'delete') rmSync(path);
    else writeFileSync(path, readFileSync(path, 'utf8').replace('本项目保存原始日志', '本项目不留原始日志'));
    assert.equal(probe.store.revalidateMemory(probe.activity, first.recordId).reason, 'source-invalidated');
    for (let attempt = 0; attempt < 2; attempt++) {
      probe.store.drainSearchProjection(probe.activity, 128);
      probe.store.rebuildSearchProjection(probe.activity);
      const page = probe.store.searchMemories(probe.activity, { query: '本项目' });
      assert.equal(page.status, 'ready');
      assert.deepEqual(page.results.map(hit => [hit.unitId, hit.kind]), [[first.recordId, 'status']]);
      probe.close(); probe = openProbe(sandbox, undefined, undefined, next, undefined, true);
    }
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

for (const duplicate of ['none','present','source-lost']) test('successive owner updates remain promotable with duplicate history: ' + duplicate, () => {
  const sandbox = createSandbox();
  let probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const first = verifiedCandidate(probe, '本项目保存原始日志').record!;
    probe.store.promoteMemory(probe.activity, first.recordId, first);
    const duplicateBinding = { ...bindingOf(sandbox), sessionId: randomUUID() };
    if (duplicate !== 'none') {
      createSandboxSession(sandbox, duplicateBinding); probe.close();
      probe = openProbe(sandbox, undefined, undefined, duplicateBinding, undefined, true);
      const corroboration = verifiedCandidate(probe, '本项目保留原始日志');
      probe.store.promoteMemory(probe.activity, corroboration.record!.recordId, corroboration.record!);
      assert.equal(compareCandidate(probe, corroboration.jobId, 'same-claim').reason, 'claim-corroborated');
      probe.close(); probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    }
    for (const [index, content] of ['本项目现决定保存详细原始日志','本项目现决定保存完整原始日志及诊断信息'].entries()) {
      const next = verifiedCandidate(probe, content);
      probe.store.promoteMemory(probe.activity, next.record!.recordId, next.record!);
      let compared = compareCandidate(probe, next.jobId, 'supersedes');
      if (compared.stage === 'comparing') compared = compareCandidate(probe, next.jobId, 'supersedes');
      assert.equal(compared.record!.lifecycle, 'active');
      assert.deepEqual(probe.store.listEligibleMemories(probe.activity).map(record => record.recordId), [next.record!.recordId]);
      if (duplicate === 'source-lost' && index === 0) rmSync(sandbox.root + '/session-' + duplicateBinding.sessionId + '.jsonl');
    }
    assert.equal(probe.store.registerHostInfo(probe.activity).pending.length, 3);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

for (const operation of ['dispatch','restore']) test('complete current-revision provenance qualifies ' + operation, () => {
  const sandbox = createSandbox();
  let probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const input = probe.archive.append(randomUUID(), '记住决定：本项目保存原始日志');
    const first = probe.store.rememberMemory(probe.activity, { input, hostInfo: 'durable' }).record!;
    const extraBinding = { ...bindingOf(sandbox), sessionId: randomUUID() };
    createSandboxSession(sandbox, extraBinding); probe.close();
    probe = openProbe(sandbox, undefined, undefined, extraBinding, undefined, true);
    probe.store.rememberMemory(probe.activity, {
      input: probe.archive.append(randomUUID(), '记住决定：本项目保存原始日志'), hostInfo: 'durable' });
    const third = { ...extraBinding, sessionId: randomUUID() };
    createSandboxSession(sandbox, third); probe.close();
    probe = openProbe(sandbox, undefined, undefined, third, undefined, true);
    if (operation === 'dispatch') {
      const selected = probe.store.readMemory(probe.activity, first.recordId);
      const prepared = probe.session.prepare(randomUUID(), '本项目如何保存日志？', [selected]);
      rmSync(sandbox.root + '/session-' + extraBinding.sessionId + '.jsonl');
      assert.throws(() => probe.session.dispatch(prepared), /source-evidence-gap|ENOENT/);
      assert.equal(probe.transport.count, 0);
    } else {
      const next = verifiedCandidate(probe, '本项目现决定保存详细原始日志');
      probe.store.promoteMemory(probe.activity, next.record!.recordId, next.record!);
      const current = compareCandidate(probe, next.jobId, 'supersedes').record!;
      rmSync(sandbox.root + '/session-' + extraBinding.sessionId + '.jsonl');
      const feedback = probe.archive.append(randomUUID(), JSON.stringify({ schema: 'memory-feedback@1', kind: 'user_wrong',
        recordId: current.recordId, revisionId: current.revisionId, headEventId: current.headEventId }), 'user');
      probe.store.recordMemoryFeedback(probe.activity, current.recordId, current, feedback);
      assert.equal(probe.store.readMemory(probe.activity, first.recordId).lifecycle, 'superseded');
      assert.deepEqual(probe.store.listEligibleMemories(probe.activity), []);
      assert.equal(probe.store.registerHostInfo(probe.activity).pending.length, 2);
    }
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('memory feedback preserves prior session injection history without widening request authority', () => {
  const sandbox = createSandbox();
  let probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const first = verifiedCandidate(probe, '本项目保存原始日志').record!;
    const active = probe.store.promoteMemory(probe.activity, first.recordId, first).record;
    const sent = probe.session.dispatch(probe.session.prepare(randomUUID(), '本项目如何保存日志？', [active]));
    const next = { ...bindingOf(sandbox), sessionId: randomUUID() };
    createSandboxSession(sandbox, next); probe.close();
    probe = openProbe(sandbox, undefined, undefined, next, undefined, true);
    assert.deepEqual(probe.store.readMemoryFeedback(probe.activity, active.recordId).injected.map(use => [use.runId, use.recordId, use.payloadHash]),
      [[sent.runId, active.recordId, sent.payloadHash]]);
    assert.throws(() => probe.store.requestStatus(probe.activity, sent.runId), /request-scope-mismatch/);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('owner-attributed negative transfer can verify archived canary pairs from a prior session', () => {
  const sandbox = createSandbox();
  let probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const first = verifiedCandidate(probe, '本项目保存原始日志').record!;
    const active = probe.store.promoteMemory(probe.activity, first.recordId, first).record;
    const pairs = pairedCanary(probe, sandbox, active, bindingOf(sandbox));
    const next = { ...bindingOf(sandbox), sessionId: randomUUID() };
    createSandboxSession(sandbox, next); probe.close();
    probe = openProbe(sandbox, undefined, undefined, next, undefined, true);
    const feedback = probe.archive.append(randomUUID(), JSON.stringify({ schema: 'memory-feedback@1', kind: 'negative_transfer',
      recordId: active.recordId, revisionId: active.revisionId, headEventId: active.headEventId, pairs }), 'user');
    const result = probe.store.recordMemoryFeedback(probe.activity, active.recordId, active, feedback);
    assert.deepEqual([result.record.lifecycle, result.record.verification], ['rejected', 'verified']);
    assert.throws(() => probe.store.agentStatus(probe.activity, pairs[0]!.baselineRunId), /request-scope-mismatch/);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

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

test('a credible broad contradiction continues across every peer and survives restart without exposing confirmed conflicts', () => {
  const sandbox = createSandbox();
  let probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const first = verifiedCandidate(probe, '本项目 Windows 本周期保存日志', { appliesTo: ['platform:win32'] }).record!;
    probe.store.promoteMemory(probe.activity, first.recordId, first);
    const second = verifiedCandidate(probe, '本项目 Linux 本周期保存日志', { appliesTo: ['platform:linux'] });
    probe.store.promoteMemory(probe.activity, second.record!.recordId, second.record!);
    assert.equal(compareCandidate(probe, second.jobId, 'distinct').record!.lifecycle, 'active');
    const current = [first, second.record!].map(record => probe.store.readMemory(probe.activity, record.recordId));
    const selected = current.filter(record => record.appliesTo.includes('platform:' + process.platform));
    const prepared = probe.session.prepare(randomUUID(), '本项目当前环境如何保存日志？', selected);
    const third = verifiedCandidate(probe, '本项目所有环境本周期都不保存日志');
    probe.store.promoteMemory(probe.activity, third.record!.recordId, third.record!);
    const pending = compareCandidate(probe, third.jobId, 'conflict');
    assert.equal(pending.stage, 'comparing');
    assert.equal(pending.record!.verification, 'conflicted');
    assert.equal(current.filter(record => probe.store.readMemory(probe.activity, record.recordId).verification === 'conflicted').length, 1);
    if (selected.length && probe.store.readMemory(probe.activity, selected[0]!.recordId).verification === 'conflicted') {
      assert.throws(() => probe.session.dispatch(prepared), /memory-stale/);
      assert.equal(probe.transport.count, 0);
    }
    probe.close(); probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    const completed = compareCandidate(probe, third.jobId, 'conflict');
    assert.equal(completed.stage, 'blocked'); assert.equal(completed.reason, 'credible-conflict');
    const members = [...current, third.record!].map(record => probe.store.readMemory(probe.activity, record.recordId));
    assert.ok(members.every(record => record.verification === 'conflicted' && record.conflictSetId === completed.record!.conflictSetId));
    assert.deepEqual(probe.store.listEligibleMemories(probe.activity), []);
    assert.equal(probe.store.registerHostInfo(probe.activity).pending.length, 2);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

for (const remaining of ['distinct','evidence-gap']) test('a confirmed conflict stays isolated while the remaining peer is ' + remaining, () => {
  const sandbox = createSandbox(), probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const first = verifiedCandidate(probe, '本项目保存原始日志').record!;
    probe.store.promoteMemory(probe.activity, first.recordId, first);
    const second = verifiedCandidate(probe, '本项目界面采用蓝色');
    probe.store.promoteMemory(probe.activity, second.record!.recordId, second.record!);
    compareCandidate(probe, second.jobId, 'distinct');
    const peers = [first, second.record!].map(record => probe.store.readMemory(probe.activity, record.recordId))
      .sort((left, right) => left.recordId.localeCompare(right.recordId));
    const negative = peers[0]!.recordId === first.recordId ? '本项目本周期不保存原始日志' : '本项目本周期禁止蓝色界面';
    const third = verifiedCandidate(probe, negative);
    probe.store.promoteMemory(probe.activity, third.record!.recordId, third.record!);
    const prepared = probe.session.prepare(randomUUID(), '本项目有哪些已确认约束？', [peers[0]!]);
    assert.equal(compareCandidate(probe, third.jobId, 'conflict').stage, 'comparing');
    assert.throws(() => probe.session.dispatch(prepared), /memory-stale/);
    assert.equal(probe.transport.count, 0);
    if (remaining === 'distinct') assert.equal(compareCandidate(probe, third.jobId, 'distinct').reason, 'credible-conflict');
    else {
      const lease = probe.store.claimCaptureJob(probe.activity, third.jobId, evolutionBudget, 30000)!;
      assert.equal(probe.store.completeCaptureVerification(lease, { result: 'evidence-gap', evidence: [] }).reason, 'comparison-evidence-gap');
    }
    assert.equal(probe.store.readMemory(probe.activity, peers[0]!.recordId).verification, 'conflicted');
    assert.equal(probe.store.readMemory(probe.activity, third.record!.recordId).verification, 'conflicted');
    assert.deepEqual(probe.store.listEligibleMemories(probe.activity).map(record => record.recordId), [peers[1]!.recordId]);
    assert.equal(probe.store.readMemory(probe.activity, peers[1]!.recordId).headEventId, peers[1]!.headEventId);
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
