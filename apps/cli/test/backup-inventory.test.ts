import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ProbeStore } from '@euler/core';
import { createSandbox, bindingOf, resourcesOf } from '../src/sandbox.ts';

function prepare(fail = false) {
  const sandbox = createSandbox();
  const result = spawnSync(process.execPath, fail
    ? ['apps/cli/test/support/backup-worker.ts', sandbox.root, 'backup-failure', 'ENOSPC']
    : ['apps/cli/src/main.ts', 'backup', '--sandbox', sandbox.root], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const db = new DatabaseSync(join(sandbox.root, 'probe.sqlite'), { readOnly: true });
  try { return { sandbox, id: String(db.prepare('SELECT snapshot_id FROM store_snapshots').get()!.snapshot_id) }; }
  finally { db.close(); }
}

test('maintenance can freeze and remove a failed backup without deleting canonical data', () => {
  const { sandbox, id } = prepare(true);
  const store = new ProbeStore(resourcesOf(sandbox), sandbox.storeId, bindingOf(sandbox));
  const coordinator = randomUUID();
  try {
    const source = readFileSync(join(sandbox.root, 'session.jsonl'));
    store.beginMaintenance(coordinator); assert.equal(store.acquireMaintenance(coordinator).acquired, true);
    const manifest = store.snapshotCleanupManifest(coordinator, id);
    assert.equal(manifest.snapshotId, id);
    store.discardSnapshot(coordinator, manifest);
    assert.equal(existsSync(manifest.directory.path), false);
    assert.deepEqual(readFileSync(join(sandbox.root, 'session.jsonl')), source);
    store.discardSnapshot(coordinator, manifest);
    store.releaseMaintenance(coordinator);
  } finally { store.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('deleted backup files with a lost acknowledgement resume without reapproval or reopening admission', () => {
  const { sandbox, id } = prepare();
  const store = new ProbeStore(resourcesOf(sandbox),sandbox.storeId,bindingOf(sandbox));
  const coordinator = randomUUID(), remove = fs.rmdirSync;
  try {
    store.beginMaintenance(coordinator); assert.equal(store.acquireMaintenance(coordinator).acquired,true);
    const manifest = store.snapshotCleanupManifest(coordinator,id);
    fs.rmdirSync = (...args) => { remove(...args); throw new Error('injected-after-directory-removal'); };
    syncBuiltinESMExports();
    try { assert.throws(() => store.discardSnapshot(coordinator,manifest), /injected-after-directory-removal/); }
    finally { fs.rmdirSync=remove; syncBuiltinESMExports(); }
    assert.throws(() => store.cancelMaintenance(coordinator), /snapshot-cleanup-in-progress/);
    store.discardSnapshot(coordinator,manifest);
    store.releaseMaintenance(coordinator);
    assert.equal(existsSync(manifest.directory.path),false);
  } finally { fs.rmdirSync=remove; syncBuiltinESMExports(); store.close(); rmSync(sandbox.root,{recursive:true,force:true}); }
});

test('snapshot deletion refuses a replaced directory and preserves its replacement', () => {
  const { sandbox, id } = prepare();
  const store = new ProbeStore(resourcesOf(sandbox), sandbox.storeId, bindingOf(sandbox));
  const coordinator = randomUUID();
  try {
    store.beginMaintenance(coordinator); assert.equal(store.acquireMaintenance(coordinator).acquired, true);
    const manifest = store.snapshotCleanupManifest(coordinator, id);
    renameSync(manifest.directory.path, manifest.directory.path + '-original');
    mkdirSync(manifest.directory.path); writeFileSync(join(manifest.directory.path, 'keep.txt'), 'replacement');
    assert.throws(() => store.discardSnapshot(coordinator, manifest), /file-identity-changed/);
    assert.equal(readFileSync(join(manifest.directory.path, 'keep.txt'), 'utf8'), 'replacement');
  } finally { store.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('maintenance can remove a preserved recovery original after freezing its exact files', () => {
  const { sandbox, id } = prepare();
  const restored = spawnSync(process.execPath, ['apps/cli/src/main.ts','restore-snapshot','--sandbox',sandbox.root,'--snapshot',id], { encoding: 'utf8' });
  assert.equal(restored.status, 0, restored.stderr);
  const receipt = restored.stdout.trim().split('\n').map(line => JSON.parse(line)).find(event => event.event === 'snapshot-restored');
  const store = new ProbeStore(resourcesOf(sandbox), sandbox.storeId, bindingOf(sandbox));
  const coordinator = randomUUID();
  try {
    store.beginMaintenance(coordinator); assert.equal(store.acquireMaintenance(coordinator).acquired, true);
    const manifest = store.recoveryCleanupManifest(coordinator, receipt.receipt.operationId);
    store.discardRecoveryOriginal(coordinator, manifest);
    assert.equal(existsSync(receipt.original.path), false);
    assert.ok(existsSync(join(sandbox.root, 'session.jsonl')));
    assert.ok(existsSync(join(sandbox.root, `backup-${id}`, 'store.sqlite')));
    store.releaseMaintenance(coordinator);
  } finally { store.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('an unexplained file inside a registered backup remains a maintenance blocker', () => {
  const { sandbox, id } = prepare();
  writeFileSync(join(sandbox.root, `backup-${id}`, 'unexpected.txt'), 'unregistered');
  const store = new ProbeStore(resourcesOf(sandbox), sandbox.storeId, bindingOf(sandbox));
  const coordinator = randomUUID();
  try {
    store.beginMaintenance(coordinator);
    assert.equal(store.acquireMaintenance(coordinator).acquired, false);
    assert.equal(readFileSync(join(sandbox.root, `backup-${id}`, 'unexpected.txt'), 'utf8'), 'unregistered');
  } finally { store.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
