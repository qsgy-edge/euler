import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { sha256, type SourceUnitInput } from '@euler/core';
import { createSandbox, createSandboxSession, bindingOf, resourcesOf } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';
import { approvedSourceUnit } from './support/source-publication.ts';

test('an unknown cross-project source query can reconcile its stable identity without spending budget twice', () => {
  const sandbox = createSandbox();
  let probe = openProbe(sandbox);
  try {
    const ref = probe.archive.append(randomUUID(), 'Atlas recoverable query');
    probe.store.publishSourceUnit(probe.activity, approvedSourceUnit(probe, { ref, projectId: sandbox.fixture.projectId,
      kind: 'source', offset: 0, length: Array.from('Atlas recoverable query').length }));
    probe.store.drainSourceProjection(probe.activity);
    const intent = probe.store.readIntent(probe.activity)!;
    const approval = probe.archive.append(randomUUID(), JSON.stringify({ schema: 'memory-discovery-approval@1',
      intentId: intent.intentId, goalEventId: intent.goalInput.eventId,
      projectIds: [sandbox.fixture.projectId], targets: {}, maxResults: 1, maxBytes: 131072 }));
    const { grantId } = probe.store.authorizeMemoryDiscovery(probe.activity, approval, [sandbox.fixture.projectId], 1);
    const queryId = randomUUID();
    const request = { query: 'Atlas', grantId, queryId };
    const first = probe.store.searchSources(probe.activity, request);
    assert.equal(first.results.length, 1);
    probe.close();
    probe = openProbe(sandbox);
    assert.deepEqual(probe.store.searchSources(probe.activity, request), first);
    assert.throws(() => probe.store.searchSources(probe.activity, { ...request, query: 'other' }), /source-query-identity-conflict/);
    assert.equal(probe.store.searchSources(probe.activity, { query: 'Atlas', grantId, queryId: randomUUID() }).coverage.reason,
      'task-budget-exhausted');
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});


test('replaying a changed source-query result returns a gap, not new bytes under the old identity', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const first = probe.archive.append(randomUUID(), 'Atlas first');
    probe.store.publishSourceUnit(probe.activity, approvedSourceUnit(probe, { ref: first, projectId: sandbox.fixture.projectId,
      kind: 'source', offset: 0, length: 'Atlas first'.length }));
    probe.store.drainSourceProjection(probe.activity);
    const intent = probe.store.readIntent(probe.activity)!;
    const approval = probe.archive.append(randomUUID(), JSON.stringify({ schema: 'memory-discovery-approval@1',
      intentId: intent.intentId, goalEventId: intent.goalInput.eventId, projectIds: [sandbox.fixture.projectId],
      targets: {}, maxResults: 2, maxBytes: 131072 }));
    const { grantId } = probe.store.authorizeMemoryDiscovery(probe.activity, approval, [sandbox.fixture.projectId], 2);
    const request = { query: 'Atlas', grantId, queryId: randomUUID() };
    assert.equal(probe.store.searchSources(probe.activity, request).results.length, 1);
    const second = probe.archive.append(randomUUID(), 'Atlas second');
    probe.store.publishSourceUnit(probe.activity, approvedSourceUnit(probe, { ref: second, projectId: sandbox.fixture.projectId,
      kind: 'source', offset: 0, length: 'Atlas second'.length }));
    probe.store.drainSourceProjection(probe.activity);
    const stale = probe.store.searchSources(probe.activity, request);
    assert.equal(stale.status, 'unavailable');
    assert.equal(stale.coverage.reason, 'query-result-stale');
    assert.deepEqual(stale.results, []);
    assert.equal(probe.store.searchSources(probe.activity, { query: 'Atlas', grantId, queryId: randomUUID() }).results.length, 1);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('an owner-published source chunk is discoverable only after indexing and expands to exact bytes', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const text = 'unpublished material\nAtlas deployment section\nprivate tail';
    const ref = probe.archive.append(randomUUID(), text);
    const offset = Array.from(text).indexOf('A');
    const length = Array.from('Atlas deployment section').length;
    const unit = probe.store.publishSourceUnit(probe.activity, approvedSourceUnit(probe, {
      ref, projectId: sandbox.fixture.projectId, kind: 'source', offset, length,
    }));
    const lag = probe.store.searchSources(probe.activity, { query: 'Atlas' });
    assert.equal(lag.status, 'dirty');
    assert.deepEqual(lag.results, []);
    probe.store.drainSourceProjection(probe.activity);
    const page = probe.store.searchSources(probe.activity, { query: 'Atlas' });
    assert.equal(page.status, 'ready');
    assert.deepEqual(page.results.map(hit => hit.unitId), [unit.unitId]);
    assert.equal(page.results[0]?.kind, 'source');
    assert.equal(page.results[0]?.locator, `source-unit@1/${unit.unitId}`);
    assert.equal(page.results[0]?.contentHash, unit.contentHash);
    assert.equal(page.results[0]?.projectId, sandbox.fixture.projectId);
    const expanded = probe.store.expandSource(probe.activity, { unitId: unit.unitId, offset: 0, limit: 40 });
    assert.equal(expanded.text, 'Atlas deployment section');
    assert.equal(expanded.locator, `source-unit@1/${unit.unitId}`);
    assert.equal(expanded.total, length);
    assert.equal(expanded.excerptHash, sha256(expanded.text));
    assert.ok(!JSON.stringify(page).includes('private tail'));
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('a same-project mixed report cannot become discoverable without an exact approved range', () => {
  const sandbox = createSandbox();
  const nextSession = { ...bindingOf(sandbox), sessionId: randomUUID() };
  createSandboxSession(sandbox, nextSession);
  const origin = openProbe(sandbox);
  const reader = openProbe(sandbox, undefined, undefined, nextSession);
  try {
    const report = 'Project A Atlas summary\nProject B secret\n';
    const ref = origin.archive.append(randomUUID(), report, 'assistant');
    for (const kind of ['source', 'report-section', 'handoff'] as const) {
      assert.throws(() => origin.store.publishSourceUnit(origin.activity, { ref,
        projectId: sandbox.fixture.projectId, kind, offset: 0, length: Array.from(report).length } as SourceUnitInput),
      /source-publication-approval-required/);
    }
    const goal = origin.archive.append(randomUUID(), 'Deliver Atlas only');
    const intent = origin.store.transitionIntent(origin.activity, null, goal, { step: 'handoff', status: 'active' }, 'Deliver Atlas only');
    const length = Array.from('Project A Atlas summary').length;
    const approval = origin.archive.append(randomUUID(), JSON.stringify({ schema: 'source-publication-approval@1',
      intentId: intent.intentId, goalEventId: intent.goalInput.eventId, ref, projectId: sandbox.fixture.projectId,
      kind: 'report-section', offset: 0, length }));
    const unit = origin.store.publishSourceUnit(origin.activity, { ref, projectId: sandbox.fixture.projectId,
      kind: 'report-section', offset: 0, length, approval });
    origin.store.drainSourceProjection(origin.activity);
    assert.deepEqual(reader.store.searchSources(reader.activity, { query: 'Atlas' }).results.map(hit => hit.unitId), [unit.unitId]);
    assert.deepEqual(reader.store.searchSources(reader.activity, { query: 'secret' }).results, []);
    assert.equal(reader.store.expandSource(reader.activity, { unitId: unit.unitId, offset: 0, limit: 80 }).text,
      'Project A Atlas summary');
    assert.throws(() => reader.store.expandSource(reader.activity, { ref, offset: 0, limit: 80 }), /source-scope-mismatch/);
  } finally { reader.close(); origin.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('a mixed report exposes only the approved section, and revoked grants cannot follow old refs', () => {
  const sandbox = createSandbox();
  const targetBinding = { ...bindingOf(sandbox), projectId: randomUUID(), sessionId: randomUUID() };
  createSandboxSession(sandbox, targetBinding);
  const origin = openProbe(sandbox);
  const target = openProbe(sandbox, undefined, undefined, targetBinding);
  try {
    const report = 'Project A secret\nAtlas handoff for B\nProject A secret tail';
    const ref = origin.archive.append(randomUUID(), report, 'assistant');
    const goal = origin.archive.append(randomUUID(), 'Prepare a bounded project handoff');
    const intent = origin.store.transitionIntent(origin.activity, null, goal, { step: 'analysis', status: 'active' }, 'Prepare a bounded project handoff');
    const offset = 0;
    const sectionOffset = report.indexOf('Atlas handoff for B');
    const length = 'Atlas handoff for B'.length;
    const decision = { schema: 'source-publication-approval@1', intentId: intent.intentId,
      goalEventId: intent.goalInput.eventId, ref, projectId: targetBinding.projectId,
      kind: 'report-section', offset: sectionOffset, length };
    const unitInput = { ref, projectId: targetBinding.projectId, kind: 'report-section' as const, offset: sectionOffset, length };
    const forged = origin.archive.append(randomUUID(), JSON.stringify(decision), 'assistant');
    assert.throws(() => origin.store.publishSourceUnit(origin.activity, { ...unitInput, approval: forged }), /source-publication-approval-required/);
    const approval = origin.archive.append(randomUUID(), JSON.stringify(decision));
    const published = origin.store.publishSourceUnit(origin.activity, { ...unitInput, approval });
    const unpublished = origin.store.publishSourceUnit(origin.activity, approvedSourceUnit(origin, {
      ref, projectId: sandbox.fixture.projectId, kind: 'source', offset, length: 'Project A secret'.length }));
    origin.store.drainSourceProjection(origin.activity);
    assert.deepEqual(target.store.searchSources(target.activity, { query: 'Atlas' }).results.map(hit => hit.unitId), [published.unitId]);
    assert.deepEqual(target.store.searchSources(target.activity, { query: 'secret' }).results, []);
    assert.throws(() => target.store.expandSource(target.activity, { ref, offset: 0, limit: 50 }), /source-scope-mismatch/);
    assert.throws(() => target.store.expandSource(target.activity, { unitId: unpublished.unitId, offset: 0, limit: 50 }), /source-scope-mismatch/);
    assert.equal(target.store.expandSource(target.activity, { unitId: published.unitId, offset: 0, limit: 50 }).text, 'Atlas handoff for B');
    const task = target.archive.append(randomUUID(), 'Analyze approved projects');
    const targetIntent = target.store.transitionIntent(target.activity, null, task, { step: 'analysis', status: 'active' }, 'Analyze approved projects');
    const grantDecision = target.archive.append(randomUUID(), JSON.stringify({ schema: 'memory-discovery-approval@1',
      intentId: targetIntent.intentId, goalEventId: targetIntent.goalInput.eventId,
      projectIds: [sandbox.fixture.projectId, targetBinding.projectId], targets: {}, maxResults: 8, maxBytes: 131072 }));
    const { grantId } = target.store.authorizeMemoryDiscovery(target.activity, grantDecision,
      [sandbox.fixture.projectId, targetBinding.projectId], 8);
    const first = target.store.searchSources(target.activity, { query: 'Atlas secret', grantId, queryId: randomUUID(), limit: 1 });
    assert.ok(first.nextCursor);
    const readId = randomUUID();
    const read = { unitId: unpublished.unitId, offset: 0, limit: 50, grantId, queryId: readId };
    const firstRead = target.store.expandSource(target.activity, read);
    assert.equal(firstRead.text, 'Project A secret');
    const usageDb = new DatabaseSync(resourcesOf(sandbox).store.path);
    try { assert.equal(usageDb.prepare('SELECT used_results FROM memory_discovery_grants WHERE grant_id=?').get(grantId)?.used_results, 2); }
    finally { usageDb.close(); }
    assert.deepEqual(target.store.expandSource(target.activity, read), firstRead);
    assert.throws(() => target.store.expandSource(target.activity, { ...read, limit: 49 }), /source-query-identity-conflict/);
    target.store.revokeMemoryDiscovery(target.activity, grantId);
    assert.throws(() => target.store.searchSources(target.activity, { query: 'Atlas secret', grantId, queryId: randomUUID(), cursor: first.nextCursor! }), /discovery-not-authorized/);
    assert.throws(() => target.store.expandSource(target.activity, { unitId: unpublished.unitId, offset: 0, limit: 50, grantId, queryId: randomUUID() }), /discovery-not-authorized/);
  } finally { target.close(); origin.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('pre-stored inert proposal versions are searchable and restore their own historical payloads', () => {
  const sandbox = createSandbox();
  let probe = openProbe(sandbox);
  try {
    const source = probe.archive.append(randomUUID(), 'Synthetic project analysis for Atlas');
    const scope = { kind: 'project' as const, id: sandbox.fixture.projectId, resolved: true };
    const base = { target: 'Atlas config', owner: sandbox.fixture.ownerId, scope, evidenceRefs: [source],
      evaluation: { schema: 'evaluation-contract@1' as const, level: 'L0' as const, assertions: ['No behavior change'] } };
    const first = probe.store.saveEvolutionProposal(probe.activity, source, { ...base, expectedChange: 'Atlas plan alpha' });
    const second = probe.store.saveEvolutionProposal(probe.activity, source, { ...base,
      expectedChange: 'Atlas plan beta', supersedes: first.proposalId });
    assert.equal(probe.store.searchSources(probe.activity, { query: 'Atlas' }).status, 'dirty');
    probe.store.drainSourceProjection(probe.activity);
    probe.close();
    probe = openProbe(sandbox);
    const page = probe.store.searchSources(probe.activity, { query: 'Atlas' });
    assert.equal(page.status, 'ready');
    assert.deepEqual(page.results.map(hit => [hit.unitId, hit.version, hit.kind, hit.status]), [
      [first.proposalId, 1, 'proposal', 'inert'], [second.proposalId, 2, 'proposal', 'inert'],
    ]);
    const old = probe.store.expandSource(probe.activity, { unitId: first.proposalId, offset: 0, limit: 4096 });
    assert.equal(old.contentHash, first.hash);
    assert.equal(old.locator, `proposal@1/${first.proposalId}/1`);
    assert.ok(old.text.includes('Atlas plan alpha'));
    assert.ok(!old.text.includes('Atlas plan beta'));
    assert.deepEqual(probe.store.searchMemories(probe.activity, { query: 'Atlas' }).results, []);
    const db = new DatabaseSync(resourcesOf(sandbox).store.path);
    try { db.prepare('UPDATE search_documents SET projection_generation=? WHERE unit_id=?').run(99, first.proposalId); }
    finally { db.close(); }
    assert.equal(probe.store.searchSources(probe.activity, { query: 'Atlas' }).status, 'dirty');
    probe.store.rebuildSourceProjection(probe.activity);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('a proposal from another project needs a task grant even when its locator is known', () => {
  const sandbox = createSandbox();
  const targetBinding = { ...bindingOf(sandbox), projectId: randomUUID(), sessionId: randomUUID() };
  createSandboxSession(sandbox, targetBinding);
  const origin = openProbe(sandbox);
  const target = openProbe(sandbox, undefined, undefined, targetBinding);
  try {
    const source = origin.archive.append(randomUUID(), 'Atlas scoped proposal evidence');
    const proposal = origin.store.saveEvolutionProposal(origin.activity, source, {
      target: 'Atlas runtime', expectedChange: 'Atlas plan remains inert', owner: sandbox.fixture.ownerId,
      scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, evidenceRefs: [source],
      evaluation: { schema: 'evaluation-contract@1', level: 'L0', assertions: ['Synthetic check'] },
    });
    origin.store.drainSourceProjection(origin.activity);
    assert.deepEqual(target.store.searchSources(target.activity, { query: 'Atlas' }).results, []);
    assert.throws(() => target.store.expandSource(target.activity, { unitId: proposal.proposalId, offset: 0, limit: 40 }), /source-scope-mismatch/);
    const goal = target.archive.append(randomUUID(), 'Analyze Atlas');
    const intent = target.store.transitionIntent(target.activity, null, goal, { step: 'analysis', status: 'active' }, 'Analyze Atlas');
    const approval = target.archive.append(randomUUID(), JSON.stringify({ schema: 'memory-discovery-approval@1',
      intentId: intent.intentId, goalEventId: intent.goalInput.eventId, projectIds: [sandbox.fixture.projectId],
      targets: {}, maxResults: 4, maxBytes: 131072 }));
    const { grantId } = target.store.authorizeMemoryDiscovery(target.activity, approval, [sandbox.fixture.projectId], 4);
    assert.deepEqual(target.store.searchSources(target.activity, { query: 'Atlas', grantId, queryId: randomUUID() }).results.map(hit => hit.unitId), [proposal.proposalId]);
    assert.equal(target.store.expandSource(target.activity, { unitId: proposal.proposalId, offset: 0, limit: 4096, grantId, queryId: randomUUID() }).contentHash, proposal.hash);
    target.store.revokeMemoryDiscovery(target.activity, grantId);
    assert.throws(() => target.store.expandSource(target.activity, { unitId: proposal.proposalId, offset: 0, limit: 40, grantId, queryId: randomUUID() }), /discovery-not-authorized/);
  } finally { target.close(); origin.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});


test('source projection drain consumes its durable outbox and does not heal a dirty index by scanning', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  const db = new DatabaseSync(resourcesOf(sandbox).store.path);
  try {
    const text = 'Atlas durable projection job';
    const ref = probe.archive.append(randomUUID(), text);
    const unit = probe.store.publishSourceUnit(probe.activity, approvedSourceUnit(probe, {
      ref, projectId: sandbox.fixture.projectId, kind: 'source', offset: 0, length: Array.from(text).length,
    }));
    assert.equal(db.prepare("SELECT status FROM source_projection_jobs WHERE owner_kind='session' AND unit_id=?")
      .get(unit.unitId)?.status, 'pending');
    assert.equal(probe.store.drainSourceProjection(probe.activity), 1);
    assert.equal(db.prepare("SELECT status FROM source_projection_jobs WHERE owner_kind='session' AND unit_id=?")
      .get(unit.unitId)?.status, 'done');
    db.prepare('DELETE FROM search_fts WHERE rowid=(SELECT rowid FROM search_documents WHERE unit_id=?)').run(unit.unitId);
    assert.equal(probe.store.searchSources(probe.activity, { query: 'Atlas' }).status, 'dirty');
    assert.equal(probe.store.drainSourceProjection(probe.activity), 0);
    assert.equal(probe.store.searchSources(probe.activity, { query: 'Atlas' }).status, 'dirty');
    probe.store.rebuildSourceProjection(probe.activity);
    assert.equal(probe.store.searchSources(probe.activity, { query: 'Atlas' }).status, 'ready');
  } finally { db.close(); probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('replaying an expanded source after archive loss returns a stale result', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const text = 'Atlas replay source';
    const ref = probe.archive.append(randomUUID(), text);
    const unit = probe.store.publishSourceUnit(probe.activity, approvedSourceUnit(probe, {
      ref, projectId: sandbox.fixture.projectId, kind: 'source', offset: 0, length: Array.from(text).length,
    }));
    probe.store.drainSourceProjection(probe.activity);
    const intent = probe.store.readIntent(probe.activity)!;
    const approval = probe.archive.append(randomUUID(), JSON.stringify({ schema: 'memory-discovery-approval@1',
      intentId: intent.intentId, goalEventId: intent.goalInput.eventId, projectIds: [sandbox.fixture.projectId],
      targets: {}, maxResults: 4, maxBytes: 131072 }));
    const { grantId } = probe.store.authorizeMemoryDiscovery(probe.activity, approval, [sandbox.fixture.projectId], 4);
    const request = { unitId: unit.unitId, offset: 0, limit: 64, grantId, queryId: randomUUID() };
    assert.equal(probe.store.expandSource(probe.activity, request).text, text);
    const sourcePath = join(sandbox.root, 'session.jsonl');
    const header = readFileSync(sourcePath, 'utf8').split('\n')[0] + '\n';
    writeFileSync(sourcePath, header);
    assert.throws(() => probe.store.expandSource(probe.activity, request), /source-query-result-stale/);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('non-project inert proposals stay canonical without entering project projection', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  const db = new DatabaseSync(resourcesOf(sandbox).store.path);
  try {
    const source = probe.archive.append(randomUUID(), 'Personal Atlas evidence');
    const proposal = probe.store.saveEvolutionProposal(probe.activity, source, {
      target: 'Personal Atlas guidance', expectedChange: 'Keep the proposal inert', owner: sandbox.fixture.ownerId,
      scope: { kind: 'personal', id: sandbox.fixture.ownerId, resolved: true }, evidenceRefs: [source],
      evaluation: { schema: 'evaluation-contract@1', level: 'L0', assertions: ['Synthetic check'] },
    });
    assert.equal(db.prepare('SELECT scope_kind FROM evolution_proposals WHERE proposal_id=?').get(proposal.proposalId)?.scope_kind, 'personal');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM source_projection_jobs WHERE unit_id=?').get(proposal.proposalId)?.count, 0);
    assert.equal(probe.store.drainSourceProjection(probe.activity), 0);
  } finally { db.close(); probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('a published source request replays after its intent completes', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const text = 'Atlas replay publication';
    const ref = probe.archive.append(randomUUID(), text);
    const input = approvedSourceUnit(probe, { ref, projectId: sandbox.fixture.projectId, kind: 'source', offset: 0, length: Array.from(text).length });
    const first = probe.store.publishSourceUnit(probe.activity, input);
    const current = probe.store.readIntent(probe.activity)!;
    const end = probe.archive.append(randomUUID(), 'Finish publication', 'user');
    probe.store.transitionIntent(probe.activity, current.eventId, end, { status: 'completed', step: 'done' });
    assert.deepEqual(probe.store.publishSourceUnit(probe.activity, input), first);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('source and memory keep separate lanes through each projection rebuild', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const ref = probe.archive.append(randomUUID(), 'Atlas shared index source');
    const unit = probe.store.publishSourceUnit(probe.activity, approvedSourceUnit(probe, { ref, projectId: sandbox.fixture.projectId,
      kind: 'source', offset: 0, length: Array.from('Atlas shared index source').length }));
    const scope = { kind: 'project' as const, id: sandbox.fixture.projectId, resolved: true };
    const captured = probe.store.captureMemory(probe.activity, ref, 'Atlas memory fact', { type: 'fact', scope, appliesTo: [] }).record;
    const verified = probe.store.verifyMemory(probe.activity, captured.recordId, captured, 'pass', [ref]).record;
    const active = probe.store.activateMemory(probe.activity, verified.recordId, verified).record;
    probe.store.drainSourceProjection(probe.activity);
    probe.store.drainSearchProjection(probe.activity);
    for (const rebuild of [() => probe.store.rebuildSourceProjection(probe.activity),
      () => probe.store.rebuildSearchProjection(probe.activity)]) {
      rebuild();
      assert.deepEqual(probe.store.searchSources(probe.activity, { query: 'Atlas' }).results.map(hit => hit.unitId), [unit.unitId]);
      assert.deepEqual(probe.store.searchMemories(probe.activity, { query: 'Atlas' }).results.map(hit => hit.unitId), [active.recordId]);
    }
    const db = new DatabaseSync(resourcesOf(sandbox).store.path);
    try { db.prepare("UPDATE search_documents SET owner_kind='session' WHERE unit_id=?").run(active.recordId); }
    finally { db.close(); }
    assert.equal(probe.store.searchMemories(probe.activity, { query: 'Atlas' }).status, 'dirty');
    probe.store.rebuildSearchProjection(probe.activity);
    assert.deepEqual(probe.store.searchMemories(probe.activity, { query: 'Atlas' }).results.map(hit => hit.unitId), [active.recordId]);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});


test('published revisions replay by stable identity, retain their older bytes and repair a corrupt index', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const original = probe.archive.append(randomUUID(), 'Atlas archival version one');
    const input = approvedSourceUnit(probe, { ref: original, projectId: sandbox.fixture.projectId, kind: 'handoff' as const,
      offset: 0, length: Array.from('Atlas archival version one').length });
    const first = probe.store.publishSourceUnit(probe.activity, input);
    assert.deepEqual(probe.store.publishSourceUnit(probe.activity, input), first);
    const revised = probe.archive.append(randomUUID(), 'Atlas archival version two');
    const second = probe.store.publishSourceUnit(probe.activity, approvedSourceUnit(probe, { ref: revised,
      projectId: sandbox.fixture.projectId, kind: 'handoff', offset: 0,
      supersedes: first.unitId, length: Array.from('Atlas archival version two').length }));
    probe.store.drainSourceProjection(probe.activity);
    assert.deepEqual(probe.store.searchSources(probe.activity, { query: 'Atlas' }).results.map(hit => hit.version), [1, 2]);
    assert.equal(probe.store.expandSource(probe.activity, { unitId: first.unitId, offset: 0, limit: 64 }).text, 'Atlas archival version one');
    const db = new DatabaseSync(resourcesOf(sandbox).store.path);
    try { db.prepare('UPDATE search_documents SET content_hash=? WHERE unit_id=?').run('0'.repeat(64), first.unitId); }
    finally { db.close(); }
    assert.equal(probe.store.searchSources(probe.activity, { query: 'absent-term' }).status, 'dirty');
    probe.store.rebuildSourceProjection(probe.activity);
    assert.deepEqual(probe.store.searchSources(probe.activity, { query: 'Atlas' }).results.map(hit => hit.version), [1, 2]);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('a consistent index-body and FTS rewrite cannot hide a canonical source hit', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const ref = probe.archive.append(randomUUID(), 'Atlas canonical handoff');
    const unit = probe.store.publishSourceUnit(probe.activity, approvedSourceUnit(probe, { ref,
      projectId: sandbox.fixture.projectId, kind: 'handoff', offset: 0, length: Array.from('Atlas canonical handoff').length }));
    probe.store.drainSourceProjection(probe.activity);
    const db = new DatabaseSync(resourcesOf(sandbox).store.path);
    try {
      db.prepare('UPDATE search_documents SET content=? WHERE unit_id=?').run('unrelated indexed body', unit.unitId);
      db.exec("INSERT INTO search_fts(search_fts) VALUES ('rebuild')");
    } finally { db.close(); }
    const page = probe.store.searchSources(probe.activity, { query: 'Atlas' });
    assert.equal(page.status, 'dirty');
    assert.deepEqual(page.results, []);
    const newer = probe.archive.append(randomUUID(), 'Atlas fresh handoff');
    probe.store.publishSourceUnit(probe.activity, approvedSourceUnit(probe, { ref: newer,
      projectId: sandbox.fixture.projectId, kind: 'handoff', offset: 0, length: Array.from('Atlas fresh handoff').length }));
    probe.store.drainSourceProjection(probe.activity);
    assert.equal(probe.store.searchSources(probe.activity, { query: 'Atlas' }).status, 'dirty');
    probe.store.rebuildSourceProjection(probe.activity);
    assert.equal(probe.store.searchSources(probe.activity, { query: 'Atlas' }).results.length, 2);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('a lost archived source returns a gap without using the stale indexed body', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const ref = probe.archive.append(randomUUID(), 'Atlas source that will disappear');
    const unit = probe.store.publishSourceUnit(probe.activity, approvedSourceUnit(probe, { ref, projectId: sandbox.fixture.projectId,
      kind: 'source', offset: 0, length: Array.from('Atlas source that will disappear').length }));
    probe.store.drainSourceProjection(probe.activity);
    const path = join(sandbox.root, 'session.jsonl');
    const header = readFileSync(path, 'utf8').split('\n')[0] + '\n';
    writeFileSync(path, header);
    const missing = probe.store.searchSources(probe.activity, { query: 'Atlas' });
    assert.equal(missing.status, 'unavailable');
    assert.deepEqual(missing.results, []);
    assert.equal(missing.coverage.reason, 'source-evidence-gap');
    assert.throws(() => probe.store.expandSource(probe.activity, { unitId: unit.unitId, offset: 0, limit: 10 }), /source-evidence-gap/);
    writeFileSync(path, header + '{malformed\n');
    assert.throws(() => probe.store.expandSource(probe.activity, { unitId: unit.unitId, offset: 0, limit: 10 }), /source-evidence-gap/);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
