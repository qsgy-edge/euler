import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createSandbox } from '../src/sandbox.ts';
import { runBackupCli } from './support/backup-cli.ts';

function cli(root: string, command: string, args: string[] = [], input?: string) {
  const result = runBackupCli(root, command, args, input);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.events;
}

test('recovery restores delivered Info and read state while preserving post-snapshot Info only in the original copy', () => {
  const sandbox = createSandbox();
  try {
    const seeded = cli(sandbox.root, 'remember', [], '记住偏好：包管理器使用 pnpm\n记住决定：本项目使用 SQLite WAL\nstop\n');
    const batches = seeded.filter(event => event.event === 'remember-result' && event.status === 'activated');
    assert.equal(batches.length, 2);
    assert.equal(cli(sandbox.root, 'info', ['--batch', batches[0].batchId]).find(event => event.event === 'info-read').read, 'read');
    const snapshot = cli(sandbox.root, 'backup').find(event => event.event === 'backup-result').snapshot;
    const info = snapshot.files.find((file: { role: string }) => file.role === 'owner-info');
    const before = readFileSync(info.source.path, 'utf8');
    assert.equal(before.trim().split('\n').length, 3);
    cli(sandbox.root, 'info', ['--batch', batches[1].batchId]);
    const later = cli(sandbox.root, 'remember', [], '记住偏好：测试使用独立目录\nstop\n')
      .find(event => event.event === 'remember-result' && event.status === 'activated');
    assert.ok(later.batchId);
    const after = readFileSync(info.source.path, 'utf8');
    const restored = cli(sandbox.root, 'restore-snapshot', ['--snapshot', snapshot.id]).find(event => event.event === 'snapshot-restored');
    assert.equal(readFileSync(info.source.path, 'utf8'), before);
    const db = new DatabaseSync(join(sandbox.root, 'probe.sqlite'), { readOnly: true });
    try {
      const plan = JSON.parse(String(db.prepare('SELECT payload FROM store_restores WHERE operation_id=?').get(restored.receipt.operationId)!.payload));
      const original = plan.originals.find((file: { role: string }) => file.role === 'owner-info');
      assert.equal(readFileSync(join(plan.original.path, original.name), 'utf8'), after);
      assert.equal(db.prepare('SELECT count(*) AS n FROM activation_batches').get()!.n, 2);
      assert.equal(db.prepare('SELECT 1 FROM activation_batches WHERE batch_id=?').get(later.batchId), undefined);
    } finally { db.close(); }
    const listed = cli(sandbox.root, 'info').find(event => event.event === 'info-list');
    assert.deepEqual([listed.pending, listed.unread], [0, 1]);
    const rejected = runBackupCli(sandbox.root, 'run');
    assert.equal(rejected.status, 1);
    assert.equal(rejected.events.find(event => event.event === 'error').reason, 'recovered-stream-blocked');
    assert.equal(cli(sandbox.root, 'recovery-new-session').find(event => event.event === 'recovery-new-session').receipt.outcome, 'received');
    assert.equal(readFileSync(info.source.path, 'utf8'), before);
  } finally { rmSync(sandbox.root, { recursive: true, force: true }); }
});
