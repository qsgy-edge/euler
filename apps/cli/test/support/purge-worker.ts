import { randomUUID } from 'node:crypto';
import { AnalysisArtifacts, check, MemoryCorrections } from '@euler/core';
import type { AnalysisArtifact, SourceAck, SourceUnit } from '@euler/core';
import cases from '../../../../fixtures/t21-purge-cases.json' with { type: 'json' };
import cleanupCases from '../../../../fixtures/t22a-source-cleanup.json' with { type: 'json' };
import { approvedSourceUnit, saveApprovedProposal } from './source-publication.ts';
import { openProbe } from '../../src/probe.ts';
import { bindingOf, createSandboxSession, openSandbox } from '../../src/sandbox.ts';
import { deliverMemoryInfo } from '../../src/owner-memory.ts';

const [root, scenario = 'separate'] = process.argv.slice(2);
const sandbox = openSandbox(root!), probe = openProbe(sandbox);
try {
  const { store, activity, archive } = probe;
  const records = cases.memories.map(({ key, source: text, content }, index) => {
    const source = ['historian', 'project-output'].includes(scenario) && index === 0
      ? archive.events().find(entry => entry.role === 'user')!.ack : archive.append(randomUUID(), text);
    const record = store.captureMemory(activity, source, scenario === 'bracket-text' ? '[T21] ' + content : content, {
      type: 'fact', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: [], claimKey: key,
    }).record;
    return store.verifyMemory(activity, record.recordId, record, 'pass', [source]).record;
  });
  if (scenario === 'shared') store.activateMemoryBatch(activity, records);
  else for (const record of records) store.activateMemory(activity, record.recordId, record);
  let target = store.readMemory(activity, records[0]!.recordId);
  const receipts: unknown[] = [];
  if (scenario === 'conflict') {
    target = store.conflictMemory(activity, target.recordId, target, records[1]!.recordId,
      store.readMemory(activity, records[1]!.recordId)).left.record;
  }
  if (scenario === 'discovery') {
    const unit = store.publishSourceUnit(activity, approvedSourceUnit(probe, { ref: target.source, projectId: sandbox.fixture.projectId,
      kind: 'source', offset: 0, length: Array.from(archive.read(target.source).text).length }));
    saveApprovedProposal(probe, { target: 'synthetic-guidance.md', expectedChange: 'Keep the synthetic fact scoped',
      owner: sandbox.fixture.ownerId, scope: target.scope, evidenceRefs: [target.source], sourceUnits: [unit.unitId],
      evaluation: { schema: 'evaluation-contract@1', level: 'L0', assertions: ['Read the synthetic source'] } });
    store.drainSourceProjection(activity);
    const intent = store.readIntent(activity)!;
    const consent = archive.append(randomUUID(), JSON.stringify({ schema: 'memory-discovery-approval@1',
      intentId: intent.intentId, goalEventId: intent.goalInput.eventId, projectIds: [sandbox.fixture.projectId],
      targets: {}, maxResults: 4, maxBytes: 131072 }));
    const { grantId } = store.authorizeMemoryDiscovery(activity, consent, [sandbox.fixture.projectId], 4);
    const page = store.searchSources(activity, { query: 'T21 source mem-1', grantId, queryId: randomUUID() });
    check(page.results.some(result => result.unitId === unit.unitId), 'purge-fixture-search-gap');
    store.expandSource(activity, { unitId: unit.unitId, grantId, queryId: randomUUID(), offset: 0, limit: 4096 });
  }
  if (scenario === 'rollback') {
    store.registerHostInfo(activity);
    const batch = store.listHostInfo(activity).map(info => store.readHostInfo(activity, info.batchId).batch)
      .find(batch => batch.events.some(event => event.recordId === target.recordId))!;
    const event = batch.events.find(event => event.recordId === target.recordId)!;
    const corrections = new MemoryCorrections(store, activity, archive);
    const preview = corrections.handle(corrections.receive(`rollback ${batch.batchId} ${event.eventId}`));
    check(preview.kind === 'preview', 'purge-fixture-rollback-gap');
    corrections.presented(preview.presentation);
    const result = corrections.handle(corrections.receive(`commit ${preview.presentation.token} rollback`));
    check(result.kind === 'result' && result.result.status === 'committed', 'purge-fixture-rollback-gap');
    for (const id of result.result.receiptIds) receipts.push(store.readOwnerReceipt(activity, id));
    target = store.readMemory(activity, target.recordId);
  }
  if (scenario === 'operations') {
    const forgotten = store.forgetMemory(activity, target.recordId, target);
    const restored = store.restoreMemory(activity, target.recordId, forgotten.record);
    target = restored.record;
    const inspect = store.inspectMemoryPresentation(activity, [target.recordId]);
    const content = 'T21 corrected synthetic content.';
    const source = archive.append(randomUUID(), content);
    const preview = store.previewMemoryOperation(activity, inspect.token, { kind: 'correct', input: source, content });
    store.registerCorrectionDelivery(activity, preview.token);
    store.acknowledgeMemoryPresentation(activity, preview.token, preview.hash);
    store.recordCorrectionApproval(activity, preview.token, archive.append(randomUUID(), `commit ${preview.token} ${JSON.stringify(content)}`));
    const result = store.commitMemoryOperation(activity, preview.token);
    for (const id of result.receiptIds) receipts.push(store.readOwnerReceipt(activity, id));
    store.acknowledgeCorrectionOwner(activity, preview.token);
    const summary = store.correctionSummary(activity, preview.token), delivery = store.correctionDelivery(activity, preview.token);
    store.acknowledgeCorrectionModel(activity, preview.token, archive.append(delivery.summaryEventId, JSON.stringify(summary), 'tool'));
    target = store.readMemory(activity, target.recordId);
  }
  const documents: SourceAck[] = [];
  if (scenario === 'handoff') {
    const goalText = 'T22a 保存合成报告与交接历史。', current = store.readIntent(activity);
    const goal = archive.append(randomUUID(), goalText);
    store.transitionIntent(activity, current?.eventId ?? null, goal, { status: 'active', step: 'analysis' }, current ? undefined : goalText);
    const artifacts = new AnalysisArtifacts(store, activity, archive);
    const request = { ref: target.source, offset: 0, limit: 4096 };
    const evidence = [{ request, hash: store.expandSource(activity, request).excerptHash }];
    let prior: AnalysisArtifact | undefined, priorUnit: SourceUnit | undefined;
    for (const version of [1, 2]) {
      const report = artifacts.saveReport({ eventId: randomUUID(), ...cleanupCases.report,
        title: cleanupCases.report.title + version, evidence, ...(prior ? { supersedes: prior.ref } : {}) });
      documents.push(report.ref);
      const unit = store.publishSourceUnit(activity, approvedSourceUnit(probe, { ref: report.ref, projectId: sandbox.fixture.projectId,
        kind: 'report-section', offset: report.bodyOffset, length: Array.from(report.body).length,
        ...(priorUnit ? { supersedes: priorUnit.unitId } : {}) }));
      prior = report; priorUnit = unit;
    }
    const handoff = artifacts.saveHandoff({ eventId: randomUUID(), title: 'T22a', markdown: cleanupCases.handoff, evidence });
    documents.push(handoff.ref);
    const selection = [{ unitId: priorUnit!.unitId, hash: priorUnit!.contentHash }];
    const approval = archive.append(randomUUID(), JSON.stringify({ schema: 'analysis-export-approval@1', selection }));
    documents.push(artifacts.exportMarkdown({ eventId: randomUUID(), selection, approval }).ref);
    const binding = { ...bindingOf(sandbox), sessionId: randomUUID(), branchId: randomUUID() };
    createSandboxSession(sandbox, binding);
    const consumer = openProbe(sandbox, undefined, undefined, binding, undefined, true);
    try {
      const excerpt = consumer.store.expandSource(consumer.activity, { unitId: priorUnit!.unitId, offset: 0, limit: 4096 });
      documents.push(consumer.archive.append(randomUUID(), JSON.stringify(excerpt), 'tool'));
    } finally { consumer.close(); }
  }
  let unrelatedBinding;
  if (scenario === 'identity' || scenario.startsWith('ambiguous-')) {
    unrelatedBinding = { ...bindingOf(sandbox), sessionId: randomUUID(), branchId: randomUUID() };
    createSandboxSession(sandbox, unrelatedBinding);
    const other = openProbe(sandbox, undefined, undefined, unrelatedBinding, undefined, true);
    try {
      other.archive.append(target.source.eventId, 'An independent event with a different complete source identity.');
      other.archive.append(target.recordId, 'A source event UUID is not a memory record identity.');
      other.archive.append(randomUUID(), JSON.stringify({ nested: { source_owner: unrelatedBinding.sessionId, source_event_id: target.source.eventId } }));
    } finally { other.close(); }
  }
  if (scenario.startsWith('ambiguous-')) archive.append(randomUUID(), JSON.stringify({ nested: scenario !== 'ambiguous-ack'
    ? { source_event_id: scenario === 'ambiguous-kind' ? target.recordId : target.source.eventId }
    : { schema: 'cli-source-ack@1', eventId: target.source.eventId } }));
  const a = randomUUID(), b = randomUUID();
  const related = [
    archive.append(a, JSON.stringify({ [target.recordId]: { next: b } })),
    archive.append(b, JSON.stringify({ cycle: a, incomplete: { contentHash: target.contentHash } })),
    archive.append(randomUUID(), JSON.stringify({ nested: JSON.stringify({ oldRevision: target.revisionId }) })),
    archive.append(randomUUID(), JSON.stringify({ nested: { content: target.content } })),
    archive.append(randomUUID(), JSON.stringify({ nested: { content: archive.read(target.source).text } })),
    archive.append(randomUUID(), JSON.stringify({ nested: JSON.stringify(target.recordId) })),
    archive.append(randomUUID(), JSON.stringify({ nested: { source_owner: target.source.binding.sessionId, source_event_id: target.source.eventId } })),
  ];
  const unrelated = archive.append(randomUUID(), JSON.stringify({ id: 'mem-13', text: `prefix-${target.recordId}-suffix` }));
  store.drainSearchProjection(activity);
  deliverMemoryInfo(sandbox, probe);
  console.log(JSON.stringify({ recordId: target.recordId, otherId: records[1]!.recordId, target, related, unrelated, unrelatedBinding, receipts, documents }));
} finally { probe.close(); }
