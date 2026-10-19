import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check } from '@euler/core';
import type { CaptureJob, MemoryComparison, SourceAck } from '@euler/core';
import fixture from '../fixtures/t14-memory-evolution-cases.json' with { type: 'json' };
import { bindingOf, createSandboxSession, openSandbox, resourcesOf } from '../apps/cli/src/sandbox.ts';
import { openProbe } from '../apps/cli/src/probe.ts';
import { deliverMemoryInfo } from '../apps/cli/src/owner-memory.ts';
import { drainCaptures } from '../apps/cli/src/capture.ts';
import { compareCandidate, evolutionBudget, observedTask, pairedCanary, verifiedCandidate } from '../apps/cli/test/support/memory-evolution.ts';

const [root, scenario, output] = process.argv.slice(2);
check(root && output && fixture.cases.some(item => item.id === scenario), 'synthetic-evolution-scenario-required');
const sandbox = openSandbox(root);
let binding = bindingOf(sandbox), probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
const selected: string[] = [];
const activate = (content: string, bounds: { appliesTo?: string[] } = {}) => {
  const candidate = verifiedCandidate(probe, content, bounds).record!;
  selected.push(candidate.recordId);
  return probe.store.promoteMemory(probe.activity, candidate.recordId, candidate).record;
};
function compare(job: CaptureJob, relation: MemoryComparison['relation']) {
  selected.push(job.record!.recordId);
  probe.store.promoteMemory(probe.activity, job.record!.recordId, job.record!);
  return compareCandidate(probe, job.jobId, relation);
}
function nextSession() {
  binding = { ...binding, sessionId: randomUUID() };
  createSandboxSession(sandbox, binding);
  probe.close(); probe = openProbe(sandbox, undefined, undefined, binding, undefined, true);
}
try {
  if (scenario?.startsWith('transport-')) {
    const route = { provider: 'synthetic', model: 'evolution-fixture', route: 'local-counting', authNamespace: 'synthetic', capability: 'standard' as const };
    const budget = scenario === 'transport-conflict'
      ? { ...evolutionBudget, maxTotalTokens: 262144 }
      : { ...evolutionBudget, maxTotalTokens: scenario === 'transport-budget' ? 65536 : 128000 };
    if (scenario === 'transport-conflict') {
      activate('本项目 win32 环境本周期保存原始日志', { appliesTo: ['platform:win32'] });
      compare(verifiedCandidate(probe, '本项目 linux 环境本周期保存原始日志', { appliesTo: ['platform:linux'] }), 'distinct');
    }
    const observations = scenario === 'transport-conflict'
      ? [['all','不保存原始日志']] : [['win32','PowerShell'], ['linux','Bash']];
    for (const [platform, observation] of observations) {
      const content = scenario === 'transport-conflict' ? '本项目 ' + platform + ' 环境本周期' + observation : '本项目在 ' + platform + ' 使用 ' + observation;
      const source = probe.archive.append(randomUUID(), '记住：' + content);
      const job = probe.store.queueOwnerCapture(probe.activity, source);
      await drainCaptures(probe, { jobId: job.jobId, batch: 1, deadlineMs: 30000, budget, config: { proposer: [route], verifier: [route] },
        adapterVersion: 'capture-counting@1', host: { async *stream(request, _signal, send) {
          const attempt = send(request.payload); probe.transport.send(request.payload, attempt);
          probe.archive.append(randomUUID(), request.payload, 'tool');
          const payload = JSON.parse(request.payload), fixed = JSON.parse(payload.p3.messages[0].content);
          let text = '';
          let calls: { id: string; name: string; arguments: Record<string, unknown> }[] = [];
          if (payload.p3.intent.step === 'proposer') text = JSON.stringify({ type: 'decision', content, appliesTo: platform === 'all' ? [] : ['platform:' + platform] });
          else if (!payload.p2.length) {
            calls = [{ id: 'search', name: 'source.search', arguments: { query: '本项目' } }];
            if (scenario === 'transport-conflict') {
              const refs: SourceAck[] = fixed.comparison ? [fixed.comparison.candidate.source, fixed.comparison.peer.source, ...fixed.comparison.feedback] : fixed.sourceRange;
              calls.push(...refs.map((ref, index) => ({ id: 'expand-' + index, name: 'source.expand', arguments: { eventId: ref.eventId, offset: 0, limit: 4096 } })));
            }
          }
          else if (payload.p2.length === 1 && scenario !== 'transport-conflict') {
            const refs: SourceAck[] = fixed.comparison ? [fixed.comparison.candidate.source, fixed.comparison.peer.source, ...fixed.comparison.feedback] : fixed.sourceRange;
            calls = refs.map((ref, index) => ({ id: `expand-${index}`, name: 'source.expand', arguments: { eventId: ref.eventId, offset: 0, limit: 4096 } }));
          } else text = JSON.stringify({ result: !fixed.comparison || fixed.comparison.relation === (platform === 'all' ? 'conflict' : 'distinct') ? 'pass' : 'block',
            evidence: payload.p2.at(-1).results.map((item: { modelResult: string }) => JSON.parse(item.modelResult).ref).filter(Boolean) });
          yield { kind: 'complete' as const, reply: { text, calls, stop: calls.length ? 'tools' as const : 'end' as const } };
        } } });
      const current = probe.store.readCaptureJob(probe.activity, job.jobId);
      if (scenario === 'transport-budget' && platform === 'linux') {
        assert.equal(current.stage, 'blocked'); assert.equal(current.reason, 'capture-budget-exhausted');
        assert.equal(current.record?.lifecycle, 'candidate');
        const count = probe.transport.count;
        await drainCaptures(probe, { jobId: job.jobId, batch: 1, deadlineMs: 30000, budget, config: { proposer: [route], verifier: [route] },
          host: { async *stream() { throw new Error('blocked-job-resent'); } } });
        assert.equal(probe.transport.count, count);
      } else if (platform === 'all') {
        assert.equal(current.stage, 'blocked'); assert.equal(current.reason, 'credible-conflict');
        assert.deepEqual(probe.store.listEligibleMemories(probe.activity), []);
      } else assert.equal(current.record?.lifecycle, 'active');
      selected.push(current.record!.recordId);
    }
    if (scenario === 'transport-budget') assert.ok(probe.transport.count > 4 && probe.transport.count < 14);
    else assert.equal(probe.transport.count, scenario === 'transport-conflict' ? 23 : 14);
  } else if (scenario === 'expiry') {
    const candidate = verifiedCandidate(probe, '本项目的旧授权已于 2000 年失效', { validUntil: '2000-01-01T00:00:00.000Z' }).record!;
    selected.push(candidate.recordId);
    assert.throws(() => probe.store.promoteMemory(probe.activity, candidate.recordId, candidate), /memory-not-current/);
    assert.equal(probe.store.revalidateMemory(probe.activity, candidate.recordId).reason, 'expired');
  } else {
    let current = activate(scenario === 'coexist' ? '本项目在 Windows 使用 PowerShell' : '本项目保存原始日志',
      scenario === 'coexist' ? { appliesTo: ['platform:win32'] } : {});
    if (scenario === 'activation-dedup') {
      compare(verifiedCandidate(probe, '本项目保留原始日志'), 'same-claim');
      compare(verifiedCandidate(probe, '本项目留存原始日志'), 'same-claim');
    }
    else if (scenario === 'coexist') compare(verifiedCandidate(probe, '本项目在 Linux 使用 Bash', { appliesTo: ['platform:linux'] }), 'distinct');
    else if (scenario === 'supersession') compare(verifiedCandidate(probe, '本项目现决定保存完整测试日志'), 'supersedes');
    else if (scenario === 'conflict') compare(verifiedCandidate(probe, '本项目同一有效期内不保存原始日志'), 'conflict');
    else if (scenario === 'source-invalidated') {
      copyFileSync(resourcesOf(sandbox).source.path, join(output, 'source-before.jsonl'));
      nextSession();
      const path = resourcesOf(sandbox).source.path;
      writeFileSync(path, readFileSync(path, 'utf8').replace('保存原始日志', '不留原始日志'));
      assert.equal(probe.store.revalidateMemory(probe.activity, current.recordId).record.verification, 'stale');
    } else if (scenario === 'owner-feedback') {
      probe.store.listEligibleMemories(probe.activity);
      observedTask(probe, sandbox, [current], 'failed');
      const value = { schema: 'memory-feedback@1', recordId: current.recordId, revisionId: current.revisionId, headEventId: current.headEventId };
      const helpful = probe.archive.append(randomUUID(), JSON.stringify({ ...value, kind: 'user_helpful' }), 'user');
      assert.equal(probe.store.recordMemoryFeedback(probe.activity, current.recordId, current, helpful).record.hash, current.hash);
      const prepared = probe.session.prepare(randomUUID(), '本项目怎样保存日志？', [current]);
      const wrong = probe.archive.append(randomUUID(), JSON.stringify({ ...value, kind: 'user_wrong' }), 'user');
      probe.store.recordMemoryFeedback(probe.activity, current.recordId, current, wrong);
      assert.throws(() => probe.session.dispatch(prepared), /memory-stale/);
    } else if (scenario!.startsWith('negative-') || scenario!.startsWith('ordinary-negative-')) {
      if (scenario!.startsWith('ordinary-')) {
        const previousId = current.recordId;
        current = compare(verifiedCandidate(probe, '本项目现决定保存详细原始日志'), 'supersedes')!.record!;
        if (scenario === 'ordinary-negative-changed') {
          const previous = probe.store.readMemory(probe.activity, previousId);
          const correction = probe.archive.append(randomUUID(), '更正：旧记录的适用对象需要重新核验');
          probe.store.correctMemory(probe.activity, previousId, previous, correction, '本项目旧记录需要重新核验');
        }
      } else if (scenario !== 'negative-first') {
        nextSession();
        const source = probe.archive.append(randomUUID(), '本项目保存详细原始日志');
        current = probe.store.reviseMemory(probe.activity, current.recordId, current, source, '本项目保存详细原始日志', [source]).record;
      }
      const pairs = pairedCanary(probe, sandbox, current, binding);
      if (scenario === 'negative-previous-lost') {
        copyFileSync(resourcesOf(sandbox).source.path, join(output, 'source-before.jsonl'));
        rmSync(resourcesOf(sandbox).source.path);
      }
      const feedback = probe.archive.append(randomUUID(), JSON.stringify({ schema: 'memory-feedback@1', kind: 'negative_transfer',
        recordId: current.recordId, revisionId: current.revisionId, headEventId: current.headEventId, pairs }), 'user');
      probe.store.recordMemoryFeedback(probe.activity, current.recordId, current, feedback);
    }
  }
  probe.store.drainSearchProjection(probe.activity, 128);
  assert.equal(deliverMemoryInfo(sandbox, probe), true);
  console.log(JSON.stringify({ schema: 'memory-evolution-result@1', scenario, recordIds: selected, selectedBinding: binding, fixtureScope: 'synthetic-only' }));
} finally { probe.close(); }
