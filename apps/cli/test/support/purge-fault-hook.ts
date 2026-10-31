import fs from 'node:fs';
import { basename, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { syncBuiltinESMExports } from 'node:module';
import { ProbeStore } from '@euler/core';
import { CliArchive } from '../../src/archive.ts';
import { OwnerInfoLog } from '../../src/owner-memory.ts';
import { CountingTransport } from '../../src/probe.ts';
import { WindowsFileRoot } from '../../src/windows-files.ts';

const point = process.env.EULER_PURGE_TEST_POINT!;
let activeOwner = '';
function crash(): never {
  fs.writeSync(1, JSON.stringify({ event: 'purge-fault', point }) + '\n');
  process.kill(process.pid, 'SIGKILL'); throw new Error('process-was-not-killed');
}
function boundary<T>(name: string, action: () => T): T {
  if (point === name + '-before') crash();
  activeOwner = name;
  try {
    const result = action();
    if (point === name + '-after') crash();
    return result;
  } finally { activeOwner = ''; }
}
const source = CliArchive.prototype.purge;
CliArchive.prototype.purge = function (...args) { return boundary('source', () => source.apply(this, args)); };
const info = OwnerInfoLog.prototype.purge;
OwnerInfoLog.prototype.purge = function (...args) { return boundary('info', () => info.apply(this, args)); };
const receiver = CountingTransport.prototype.purge;
CountingTransport.prototype.purge = function (...args) { return boundary('receiver', () => receiver.apply(this, args)); };
const output = WindowsFileRoot.prototype.purge;
WindowsFileRoot.prototype.purge = function (...args) { return boundary('output', () => output.apply(this, args)); };
const scrub = ProbeStore.prototype.preparePurgeMaintenance;
ProbeStore.prototype.preparePurgeMaintenance = function (...args) { return boundary('scrub', () => scrub.apply(this, args)); };
const complete = ProbeStore.prototype.completePurge;
ProbeStore.prototype.completePurge = function (...args) {
  const result = complete.apply(this, args);
  if (point === 'completion-after') crash();
  return result;
};
const writeFile = fs.writeFileSync;
fs.writeFileSync = ((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
  const result = Reflect.apply(writeFile, fs, [path, ...args]);
  if (point === 'staging-copy-after' && basename(dirname(String(path))).startsWith('backup-')) crash();
  return result;
}) as typeof fs.writeFileSync;
const remove = fs.unlinkSync;
fs.unlinkSync = (...args) => {
  const selected = basename(dirname(String(args[0]))).startsWith('backup-');
  if (selected && point === 'backup-before') crash();
  remove(...args);
  if (selected && point === 'backup-partial') crash();
};
const removeDirectory = fs.rmdirSync;
fs.rmdirSync = (...args) => {
  removeDirectory(...args);
  if (basename(String(args[0])).startsWith('backup-') && point === 'backup-after') crash();
};
const write = fs.writeSync;
fs.writeSync = ((...args: Parameters<typeof write>) => {
  if (point === 'info-enospc' && activeOwner === 'info') throw Object.assign(new Error('injected-no-space-left'), { code: 'ENOSPC' });
  return write(...args);
}) as typeof write;
syncBuiltinESMExports();
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) {
  if (sql === 'VACUUM') {
    if (point === 'sqlite-full') throw Object.assign(new Error('injected-database-or-disk-full'), { code: 'ERR_SQLITE_ERROR', errcode: 13 });
    return boundary('vacuum', () => exec.call(this, sql));
  }
  return exec.call(this, sql);
};
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql) {
  const statement = prepare.call(this, sql);
  if (point === 'completion-before' && sql.startsWith('INSERT INTO memory_events') && sql.includes("'purge-controlled-complete'")) {
    statement.run = () => crash();
  }
  return statement;
};
