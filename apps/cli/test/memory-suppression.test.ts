import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { bindingOf, createSandbox, createSandboxSession } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';
import { compareCandidate, evolutionBudget, verifiedCandidate } from './support/memory-evolution.ts';

for (const content of ['本项目使用 pnpm', '  本项目使用 pnpm  ', '本项目命名使用 cafe\u0301'])
test('a reverified correction is the canonical active claim before and after forget: ' + JSON.stringify(content), () => {
  const sandbox = createSandbox(), probe = openProbe(sandbox);
  try {
    const initial = probe.store.rememberMemory(probe.activity, {
      input: probe.archive.append(randomUUID(), '记住偏好：本项目使用 npm'), hostInfo: 'durable' }).record;
    const corrected = probe.store.correctMemory(probe.activity, initial.recordId, initial,
      probe.archive.append(randomUUID(), '本项目更正为：' + content), content).record;
    const job = probe.store.queueMemoryVerification(probe.activity, corrected.recordId, corrected);
    const lease = probe.store.claimCaptureJob(probe.activity, job.jobId, evolutionBudget, 30000)!;
    probe.store.searchCaptureSources(lease, '本项目');
    for (const ref of job.range) probe.store.expandCaptureSource(lease, { ref, offset: 0, limit: 4096 });
    const verified = probe.store.completeCaptureVerification(lease, { result: 'pass', evidence: job.range }).record!;
    const active = probe.store.promoteMemory(probe.activity, verified.recordId, verified).record;
    assert.equal(active.lifecycle, 'active');
    const repeated = probe.store.rememberMemory(probe.activity, {
      input: probe.archive.append(randomUUID(), '记住偏好：' + content.trim().normalize('NFC')), hostInfo: 'durable' });
    assert.equal(repeated.status, 'no_op');
    assert.equal(repeated.record.recordId, initial.recordId);
    assert.equal(repeated.reason, 'claim-already-active');
    probe.store.forgetMemory(probe.activity, active.recordId, active);
    probe.store.drainSearchProjection(probe.activity);
    const page = probe.store.searchMemories(probe.activity, { query: '本项目' });
    assert.equal(page.status, 'ready');
    assert.deepEqual(page.results, []);
    assert.deepEqual(probe.store.listEligibleMemories(probe.activity), []);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('direct capture retains a later-period fact as an unverified candidate without reopening the forgotten interval', t => {
  const sandbox = createSandbox(), probe = openProbe(sandbox);
  try {
    const now = Date.now(); t.mock.timers.enable({ apis: ['Date'], now });
    const split = new Date(now + 1000).toISOString();
    const options = { type: 'fact' as const, scope: { kind: 'project' as const, id: sandbox.fixture.projectId, resolved: true },
      claimKey: 'synthetic/resource', appliesTo: [], validFrom: new Date(now - 1000).toISOString(), validUntil: split };
    const input = probe.archive.append(randomUUID(), '本项目合成资源状态为 A');
    const captured = probe.store.captureMemory(probe.activity, input, '本项目合成资源状态为 A', options).record;
    const verified = probe.store.verifyMemory(probe.activity, captured.recordId, captured, 'pass', [input]).record;
    const active = probe.store.activateMemory(probe.activity, verified.recordId, verified).record;
    const forgotten = probe.store.forgetMemory(probe.activity, active.recordId, active).record;
    t.mock.timers.tick(1001);
    const nextInput = probe.archive.append(randomUUID(), '本项目合成资源状态为 A');
    const nextOptions = { ...options, validFrom: split, validUntil: new Date(now + 2000).toISOString() };
    const next = probe.store.captureMemory(probe.activity, nextInput, active.content, nextOptions);
    assert.equal(next.status, 'committed');
    assert.notEqual(next.record.recordId, forgotten.recordId);
    assert.equal(next.record.lifecycle, 'candidate'); assert.equal(next.record.verification, 'unverified');
    assert.deepEqual(probe.store.captureMemory(probe.activity, nextInput, active.content, nextOptions).record, next.record);
    const overlapping = probe.store.captureMemory(probe.activity, probe.archive.append(randomUUID(), '旧区间重复导入'), active.content,
      { ...nextOptions, validFrom: new Date(now).toISOString() });
    assert.equal(overlapping.status, 'no_op'); assert.equal(overlapping.record.recordId, forgotten.recordId);
    const approval = probe.archive.append(randomUUID(), JSON.stringify({ schema: 'memory-reverification-approval@1',
      recordId: next.record.recordId, revisionId: next.record.revisionId, headEventId: next.record.headEventId, sourceHash: nextInput.hash }));
    const queued = probe.store.queueMemoryVerification(probe.activity, next.record.recordId, next.record, approval);
    assert.equal(queued.record!.recordId, next.record.recordId);
    assert.equal(queued.stage, 'pending');
    assert.equal(probe.store.readMemory(probe.activity, forgotten.recordId).headEventId, forgotten.headEventId);
    assert.deepEqual(probe.store.listEligibleMemories(probe.activity), []);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

for (const origin of ['correction', 'cross-session-correction', 'corroboration'] as const)
test(`forget freezes the current claim and established source lineages: ${origin}`, () => {
  const sandbox = createSandbox();
  let probe = openProbe(sandbox);
  try {
    const remember = (content: string) => probe.store.rememberMemory(probe.activity, {
      input: probe.archive.append(randomUUID(), `记住偏好：${content}`), hostInfo: 'durable' });
    const initial = remember('使用 npm').record;
    if (origin !== 'correction') {
      const binding = { ...bindingOf(sandbox), sessionId: randomUUID() };
      createSandboxSession(sandbox, binding); probe.close();
      probe = openProbe(sandbox, undefined, undefined, binding);
    }
    const current = origin === 'corroboration' ? remember('使用 npm').record
      : probe.store.correctMemory(probe.activity, initial.recordId, initial,
        probe.archive.append(randomUUID(), '更正为使用 pnpm'), '使用 pnpm').record;
    const forgotten = probe.store.forgetMemory(probe.activity, current.recordId, current).record;
    for (const content of [current.content, initial.content]) {
      const repeated = remember(content);
      assert.equal(repeated.status, 'no_op');
      assert.equal(repeated.reason, 'memory-suppressed');
      assert.equal(repeated.record.recordId, initial.recordId);
      assert.equal(repeated.record.headEventId, forgotten.headEventId);
    }
    const frozen = JSON.parse(probe.store.inspectMemory(probe.activity, current.recordId).history.at(-1)!.payload);
    assert.equal(frozen.suppression.headEventId, current.headEventId);
    assert.equal(frozen.suppression.revisionId, current.revisionId);
    assert.ok(frozen.suppression.sources.some((ref: { hash: string }) => ref.hash === initial.source.hash));
    assert.ok(frozen.suppression.sources.some((ref: { hash: string }) => ref.hash === current.source.hash));
    assert.deepEqual(probe.store.listEligibleMemories(probe.activity), []);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('same-lineage paraphrases remain evidence-gap while an independently established distinct claim can activate', () => {
  const sandbox = createSandbox(), probe = openProbe(sandbox);
  try {
    const original = probe.store.rememberMemory(probe.activity, {
      input: probe.archive.append(randomUUID(), '记住偏好：本项目使用 pnpm'), hostInfo: 'durable' }).record;
    const forgotten = probe.store.forgetMemory(probe.activity, original.recordId, original).record;
    const input = probe.archive.append(randomUUID(), '记住偏好：本项目使用 pnpm。');
    const request = { input, hostInfo: 'durable' as const };
    const pending = probe.store.rememberMemory(probe.activity, request);
    assert.equal(pending.status, 'blocked');
    assert.equal(pending.reason, 'suppression-identity-evidence-gap');
    assert.equal(pending.record.lifecycle, 'candidate');
    assert.equal(pending.record.verification, 'unverified');
    assert.equal(probe.store.rememberMemory(probe.activity, request).record.headEventId, pending.record.headEventId);
    const synthetic = probe.store.verifyMemory(probe.activity, pending.record.recordId, pending.record, 'pass', [input]).record;
    assert.throws(() => probe.store.activateMemory(probe.activity, synthetic.recordId, synthetic), /suppression-identity-evidence-gap/);
    assert.throws(() => probe.store.activateMemoryBatch(probe.activity, [synthetic]), /suppression-identity-evidence-gap/);
    assert.deepEqual(probe.store.listEligibleMemories(probe.activity), []);
    const distinct = verifiedCandidate(probe, '本项目日志使用 UTC 时间');
    probe.store.promoteMemory(probe.activity, distinct.record!.recordId, distinct.record!);
    let result = compareCandidate(probe, distinct.jobId, 'distinct');
    if (result.stage === 'comparing') result = compareCandidate(probe, distinct.jobId, 'distinct');
    assert.equal(result.record!.lifecycle, 'active');
    assert.equal(probe.store.readMemory(probe.activity, original.recordId).headEventId, forgotten.headEventId);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

for (const alias of ['agent:cli', 'cli']) test(`applies-to aliases cannot bypass suppression: ${alias}`, () => {
  const sandbox = createSandbox(), probe = openProbe(sandbox);
  try {
    const input = probe.archive.append(randomUUID(), '使用本地路由');
    const options = { type: 'preference' as const, claimKey: 'synthetic/route',
      scope: { kind: 'project' as const, id: sandbox.fixture.projectId, resolved: true }, appliesTo: ['cli'] };
    const candidate = probe.store.captureMemory(probe.activity, input, '使用本地路由', options).record;
    const verified = probe.store.verifyMemory(probe.activity, candidate.recordId, candidate, 'pass', [input]).record;
    const active = probe.store.activateMemory(probe.activity, verified.recordId, verified).record;
    probe.store.forgetMemory(probe.activity, active.recordId, active);
    const replay = probe.store.captureMemory(probe.activity, probe.archive.append(randomUUID(), '重复导入'),
      '使用本地路由', { ...options, appliesTo: [alias] });
    assert.equal(replay.status, 'no_op');
    assert.equal(replay.record.recordId, active.recordId);
    const other = probe.store.captureMemory(probe.activity, probe.archive.append(randomUUID(), '不同适用环境'),
      '使用本地路由', { ...options, appliesTo: ['agent:other'] });
    assert.equal(other.status, 'committed');
    const otherVerified = probe.store.verifyMemory(probe.activity, other.record.recordId, other.record, 'pass', [other.record.source]).record;
    assert.equal(probe.store.activateMemory(probe.activity, otherVerified.recordId, otherVerified).record.lifecycle, 'active');
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

for (const boundary of ['scope', 'independent-lineage'] as const)
test('suppression does not become a global content hash ban: ' + boundary, () => {
  const sandbox = createSandbox();
  let probe = openProbe(sandbox);
  try {
    const content = '本项目使用 pnpm';
    const first = probe.store.rememberMemory(probe.activity, {
      input: probe.archive.append(randomUUID(), '记住偏好：' + content), hostInfo: 'durable' }).record;
    probe.store.forgetMemory(probe.activity, first.recordId, first);
    if (boundary === 'independent-lineage') {
      const binding = { ...bindingOf(sandbox), sessionId: randomUUID() };
      createSandboxSession(sandbox, binding); probe.close();
      probe = openProbe(sandbox, undefined, undefined, binding);
      const independent = probe.store.rememberMemory(probe.activity, {
        input: probe.archive.append(randomUUID(), '记住偏好：' + content), hostInfo: 'durable' });
      assert.equal(independent.status, 'activated');
      assert.notEqual(independent.record.recordId, first.recordId);
    } else {
      const input = probe.archive.append(randomUUID(), '记住偏好：' + content);
      const candidate = probe.store.captureMemory(probe.activity, input, content, { type: 'preference', appliesTo: [],
        scope: { kind: 'personal', id: sandbox.fixture.ownerId, resolved: true } }).record;
      const verified = probe.store.verifyMemory(probe.activity, candidate.recordId, candidate, 'pass', [input]).record;
      assert.equal(probe.store.activateMemory(probe.activity, verified.recordId, verified).record.lifecycle, 'active');
    }
    assert.equal(probe.store.readMemory(probe.activity, first.recordId).lifecycle, 'tombstoned');
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
