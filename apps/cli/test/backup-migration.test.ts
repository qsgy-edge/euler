import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ProbeStore } from '@euler/core';
import { createSandbox, resourcesOf, bindingOf } from '../src/sandbox.ts';

for (const point of ['success', 'before-commit', 'after-commit']) test(`a disposable forward migration has a verified recovery point at ${point}`, () => {
  const sandbox = createSandbox(), copies = mkdtempSync(join(tmpdir(), 'euler-t20-migration-'));
  try {
    const setup = spawnSync(process.execPath, ['apps/cli/src/main.ts', 'run', '--sandbox', sandbox.root], { encoding: 'utf8' });
    assert.equal(setup.status, 0, setup.stderr);
    const backup = spawnSync(process.execPath, ['apps/cli/test/support/backup-worker.ts', sandbox.root, 'migration-checkpoint'], { encoding: 'utf8' });
    assert.equal(backup.status, 0, backup.stderr);
    const saved = JSON.parse(backup.stdout).snapshot;
    assert.equal(saved.kind, 'migration');
    const source = readFileSync(join(saved.directory.path, 'store.sqlite'));
    const candidate = join(copies, 'candidate.sqlite'); copyFileSync(join(saved.directory.path, 'store.sqlite'), candidate);
    const migration = spawnSync(process.execPath, ['apps/cli/test/support/backup-migration-worker.ts', candidate, point], { encoding: 'utf8' });
    assert.equal(migration.error, undefined); assert.doesNotMatch(migration.stderr, /Error:|ERR_/);
    if (point === 'success') assert.equal(migration.status, 0); else assert.ok(migration.signal === 'SIGKILL' || migration.status !== 0);
    const db = new DatabaseSync(candidate);
    try {
      assert.equal(db.prepare('PRAGMA quick_check').get()!.quick_check, 'ok');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      const version = point === 'before-commit' ? 26 : 27;
      assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,version);
      const metadata = db.prepare('SELECT schema_version,ddl_hash FROM schema_meta').get()!;
      assert.equal(metadata.schema_version,version);
      assert.ok(String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='schema_meta'").get()!.sql).includes(`CHECK(schema_version=${version})`));
      if (version === 27) {
        const schema = db.prepare('SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name').all();
        assert.equal(metadata.ddl_hash,createHash('sha256').update(JSON.stringify(schema)).digest('hex'));
      }
      assert.equal(Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='synthetic_migration_probe'").get()), point !== 'before-commit');
      assert.equal(db.prepare('SELECT count(*) AS n FROM request_attempts').get()!.n, 1);
    } finally { db.close(); }
    assert.deepEqual(readFileSync(join(saved.directory.path, 'store.sqlite')), source);
    const store = new ProbeStore(resourcesOf(sandbox), sandbox.storeId, bindingOf(sandbox));
    try {
      const coordinator = randomUUID(); store.beginMaintenance(coordinator); assert.equal(store.acquireMaintenance(coordinator).acquired, true);
      store.discardSnapshot(coordinator, store.snapshotCleanupManifest(coordinator, saved.id)); store.releaseMaintenance(coordinator);
    } finally { store.close(); }
  } finally { rmSync(sandbox.root, { recursive: true, force: true }); rmSync(copies, { recursive: true, force: true }); }
});
