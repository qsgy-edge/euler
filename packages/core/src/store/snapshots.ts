import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, unlinkSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { check, sha256 } from '../contracts.ts';
import { fileIdentity, sameFile } from './probe-store.ts';
import type { BoundFile } from './probe-store.ts';

export interface SnapshotFile {
  source: BoundFile; name: string; hash: string; bytes: number;
  role: 'source' | 'owner-info' | 'receiver' | 'project-output';
}
export interface StoreSnapshot {
  schema: 'store-snapshot@1'; id: string; kind: 'daily' | 'migration'; createdAt: string; day: string;
  storeId: string; root: BoundFile; directory: BoundFile; dataHash: string;
  database: { hash: string; bytes: number }; files: SnapshotFile[]; state: 'ready';
}

export interface SnapshotCleanupManifest {
  schema: 'snapshot-cleanup@1'; snapshotId: string; recoveryId?: string; directory: BoundFile;
  files: { name: string; file: BoundFile; hash: string; bytes: number }[]; digest: string;
}

export function snapshotDirectoryExists(directory: BoundFile): boolean {
  try { sameFile(directory.path, directory.identity); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

export function inspectSnapshotFiles(directory: BoundFile, permitted: string[]): SnapshotCleanupManifest['files'] {
  sameFile(directory.path, directory.identity);
  return readdirSync(directory.path).sort().map(name => {
    check(permitted.includes(name), 'snapshot-inventory-mismatch');
    const path = join(directory.path, name), file = { path, identity: fileIdentity(path) };
    const bytes = snapshotBytes(file);
    return { name, file, hash: sha256(bytes), bytes: bytes.length };
  });
}

export function removeSnapshotFiles(manifest: SnapshotCleanupManifest): void {
  if (!snapshotDirectoryExists(manifest.directory)) return;
  const files = inspectSnapshotFiles(manifest.directory, manifest.files.map(file => file.name));
  for (const file of files) {
    const expected = manifest.files.find(item => item.name === file.name);
    check(JSON.stringify(expected) === JSON.stringify(file), 'snapshot-cleanup-stale');
  }
  for (const file of files) {
    sameFile(manifest.directory.path, manifest.directory.identity); sameFile(file.file.path, file.file.identity);
    unlinkSync(file.file.path);
  }
  rmdirSync(manifest.directory.path);
}

export function syncSnapshotFile(path: string): void {
  const fd = openSync(path, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function syncSnapshotDirectory(path: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function snapshotBytes(file: BoundFile): Buffer {
  sameFile(file.path, file.identity);
  check(lstatSync(file.path).isFile(), 'snapshot-carrier-not-file');
  const bytes = readFileSync(file.path);
  sameFile(file.path, file.identity);
  return bytes;
}
export function writeSnapshotFile(path: string, bytes: Uint8Array | string): void {
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  syncSnapshotFile(path);
}
export function checkSqliteSnapshot(db: DatabaseSync, scope: 'all' | 'canonical' = 'all'): 'healthy' | 'projection-failed' {
  const quick = db.prepare('PRAGMA quick_check').all();
  const foreign = db.prepare('PRAGMA foreign_key_check').all();
  const quickOk = quick.length === 1 && quick[0]!.quick_check === 'ok';
  if (scope === 'canonical' && (!quickOk || foreign.length > 0)) {
    const projection = (name: string) => name === 'search_documents' || name === 'search_fts' || name.startsWith('search_fts_');
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' UNION SELECT 'sqlite_schema'").all();
    const checks = quickOk ? [] : tables.map(row => ({ name: String(row.name),
      errors: db.prepare(`PRAGMA quick_check("${String(row.name).replaceAll('"','""')}")`).all()
        .map(item => String(item.quick_check)).filter(message => message !== 'ok') }));
    const projectionErrors = new Set(checks.filter(row => projection(row.name)).flatMap(row => row.errors));
    if (foreign.every(row => projection(String(row.table))) && checks.every(row => projection(row.name) || row.errors.length === 0)
      && (quickOk || quick.every(row => projectionErrors.has(String(row.quick_check))))) return 'projection-failed';
  }
  check(quickOk, 'store-integrity-failed');
  check(foreign.length === 0, 'store-foreign-key-failed');
  return 'healthy';
}

// Control bookkeeping alone does not count as a new data version for daily retention.
export function snapshotDataHash(db: DatabaseSync, files: SnapshotFile[]): string {
  const excluded = new Set(['owner_activities', 'maintenance_residuals', 'owner_fences', 'store_snapshots']);
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const rows = tables.filter(row => !excluded.has(String(row.name))).map(row => {
    const name = String(row.name);
    return [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().map(value => JSON.stringify(value)).sort()];
  });
  return sha256(JSON.stringify({ rows, files: files.map(({ source, role, hash, bytes }) => ({ source, role, hash, bytes })) }));
}

function verifySnapshotFile(path: string, expected: { hash: string; bytes: number }): void {
  const stat = lstatSync(path);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'unsafe-snapshot-file');
  const bytes = readFileSync(path);
  check(bytes.length === expected.bytes && sha256(bytes) === expected.hash, 'snapshot-content-mismatch');
}

export function verifySnapshot(snapshot: StoreSnapshot): void {
  sameFile(snapshot.root.path, snapshot.root.identity);
  sameFile(snapshot.directory.path, snapshot.directory.identity);
  const expected = ['manifest.json', 'store.sqlite', ...snapshot.files.map(file => file.name)].sort();
  check(JSON.stringify(readdirSync(snapshot.directory.path).sort()) === JSON.stringify(expected), 'snapshot-inventory-mismatch');
  const manifest = readFileSync(join(snapshot.directory.path, 'manifest.json'), 'utf8');
  check(manifest === JSON.stringify(snapshot) + '\n', 'snapshot-manifest-mismatch');
  for (const item of [{ name: 'store.sqlite', ...snapshot.database }, ...snapshot.files]) {
    check(!item.name.includes('/') && !item.name.includes('\\'), 'snapshot-inventory-mismatch');
    verifySnapshotFile(join(snapshot.directory.path, item.name), item);
  }
  const db = new DatabaseSync(join(snapshot.directory.path, 'store.sqlite'), { readOnly: true });
  try { checkSqliteSnapshot(db); } finally { db.close(); }
}

export function deleteSnapshot(snapshot: StoreSnapshot): void {
  sameFile(snapshot.root.path, snapshot.root.identity);
  if (!snapshotDirectoryExists(snapshot.directory)) return;
  sameFile(snapshot.directory.path, snapshot.directory.identity);
  const expected = new Map<string, { hash: string; bytes: number }>([
    ['manifest.json', { hash: sha256(JSON.stringify(snapshot) + '\n'), bytes: Buffer.byteLength(JSON.stringify(snapshot) + '\n') }],
    ['store.sqlite', snapshot.database], ...snapshot.files.map(file => [file.name, file] as const),
  ]);
  for (const name of readdirSync(snapshot.directory.path)) {
    const item = expected.get(name);
    check(item, 'snapshot-inventory-mismatch');
    verifySnapshotFile(join(snapshot.directory.path, name), item);
  }
  for (const name of readdirSync(snapshot.directory.path)) {
    sameFile(snapshot.directory.path, snapshot.directory.identity);
    unlinkSync(join(snapshot.directory.path, name));
  }
  rmdirSync(snapshot.directory.path);
  syncSnapshotDirectory(snapshot.root.path);
}
