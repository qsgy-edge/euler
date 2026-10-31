import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { arch, release, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sha256 } from '@euler/core';
import type { PurgePresentation } from '@euler/core';
import { CountingTransport } from '../apps/cli/src/probe.ts';
import { createSandbox } from '../apps/cli/src/sandbox.ts';
import { startCli, sendCommand } from '../apps/cli/src/process-driver.ts';
import cases from '../fixtures/t22b-controlled-cleanup.json' with { type: 'json' };

const fixturePath = 'fixtures/t22b-controlled-cleanup.json';
const directory = join('artifacts', 't22b-' + Date.now()); mkdirSync(directory, { recursive: true });
const startedAt = new Date().toISOString(), observations: object[] = [], evidenceGaps: string[] = [];
let failed = false;
console.log(JSON.stringify({ directory }));
for (const scenario of cases.cases) {
  if (scenario === 'project-output' && process.platform !== 'win32') {
    evidenceGaps.push('Native project-output ownership is implemented only by the Windows file Host.');
    observations.push({ scenario, status: 'unavailable' }); continue;
  }
  const path = join(directory, scenario); mkdirSync(path);
  const sandbox = createSandbox(), commands: object[] = [];
  let project: string | undefined, cli: ReturnType<typeof startCli> | undefined, db: DatabaseSync | undefined;
  const input: string[] = [];
  const save = (name: string, value: unknown) => writeFileSync(join(path, name), JSON.stringify(value, null, 2) + '\n');
  const run = (name: string, args: string[], env?: NodeJS.ProcessEnv, crash = false) => {
    const start = new Date().toISOString();
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env });
    writeFileSync(join(path, name + '.stdout.jsonl'), result.stdout ?? ''); writeFileSync(join(path, name + '.stderr.txt'), result.stderr ?? '');
    commands.push({ command: [process.execPath, ...args], startedAt: start, completedAt: new Date().toISOString(),
      exitCode: result.status, signal: result.signal, stdout: name + '.stdout.jsonl', stderr: name + '.stderr.txt' });
    assert.equal(result.error, undefined);
    if (crash) assert.ok(result.signal === 'SIGKILL' || result.status !== 0, result.stderr);
    else assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  };
  const send = (line: string) => { input.push(line); return sendCommand(cli!, line, 'purge-result'); };
  try {
    if (scenario === 'historian') run('historian', ['apps/cli/src/main.ts', 'historian', '--sandbox', sandbox.root]);
    if (scenario === 'project-output') {
      project = realpathSync.native(mkdtempSync(join(tmpdir(), 'euler-t22b-output-')));
      run('file', ['apps/cli/test/support/backup-file-worker.ts', sandbox.root, project]);
      cpSync(join(project, 'result.md'), join(path, 'project-before.md'));
    }
    const mode = ['backup','staging-backup','retired-backup','migration-backup','recovery'].includes(scenario) ? 'separate' : scenario;
    const seeded = run('seed', ['apps/cli/test/support/purge-worker.ts', sandbox.root, mode]).at(-1)!;
    new CountingTransport(sandbox).send(seeded.target.content, { attemptId: randomUUID(), runId: randomUUID(),
      payloadHash: seeded.target.contentHash, byteLength: Buffer.byteLength(seeded.target.content) });
    if (scenario === 'backup' || scenario === 'recovery') {
      const snapshot = run('backup', ['apps/cli/src/main.ts', 'backup', '--sandbox', sandbox.root]).find(row => row.event === 'backup-result').snapshot;
      if (scenario === 'recovery') {
        run('later-session', ['apps/cli/test/support/purge-recovered-source-worker.ts', sandbox.root, JSON.stringify(seeded.target.source)]);
        run('restore', ['apps/cli/src/main.ts', 'restore-snapshot', '--sandbox', sandbox.root, '--snapshot', snapshot.id]);
      }
    }
    if (scenario === 'staging-backup') run('staging', ['apps/cli/src/main.ts', 'backup', '--sandbox', sandbox.root], {
      ...process.env, EULER_PURGE_TEST_POINT: 'staging-copy-after',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${new URL('../apps/cli/test/support/purge-fault-hook.ts', import.meta.url).href}`,
    }, true);
    if (scenario === 'retired-backup') run('retention', ['apps/cli/test/support/purge-backup-states-worker.ts', sandbox.root]);
    if (scenario === 'migration-backup') run('migration', ['apps/cli/test/support/backup-worker.ts', sandbox.root, 'migration-checkpoint']);
    db = new DatabaseSync(join(sandbox.root, 'probe.sqlite'), { readOnly: true });
    const snapshots = db.prepare('SELECT kind,state FROM store_snapshots').all();
    if (scenario === 'staging-backup') assert.ok(snapshots.some(row => row.state === 'staging'));
    if (scenario === 'retired-backup') assert.ok(snapshots.some(row => row.state === 'retired'));
    if (scenario === 'migration-backup') assert.ok(snapshots.some(row => row.kind === 'migration'));
    save('snapshot-states.json', snapshots);
    cli = startCli(['purge', '--sandbox', sandbox.root, '--record', seeded.recordId]);
    commands.push({ command: [process.execPath, 'apps/cli/src/main.ts', 'purge', '--sandbox', sandbox.root, '--record', seeded.recordId],
      stdout: 'purge.stdout.jsonl', stderr: 'purge.stderr.txt', stdin: 'purge.stdin.txt', exit: 'purge.exit.json' });
    const preview = await cli.waitFor('purge-preview') as unknown as PurgePresentation;
    save('preview.json', preview); cpSync(sandbox.root, join(path, 'before'), { recursive: true });
    const selected = (table: string, column: string) => (preview.manifest.database.find(item => item.table === table)?.rows ?? [])
      .map(row => String(db!.prepare(`SELECT ${column} FROM ${table} WHERE rowid=?`).get(row.rowid)![column]));
    const tokens = selected('host_presentations', 'token'), jobs = selected('capture_jobs', 'job_id');
    const logical = await send(preview.phrase); assert.equal(logical.status, 'logical-commit');
    const logicalRow = db.prepare("SELECT * FROM memory_events WHERE kind='purge-logical-commit'").get()!;
    save('logical.json', logicalRow);
    const complete = await send('cleanup'); assert.equal(complete.status, 'controlled-complete', JSON.stringify(complete));
    assert.equal((await cli.exit).code, 0, cli.stderr());
    assert.deepEqual(db.prepare("SELECT * FROM memory_events WHERE kind='purge-logical-commit'").get(), logicalRow);
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 26);
    assert.equal(db.prepare('PRAGMA quick_check').get()!.quick_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA freelist_count').get()!.freelist_count, 0);
    assert.equal(db.prepare('SELECT state FROM owner_fences').get()!.state, 'open');
    const operation = db.prepare("SELECT state,continuation,continuation_hash,presentation_hash FROM pending_operations WHERE kind='purge'").get()!;
    assert.equal(operation.state, 'committed');
    for (const key of ['continuation','continuation_hash','presentation_hash']) assert.equal(operation[key], null);
    for (const record of preview.manifest.records) assert.equal(db.prepare('SELECT count(*) n FROM memory_records WHERE record_id=?').get(record.recordId)!.n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM search_fts WHERE search_fts MATCH ?').get('"' + seeded.target.content.replaceAll('"', '""') + '"')!.n, 0);
    const canaries = [seeded.target.content, seeded.target.contentHash, seeded.target.source.locator, seeded.target.source.hash, preview.digest];
    const scans = readdirSync(sandbox.root).map(name => {
      const bytes = readFileSync(join(sandbox.root, name));
      for (const canary of canaries) assert.equal(bytes.includes(Buffer.from(canary)), false, `${scenario}/${name}`);
      return { path: name, bytes: bytes.length, sha256: sha256(bytes), canaryHits: 0 };
    });
    const wal = join(sandbox.root, 'probe.sqlite-wal');
    if (existsSync(wal)) cpSync(wal, join(path, 'wal-after.bin'));
    for (const backup of preview.manifest.backups) assert.equal(existsSync(backup.directory.path), false);
    if (project) assert.equal(existsSync(join(project, 'result.md')), false);
    const owners = { source: 'CliArchive', 'owner-info': 'OwnerInfoLog', receiver: 'CountingTransport', 'project-output': 'WindowsFileRoot' };
    save('after-observation.json', { complete, operation, freelistCount: 0, quickCheck: 'ok', foreignKeys: [], scans,
      inventory: preview.manifest.inventory.carriers.map(carrier => ({ ...carrier, owner: owners[carrier.role],
        selected: preview.manifest.carriers.some(selected => selected.file.path === carrier.file.path), status: 'verified' })),
      database: { owner: 'ProbeStore/applyLogicalPurge', tables: preview.manifest.inventory.tables },
      backups: preview.manifest.backups.map(backup => ({ directory: backup.directory, owner: 'removeSnapshotFiles', status: 'absent' })) });
    db.close(); db = undefined;
    cpSync(sandbox.root, join(path, 'after'), { recursive: true });
    const verified = run('non-resurrection', ['apps/cli/test/support/purge-complete-worker.ts', sandbox.root, JSON.stringify({
      target: seeded.target, otherId: seeded.otherId, removeOther: scenario === 'conflict', tokens, jobs,
      sources: [seeded.target.source, ...seeded.documents],
    })]).at(-1)!;
    assert.equal(verified.canaryHits, 0);
    const repeated = run('repeated', ['apps/cli/src/main.ts', 'purge', '--sandbox', sandbox.root]).at(-1)!;
    assert.deepEqual(repeated.receipt, complete.receipt);
    const clean = run('clean-backup', ['apps/cli/src/main.ts', 'backup', '--sandbox', sandbox.root]).find(row => row.event === 'backup-result');
    assert.equal(clean.status, 'created');
    observations.push({ scenario, status: 'pass', operationId: preview.operationId, commands, inventory: 'after-observation.json' });
  } catch (error) {
    failed = true; writeFileSync(join(path, 'error.txt'), (error as Error).stack ?? String(error));
    observations.push({ scenario, status: 'fail', commands });
  } finally {
    if (cli) {
      if (cli.child.exitCode === null && cli.child.signalCode === null) cli.child.kill('SIGKILL');
      save('purge.exit.json', await cli.exit);
      writeFileSync(join(path, 'purge.stdout.jsonl'), cli.observations.map(row => JSON.stringify(row)).join('\n') + '\n');
      writeFileSync(join(path, 'purge.stderr.txt'), cli.stderr()); writeFileSync(join(path, 'purge.stdin.txt'), input.join('\n') + '\n');
    }
    db?.close();
    cpSync(sandbox.root, join(path, 'final'), { recursive: true }); rmSync(sandbox.root, { recursive: true, force: true });
    if (project) rmSync(project, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ scenario, status: (observations.at(-1) as { status: string }).status }));
}
const contractCommand = ['--test', '--test-concurrency=1', 'apps/cli/test/purge-copies.test.ts', 'apps/cli/test/purge-project.test.ts',
  'apps/cli/test/purge-complete.test.ts', 'apps/cli/test/purge-faults.test.ts', 'apps/cli/test/purge-source-recovery.test.ts'];
const contractStarted = new Date().toISOString();
const contracts = spawnSync(process.execPath, contractCommand, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
writeFileSync(join(directory, 'contract-tests.stdout.txt'), contracts.stdout ?? '');
writeFileSync(join(directory, 'contract-tests.stderr.txt'), contracts.stderr ?? '');
if (contracts.status !== 0 || contracts.error) failed = true;
if (process.getuid?.() === 0) evidenceGaps.push('Ordinary file permission withdrawal is not testable under root.');
const git = (args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const files = readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
  .map(entry => join(entry.parentPath, entry.name)).map(path => ({ path: relative(directory, path).replaceAll('\\', '/'), sha256: sha256(readFileSync(path)) }));
const receipt = { schema: 't22b-controlled-cleanup-receipt@1', synthetic: true, startedAt, completedAt: new Date().toISOString(),
  status: failed ? 'fail' : evidenceGaps.length ? 'evidence-gap' : 'pass',
  fixtures: [fixturePath, ...cases.baseFixtures].map(path => ({ path, sha256: sha256(readFileSync(path)) })),
  implementation: { commit: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']), changes: git(['status', '--short']) },
  environment: { platform: process.platform, arch: arch(), release: release(), node: process.version },
  authority: ['issue:23', 'docs/architecture/issues/15-euler-v1-spec.md#i18', 'docs/architecture/issues/10-choose-storage-projections.md'],
  evidenceCopies: { owner: 'independent-synthetic-evidence-runner', path: directory, controlledByPurge: false },
  unverified: ['Power loss and torn writes within one archive entry are not process-boundary crash evidence.',
    'ENOSPC and SQLITE_FULL are injected at actual owner/SQLite boundaries; no physical volume is filled.'],
  contractTests: { command: [process.execPath, ...contractCommand], startedAt: contractStarted, completedAt: new Date().toISOString(),
    exitCode: contracts.status, signal: contracts.signal, stdout: 'contract-tests.stdout.txt', stderr: 'contract-tests.stderr.txt' },
  observations, evidenceGaps, files };
writeFileSync(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ directory, status: receipt.status, cases: observations.length }));
if (failed) process.exitCode = 1;
