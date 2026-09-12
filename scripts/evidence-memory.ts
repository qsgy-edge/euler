import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, release, arch } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { startCli } from '../apps/cli/src/process-driver.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const startedAt = new Date().toISOString();
const destination = join(repo, 'artifacts', `t02-${startedAt.replace(/[:.]/g, '-')}`);
mkdirSync(destination, { recursive: true });
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const fixtureBytes = readFileSync(join(repo, 'fixtures/scoped-memory.json'));
const fixture = JSON.parse(fixtureBytes.toString());
const sourceFixture = JSON.parse(readFileSync(join(repo, 'fixtures/first-turn.json'), 'utf8'));
const { ownerId, hostId, projectId, sessionId, branchId } = sourceFixture;
const binding = { ownerId, hostId, projectId, sessionId, branchId };
const assertions: { name: string; passed: boolean; error?: string }[] = [];
const processes: Record<string, unknown>[] = [];
let sqliteVersion = '';
function record(path: string, value: string | Buffer) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }
function verify(name: string, action: () => void) {
  try { action(); assertions.push({ name, passed: true }); }
  catch (error) { assertions.push({ name, passed: false, error: (error as Error).message }); }
}
function launch(name: string, args: string[]) {
  const driver = startCli(args);
  const chunks: Buffer[] = [];
  driver.child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  const exit = driver.exit.then(result => {
    record(join(destination, name, 'stdout.jsonl'), Buffer.concat(chunks));
    record(join(destination, name, 'stderr.txt'), driver.stderr());
    processes.push({ name, args, command: process.execPath, cwd: repo, ...result });
    return result;
  });
  void exit.catch(() => {});
  return { ...driver, exit };
}

// Independent raw verifier: no Store or Core hashing/recovery helpers.
function verifySnapshot(snapshot: string, corrected: boolean, reported: Record<string, any>) {
  const temp = mkdtempSync(join(tmpdir(), 'euler-t02-verify-'));
  try {
    for (const file of readdirSync(snapshot)) copyFileSync(join(snapshot, file), join(temp, file));
    const lines = readFileSync(join(temp, 'session.jsonl'), 'utf8').trimEnd().split('\n');
    const refs = new Map(lines.slice(1).map(line => {
      const source = JSON.parse(line);
      return [source.eventId, { schema: 'cli-source-ack@1', status: 'durable', binding, eventId: source.eventId,
        locator: `cli-jsonl@1/${sessionId}/${source.eventId}`, hash: digest(line), byteLength: Buffer.byteLength(line), contentHash: digest(source.text) }];
    }));
    const db = new DatabaseSync(join(temp, 'probe.sqlite'), { readOnly: true });
    try {
      sqliteVersion = String(db.prepare('SELECT sqlite_version() AS version').get()!.version);
      assert.deepEqual(db.prepare('PRAGMA quick_check').all().map(row => row.quick_check), ['ok']);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      const revisions = db.prepare('SELECT * FROM memory_revisions ORDER BY revision').all();
      assert.equal(revisions.length, corrected ? 2 : 1);
      assert.equal(revisions[0]!.content, fixture.memoryText);
      for (const row of revisions) {
        assert.equal(row.content_hash, digest(String(row.content)));
        assert.deepEqual(JSON.parse(String(row.source_json)), refs.get(row.source_event_id));
      }
      const events = db.prepare('SELECT * FROM memory_events ORDER BY origin_seq').all();
      assert.deepEqual(events.map(event => event.kind), corrected ? ['capture','verify','activate','correct'] : ['capture','verify','activate']);
      let previous: string | null = null;
      for (const [index, event] of events.entries()) {
        const payload = JSON.parse(String(event.payload));
        assert.equal(event.seq, index + 1);
        assert.equal(event.origin_seq, index + 1);
        assert.equal(event.origin_host_id, hostId);
        assert.equal(event.payload_hash, digest(String(event.payload)));
        assert.equal(event.before_snapshot, previous);
        assert.equal(JSON.stringify(payload.after), event.after_snapshot);
        assert.equal(payload.after.headEventId, event.event_id);
        assert.equal(payload.eventId, event.event_id);
        assert.equal(payload.request, event.request_hash);
        assert.equal(payload.before === null ? null : JSON.stringify(payload.before), event.before_snapshot);
        previous = String(event.after_snapshot);
      }
      const head = db.prepare('SELECT * FROM memory_heads').get()!;
      assert.equal(head.snapshot, previous);
      assert.equal(head.snapshot_hash, digest(previous!));
      const current = { ...JSON.parse(previous!), hash: head.snapshot_hash };
      assert.deepEqual(reported, current);
      assert.equal(current.content, corrected ? fixture.correctionText : fixture.memoryText);
      assert.equal(current.verification, corrected ? 'unverified' : 'verified');
      const outbox = db.prepare('SELECT * FROM projection_jobs').all();
      assert.equal(outbox.length, corrected ? 5 : 4);
      assert.equal(outbox.filter(row => row.kind === 'host-info').length, 1);
      for (const row of outbox) {
        const manifest = JSON.parse(String(row.payload));
        assert.equal(row.payload_hash, digest(String(row.payload)));
        assert.equal(manifest.events.length, 1);
        assert.equal(JSON.stringify(manifest.events[0]), events.find(event => event.event_id === row.event_id)!.payload);
        assert.equal(manifest.batchId, row.batch_id);
      }
      for (const run of db.prepare('SELECT * FROM verification_runs').all()) {
        assert.equal(run.evidence_hash, digest(String(run.evidence_json)));
        const evidence = JSON.parse(String(run.evidence_json));
        assert.equal(db.prepare('SELECT count(*) AS n FROM verification_evidence WHERE run_id=?').get(String(run.run_id))!.n, evidence.length);
        for (const ref of evidence) assert.deepEqual(ref, refs.get(ref.eventId));
      }
      const proposals = db.prepare('SELECT * FROM evolution_proposals ORDER BY version').all();
      assert.equal(proposals.length, 2);
      for (const [index, row] of proposals.entries()) {
        const payload = JSON.parse(String(row.payload));
        assert.equal(row.payload_hash, digest(String(row.payload)));
        assert.equal(payload.version, index + 1);
        assert.equal(payload.inert, true);
        assert.equal(payload.supersedes, index === 0 ? null : proposals[0]!.proposal_id);
        assert.equal(db.prepare('SELECT count(*) AS n FROM proposal_evidence WHERE proposal_id=?').get(String(row.proposal_id))!.n, 2);
        assert.deepEqual(payload.input, refs.get(fixture.sourceEventId));
      }
      assert.equal(db.prepare('SELECT count(*) AS n FROM intent_events').get()!.n, 1);
      assert.equal(db.prepare('SELECT count(*) AS n FROM projects').get()!.n, 1);
    } finally { db.close(); }
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

async function scenario(name: string) {
  let root: string | undefined;
  let worker: ReturnType<typeof launch> | undefined;
  let competitor: ReturnType<typeof launch> | undefined;
  try {
    const creation = launch(`${name}/create`, ['create']);
    assert.equal((await creation.exit).code, 0);
    root = String(creation.observations.find(row => row.event === 'sandbox')!.root);
    const setup = launch(`${name}/setup`, ['memory', '--sandbox', root]);
    assert.equal((await setup.exit).code, 0);
    const written = setup.observations.find(row => row.event === 'memory-result') as Record<string, any>;
    let recovered: Record<string, any> = written.activated.record;
    if (name === 'compete') {
      worker = launch(`${name}/writer-a`, ['memory-worker', '--scenario', name, '--sandbox', root]);
      competitor = launch(`${name}/writer-b`, ['memory-worker', '--scenario', name, '--sandbox', root]);
      const ready = await Promise.all([worker.waitFor('memory-ready'), competitor.waitFor('memory-ready')]);
      assert.deepEqual(ready[0]!.expected, ready[1]!.expected);
      worker.command('commit'); competitor.command('commit');
      const exits = await Promise.all([worker.exit, competitor.exit]);
      const observations = [...worker.observations, ...competitor.observations];
      verify('concurrent writers: one commit, one stale rejection', () => {
        assert.deepEqual(exits.map(exit => exit.code).sort(), [0, 1]);
        assert.equal(observations.filter(row => row.event === 'memory-written').length, 1);
        assert.equal(observations.filter(row => row.event === 'error' && row.reason === 'memory-stale').length, 1);
      });
      recovered = (observations.find(row => row.event === 'memory-written')!.result as Record<string, any>).record;
    } else if (name !== 'normal') {
      worker = launch(`${name}/writer`, ['memory-worker', '--scenario', name, '--sandbox', root]);
      await worker.waitFor('memory-ready');
      worker.command('commit');
      await worker.waitFor('memory-checkpoint');
      worker.child.kill('SIGKILL');
      assert.notEqual((await worker.exit).code, 0);
      const lookup = launch(`${name}/reconcile`, ['memory-reconcile', '--sandbox', root,
        '--record', recovered.recordId, '--expected', recovered.headEventId]);
      assert.equal((await lookup.exit).code, 0);
      const observation = lookup.observations.find(row => row.event === 'memory-reconciled') as Record<string, any>;
      verify(`${name}: query precedes any retry`, () => {
        assert.equal(worker!.observations.some(row => row.event === 'memory-written'), false);
        if (name === 'crash-in-transaction') { assert.equal(observation.operation, null); assert.deepEqual(observation.recovered, recovered); }
        else { assert.deepEqual(observation.operation.record, observation.recovered); assert.notEqual(observation.operation.eventId, recovered.headEventId); }
      });
      recovered = observation.recovered;
    } else {
      const reader = launch(`${name}/recover`, ['recover', '--sandbox', root]);
      assert.equal((await reader.exit).code, 0);
      const observed = reader.observations.find(row => row.event === 'recovered') as Record<string, any>;
      verify('separate process recovers source-backed intent and memory', () => {
        assert.deepEqual(observed.memories, [recovered]); assert.deepEqual(observed.intent, written.intent); assert.equal(observed.sends, 0);
      });
    }
    const snapshot = join(destination, name, 'snapshot');
    mkdirSync(snapshot, { recursive: true });
    for (const file of readdirSync(root)) copyFileSync(join(root, file), join(snapshot, file));
    const corrected = name === 'crash-after-commit' || name === 'compete';
    verify(`${name}: independently recomputed source/revision/event/head/outbox/proposal`, () => verifySnapshot(snapshot, corrected, recovered));
    if (name === 'normal') {
      verify('re-signed fabricated snapshot rejected against raw event history', () => {
        const changed: Record<string, unknown> = { ...recovered, content: 'forged content', contentHash: digest('forged content') };
        delete changed.hash;
        assert.throws(() => verifySnapshot(snapshot, false, { ...changed, hash: digest(JSON.stringify(changed)) }));
      });
    }
  } catch (error) {
    assertions.push({ name, passed: false, error: (error as Error).stack ?? String(error) });
  } finally {
    for (const process of [worker, competitor]) {
      if (process && process.child.exitCode === null && process.child.signalCode === null) { process.child.kill('SIGKILL'); await process.exit; }
    }
    if (root) rmSync(root, { recursive: true, force: true });
  }
}

const testArgs = ['--test', 'apps/cli/test/memory-store.test.ts', 'apps/cli/test/memory-recovery.test.ts'];
const tests = spawnSync(process.execPath, testArgs, { cwd: repo, encoding: 'utf8', timeout: 30000 });
record(join(destination, 'tests.stdout.txt'), tests.stdout ?? '');
record(join(destination, 'tests.stderr.txt'), tests.stderr ?? '');
verify('Store, constraints, concurrency, crash and rollback tests', () => assert.equal(tests.status, 0, tests.stderr));
for (const name of ['normal', 'crash-in-transaction', 'crash-after-commit', 'compete']) await scenario(name);
const git = (...args: string[]) => execFileSync('git', ['--no-optional-locks', ...args], { cwd: repo, encoding: 'utf8' }).trim();
function files(dir: string): { path: string; sha256: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name))
    : [{ path: relative(destination, join(dir, entry.name)).replaceAll('\\', '/'), sha256: digest(readFileSync(join(dir, entry.name))) }]);
}
const summary = {
  schema: 'euler-t02-evidence@1', startedAt, finishedAt: new Date().toISOString(),
  implementationCommit: git('rev-parse','HEAD'), implementationTree: git('rev-parse','HEAD^{tree}'), workingTree: git('status','--short'),
  environment: { platform: process.platform, release: release(), architecture: arch(), node: process.version, sqlite: sqliteVersion },
  fixture: { path: 'fixtures/scoped-memory.json', digest: digest(JSON.stringify(fixture)), rawDigest: digest(fixtureBytes), mode: 'synthetic-only', heldOut: false },
  sourceFixtureDigest: digest(JSON.stringify(sourceFixture)), testCommand: [process.execPath, ...testArgs], testExitCode: tests.status,
  processes, assertions, files: files(destination), status: assertions.every(assertion => assertion.passed) ? 'pass' : 'fail',
  evidenceGaps: ['Semantic qualification/independent model verifier (later Core)', 'Production data roots, physical purge and live owner switch',
    'Power loss and unsupported OS runtime results', 'Full X-01: pending/ledger/Host consumers belong to their tickets'],
};
record(join(destination, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ artifact: destination, status: summary.status, assertions: assertions.length, failures: assertions.filter(row => !row.passed).length }));
if (summary.status !== 'pass') process.exitCode = 1;
