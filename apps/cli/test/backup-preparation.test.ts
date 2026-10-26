import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync,readFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createSandbox } from '../src/sandbox.ts';
import { runBackupCli } from './support/backup-cli.ts';

for(const point of ['directory','preparation','ENOSPC','EROFS']) for(const action of ['resume','discard'])
test(`recovery interrupted at ${point} permits ${action} through registered maintenance`,()=>{
  const sandbox=createSandbox();
  const cli=(command:string,...args:string[])=>{
    const result=runBackupCli(sandbox.root,command,args);
    assert.equal(result.status,0,result.stdout+result.stderr); return result.events;
  };
  try {
    cli('run'); const saved=cli('backup').find(event=>event.event==='backup-result').snapshot;
    const original=readFileSync(join(sandbox.root,'session.jsonl'));
    const failure=['ENOSPC','EROFS'].includes(point);
    const killed=spawnSync(process.execPath,['apps/cli/test/support/backup-worker.ts',sandbox.root,failure?'restore-failure':'restore-crash',point],{encoding:'utf8'});
    if(failure) assert.equal(killed.status,0,killed.stderr); else assert.ok(killed.signal==='SIGKILL'||killed.status!==0);
    assert.doesNotMatch(killed.stderr,/Error:|ERR_/); assert.equal(JSON.parse(killed.stdout).point,point);
    const db=new DatabaseSync(join(sandbox.root,'probe.sqlite'),{readOnly:true});
    let operationId:string;
    try { const row=db.prepare("SELECT operation_id FROM store_restores WHERE state='preparing'").get(); assert.ok(row); operationId=String(row.operation_id); } finally {db.close();}
    assert.deepEqual(readFileSync(join(sandbox.root,'session.jsonl')),original);
    if(action==='discard') {
      const discarded=spawnSync(process.execPath,['apps/cli/test/support/backup-worker.ts',sandbox.root,'discard-recovery',operationId],{encoding:'utf8'});
      assert.equal(discarded.status,0,discarded.stderr);
      assert.equal(existsSync(JSON.parse(discarded.stdout).directory.path),false);
    }
    const result=cli('restore-snapshot','--snapshot',saved.id).find(event=>event.event==='snapshot-restored');
    if(action==='resume') assert.equal(result.receipt.operationId,operationId); else assert.notEqual(result.receipt.operationId,operationId);
    cli('recovery-new-session');
  } finally {rmSync(sandbox.root,{recursive:true,force:true});}
});

test('backup directory creation interrupted before identity binding stays in maintenance inventory',()=>{
  const sandbox=createSandbox();
  try {
    const killed=spawnSync(process.execPath,['apps/cli/test/support/backup-worker.ts',sandbox.root,'backup-crash'],{encoding:'utf8'});
    assert.ok(killed.signal==='SIGKILL'||killed.status!==0); assert.doesNotMatch(killed.stderr,/Error:|ERR_/);
    assert.equal(JSON.parse(killed.stdout).point,'backup-directory');
    const db=new DatabaseSync(join(sandbox.root,'probe.sqlite'),{readOnly:true});
    let snapshotId:string;
    try {const row=db.prepare("SELECT snapshot_id FROM store_snapshots WHERE state='staging'").get(); assert.ok(row); snapshotId=String(row.snapshot_id);} finally {db.close();}
    const source=readFileSync(join(sandbox.root,'session.jsonl'));
    const discarded=spawnSync(process.execPath,['apps/cli/test/support/backup-worker.ts',sandbox.root,'discard-snapshot',snapshotId],{encoding:'utf8'});
    assert.equal(discarded.status,0,discarded.stderr); assert.equal(existsSync(JSON.parse(discarded.stdout).directory.path),false);
    assert.deepEqual(readFileSync(join(sandbox.root,'session.jsonl')),source);
    const retried=runBackupCli(sandbox.root,'backup');
    assert.equal(retried.status,0,retried.stdout+retried.stderr);
    const result=retried.events.find(event=>event.event==='backup-result');
    assert.equal(result.status,'created'); assert.ok(result.snapshot);
  } finally {rmSync(sandbox.root,{recursive:true,force:true});}
});

test('a later restore preserves original-copy deletion recorded after its snapshot',()=>{
  const sandbox=createSandbox();
  const run=(entry:string,...args:string[])=>{
    const result=spawnSync(process.execPath,[entry,...args],{encoding:'utf8'});
    assert.equal(result.status,0,result.stdout+result.stderr); return result.stdout.trim().split('\n').map(line=>JSON.parse(line));
  };
  const cli=(command:string,...args:string[])=>{
    const result=runBackupCli(sandbox.root,command,args);
    assert.equal(result.status,0,result.stdout+result.stderr); return result.events;
  };
  try {
    cli('run'); const first=cli('backup').find(event=>event.event==='backup-result').snapshot;
    const restored=cli('restore-snapshot','--snapshot',first.id).find(event=>event.event==='snapshot-restored');
    const checkpoint=run('apps/cli/test/support/backup-worker.ts',sandbox.root,'migration-checkpoint')[0].snapshot;
    run('apps/cli/test/support/backup-worker.ts',sandbox.root,'discard-recovery',restored.receipt.operationId);
    cli('restore-snapshot','--snapshot',checkpoint.id);
    assert.equal(existsSync(restored.original.path),false);
    const db=new DatabaseSync(join(sandbox.root,'probe.sqlite'),{readOnly:true});
    try {assert.equal(db.prepare('SELECT original_deleted FROM store_restores WHERE operation_id=?').get(restored.receipt.operationId)!.original_deleted,1);} finally {db.close();}
    cli('recovery-new-session');
  } finally {rmSync(sandbox.root,{recursive:true,force:true});}
});
