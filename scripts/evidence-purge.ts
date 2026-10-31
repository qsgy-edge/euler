import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { arch, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sha256 } from '@euler/core';
import type { PurgePresentation } from '@euler/core';
import { createSandbox } from '../apps/cli/src/sandbox.ts';
import { startCli, sendCommand } from '../apps/cli/src/process-driver.ts';

const fixturePath = 'fixtures/t21-purge-cases.json';
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { cases: string[] };
const directory = join('artifacts', 't21-' + Date.now()); mkdirSync(directory, { recursive: true });
console.log(JSON.stringify({ directory }));
const startedAt = new Date().toISOString(), observations: Record<string, unknown>[] = [], evidenceGaps: string[] = [];
let failed = false;
for (const scenario of fixture.cases) {
  const path = join(directory, scenario); mkdirSync(path);
  if (scenario === 'project-output' && process.platform !== 'win32') {
    const reason = 'controlled-project-output-host-unavailable-' + process.platform;
    evidenceGaps.push(reason); observations.push({ scenario, passed: null, reason }); continue;
  }
  const sandbox = createSandbox(), children: { name: string; cli: ReturnType<typeof startCli>; input: string[] }[] = [];
  const commands: object[] = [];
  let outputRoot: string | undefined;
  const run = (name: string, args: string[], expected = 0) => {
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    writeFileSync(join(path, name + '.stdout.jsonl'), result.stdout ?? '');
    writeFileSync(join(path, name + '.stderr.txt'), result.stderr ?? '');
    commands.push({ command: [process.execPath, ...args], exitCode: result.status, signal: result.signal, stdout: name + '.stdout.jsonl', stderr: name + '.stderr.txt' });
    assert.equal(result.error, undefined); assert.equal(result.status, expected, result.stderr + result.stdout);
    return result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  };
  const cli = (name: string, command: string, args: string[] = [], expected = 0) =>
    run(name, ['apps/cli/src/main.ts', command, '--sandbox', sandbox.root, ...args], expected);
  const start = (name: string, args: string[] = []) => {
    const child = startCli(['purge', '--sandbox', sandbox.root, ...args]);
    const log = { name, cli: child, input: [] as string[] }; children.push(log);
    commands.push({ command: [process.execPath, 'apps/cli/src/main.ts', 'purge', '--sandbox', sandbox.root, ...args], stdout: name + '.stdout.jsonl', stderr: name + '.stderr.txt', stdin: name + '.stdin.txt' });
    return child;
  };
  const send = (child: ReturnType<typeof startCli>, input: string, event: string) => {
    children.find(item => item.cli === child)!.input.push(input); return sendCommand(child, input, event);
  };
  const inspect = <T>(read: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(join(sandbox.root, 'probe.sqlite'), { readOnly: true });
    try { return read(db); } finally { db.close(); }
  };
  const fault = (sql: string, ...values: string[]) => {
    const db = new DatabaseSync(join(sandbox.root, 'probe.sqlite'));
    try { db.function('euler_store_writer', () => 1); db.prepare(sql).run(...values); } finally { db.close(); }
  };
  try {
    if (scenario === 'historian') cli('historian', 'historian');
    if (['broken-stream', 'broken-ledger'].includes(scenario)) cli('seed-request', 'run');
    if (scenario === 'project-output') {
      outputRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'euler-t21-output-')));
      run('project-output', ['apps/cli/test/support/backup-file-worker.ts', sandbox.root, outputRoot]);
    }
    const mode = ['shared', 'operations', 'rollback', 'discovery', 'conflict', 'historian', 'identity', 'project-output', 'bracket-text', 'ambiguous-column', 'ambiguous-ack', 'ambiguous-kind'].includes(scenario) ? scenario : 'separate';
    const seeded = run('seed', ['apps/cli/test/support/purge-worker.ts', sandbox.root, mode]).at(-1)!;
    let snapshotId: string | undefined;
    if (['backup', 'recovery'].includes(scenario)) {
      snapshotId = cli('backup', 'backup').find(event => event.event === 'backup-result').snapshot.id;
      if (scenario === 'recovery') cli('recovery', 'restore-snapshot', ['--snapshot', snapshotId!]);
    }
    if (scenario === 'postcondition-failure') fault('CREATE TRIGGER purge_test_ignore BEFORE DELETE ON memory_records BEGIN SELECT RAISE(IGNORE); END');
    if (scenario === 'unknown-carrier') writeFileSync(join(sandbox.root, 'unregistered-copy.json'), JSON.stringify(seeded.target));
    if (scenario === 'unhealthy-canonical') fault("UPDATE owner_fences SET health='failed'");
    if (scenario === 'broken-stream') { fault('DROP TRIGGER immutable_execution_events_update'); fault('UPDATE execution_events SET seq=seq+1'); }
    if (scenario === 'broken-ledger') { fault('DROP TRIGGER immutable_request_events_update'); fault("UPDATE request_events SET hash='broken' WHERE seq=1"); }
    cpSync(sandbox.root, join(path, 'before'), { recursive: true });
    const scenarioFlag = scenario === 'before-commit-exit' ? 'purge-before-commit'
      : scenario === 'unknown-after-commit' ? 'purge-after-commit' : scenario === 'unknown-response' ? 'purge-unknown' : 'success';
    let child = start('purge', ['--record', seeded.recordId, '--scenario', scenarioFlag]);
    if (scenario === 'unknown-carrier') {
      await child.waitFor('maintenance-blocked');
      assert.equal(child.observations.some(event => event.event === 'purge-preview'), false);
      await send(child, 'cancel', 'purge-cancelled'); assert.equal((await child.exit).code, 0);
      observations.push({ scenario, passed: true, commands, result: 'unregistered-carrier-blocked' }); continue;
    }
    if (['ambiguous-column', 'ambiguous-ack', 'ambiguous-kind', 'unhealthy-canonical', 'broken-stream', 'broken-ledger'].includes(scenario)) {
      const expected = scenario.startsWith('ambiguous-') ? 'purge-unqualified-source-reference'
        : scenario === 'unhealthy-canonical' ? 'store-integrity-failed' : scenario === 'broken-stream' ? 'stream-evidence-gap' : 'ledger-evidence-gap';
      assert.equal((await child.waitFor('purge-rejected')).reason, expected);
      assert.equal(child.observations.some(event => event.event === 'purge-preview'), false);
      assert.equal(inspect(db => db.prepare("SELECT count(*) n FROM memory_events WHERE kind='purge-logical-commit'").get()!.n), 0);
      assert.equal(inspect(db => db.prepare('SELECT count(*) n FROM memory_records WHERE record_id=?').get(seeded.recordId)!.n), 1);
      for (const file of readdirSync(join(path, 'before')).filter(file => file.endsWith('.jsonl')))
        assert.deepEqual(readFileSync(join(sandbox.root, file)), readFileSync(join(path, 'before', file)));
      await send(child, 'cancel', 'purge-cancelled'); assert.equal((await child.exit).code, 0);
      if (!scenario.startsWith('ambiguous-'))
        assert.equal(cli('blocked-unhealthy-runtime', 'run', [], 1).find(event => event.event === 'error').reason, 'store-integrity-failed');
      observations.push({ scenario, passed: true, commands, result: 'preflight-rejected', reason: expected }); continue;
    }
    let preview = await child.waitFor('purge-preview') as unknown as PurgePresentation;
    writeFileSync(join(path, 'preview.json'), JSON.stringify(preview, null, 2) + '\n');
    assert.equal(preview.manifest.schema, 'purge-manifest@1');
    assert.ok(preview.manifest.records.some(record => record.recordId === seeded.recordId));
    assert.equal(preview.manifest.records.length, scenario === 'conflict' ? 2 : 1);
    for (const role of ['source', 'owner-info']) assert.ok(preview.manifest.carriers.some(carrier => carrier.role === role));
    const sourceIds = preview.manifest.carriers.filter(carrier => carrier.role === 'source').flatMap(carrier => carrier.entries.map(entry => entry.id));
    for (const source of seeded.related) assert.ok(sourceIds.includes(source.eventId), source.eventId);
    assert.equal(sourceIds.includes(seeded.unrelated.eventId), false);
    if (scenario === 'historian') assert.ok(preview.manifest.database.some(item => item.table === 'compartments' && item.count > 0));
    if (scenario === 'discovery') for (const table of ['source_units', 'evolution_proposals', 'source_query_receipts'])
      assert.ok(preview.manifest.database.some(item => item.table === table && item.count > 0));
    if (scenario === 'project-output') assert.ok(preview.manifest.carriers.some(carrier => carrier.role === 'project-output'));
    if (scenario === 'identity') assert.equal(preview.manifest.carriers.some(carrier => carrier.file.path.endsWith('session-' + seeded.unrelatedBinding.sessionId + '.jsonl')), false);
    const files = [...preview.manifest.inventory.carriers.map(item => item.file), ...preview.manifest.backups.flatMap(item => item.files.map(file => file.file))];
    const hashes = files.map(file => ({ path: file.path, hash: sha256(readFileSync(file.path)) }));
    const oldReceipts = inspect(db => db.prepare('SELECT receipt_id,receipt_payload,receipt_hash FROM memory_events WHERE record_id=? AND receipt_payload IS NOT NULL').all(seeded.recordId));
    const attemptStates = inspect(db => db.prepare('SELECT attempt_id,assembly_id,ordinal,outcome,byte_length FROM request_attempts ORDER BY assembly_id,ordinal').all());
    const unchanged = () => { for (const file of hashes) assert.equal(sha256(readFileSync(file.path)), file.hash, file.path); };
    if (scenario === 'separate') {
      for (const input of ['同意', '永久删除并恢复', 'PURGE ' + preview.token + ' ' + randomUUID()])
        assert.equal((await send(child, input, 'purge-rejected')).reason, 'exact-live-purge-phrase-required');
    }
    if (scenario === 'before-commit-exit') {
      children.find(item => item.cli === child)!.input.push(preview.phrase); child.command(preview.phrase);
      await child.waitFor('purge-checkpoint'); child.child.kill('SIGKILL'); await child.exit;
      unchanged(); assert.equal(inspect(db => db.prepare("SELECT count(*) n FROM memory_events WHERE kind='purge-logical-commit'").get()!.n), 0);
      const old = preview;
      child = start('restarted-before-commit', ['--record', seeded.recordId]);
      preview = await child.waitFor('purge-preview') as unknown as PurgePresentation;
      assert.notEqual(preview.token, old.token);
      assert.equal((await send(child, old.phrase, 'purge-rejected')).reason, 'exact-live-purge-phrase-required');
    }
    if (['cancel', 'before-commit-exit'].includes(scenario)) {
      await send(child, 'cancel', 'purge-cancelled'); assert.equal((await child.exit).code, 0); unchanged();
      assert.equal(inspect(db => db.prepare('SELECT count(*) n FROM memory_records WHERE record_id=?').get(seeded.recordId)!.n), 1);
      cli('fresh-runtime', 'run');
      observations.push({ scenario, passed: true, commands, result: 'cancelled-new-epoch-open' }); continue;
    }
    if (scenario === 'stale-preview') {
      appendFileSync(join(sandbox.root, 'session.jsonl'), JSON.stringify({ schema: 'cli-input@1', eventId: randomUUID(), role: 'user', text: JSON.stringify({ recordId: seeded.recordId }) }) + '\n');
      const rejected = await send(child, preview.phrase, 'purge-rejected'); assert.equal(rejected.reason, 'purge-manifest-stale');
      assert.equal(inspect(db => db.prepare("SELECT count(*) n FROM memory_events WHERE kind='purge-logical-commit'").get()!.n), 0);
      const next = await send(child, 'acquire', 'purge-preview') as unknown as PurgePresentation;
      assert.notEqual(next.token, preview.token); assert.notEqual(next.digest, preview.digest);
      await send(child, 'cancel', 'purge-cancelled'); await child.exit;
      observations.push({ scenario, passed: true, commands, result: 'changed-manifest-needs-new-approval' }); continue;
    }
    if (scenario === 'postcondition-failure') {
      assert.equal((await send(child, preview.phrase, 'purge-rejected')).reason, 'purge-database-postcondition-failed');
      unchanged();
      assert.equal(inspect(db => db.prepare("SELECT count(*) n FROM memory_events WHERE kind='purge-logical-commit'").get()!.n), 0);
      assert.equal(inspect(db => db.prepare('SELECT count(*) n FROM memory_records WHERE record_id=?').get(seeded.recordId)!.n), 1);
      const next = await send(child, 'acquire', 'purge-preview') as unknown as PurgePresentation;
      assert.equal(next.digest, preview.digest); assert.notEqual(next.token, preview.token);
      await send(child, 'cancel', 'purge-cancelled'); await child.exit;
      observations.push({ scenario, passed: true, commands, result: 'rolled-back-no-external-deletion' }); continue;
    }
    children.find(item => item.cli === child)!.input.push(preview.phrase); child.command(preview.phrase);
    let result;
    if (scenario === 'unknown-after-commit') {
      const checkpoint = await child.waitFor('purge-checkpoint'); assert.equal(checkpoint.stage, 'after-commit');
      assert.equal(child.observations.some(event => event.event === 'purge-result'), false);
      child.child.kill('SIGKILL'); await child.exit;
      child = start('reconcile-unknown'); result = await child.waitFor('purge-result');
    } else result = await child.waitFor('purge-result');
    assert.equal(result.status, 'logical-commit'); assert.equal(result.cleanup, 'incomplete');
    assert.deepEqual(result.receipt, { schema: 'purge/logical-commit@1', operationId: preview.operationId, status: 'logical-commit' });
    unchanged();
    inspect(db => {
      assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 26);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      for (const record of preview.manifest.records) for (const table of ['memory_records', 'memory_revisions', 'memory_heads', 'provenance_refs', 'verification_runs', 'feedback_events', 'search_documents'])
        assert.equal(db.prepare('SELECT count(*) n FROM ' + table + ' WHERE record_id=?').get(record.recordId)!.n, 0, table);
      if (scenario !== 'conflict') assert.equal(db.prepare('SELECT count(*) n FROM memory_records WHERE record_id=?').get(seeded.otherId)!.n, 1);
      for (const receipt of oldReceipts) assert.deepEqual(db.prepare('SELECT receipt_id,receipt_payload,receipt_hash FROM memory_events WHERE receipt_id=?').get(receipt.receipt_id!), receipt);
      const attemptsAfter = db.prepare('SELECT attempt_id,assembly_id,ordinal,outcome,byte_length FROM request_attempts ORDER BY assembly_id,ordinal').all();
      assert.deepEqual(attemptsAfter.map(({ attempt_id, ...facts }) => facts), attemptStates.map(({ attempt_id, ...facts }) => facts));
      for (const [index, before] of attemptStates.entries()) {
        if (sourceIds.includes(String(before.attempt_id))) {
          assert.notEqual(attemptsAfter[index]!.attempt_id, before.attempt_id);
          for (const table of ['request_attempts', 'request_events', 'execution_events'])
            assert.equal(db.prepare(`SELECT count(*) n FROM ${table} WHERE attempt_id=?`).get(before.attempt_id!)!.n, 0);
        } else assert.equal(attemptsAfter[index]!.attempt_id, before.attempt_id);
      }
      const settled = db.prepare("SELECT * FROM memory_events WHERE kind='purge-logical-commit'").all(); assert.equal(settled.length, 1);
      assert.equal(settled[0]!.record_id, null); assert.equal(settled[0]!.payload, null); assert.equal(settled[0]!.source_event_id, null);
      const continuation = db.prepare("SELECT * FROM pending_operations WHERE kind='purge'").all(); assert.equal(continuation.length, 1);
      assert.equal(continuation[0]!.operation_id, preview.operationId); assert.equal(continuation[0]!.state, 'cleaning');
      const saved = JSON.parse(String(continuation[0]!.continuation));
      assert.deepEqual(saved.carriers, preview.manifest.carriers); assert.deepEqual(saved.backups, preview.manifest.backups);
      assert.equal(saved.records, undefined); assert.equal(saved.database, undefined);
      writeFileSync(join(path, 'logical-observation.json'), JSON.stringify({ receipt: settled, continuation, attempts: { before: attemptStates, after: attemptsAfter } }, null, 2) + '\n');
    });
    assert.equal((await send(child, preview.phrase, 'purge-settled')).operationId, preview.operationId);
    assert.equal((await send(child, 'cancel', 'purge-settled')).cleanup, 'incomplete');
    child.child.stdin.end(); assert.equal((await child.exit).code, 0);
    for (const command of ['run', 'remember', 'capture', 'backup']) assert.equal(cli('blocked-' + command, command, command === 'capture' ? ['--scenario', 'synthetic'] : [], 1).find(event => event.event === 'error').reason, 'admission-closed');
    if (snapshotId) cli('blocked-recovery', 'restore-snapshot', ['--snapshot', snapshotId], 1);
    const resumed = start('resumed'); assert.deepEqual((await resumed.waitFor('purge-result')).receipt, result.receipt);
    resumed.child.stdin.end(); assert.equal((await resumed.exit).code, 0); unchanged();
    observations.push({ scenario, passed: true, commands, operationId: preview.operationId, result: 'logical-commit', cleanup: 'incomplete',
      database: preview.manifest.database.map(({ table, count }) => ({ table, count })), carrierRoles: preview.manifest.carriers.map(carrier => carrier.role),
      retainedReceipts: oldReceipts.length, preservedAttempts: attemptStates.length });
  } catch (error) {
    failed = true; writeFileSync(join(path, 'verification-error.txt'), error instanceof Error ? error.stack ?? error.message : String(error));
    observations.push({ scenario, passed: false, commands });
  } finally {
    for (const child of children) {
      if (child.cli.child.exitCode === null && child.cli.child.signalCode === null) child.cli.child.kill('SIGKILL');
      await child.cli.exit;
      writeFileSync(join(path, child.name + '.stdout.jsonl'), child.cli.observations.map(event => JSON.stringify(event)).join('\n') + '\n');
      writeFileSync(join(path, child.name + '.stderr.txt'), child.cli.stderr());
      writeFileSync(join(path, child.name + '.stdin.txt'), child.input.join('\n') + '\n');
    }
    if (outputRoot) { cpSync(outputRoot, join(path, 'project-output'), { recursive: true }); rmSync(outputRoot, { recursive: true, force: true }); }
    cpSync(sandbox.root, join(path, 'after'), { recursive: true }); rmSync(sandbox.root, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ scenario, passed: observations.at(-1)!.passed }));
}
function files(path: string, prefix = ''): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(join(path, entry.name), prefix + entry.name + '/') : [prefix + entry.name]);
}
const git = (args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const receipt = { schema: 't21-logical-purge-receipt@1', synthetic: true, startedAt, completedAt: new Date().toISOString(),
  status: failed ? 'fail' : evidenceGaps.length ? 'evidence-gap' : 'pass', fixture: { path: fixturePath, sha256: sha256(readFileSync(fixturePath)) },
  implementation: { commit: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']), changes: git(['status', '--short']) },
  environment: { platform: process.platform, arch: arch(), release: release(), node: process.version },
  authority: ['issue:21', 'docs/architecture/issues/15-euler-v1-spec.md#i18', 'docs/architecture/issues/10-choose-storage-projections.md'],
  scope: 'Logical database commit and continuation for the implemented synthetic carriers; cleanup remains incomplete.',
  evidenceCopies: { owner: 'independent-synthetic-evidence-runner', path: directory, controlledByPurge: false },
  unverified: ['Physical source/Host/backup cleanup, SQLite main/WAL/free-page maintenance and final controlled-complete (T22b).'],
  observations, evidenceGaps, files: files(directory).map(path => ({ path, sha256: sha256(readFileSync(join(directory, path))) })) };
writeFileSync(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ directory, status: receipt.status, cases: observations.length, failed: observations.filter(row => row.passed === false).length }));
if (failed) process.exitCode = 1;
