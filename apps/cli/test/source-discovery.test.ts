import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { sha256, type SourceUnitInput } from '@euler/core';
import { createSandbox, createSessionSandbox, createSandboxSession, bindingOf, resourcesOf } from '../src/sandbox.ts';
import { startCli, sendCommand } from '../src/process-driver.ts';
import { openProbe } from '../src/probe.ts';
import { approvedSourceUnit, saveApprovedProposal } from './support/source-publication.ts';

test('an unbound CLI grants task-scoped reads without binding an operation project', async t => {
  const sandbox = createSessionSandbox(randomUUID(), randomUUID()), origin = bindingOf(sandbox);
  t.after(() => rmSync(sandbox.root, { recursive: true, force: true }));
  const query = 'ferruledev', allowed = randomUUID(), other = randomUUID();
  const allowedSources = new Map<string, string>();
  let outside = '';
  for (const projectId of [allowed, other]) {
    const binding = { ...origin, sessionId: randomUUID(), projectId };
    createSandboxSession(sandbox, binding);
    const p = openProbe(sandbox, undefined, undefined, binding, undefined, true);
    try {
      for (const part of projectId === allowed ? ['bearing', 'spindle'] : ['housing']) {
        const text = `${query} ${part}`, ref = p.archive.append(randomUUID(), text);
        const unit = p.store.publishSourceUnit(p.activity, approvedSourceUnit(p, { ref, projectId, kind: 'source', offset: 0, length: text.length }));
        if (projectId === allowed) allowedSources.set(unit.unitId, text); else outside = unit.unitId;
        const input = p.archive.append(randomUUID(), `记住决定：${text}`, 'user');
        assert.equal(p.store.rememberMemory(p.activity, { input, hostInfo: 'durable' }).status, 'activated');
      }
      p.store.drainSourceProjection(p.activity); p.store.drainSearchProjection(p.activity);
    } finally { p.close(); }
  }
  const cli = startCli(['session', '--sandbox', sandbox.root]);
  let grantId: string;
  try {
    await cli.waitFor('session-ready');
    await sendCommand(cli, '/task Compare the authorized drawings', 'session-task');
    assert.deepEqual((await sendCommand(cli, `/memory ${query}`, 'session-memory')).results, []);
    assert.deepEqual((await sendCommand(cli, `/source-search ${query}`, 'session-sources')).results, []);
    const at = cli.observations.length;
    cli.command('/grant ' + JSON.stringify({ projectIds: [allowed], targets: {}, maxResults: 32, maxBytes: 131072 }));
    const grant = await Promise.race(['session-grant', 'session-command-rejected'].map(event => cli.waitFor(event, at)));
    assert.equal(grant.event, 'session-grant', JSON.stringify(grant)); grantId = grant.grantId as string;
    const status = await sendCommand(cli, '/status', 'session-status');
    assert.equal(status.project, null); assert.equal(status.files, 'unavailable');
    assert.equal((await sendCommand(cli, '/skills', 'session-command-rejected')).reason, 'guidance-project-unbound');
  } finally { cli.command('/exit'); await cli.exit; }
  const p = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const search = { query, grantId, limit: 1 };
    const first = p.store.searchMemories(p.activity, search); assert.ok(first.nextCursor);
    const last = p.store.searchMemories(p.activity, { ...search, cursor: first.nextCursor });
    assert.equal(last.nextCursor, null);
    assert.deepEqual([...first.results, ...last.results].map(hit => hit.projectId), [allowed, allowed]);
    assert.notEqual(first.results[0]!.unitId, last.results[0]!.unitId);
    const page = p.store.searchSources(p.activity, { ...search, queryId: randomUUID() }); assert.ok(page.nextCursor);
    const next = p.store.searchSources(p.activity, { ...search, cursor: page.nextCursor, queryId: randomUUID() });
    assert.equal(next.nextCursor, null);
    assert.deepEqual(new Set([...page.results, ...next.results].map(hit => hit.unitId)), new Set(allowedSources.keys()));
    const expand = { grantId, queryId: randomUUID(), unitId: page.results[0]!.unitId, offset: 0, limit: 100 };
    assert.equal(p.store.expandSource(p.activity, expand).text, allowedSources.get(expand.unitId));
    assert.throws(() => p.store.expandSource(p.activity, { ...expand, queryId: randomUUID(), unitId: outside }), /source-scope-mismatch/);
    assert.equal(p.store.sessionProject(p.activity), null);
  } finally { p.close(); }
  const sibling = { ...origin, sessionId: randomUUID(), branchId: randomUUID() };
  createSandboxSession(sandbox, sibling);
  const fresh = openProbe(sandbox, undefined, undefined, sibling, undefined, true);
  try {
    assert.throws(() => fresh.store.searchMemories(fresh.activity, { grantId, query }), /discovery-not-authorized/);
  } finally { fresh.close(); }
  const nextCli = startCli(['session', '--sandbox', sandbox.root]);
  try {
    await nextCli.waitFor('session-ready');
    await sendCommand(nextCli, '/bind ' + JSON.stringify({ projectId: other, root: null }), 'session-bound');
  } finally { nextCli.command('/exit'); await nextCli.exit; }
  const bound = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const page = bound.store.searchMemories(bound.activity, { grantId, query });
    assert.deepEqual(page.coverage.allowedProjects, [allowed]); assert.equal(page.results.length, 2);
    bound.store.revokeMemoryDiscovery(bound.activity, grantId);
    assert.throws(() => bound.store.searchMemories(bound.activity, { grantId, query }), /discovery-not-authorized/);
    assert.throws(() => bound.store.expandSource(bound.activity, { grantId, queryId: randomUUID(), unitId: [...allowedSources.keys()][0]!, offset: 0, limit: 100 }), /discovery-not-authorized/);
  } finally { bound.close(); }
});

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

test('explicit single-Han project search pages through published ranges only', () => {
  const sandbox = createSandbox(), probe = openProbe(sandbox);
  try {
    const text = '榆桥记录\n备注为榆\n未发布的榆树原文';
    const ref = probe.archive.append(randomUUID(), text);
    const projectId = sandbox.fixture.projectId;
    const units = [0, 5].map(offset => probe.store.publishSourceUnit(probe.activity,
      approvedSourceUnit(probe, { ref, projectId, kind: 'source', offset, length: 4 })));
    const search = { query: '榆', limit: 1, mode: 'single-han' as const };
    assert.equal(probe.store.searchSources(probe.activity, search).status, 'dirty');
    probe.store.drainSourceProjection(probe.activity);
    assert.equal(probe.store.searchSources(probe.activity, { query: '榆' }).coverage.reason, 'unsupported-query');
    const first = probe.store.searchSources(probe.activity, search);
    assert.deepEqual(first.results.map(hit => hit.unitId), [units[0]!.unitId]);
    assert.ok(first.nextCursor);
    const next = probe.store.searchSources(probe.activity, { ...search, cursor: first.nextCursor });
    assert.deepEqual(next.results.map(hit => hit.unitId), [units[1]!.unitId]);
    assert.equal(next.nextCursor, null);
    assert.equal(probe.store.expandSource(probe.activity, { unitId: units[1]!.unitId, offset: 0, limit: 4 }).text, '备注为榆');
    const tiny = probe.store.searchSources(probe.activity, { ...search, byteBudget: 1 });
    assert.equal(tiny.coverage.reason, 'result-over-budget');
    assert.deepEqual(tiny.results, []);
    assert.equal(tiny.nextCursor, null);
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
    const first = saveApprovedProposal(probe, { ...base, expectedChange: 'Atlas plan alpha' });
    const second = saveApprovedProposal(probe, { ...base,
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
    const proposal = saveApprovedProposal(origin, {
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

test('bounded source projection drains converge to ready after the final batch', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    for (const text of ['Atlas batch one', 'Atlas batch two']) {
      const ref = probe.archive.append(randomUUID(), text);
      probe.store.publishSourceUnit(probe.activity, approvedSourceUnit(probe, {
        ref, projectId: sandbox.fixture.projectId, kind: 'source', offset: 0, length: text.length,
      }));
    }
    assert.equal(probe.store.drainSourceProjection(probe.activity, 1), 1);
    assert.equal(probe.store.searchSources(probe.activity, { query: 'Atlas' }).status, 'dirty');
    assert.equal(probe.store.drainSourceProjection(probe.activity, 1), 1);
    assert.equal(probe.store.searchSources(probe.activity, { query: 'Atlas' }).status, 'ready');
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('source projection records a durable failure when canonical archive evidence is gone', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  const db = new DatabaseSync(resourcesOf(sandbox).store.path);
  try {
    const text = 'Atlas failed projection';
    const ref = probe.archive.append(randomUUID(), text);
    const unit = probe.store.publishSourceUnit(probe.activity, approvedSourceUnit(probe, {
      ref, projectId: sandbox.fixture.projectId, kind: 'source', offset: 0, length: text.length,
    }));
    const sourcePath = join(sandbox.root, 'session.jsonl');
    const archived = readFileSync(sourcePath, 'utf8');
    const header = archived.split('\n')[0] + '\n';
    writeFileSync(sourcePath, header);
    assert.equal(probe.store.drainSourceProjection(probe.activity), 1);
    const failedJob = db.prepare("SELECT status, reason FROM source_projection_jobs WHERE owner_kind='session' AND unit_id=?")
      .get(unit.unitId) as { status: string; reason: string };
    assert.equal(failedJob.status, 'failed');
    assert.equal(failedJob.reason, 'source-evidence-gap');
    const page = probe.store.searchSources(probe.activity, { query: 'Atlas' });
    assert.equal(page.status, 'unavailable');
    assert.equal(page.coverage.reason, 'index-failed');
    assert.deepEqual(page.results, []);
    writeFileSync(sourcePath, archived);
    assert.equal(probe.store.rebuildSourceProjection(probe.activity), 1);
    const recovered = probe.store.searchSources(probe.activity, { query: 'Atlas' });
    assert.equal(recovered.status, 'ready');
    assert.equal(recovered.results.length, 1);
  } finally { db.close(); probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('a stale source supersession cannot fork the current version chain', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const firstText = 'Atlas source version one';
    const firstRef = probe.archive.append(randomUUID(), firstText);
    const first = probe.store.publishSourceUnit(probe.activity, approvedSourceUnit(probe, {
      ref: firstRef, projectId: sandbox.fixture.projectId, kind: 'handoff', offset: 0, length: firstText.length,
    }));
    const secondText = 'Atlas source version two';
    const secondRef = probe.archive.append(randomUUID(), secondText);
    probe.store.publishSourceUnit(probe.activity, approvedSourceUnit(probe, {
      ref: secondRef, projectId: sandbox.fixture.projectId, kind: 'handoff', offset: 0,
      length: secondText.length, supersedes: first.unitId,
    }));
    const staleText = 'Atlas stale source branch';
    const staleRef = probe.archive.append(randomUUID(), staleText);
    assert.throws(() => probe.store.publishSourceUnit(probe.activity, approvedSourceUnit(probe, {
      ref: staleRef, projectId: sandbox.fixture.projectId, kind: 'handoff', offset: 0,
      length: staleText.length, supersedes: first.unitId,
    })), /source-version-stale/);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('independent source lineages can advance separately under parent CAS', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const firstRef = probe.archive.append(randomUUID(), 'Atlas lineage A root');
    const first = probe.store.publishSourceUnit(probe.activity, approvedSourceUnit(probe, {
      ref: firstRef, projectId: sandbox.fixture.projectId, kind: 'handoff', offset: 0,
      length: Array.from('Atlas lineage A root').length,
    }));
    const secondRef = probe.archive.append(randomUUID(), 'Atlas lineage B root');
    const second = probe.store.publishSourceUnit(probe.activity, approvedSourceUnit(probe, {
      ref: secondRef, projectId: sandbox.fixture.projectId, kind: 'handoff', offset: 0,
      length: Array.from('Atlas lineage B root').length,
    }));
    const childRef = probe.archive.append(randomUUID(), 'Atlas lineage A child');
    const child = probe.store.publishSourceUnit(probe.activity, approvedSourceUnit(probe, {
      ref: childRef, projectId: sandbox.fixture.projectId, kind: 'handoff', offset: 0,
      length: Array.from('Atlas lineage A child').length, supersedes: first.unitId,
    }));
    assert.equal(child.version, 2);
    assert.equal(second.version, 1);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
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

test('replaying a source search after archive loss returns a stale result', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const text = 'Atlas replay search';
    const ref = probe.archive.append(randomUUID(), text);
    probe.store.publishSourceUnit(probe.activity, approvedSourceUnit(probe, {
      ref, projectId: sandbox.fixture.projectId, kind: 'source', offset: 0, length: Array.from(text).length,
    }));
    probe.store.drainSourceProjection(probe.activity);
    const intent = probe.store.readIntent(probe.activity)!;
    const approval = probe.archive.append(randomUUID(), JSON.stringify({ schema: 'memory-discovery-approval@1',
      intentId: intent.intentId, goalEventId: intent.goalInput.eventId, projectIds: [sandbox.fixture.projectId],
      targets: {}, maxResults: 4, maxBytes: 131072 }));
    const { grantId } = probe.store.authorizeMemoryDiscovery(probe.activity, approval, [sandbox.fixture.projectId], 4);
    const request = { query: 'Atlas', grantId, queryId: randomUUID() };
    assert.equal(probe.store.searchSources(probe.activity, request).results.length, 1);
    const sourcePath = join(sandbox.root, 'session.jsonl');
    const header = readFileSync(sourcePath, 'utf8').split('\n')[0] + '\n';
    writeFileSync(sourcePath, header + '{"broken');
    const stale = probe.store.searchSources(probe.activity, request);
    assert.equal(stale.status, 'unavailable');
    assert.equal(stale.coverage.reason, 'query-result-stale');
    assert.deepEqual(stale.results, []);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('non-project inert proposals stay canonical without entering project projection', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  const db = new DatabaseSync(resourcesOf(sandbox).store.path);
  try {
    const source = probe.archive.append(randomUUID(), 'Personal Atlas evidence');
    const proposal = saveApprovedProposal(probe, {
      target: 'Personal Atlas guidance', expectedChange: 'Keep the proposal inert', owner: sandbox.fixture.ownerId,
      scope: { kind: 'personal', id: sandbox.fixture.ownerId, resolved: true }, evidenceRefs: [source],
      evaluation: { schema: 'evaluation-contract@1', level: 'L0', assertions: ['Synthetic check'] },
    });
    assert.equal(db.prepare('SELECT scope_kind FROM evolution_proposals WHERE proposal_id=?').get(proposal.proposalId)?.scope_kind, 'personal');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM source_projection_jobs WHERE unit_id=?').get(proposal.proposalId)?.count, 0);
    assert.equal(probe.store.drainSourceProjection(probe.activity), 0);
    const restored = probe.store.readEvolutionProposal(probe.activity, proposal.proposalId);
    assert.equal(restored.scope.kind, 'personal');
    const revised = saveApprovedProposal(probe, {
      target: 'Personal Atlas guidance', expectedChange: 'Keep the revised proposal inert', owner: sandbox.fixture.ownerId,
      scope: { kind: 'personal', id: sandbox.fixture.ownerId, resolved: true }, evidenceRefs: [source],
      supersedes: proposal.proposalId,
      evaluation: { schema: 'evaluation-contract@1', level: 'L0', assertions: ['Synthetic check'] },
    });
    assert.equal(revised.version, 2);
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
    const text = 'Atlas 榆桥 canonical handoff';
    const ref = probe.archive.append(randomUUID(), text);
    const unit = probe.store.publishSourceUnit(probe.activity, approvedSourceUnit(probe, { ref,
      projectId: sandbox.fixture.projectId, kind: 'handoff', offset: 0, length: Array.from(text).length }));
    probe.store.drainSourceProjection(probe.activity);
    const db = new DatabaseSync(resourcesOf(sandbox).store.path);
    try {
      db.prepare('UPDATE search_documents SET content=? WHERE unit_id=?').run('unrelated indexed body', unit.unitId);
      db.exec("INSERT INTO search_fts(search_fts) VALUES ('rebuild')");
    } finally { db.close(); }
    const page = probe.store.searchSources(probe.activity, { query: 'Atlas' });
    assert.equal(page.status, 'dirty');
    assert.deepEqual(page.results, []);
    const literal = { query: '榆', mode: 'single-han' as const };
    assert.equal(probe.store.searchSources(probe.activity, literal).status, 'dirty');
    const newer = probe.archive.append(randomUUID(), 'Atlas fresh handoff');
    probe.store.publishSourceUnit(probe.activity, approvedSourceUnit(probe, { ref: newer,
      projectId: sandbox.fixture.projectId, kind: 'handoff', offset: 0, length: Array.from('Atlas fresh handoff').length }));
    probe.store.drainSourceProjection(probe.activity);
    assert.equal(probe.store.searchSources(probe.activity, { query: 'Atlas' }).status, 'dirty');
    probe.store.rebuildSourceProjection(probe.activity);
    assert.equal(probe.store.searchSources(probe.activity, { query: 'Atlas' }).results.length, 2);
    assert.deepEqual(probe.store.searchSources(probe.activity, literal).results.map(hit => hit.unitId), [unit.unitId]);
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
