import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CliArchive } from '../src/archive.ts';
import test from 'node:test';
import { openMaintenanceStore } from '../src/backup.ts';
import { OwnerInfoLog } from '../src/owner-memory.ts';
import { readPurgeCarriers } from '../src/purge.ts';
import { CountingTransport } from '../src/probe.ts';
import { createSandbox } from '../src/sandbox.ts';

function setup(receiver: boolean | 'unidentified' = false, backup = false) {
  const sandbox = createSandbox();
  const seeded = spawnSync(process.execPath, ['apps/cli/test/support/purge-worker.ts', sandbox.root], { encoding: 'utf8' });
  assert.equal(seeded.status, 0, seeded.stderr);
  const fixture = JSON.parse(seeded.stdout.trim().split('\n').at(-1)!);
  if (receiver) {
    const transport = new CountingTransport(sandbox);
    if (receiver === 'unidentified') {
      transport.send('unrelated before'); transport.send(fixture.target.content);
      transport.send('unrelated between'); transport.send(fixture.target.content);
    } else transport.send(fixture.target.content, { attemptId: randomUUID(), runId: randomUUID(),
      payloadHash: fixture.target.contentHash, byteLength: Buffer.byteLength(fixture.target.content) });
    transport.send('unrelated synthetic receiver record');
  }
  if (backup) {
    const saved = spawnSync(process.execPath, ['apps/cli/src/main.ts', 'backup', '--sandbox', sandbox.root], { encoding: 'utf8' });
    assert.equal(saved.status, 0, saved.stderr);
  }
  const store = openMaintenanceStore(sandbox), coordinator = randomUUID();
  store.beginMaintenance(coordinator);
  assert.equal(store.acquireMaintenance(coordinator).acquired, true);
  const carriers = readPurgeCarriers(sandbox, store, coordinator);
  const preview = store.previewPurge(coordinator, fixture.recordId, carriers);
  store.acknowledgePurgePresentation(coordinator, preview.token, preview.digest);
  store.commitPurge(coordinator, store.receivePurgeInput(coordinator, preview.phrase), preview.token, carriers);
  return { sandbox, fixture, store, coordinator, preview,
    close: () => { store.close(); rmSync(sandbox.root, { recursive: true, force: true }); } };
}

test('the Info owner erases only the approved card and can reconcile deletion before acknowledgement', () => {
  const f = setup();
  try {
    const log = new OwnerInfoLog(f.sandbox, action => action(), () => {});
    const selection = f.preview.manifest.carriers.find(carrier => carrier.role === 'owner-info')!;
    const unaffected = log.entries().filter(entry => !selection.entries.some(item => item.id === entry.record.entryId));
    assert.equal(unaffected.length, 1);
    const plan = log.preparePurge(selection);
    const ack = log.purge(selection, plan);
    assert.deepEqual(log.purge(selection, plan), ack);
    assert.deepEqual(log.entries(), unaffected);
    const bytes = readFileSync(join(f.sandbox.root, 'owner-info.jsonl'));
    assert.equal(bytes.includes(Buffer.from(f.fixture.recordId)), false);
    assert.equal(bytes.includes(Buffer.from(f.fixture.target.content)), false);
  } finally { f.close(); }
});

test('Core settles Info and receiver owners from actual bytes and preserves unrelated entries', () => {
  const f = setup(true);
  try {
    const info = new OwnerInfoLog(f.sandbox, action => action(), () => {});
    const receiver = new CountingTransport(f.sandbox);
    const result = f.store.cleanupPurgeHost(f.coordinator, { info, receiver });
    assert.equal(result.host.status, 'complete');
    assert.equal(result.cleanup, 'incomplete');
    assert.equal(receiver.inspect().count, 1);
    assert.equal(info.entries().length, 1);
    assert.equal(readFileSync(join(f.sandbox.root, 'counting-receiver.jsonl')).includes(Buffer.from(f.fixture.target.contentHash)), false);
    assert.deepEqual(f.store.cleanupPurgeHost(f.coordinator, { info, receiver }), result);
    assert.equal(f.store.fence().state, 'cleaning');
  } finally { f.close(); }
});

test('receiver cleanup preserves ordinal identities across multiple selected records without attempt IDs', () => {
  const f = setup('unidentified');
  try {
    const info = new OwnerInfoLog(f.sandbox, action => action(), () => {}), receiver = new CountingTransport(f.sandbox);
    const selected = f.preview.manifest.carriers.find(carrier => carrier.role === 'receiver')!;
    assert.deepEqual(selected.entries.map(entry => entry.id), ['1', '3']);
    const result = f.store.cleanupPurgeHost(f.coordinator, { info, receiver });
    assert.equal(result.host.status, 'complete');
    assert.equal(receiver.inspect().count, 3);
    assert.equal(readFileSync(selected.file.path).includes(Buffer.from(f.fixture.target.contentHash)), false);
    assert.deepEqual(f.store.cleanupPurgeHost(f.coordinator, { info, receiver }), result);
  } finally { f.close(); }
});

test('Core deletes the committed backup manifest through its snapshot owner and repeats without reopening admission', () => {
  const f = setup(false, true);
  try {
    assert.equal(f.preview.manifest.backups.length, 1);
    const result = f.store.cleanupPurgeBackups(f.coordinator);
    assert.equal(result.backup.status, 'complete');
    for (const backup of f.preview.manifest.backups) assert.equal(existsSync(backup.directory.path), false);
    assert.deepEqual(f.store.cleanupPurgeBackups(f.coordinator), result);
    assert.equal(result.cleanup, 'incomplete');
    assert.equal(f.store.fence().state, 'cleaning');
  } finally { f.close(); }
});

for (const role of ['owner-info', 'receiver', 'backup'] as const) for (const fault of role === 'backup' ? ['identity'] : ['identity', 'readonly'])
test(`${role} cleanup rejects ${fault} changes and resumes after the approved resource is restored`, {
  skip: fault === 'readonly' && process.getuid?.() === 0 ? 'root bypasses ordinary file mode permissions' : false,
}, () => {
  const f = setup(true, true), saved = f.sandbox.root + '-saved';
  const info = new OwnerInfoLog(f.sandbox, action => action(), () => {}), receiver = new CountingTransport(f.sandbox);
  const path = role === 'backup' ? f.preview.manifest.backups[0]!.files[0]!.file.path
    : f.preview.manifest.carriers.find(carrier => carrier.role === role)!.file.path;
  const before = readFileSync(path);
  const cleanup = () => role === 'backup' ? f.store.cleanupPurgeBackups(f.coordinator) : f.store.cleanupPurgeHost(f.coordinator, { info, receiver });
  try {
    if (fault === 'identity') { renameSync(path, saved); writeFileSync(path, before); }
    else chmodSync(path, 0o444);
    assert.throws(cleanup, /maintenance-residuals-or-participants|file-identity|EPERM|EACCES|EBUSY/);
    assert.deepEqual(readFileSync(path), before);
    assert.equal(f.store.purgeStatus(f.coordinator)!.cleanup, 'incomplete');
    if (fault === 'identity') { rmSync(path); renameSync(saved, path); }
    else chmodSync(path, 0o600);
    const result = cleanup();
    assert.equal(role === 'backup' ? result.backup.status : result.host.status, 'complete');
  } finally {
    if (existsSync(path)) chmodSync(path, 0o600);
    f.close(); rmSync(saved, { force: true });
  }
});

test('a Windows backup sharing lock prevents deletion until the actual handle is released', { skip: process.platform !== 'win32' }, async () => {
  const f = setup(false, true), path = f.preview.manifest.backups[0]!.files[0]!.file.path, before = readFileSync(path);
  const command = `$f=[System.IO.File]::Open($env:EULER_TEST_LOCK,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::Read); try { [Console]::WriteLine('locked'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null } finally { $f.Dispose() }`;
  const lock = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], {
    env: { ...process.env, EULER_TEST_LOCK: path }, stdio: 'pipe', windowsHide: true,
  });
  const exited = new Promise((resolve, reject) => { lock.once('close', resolve); lock.once('error', reject); });
  try {
    const ready = await new Promise<string>((resolve, reject) => {
      lock.stdout.once('data', chunk => resolve(String(chunk).trim())); lock.once('error', reject);
      lock.once('close', () => reject(new Error('lock-process-exited-before-ready')));
    });
    assert.equal(ready, 'locked');
    assert.throws(() => f.store.cleanupPurgeBackups(f.coordinator), /EPERM|EACCES|EBUSY/);
    assert.deepEqual(readFileSync(path), before);
    lock.stdin.end('\n'); await exited;
    assert.equal(f.store.cleanupPurgeBackups(f.coordinator).backup.status, 'complete');
  } finally {
    if (lock.exitCode === null && lock.signalCode === null) lock.kill();
    await exited; f.close();
  }
});

test('completion scrubs sensitive progress before vacuum, preserves both receipts and reopens only the new epoch', () => {
  const f = setup(true, true), db = new DatabaseSync(join(f.sandbox.root, 'probe.sqlite'));
  try {
    assert.throws(() => f.store.preparePurgeMaintenance(f.coordinator), /purge-cleanup-incomplete/);
    f.store.cleanupPurgeSources(f.coordinator, (binding, source) => new CliArchive({ ...f.sandbox,
      sourceName: basename(source.path), archiveIdentity: source.identity, fixture: { ...f.sandbox.fixture, ...binding } }, action => action()));
    f.store.cleanupPurgeHost(f.coordinator, { info: new OwnerInfoLog(f.sandbox, action => action(), () => {}), receiver: new CountingTransport(f.sandbox) });
    f.store.cleanupPurgeBackups(f.coordinator);
    const beforeEpoch = f.store.fence().epoch;
    assert.equal(f.store.preparePurgeMaintenance(f.coordinator).phase, 'sqlite-maintenance');
    const progress = db.prepare("SELECT * FROM pending_operations WHERE kind='purge'").get()!;
    assert.equal(progress.presentation_hash, null);
    for (const value of [f.preview.digest, f.fixture.target.source.locator, f.fixture.target.contentHash]) {
      assert.equal(JSON.stringify(progress).includes(value), false);
    }
    assert.equal(f.store.fence().state, 'cleaning');
    const unknown = join(f.sandbox.root, f.fixture.target.contentHash + '.txt');
    writeFileSync(unknown, f.fixture.target.content);
    assert.throws(() => f.store.completePurge(f.coordinator, f.preview.operationId), /maintenance-residuals-or-participants/);
    assert.equal(f.store.purgeCompletion(f.preview.operationId), null);
    rmSync(unknown);
    db.exec('BEGIN'); db.prepare('SELECT count(*) FROM memory_records').get();
    assert.throws(() => f.store.completePurge(f.coordinator, f.preview.operationId), /purge-checkpoint-incomplete|database is locked/);
    assert.equal(f.store.purgeCompletion(f.preview.operationId), null);
    db.exec('ROLLBACK');
    const complete = f.store.completePurge(f.coordinator, f.preview.operationId);
    assert.equal(complete.status, 'controlled-complete');
    assert.equal(f.store.fence().state, 'open');
    assert.equal(f.store.fence().epoch, beforeEpoch + 1);
    assert.deepEqual(f.store.completePurge(f.coordinator, f.preview.operationId), complete);
    assert.deepEqual(f.store.purgeCompletion(f.preview.operationId), complete);
    assert.equal(db.prepare('PRAGMA freelist_count').get()!.freelist_count, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM memory_events WHERE kind IN ('purge-logical-commit','purge-controlled-complete')").get()!.n, 2);
    assert.equal(db.prepare("SELECT continuation FROM pending_operations WHERE kind='purge'").get()!.continuation, null);
    for (const name of readdirSync(f.sandbox.root)) {
      const bytes = readFileSync(join(f.sandbox.root, name));
      for (const canary of [f.fixture.target.content, f.fixture.target.contentHash, f.fixture.target.source.locator, f.preview.digest]) {
        assert.equal(bytes.includes(Buffer.from(canary)), false, `${name}: ${canary}`);
      }
    }
  } finally { db.close(); f.close(); }
});
