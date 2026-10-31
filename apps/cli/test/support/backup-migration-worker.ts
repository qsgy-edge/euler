import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { writeSync } from 'node:fs';
const [path, point] = process.argv.slice(2);
const db = new DatabaseSync(path!);
function crash(): never {
  writeSync(1, JSON.stringify({ event: 'migration-crash', point }) + '\n');
  process.kill(process.pid, 'SIGKILL'); throw new Error('process-was-not-killed');
}
try {
  db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE; CREATE TABLE synthetic_migration_probe(value TEXT NOT NULL) STRICT;');
  const metadata = db.prepare('SELECT * FROM schema_meta').get()!;
  assert.equal(metadata.schema_version,26);
  const definition = String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='schema_meta'").get()!.sql);
  const guards = db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='schema_meta' ORDER BY name").all();
  db.exec('DROP TABLE schema_meta');
  db.exec(definition.replace('CHECK(schema_version=26)','CHECK(schema_version=27)'));
  for (const guard of guards) db.exec(String(guard.sql));
  db.function('euler_store_writer',()=>1);
  const schema = db.prepare('SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name').all();
  const digest = createHash('sha256').update(JSON.stringify(schema)).digest('hex');
  db.prepare('INSERT INTO schema_meta VALUES (?,?,?,?,?,?)')
    .run(metadata.singleton!,metadata.store_id!,27,digest,metadata.app_id!,metadata.os_user!);
  db.prepare('INSERT INTO synthetic_migration_probe VALUES (?)').run('forward migration committed');
  db.exec('PRAGMA user_version=27');
  if (point === 'before-commit') crash();
  db.exec('COMMIT');
  if (point === 'after-commit') crash();
  console.log(JSON.stringify({ event: 'migration-committed', version: 27 }));
} finally { db.close(); }
