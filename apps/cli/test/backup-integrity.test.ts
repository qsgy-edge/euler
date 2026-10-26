import assert from 'node:assert/strict';
import { runBackupCli } from './support/backup-cli.ts';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { sha256 } from '@euler/core';
import { createSandbox,createSandboxSession,bindingOf } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

function cli(root: string,command: string) {
  return runBackupCli(root,command,command==='handoff'?['--scenario','synthetic']:[]);
}
for (const lane of ['memory','source']) test(`a failed backup permits ${lane} projection repair without losing canonical history`,()=>{
  const sandbox=createSandbox();
  try {
    const seeded=cli(sandbox.root,lane==='memory'?'memory':'handoff'); assert.equal(seeded.status,0,seeded.stdout+seeded.stderr);
    const setup=openProbe(sandbox,undefined,undefined,undefined,undefined,true);
    try { if(lane==='memory') setup.store.rebuildSearchProjection(setup.activity); else setup.store.rebuildSourceProjection(setup.activity); } finally {setup.close();}
    const db=new DatabaseSync(join(sandbox.root,'probe.sqlite'));
    try {
      db.function('euler_store_writer',()=>1); db.exec('PRAGMA ignore_check_constraints=ON');
      assert.ok(Number(db.prepare('UPDATE search_documents SET projection_generation=0').run().changes)>0);
    } finally {db.close();}
    assert.equal(cli(sandbox.root,'backup').status,1);
    const probe=openProbe(sandbox,undefined,undefined,undefined,undefined,true);
    try {
      const appended=probe.archive.append(randomUUID(),'A projection fault must not stop canonical source writes.');
      assert.equal(appended.status,'durable');
      assert.equal(probe.store.fence().health,'healthy');
      if(lane==='memory') probe.store.rebuildSearchProjection(probe.activity); else probe.store.rebuildSourceProjection(probe.activity);
      assert.equal(probe.store.fence().health,'healthy');
      assert.equal(probe.store.withActivity(probe.activity,()=>true),true);
    } finally {probe.close();}
    const backed=cli(sandbox.root,'backup'); assert.equal(backed.status,0,backed.stdout+backed.stderr);
  } finally {rmSync(sandbox.root,{recursive:true,force:true});}
});

test('projection repair cannot reopen a store whose canonical ledger is still damaged',()=>{
  const sandbox=createSandbox();
  try {
    assert.equal(cli(sandbox.root,'run').status,0); assert.equal(cli(sandbox.root,'memory').status,0);
    const db=new DatabaseSync(join(sandbox.root,'probe.sqlite'));
    try {db.exec("DROP TRIGGER immutable_request_events_update; UPDATE request_events SET hash='broken' WHERE seq=1");} finally {db.close();}
    assert.equal(cli(sandbox.root,'backup').status,1);
    const probe=openProbe(sandbox,undefined,undefined,undefined,undefined,true);
    try {
      assert.throws(()=>probe.store.rebuildSearchProjection(probe.activity),/ledger-evidence-gap|store-integrity-failed/);
      assert.equal(probe.store.fence().health,'failed');
      assert.throws(()=>probe.store.withActivity(probe.activity,()=>true),/store-integrity-failed/);
    } finally {probe.close();}
  } finally {rmSync(sandbox.root,{recursive:true,force:true});}
});

for (const field of ['publication-hash','raw-range-hash','publication-stage']) test(`backup rejects a corrupt Historian ${field} before publication`,()=>{
  const sandbox=createSandbox();
  try {
    const created=cli(sandbox.root,'historian'); assert.equal(created.status,0,created.stdout+created.stderr);
    const db=new DatabaseSync(join(sandbox.root,'probe.sqlite'));
    try {
      if(field==='publication-hash') db.exec("DROP TRIGGER immutable_compartments_update; UPDATE compartments SET hash='broken'");
      else if(field==='publication-stage') {
        db.function('euler_store_writer',()=>1);
        db.exec("UPDATE capture_work SET stage='pending' WHERE job_id IN (SELECT job_id FROM compartments)");
      } else {
        db.exec('DROP TRIGGER immutable_capture_jobs_update');
        const row=db.prepare('SELECT j.job_id,j.payload FROM capture_jobs j JOIN compartments c ON c.job_id=j.job_id').get()!;
        const payload=JSON.stringify({...JSON.parse(String(row.payload)),rawHash:'broken'});
        db.prepare('UPDATE capture_jobs SET payload=?,payload_hash=? WHERE job_id=?').run(payload,sha256(payload),row.job_id!);
      }
    } finally {db.close();}
    const backed=cli(sandbox.root,'backup'); assert.equal(backed.status,1);
    assert.match(backed.events.find(event=>event.event==='error').reason,/compartment-integrity|historian-source-gap/);
    const inspected=new DatabaseSync(join(sandbox.root,'probe.sqlite'),{readOnly:true});
    try {assert.equal(inspected.prepare("SELECT count(*) AS n FROM store_snapshots WHERE state='ready'").get()!.n,0);} finally {inspected.close();}
  } finally {rmSync(sandbox.root,{recursive:true,force:true});}
});

for (const table of ['source_units','evolution_proposals']) test(`backup rejects corrupt ${table} owner metadata`,()=>{
  const sandbox=createSandbox();
  try {
    const created=cli(sandbox.root,table==='source_units'?'handoff':'memory'); assert.equal(created.status,0,created.stdout+created.stderr);
    const db=new DatabaseSync(join(sandbox.root,'probe.sqlite'));
    try {
      db.exec(`DROP TRIGGER immutable_${table}_update`);
      assert.ok(Number(db.prepare(`UPDATE ${table} SET payload_hash='broken'`).run().changes)>0);
    } finally {db.close();}
    const backed=cli(sandbox.root,'backup'); assert.equal(backed.status,1);
    assert.match(backed.events.find(event=>event.event==='error').reason,/source-evidence-gap|proposal-evidence-gap/);
  } finally {rmSync(sandbox.root,{recursive:true,force:true});}
});

test('store audit verifies a valid Historian publication from another registered session',()=>{
  const sandbox=createSandbox();
  try {
    const created=cli(sandbox.root,'historian'); assert.equal(created.status,0,created.stdout+created.stderr);
    const binding={...bindingOf(sandbox),sessionId:randomUUID(),branchId:randomUUID()}; createSandboxSession(sandbox,binding);
    const probe=openProbe(sandbox,undefined,undefined,binding,undefined,true);
    try {probe.store.auditStore(probe.activity);} finally {probe.close();}
  } finally {rmSync(sandbox.root,{recursive:true,force:true});}
});
