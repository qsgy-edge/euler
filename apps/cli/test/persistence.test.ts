import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createSandbox, createSandboxSession, openSandbox, resolveDataRoot, bindingOf, resourcesOf, syncFile } from '../src/sandbox.ts';
import { CliArchive } from '../src/archive.ts';
import type { Activity } from '@euler/core';
import { ProbeStore, fileIdentity } from '@euler/core';
import { openProbe } from '../src/probe.ts';

// Agreed X-01 seams: public Store operations, actual SQLite constraints and restart.
test('registered sessions share project memory without sharing intent or rebinding a source owner', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  let second: ProbeStore | undefined;
  try {
    const input = probe.archive.append(sandbox.fixture.eventId, sandbox.fixture.text);
    const captured = probe.store.captureMemory(probe.activity, input, 'Shared project fact', {
      type: 'fact', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: [],
    });
    const binding = { ...bindingOf(sandbox), sessionId: randomUUID() };
    const path = join(sandbox.root, `session-${binding.sessionId}.jsonl`);
    writeFileSync(path, JSON.stringify({ schema: 'cli-session@1', binding }) + '\n', { flag: 'wx' });
    syncFile(path);
    const source = { path, identity: fileIdentity(path) };
    probe.store.bindSession(probe.activity, binding, source);
    let activity: Activity;
    second = new ProbeStore({ ...resourcesOf(sandbox), source }, sandbox.storeId, binding, false,
      ref => new CliArchive(sandbox, action => second!.withActivity(activity, action)).read(ref));
    activity = second.register();
    assert.deepEqual(second.readMemory(activity, captured.record.recordId), captured.record);
    assert.equal(second.readIntent(activity), null);
    assert.throws(() => new ProbeStore({ ...resourcesOf(sandbox), source }, sandbox.storeId,
      { ...binding, projectId: randomUUID() }), /store-binding-mismatch/);
    assert.throws(() => probe.store.bindSession(probe.activity, { ...binding, sessionId: randomUUID() }, source), /UNIQUE/);
  } finally { second?.close(); probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('disposable app identities open the same local store and keep another app separate', () => {
  const appA = `euler-t04-${randomUUID()}`;
  const appB = `euler-t04-${randomUUID()}`;
  const a = createSandbox(appA);
  const b = createSandbox(appB);
  try {
    assert.equal(a.root, resolveDataRoot(appA));
    assert.equal(b.root, resolveDataRoot(appB));
    assert.notDeepEqual(a.storeIdentity, b.storeIdentity);
    assert.deepEqual(openSandbox(resolveDataRoot(appA)), a);
    assert.equal(resourcesOf(a).store.path, join(a.root, 'store.sqlite3'));
    const probe = openProbe(a);
    try { assert.equal(probe.store.diagnostics().journalMode, 'wal'); } finally { probe.close(); }
    assert.throws(() => createSandbox('euler'), /synthetic-app-id-required/);
    assert.throws(() => resolveDataRoot('../euler'), /invalid-app-id/);
  } finally { rmSync(a.root, { recursive: true, force: true }); rmSync(b.root, { recursive: true, force: true }); }
});

test('activation commits an ordered immutable batch with one Info outbox and per-event search work', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const candidates = ['First fact', 'Second fact'].map(content => {
      const source = probe.archive.append(randomUUID(), content);
      const captured = probe.store.captureMemory(probe.activity, source, content, {
        type: 'fact', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: [],
      });
      return probe.store.verifyMemory(probe.activity, captured.record.recordId, captured.record, 'pass', [source]).record;
    });
    const batch = probe.store.activateMemoryBatch(probe.activity, candidates);
    assert.equal(batch.events.length, 2);
    assert.deepEqual(batch.events.map(event => event.recordId), candidates.map(record => record.recordId));
    assert.equal(probe.store.pendingMemoryProjections(probe.activity).filter(job => job.kind === 'host-info').length, 1);
    assert.equal(probe.store.listEligibleMemories(probe.activity).length, 2);
    probe.store.forgetMemory(probe.activity, batch.events[0]!.after.recordId, batch.events[0]!.after);
    assert.deepEqual(probe.store.readActivationBatch(probe.activity, batch.batchId), batch);
    assert.throws(() => probe.store.activateMemoryBatch(probe.activity, [candidates[0]!, candidates[0]!]), /duplicate-batch-target/);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('explicit workspace membership shares only workspace and personal facts across logical projects', () => {
  const sandbox = createSandbox();
  const otherBinding = { ...bindingOf(sandbox), projectId: randomUUID(), sessionId: randomUUID() };
  createSandboxSession(sandbox, otherBinding);
  const first = openProbe(sandbox);
  const second = openProbe(sandbox, undefined, undefined, otherBinding);
  try {
    const workspaceId = randomUUID();
    first.store.bindWorkspace(first.activity, workspaceId, [sandbox.fixture.projectId, otherBinding.projectId]);
    for (const scope of [
      { kind: 'project' as const, id: sandbox.fixture.projectId, resolved: true },
      { kind: 'workspace' as const, id: workspaceId, resolved: true },
      { kind: 'personal' as const, id: sandbox.fixture.ownerId, resolved: true },
    ]) {
      const source = first.archive.append(randomUUID(), `${scope.kind} evidence`);
      const c = first.store.captureMemory(first.activity, source, `${scope.kind} fact`, { type: 'fact', scope, appliesTo: [] });
      const v = first.store.verifyMemory(first.activity, c.record.recordId, c.record, 'pass', [source]);
      first.store.activateMemory(first.activity, c.record.recordId, v.record);
    }
    assert.deepEqual(second.store.listEligibleMemories(second.activity).map(record => record.content), ['workspace fact', 'personal fact']);
    assert.equal(second.store.recoverMemories(second.activity).length, 2);
    assert.equal(second.store.pendingMemoryProjections(second.activity).filter(job => job.kind === 'host-info').length, 2);
    assert.throws(() => first.store.bindWorkspace(first.activity, randomUUID(), [sandbox.fixture.projectId, otherBinding.projectId]), /UNIQUE/);
  } finally { second.close(); first.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('unknown schema and another app identity are rejected, and high-frequency filters use declared indexes', () => {
  const sandbox = createSandbox();
  const db = new DatabaseSync(`${sandbox.root}/probe.sqlite`);
  try {
    assert.throws(() => new ProbeStore(resourcesOf(sandbox), sandbox.storeId, bindingOf(sandbox), false, undefined, 'other-app'), /store-schema-identity-mismatch/);
    const eligibility = db.prepare(`EXPLAIN QUERY PLAN SELECT record_id FROM memory_heads
      WHERE lifecycle='active' AND verification='verified' AND scope_kind='project' AND scope_id=?`).all(sandbox.fixture.projectId);
    assert.ok(eligibility.some(row => String(row.detail).includes('memory_heads_eligibility')));
    const pending = db.prepare("EXPLAIN QUERY PLAN SELECT operation_id FROM pending_operations WHERE session_id=? AND state='pending'").all(sandbox.fixture.sessionId);
    assert.ok(pending.some(row => String(row.detail).includes('session_pending')));
    db.exec('PRAGMA user_version=999');
    assert.throws(() => openProbe(sandbox), /unsupported-probe-schema/);
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 999);
  } finally { db.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('an intent head cannot be rolled back to an older otherwise valid event', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  const db = new DatabaseSync(`${sandbox.root}/probe.sqlite`);
  try {
    const first = probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text).intent;
    const input = probe.archive.append(randomUUID(), 'Advance');
    probe.store.transitionIntent(probe.activity, first.eventId, input, { step: 'Next', status: 'active' });
    db.prepare('UPDATE intent_heads SET event_id=?').run(first.eventId);
    assert.throws(() => probe.store.readIntent(probe.activity), /intent-evidence-gap/);
  } finally { db.close(); probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('maintenance detects replacement of another registered session source', () => {
  const sandbox = createSandbox();
  const binding = { ...bindingOf(sandbox), sessionId: randomUUID() };
  createSandboxSession(sandbox, binding);
  const probe = openProbe(sandbox);
  try {
    const path = join(sandbox.root, `session-${binding.sessionId}.jsonl`);
    const bytes = readFileSync(path);
    renameSync(path, path + '.old');
    writeFileSync(path, bytes);
    const coordinator = randomUUID();
    probe.store.beginMaintenance(coordinator);
    const acquired = probe.store.acquireMaintenance(coordinator);
    assert.equal(acquired.residuals.find(row => row.path === `session-${binding.sessionId}.jsonl`)!.state, 'unexpected');
    probe.store.cancelMaintenance(coordinator);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('intent recovery rebuilds a missing head from immutable events and preserves the latest version', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  const db = new DatabaseSync(`${sandbox.root}/probe.sqlite`);
  try {
    const first = probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text).intent;
    const input = probe.archive.append(randomUUID(), 'Continue with the next step');
    const latest = probe.store.transitionIntent(probe.activity, first.eventId, input, { step: 'Check persistence', status: 'active' });
    db.exec('DELETE FROM intent_heads');
    assert.deepEqual(probe.store.recoverIntent(probe.activity), latest);
    assert.deepEqual(probe.store.readIntent(probe.activity), latest);
    assert.equal(db.prepare('SELECT count(*) AS n FROM intent_events').get()!.n, 2);
  } finally { db.close(); probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
