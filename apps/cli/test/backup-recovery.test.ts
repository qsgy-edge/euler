import assert from 'node:assert/strict';
import { runBackupCli } from './support/backup-cli.ts';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createSandbox } from '../src/sandbox.ts';

function cli(root: string, command: string, ...args: string[]) {
  return runBackupCli(root, command, args);
}

test('missing current owner control cannot be replaced by an older open snapshot', () => {
  const sandbox = createSandbox();
  try {
    const saved = cli(sandbox.root,'backup').events.find(event => event.event === 'backup-result').snapshot;
    const db = new DatabaseSync(join(sandbox.root,'probe.sqlite'));
    try { db.function('euler_store_writer',()=>1); db.exec('PRAGMA foreign_keys=OFF; DELETE FROM owner_fences'); }
    finally { db.close(); }
    const original = readFileSync(join(sandbox.root,'session.jsonl'));
    const restored = cli(sandbox.root,'restore-snapshot','--snapshot',saved.id);
    assert.equal(restored.status,1);
    assert.equal(restored.events.find(event => event.event === 'error').reason,'store-binding-mismatch');
    assert.deepEqual(readFileSync(join(sandbox.root,'session.jsonl')),original);
  } finally { rmSync(sandbox.root,{recursive:true,force:true}); }
});

test('restoring a verified snapshot preserves the damaged original and blocks every old stream', () => {
  const sandbox = createSandbox();
  try {
    const run = cli(sandbox.root, 'run');
    assert.equal(run.status, 0, run.stderr);
    const before = new DatabaseSync(join(sandbox.root, 'probe.sqlite'), { readOnly: true });
    let oldRun: string;
    try { oldRun = String(before.prepare('SELECT run_id FROM request_runs LIMIT 1').get()!.run_id); }
    finally { before.close(); }
    const saved = cli(sandbox.root, 'backup');
    assert.equal(saved.status, 0, JSON.stringify(saved.events));
    const snapshot = saved.events.find(event => event.event === 'backup-result').snapshot;
    const changed = new DatabaseSync(join(sandbox.root, 'probe.sqlite'));
    try {
      changed.exec('DROP TRIGGER immutable_request_events_update');
      changed.exec("UPDATE request_events SET hash='broken' WHERE seq=1");
    } finally { changed.close(); }
    const rejectedBackup = cli(sandbox.root, 'backup');
    assert.equal(rejectedBackup.status, 1);
    assert.equal(rejectedBackup.events.find(event => event.event === 'error').reason, 'ledger-evidence-gap');
    const blocked = cli(sandbox.root, 'run');
    assert.equal(blocked.status, 1);
    assert.equal(blocked.events.find(event => event.event === 'error').reason, 'store-integrity-failed');
    const recovered = cli(sandbox.root, 'restore-snapshot', '--snapshot', snapshot.id);
    assert.equal(recovered.status, 0, JSON.stringify(recovered.events));
    const receipt = recovered.events.find(event => event.event === 'snapshot-restored');
    assert.equal(receipt.receipt.schema, 'store/recovered-from-snapshot@v1');
    assert.ok(readFileSync(join(receipt.original.path, 'store.sqlite')).length > 0);
    const status = cli(sandbox.root, 'request-status', '--request', oldRun).events.find(event => event.event === 'request-status');
    assert.deepEqual(status.recovery, receipt.receipt);
    assert.match(status.warning, /snapshot/);
    const old = cli(sandbox.root, 'request-resume', '--request', oldRun, '--accept-duplicate-risk');
    assert.equal(old.status, 1);
    assert.equal(old.events.find(event => event.event === 'error').reason, 'recovered-stream-blocked');
    const next = cli(sandbox.root, 'recovery-new-session');
    assert.equal(next.status, 0, JSON.stringify(next.events));
    assert.equal(next.events.find(event => event.event === 'recovery-new-session').receipt.outcome, 'received');
  } finally { rmSync(sandbox.root, { recursive: true, force: true }); }
});
