import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { createSandbox, createSandboxSession, bindingOf } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

test('search projection drains outbox and applies canonical eligibility', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const source = probe.archive.append(sandbox.fixture.eventId, sandbox.fixture.text);
    const options = { type: 'fact' as const, scope: { kind: 'project' as const, id: sandbox.fixture.projectId, resolved: true }, appliesTo: [] };
    const captured = probe.store.captureMemory(probe.activity, source, '本地路由优先', options);
    const verified = probe.store.verifyMemory(probe.activity, captured.record.recordId, captured.record, 'pass', [source]);
    const active = probe.store.activateMemory(probe.activity, captured.record.recordId, verified.record);
    assert.equal(probe.store.searchMemories(probe.activity, { query: '路由' }).results.length, 0);
    assert.equal(probe.store.drainSearchProjection(probe.activity).length, 3);
    assert.equal(probe.store.searchMemories(probe.activity, { query: '路由' }).results[0]?.unitId, active.record.recordId);
    probe.store.forgetMemory(probe.activity, active.record.recordId, active.record);
    probe.store.drainSearchProjection(probe.activity);
    assert.deepEqual(probe.store.searchMemories(probe.activity, { query: '路由' }).results, []);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('search projection rebuilds canonical content after document corruption', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  const db = new DatabaseSync(`${sandbox.root}/probe.sqlite`);
  try {
    const source = probe.archive.append(sandbox.fixture.eventId, sandbox.fixture.text);
    const options = { type: 'fact' as const, scope: { kind: 'project' as const, id: sandbox.fixture.projectId, resolved: true }, appliesTo: [] };
    const captured = probe.store.captureMemory(probe.activity, source, '旧内容', options);
    const verified = probe.store.verifyMemory(probe.activity, captured.record.recordId, captured.record, 'pass', [source]);
    const active = probe.store.activateMemory(probe.activity, captured.record.recordId, verified.record);
    probe.store.drainSearchProjection(probe.activity);
    const changedSource = probe.archive.append('00000000-0000-4000-8000-000000000051', '新证据');
    const revised = probe.store.reviseMemory(probe.activity, active.record.recordId, active.record, changedSource, '新内容', [changedSource]);
    probe.store.drainSearchProjection(probe.activity);
    db.prepare("UPDATE search_documents SET content='伪造内容', content_hash=? WHERE record_id=?").run('0'.repeat(64), active.record.recordId);
    const corrupted = probe.store.searchMemories(probe.activity, { query: '新内容' });
    assert.equal(corrupted.status, 'dirty');
    assert.deepEqual(corrupted.results, []);
    assert.equal(corrupted.coverage.reason, 'index-lag');
    probe.store.rebuildSearchProjection(probe.activity);
    assert.equal(probe.store.searchMemories(probe.activity, { query: '新内容' }).results[0]?.unitId, revised.record.recordId);
  } finally { db.close(); probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('rebuilding one project preserves another project search slice', () => {
  const sandbox = createSandbox();
  const otherBinding = { ...bindingOf(sandbox), projectId: randomUUID(), sessionId: randomUUID() };
  createSandboxSession(sandbox, otherBinding);
  const first = openProbe(sandbox);
  const second = openProbe(sandbox, undefined, undefined, otherBinding);
  try {
    const source = second.archive.append(randomUUID(), '另一个项目证据');
    const options = { type: 'fact' as const, scope: { kind: 'project' as const, id: otherBinding.projectId, resolved: true }, appliesTo: [] };
    const captured = second.store.captureMemory(second.activity, source, '共享项目内容', options);
    const verified = second.store.verifyMemory(second.activity, captured.record.recordId, captured.record, 'pass', [source]);
    second.store.activateMemory(second.activity, captured.record.recordId, verified.record);
    second.store.drainSearchProjection(second.activity);
    assert.equal(second.store.searchMemories(second.activity, { query: '项目' }).results[0]?.unitId, captured.record.recordId);
    first.store.rebuildSearchProjection(first.activity);
    assert.equal(second.store.searchMemories(second.activity, { query: '项目' }).results[0]?.unitId, captured.record.recordId);
  } finally { second.close(); first.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('a projected owner change cannot make an eligible fact disappear as an empty result', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  const db = new DatabaseSync(`${sandbox.root}/probe.sqlite`);
  try {
    const source = probe.archive.append(randomUUID(), 'owner-bound source');
    const captured = probe.store.captureMemory(probe.activity, source, 'Atlas ownership', {
      type: 'fact', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: [],
    }).record;
    const verified = probe.store.verifyMemory(probe.activity, captured.recordId, captured, 'pass', [source]).record;
    probe.store.activateMemory(probe.activity, verified.recordId, verified);
    probe.store.drainSearchProjection(probe.activity);
    db.prepare('UPDATE search_documents SET owner_id=? WHERE record_id=?').run(randomUUID(), captured.recordId);
    const page = probe.store.searchMemories(probe.activity, { query: 'Atlas' });
    assert.equal(page.status, 'dirty');
    assert.deepEqual(page.results, []);
  } finally { db.close(); probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('project spoofing in a shared projection cannot reveal term presence from an ungranted source', () => {
  const sandbox = createSandbox();
  const other = { ...bindingOf(sandbox), projectId: randomUUID(), sessionId: randomUUID() };
  createSandboxSession(sandbox, other);
  const first = openProbe(sandbox);
  const second = openProbe(sandbox, undefined, undefined, other);
  const db = new DatabaseSync(`${sandbox.root}/probe.sqlite`);
  try {
    const source = second.archive.append(randomUUID(), 'private personal evidence');
    const captured = second.store.captureMemory(second.activity, source, 'HiddenCanary', {
      type: 'fact', scope: { kind: 'personal', id: other.ownerId, resolved: true }, appliesTo: [],
    }).record;
    const verified = second.store.verifyMemory(second.activity, captured.recordId, captured, 'pass', [source]).record;
    second.store.activateMemory(second.activity, verified.recordId, verified);
    second.store.drainSearchProjection(second.activity);
    const goal = 'Analyze only the registered local project';
    const input = first.archive.append(randomUUID(), goal);
    const intent = first.store.transitionIntent(first.activity, null, input, { status: 'active', step: 'analysis' }, goal);
    const approval = first.archive.append(randomUUID(), JSON.stringify({ schema: 'memory-discovery-approval@1',
      intentId: intent.intentId, goalEventId: intent.goalInput.eventId,
      projectIds: [sandbox.fixture.projectId], targets: {}, maxResults: 2, maxBytes: 131072 }));
    const { grantId } = first.store.authorizeMemoryDiscovery(first.activity, approval, [sandbox.fixture.projectId], 2);
    db.prepare('UPDATE search_documents SET project_id=? WHERE record_id=?').run(sandbox.fixture.projectId, captured.recordId);
    const absent = first.store.searchMemories(first.activity, { query: 'AbsentCanary', grantId });
    const present = first.store.searchMemories(first.activity, { query: 'HiddenCanary', grantId });
    assert.equal(absent.status, 'dirty');
    assert.equal(present.status, 'dirty');
    assert.equal(absent.coverage.reason, 'index-lag');
    assert.equal(present.coverage.reason, 'index-lag');
    assert.deepEqual(absent.results, []);
    assert.deepEqual(present.results, []);
    assert.equal(JSON.stringify(absent).includes(other.projectId), false);
    assert.equal(JSON.stringify(present).includes(other.projectId), false);
  } finally { db.close(); second.close(); first.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('missing FTS posting reports a dirty projection instead of an empty answer', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  const db = new DatabaseSync(`${sandbox.root}/probe.sqlite`);
  try {
    const source = probe.archive.append(randomUUID(), 'posting evidence');
    const captured = probe.store.captureMemory(probe.activity, source, 'Atlas posting', {
      type: 'fact', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: [],
    }).record;
    const verified = probe.store.verifyMemory(probe.activity, captured.recordId, captured, 'pass', [source]).record;
    probe.store.activateMemory(probe.activity, verified.recordId, verified);
    probe.store.drainSearchProjection(probe.activity);
    const row = db.prepare('SELECT rowid,content FROM search_documents WHERE record_id=?').get(captured.recordId)!;
    db.prepare("INSERT INTO search_fts(search_fts,rowid,content) VALUES ('delete',?,?)").run(row.rowid!, row.content!);
    const missing = probe.store.searchMemories(probe.activity, { query: 'Atlas' });
    assert.equal(missing.status, 'dirty');
    assert.deepEqual(missing.results, []);
    probe.store.rebuildSearchProjection(probe.activity);
    assert.equal(probe.store.searchMemories(probe.activity, { query: 'Atlas' }).results[0]?.unitId, captured.recordId);
  } finally { db.close(); probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('excluded project terms cannot influence visible scores', () => {
  const sandbox = createSandbox();
  const other = { ...bindingOf(sandbox), projectId: randomUUID(), sessionId: randomUUID() };
  createSandboxSession(sandbox, other);
  const first = openProbe(sandbox);
  const second = openProbe(sandbox, undefined, undefined, other);
  try {
    const visibleSource = first.archive.append(randomUUID(), 'visible evidence');
    const visible = first.store.captureMemory(first.activity, visibleSource, 'Alpha route', {
      type: 'fact', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: [],
    }).record;
    const v = first.store.verifyMemory(first.activity, visible.recordId, visible, 'pass', [visibleSource]).record;
    first.store.activateMemory(first.activity, v.recordId, v);
    first.store.drainSearchProjection(first.activity);
    const hiddenSource = second.archive.append(randomUUID(), 'hidden evidence');
    const hidden = second.store.captureMemory(second.activity, hiddenSource, 'Hidden alpha', {
      type: 'fact', scope: { kind: 'project', id: other.projectId, resolved: true }, appliesTo: [],
    }).record;
    const hv = second.store.verifyMemory(second.activity, hidden.recordId, hidden, 'pass', [hiddenSource]).record;
    const active = second.store.activateMemory(second.activity, hv.recordId, hv).record;
    const fillerSource = second.archive.append(randomUUID(), 'filler evidence');
    const filler = second.store.captureMemory(second.activity, fillerSource, 'Other term', {
      type: 'fact', scope: { kind: 'project', id: other.projectId, resolved: true }, appliesTo: [],
    }).record;
    const fv = second.store.verifyMemory(second.activity, filler.recordId, filler, 'pass', [fillerSource]).record;
    second.store.activateMemory(second.activity, fv.recordId, fv);
    second.store.drainSearchProjection(second.activity);
    const goal = 'Analyze only project A';
    const input = first.archive.append(randomUUID(), goal);
    const intent = first.store.transitionIntent(first.activity, null, input, { status: 'active', step: 'analysis' }, goal);
    const approval = first.archive.append(randomUUID(), JSON.stringify({ schema: 'memory-discovery-approval@1',
      intentId: intent.intentId, goalEventId: intent.goalInput.eventId,
      projectIds: [sandbox.fixture.projectId], targets: {}, maxResults: 4, maxBytes: 131072 }));
    const { grantId } = first.store.authorizeMemoryDiscovery(first.activity, approval, [sandbox.fixture.projectId], 4);
    const before = first.store.searchMemories(first.activity, { query: 'alpha', grantId });
    const changedSource = second.archive.append(randomUUID(), 'replacement evidence');
    second.store.reviseMemory(second.activity, active.recordId, active, changedSource, 'Hidden omega', [changedSource]);
    second.store.drainSearchProjection(second.activity);
    assert.equal(second.store.searchMemories(second.activity, { query: 'omega' }).results[0]?.unitId, hidden.recordId);
    const after = first.store.searchMemories(first.activity, { query: 'alpha', grantId });
    assert.equal(before.status, 'ready');
    assert.equal(after.status, 'ready');
    assert.deepEqual(before.results.map(hit => [hit.unitId, hit.rank]), after.results.map(hit => [hit.unitId, hit.rank]));
    assert.deepEqual(before.results.map(hit => hit.projectId), [sandbox.fixture.projectId]);
  } finally { second.close(); first.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('rebuild deletes canonical rows even when projected owner or scope was corrupted', () => {
  for (const field of ['owner_id', 'scope_id'] as const) {
    const sandbox = createSandbox();
    const probe = openProbe(sandbox);
    const db = new DatabaseSync(`${sandbox.root}/probe.sqlite`);
    try {
      const source = probe.archive.append(randomUUID(), 'rebuild evidence');
      const captured = probe.store.captureMemory(probe.activity, source, 'Atlas repair', {
        type: 'fact', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: [],
      }).record;
      const verified = probe.store.verifyMemory(probe.activity, captured.recordId, captured, 'pass', [source]).record;
      probe.store.activateMemory(probe.activity, verified.recordId, verified);
      probe.store.drainSearchProjection(probe.activity);
      db.prepare(`UPDATE search_documents SET ${field}=? WHERE record_id=?`).run(randomUUID(), captured.recordId);
      assert.equal(probe.store.searchMemories(probe.activity, { query: 'Atlas' }).status, 'dirty');
      probe.store.rebuildSearchProjection(probe.activity);
      const repaired = probe.store.searchMemories(probe.activity, { query: 'Atlas' });
      assert.equal(repaired.status, 'ready', field);
      assert.equal(repaired.results[0]?.unitId, captured.recordId, field);
    } finally { db.close(); probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
  }
});

test('CJK bigrams do not cross punctuation boundaries', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const source = probe.archive.append(randomUUID(), '边界证据');
    const options = { type: 'fact' as const, scope: { kind: 'project' as const, id: sandbox.fixture.projectId, resolved: true }, appliesTo: [] };
    const captured = probe.store.captureMemory(probe.activity, source, '本地,路由', options);
    const verified = probe.store.verifyMemory(probe.activity, captured.record.recordId, captured.record, 'pass', [source]);
    probe.store.activateMemory(probe.activity, captured.record.recordId, verified.record);
    probe.store.drainSearchProjection(probe.activity);
    assert.equal(probe.store.searchMemories(probe.activity, { query: '地路' }).results.length, 0);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
