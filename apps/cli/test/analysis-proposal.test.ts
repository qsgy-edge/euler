import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { AnalysisArtifacts } from '@euler/core';
import type { EvolutionProposalInput } from '@euler/core';
import { createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';
import { approvedSourceUnit, saveApprovedProposal } from './support/source-publication.ts';

function scenario(run: (probe: ReturnType<typeof openProbe>, artifacts: AnalysisArtifacts) => void) {
  const sandbox = createSandbox(), probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const goal = probe.archive.append(randomUUID(), '分析合成报告；只交付独立批准的内容');
    probe.store.transitionIntent(probe.activity, null, goal, { status: 'active', step: 'analysis' }, '分析合成报告；只交付独立批准的内容');
    run(probe, new AnalysisArtifacts(probe.store, probe.activity, probe.archive));
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
}
function proposal(probe: ReturnType<typeof openProbe>): EvolutionProposalInput {
  return { target: 'logging.ts', expectedChange: '记录环境字段。范围：测试日志。非目标：运行策略。', owner: probe.archive.events()[0]!.ack.binding.ownerId,
    scope: { kind: 'project', id: probe.archive.events()[0]!.ack.binding.projectId, resolved: true }, evidenceRefs: [],
    evaluation: { schema: 'evaluation-contract@1', level: 'L1', assertions: ['日志有环境字段'] } };
}

for (const reference of ['input','evidence'] as const) test(`a mixed report cannot be published as a project proposal through its ${reference}`, () => {
  scenario((probe, artifacts) => {
    const report = artifacts.saveHandoff({ eventId: randomUUID(), title: '混合报告', markdown: 'PRIVATE_OTHER_PROJECT\n获准范围尚未指定', evidence: [] });
    const input = probe.archive.append(randomUUID(), '保存待验证建议');
    const value = { ...proposal(probe), expectedChange: 'PRIVATE_OTHER_PROJECT', evidenceRefs: [reference === 'input' ? input : report.ref] };
    assert.throws(() => probe.store.saveEvolutionProposal(probe.activity, reference === 'input' ? report.ref : input, value), /report-evidence-requires-approved-unit/);
    probe.store.drainSourceProjection(probe.activity);
    assert.equal(probe.store.searchSources(probe.activity, { query: 'PRIVATE_OTHER_PROJECT' }).results.length, 0);
  });
});

test('approved report background does not authorize unapproved proposal text', () => {
  scenario((probe, artifacts) => {
    const section = '获准背景：测试日志缺少环境字段。';
    const report = artifacts.saveHandoff({ eventId: randomUUID(), title: '混合报告', markdown: `${section}\nPRIVATE_OTHER_PROJECT`, evidence: [] });
    const unit = probe.store.publishSourceUnit(probe.activity, approvedSourceUnit(probe,
      { ref: report.ref, projectId: proposal(probe).scope.id, kind: 'report-section', offset: report.bodyOffset, length: Array.from(section).length }));
    const value = { ...proposal(probe), sourceUnits: [unit.unitId] };
    const generic = probe.archive.append(randomUUID(), '保存建议');
    assert.throws(() => probe.store.saveEvolutionProposal(probe.activity, generic, value), /proposal-publication-approval/);
    const approval = probe.archive.append(randomUUID(), JSON.stringify({ schema: 'analysis-proposal-approval@1', proposal: value }));
    assert.throws(() => probe.store.saveEvolutionProposal(probe.activity, approval, { ...value, expectedChange: 'PRIVATE_OTHER_PROJECT' }), /proposal-publication-approval/);
    const saved = probe.store.saveEvolutionProposal(probe.activity, approval, value);
    const selection = [{ unitId: saved.proposalId, hash: saved.hash }];
    const exportApproval = probe.archive.append(randomUUID(), JSON.stringify({ schema: 'analysis-export-approval@1', selection }));
    const exported = artifacts.exportMarkdown({ eventId: randomUUID(), selection, approval: exportApproval });
    assert.match(exported.markdown, /获准背景：测试日志缺少环境字段/);
    assert.match(exported.markdown, /报告版本：1/);
    assert.doesNotMatch(exported.markdown, /PRIVATE_OTHER_PROJECT/);
  });
});

test('a legacy proposal export includes its approved raw evidence and immutable provenance', () => {
  scenario((probe, artifacts) => {
    const source = probe.archive.append(randomUUID(), '合成观察：日志缺少环境字段。');
    const saved = saveApprovedProposal(probe, { ...proposal(probe), evidenceRefs: [source] });
    const selection = [{ unitId: saved.proposalId, hash: saved.hash }];
    const approval = probe.archive.append(randomUUID(), JSON.stringify({ schema: 'analysis-export-approval@1', selection }));
    const exported = artifacts.exportMarkdown({ eventId: randomUUID(), selection, approval });
    assert.match(exported.markdown, /合成观察：日志缺少环境字段/);
    assert(exported.markdown.includes(source.locator));
    assert(exported.markdown.includes(source.hash));
    assert(exported.markdown.includes(source.contentHash));
    assert(exported.markdown.includes(source.binding.projectId));
    assert(exported.markdown.includes(`范围：project/${saved.scope.id}（resolved=true）`));
    assert(exported.markdown.includes(`目标类型：${saved.targetType}`));
    assert(exported.markdown.includes(`风险：${saved.risk}`));
    assert(exported.markdown.includes(`评估等级：${saved.evaluation.level}`));
  });
});
