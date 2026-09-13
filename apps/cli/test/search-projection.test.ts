import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { createSandbox } from '../src/sandbox.ts';
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
    assert.equal(probe.store.searchMemories(probe.activity, '路由').length, 0);
    assert.equal(probe.store.drainSearchProjection(probe.activity).length, 3);
    assert.equal(probe.store.searchMemories(probe.activity, '路由')[0]!.record.recordId, active.record.recordId);
    probe.store.forgetMemory(probe.activity, active.record.recordId, active.record);
    probe.store.drainSearchProjection(probe.activity);
    assert.deepEqual(probe.store.searchMemories(probe.activity, '路由'), []);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('search projection rebuilds after FTS corruption and ignores stale outbox order', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  const db = new DatabaseSync(`${sandbox.root}/probe.sqlite`);
  try {
    const source = probe.archive.append(sandbox.fixture.eventId, sandbox.fixture.text);
    const options = { type: 'fact' as const, scope: { kind: 'project' as const, id: sandbox.fixture.projectId, resolved: true }, appliesTo: [] };
    const captured = probe.store.captureMemory(probe.activity, source, '旧内容', options);
    const verified = probe.store.verifyMemory(probe.activity, captured.record.recordId, captured.record, 'pass', [source]);
    const active = probe.store.activateMemory(probe.activity, captured.record.recordId, verified.record);
    const first = probe.store.drainSearchProjection(probe.activity);
    assert.equal(first.length, 3);
    const changedSource = probe.archive.append('00000000-0000-4000-8000-000000000051', '新证据');
    const revised = probe.store.reviseMemory(probe.activity, active.record.recordId, active.record, changedSource, '新内容', [changedSource]);
    probe.store.drainSearchProjection(probe.activity);
    db.exec('DELETE FROM search_fts');
    assert.deepEqual(probe.store.searchMemories(probe.activity, '新内容'), []);
    probe.store.rebuildSearchProjection(probe.activity);
    assert.equal(probe.store.searchMemories(probe.activity, '新内容')[0]!.record.revisionId, revised.record.revisionId);
  } finally { db.close(); probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
