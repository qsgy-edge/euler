import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import test from 'node:test';
import corpus from '../../../fixtures/t10-retrieval-dev.json' with { type: 'json' };
import supplement from '../../../fixtures/t10-retrieval-supplement.json' with { type: 'json' };
import { createSandbox, createSandboxSession, bindingOf } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

const corpusDigest = 'c389e0256e980832d96241e6cd84286bf13098d348d795cff4ab4b0009d9c600';
assert.equal(createHash('sha256').update(readFileSync(new URL('../../../fixtures/t10-retrieval-dev.json', import.meta.url))).digest('hex'), corpusDigest);
assert.equal(createHash('sha256').update(readFileSync(new URL('../../../fixtures/t10-retrieval-supplement.json', import.meta.url))).digest('hex'),
  'd0d63c08714250d356435dad9bf9fae6a0c4eef249991ea2f803dbf94c26240a');


test('D02: a CJK substring reaches its current canonical memory', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const entry = corpus.cases.find(item => item.id === 'D02')!;
    const source = probe.archive.append(randomUUID(), 'synthetic evidence');
    const options = { type: 'fact' as const, scope: { kind: 'project' as const, id: sandbox.fixture.projectId, resolved: true }, appliesTo: [] };
    const captured = probe.store.captureMemory(probe.activity, source, entry.content, options).record;
    const verified = probe.store.verifyMemory(probe.activity, captured.recordId, captured, 'pass', [source]).record;
    const active = probe.store.activateMemory(probe.activity, verified.recordId, verified).record;
    probe.store.drainSearchProjection(probe.activity);
    const page = probe.store.searchMemories(probe.activity, { query: entry.query });
    assert.equal(page.status, 'ready');
    assert.equal(page.results[0]?.kind, 'memory');
    assert.equal(page.results[0]?.record.recordId, active.recordId);
    assert.equal(page.results[0]?.record.content, entry.content);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('D01/D03/D04/D05: frozen exact, boundary, synonym and single-Han judgments', () => {
  for (const entry of corpus.cases.filter(item => item.id !== 'D02')) {
    const sandbox = createSandbox();
    const probe = openProbe(sandbox);
    try {
      const source = probe.archive.append(randomUUID(), `Evidence for ${entry.id}`);
      const captured = probe.store.captureMemory(probe.activity, source, entry.content, {
        type: 'fact', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: [],
      }).record;
      const verified = probe.store.verifyMemory(probe.activity, captured.recordId, captured, 'pass', [source]).record;
      probe.store.activateMemory(probe.activity, verified.recordId, verified);
      probe.store.drainSearchProjection(probe.activity);
      const page = probe.store.searchMemories(probe.activity, { query: entry.query });
      assert.equal(page.status, 'ready', entry.id);
      assert.deepEqual(page.results.map(result => result.unitId), entry.gold === 'hit' ? [captured.recordId] : [], entry.id);
    } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
  }
});

test('S01: lexical lanes cover two different task questions', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const entry = supplement.cases.find(item => item.id === 'S01')!;
    const ids = entry.records!.map(content => {
      const source = probe.archive.append(randomUUID(), `Evidence: ${content}`);
      const captured = probe.store.captureMemory(probe.activity, source, content, {
        type: 'fact', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: [],
      }).record;
      const verified = probe.store.verifyMemory(probe.activity, captured.recordId, captured, 'pass', [source]).record;
      return probe.store.activateMemory(probe.activity, verified.recordId, verified).record.recordId;
    });
    probe.store.drainSearchProjection(probe.activity);
    const page = probe.store.searchMemories(probe.activity, { query: entry.query });
    assert.equal(page.status, 'ready');
    assert.deepEqual(new Set(page.results.map(item => item.unitId)), new Set(ids));
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('a tight result budget covers separate lexical questions before near duplicates', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    for (const content of ['Cache setting alpha', 'Cache setting beta', 'Cache setting delta',
      'Socket setting gamma ' + 'noise '.repeat(150), 'Socket setting theta ' + 'noise '.repeat(150),
      'Socket setting sigma ' + 'noise '.repeat(150)]) {
      const source = probe.archive.append(randomUUID(), `Evidence: ${content}`);
      const captured = probe.store.captureMemory(probe.activity, source, content, {
        type: 'fact', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: [],
      }).record;
      const verified = probe.store.verifyMemory(probe.activity, captured.recordId, captured, 'pass', [source]).record;
      probe.store.activateMemory(probe.activity, verified.recordId, verified);
    }
    probe.store.drainSearchProjection(probe.activity);
    const page = probe.store.searchMemories(probe.activity, { query: 'cache socket', limit: 2 });
    assert.equal(page.results.length, 2);
    assert.equal(page.truncated, true);
    assert.ok(page.results.some(item => item.kind === 'memory' && item.record.content.startsWith('Cache')));
    assert.ok(page.results.some(item => item.kind === 'memory' && item.record.content.startsWith('Socket')));
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('S02: equivalent current claims in one project occupy one result slot', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const entry = supplement.cases.find(item => item.id === 'S02')!;
    const ids = entry.records!.map(content => {
      const source = probe.archive.append(randomUUID(), `Evidence: ${content}`);
      const captured = probe.store.captureMemory(probe.activity, source, content, {
        type: 'fact', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: [], claimKey: entry.claimKey!,
      }).record;
      const verified = probe.store.verifyMemory(probe.activity, captured.recordId, captured, 'pass', [source]).record;
      return probe.store.activateMemory(probe.activity, verified.recordId, verified).record.recordId;
    });
    probe.store.drainSearchProjection(probe.activity);
    const page = probe.store.searchMemories(probe.activity, { query: entry.query });
    assert.equal(page.status, 'ready');
    assert.deepEqual(page.results.map(item => item.unitId), [ids[0]]);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('S03: FTS operators are treated as untrusted lexical input', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const entry = supplement.cases.find(item => item.id === 'S03')!;
    const ids = entry.records!.map(content => {
      const source = probe.archive.append(randomUUID(), `Evidence: ${content}`);
      const captured = probe.store.captureMemory(probe.activity, source, content, {
        type: 'fact', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: [],
      }).record;
      const verified = probe.store.verifyMemory(probe.activity, captured.recordId, captured, 'pass', [source]).record;
      return probe.store.activateMemory(probe.activity, verified.recordId, verified).record.recordId;
    });
    probe.store.drainSearchProjection(probe.activity);
    const page = probe.store.searchMemories(probe.activity, { query: entry.query });
    assert.equal(page.status, 'ready');
    assert.deepEqual(new Set(page.results.map(item => item.unitId)), new Set(ids));
    const malformed = probe.store.searchMemories(probe.activity, { query: 'cache" OR *' });
    assert.deepEqual(malformed.results.map(item => item.unitId), [ids[0]]);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('S05: an undersized page budget never emits a partial fact', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const source = probe.archive.append(randomUUID(), 'budget evidence');
    const captured = probe.store.captureMemory(probe.activity, source, 'Atlas budget', {
      type: 'fact', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: [],
    }).record;
    const verified = probe.store.verifyMemory(probe.activity, captured.recordId, captured, 'pass', [source]).record;
    probe.store.activateMemory(probe.activity, verified.recordId, verified);
    probe.store.drainSearchProjection(probe.activity);
    const page = probe.store.searchMemories(probe.activity, { query: 'Atlas', byteBudget: 1 });
    assert.equal(page.status, 'unavailable');
    assert.equal(page.coverage.reason, 'result-over-budget');
    assert.deepEqual(page.results, []);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('X01/X02: only an owner-bound task grant can discover another registered project', () => {
  const sandbox = createSandbox();
  const secondBinding = { ...bindingOf(sandbox), projectId: randomUUID(), sessionId: randomUUID() };
  createSandboxSession(sandbox, secondBinding);
  const first = openProbe(sandbox);
  const second = openProbe(sandbox, undefined, undefined, secondBinding);
  try {
    const primarySource = first.archive.append(randomUUID(), 'primary synthetic evidence');
    const otherSource = second.archive.append(randomUUID(), 'other synthetic evidence');
    const primaryScope = { kind: 'project' as const, id: sandbox.fixture.projectId, resolved: true };
    const otherScope = { kind: 'project' as const, id: secondBinding.projectId, resolved: true };
    const a = first.store.captureMemory(first.activity, primarySource, 'Atlas index primary', { type: 'fact', scope: primaryScope, appliesTo: [] }).record;
    const b = second.store.captureMemory(second.activity, otherSource, 'Atlas index secondary', { type: 'fact', scope: otherScope, appliesTo: [] }).record;
    for (const [probe, record, source] of [[first, a, primarySource], [second, b, otherSource]] as const) {
      const verified = probe.store.verifyMemory(probe.activity, record.recordId, record, 'pass', [source]).record;
      probe.store.activateMemory(probe.activity, record.recordId, verified);
      probe.store.drainSearchProjection(probe.activity);
    }
    const local = first.store.searchMemories(first.activity, { query: 'Atlas' });
    assert.deepEqual(local.results.map(item => item.projectId), [sandbox.fixture.projectId]);
    const unbound = first.store.searchMemories(first.activity, { query: 'Atlas', noActiveProject: true });
    assert.deepEqual(unbound.results, []);
    assert.deepEqual(unbound.coverage.allowedProjects, []);
    assert.equal(unbound.coverage.reason, 'no-active-project');
    assert.throws(() => first.store.searchMemories(first.activity, { query: 'Atlas', grantId: randomUUID() }), /discovery-not-authorized/);
    const text = 'Owner authorizes read-only analysis of two registered synthetic projects';
    const instruction = first.archive.append(randomUUID(), text);
    first.store.transitionIntent(first.activity, null, instruction, { status: 'active', step: 'analysis' }, text);
    const grant = first.store.authorizeMemoryDiscovery(first.activity, instruction, [sandbox.fixture.projectId, secondBinding.projectId], 4);
    const page = first.store.searchMemories(first.activity, { query: 'Atlas', grantId: grant.grantId, noActiveProject: true });
    assert.equal(page.status, 'ready');
    assert.deepEqual(new Set(page.results.map(item => item.projectId)), new Set([sandbox.fixture.projectId, secondBinding.projectId]));
    assert.deepEqual(new Set(page.results.map(item => item.unitId)), new Set([a.recordId, b.recordId]));
    assert.throws(() => first.store.authorizeMemoryDiscovery(first.activity, instruction, [randomUUID()], 1), /discovery-project-unavailable/);
    const firstPage = first.store.searchMemories(first.activity, { query: 'Atlas', grantId: grant.grantId, limit: 1 });
    assert.equal(firstPage.results.length, 1);
    assert.equal(firstPage.truncated, true);
    assert.ok(firstPage.nextCursor);
    const secondPage = first.store.searchMemories(first.activity, { query: 'Atlas', grantId: grant.grantId, limit: 1, cursor: firstPage.nextCursor });
    assert.equal(secondPage.results.length, 1);
    assert.equal(secondPage.truncated, false);
    assert.notEqual(secondPage.results[0]?.unitId, firstPage.results[0]?.unitId);
    assert.equal(first.store.searchMemories(first.activity, { query: 'Atlas', grantId: grant.grantId }).coverage.reason, 'task-budget-exhausted');
    first.store.revokeMemoryDiscovery(first.activity, grant.grantId);
    assert.throws(() => first.store.searchMemories(first.activity, { query: 'Atlas', grantId: grant.grantId, cursor: firstPage.nextCursor! }), /discovery-not-authorized/);
    const nextGrant = first.store.authorizeMemoryDiscovery(first.activity, instruction, [secondBinding.projectId], 2);
    const end = first.archive.append(randomUUID(), 'Finish synthetic analysis');
    const current = first.store.readIntent(first.activity)!;
    first.store.transitionIntent(first.activity, current.eventId, end, { status: 'completed', step: 'done' });
    assert.throws(() => first.store.searchMemories(first.activity, { query: 'Atlas', grantId: nextGrant.grantId }), /discovery-not-authorized/);
  } finally { second.close(); first.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('a cross-project grant cannot reveal a shared-scope record sourced from an ungranted project', () => {
  const sandbox = createSandbox();
  const other = { ...bindingOf(sandbox), projectId: randomUUID(), sessionId: randomUUID() };
  createSandboxSession(sandbox, other);
  const first = openProbe(sandbox);
  const second = openProbe(sandbox, undefined, undefined, other);
  try {
    const source = second.archive.append(randomUUID(), 'private source evidence');
    const captured = second.store.captureMemory(second.activity, source, 'Atlas global note', {
      type: 'fact', scope: { kind: 'personal', id: other.ownerId, resolved: true }, appliesTo: [],
    }).record;
    const verified = second.store.verifyMemory(second.activity, captured.recordId, captured, 'pass', [source]).record;
    second.store.activateMemory(second.activity, verified.recordId, verified);
    second.store.drainSearchProjection(second.activity);
    const text = 'Analyze only this registered project';
    const input = first.archive.append(randomUUID(), text);
    first.store.transitionIntent(first.activity, null, input, { status: 'active', step: 'analysis' }, text);
    const { grantId } = first.store.authorizeMemoryDiscovery(first.activity, input, [sandbox.fixture.projectId], 2);
    const page = first.store.searchMemories(first.activity, { query: 'Atlas', grantId });
    assert.equal(page.status, 'ready');
    assert.deepEqual(page.results, []);
    assert.equal(JSON.stringify(page).includes(other.projectId), false);
    assert.equal(JSON.stringify(page).includes('global note'), false);
  } finally { second.close(); first.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('X03/X04: cross-project applies-to uses the target environment, not the querying host', () => {
  const sandbox = createSandbox();
  const other = { ...bindingOf(sandbox), projectId: randomUUID(), sessionId: randomUUID() };
  createSandboxSession(sandbox, other);
  const first = openProbe(sandbox);
  const second = openProbe(sandbox, undefined, undefined, other);
  try {
    const platform = process.platform === 'linux' ? 'win32' : 'linux';
    const source = second.archive.append(randomUUID(), 'target environment evidence');
    const record = second.store.captureMemory(second.activity, source, 'Linux socket mode', {
      type: 'fact', scope: { kind: 'project', id: other.projectId, resolved: true }, appliesTo: [`platform:${platform}`],
    }).record;
    const verified = second.store.verifyMemory(second.activity, record.recordId, record, 'pass', [source]).record;
    second.store.activateMemory(second.activity, record.recordId, verified);
    second.store.drainSearchProjection(second.activity);
    const text = 'Explicitly read the registered target project';
    const input = first.archive.append(randomUUID(), text);
    first.store.transitionIntent(first.activity, null, input, { status: 'active', step: 'analysis' }, text);
    const knownGrant = first.store.authorizeMemoryDiscovery(first.activity, input, [other.projectId], 8,
      { [other.projectId]: { platform, agent: 'cli' } });
    const known = first.store.searchMemories(first.activity, { query: 'socket', grantId: knownGrant.grantId });
    assert.equal(known.status, 'ready');
    const knownHit = known.results[0];
    assert.equal(knownHit?.kind, 'memory');
    if (knownHit?.kind === 'memory') assert.equal(knownHit.applicability, 'applicable');
    const unknownGrant = first.store.authorizeMemoryDiscovery(first.activity, input, [other.projectId], 8);
    const unknown = first.store.searchMemories(first.activity, { query: 'socket', grantId: unknownGrant.grantId });
    const unknownHit = unknown.results[0];
    assert.equal(unknownHit?.kind, 'memory');
    if (unknownHit?.kind === 'memory') {
      assert.equal(unknownHit.applicability, 'needs-verification');
      assert.equal(unknownHit.exposureMode, 'reference_only');
    }
    const wrongGrant = first.store.authorizeMemoryDiscovery(first.activity, input, [other.projectId], 8,
      { [other.projectId]: { platform: process.platform } });
    assert.equal(first.store.searchMemories(first.activity, { query: 'socket', grantId: wrongGrant.grantId }).results.length, 0);
    assert.throws(() => first.store.searchMemories(first.activity, {
      query: 'socket', grantId: unknownGrant.grantId, target: { platform },
    }), /invalid-search-target/);
  } finally { second.close(); first.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('expired memory is only an annotated status, never an injected fact', t => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const source = probe.archive.append(randomUUID(), 'expiry evidence');
    const validUntil = new Date(Date.now() + 60_000).toISOString();
    const captured = probe.store.captureMemory(probe.activity, source, 'Atlas lease expires', {
      type: 'fact', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: [], validUntil,
    }).record;
    const verified = probe.store.verifyMemory(probe.activity, captured.recordId, captured, 'pass', [source]).record;
    probe.store.activateMemory(probe.activity, verified.recordId, verified);
    probe.store.drainSearchProjection(probe.activity);
    t.mock.method(Date, 'now', () => Date.parse(validUntil) + 1);
    const page = probe.store.searchMemories(probe.activity, { query: 'lease' });
    assert.equal(page.status, 'ready');
    assert.equal(page.results[0]?.kind, 'status');
    assert.equal(page.results[0]?.reason, 'expired');
    assert.equal('record' in page.results[0]!, false);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('X08: a conflicted claim emits one bounded status without either fact body', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const records = ['Atlas index enabled', 'Atlas index disabled'].map(content => {
      const source = probe.archive.append(randomUUID(), `Evidence: ${content}`);
      const captured = probe.store.captureMemory(probe.activity, source, content, {
        type: 'fact', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: [],
      }).record;
      const verified = probe.store.verifyMemory(probe.activity, captured.recordId, captured, 'pass', [source]).record;
      return probe.store.activateMemory(probe.activity, verified.recordId, verified).record;
    });
    probe.store.drainSearchProjection(probe.activity);
    const conflict = probe.store.conflictMemory(probe.activity, records[0]!.recordId, records[0]!, records[1]!.recordId, records[1]!);
    probe.store.drainSearchProjection(probe.activity);
    const page = probe.store.searchMemories(probe.activity, { query: 'Atlas' });
    assert.equal(page.status, 'ready');
    assert.equal(page.results.length, 1);
    assert.equal(page.results[0]?.kind, 'status');
    assert.equal(page.results[0]?.conflictSetId, conflict.conflictSetId);
    assert.equal(JSON.stringify(page.results[0]).includes('Atlas index'), false);
    assert.equal('record' in page.results[0]!, false);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('X06/X07: pending projection is not an authoritative empty answer, and rebuild restores results', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const source = probe.archive.append(randomUUID(), 'synthetic index evidence');
    const options = { type: 'fact' as const, scope: { kind: 'project' as const, id: sandbox.fixture.projectId, resolved: true }, appliesTo: [] };
    const captured = probe.store.captureMemory(probe.activity, source, 'Atlas index', options).record;
    const verified = probe.store.verifyMemory(probe.activity, captured.recordId, captured, 'pass', [source]).record;
    probe.store.activateMemory(probe.activity, verified.recordId, verified);
    const pending = probe.store.searchMemories(probe.activity, { query: 'Atlas' });
    assert.equal(pending.status, 'dirty');
    assert.deepEqual(pending.results, []);
    probe.store.rebuildSearchProjection(probe.activity);
    const rebuilt = probe.store.searchMemories(probe.activity, { query: 'Atlas' });
    assert.equal(rebuilt.status, 'ready');
    assert.equal(rebuilt.results[0]?.unitId, captured.recordId);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
