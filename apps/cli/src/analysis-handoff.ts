import fixture from '../../../fixtures/t13-capture-cases.json' with { type: 'json' };
import { randomUUID } from 'node:crypto';
import { AnalysisArtifacts, check } from '@euler/core';
import { openProbe } from './probe.ts';
import type { Sandbox } from './sandbox.ts';

/** Explicit synthetic Host inputs exercise storage and export without a Skill or external publisher. */
export function runHandoffDemo(sandbox: Sandbox, scenario: string): void {
  check(scenario === 'synthetic', 'handoff-synthetic-scenario-required');
  const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const goalText = '分析 Atlas 日志并保存合成报告；只交付明确选中的区段';
    const goal = probe.archive.append(randomUUID(), goalText);
    const intent = probe.store.readIntent(probe.activity) ?? probe.store.transitionIntent(probe.activity, null, goal,
      { status: 'active', step: 'analysis' }, goalText);
    const artifacts = new AnalysisArtifacts(probe.store, probe.activity, probe.archive);
    const section = fixture.handoff.section;
    const report = artifacts.saveReport({ eventId: randomUUID(), title: '合成分析报告', facts: fixture.handoff.privateText,
      inferences: '日志可能需要补充环境信息。', recommendations: section, unresolved: '真实 provider 尚未验证。', evidence: [] });
    const raw = probe.archive.read(report.ref).text;
    const offset = Array.from(raw.slice(0, raw.indexOf(section))).length;
    const publication = { ref: report.ref, projectId: goal.binding.projectId, kind: 'report-section' as const, offset, length: Array.from(section).length };
    const approval = probe.archive.append(randomUUID(), JSON.stringify({ schema: 'source-publication-approval@1',
      intentId: intent.intentId, goalEventId: intent.goalInput.eventId, ...publication }));
    const unit = probe.store.publishSourceUnit(probe.activity, { ...publication, approval });
    probe.store.drainSourceProjection(probe.activity);
    const selection = [{ unitId: unit.unitId, hash: unit.contentHash }];
    const exportApproval = probe.archive.append(randomUUID(), JSON.stringify({ schema: 'analysis-export-approval@1', selection }));
    const exported = artifacts.exportMarkdown({ eventId: randomUUID(), selection, approval: exportApproval });
    console.log(JSON.stringify({ event: 'handoff-result', mode: 'synthetic-only', report: report.ref, version: report.version,
      unitId: unit.unitId, export: exported.ref, exportHash: exported.hash, markdown: exported.markdown, sends: probe.transport.count }));
  } finally { probe.close(); }
}
