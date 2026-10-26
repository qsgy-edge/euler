import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProbeStore } from '@euler/core';
import { createSandbox, resourcesOf, bindingOf } from '../src/sandbox.ts';

for (const when of ['before','after']) test(`a project output created ${when} the snapshot stays owned after recovery and original cleanup`, { skip: process.platform !== 'win32' }, () => {
  const sandbox = createSandbox(), root = realpathSync.native(mkdtempSync(join(tmpdir(),'euler-t20-output-')));
  const cli = (command: string,...args: string[]) => {
    const result = spawnSync(process.execPath,['apps/cli/src/main.ts',command,'--sandbox',sandbox.root,...args],{encoding:'utf8'});
    assert.equal(result.status,0,result.stdout+result.stderr);
    return result.stdout.trim().split('\n').map(line=>JSON.parse(line));
  };
  const createOutput = () => {
    const writer = spawnSync(process.execPath,['apps/cli/test/support/backup-file-worker.ts',sandbox.root,root],{encoding:'utf8'});
    assert.equal(writer.status,0,writer.stdout+writer.stderr);
    return JSON.parse(writer.stdout).controlledFiles[0];
  };
  try {
    let original;
    if (when === 'before') original = createOutput();
    const saved = cli('backup').find(event=>event.event==='backup-result').snapshot;
    if (when === 'after') original = createOutput();
    else writeFileSync(join(root,'result.md'),'later modified bytes in the same physical file');
    assert.equal(saved.files.filter((file: {role:string})=>file.role==='project-output').length,when==='before'?1:0);
    const restored = cli('restore-snapshot','--snapshot',saved.id).find(event=>event.event==='snapshot-restored');
    const store = new ProbeStore(resourcesOf(sandbox),sandbox.storeId,bindingOf(sandbox));
    try {
      assert.deepEqual(store.maintenanceStatus().controlledFiles,[original]);
      const coordinator = randomUUID(); store.beginMaintenance(coordinator); assert.equal(store.acquireMaintenance(coordinator).acquired,true);
      store.discardRecoveryOriginal(coordinator,store.recoveryCleanupManifest(coordinator,restored.receipt.operationId));
      assert.deepEqual(store.maintenanceStatus().controlledFiles,[original]);
      store.releaseMaintenance(coordinator);
    } finally { store.close(); }
    assert.equal(readFileSync(join(root,'result.md'),'utf8'),'EULER-T20 controlled project output');
    const migration = spawnSync(process.execPath,['apps/cli/test/support/backup-worker.ts',sandbox.root,'migration-checkpoint'],{encoding:'utf8'});
    assert.equal(migration.status,0,migration.stdout+migration.stderr);
    const checkpoint = JSON.parse(migration.stdout).snapshot;
    assert.equal(checkpoint.files.filter((file: {role:string})=>file.role==='project-output').length,1);
  } finally { rmSync(sandbox.root,{recursive:true,force:true}); rmSync(root,{recursive:true,force:true}); }
});
