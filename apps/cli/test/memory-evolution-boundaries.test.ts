import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { CaptureRun } from '@euler/core';
import { createSandbox, resourcesOf } from '../src/sandbox.ts';
import { approvedSourceUnit } from './support/source-publication.ts';
import { openProbe } from '../src/probe.ts';
import { evolutionBudget, verifiedCandidate } from './support/memory-evolution.ts';

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
    for (const ref of [first.source, second.source]) probe.store.expandCaptureSource(lease, { ref, offset: 0, limit: 4096 });
    assert.throws(() => probe.store.completeCaptureVerification(lease, { result: 'pass', evidence: [first.source, second.source] }), /comparison-ineligible/);
    assert.deepEqual(probe.store.listEligibleMemories(probe.activity), []);
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
