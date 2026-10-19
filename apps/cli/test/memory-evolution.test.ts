import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { evolutionBudget, observedTask, pairedCanary, verifiedCandidate } from './support/memory-evolution.ts';
import { bindingOf, createSandbox, createSandboxSession, resourcesOf } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';
import { drainCaptures } from '../src/capture.ts';



test('an independently verified ordinary project candidate activates once with a durable Info batch', () => {
  const sandbox = createSandbox();
  let probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const candidate = verifiedCandidate(probe, '本项目在测试完成后保存原始日志').record!;
    const result = probe.store.promoteMemory(probe.activity, candidate.recordId, candidate);
    assert.equal(result.status, 'activated');
    assert.equal(result.record.lifecycle, 'active');
    assert.equal(result.record.verification, 'verified');
    assert.ok(result.batchId);
    const batch = probe.store.readActivationBatch(probe.activity, result.batchId!);
    assert.deepEqual(batch.events.map(event => event.recordId), [candidate.recordId]);
    assert.equal(batch.events[0]!.before.lifecycle, 'candidate');
    assert.equal(batch.events[0]!.after.hash, result.record.hash);
    const head = result.record.headEventId;
    probe.close(); probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    const replay = probe.store.promoteMemory(probe.activity, candidate.recordId, candidate);
    assert.equal(replay.status, 'no_op');
    assert.equal(replay.record.headEventId, head);
    assert.equal(replay.batchId, result.batchId);
    assert.equal(probe.store.listEligibleMemories(probe.activity).length, 1);
    assert.equal(probe.store.registerHostInfo(probe.activity).pending.length, 1);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('a source-bound independent comparison attaches new evidence without a second active claim', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const first = verifiedCandidate(probe, '本项目在测试完成后保存原始日志').record!;
    const active = probe.store.promoteMemory(probe.activity, first.recordId, first).record;
    const second = verifiedCandidate(probe, '测试结束后，本项目保留原始日志');
    const waiting = probe.store.promoteMemory(probe.activity, second.record!.recordId, second.record!);
    assert.equal(waiting.status, 'blocked');
    assert.equal(waiting.reason, 'comparison-evidence-required');
    const lease = probe.store.claimCaptureJob(probe.activity, second.jobId, evolutionBudget, 30000)!;
    const comparison = probe.store.captureComparison(lease)!;
    assert.equal(comparison.relation, 'same-claim');
    assert.equal(comparison.peer.recordId, active.recordId);
    assert.equal(comparison.peer.headEventId, active.headEventId);
    assert.throws(() => probe.store.completeCaptureVerification(lease,
      { result: 'pass', evidence: [second.source, active.source] }), /independent-evidence/);
    probe.store.searchCaptureSources(lease, '原始日志');
    for (const ref of [second.source, active.source]) probe.store.expandCaptureSource(lease, { ref, offset: 0, limit: 4096 });
    const result = probe.store.completeCaptureVerification(lease, { result: 'pass', evidence: [second.source, active.source] });
    assert.equal(result.stage, 'complete');
    assert.equal(result.reason, 'claim-corroborated');
    assert.equal(result.record!.lifecycle, 'rejected');
    const eligible = probe.store.listEligibleMemories(probe.activity);
    assert.deepEqual(eligible.map(record => record.recordId), [first.recordId]);
    const history = probe.store.inspectMemory(probe.activity, first.recordId).history;
    const corroboration = JSON.parse(history.at(-1)!.payload);
    assert.equal(corroboration.kind, 'corroborate');
    assert.equal(corroboration.source.eventId, second.source.eventId);
    assert.equal(probe.store.registerHostInfo(probe.activity).pending.length, 1);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('different subject environments coexist only after an independently supported distinctness verdict', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const first = verifiedCandidate(probe, '本项目在 Windows 使用 PowerShell', { appliesTo: ['platform:win32'] }).record!;
    probe.store.promoteMemory(probe.activity, first.recordId, first);
    const second = verifiedCandidate(probe, '本项目在 Linux 使用 Bash', { appliesTo: ['platform:linux'] });
    probe.store.promoteMemory(probe.activity, second.record!.recordId, second.record!);
    for (const relation of ['same-claim', 'distinct']) {
      const lease = probe.store.claimCaptureJob(probe.activity, second.jobId, evolutionBudget, 30000)!;
      assert.equal(probe.store.captureComparison(lease)!.relation, relation);
      probe.store.searchCaptureSources(lease, '本项目');
      for (const ref of [first.source, second.source]) probe.store.expandCaptureSource(lease, { ref, offset: 0, limit: 4096 });
      const result = probe.store.completeCaptureVerification(lease,
        { result: relation === 'distinct' ? 'pass' : 'block', evidence: [first.source, second.source] });
      assert.equal(result.stage, relation === 'distinct' ? 'complete' : 'comparing');
    }
    assert.equal(probe.store.readMemory(probe.activity, first.recordId).lifecycle, 'active');
    assert.equal(probe.store.readMemory(probe.activity, second.record!.recordId).lifecycle, 'active');
    assert.deepEqual(probe.store.listEligibleMemories(probe.activity).map(record => record.content),
      [first, second.record!].filter(record => record.appliesTo.includes(`platform:${process.platform}`)).map(record => record.content));
    probe.store.drainSearchProjection(probe.activity);
    const linux = probe.store.searchMemories(probe.activity, { query: '本项目', target: { platform: 'linux', agent: 'cli' } });
    assert.deepEqual(linux.results.map(hit => hit.kind === 'memory' && hit.record.recordId), [second.record!.recordId]);
    assert.equal(probe.store.registerHostInfo(probe.activity).pending.length, 2);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('credible mutually exclusive evidence isolates both claims without treating an unverified counterexample as truth', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const first = verifiedCandidate(probe, '本项目的默认输出语言是中文').record!;
    const active = probe.store.promoteMemory(probe.activity, first.recordId, first).record;
    const source = probe.archive.append(randomUUID(), '本项目的默认输出语言是英文');
    const unverified = probe.store.captureMemory(probe.activity, source, '本项目的默认输出语言是英文',
      { type: 'decision', scope: first.scope, appliesTo: [] }).record;
    assert.deepEqual(probe.store.listEligibleMemories(probe.activity).map(record => record.recordId), [active.recordId]);
    assert.throws(() => probe.store.promoteMemory(probe.activity, unverified.recordId, unverified), /memory-not-eligible/);
    const second = verifiedCandidate(probe, '本项目的默认输出语言是英文');
    probe.store.promoteMemory(probe.activity, second.record!.recordId, second.record!);
    for (const relation of ['same-claim', 'distinct', 'supersedes', 'superseded-by', 'conflict']) {
      const lease = probe.store.claimCaptureJob(probe.activity, second.jobId, evolutionBudget, 30000)!;
      assert.equal(probe.store.captureComparison(lease)!.relation, relation);
      probe.store.searchCaptureSources(lease, '本项目');
      for (const ref of [first.source, second.source]) probe.store.expandCaptureSource(lease, { ref, offset: 0, limit: 4096 });
      probe.store.completeCaptureVerification(lease,
        { result: relation === 'conflict' ? 'pass' : 'block', evidence: [first.source, second.source] });
    }
    const left = probe.store.inspectMemory(probe.activity, active.recordId).record;
    const right = probe.store.readCaptureJob(probe.activity, second.jobId);
    assert.equal(left.verification, 'conflicted');
    assert.equal(right.record!.verification, 'conflicted');
    assert.equal(right.record!.conflictSetId, left.conflictSetId);
    assert.equal(right.reason, 'credible-conflict');
    assert.deepEqual(probe.store.listEligibleMemories(probe.activity), []);
    assert.equal(probe.store.registerHostInfo(probe.activity).pending.length, 1);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('an authoritative temporal replacement retains the old verified version and atomically announces the new active claim', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const old = verifiedCandidate(probe, '本项目在 2025 年使用 Node 22').record!;
    const active = probe.store.promoteMemory(probe.activity, old.recordId, old).record;
    const next = verifiedCandidate(probe, '本项目自 2026 年起使用 Node 24');
    probe.store.promoteMemory(probe.activity, next.record!.recordId, next.record!);
    for (const relation of ['same-claim', 'distinct', 'supersedes']) {
      const lease = probe.store.claimCaptureJob(probe.activity, next.jobId, evolutionBudget, 30000)!;
      assert.equal(probe.store.captureComparison(lease)!.relation, relation);
      probe.store.searchCaptureSources(lease, '本项目');
      for (const ref of [old.source, next.source]) probe.store.expandCaptureSource(lease, { ref, offset: 0, limit: 4096 });
      probe.store.completeCaptureVerification(lease,
        { result: relation === 'supersedes' ? 'pass' : 'block', evidence: [old.source, next.source] });
    }
    const previous = probe.store.inspectMemory(probe.activity, old.recordId).record;
    assert.equal(previous.lifecycle, 'superseded');
    assert.equal(previous.verification, 'verified');
    assert.equal(previous.revisionId, active.revisionId);
    const current = probe.store.readCaptureJob(probe.activity, next.jobId);
    assert.equal(current.stage, 'complete');
    assert.equal(current.record!.lifecycle, 'active');
    assert.deepEqual(probe.store.listEligibleMemories(probe.activity).map(record => record.recordId), [current.record!.recordId]);
    const update = JSON.parse(probe.store.inspectMemory(probe.activity, current.record!.recordId).history.at(-1)!.payload);
    assert.equal(update.previous[0].before.hash, active.hash);
    assert.equal(update.previous[0].after.hash, previous.hash);
    assert.equal(probe.store.registerHostInfo(probe.activity).pending.length, 2);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('the bounded Host pump promotes ordinary captures and gives each relation an isolated verifier context', async () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  const route = { provider: 'synthetic', model: 'evolution-fixture', route: 'synthetic-evolution', authNamespace: 'synthetic', capability: 'standard' as const };
  const budget = { ...evolutionBudget, maxTotalTokens: 400000, contextLimit: 64000 };
  const contexts: string[] = [];
  try {
    for (const content of ['本项目在 Windows 使用 PowerShell', '本项目在 Linux 使用 Bash']) {
      const source = probe.archive.append(randomUUID(), `记住：${content}`);
      const job = probe.store.queueOwnerCapture(probe.activity, source);
      const results = await drainCaptures(probe, { jobId: job.jobId, batch: 1, deadlineMs: 30000, budget,
        config: { proposer: [route], verifier: [route] }, adapterVersion: 'capture-counting@1', host: {
          async *stream(request, _signal, send) {
            const attempt = send(request.payload);
            probe.transport.send(request.payload, attempt);
            const payload = JSON.parse(request.payload), input = JSON.parse(payload.p3.messages[0].content);
            let text = '', calls: { id: string; name: string; arguments: Record<string, unknown> }[] = [];
            if (payload.p3.intent.step === 'proposer') text = JSON.stringify({ type: 'decision', content });
            else if (payload.p2.length === 0) {
              contexts.push(input.comparison?.relation ?? 'claim');
              assert.doesNotMatch(JSON.stringify(payload.p2), /proposer|rationale/);
              calls = [{ id: 'search', name: 'source.search', arguments: { query: '本项目' } }];
            } else if (payload.p2.length === 1) {
              const hits = JSON.parse(payload.p2[0].results[0].modelResult).results;
              calls = hits.map((hit: { ref: { eventId: string }; offset: number }, index: number) => ({ id: `expand-${index}`,
                name: 'source.expand', arguments: { eventId: hit.ref.eventId, offset: hit.offset, limit: 4096 } }));
            } else {
              const evidence = payload.p2[1].results.map((value: { modelResult: string }) => JSON.parse(value.modelResult).ref);
              text = JSON.stringify({ result: input.comparison?.relation === 'same-claim' ? 'block' : 'pass', evidence });
            }
            yield { kind: 'complete' as const, reply: { text, calls, stop: calls.length ? 'tools' as const : 'end' as const } };
          },
        } });
      assert.equal(results[0]!.stage, 'complete');
      assert.equal(results[0]!.record!.lifecycle, 'active');
    }
    assert.deepEqual(contexts, ['claim', 'claim', 'same-claim', 'distinct']);
    assert.equal(probe.store.listEligibleMemories(probe.activity).length, 2);
    assert.equal(probe.transport.count, 14);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('owner feedback is source-bound, helpfulness leaves truth unchanged, and wrong feedback invalidates a prepared request', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const candidate = verifiedCandidate(probe, '本项目保存完整日志').record!;
    const active = probe.store.promoteMemory(probe.activity, candidate.recordId, candidate).record;
    const prepared = probe.session.prepare(randomUUID(), '如何记录本项目测试结果？', [active]);
    const value = { schema: 'memory-feedback@1', kind: 'user_helpful', recordId: active.recordId,
      revisionId: active.revisionId, headEventId: active.headEventId };
    const forged = probe.archive.append(randomUUID(), JSON.stringify(value), 'assistant');
    assert.throws(() => probe.store.recordMemoryFeedback(probe.activity, active.recordId, active, forged), /owner-source-required/);
    const helpful = probe.archive.append(randomUUID(), JSON.stringify(value), 'user');
    const observed = probe.store.recordMemoryFeedback(probe.activity, active.recordId, active, helpful);
    assert.equal(observed.record.hash, active.hash);
    const wrong = probe.archive.append(randomUUID(), JSON.stringify({ ...value, kind: 'user_wrong' }), 'user');
    const invalidated = probe.store.recordMemoryFeedback(probe.activity, active.recordId, active, wrong);
    assert.equal(invalidated.record.verification, 'stale');
    assert.notEqual(invalidated.record.headEventId, active.headEventId);
    assert.deepEqual(probe.store.listEligibleMemories(probe.activity), []);
    assert.throws(() => probe.session.dispatch(prepared), /memory-stale/);
    assert.equal(probe.transport.count, 0);
    assert.equal(probe.store.recordMemoryFeedback(probe.activity, active.recordId, active, wrong).status, 'no_op');
    const feedback = probe.store.readMemoryFeedback(probe.activity, active.recordId);
    assert.deepEqual(feedback.events.map(event => event.kind), ['user_helpful', 'user_wrong']);
    assert.deepEqual(feedback.injected.map(item => item.assemblyId), [prepared.assemblyId]);
    assert.equal(feedback.injected[0]!.headEventId, active.headEventId);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

for (const stop of ['end', 'error'] as const) test(`ordinary task ${stop} and retrieval never change memory truth`, () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const candidate = verifiedCandidate(probe, '本项目测试需要保存原始日志').record!;
    const active = probe.store.promoteMemory(probe.activity, candidate.recordId, candidate).record;
    probe.store.drainSearchProjection(probe.activity);
    assert.equal(probe.store.searchMemories(probe.activity, { query: '原始日志' }).results.length, 1);
    const run = observedTask(probe, sandbox, [active], stop === 'end' ? 'completed' : 'failed');
    assert.equal(probe.store.agentStatus(probe.activity, run.runId).terminal, run.terminal);
    const feedback = probe.store.readMemoryFeedback(probe.activity, active.recordId);
    assert.ok(feedback.events.some(event => event.kind === 'retrieved'));
    const outcome = feedback.events.find(event => event.kind === 'task_outcome')!;
    assert.ok(outcome);
    assert.equal((outcome.evidence as { terminal: string }).terminal, run.terminal);
    assert.ok(feedback.injected.some(use => use.runId === run.runId));
    assert.equal(probe.store.readMemory(probe.activity, active.recordId).hash, active.hash);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('negative transfer needs owner-attributed paired receipts and rejects a still-verified first activation without restoring anything', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const candidate = verifiedCandidate(probe, '本项目保存原始日志以复查测试').record!;
    const active = probe.store.promoteMemory(probe.activity, candidate.recordId, candidate).record;
    const value = { schema: 'memory-feedback@1', kind: 'negative_transfer', recordId: active.recordId,
      revisionId: active.revisionId, headEventId: active.headEventId };
    const unsupported = probe.archive.append(randomUUID(), JSON.stringify(value), 'user');
    assert.throws(() => probe.store.recordMemoryFeedback(probe.activity, active.recordId, active, unsupported), /negative-transfer-evidence-required/);
    assert.equal(probe.store.readMemory(probe.activity, active.recordId).hash, active.hash);
    const failures = pairedCanary(probe, sandbox, active, bindingOf(sandbox), true);
    const accidental = probe.archive.append(randomUUID(), JSON.stringify({ ...value, pairs: failures }), 'user');
    assert.throws(() => probe.store.recordMemoryFeedback(probe.activity, active.recordId, active, accidental), /negative-transfer-evidence-required/);
    assert.equal(probe.store.readMemory(probe.activity, active.recordId).hash, active.hash);
    const pairs = pairedCanary(probe, sandbox, active);
    const evidence = probe.archive.append(randomUUID(), JSON.stringify({ ...value, pairs }), 'user');
    const result = probe.store.recordMemoryFeedback(probe.activity, active.recordId, active, evidence);
    assert.equal(result.record.lifecycle, 'rejected');
    assert.equal(result.record.verification, 'verified');
    assert.deepEqual(probe.store.listEligibleMemories(probe.activity), []);
    const rejected = JSON.parse(probe.store.inspectMemory(probe.activity, active.recordId).history.at(-1)!.payload);
    assert.equal(rejected.reason, 'negative_transfer');
    assert.equal(rejected.source.eventId, evidence.eventId);
    assert.equal(probe.store.recordMemoryFeedback(probe.activity, active.recordId, active, evidence).status, 'no_op');
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

for (const losePreviousSource of [false, true]) test(`negative transfer restores the previous revision only while its source remains eligible (${losePreviousSource})`, () => {
  const sandbox = createSandbox();
  let probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const candidate = verifiedCandidate(probe, '本项目保存必要的原始日志').record!;
    const previous = probe.store.promoteMemory(probe.activity, candidate.recordId, candidate).record;
    const nextBinding = { ...bindingOf(sandbox), sessionId: randomUUID() };
    createSandboxSession(sandbox, nextBinding);
    probe.close(); probe = openProbe(sandbox, undefined, undefined, nextBinding, undefined, true);
    const source = probe.archive.append(randomUUID(), '本项目保存详细原始日志');
    const current = probe.store.reviseMemory(probe.activity, previous.recordId, previous, source, '本项目保存详细原始日志', [source]).record;
    const pairs = pairedCanary(probe, sandbox, current, nextBinding);
    if (losePreviousSource) rmSync(resourcesOf(sandbox).source.path);
    const feedback = probe.archive.append(randomUUID(), JSON.stringify({ schema: 'memory-feedback@1', kind: 'negative_transfer',
      recordId: current.recordId, revisionId: current.revisionId, headEventId: current.headEventId, pairs }), 'user');
    const result = probe.store.recordMemoryFeedback(probe.activity, current.recordId, current, feedback);
    const eligible = probe.store.listEligibleMemories(probe.activity);
    if (losePreviousSource) {
      assert.equal(result.record.lifecycle, 'rejected');
      assert.deepEqual(eligible, []);
    } else {
      assert.equal(result.record.revisionId, previous.revisionId);
      assert.equal(result.record.lifecycle, 'active');
      assert.equal(eligible[0]!.content, previous.content);
      assert.notEqual(result.record.headEventId, previous.headEventId);
    }
    const history = probe.store.inspectMemory(probe.activity, current.recordId).history.map(event => JSON.parse(event.payload));
    assert.ok(history.some(event => event.kind === 'reject' && event.after.verification === 'verified' && event.reason === 'negative_transfer'));
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

for (const change of ['delete', 'change'] as const) test(`source ${change} appends stale state and prevents normal retrieval`, () => {
  const sandbox = createSandbox();
  let probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const candidate = verifiedCandidate(probe, '本项目保留原始日志供复查').record!;
    const active = probe.store.promoteMemory(probe.activity, candidate.recordId, candidate).record;
    probe.store.drainSearchProjection(probe.activity);
    const nextBinding = { ...bindingOf(sandbox), sessionId: randomUUID() };
    createSandboxSession(sandbox, nextBinding);
    probe.close(); probe = openProbe(sandbox, undefined, undefined, nextBinding, undefined, true);
    const sourcePath = resourcesOf(sandbox).source.path;
    if (change === 'delete') rmSync(sourcePath);
    else writeFileSync(sourcePath, readFileSync(sourcePath, 'utf8').replace('保留原始日志', '不留原始日志'));
    const checked = probe.store.revalidateMemory(probe.activity, active.recordId);
    assert.equal(checked.record.verification, 'stale');
    assert.notEqual(checked.record.headEventId, active.headEventId);
    assert.equal(probe.store.revalidateMemory(probe.activity, active.recordId).status, 'no_op');
    assert.deepEqual(probe.store.listEligibleMemories(probe.activity), []);
    probe.store.drainSearchProjection(probe.activity);
    const page = probe.store.searchMemories(probe.activity, { query: '原始日志' });
    assert.equal(page.results[0]?.kind, 'status');
    assert.ok(!JSON.stringify(page).includes(active.content));
    assert.ok(probe.store.readMemoryFeedback(probe.activity, active.recordId).events.some(event => event.kind === 'source_revalidated'));
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('expiry persists stale state without losing the immutable verified revision', t => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const source = probe.archive.append(randomUUID(), '合成缓存观测，过期后需要新观测');
    const validUntil = new Date(Date.now() + 60_000).toISOString();
    let record = probe.store.captureMemory(probe.activity, source, '合成缓存当前有效', {
      type: 'fact', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: [], validUntil }).record;
    record = probe.store.verifyMemory(probe.activity, record.recordId, record, 'pass', [source]).record;
    record = probe.store.activateMemory(probe.activity, record.recordId, record).record;
    t.mock.method(Date, 'now', () => Date.parse(validUntil) + 1);
    const checked = probe.store.revalidateMemory(probe.activity, record.recordId);
    assert.equal(checked.reason, 'expired');
    assert.equal(checked.record.verification, 'stale');
    assert.equal(checked.record.revisionId, record.revisionId);
    assert.equal(checked.record.contentHash, record.contentHash);
    assert.deepEqual(probe.store.listEligibleMemories(probe.activity), []);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('safety feedback stops injection and reverification must pass the activation gate again', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const candidate = verifiedCandidate(probe, '本项目保存测试日志').record!;
    const active = probe.store.promoteMemory(probe.activity, candidate.recordId, candidate).record;
    const source = probe.archive.append(randomUUID(), JSON.stringify({ schema: 'memory-feedback@1', kind: 'safety_violation',
      recordId: active.recordId, revisionId: active.revisionId, headEventId: active.headEventId }), 'user');
    const stale = probe.store.recordMemoryFeedback(probe.activity, active.recordId, active, source).record;
    assert.equal(stale.verification, 'stale');
    assert.deepEqual(probe.store.listEligibleMemories(probe.activity), []);
    const approval = probe.archive.append(randomUUID(), JSON.stringify({ schema: 'memory-reverification-approval@1',
      recordId: stale.recordId, revisionId: stale.revisionId, headEventId: stale.headEventId, sourceHash: stale.source.hash }), 'user');
    const job = probe.store.queueMemoryVerification(probe.activity, stale.recordId, stale, approval);
    const lease = probe.store.claimCaptureJob(probe.activity, job.jobId, evolutionBudget, 30000)!;
    probe.store.searchCaptureSources(lease, '本项目');
    probe.store.searchCaptureSources(lease, 'memory-');
    for (const ref of job.range) probe.store.expandCaptureSource(lease, { ref, offset: 0, limit: 4096 });
    assert.ok(job.range.some(ref => ref.eventId === source.eventId));
    const verified = probe.store.completeCaptureVerification(lease, { result: 'pass', evidence: job.range }).record!;
    assert.equal(verified.lifecycle, 'candidate');
    assert.deepEqual(probe.store.listEligibleMemories(probe.activity), []);
    const promoted = probe.store.promoteMemory(probe.activity, verified.recordId, verified);
    assert.equal(promoted.record.lifecycle, 'active');
    assert.ok(promoted.batchId);
    assert.equal(probe.store.registerHostInfo(probe.activity).pending.length, 2);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
