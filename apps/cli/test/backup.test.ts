import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { SnapshotFile } from '@euler/core';
import { createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';
import { backupSandbox, listSandboxBackups } from '../src/backup.ts';

test('a verified online snapshot preserves the database and its exact source and owner carriers', async () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const turn = probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
    probe.session.dispatch(turn);
    const result = await backupSandbox(sandbox);
    assert.equal(result.status, 'created');
    assert.ok(result.snapshot);
    assert.equal(result.snapshot.state, 'ready');
    const snapshots = listSandboxBackups(sandbox);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]!.id, result.snapshot.id);
    const db = new DatabaseSync(join(result.snapshot.directory.path, 'store.sqlite'), { readOnly: true });
    try {
      assert.deepEqual(db.prepare('PRAGMA quick_check').all().map(row => row.quick_check), ['ok']);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(db.prepare('SELECT count(*) AS n FROM request_attempts').get()!.n, 1);
    } finally { db.close(); }
    for (const name of ['session.jsonl', 'owner-info.jsonl', 'counting-receiver.jsonl']) {
      const carrier: SnapshotFile | undefined = result.snapshot.files.find(file => file.source.path === join(sandbox.root, name));
      assert.ok(carrier, name);
      assert.deepEqual(readFileSync(join(result.snapshot.directory.path, carrier.name)), readFileSync(carrier.source.path));
    }
    assert.equal(probe.transport.count, 1);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('changed daily snapshots retain the latest two and unchanged days create nothing', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-01T12:00:00Z') });
  const sandbox = createSandbox();
  const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    assert.equal((await backupSandbox(sandbox)).status, 'created');
    assert.equal((await backupSandbox(sandbox)).status, 'daily-limit');
    context.mock.timers.setTime(new Date('2026-01-02T12:00:00Z').getTime());
    assert.equal((await backupSandbox(sandbox)).status, 'unchanged');
    probe.archive.append('00000000-0000-4000-8000-000000000001', 'second snapshot source');
    const second = await backupSandbox(sandbox);
    context.mock.timers.setTime(new Date('2026-01-03T12:00:00Z').getTime());
    probe.archive.append('00000000-0000-4000-8000-000000000002', 'third snapshot source');
    const third = await backupSandbox(sandbox);
    assert.deepEqual(listSandboxBackups(sandbox).map(snapshot => snapshot.id), [second.snapshot!.id, third.snapshot!.id]);
    assert.equal(readdirSync(sandbox.root).filter(name => name.startsWith('backup-')).length, 2);
    assert.equal(probe.archive.inspect().eventCount, 2);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('an online snapshot keeps one database and archive boundary while normal writes continue', async () => {
  const sandbox = createSandbox(), probe = openProbe(sandbox);
  try {
    const initial = probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
    const saving = backupSandbox(sandbox);
    const next = probe.archive.append(randomUUID(), 'a later source outside the snapshot');
    probe.store.transitionIntent(probe.activity, initial.intent.eventId, next, { status: 'active', step: 'later step' });
    const saved = (await saving).snapshot!;
    const db = new DatabaseSync(join(saved.directory.path, 'store.sqlite'), { readOnly: true });
    try { assert.equal(db.prepare('SELECT max(version) AS version FROM intent_events').get()!.version, 1); }
    finally { db.close(); }
    assert.equal(probe.store.readIntent(probe.activity)!.version, 2);
    const file = saved.files.find(file => file.source.path === join(sandbox.root, 'session.jsonl'))!;
    assert.ok(!readFileSync(join(saved.directory.path,file.name),'utf8').includes(next.eventId));
    assert.equal(probe.archive.read(next).text, 'a later source outside the snapshot');
  } finally { probe.close(); rmSync(sandbox.root,{recursive:true,force:true}); }
});

test('valid archive syntax with altered referenced bytes cannot become a recoverable snapshot', async () => {
  const sandbox = createSandbox(), probe = openProbe(sandbox);
  try {
    probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
    const path = join(sandbox.root, 'session.jsonl');
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
    const event = JSON.parse(lines[1]!); event.text += ' changed after acknowledgement';
    lines[1] = JSON.stringify(event); writeFileSync(path, lines.join('\n') + '\n');
    await assert.rejects(backupSandbox(sandbox), /source-evidence-gap/);
    assert.equal(readdirSync(sandbox.root).filter(name => name.startsWith('backup-')).length, 0);
  } finally { probe.store.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
