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

test('backup rejects a valid SQLite memory head whose typed lifecycle contradicts its replay',()=>{
  const sandbox=createSandbox();
  try {
    const seeded=cli(sandbox.root,'memory'); assert.equal(seeded.status,0,seeded.stdout+seeded.stderr);
    const recordId=seeded.events.find(event=>event.event==='memory-result').activated.record.recordId;
    const db=new DatabaseSync(join(sandbox.root,'probe.sqlite'));
    try {
      db.function('euler_store_writer',()=>1);
      assert.equal(db.prepare("UPDATE memory_heads SET lifecycle='tombstoned' WHERE record_id=?").run(recordId).changes,1);
      assert.equal(db.prepare('PRAGMA quick_check').get()!.quick_check,'ok');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    } finally {db.close();}
    const probe=openProbe(sandbox,undefined,undefined,undefined,undefined,true);
    try {assert.throws(()=>probe.store.readMemory(probe.activity,recordId),/memory-evidence-gap/);} finally {probe.close();}
    const backed=cli(sandbox.root,'backup'); assert.equal(backed.status,1);
    assert.equal(backed.events.find(event=>event.event==='error').reason,'memory-evidence-gap');
    const state=new DatabaseSync(join(sandbox.root,'probe.sqlite'),{readOnly:true});
    try {assert.equal(state.prepare("SELECT count(*) AS n FROM store_snapshots WHERE state='ready'").get()!.n,0);} finally {state.close();}
  } finally {rmSync(sandbox.root,{recursive:true,force:true});}
});

test('backup rejects an activation batch whose manifest cannot be read',()=>{
  const sandbox=createSandbox();
  try {
    const seeded=cli(sandbox.root,'memory'); assert.equal(seeded.status,0,seeded.stdout+seeded.stderr);
    const db=new DatabaseSync(join(sandbox.root,'probe.sqlite'));
    let batchId:string;
    try {
      batchId=String(db.prepare('SELECT batch_id FROM activation_batches LIMIT 1').get()!.batch_id);
      db.exec('DROP TRIGGER immutable_activation_batches_update');
      db.prepare("UPDATE activation_batches SET payload_hash='broken' WHERE batch_id=?").run(batchId);
    } finally {db.close();}
    const probe=openProbe(sandbox,undefined,undefined,undefined,undefined,true);
    try {assert.throws(()=>probe.store.readActivationBatch(probe.activity,batchId),/batch-evidence-gap/);} finally {probe.close();}
    const backed=cli(sandbox.root,'backup'); assert.equal(backed.status,1);
    assert.equal(backed.events.find(event=>event.event==='error').reason,'batch-evidence-gap');
  } finally {rmSync(sandbox.root,{recursive:true,force:true});}
});

test('store-wide checks preserve foreign project batches and session-scoped memory access',()=>{
  const sandbox=createSandbox();
  try {
    const binding={...bindingOf(sandbox),projectId:randomUUID(),sessionId:randomUUID(),branchId:randomUUID()}; createSandboxSession(sandbox,binding);
    const origin=openProbe(sandbox,undefined,undefined,binding,undefined,true);
    let recordId:string;
    try {
      const input=origin.archive.append(randomUUID(),'记住决定：本项目编译目标使用 ES2024');
      assert.equal(origin.store.rememberMemory(origin.activity,{input,hostInfo:'durable'}).status,'activated');
      const source=origin.archive.append(randomUUID(),'Synthetic session-only source.');
      recordId=origin.store.captureMemory(origin.activity,source,'Session-only fact.',{type:'fact',
        scope:{kind:'session',id:binding.sessionId,resolved:false},appliesTo:[]}).record.recordId;
    } finally {origin.close();}
    const other=openProbe(sandbox,undefined,undefined,undefined,undefined,true);
    try {
      assert.throws(()=>other.store.readMemory(other.activity,recordId),/invalid-memory-scope/);
      other.store.auditStore(other.activity);
    } finally {other.close();}
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
