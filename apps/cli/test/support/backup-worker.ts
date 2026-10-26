import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import sqlite from 'node:sqlite';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { ProbeStore, ProbeSession, API_VERSION } from '@euler/core';
import { openSandbox, bindingOf, resourcesOf, createSandboxSession } from '../../src/sandbox.ts';
import { openProbe } from '../../src/probe.ts';
import { backupSandbox, restoreSandboxSnapshot } from '../../src/backup.ts';

const [root, action, value] = process.argv.slice(2);
const sandbox = openSandbox(root!);
function crash(point: string): never {
  fs.writeSync(1, JSON.stringify({ event: 'snapshot-crash', point }) + '\n');
  process.kill(process.pid, 'SIGKILL'); throw new Error('process-was-not-killed');
}
if (action === 'migration-checkpoint') {
  console.log(JSON.stringify(await backupSandbox(sandbox, 'migration')));
} else if (action === 'repair-projection') {
  const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    if (value === 'memory') probe.store.rebuildSearchProjection(probe.activity);
    else if (value === 'source') probe.store.rebuildSourceProjection(probe.activity);
    else throw new Error('invalid-projection-lane');
    console.log(JSON.stringify({ event: 'projection-rebuilt', health: probe.store.fence().health }));
  } finally { probe.close(); }
} else if (action === 'discard-recovery') {
  const store = new ProbeStore(resourcesOf(sandbox), sandbox.storeId, bindingOf(sandbox)), coordinator = randomUUID();
  try {
    store.beginMaintenance(coordinator);
    if (!store.acquireMaintenance(coordinator).acquired) throw new Error('maintenance-residuals-or-participants');
    const manifest = store.recoveryCleanupManifest(coordinator, value!);
    store.discardRecoveryOriginal(coordinator, manifest); store.releaseMaintenance(coordinator);
    console.log(JSON.stringify(manifest));
  } finally { store.close(); }
} else if (action === 'unknown') {
  const binding = { ...bindingOf(sandbox), sessionId: randomUUID(), branchId: randomUUID() };
  createSandboxSession(sandbox, binding);
  const jobId = randomUUID();
  const probe = openProbe(sandbox, undefined, { kind: 'job', id: jobId, authorizationId: jobId }, binding, undefined, true);
  try {
    const run = new ProbeSession(probe.store, probe.activity, { version: API_VERSION, binding, source: probe.archive, transport: probe.transport });
    const turn = run.prepare(randomUUID(), 'A post-snapshot synthetic request whose result is unknown.');
    const attempt = probe.store.startRequestAttempt(probe.activity, { runId: run.runId, assemblyId: turn.assemblyId,
      payloadHash: turn.payloadHash, byteLength: Buffer.byteLength(turn.payload), adapterVersion: API_VERSION });
    probe.transport.send(turn.payload, attempt);
    console.log(JSON.stringify({ jobId, sessionId: binding.sessionId, runId: run.runId, attemptId: attempt.attemptId }));
  } finally { probe.store.close(); }
} else if (action === 'backup-failure') {
  const write = fs.writeFileSync;
  fs.writeFileSync = ((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (String(path).includes('backup-')) throw Object.assign(new Error(value), { code: value });
    return Reflect.apply(write, fs, [path, ...args]);
  }) as typeof fs.writeFileSync;
  syncBuiltinESMExports();
  try { await backupSandbox(sandbox); throw new Error('expected-backup-failure'); }
  catch (error) { console.log(JSON.stringify({ event: 'backup-failed', reason: (error as NodeJS.ErrnoException).code })); }
} else if (action === 'restore-crash' || action === 'restore-failure') {
  const mkdir = fs.mkdirSync;
  fs.mkdirSync = ((path: fs.PathLike, ...args: unknown[]) => {
    const result = Reflect.apply(mkdir, fs, [path, ...args]);
    if (value === 'directory' && /recovery-[^/\\]+$/.test(String(path))) crash(value);
    return result;
  }) as typeof fs.mkdirSync;
  const write = fs.writeFileSync;
  fs.writeFileSync = ((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (action === 'restore-failure' && /recovery-[^/\\]+[/\\]store.sqlite$/.test(String(path))) {
      throw Object.assign(new Error(value), { code: value });
    }
    const result = Reflect.apply(write, fs, [path, ...args]);
    if (value === 'preparation' && /recovery-[^/\\]+[/\\]store.sqlite$/.test(String(path))) crash(value);
    return result;
  }) as typeof fs.writeFileSync;
  const open = fs.openSync, truncate = fs.ftruncateSync, files = new Map<number, string>();
  fs.openSync = ((path: fs.PathLike, ...args: unknown[]) => {
    const fd = Reflect.apply(open, fs, [path, ...args]) as number; files.set(fd, String(path)); return fd;
  }) as typeof fs.openSync;
  fs.ftruncateSync = (fd, length) => {
    truncate(fd, length);
    if (value === 'carrier' && files.get(fd) === join(sandbox.root, 'session.jsonl')) crash(value);
  };
  const exec = sqlite.DatabaseSync.prototype.exec;
  sqlite.DatabaseSync.prototype.exec = function(sql: string) {
    const result = exec.call(this, sql);
    if (value === 'database' && sql.includes('busy_timeout=2000') && sql.includes('journal_mode=WAL')) crash(value);
    return result;
  };
  syncBuiltinESMExports();
  const db = new sqlite.DatabaseSync(join(sandbox.root, 'probe.sqlite'), { readOnly: true });
  const id = String(db.prepare("SELECT snapshot_id FROM store_snapshots WHERE state='ready' ORDER BY created_at DESC LIMIT 1").get()!.snapshot_id);
  db.close();
  try { await restoreSandboxSnapshot(sandbox, id); throw new Error('expected-restore-failure'); }
  catch (error) {
    if (action !== 'restore-failure' || (error as NodeJS.ErrnoException).code !== value) throw error;
    console.log(JSON.stringify({ event: 'snapshot-failed', point: value }));
  }
}
