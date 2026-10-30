import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { Binding, BoundFile } from '@euler/core';
import { CliArchive } from '../src/archive.ts';
import { openMaintenanceStore } from '../src/backup.ts';
import { readPurgeCarriers } from '../src/purge.ts';
import { createSandbox } from '../src/sandbox.ts';

function setup() {
  const sandbox = createSandbox();
  const seeded = spawnSync(process.execPath, ['apps/cli/test/support/purge-worker.ts', sandbox.root], { encoding: 'utf8' });
  assert.equal(seeded.status, 0, seeded.stderr);
  const fixture = JSON.parse(seeded.stdout.trim().split('\n').at(-1)!);
  const store = openMaintenanceStore(sandbox), coordinator = randomUUID();
  store.beginMaintenance(coordinator); assert.equal(store.acquireMaintenance(coordinator).acquired, true);
  const source = join(sandbox.root, 'session.jsonl');
  const owner = (binding: Binding, file: BoundFile) => new CliArchive({ ...sandbox, sourceName: basename(file.path),
    archiveIdentity: file.identity, fixture: { ...sandbox.fixture, ...binding } }, action => action());
  const commit = () => {
    const carriers = readPurgeCarriers(sandbox, store, coordinator);
    const preview = store.previewPurge(coordinator, fixture.recordId, carriers);
    store.acknowledgePurgePresentation(coordinator, preview.token, preview.digest);
    return store.commitPurge(coordinator, store.receivePurgeInput(coordinator, preview.phrase), preview.token, carriers);
  };
  return { sandbox, fixture, store, coordinator, source, owner, commit, close: () => { store.close(); rmSync(sandbox.root, { recursive: true, force: true }); } };
}

test('source owner is never invoked without a durable logical commit', () => {
  const f = setup();
  try {
    const before = readFileSync(f.source);
    assert.throws(() => f.store.cleanupPurgeSources(f.coordinator, () => { throw new Error('owner-was-called'); }), /purge-logical-commit-required/);
    assert.deepEqual(readFileSync(f.source), before);
    assert.equal(f.store.purgeStatus(f.coordinator), null);
  } finally { f.close(); }
});

for (const fault of ['identity', 'content', 'owner', 'plan', 'permission'])
test(`source cleanup blocks ${fault} changes without erasing bytes and resumes only after the same resource is restored`, {
  skip: fault === 'permission' && process.getuid?.() === 0 ? 'root bypasses ordinary file mode permissions' : false,
}, () => {
  const f = setup(), originalPath = f.sandbox.root + '-original-source';
  try {
    f.commit();
    const before = readFileSync(f.source);
    let owner = f.owner;
    if (fault === 'identity') { renameSync(f.source, originalPath); writeFileSync(f.source, before); }
    if (fault === 'content') { const changed = Buffer.from(before); changed[changed.indexOf(Buffer.from('T21 source'))] = 88; writeFileSync(f.source, changed); }
    if (fault === 'owner') owner = () => undefined as never;
    if (fault === 'plan') owner = (binding, file) => {
      const archive = f.owner(binding, file), prepare = archive.preparePurge.bind(archive);
      archive.preparePurge = selection => { const plan = prepare(selection); plan.ranges[0]!.offset = 1; return plan; };
      return archive;
    };
    if (fault === 'permission') chmodSync(f.source, 0o444);
    const changed = readFileSync(f.source);
    assert.throws(() => f.store.cleanupPurgeSources(f.coordinator, owner),
      /file-identity-changed|maintenance-residuals-or-participants|purge-source-owner-unavailable|purge-source-range-mismatch|EPERM|EACCES/);
    assert.deepEqual(readFileSync(f.source), changed);
    if (fault === 'identity') { rmSync(f.source); renameSync(originalPath, f.source); }
    assert.equal(f.store.purgeStatus(f.coordinator)?.cleanup, 'incomplete');
    if (fault === 'content') writeFileSync(f.source, before);
    if (fault === 'permission') chmodSync(f.source, 0o600);
    assert.equal(f.store.cleanupPurgeSources(f.coordinator, f.owner).source.status, 'complete');
  } finally { chmodSync(f.source, 0o600); f.close(); rmSync(originalPath, { force: true }); }
});

test('a failed continuation acknowledgement is reconciled from erased bytes without repeating the logical commit', () => {
  const f = setup(), db = new DatabaseSync(join(f.sandbox.root, 'probe.sqlite'));
  try {
    const committed = f.commit();
    db.exec(`CREATE TRIGGER fail_source_ack BEFORE UPDATE ON pending_operations
      WHEN NEW.continuation LIKE '%"ack":{"hash"%' BEGIN SELECT RAISE(ABORT,'injected-ack-storage-failure'); END;`);
    assert.throws(() => f.store.cleanupPurgeSources(f.coordinator, f.owner), /injected-ack-storage-failure/);
    assert.equal(f.store.purgeStatus(f.coordinator)?.source.status, 'pending');
    const erased = readFileSync(f.source);
    assert.ok(!erased.includes(Buffer.from(f.fixture.target.source.eventId)));
    db.exec('DROP TRIGGER fail_source_ack');
    const result = f.store.cleanupPurgeSources(f.coordinator, f.owner);
    assert.deepEqual(result.receipt, committed.receipt);
    assert.equal(result.source.status, 'complete');
    assert.deepEqual(readFileSync(f.source), erased);
    assert.equal(db.prepare("SELECT count(*) n FROM memory_events WHERE kind='purge-logical-commit'").get()!.n, 1);
  } finally { db.close(); f.close(); }
});

test('an owner cannot acknowledge source completion without actually erasing its carrier', () => {
  const f = setup();
  try {
    f.commit(); const before = readFileSync(f.source);
    assert.throws(() => f.store.cleanupPurgeSources(f.coordinator, (binding, file) => {
      const archive = f.owner(binding, file);
      archive.purge = (selection, plan) => ({ hash: plan.afterHash, bytes: selection.bytes });
      return archive;
    }), /purge-source-postcondition-failed/);
    assert.deepEqual(readFileSync(f.source), before);
    assert.equal(f.store.purgeStatus(f.coordinator)?.source.status, 'pending');
    assert.equal(f.store.cleanupPurgeSources(f.coordinator, f.owner).source.status, 'complete');
  } finally { f.close(); }
});

test('a recorded source acknowledgement cannot report completion after the carrier changes', () => {
  const f = setup();
  try {
    f.commit(); const original = readFileSync(f.source);
    assert.equal(f.store.cleanupPurgeSources(f.coordinator, f.owner).source.status, 'complete');
    writeFileSync(f.source, original);
    assert.equal(f.store.purgeStatus(f.coordinator)?.source.status, 'blocked');
    assert.throws(() => f.store.cleanupPurgeSources(f.coordinator, f.owner), /maintenance-residuals-or-participants/);
    assert.deepEqual(readFileSync(f.source), original);
  } finally { f.close(); }
});

test('a real Windows sharing lock blocks source deletion until the handle is released', { skip: process.platform !== 'win32' }, async () => {
  const f = setup();
  const command = `$f=[System.IO.File]::Open($env:EULER_TEST_SOURCE,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::Read); try { [Console]::WriteLine('locked'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null } finally { $f.Dispose() }`;
  let lock: ReturnType<typeof spawn> | undefined;
  let exited: Promise<unknown> | undefined;
  try {
    f.commit(); const before = readFileSync(f.source);
    lock = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], { env: { ...process.env, EULER_TEST_SOURCE: f.source }, stdio: 'pipe', windowsHide: true });
    exited = new Promise((resolve, reject) => { lock!.once('close', resolve); lock!.once('error', reject); });
    const ready = await new Promise<string>((resolve, reject) => {
      lock!.stdout!.once('data', chunk => resolve(String(chunk).trim())); lock!.once('error', reject);
      lock!.once('close', () => reject(new Error('lock-process-exited-before-ready')));
    });
    assert.equal(ready, 'locked');
    assert.throws(() => f.store.cleanupPurgeSources(f.coordinator, f.owner), /EPERM|EACCES|EBUSY/);
    assert.deepEqual(readFileSync(f.source), before);
    lock.stdin!.end('\n'); await exited;
    assert.equal(f.store.cleanupPurgeSources(f.coordinator, f.owner).source.status, 'complete');
  } finally {
    if (lock && lock.exitCode === null && lock.signalCode === null) lock.kill();
    if (exited) await exited;
    f.close();
  }
});
