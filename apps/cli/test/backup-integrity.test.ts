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

test('backup rejects provenance that forget cannot read',()=>{
  const sandbox=createSandbox();
  try {
    const seeded=cli(sandbox.root,'memory'); assert.equal(seeded.status,0,seeded.stdout+seeded.stderr);
    const record=seeded.events.find(event=>event.event==='memory-result').activated.record;
    const db=new DatabaseSync(join(sandbox.root,'probe.sqlite'));
    try {
      db.exec('DROP TRIGGER immutable_provenance_refs_update');
      assert.ok(Number(db.prepare("UPDATE provenance_refs SET payload_hash='broken' WHERE record_id=?").run(record.recordId).changes)>0);
      assert.equal(db.prepare('PRAGMA quick_check').get()!.quick_check,'ok');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    } finally {db.close();}
    const probe=openProbe(sandbox,undefined,undefined,undefined,undefined,true);
    try {assert.throws(()=>probe.store.forgetMemory(probe.activity,record.recordId,record),/memory-evidence-gap/);} finally {probe.close();}
    const backed=cli(sandbox.root,'backup'); assert.equal(backed.status,1);
    assert.equal(backed.events.find(event=>event.event==='error').reason,'memory-evidence-gap');
  } finally {rmSync(sandbox.root,{recursive:true,force:true});}
});

for (const fault of ['identity','source']) test(`backup rejects corrupt provenance ${fault}`,()=>{
  const sandbox=createSandbox();
  try {
    const seeded=cli(sandbox.root,'memory'); assert.equal(seeded.status,0,seeded.stdout+seeded.stderr);
    const db=new DatabaseSync(join(sandbox.root,'probe.sqlite'));
    try {
      db.exec('DROP TRIGGER immutable_provenance_refs_update');
      const row=db.prepare('SELECT * FROM provenance_refs LIMIT 1').get()!;
      if(fault==='identity') db.prepare('UPDATE provenance_refs SET owner_id=? WHERE ref_id=?').run(randomUUID(),row.ref_id!);
      else {
        const source={...JSON.parse(String(row.source_json)),contentHash:'0'.repeat(64)};
        const payload=JSON.stringify({...JSON.parse(String(row.payload)),source});
        db.prepare('UPDATE provenance_refs SET source_json=?,content_hash=?,payload=?,payload_hash=? WHERE ref_id=?')
          .run(JSON.stringify(source),source.contentHash,payload,sha256(payload),row.ref_id!);
      }
      assert.equal(db.prepare('PRAGMA quick_check').get()!.quick_check,'ok');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    } finally {db.close();}
    const backed=cli(sandbox.root,'backup'); assert.equal(backed.status,1);
    assert.equal(backed.events.find(event=>event.event==='error').reason,fault==='identity'?'memory-evidence-gap':'source-evidence-gap');
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

test('backup rejects an Intent whose typed status disagrees with its archived snapshot',()=>{
  const sandbox=createSandbox();
  try {
    const seeded=cli(sandbox.root,'run'); assert.equal(seeded.status,0,seeded.stdout+seeded.stderr);
    const db=new DatabaseSync(join(sandbox.root,'probe.sqlite'));
    try {
      db.exec('DROP TRIGGER immutable_intent_update');
      assert.equal(db.prepare("UPDATE intent_events SET status='paused' WHERE event_id IN (SELECT event_id FROM intent_heads)").run().changes,1);
    } finally {db.close();}
    const probe=openProbe(sandbox,undefined,undefined,undefined,undefined,true);
    try {assert.throws(()=>probe.store.readIntent(probe.activity),/intent-evidence-gap/);} finally {probe.close();}
    const backed=cli(sandbox.root,'backup'); assert.equal(backed.status,1);
    assert.equal(backed.events.find(event=>event.event==='error').reason,'intent-evidence-gap');
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

for (const fault of ['digest','events','event','owner','scope','missing']) test(`backup rejects a corrupt unregistered Info outbox: ${fault}`,()=>{
  const sandbox=createSandbox();
  try {
    const seeded=cli(sandbox.root,'memory'); assert.equal(seeded.status,0,seeded.stdout+seeded.stderr);
    const db=new DatabaseSync(join(sandbox.root,'probe.sqlite'));
    try {
      db.exec('DROP TRIGGER immutable_projection_jobs_update');
      const job=db.prepare("SELECT * FROM projection_jobs WHERE kind='host-info' LIMIT 1").get()!;
      if(fault==='digest') db.prepare("UPDATE projection_jobs SET payload_hash='broken' WHERE job_id=?").run(job.job_id!);
      else if(fault==='events') {
        const payload=JSON.stringify({...JSON.parse(String(job.payload)),events:[]});
        db.prepare('UPDATE projection_jobs SET payload=?,payload_hash=? WHERE job_id=?').run(payload,sha256(payload),job.job_id!);
      } else if(fault==='event') {
        const event=db.prepare("SELECT event_id FROM memory_events WHERE batch_id IS NULL LIMIT 1").get()!;
        db.prepare('UPDATE projection_jobs SET event_id=? WHERE job_id=?').run(event.event_id!,job.job_id!);
      } else if(fault==='missing') {
        db.exec('DROP TRIGGER immutable_projection_jobs_delete');
        db.prepare('DELETE FROM projection_jobs WHERE job_id=?').run(job.job_id!);
      } else db.prepare(`UPDATE projection_jobs SET ${fault==='owner'?'owner_id':'scope_id'}=? WHERE job_id=?`).run(randomUUID(),job.job_id!);
    } finally {db.close();}
    const probe=openProbe(sandbox,undefined,undefined,undefined,undefined,true);
    try {
      if(['digest','events','event'].includes(fault)) assert.throws(()=>probe.store.registerHostInfo(probe.activity),/outbox-evidence-gap/);
      else assert.deepEqual(probe.store.registerHostInfo(probe.activity).pending,[]);
    } finally {probe.close();}
    const backed=cli(sandbox.root,'backup'); assert.equal(backed.status,1);
    assert.equal(backed.events.find(event=>event.event==='error').reason,'outbox-evidence-gap');
  } finally {rmSync(sandbox.root,{recursive:true,force:true});}
});

test('backup rejects Info metadata that disagrees with its frozen activation batch',()=>{
  const sandbox=createSandbox();
  try {
    const seeded=runBackupCli(sandbox.root,'remember',[],'记住偏好：使用独立目录\nstop\n');
    assert.equal(seeded.status,0,seeded.stdout+seeded.stderr);
    const batchId=seeded.events.find(event=>event.event==='remember-result' && event.status==='activated').batchId;
    const db=new DatabaseSync(join(sandbox.root,'probe.sqlite'));
    try {
      db.function('euler_store_writer',()=>1);
      db.exec('DROP TRIGGER guarded_host_info_update');
      db.prepare('UPDATE host_info_batches SET member_count=member_count+1 WHERE batch_id=?').run(batchId);
    } finally {db.close();}
    const probe=openProbe(sandbox,undefined,undefined,undefined,undefined,true);
    try {assert.throws(()=>probe.store.readHostInfo(probe.activity,batchId),/host-info-evidence-gap/);} finally {probe.close();}
    const backed=cli(sandbox.root,'backup'); assert.equal(backed.status,1);
    assert.equal(backed.events.find(event=>event.event==='error').reason,'host-info-evidence-gap');
  } finally {rmSync(sandbox.root,{recursive:true,force:true});}
});

test('backup rejects capture metadata that its owner can no longer read',()=>{
  const sandbox=createSandbox();
  try {
    const seeded=cli(sandbox.root,'memory'); assert.equal(seeded.status,0,seeded.stdout+seeded.stderr);
    const db=new DatabaseSync(join(sandbox.root,'probe.sqlite'));
    let jobId:string;
    try {
      jobId=String(db.prepare('SELECT job_id FROM capture_jobs LIMIT 1').get()!.job_id);
      db.exec('DROP TRIGGER immutable_capture_jobs_update');
      db.prepare("UPDATE capture_jobs SET payload_hash='broken' WHERE job_id=?").run(jobId);
    } finally {db.close();}
    const probe=openProbe(sandbox,undefined,undefined,undefined,undefined,true);
    try {assert.throws(()=>probe.store.readCaptureJob(probe.activity,jobId),/capture-evidence-gap/);} finally {probe.close();}
    const backed=cli(sandbox.root,'backup'); assert.equal(backed.status,1);
    assert.equal(backed.events.find(event=>event.event==='error').reason,'capture-evidence-gap');
  } finally {rmSync(sandbox.root,{recursive:true,force:true});}
});

test('backup rejects feedback whose receipt cannot be read',()=>{
  const sandbox=createSandbox();
  try {
    const seeded=cli(sandbox.root,'memory'); assert.equal(seeded.status,0,seeded.stdout+seeded.stderr);
    const record=seeded.events.find(event=>event.event==='memory-result').activated.record;
    const writer=openProbe(sandbox,undefined,undefined,undefined,undefined,true);
    try {
      const input=writer.archive.append(randomUUID(),JSON.stringify({schema:'memory-feedback@1',kind:'user_helpful',
        recordId:record.recordId,revisionId:record.revisionId,headEventId:record.headEventId}));
      assert.equal(writer.store.recordMemoryFeedback(writer.activity,record.recordId,record,input).status,'recorded');
    } finally {writer.close();}
    const db=new DatabaseSync(join(sandbox.root,'probe.sqlite'));
    try {
      db.exec('DROP TRIGGER immutable_feedback_events_update');
      assert.equal(db.prepare("UPDATE feedback_events SET payload_hash='broken' WHERE kind='user_helpful'").run().changes,1);
    } finally {db.close();}
    const probe=openProbe(sandbox,undefined,undefined,undefined,undefined,true);
    try {assert.throws(()=>probe.store.readMemoryFeedback(probe.activity,record.recordId),/feedback-evidence-gap/);} finally {probe.close();}
    const backed=cli(sandbox.root,'backup'); assert.equal(backed.status,1);
    assert.equal(backed.events.find(event=>event.event==='error').reason,'feedback-evidence-gap');
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
      assert.equal(origin.store.registerHostInfo(origin.activity).pending.length,1);
      const intent=origin.store.transitionIntent(origin.activity,null,input,{step:'capture',status:'active'},'记住决定：本项目编译目标使用 ES2024');
      const done=origin.archive.append(randomUUID(),'Complete the other project task.');
      origin.store.transitionIntent(origin.activity,intent.eventId,done,{step:'complete',status:'completed'});
      const source=origin.archive.append(randomUUID(),'Synthetic session-only source.');
      recordId=origin.store.captureMemory(origin.activity,source,'Session-only fact.',{type:'fact',
        scope:{kind:'session',id:binding.sessionId,resolved:false},appliesTo:[]}).record.recordId;
    } finally {origin.close();}
    const other=openProbe(sandbox,undefined,undefined,undefined,undefined,true);
    try {
      assert.throws(()=>other.store.readMemory(other.activity,recordId),/invalid-memory-scope/);
      assert.equal(other.store.readIntent(other.activity),null);
      assert.equal(other.store.recoverIntent(other.activity),null);
      assert.deepEqual(other.store.registerHostInfo(other.activity).pending,[]);
      assert.deepEqual(other.store.pendingMemoryProjections(other.activity),[]);
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
