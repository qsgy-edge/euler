import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createSandbox } from '../src/sandbox.ts';

function child(path: string, args: string[]) {
  const result = spawnSync(process.execPath, [path, ...args], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.error, undefined);
  const events = result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { ...result, events };
}
function cli(root: string, command: string, ...args: string[]) {
  const result = child('apps/cli/src/main.ts', [command, '--sandbox', root, ...args]);
  assert.equal(result.status, 0, JSON.stringify(result.events) + result.stderr);
  return result.events;
}
for (const when of ['before', 'after']) test(`a ${when}-snapshot unknown job stays unknown or explicitly missing and never resends`, () => {
  const sandbox = createSandbox();
  try {
    let snapshot: { id: string };
    if (when === 'after') snapshot = cli(sandbox.root, 'backup').find(e => e.event === 'backup-result').snapshot;
    const work = child('apps/cli/test/support/backup-worker.ts', [sandbox.root, 'unknown']);
    assert.equal(work.status, 0, work.stderr);
    const ids = work.events[0]!;
    if (when === 'before') snapshot = cli(sandbox.root, 'backup').find(e => e.event === 'backup-result').snapshot;
    const restored = cli(sandbox.root, 'restore-snapshot', '--snapshot', snapshot!.id).find(e => e.event === 'snapshot-restored');
    const db = new DatabaseSync(join(sandbox.root, 'probe.sqlite'), { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT count(*) AS n FROM store_recovered_owners WHERE kind='job' AND owner_id=?").get(ids.jobId)!.n, 1);
      const attempt = db.prepare('SELECT outcome FROM request_attempts WHERE attempt_id=?').get(ids.attemptId);
      if (when === 'before') assert.equal(attempt!.outcome, 'unknown-sent'); else assert.equal(attempt, undefined);
      const receipt = JSON.parse(String(db.prepare('SELECT receipt FROM store_recovery_events').get()!.receipt));
      assert.equal(receipt.outcome, 'recovered_with_gap');
      const plan = JSON.parse(String(db.prepare('SELECT payload FROM store_restores').get()!.payload));
      const receiver = plan.originals.find((file: { role: string }) => file.role === 'receiver');
      assert.ok(readFileSync(join(restored.original.path, receiver.name), 'utf8').includes(ids.attemptId));
    } finally { db.close(); }
    cli(sandbox.root, 'recovery-new-session');
  } finally { rmSync(sandbox.root, { recursive: true, force: true }); }
});

for (const point of ['carrier', 'database']) test(`a real process interrupted during ${point} restore resumes the same operation`, () => {
  const sandbox = createSandbox();
  try {
    cli(sandbox.root, 'run');
    const snapshot = cli(sandbox.root, 'backup').find(e => e.event === 'backup-result').snapshot;
    const interrupted = child('apps/cli/test/support/backup-worker.ts', [sandbox.root, 'restore-crash', point]);
    assert.ok(interrupted.signal === 'SIGKILL' || interrupted.status !== 0);
    assert.doesNotMatch(interrupted.stderr, /Error:|ERR_/);
    assert.equal(interrupted.events[0]!.point, point);
    const db = new DatabaseSync(join(sandbox.root, 'probe.sqlite'), { readOnly: true });
    let operationId: string;
    try {
      const pending = db.prepare("SELECT operation_id FROM store_restores WHERE state='prepared'").get(); assert.ok(pending);
      operationId = String(pending.operation_id);
      assert.notEqual(db.prepare('SELECT state FROM owner_fences').get()!.state, 'open');
    } finally { db.close(); }
    const resumed = cli(sandbox.root, 'restore-snapshot', '--snapshot', snapshot.id).find(e => e.event === 'snapshot-restored');
    assert.equal(resumed.receipt.operationId, operationId);
    cli(sandbox.root, 'recovery-new-session');
  } finally { rmSync(sandbox.root, { recursive: true, force: true }); }
});

for (const code of ['ENOSPC', 'EROFS']) test(`${code} stops optional backup without removing history and permits a later verified backup`, () => {
  const sandbox = createSandbox();
  try {
    cli(sandbox.root, 'run');
    const source = readFileSync(join(sandbox.root, 'session.jsonl'));
    const failed = child('apps/cli/test/support/backup-worker.ts', [sandbox.root, 'backup-failure', code]);
    assert.equal(failed.status, 0, failed.stderr); assert.equal(failed.events[0]!.reason, code);
    assert.deepEqual(readFileSync(join(sandbox.root, 'session.jsonl')), source);
    assert.deepEqual(cli(sandbox.root, 'backups').find(e => e.event === 'backups').snapshots, []);
    cli(sandbox.root, 'run');
    const saved = cli(sandbox.root, 'backup').find(e => e.event === 'backup-result').snapshot;
    cli(sandbox.root, 'restore-snapshot', '--snapshot', saved.id);
  } finally { rmSync(sandbox.root, { recursive: true, force: true }); }
});
