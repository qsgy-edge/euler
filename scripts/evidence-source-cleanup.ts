import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { arch, release } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sha256 } from '@euler/core';
import type { PurgeContinuation, PurgePresentation } from '@euler/core';
import { createSandbox } from '../apps/cli/src/sandbox.ts';
import { startCli, sendCommand } from '../apps/cli/src/process-driver.ts';

const fixturePath = 'fixtures/t22a-source-cleanup.json';
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { cases: string[]; baseFixture: string };
const directory = join('artifacts', 't22a-' + Date.now()); mkdirSync(directory, { recursive: true });
const startedAt = new Date().toISOString(), observations: object[] = [], evidenceGaps: string[] = [];
let failed = false;
console.log(JSON.stringify({ directory }));
for (const scenario of fixture.cases) {
  const path = join(directory, scenario); mkdirSync(path);
  const sandbox = createSandbox(), commands: object[] = [], assertions: string[] = [];
  const children: { name: string; cli: ReturnType<typeof startCli>; input: string[]; startedAt: string }[] = [];
  const save = (name: string, value: unknown) => writeFileSync(join(path, name), JSON.stringify(value, null, 2) + '\n');
  const run = (name: string, args: string[], expected: number | 'crash' = 0) => {
    const start = new Date().toISOString();
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    writeFileSync(join(path, name + '.stdout.jsonl'), result.stdout ?? '');
    writeFileSync(join(path, name + '.stderr.txt'), result.stderr ?? '');
    commands.push({ command: [process.execPath, ...args], startedAt: start, completedAt: new Date().toISOString(),
      exitCode: result.status, signal: result.signal, stdout: name + '.stdout.jsonl', stderr: name + '.stderr.txt' });
    assert.equal(result.error, undefined);
    if (expected === 'crash') assert.ok(result.signal === 'SIGKILL' || result.status !== 0, result.stderr + result.stdout);
    else assert.equal(result.status, expected, result.stderr + result.stdout);
    return result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  };
  const start = (name: string, args: string[] = []) => {
    const cli = startCli(['purge', '--sandbox', sandbox.root, ...args]);
    const child = { name, cli, input: [] as string[], startedAt: new Date().toISOString() }; children.push(child);
    commands.push({ command: [process.execPath, 'apps/cli/src/main.ts', 'purge', '--sandbox', sandbox.root, ...args],
      startedAt: child.startedAt, stdout: name + '.stdout.jsonl', stderr: name + '.stderr.txt', stdin: name + '.stdin.txt', exit: name + '.exit.json' });
    return cli;
  };
  const send = (cli: ReturnType<typeof startCli>, line: string, event: string) => {
    children.find(child => child.cli === cli)!.input.push(line); return sendCommand(cli, line, event);
  };
  const inspect = <T>(read: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(join(sandbox.root, 'probe.sqlite'), { readOnly: true });
    try { return read(db); } finally { db.close(); }
  };
  try {
    if (scenario === 'historian') run('historian', ['apps/cli/src/main.ts', 'historian', '--sandbox', sandbox.root]);
    const mode = ['handoff', 'historian', 'identity'].includes(scenario) ? scenario : 'separate';
    const seeded = run('seed', ['apps/cli/test/support/purge-worker.ts', sandbox.root, mode]).at(-1)!;
    let snapshot: string | undefined, laterSource: string | undefined;
    if (scenario === 'backup' || scenario.startsWith('recovered-session')) snapshot = run('backup', ['apps/cli/src/main.ts', 'backup', '--sandbox', sandbox.root])
      .find(item => item.event === 'backup-result').snapshot.id;
    if (scenario.startsWith('recovered-session')) {
      const later = run('later-source', ['apps/cli/test/support/purge-recovered-source-worker.ts', sandbox.root, JSON.stringify(seeded.target.source)]).at(-1)!;
      laterSource = later.source.path;
      if (scenario === 'recovered-session-restore-crash') {
        const crashed = run('restore-crash', ['apps/cli/test/support/backup-worker.ts', sandbox.root, 'restore-crash', 'database'], 'crash');
        assert.equal(crashed.at(-1)!.point, 'database');
        const interrupted = inspect(db => ({ states: db.prepare('SELECT state FROM store_restores').all(),
          laterSessions: db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE session_id=?').get(later.binding.sessionId)!.count }));
        save('restore-interrupted.json', interrupted); cpSync(sandbox.root, join(path, 'restore-interrupted'), { recursive: true });
        assert.ok(interrupted.states.some(row => row.state === 'prepared')); assert.equal(interrupted.laterSessions, 0);
        assertions.push('After database replacement, a prepared recovery retains the later original owner and can resume after process exit.');
      }
      run('restore', ['apps/cli/src/main.ts', 'restore-snapshot', '--sandbox', sandbox.root, '--snapshot', snapshot!]);
    }
    const point = scenario === 'recovered-session-after-delete' ? 'after-delete' : scenario;
    const crash = ['before-delete', 'after-delete', 'after-ack', 'takeover'].includes(point);
    let child = start('purge', ['--record', seeded.recordId, '--scenario', crash && point !== 'takeover' ? 'source-' + point : 'success']);
    const preview = await child.waitFor('purge-preview') as unknown as PurgePresentation;
    save('preview.json', preview); cpSync(sandbox.root, join(path, 'before'), { recursive: true });
    const before = preview.manifest.inventory.carriers.map(carrier => ({ ...carrier, content: readFileSync(carrier.file.path) }));
    if (laterSource) {
      assert.ok(preview.manifest.carriers.some(carrier => carrier.file.path === laterSource && carrier.entries.length > 0));
      assertions.push('A post-snapshot session original retains its owner registration through recovery and is approved before logical commit.');
    }
    if (scenario === 'handoff') {
      assert.equal(seeded.documents.length, 5);
      for (const ref of seeded.documents) assert.ok(preview.manifest.carriers.some(carrier => carrier.role === 'source'
        && carrier.entries.some(entry => entry.id === ref.eventId)));
      assertions.push('Report versions, handoff, approved export and consuming-session excerpt are in the frozen deletion closure.');
    }
    const committed = await send(child, preview.phrase, 'purge-result');
    const logical = inspect(db => ({ receipt: db.prepare("SELECT * FROM memory_events WHERE kind='purge-logical-commit'").get(),
      operation: db.prepare("SELECT * FROM pending_operations WHERE kind='purge'").get() }));
    save('logical.json', logical);
    if (point === 'takeover') {
      child.child.stdin.end(); await child.exit; child = start('takeover', ['--scenario', 'source-takeover']);
    } else if (crash) child.command('cleanup-source');
    if (crash) {
      if (point !== 'takeover') children.find(item => item.cli === child)!.input.push('cleanup-source');
      assert.equal((await child.waitFor('purge-source-checkpoint')).stage, point);
      const rival = start('rival'); assert.equal((await rival.exit).code, 1);
      assert.ok(rival.observations.some(item => item.reason === 'maintenance-owned'));
      child.child.kill('SIGKILL'); await child.exit;
      cpSync(sandbox.root, join(path, 'interrupted'), { recursive: true });
      child = start('resumed'); assert.deepEqual((await child.waitFor('purge-result')).receipt, committed.receipt);
      assertions.push('A live coordinator prevents takeover; its observed process exit permits the same operation to resume.');
    }
    const cleaned = await send(child, 'cleanup-source', 'purge-source-result');
    assert.equal(cleaned.error, undefined); assert.equal(cleaned.cleanup, 'incomplete');
    assert.equal((cleaned.source as { status: string }).status, 'complete');
    assert.deepEqual(cleaned.receipt, committed.receipt);
    const fileObservations: object[] = [];
    for (const prior of before) {
      const actual = readFileSync(prior.file.path);
      const selected = preview.manifest.carriers.find(carrier => carrier.file.path === prior.file.path);
      if (prior.role !== 'source' || !selected) assert.deepEqual(actual, prior.content);
      else {
        const retained = actual.toString('utf8').trimEnd().split('\n').filter(line => line.trim().length);
        const lines = prior.content.toString('utf8').trimEnd().split('\n');
        const expected = lines.filter((line, index) => index === 0 || !selected.entries.some(entry => entry.id === JSON.parse(line).eventId));
        assert.deepEqual(retained, expected);
        for (const entry of selected.entries) assert.equal(actual.includes(Buffer.from(entry.id)), false);
      }
      fileObservations.push({ role: prior.role, file: prior.file, beforeHash: sha256(prior.content), afterHash: sha256(actual), bytes: actual.length });
    }
    assertions.push('Actual source bytes contain none of the selected entries; unrelated events and other carrier bytes are unchanged.');
    const after = inspect(db => {
      const row = db.prepare("SELECT continuation,continuation_hash FROM pending_operations WHERE kind='purge'").get()!;
      assert.equal(sha256(String(row.continuation)), row.continuation_hash);
      const continuation = JSON.parse(String(row.continuation)) as PurgeContinuation;
      assert.deepEqual(continuation.carriers, preview.manifest.carriers);
      assert.deepEqual(continuation.sources, preview.manifest.inventory.sources);
      assert.deepEqual(continuation.backups, preview.manifest.backups);
      assert.equal(continuation.sourceCleanup!.length, preview.manifest.carriers.filter(carrier => carrier.role === 'source').length);
      for (const work of continuation.sourceCleanup!) {
        assert.equal(work.ack!.hash, work.plan.afterHash);
        assert.equal(sha256(readFileSync(continuation.carriers[work.index]!.file.path)), work.ack!.hash);
      }
      assert.equal(db.prepare("SELECT count(*) n FROM memory_events WHERE kind='purge-logical-commit'").get()!.n, 1);
      assert.deepEqual(db.prepare("SELECT * FROM memory_events WHERE kind='purge-logical-commit'").get(), logical.receipt);
      assert.equal(db.prepare('SELECT state FROM owner_fences').get()!.state, 'cleaning');
      assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 25);
      return { continuation, logicalReceipt: logical.receipt, fence: 'cleaning', source: cleaned.source };
    });
    save('after-observation.json', { ...after, files: fileObservations });
    assertions.push('Durable acknowledgements match actual file identities and hashes; the logical receipt is unchanged and the fence remains cleaning.');
    assert.deepEqual(await send(child, 'cleanup-source', 'purge-source-result'), cleaned);
    child.child.stdin.end(); assert.equal((await child.exit).code, 0);
    const reopened = start('reopened'); assert.deepEqual((await reopened.waitFor('purge-result')).source, cleaned.source);
    reopened.child.stdin.end(); await reopened.exit;
    for (const command of ['run', 'capture', 'historian', 'backup']) {
      const result = run('blocked-' + command, ['apps/cli/src/main.ts', command, '--sandbox', sandbox.root,
        ...(command === 'capture' ? ['--scenario', 'synthetic'] : [])], 1);
      assert.ok(result.some(item => item.reason === 'admission-closed'));
    }
    if (snapshot) run('blocked-restore', ['apps/cli/src/main.ts', 'restore-snapshot', '--sandbox', sandbox.root, '--snapshot', snapshot], 1);
    assertions.push('Ordinary execution, derivation, backup and recovery remain blocked after source participant completion.');
    observations.push({ scenario, passed: true, assertions, commands, operationId: preview.operationId, source: cleaned.source, cleanup: 'incomplete' });
  } catch (error) {
    failed = true; writeFileSync(join(path, 'error.txt'), (error as Error).stack ?? String(error));
    observations.push({ scenario, passed: false, assertions, commands });
  } finally {
    for (const child of children) {
      if (child.cli.child.exitCode === null && child.cli.child.signalCode === null) child.cli.child.kill('SIGKILL');
      const exit = await child.cli.exit;
      save(child.name + '.exit.json', { ...exit, completedAt: new Date().toISOString() });
      writeFileSync(join(path, child.name + '.stdout.jsonl'), child.cli.observations.map(event => JSON.stringify(event)).join('\n') + '\n');
      writeFileSync(join(path, child.name + '.stderr.txt'), child.cli.stderr());
      writeFileSync(join(path, child.name + '.stdin.txt'), child.input.join('\n') + '\n');
    }
    cpSync(sandbox.root, join(path, 'after'), { recursive: true }); rmSync(sandbox.root, { recursive: true, force: true });
  }
  console.log(JSON.stringify(observations.at(-1)));
}
const contractCommand = ['--test', '--test-concurrency=1', 'apps/cli/test/purge-source-boundary.test.ts', 'apps/cli/test/purge-source-late.test.ts', 'apps/cli/test/purge-source-recovery.test.ts'];
const contractStarted = new Date().toISOString();
const contracts = spawnSync(process.execPath, contractCommand, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
writeFileSync(join(directory, 'contract-tests.stdout.txt'), contracts.stdout ?? '');
writeFileSync(join(directory, 'contract-tests.stderr.txt'), contracts.stderr ?? '');
if (contracts.status !== 0 || contracts.error) failed = true;
if (process.platform !== 'win32') evidenceGaps.push('Windows sharing-lock behavior requires the Windows run.');
if (process.getuid?.() === 0) evidenceGaps.push('Ordinary file permission withdrawal is not testable under root.');
const git = (args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const files = readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
  .map(entry => join(entry.parentPath, entry.name)).map(path => ({ path: path.slice(directory.length + 1), sha256: sha256(readFileSync(path)) }));
const receipt = { schema: 't22a-source-cleanup-receipt@1', synthetic: true, startedAt, completedAt: new Date().toISOString(),
  status: failed ? 'fail' : evidenceGaps.length ? 'evidence-gap' : 'pass',
  fixtures: [fixturePath, fixture.baseFixture].map(path => ({ path, sha256: sha256(readFileSync(path)) })),
  implementation: { commit: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']), changes: git(['status', '--short']) },
  environment: { platform: process.platform, arch: arch(), release: release(), node: process.version },
  authority: ['issue:22', 'docs/architecture/issues/15-euler-v1-spec.md#i18', 'docs/architecture/issues/10-choose-storage-projections.md'],
  scope: 'Source/archive participant cleanup and recovery in disposable synthetic stores; global cleanup remains incomplete.',
  evidenceCopies: { owner: 'independent-synthetic-evidence-runner', path: directory, controlledByPurge: false },
  unverified: ['Host/receiver/project-output and snapshot cleanup, SQLite main/WAL/free pages and controlled-complete belong to T22b.',
    'Power-loss or torn writes within an archive entry are not represented by process-boundary crash evidence.'],
  contractTests: { command: [process.execPath, ...contractCommand], startedAt: contractStarted, completedAt: new Date().toISOString(),
    exitCode: contracts.status, signal: contracts.signal, stdout: 'contract-tests.stdout.txt', stderr: 'contract-tests.stderr.txt' },
  observations, evidenceGaps, files };
writeFileSync(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ directory, status: receipt.status, cases: observations.length }));
if (failed) process.exitCode = 1;
