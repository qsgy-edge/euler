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
    assert.equal(probe.store.searchMemories(probe.activity, '路由').length, 0);
    assert.equal(probe.store.drainSearchProjection(probe.activity).length, 3);
    assert.equal(probe.store.searchMemories(probe.activity, '路由')[0]!.record.recordId, active.record.recordId);
    probe.store.forgetMemory(probe.activity, active.record.recordId, active.record);
    probe.store.drainSearchProjection(probe.activity);
    assert.deepEqual(probe.store.searchMemories(probe.activity, '路由'), []);
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
    assert.throws(() => probe.store.searchMemories(probe.activity, '新内容'), /search-evidence-gap/);
    probe.store.rebuildSearchProjection(probe.activity);
    assert.equal(probe.store.searchMemories(probe.activity, '新内容')[0]!.record.revisionId, revised.record.revisionId);
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
    assert.equal(second.store.searchMemories(second.activity, '项目')[0]!.record.recordId, captured.record.recordId);
    first.store.rebuildSearchProjection(first.activity);
    assert.equal(second.store.searchMemories(second.activity, '项目')[0]!.record.recordId, captured.record.recordId);
  } finally { second.close(); first.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
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
    assert.equal(probe.store.searchMemories(probe.activity, '地路').length, 0);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
