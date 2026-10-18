import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AnalysisArtifacts, sha256 } from '@euler/core';
import { bindingOf, createSandbox, createSandboxSession } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';
import { approvedSourceUnit } from './support/source-publication.ts';

function begin(probe: ReturnType<typeof openProbe>) {
  const source = probe.archive.append(randomUUID(), '分析测试项目并保存报告；仅按后续逐项批准交付区段');
  return probe.store.transitionIntent(probe.activity, null, source, { status: 'active', step: 'analysis' }, '分析测试项目并保存报告；仅按后续逐项批准交付区段');
}

test('reports preserve immutable versions and selected temporary Markdown survives removal and restart', () => {
  const sandbox = createSandbox();
  const temp = mkdtempSync(join(tmpdir(), 'euler-handoff-'));
  let probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    begin(probe);
    let artifacts = new AnalysisArtifacts(probe.store, probe.activity, probe.archive);
    const input = { eventId: randomUUID(), title: '测试报告', facts: '事实：两条合成输入均有归档。', inferences: '推断：可重复恢复。',
      recommendations: '建议：保留原始日志。', unresolved: '未决：真实模型尚未验收。', evidence: [] };
    const first = artifacts.saveReport(input);
    assert.equal(first.version, 1);
    assert.equal(first.ref.contentHash, sha256(probe.archive.read(first.ref).text));
    assert.equal(artifacts.saveReport(input).ref.eventId, first.ref.eventId);
    const next = artifacts.saveReport({ ...input, eventId: randomUUID(), facts: '事实：第三条合成输入已归档。', supersedes: first.ref });
    assert.equal(next.version, 2);
    assert.equal(artifacts.read(first.ref).body, first.body);
    assert.notEqual(next.ref.hash, first.ref.hash);
    const path = join(temp, 'handoff.md');
    const markdown = '# 接续\n\n背景：合成测试。\n\n建议技能：仅供用户选择，不自动调用。\n';
    writeFileSync(path, markdown, { flag: 'wx' });
    const handoff = artifacts.saveHandoff({ eventId: randomUUID(), title: '接续', markdown: readFileSync(path, 'utf8'), evidence: [] });
    rmSync(temp, { recursive: true });
    probe.close();
    probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    artifacts = new AnalysisArtifacts(probe.store, probe.activity, probe.archive);
    assert.equal(artifacts.read(handoff.ref).body, markdown);
    assert.equal(handoff.bodyHash, sha256(markdown));
    assert.equal(probe.store.listCaptureJobs(probe.activity).length, 0);
    assert.equal(probe.transport.count, 0);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); rmSync(temp, { recursive: true, force: true }); }
});

test('a target project can discover and explicitly export only its approved report section', () => {
  const sandbox = createSandbox();
  const targetBinding = { ...bindingOf(sandbox), projectId: randomUUID(), sessionId: randomUUID() };
  createSandboxSession(sandbox, targetBinding);
  const origin = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  const target = openProbe(sandbox, undefined, undefined, targetBinding, undefined, true);
  try {
    begin(origin);
    const artifacts = new AnalysisArtifacts(origin.store, origin.activity, origin.archive);
    const section = 'Atlas 交接\n背景：运行日志缺少环境字段。\n建议：补充环境。\n范围：日志输出；非目标：运行策略。\n验收：合成日志包含环境字段。';
    const report = artifacts.saveHandoff({ eventId: randomUUID(), title: '混合报告', markdown: `私有项目A\n${section}\n不可交付尾部`, evidence: [] });
    const offset = report.bodyOffset + Array.from('私有项目A\n').length;
    const unit = origin.store.publishSourceUnit(origin.activity, approvedSourceUnit(origin, { ref: report.ref, projectId: targetBinding.projectId,
      kind: 'report-section', offset, length: Array.from(section).length }));
    origin.store.drainSourceProjection(origin.activity);
    assert.equal(target.store.searchSources(target.activity, { query: 'Atlas' }).results[0]!.unitId, unit.unitId);
    const targetArtifacts = new AnalysisArtifacts(target.store, target.activity, target.archive);
    begin(target);
    const selection = [{ unitId: unit.unitId, hash: unit.contentHash }];
    const approval = target.archive.append(randomUUID(), JSON.stringify({ schema: 'analysis-export-approval@1', selection }));
    const exported = targetArtifacts.exportMarkdown({ eventId: randomUUID(), selection, approval });
    assert.match(exported.markdown, /背景：运行日志缺少环境字段/);
    assert.match(exported.markdown, /验收：合成日志包含环境字段/);
    assert.match(exported.markdown, /待验证/);
    assert.match(exported.markdown, new RegExp(unit.contentHash));
    assert.doesNotMatch(exported.markdown, /私有项目A|不可交付尾部/);
    const proposalInput = target.archive.append(randomUUID(), '保存 Atlas 日志改进提案，保持待验证状态');
    const proposal = target.store.saveEvolutionProposal(target.activity, proposalInput, {
      target: 'src/logging.ts', targetType: 'code', owner: targetBinding.ownerId,
      scope: { kind: 'project', id: targetBinding.projectId, resolved: true },
      expectedChange: '背景：日志缺少测试环境。\n预期改动：记录环境字段。\n范围：日志输出。\n非目标：改变运行策略。',
      evidenceRefs: [], sourceUnits: [unit.unitId], evaluation: { schema: 'evaluation-contract@1', level: 'L1', assertions: ['合成日志包含环境字段'] },
    });
    assert.equal(proposal.inert, true);
    const proposalSelection = [{ unitId: proposal.proposalId, hash: proposal.hash }];
    const proposalApproval = target.archive.append(randomUUID(), JSON.stringify({ schema: 'analysis-export-approval@1', selection: proposalSelection }));
    const proposalExport = targetArtifacts.exportMarkdown({ eventId: randomUUID(), selection: proposalSelection, approval: proposalApproval });
    assert.match(proposalExport.markdown, /Atlas 交接/);
    assert.match(proposalExport.markdown, /src\/logging.ts/);
    assert.doesNotMatch(proposalExport.markdown, /私有项目A|不可交付尾部/);
    assert.throws(() => targetArtifacts.exportMarkdown({ eventId: randomUUID(), selection: [{ unitId: unit.unitId, hash: '0'.repeat(64) }], approval }), /export-approval-mismatch|source-version-stale/);
    assert.equal(target.store.listHostInfo(target.activity).length, 0);
  } finally { target.close(); origin.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
