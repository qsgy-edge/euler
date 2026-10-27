import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AnalysisArtifacts, sha256 } from '@euler/core';
import type { Binding, AnalysisArtifact, SourceUnit, EvolutionProposal } from '@euler/core';
import { openSandbox, bindingOf, createSandboxSession } from '../../src/sandbox.ts';
import { openProbe } from '../../src/probe.ts';
import { approvedSourceUnit, saveApprovedProposal } from './source-publication.ts';

const [root, action, encoded] = process.argv.slice(2);
const sandbox = openSandbox(root!);
type History = { target: Binding; versions: { report: AnalysisArtifact; unit: SourceUnit; text: string }[]; proposal: EvolutionProposal };
function session(projectId: string) {
  const binding = { ...bindingOf(sandbox), projectId, sessionId: randomUUID(), branchId: randomUUID() };
  createSandboxSession(sandbox, binding);
  return binding;
}
if (action === 'seed') {
  const target = session(randomUUID());
  const origin = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  const destination = openProbe(sandbox, undefined, undefined, target, undefined, true);
  try {
    const goalText = '保存合成报告历史，仅将批准区段交付目标项目。';
    const goal = origin.archive.append(randomUUID(), goalText);
    origin.store.transitionIntent(origin.activity, null, goal, { status: 'active', step: 'analysis' }, goalText);
    const artifacts = new AnalysisArtifacts(origin.store, origin.activity, origin.archive);
    const versions: History['versions'] = [];
    for (const version of [1, 2]) {
      const previous = versions.at(-1);
      const text = 'Atlas 交接版本 ' + version + '：日志须记录环境字段。';
      const report = artifacts.saveReport({ eventId: randomUUID(), title: '混合报告', facts: 'PRIVATE-ORIGIN 合成内部资料',
        inferences: '仅为分析', recommendations: text, unresolved: '待实现', evidence: [], ...(previous ? { supersedes: previous.report.ref } : {}) });
      const raw = origin.archive.read(report.ref).text;
      const unit = origin.store.publishSourceUnit(origin.activity, approvedSourceUnit(origin, { ref: report.ref,
        projectId: target.projectId, kind: 'report-section', offset: Array.from(raw.slice(0, raw.indexOf(text))).length,
        length: Array.from(text).length, ...(previous ? { supersedes: previous.unit.unitId } : {}) }));
      versions.push({ report, unit, text });
    }
    const proposal = saveApprovedProposal(destination, { target: 'src/logging.ts', targetType: 'code', owner: target.ownerId,
      scope: { kind: 'project', id: target.projectId, resolved: true }, expectedChange: '日志记录环境字段；仅修改日志，不改变运行策略。',
      evidenceRefs: [], sourceUnits: [versions[1]!.unit.unitId],
      evaluation: { schema: 'evaluation-contract@1', level: 'L1', assertions: ['合成日志包含环境字段'] } });
    origin.store.drainSourceProjection(origin.activity);
    console.log(JSON.stringify({ target, versions, proposal } satisfies History));
  } finally { destination.close(); origin.close(); }
} else if (action === 'verify') {
  const history = JSON.parse(encoded!) as History;
  const origin = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  const targetBinding = session(history.target.projectId), unrelatedBinding = session(randomUUID());
  const target = openProbe(sandbox, undefined, undefined, targetBinding, undefined, true);
  const unrelated = openProbe(sandbox, undefined, undefined, unrelatedBinding, undefined, true);
  const reads: { reader: Binding; request: unknown; result?: unknown; error?: string }[] = [];
  function observe<T>(reader: Binding, request: unknown, action: () => T): T {
    try {
      const result = action(); reads.push({ reader, request, result }); return result;
    } catch (error) {
      reads.push({ reader, request, error: (error as Error).message }); throw error;
    }
  }
  try {
    const artifacts = new AnalysisArtifacts(origin.store, origin.activity, origin.archive);
    for (const version of history.versions) {
      const report = observe(bindingOf(sandbox), { ref: version.report.ref }, () => artifacts.read(version.report.ref));
      assert.deepEqual(report, version.report);
      assert.equal(sha256(version.report.body), version.report.bodyHash);
      const request = { unitId: version.unit.unitId, offset: 0, limit: 4096 };
      const result = observe(targetBinding, request, () => target.store.expandSource(target.activity, request));
      assert.equal(result.text, version.text); assert.equal(result.version, version.unit.version);
      assert.equal(result.contentHash, version.unit.contentHash); assert.doesNotMatch(result.text, /PRIVATE-ORIGIN/);
      const rawRequest = { ref: version.report.ref, offset: 0, limit: 4096 };
      assert.throws(() => observe(targetBinding, rawRequest, () => target.store.expandSource(target.activity, rawRequest)), /source-scope-mismatch|source-not-shared/);
      assert.throws(() => observe(unrelatedBinding, request, () => unrelated.store.expandSource(unrelated.activity, request)), /source-scope-mismatch/);
    }
    assert.deepEqual(target.store.readEvolutionProposal(target.activity, history.proposal.proposalId), history.proposal);
    const proposalRequest = { unitId: history.proposal.proposalId, offset: 0, limit: 4096 };
    assert.equal(observe(targetBinding, proposalRequest, () => target.store.expandSource(target.activity, proposalRequest)).contentHash, history.proposal.hash);
    assert.throws(() => observe(unrelatedBinding, proposalRequest, () => unrelated.store.expandSource(unrelated.activity, proposalRequest)), /source-scope-mismatch/);
    console.log(JSON.stringify({ versions: history.versions.map(item => item.report.version), proposal: history.proposal.proposalId, reads,
      privateReadsRejected: reads.filter(read => read.error && JSON.stringify(read.request) !== JSON.stringify(proposalRequest)).length,
      unrelatedProposalRejected: reads.at(-1)!.error === 'source-scope-mismatch', sends: origin.transport.count + target.transport.count + unrelated.transport.count }));
  } finally { unrelated.close(); target.close(); origin.close(); }
} else throw new Error('invalid-handoff-backup-action');
