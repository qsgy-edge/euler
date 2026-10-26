import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { arch, release, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSandbox } from '../apps/cli/src/sandbox.ts';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const fixturePath = 'fixtures/t20-backup-cases.json';
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { cases: string[] };
const directory = join('artifacts', 't20-' + Date.now()); mkdirSync(directory, { recursive: true });
const startedAt = new Date().toISOString();
const observations: Record<string, unknown>[] = [];
let failed = false;
const evidenceGaps: string[] = [];
for (const scenario of fixture.cases) {
  const path = join(directory, scenario); mkdirSync(path);
  if (scenario.startsWith('project-output-') && process.platform !== 'win32') {
    const reason = 'controlled-project-output-host-unavailable-' + process.platform;
    if (!evidenceGaps.includes(reason)) evidenceGaps.push(reason);
    observations.push({ scenario,passed: null,reason }); continue;
  }
  const sandbox = createSandbox();
  let outputRoot: string | undefined;
  const commands: Record<string, unknown>[] = [];
  const run = (name: string, args: string[], expected: 'success' | 'error' | 'kill' = 'success') => {
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    writeFileSync(join(path, name + '.stdout.jsonl'), result.stdout ?? ''); writeFileSync(join(path, name + '.stderr.txt'), result.stderr ?? '');
    commands.push({ command: [process.execPath, ...args], exitCode: result.status, signal: result.signal, stdout: name + '.stdout.jsonl', stderr: name + '.stderr.txt' });
    assert.equal(result.error, undefined);
    if (expected === 'success') assert.equal(result.status, 0, result.stderr);
    else assert.ok(result.signal === 'SIGKILL' || result.status !== 0);
    if (expected === 'kill') assert.doesNotMatch(result.stderr, /Error:|ERR_/);
    return result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  };
  const cli = (name: string, command: string, args: string[] = [], expected: 'success' | 'error' = 'success') =>
    run(name, ['apps/cli/src/main.ts', command, '--sandbox', sandbox.root, ...args], expected);
  try {
    if (['memory','handoff','historian'].includes(scenario)) cli('setup', scenario, ['--scenario','synthetic']);
    else cli('setup', 'run');
    let unknown: Record<string, string> | undefined;
    if (scenario === 'unknown-before') unknown = run('unknown-before', ['apps/cli/test/support/backup-worker.ts',sandbox.root,'unknown'])[0];
    if (['ENOSPC','EROFS'].includes(scenario)) {
      const original = hash(readFileSync(join(sandbox.root, 'session.jsonl')));
      assert.equal(run('backup-failure', ['apps/cli/test/support/backup-worker.ts',sandbox.root,'backup-failure',scenario])[0].reason, scenario);
      assert.equal(hash(readFileSync(join(sandbox.root, 'session.jsonl'))), original);
      assert.deepEqual(cli('failed-backups', 'backups').find(e => e.event === 'backups').snapshots, []);
    }
    const createOutput = () => {
      outputRoot = realpathSync.native(mkdtempSync(join(tmpdir(),'euler-t20-output-')));
      return run('project-output',['apps/cli/test/support/backup-file-worker.ts',sandbox.root,outputRoot])[0].controlledFiles[0];
    };
    let expectedOutput: unknown;
    if (scenario === 'project-output-before') expectedOutput = createOutput();
    const saved = scenario.startsWith('migration-')
      ? run('backup', ['apps/cli/test/support/backup-worker.ts',sandbox.root,'migration-checkpoint'])[0].snapshot
      : cli('backup', 'backup').find(e => e.event === 'backup-result').snapshot;
    assert.ok(saved?.id);
    const snapshotPath = join(saved.directory.path, 'store.sqlite');
    assert.equal(hash(readFileSync(snapshotPath)), saved.database.hash);
    const snapshotDb = new DatabaseSync(snapshotPath, { readOnly: true });
    let attempts: Record<string, unknown>[], streams: Record<string, unknown>[], snapshotEpoch: number;
    try {
      assert.equal(snapshotDb.prepare('PRAGMA user_version').get()!.user_version, 23);
      assert.equal(snapshotDb.prepare('PRAGMA quick_check').get()!.quick_check, 'ok');
      assert.deepEqual(snapshotDb.prepare('PRAGMA foreign_key_check').all(), []);
      attempts = snapshotDb.prepare('SELECT * FROM request_attempts ORDER BY attempt_id').all();
      streams = snapshotDb.prepare('SELECT owner_kind,owner_id FROM execution_streams').all();
      snapshotEpoch = Number(snapshotDb.prepare('SELECT epoch FROM owner_fences').get()!.epoch);
      for (const event of snapshotDb.prepare('SELECT payload,hash FROM request_events').all()) assert.equal(hash(String(event.payload)), event.hash);
    } finally { snapshotDb.close(); }
    if (scenario === 'unknown-after') unknown = run('unknown-after', ['apps/cli/test/support/backup-worker.ts',sandbox.root,'unknown'])[0];
    if (scenario === 'project-output-after') expectedOutput = createOutput();
    if (scenario.startsWith('migration-')) {
      const candidate = join(path, 'migration.sqlite'); copyFileSync(snapshotPath, candidate);
      const point = scenario.slice('migration-'.length);
      run('migration', ['apps/cli/test/support/backup-migration-worker.ts',candidate,point], point === 'success' ? 'success' : 'kill');
      const candidateDb = new DatabaseSync(candidate);
      try {
        const version = point === 'before-commit' ? 23 : 24;
        assert.equal(candidateDb.prepare('PRAGMA user_version').get()!.user_version,version);
        const metadata = candidateDb.prepare('SELECT schema_version,ddl_hash FROM schema_meta').get()!;
        assert.equal(metadata.schema_version,version);
        assert.ok(String(candidateDb.prepare("SELECT sql FROM sqlite_schema WHERE name='schema_meta'").get()!.sql).includes(`CHECK(schema_version=${version})`));
        if (version === 24) assert.equal(metadata.ddl_hash,hash(JSON.stringify(candidateDb.prepare('SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name').all())));
        assert.equal(candidateDb.prepare('PRAGMA quick_check').get()!.quick_check, 'ok');
        assert.deepEqual(candidateDb.prepare('PRAGMA foreign_key_check').all(), []);
      } finally { candidateDb.close(); }
      assert.equal(hash(readFileSync(snapshotPath)), saved.database.hash);
    }
    if (scenario === 'canonical-corruption') {
      const db = new DatabaseSync(join(sandbox.root, 'probe.sqlite'));
      try { db.exec("DROP TRIGGER immutable_request_events_update; UPDATE request_events SET hash='broken' WHERE seq=1"); } finally { db.close(); }
      assert.equal(cli('rejected-backup','backup',[],'error').find(e => e.event === 'error').reason, 'ledger-evidence-gap');
      assert.equal(cli('blocked-run','run',[],'error').find(e => e.event === 'error').reason, 'store-integrity-failed');
    }
    let operationId: string | undefined;
    if (scenario.startsWith('crash-')) {
      const point = scenario.slice('crash-'.length);
      assert.equal(run('interrupted', ['apps/cli/test/support/backup-worker.ts',sandbox.root,'restore-crash',point], 'kill')[0].point, point);
      const db = new DatabaseSync(join(sandbox.root, 'probe.sqlite'), { readOnly: true });
      try {
        operationId = String(db.prepare("SELECT operation_id FROM store_restores WHERE state='prepared'").get()!.operation_id);
        assert.notEqual(db.prepare('SELECT state FROM owner_fences').get()!.state, 'open');
      } finally { db.close(); }
      cpSync(sandbox.root, join(path, 'interrupted-sandbox'), { recursive: true });
    }
    const restored = cli('restored','restore-snapshot',['--snapshot',saved.id]).find(e => e.event === 'snapshot-restored');
    assert.equal(restored.receipt.schema, 'store/recovered-from-snapshot@v1');
    if (operationId) assert.equal(restored.receipt.operationId, operationId);
    for (const file of saved.files) {
      const bytes = readFileSync(file.source.path); assert.equal(bytes.length, file.bytes); assert.equal(hash(bytes), file.hash);
    }
    const db = new DatabaseSync(join(sandbox.root, 'probe.sqlite'), { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA quick_check').get()!.quick_check, 'ok'); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.deepEqual(db.prepare('SELECT * FROM request_attempts ORDER BY attempt_id').all(), attempts);
      assert.ok(Number(db.prepare('SELECT epoch FROM owner_fences').get()!.epoch) > snapshotEpoch);
      for (const stream of streams) assert.ok(db.prepare('SELECT 1 FROM store_recovered_owners WHERE kind=? AND owner_id=?').get(String(stream.owner_kind),String(stream.owner_id)));
      const receipt = db.prepare('SELECT receipt,digest FROM store_recovery_events WHERE operation_id=?').get(restored.receipt.operationId)!;
      assert.equal(hash(String(receipt.receipt)), receipt.digest); assert.deepEqual(JSON.parse(String(receipt.receipt)), restored.receipt);
      assert.deepEqual(Object.keys(restored.receipt).sort(), ['createdAt','operationId','outcome','schema']);
      const pending = db.prepare('SELECT state,payload,digest FROM store_restores WHERE operation_id=?').get(restored.receipt.operationId)!;
      assert.equal(pending.state, 'complete'); assert.equal(hash(String(pending.payload)), pending.digest);
      const plan = JSON.parse(String(pending.payload));
      for (const file of plan.originals) assert.equal(hash(readFileSync(join(plan.original.path, file.name))), file.hash);
      if (unknown) {
        assert.ok(db.prepare("SELECT 1 FROM store_recovered_owners WHERE kind='job' AND owner_id=?").get(unknown.jobId!));
        const attempt = db.prepare('SELECT outcome FROM request_attempts WHERE attempt_id=?').get(unknown.attemptId!);
        if (scenario === 'unknown-before') assert.equal(attempt!.outcome, 'unknown-sent'); else assert.equal(attempt, undefined);
        const receiver = plan.originals.find((file: { role: string }) => file.role === 'receiver');
        assert.ok(readFileSync(join(plan.original.path, receiver.name),'utf8').includes(unknown.attemptId!));
      }
    } finally { db.close(); }
    if (expectedOutput) {
      assert.deepEqual(cli('maintenance-inventory','maintenance-status').find(e => e.event === 'maintenance-status').controlledFiles,[expectedOutput]);
      assert.equal(readFileSync(join(outputRoot!,'result.md'),'utf8'),'EULER-T20 controlled project output');
    }
    const rejected = cli('old-run-rejected','run',[],'error').find(e => e.event === 'error'); assert.equal(rejected.reason, 'recovered-stream-blocked');
    const fresh = cli('new-session','recovery-new-session').find(e => e.event === 'recovery-new-session'); assert.equal(fresh.receipt.outcome, 'received');
    observations.push({ scenario, passed: true, commands, snapshotId: saved.id, operationId: restored.receipt.operationId, preservedAttempts: attempts.length, snapshotStreams: streams.length, newSessionId: fresh.sessionId });
  } catch (error) {
    failed = true; writeFileSync(join(path,'verification-error.txt'), error instanceof Error ? error.stack ?? error.message : String(error));
    observations.push({ scenario, passed: false, commands });
  } finally {
    assert.ok(basename(sandbox.root).startsWith('euler-t01-'));
    if (outputRoot) { cpSync(outputRoot,join(path,'project-output'),{recursive:true}); rmSync(outputRoot,{recursive:true,force:true}); }
    cpSync(sandbox.root, join(path,'sandbox'), { recursive: true });
    rmSync(sandbox.root, { recursive: true, force: true });
  }
}
function files(path: string, prefix = ''): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(join(path,entry.name), prefix + entry.name + '/') : [prefix + entry.name]);
}
const git = (args: string[]) => execFileSync('git',args,{encoding:'utf8'}).trim();
const receipt = { schema: 't20-backup-receipt@1', synthetic: true, startedAt, completedAt: new Date().toISOString(),
  status: failed ? 'fail' : evidenceGaps.length ? 'evidence-gap' : 'pass', fixture: { path: fixturePath, sha256: hash(readFileSync(fixturePath)) },
  implementation: { commit: git(['rev-parse','HEAD']), tree: git(['rev-parse','HEAD^{tree}']), changes: git(['status','--short']) },
  environment: { platform: process.platform, arch: arch(), release: release(), node: process.version },
  authority: ['issue:20','docs/architecture/issues/15-euler-v1-spec.md#i19','docs/architecture/issues/10-choose-storage-projections.md'],
  observations, evidenceGaps, files: files(directory).map(path => ({ path, sha256: hash(readFileSync(join(directory,path))) })) };
writeFileSync(join(directory,'receipt.json'),JSON.stringify(receipt,null,2) + '\n');
console.log(JSON.stringify({ directory, status: receipt.status, cases: observations.length, failed: observations.filter(row => row.passed === false).length, unavailable: observations.filter(row => row.passed === null).length }));
if (failed) process.exitCode = 1;
