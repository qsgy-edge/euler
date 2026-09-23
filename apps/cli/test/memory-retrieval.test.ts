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

function approveDiscovery(probe: ReturnType<typeof openProbe>, projectIds: string[], maxResults: number,
  targets: Record<string, { agent?: string; platform?: string; component?: string }> = {}, maxBytes = 131072) {
  const intent = probe.store.readIntent(probe.activity)!;
  return probe.archive.append(randomUUID(), JSON.stringify({ schema: 'memory-discovery-approval@1',
    intentId: intent.intentId, goalEventId: intent.goalInput.eventId, projectIds, targets, maxResults, maxBytes }));
}



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

test('Latin script boundaries and one-digit exact terms remain searchable beside Han', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const source = probe.archive.append(randomUUID(), 'mixed-script evidence');
    const captured = probe.store.captureMemory(probe.activity, source, '缓存API 7', {
      type: 'fact', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: [],
    }).record;
    const verified = probe.store.verifyMemory(probe.activity, captured.recordId, captured, 'pass', [source]).record;
    probe.store.activateMemory(probe.activity, verified.recordId, verified);
    probe.store.drainSearchProjection(probe.activity);
    for (const query of ['API', '7', '缓存']) {
      const page = probe.store.searchMemories(probe.activity, { query });
      assert.equal(page.status, 'ready');
      assert.deepEqual(page.results.map(item => item.unitId), [captured.recordId], query);
    }
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
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

test('an oversized first candidate cannot block a later fitting fact', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const ids = [ 'Atlas ' + 'noise '.repeat(500), 'Atlas small' ].map(content => {
      const source = probe.archive.append(randomUUID(), `Evidence: ${content.slice(0, 20)}`);
      const captured = probe.store.captureMemory(probe.activity, source, content, {
        type: 'fact', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: [],
      }).record;
      const verified = probe.store.verifyMemory(probe.activity, captured.recordId, captured, 'pass', [source]).record;
      return probe.store.activateMemory(probe.activity, verified.recordId, verified).record.recordId;
    });
    probe.store.drainSearchProjection(probe.activity);
    const page = probe.store.searchMemories(probe.activity, { query: 'Atlas', byteBudget: 1800 });
    assert.equal(page.status, 'ready');
    assert.deepEqual(page.results.map(item => item.unitId), [ids[1]]);
    assert.equal(page.truncated, true);
    assert.equal(page.coverage.reason, 'oversized-candidate-skipped');
    assert.equal(page.nextCursor, null);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('numeric terms gate near neighbors before normal result admission', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const ids = ['RFC 42 route', 'RFC 43 route', 'RFC 43 route; phase 42 approved'].map(content => {
      const source = probe.archive.append(randomUUID(), `Evidence ${content}`);
      const captured = probe.store.captureMemory(probe.activity, source, content, {
        type: 'fact', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: [],
      }).record;
      const verified = probe.store.verifyMemory(probe.activity, captured.recordId, captured, 'pass', [source]).record;
      return probe.store.activateMemory(probe.activity, verified.recordId, verified).record.recordId;
    });
    probe.store.drainSearchProjection(probe.activity);
    assert.deepEqual(probe.store.searchMemories(probe.activity, { query: 'RFC 42 route' }).results.map(hit => hit.unitId), [ids[0]]);
    assert.deepEqual(probe.store.searchMemories(probe.activity, { query: 'RFC 99 route' }).results, []);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('a number bound to identifiers on both sides rejects an interrupted phrase', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const ids = ['foo 2026 bar', 'foo 2026 unrelated bar', 'foo unrelated 2026 bar'].map(content => {
      const source = probe.archive.append(randomUUID(), `Evidence: ${content}`);
      const captured = probe.store.captureMemory(probe.activity, source, content, {
        type: 'fact', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: [],
      }).record;
      const verified = probe.store.verifyMemory(probe.activity, captured.recordId, captured, 'pass', [source]).record;
      return probe.store.activateMemory(probe.activity, verified.recordId, verified).record.recordId;
    });
    probe.store.drainSearchProjection(probe.activity);
    assert.deepEqual(probe.store.searchMemories(probe.activity, { query: 'foo 2026 bar' }).results.map(hit => hit.unitId), [ids[0]]);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('overlapping current validity windows share one claim result slot', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const ids = ['Atlas setting alpha', 'Atlas setting beta'].map((content, index) => {
      const source = probe.archive.append(randomUUID(), `Evidence ${content}`);
      const captured = probe.store.captureMemory(probe.activity, source, content, {
        type: 'fact', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: [], claimKey: 'Atlas setting',
        validFrom: new Date(Date.now() - (index + 1) * 60_000).toISOString(),
        validUntil: new Date(Date.now() + (index + 1) * 60_000).toISOString(),
      }).record;
      const verified = probe.store.verifyMemory(probe.activity, captured.recordId, captured, 'pass', [source]).record;
      return probe.store.activateMemory(probe.activity, verified.recordId, verified).record.recordId;
    });
    probe.store.drainSearchProjection(probe.activity);
    const page = probe.store.searchMemories(probe.activity, { query: 'Atlas' });
    assert.equal(page.status, 'ready');
    assert.equal(page.results.length, 1);
    assert.ok(ids.includes(page.results[0]!.unitId));
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('workspace memory is evaluated for each approved target while retaining its source project', () => {
  const sandbox = createSandbox();
  const targetBinding = { ...bindingOf(sandbox), projectId: randomUUID(), sessionId: randomUUID() };
  createSandboxSession(sandbox, targetBinding);
  const probe = openProbe(sandbox);
  const target = openProbe(sandbox, undefined, undefined, targetBinding);
  try {
    const workspaceId = randomUUID();
    probe.store.bindWorkspace(probe.activity, workspaceId, [sandbox.fixture.projectId, targetBinding.projectId]);
    const targetPlatform = process.platform === 'linux' ? 'win32' : 'linux';
    const source = probe.archive.append(randomUUID(), 'Shared socket evidence');
    const captured = probe.store.captureMemory(probe.activity, source, 'Socket target mode', {
      type: 'fact', scope: { kind: 'workspace', id: workspaceId, resolved: true }, appliesTo: [`platform:${targetPlatform}`],
    }).record;
    const verified = probe.store.verifyMemory(probe.activity, captured.recordId, captured, 'pass', [source]).record;
    probe.store.activateMemory(probe.activity, verified.recordId, verified);
    probe.store.drainSearchProjection(probe.activity);
    const goal = 'Analyze both workspace members';
    const input = probe.archive.append(randomUUID(), goal);
    probe.store.transitionIntent(probe.activity, null, input, { status: 'active', step: 'analysis' }, goal);
    const targets = {
      [sandbox.fixture.projectId]: { agent: 'cli', platform: process.platform },
      [targetBinding.projectId]: { agent: 'cli', platform: targetPlatform },
    };
    const approval = approveDiscovery(probe, [sandbox.fixture.projectId, targetBinding.projectId], 4, targets);
    const { grantId } = probe.store.authorizeMemoryDiscovery(probe.activity, approval,
      [sandbox.fixture.projectId, targetBinding.projectId], 4, targets);
    const page = probe.store.searchMemories(probe.activity, { query: 'Socket', grantId });
    assert.equal(page.status, 'ready');
    assert.equal(page.results.length, 1);
    const hit = page.results[0];
    assert.equal(hit?.kind, 'memory');
    assert.equal(hit?.projectId, sandbox.fixture.projectId);
    assert.equal(hit?.targetProjectId, targetBinding.projectId);
    if (hit?.kind === 'memory') assert.equal(hit.applicability, 'applicable');
  } finally { target.close(); probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('one shared fact can occupy separate target pages without losing source provenance', () => {
  const sandbox = createSandbox();
  const other = { ...bindingOf(sandbox), projectId: randomUUID(), sessionId: randomUUID() };
  createSandboxSession(sandbox, other);
  const sourceHost = openProbe(sandbox);
  const targetHost = openProbe(sandbox, undefined, undefined, other);
  try {
    const workspaceId = randomUUID();
    sourceHost.store.bindWorkspace(sourceHost.activity, workspaceId, [sandbox.fixture.projectId, other.projectId]);
    const source = sourceHost.archive.append(randomUUID(), 'Shared workspace evidence');
    const captured = sourceHost.store.captureMemory(sourceHost.activity, source, 'Socket shared mode', {
      type: 'fact', scope: { kind: 'workspace', id: workspaceId, resolved: true }, appliesTo: [],
    }).record;
    const verified = sourceHost.store.verifyMemory(sourceHost.activity, captured.recordId, captured, 'pass', [source]).record;
    sourceHost.store.activateMemory(sourceHost.activity, verified.recordId, verified);
    sourceHost.store.drainSearchProjection(sourceHost.activity);
    const local = targetHost.store.searchMemories(targetHost.activity, { query: 'Socket' });
    assert.equal(local.results[0]?.projectId, sandbox.fixture.projectId);
    assert.equal(local.results[0]?.targetProjectId, other.projectId);
    const goal = 'Analyze both members';
    const input = sourceHost.archive.append(randomUUID(), goal);
    sourceHost.store.transitionIntent(sourceHost.activity, null, input, { status: 'active', step: 'analysis' }, goal);
    const targets = {
      [sandbox.fixture.projectId]: { agent: 'cli', platform: process.platform },
      [other.projectId]: { agent: 'cli', platform: process.platform },
    };
    const approval = approveDiscovery(sourceHost, [sandbox.fixture.projectId, other.projectId], 2, targets);
    const { grantId } = sourceHost.store.authorizeMemoryDiscovery(sourceHost.activity, approval,
      [sandbox.fixture.projectId, other.projectId], 2, targets);
    const first = sourceHost.store.searchMemories(sourceHost.activity, { query: 'Socket', grantId, limit: 1 });
    assert.equal(first.results.length, 1);
    assert.ok(first.nextCursor);
    const second = sourceHost.store.searchMemories(sourceHost.activity, { query: 'Socket', grantId, limit: 1, cursor: first.nextCursor! });
    assert.equal(second.results.length, 1);
    assert.equal(second.nextCursor, null);
    assert.equal(first.results[0]?.unitId, second.results[0]?.unitId);
    assert.deepEqual(new Set([first.results[0]?.targetProjectId, second.results[0]?.targetProjectId]),
      new Set([sandbox.fixture.projectId, other.projectId]));
    assert.ok([...first.results, ...second.results].every(hit => hit.projectId === sandbox.fixture.projectId));
  } finally { targetHost.close(); sourceHost.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('equivalent applicability syntax deduplicates the same current claim and target', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    for (const [index, condition] of ['linux', 'platform:linux'].entries()) {
      const source = probe.archive.append(randomUUID(), `Evidence for ${condition}`);
      const captured = probe.store.captureMemory(probe.activity, source, `Socket setting ${index}`, {
        type: 'fact', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true },
        appliesTo: [condition], claimKey: 'Socket setting',
      }).record;
      const verified = probe.store.verifyMemory(probe.activity, captured.recordId, captured, 'pass', [source]).record;
      probe.store.activateMemory(probe.activity, verified.recordId, verified);
    }
    probe.store.drainSearchProjection(probe.activity);
    const page = probe.store.searchMemories(probe.activity, { query: 'Socket', target: { agent: 'cli', platform: 'linux' } });
    assert.equal(page.status, 'ready');
    assert.equal(page.results.length, 1);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('numeric identifiers require both neighboring query terms', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const entries = ['foo 2026 unrelated bar', 'foo 2026 bar', 'foo unrelated 2026 bar'];
    const ids = entries.map(content => {
      const source = probe.archive.append(randomUUID(), `Evidence: ${content}`);
      const captured = probe.store.captureMemory(probe.activity, source, content, {
        type: 'fact', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: [],
      }).record;
      const verified = probe.store.verifyMemory(probe.activity, captured.recordId, captured, 'pass', [source]).record;
      return probe.store.activateMemory(probe.activity, verified.recordId, verified).record.recordId;
    });
    probe.store.drainSearchProjection(probe.activity);
    const page = probe.store.searchMemories(probe.activity, { query: 'foo 2026 bar' });
    assert.deepEqual(page.results.map(item => item.unitId), [ids[1]]);
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

test('X01/X02/X05/X09: only an owner-bound task grant can discover another registered project', () => {
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
    assert.throws(() => first.store.authorizeMemoryDiscovery(first.activity, instruction, [secondBinding.projectId], 1), /discovery-consent-required/);
    const consent = approveDiscovery(first, [sandbox.fixture.projectId, secondBinding.projectId], 4);
    for (const role of ['assistant', 'tool'] as const) {
      const forged = first.archive.append(randomUUID(), first.archive.read(consent).text, role);
      assert.throws(() => first.store.authorizeMemoryDiscovery(first.activity, forged,
        [sandbox.fixture.projectId, secondBinding.projectId], 4), /discovery-consent-required/);
    }
    const grant = first.store.authorizeMemoryDiscovery(first.activity, consent, [sandbox.fixture.projectId, secondBinding.projectId], 4);
    const page = first.store.searchMemories(first.activity, { query: 'Atlas', grantId: grant.grantId, noActiveProject: true });
    assert.equal(page.status, 'ready');
    assert.deepEqual(new Set(page.results.map(item => item.projectId)), new Set([sandbox.fixture.projectId, secondBinding.projectId]));
    assert.deepEqual(new Set(page.results.map(item => item.unitId)), new Set([a.recordId, b.recordId]));
    assert.ok(page.results.every(item => item.kind === 'memory' && item.applicability === 'needs-verification'
      && item.exposureMode === 'reference_only'));
    const unknownProject = randomUUID();
    const unavailable = approveDiscovery(first, [unknownProject], 1);
    assert.throws(() => first.store.authorizeMemoryDiscovery(first.activity, unavailable, [unknownProject], 1), /discovery-project-unavailable/);
    assert.throws(() => first.store.authorizeMemoryDiscovery(first.activity, consent, [secondBinding.projectId], 4), /discovery-consent-required/);
    const firstPage = first.store.searchMemories(first.activity, { query: 'Atlas', grantId: grant.grantId, limit: 1 });
    assert.equal(firstPage.results.length, 1);
    assert.equal(firstPage.truncated, true);
    assert.deepEqual(new Set(firstPage.coverage.inspectedProjects), new Set([sandbox.fixture.projectId, secondBinding.projectId]));
    assert.equal(firstPage.coverage.candidateCount, 2);
    assert.ok(firstPage.nextCursor);
    const secondPage = first.store.searchMemories(first.activity, { query: 'Atlas', grantId: grant.grantId, limit: 1, cursor: firstPage.nextCursor });
    assert.equal(secondPage.results.length, 1);
    assert.equal(secondPage.truncated, false);
    assert.notEqual(secondPage.results[0]?.unitId, firstPage.results[0]?.unitId);
    assert.equal(first.store.searchMemories(first.activity, { query: 'Atlas', grantId: grant.grantId }).coverage.reason, 'task-budget-exhausted');
    first.store.revokeMemoryDiscovery(first.activity, grant.grantId);
    assert.throws(() => first.store.searchMemories(first.activity, { query: 'Atlas', grantId: grant.grantId, cursor: firstPage.nextCursor! }), /discovery-not-authorized/);
    const nextConsent = approveDiscovery(first, [secondBinding.projectId], 2);
    assert.throws(() => first.store.authorizeMemoryDiscovery(first.activity, nextConsent, [secondBinding.projectId], 2), /discovery-already-authorized/);
    const end = first.archive.append(randomUUID(), 'Finish synthetic analysis');
    const current = first.store.readIntent(first.activity)!;
    const completed = first.store.transitionIntent(first.activity, current.eventId, end, { status: 'completed', step: 'done' });
    const resumedInput = first.archive.append(randomUUID(), 'Continue after completion');
    first.store.transitionIntent(first.activity, completed.eventId, resumedInput, { status: 'active', step: 'new-analysis' });
    assert.throws(() => first.store.authorizeMemoryDiscovery(first.activity, nextConsent, [secondBinding.projectId], 2), /discovery-consent-required/);
  } finally { second.close(); first.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('cross-project discovery charges empty queries to a durable per-grant query limit', () => {
  const sandbox = createSandbox();
  let probe = openProbe(sandbox);
  try {
    const text = 'Approve bounded analysis';
    const input = probe.archive.append(randomUUID(), text);
    probe.store.transitionIntent(probe.activity, null, input, { status: 'active', step: 'analysis' }, text);
    const approval = approveDiscovery(probe, [sandbox.fixture.projectId], 1);
    const { grantId } = probe.store.authorizeMemoryDiscovery(probe.activity, approval, [sandbox.fixture.projectId], 1);
    for (let index = 0; index < 8; index++) {
      if (index === 4) { probe.close(); probe = openProbe(sandbox); }
      const page = probe.store.searchMemories(probe.activity, { query: `absent${index}word`, grantId });
      assert.equal(page.status, 'ready', String(index));
      assert.deepEqual(page.results, []);
    }
    const exhausted = probe.store.searchMemories(probe.activity, { query: 'absent', grantId });
    assert.equal(exhausted.status, 'unavailable');
    assert.equal(exhausted.coverage.reason, 'task-query-budget-exhausted');
    assert.deepEqual(exhausted.coverage.unavailableProjects, [sandbox.fixture.projectId]);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('one owner decision cannot mint fresh budget or revive discovery after task completion', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const source = probe.archive.append(randomUUID(), 'Atlas evidence');
    const captured = probe.store.captureMemory(probe.activity, source, 'Atlas route', {
      type: 'fact', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: [],
    }).record;
    const verified = probe.store.verifyMemory(probe.activity, captured.recordId, captured, 'pass', [source]).record;
    probe.store.activateMemory(probe.activity, verified.recordId, verified);
    probe.store.drainSearchProjection(probe.activity);
    const text = 'Authorize one Atlas result';
    const input = probe.archive.append(randomUUID(), text);
    probe.store.transitionIntent(probe.activity, null, input, { status: 'active', step: 'analysis' }, text);
    const approval = approveDiscovery(probe, [sandbox.fixture.projectId], 1);
    const grant = probe.store.authorizeMemoryDiscovery(probe.activity, approval, [sandbox.fixture.projectId], 1);
    assert.equal(probe.store.searchMemories(probe.activity, { query: 'Atlas', grantId: grant.grantId }).results.length, 1);
    assert.deepEqual(probe.store.authorizeMemoryDiscovery(probe.activity, approval, [sandbox.fixture.projectId], 1), grant);
    assert.equal(probe.store.searchMemories(probe.activity, { query: 'Atlas', grantId: grant.grantId }).coverage.reason, 'task-budget-exhausted');
    const secondApproval = approveDiscovery(probe, [sandbox.fixture.projectId], 1);
    assert.throws(() => probe.store.authorizeMemoryDiscovery(probe.activity, secondApproval, [sandbox.fixture.projectId], 1), /discovery-already-authorized/);
    const done = probe.archive.append(randomUUID(), 'Finish task');
    const active = probe.store.readIntent(probe.activity)!;
    const completed = probe.store.transitionIntent(probe.activity, active.eventId, done, { status: 'completed', step: 'done' });
    const restart = probe.archive.append(randomUUID(), 'Reactivate same intent');
    probe.store.transitionIntent(probe.activity, completed.eventId, restart, { status: 'active', step: 'resumed' });
    assert.throws(() => probe.store.authorizeMemoryDiscovery(probe.activity, approval, [sandbox.fixture.projectId], 1), /discovery-consent-required/);
    assert.throws(() => probe.store.authorizeMemoryDiscovery(probe.activity, secondApproval, [sandbox.fixture.projectId], 1), /discovery-consent-required/);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('an owner can revoke a grant while the intent is paused', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const text = 'Authorize bounded analysis';
    const input = probe.archive.append(randomUUID(), text);
    probe.store.transitionIntent(probe.activity, null, input, { status: 'active', step: 'analysis' }, text);
    const approval = approveDiscovery(probe, [sandbox.fixture.projectId], 1);
    const { grantId } = probe.store.authorizeMemoryDiscovery(probe.activity, approval, [sandbox.fixture.projectId], 1);
    const pauseInput = probe.archive.append(randomUUID(), 'Pause task');
    const current = probe.store.readIntent(probe.activity)!;
    const paused = probe.store.transitionIntent(probe.activity, current.eventId, pauseInput, { status: 'paused', step: 'waiting' });
    probe.store.revokeMemoryDiscovery(probe.activity, grantId);
    const resumeInput = probe.archive.append(randomUUID(), 'Resume task');
    probe.store.transitionIntent(probe.activity, paused.eventId, resumeInput, { status: 'active', step: 'analysis' });
    assert.throws(() => probe.store.searchMemories(probe.activity, { query: 'Atlas', grantId }), /discovery-not-authorized/);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
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
    const consent = approveDiscovery(first, [sandbox.fixture.projectId], 2);
    const { grantId } = first.store.authorizeMemoryDiscovery(first.activity, consent, [sandbox.fixture.projectId], 2);
    const page = first.store.searchMemories(first.activity, { query: 'Atlas', grantId });
    assert.equal(page.status, 'ready');
    assert.deepEqual(page.results, []);
    assert.equal(JSON.stringify(page).includes(other.projectId), false);
    assert.equal(JSON.stringify(page).includes('global note'), false);
  } finally { second.close(); first.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('malformed applies-to conditions fail at capture instead of granting normal applicability', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const source = probe.archive.append(randomUUID(), 'restriction evidence');
    for (const condition of ['agent:cli:restricted', 'unknown:cli', 'platform:', 'agent:cli restricted']) {
      assert.throws(() => probe.store.captureMemory(probe.activity, source, 'Restricted route', {
        type: 'fact', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: [condition],
      }), /invalid-memory-scope/, condition);
    }
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('X03/X04: cross-project applies-to uses the target environment, not the querying host', () => {
  const sandbox = createSandbox();
  const other = { ...bindingOf(sandbox), projectId: randomUUID(), sessionId: randomUUID() };
  createSandboxSession(sandbox, other);
  const first = openProbe(sandbox);
  const second = openProbe(sandbox, undefined, undefined, other);
  const unknownBinding = { ...bindingOf(sandbox), sessionId: randomUUID(), branchId: randomUUID() };
  const wrongBinding = { ...bindingOf(sandbox), sessionId: randomUUID(), branchId: randomUUID() };
  createSandboxSession(sandbox, unknownBinding);
  createSandboxSession(sandbox, wrongBinding);
  const unknownHost = openProbe(sandbox, undefined, undefined, unknownBinding);
  const wrongHost = openProbe(sandbox, undefined, undefined, wrongBinding);
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
    const knownTarget = { [other.projectId]: { platform, agent: 'cli' } };
    const knownConsent = approveDiscovery(first, [other.projectId], 8, knownTarget);
    const knownGrant = first.store.authorizeMemoryDiscovery(first.activity, knownConsent, [other.projectId], 8, knownTarget);
    assert.throws(() => first.store.authorizeMemoryDiscovery(first.activity, knownConsent, [other.projectId], 8,
      { [other.projectId]: { platform: process.platform } }), /discovery-consent-required/);
    const known = first.store.searchMemories(first.activity, { query: 'socket', grantId: knownGrant.grantId });
    assert.equal(known.status, 'ready');
    const knownHit = known.results[0];
    assert.equal(knownHit?.kind, 'memory');
    if (knownHit?.kind === 'memory') assert.equal(knownHit.applicability, 'applicable');
    const unknownText = 'Analyze with unknown target';
    const unknownInput = unknownHost.archive.append(randomUUID(), unknownText);
    unknownHost.store.transitionIntent(unknownHost.activity, null, unknownInput, { status: 'active', step: 'analysis' }, unknownText);
    const unknownApproval = approveDiscovery(unknownHost, [other.projectId], 8);
    const unknownGrant = unknownHost.store.authorizeMemoryDiscovery(unknownHost.activity, unknownApproval, [other.projectId], 8);
    const unknown = unknownHost.store.searchMemories(unknownHost.activity, { query: 'socket', grantId: unknownGrant.grantId });
    const unknownHit = unknown.results[0];
    assert.equal(unknownHit?.kind, 'memory');
    if (unknownHit?.kind === 'memory') {
      assert.equal(unknownHit.applicability, 'needs-verification');
      assert.equal(unknownHit.exposureMode, 'reference_only');
    }
    const wrongTarget = { [other.projectId]: { platform: process.platform } };
    const wrongText = 'Analyze wrong target';
    const wrongInput = wrongHost.archive.append(randomUUID(), wrongText);
    wrongHost.store.transitionIntent(wrongHost.activity, null, wrongInput, { status: 'active', step: 'analysis' }, wrongText);
    const wrongConsent = approveDiscovery(wrongHost, [other.projectId], 8, wrongTarget);
    const wrongGrant = wrongHost.store.authorizeMemoryDiscovery(wrongHost.activity, wrongConsent, [other.projectId], 8, wrongTarget);
    assert.equal(wrongHost.store.searchMemories(wrongHost.activity, { query: 'socket', grantId: wrongGrant.grantId }).results.length, 0);
    assert.throws(() => unknownHost.store.searchMemories(unknownHost.activity, {
      query: 'socket', grantId: unknownGrant.grantId, target: { platform },
    }), /invalid-search-target/);
  } finally { wrongHost.close(); unknownHost.close(); second.close(); first.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
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
    assert.deepEqual(probe.store.listEligibleMemories(probe.activity), []);
    assert.equal('record' in page.results[0]!, false);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('cross-project conflict statuses retain both source project labels', () => {
  const sandbox = createSandbox();
  const other = { ...bindingOf(sandbox), projectId: randomUUID(), sessionId: randomUUID() };
  createSandboxSession(sandbox, other);
  const first = openProbe(sandbox);
  const second = openProbe(sandbox, undefined, undefined, other);
  try {
    for (const [probe, projectId] of [[first, sandbox.fixture.projectId], [second, other.projectId]] as const) {
      const records = ['enabled', 'disabled'].map(value => {
        const source = probe.archive.append(randomUUID(), `Evidence: Atlas ${value} ${projectId}`);
        const captured = probe.store.captureMemory(probe.activity, source, `Atlas ${value}`, {
          type: 'fact', scope: { kind: 'personal', id: other.ownerId, resolved: true }, appliesTo: [],
        }).record;
        const verified = probe.store.verifyMemory(probe.activity, captured.recordId, captured, 'pass', [source]).record;
        return probe.store.activateMemory(probe.activity, verified.recordId, verified).record;
      });
      probe.store.conflictMemory(probe.activity, records[0]!.recordId, records[0]!, records[1]!.recordId, records[1]!);
      probe.store.drainSearchProjection(probe.activity);
    }
    const text = 'Approve cross-project conflict inspection';
    const input = first.archive.append(randomUUID(), text);
    first.store.transitionIntent(first.activity, null, input, { status: 'active', step: 'analysis' }, text);
    const consent = approveDiscovery(first, [sandbox.fixture.projectId, other.projectId], 4);
    const { grantId } = first.store.authorizeMemoryDiscovery(first.activity, consent, [sandbox.fixture.projectId, other.projectId], 4);
    const page = first.store.searchMemories(first.activity, { query: 'Atlas', grantId });
    assert.equal(page.status, 'ready');
    assert.deepEqual(new Set(page.results.map(item => item.projectId)), new Set([sandbox.fixture.projectId, other.projectId]));
    assert.ok(page.results.every(item => item.kind === 'status' && item.reason === 'conflicted'));
    assert.equal(JSON.stringify(page.results).includes('Atlas enabled'), false);
  } finally { second.close(); first.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
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
    assert.deepEqual(pending.coverage.inspectedProjects, []);
    assert.deepEqual(pending.coverage.unavailableProjects, [sandbox.fixture.projectId]);
    probe.store.rebuildSearchProjection(probe.activity);
    const rebuilt = probe.store.searchMemories(probe.activity, { query: 'Atlas' });
    assert.equal(rebuilt.status, 'ready');
    assert.equal(rebuilt.results[0]?.unitId, captured.recordId);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
