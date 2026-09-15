import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { arch, hostname, platform, release, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { ProbeStore } from '@euler/core';
import { openProbe } from '../apps/cli/src/probe.ts';
import { bindingOf, createSandbox, fixture, fixtureDigest, resourcesOf } from '../apps/cli/src/sandbox.ts';
import { startCli } from '../apps/cli/src/process-driver.ts';

const repo = fileURLToPath(new URL('../', import.meta.url));
const startedAt = new Date().toISOString();
const destination = join(repo, 'artifacts', `t03-${startedAt.replace(/[:.]/g, '-')}`);
mkdirSync(destination, { recursive: true });
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const git = (...args: string[]) => execFileSync('git', ['--no-optional-locks', ...args], { cwd: repo, encoding: 'utf8' }).trim();
const files: { path: string; sha256: string }[] = [];
const cases: Record<string, unknown>[] = [];
const assertions: { name: string; passed: boolean; error?: string }[] = [];
function record(path: string, bytes: string | Buffer) {
  writeFileSync(path, bytes);
  files.push({ path: relative(destination, path).replaceAll('\\', '/'), sha256: digest(readFileSync(path)) });
}
function verify(name: string, action: () => void) {
  try { action(); assertions.push({ name, passed: true }); }
  catch (error) { assertions.push({ name, passed: false, error: (error as Error).message }); }
}

// Raw SQL verifier uses a private snapshot copy, never Core read methods or a
// summary produced by the system under test. Opening SQLite may create sidecars.
function rawSnapshot(snapshot: string, check: (db: DatabaseSync) => void) {
  const temporary = mkdtempSync(join(tmpdir(), 'euler-t03-verify-'));
  try {
    for (const name of ['probe.sqlite', 'probe.sqlite-wal', 'probe.sqlite-shm']) {
      if (existsSync(join(snapshot, name))) copyFileSync(join(snapshot, name), join(temporary, name));
    }
    const db = new DatabaseSync(join(temporary, 'probe.sqlite'), { readOnly: true });
    try {
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
      assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 9);
      const streams = db.prepare('SELECT * FROM execution_streams').all();
      assert.ok(streams.length > 0);
      for (const stream of streams) {
        assert.equal(stream.principal_id, fixture.ownerId);
        assert.equal(stream.origin_host_id, fixture.hostId);
        assert.equal(stream.project_id, fixture.projectId);
        assert.equal(stream.authorization_kind, 'synthetic-host-command');
        assert.match(String(stream.authorization_id), /^[0-9a-f-]{36}$/);
      }
      const manifest = JSON.parse(readFileSync(join(snapshot, 'sandbox.json'), 'utf8'));
      for (const row of db.prepare('SELECT * FROM owner_activities').all()) {
        assert.equal(row.store_id, manifest.storeId);
        assert.equal(row.root_path, manifest.root);
        assert.equal(row.root_dev, manifest.rootIdentity.dev);
        assert.equal(row.root_ino, manifest.rootIdentity.ino);
        if (row.pid !== null) {
          assert.ok(Number(row.pid) > 0);
          assert.match(String(row.incarnation), /^[0-9a-f-]{36}$/);
          assert.ok(Number.isFinite(Date.parse(String(row.started_at))));
        }
      }
      assert.equal(db.prepare(`SELECT count(*) AS count FROM
        (SELECT run_id FROM execution_events GROUP BY run_id HAVING count(DISTINCT stream_id)>1)`).get()!.count, 0);
      check(db);
    } finally { db.close(); }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

async function runCase(name: string) {
  const sandbox = createSandbox();
  const path = join(destination, name);
  mkdirSync(path);
  const children: { name: string; args: string[]; proc: ReturnType<typeof startCli> }[] = [];
  const start = (label: string, command: string, extraArgs: string[] = []) => {
    const args = [command, '--sandbox', sandbox.root, ...extraArgs];
    const proc = startCli(args);
    children.push({ name: label, args, proc });
    return proc;
  };
  let store: ProbeStore | undefined;
  const started = new Date().toISOString();
  let error: string | null = null;
  try {
    if (name === 'ownership') {
      const run = start('session', 'run');
      assert.equal((await run.exit).code, 0);
      const receipt = run.observations.find(item => item.event === 'run-result')!.receipt as Record<string, string>;
      const attempts = ['job', 'migration'].map(kind => {
        const id = randomUUID();
        const probe = openProbe(sandbox, undefined, { kind: kind as 'job' | 'migration', id, authorizationId: id });
        try {
          const sent = probe.session.dispatch(probe.session.prepare(fixture.eventId, fixture.text));
          verify(`${kind}: sent receipt agrees with durable owner`, () => {
            const durable = probe.store.readAttempt(probe.activity, sent.attemptId)!;
            assert.equal(sent.ownerKind, kind);
            assert.equal(sent.ownerId, id);
            assert.equal(sent.ownerKind, durable.ownerKind);
            assert.equal(sent.ownerId, durable.ownerId);
            assert.equal(probe.transport.count, 1);
          });
          return sent;
        } finally { probe.close(); }
      });
      record(join(path, 'ownership.json'), JSON.stringify({ receipt, attempts }, null, 2));
      const restart = start('fresh-process-query', 'maintenance-status');
      assert.equal((await restart.exit).code, 0);
      const status = restart.observations.find(item => item.event === 'maintenance-status')!;
      verify('fresh process recovers session/job/migration stream owners', () => {
        const streams = status.streams as { streamId: string; ownerId: string; ownerKind: string }[];
        assert.equal(streams.find(stream => stream.streamId === receipt.streamId)?.ownerId, fixture.sessionId);
        for (const attempt of attempts) assert.equal(streams.find(stream => stream.streamId === attempt.streamId)?.ownerId, attempt.ownerId);
        assert.deepEqual(streams.map(stream => stream.ownerKind).sort(), ['job', 'migration', 'session']);
      });
    } else if (name === 'unknown-launch') {
      store = new ProbeStore(resourcesOf(sandbox), sandbox.storeId, bindingOf(sandbox));
      const activity = store.register();
      const reservation = store.reserveChild(activity);
      record(join(path, 'reserved-launch.json'), JSON.stringify({ parentId: activity.id, reservation }));
      store.close(); store = undefined;
      const maintenance = start('coordinator', 'maintain');
      const blocked = await maintenance.waitFor('maintenance-blocked');
      verify('missing controlled launch acknowledgement blocks exclusive', () => {
        assert.equal(blocked.acquired, false);
        assert.ok((blocked.observations as { id: string; state: string }[]).some(row => row.id === reservation && row.state === 'unknown'));
      });
      maintenance.command('cancel');
      assert.equal((await maintenance.exit).code, 0);
    } else if (name === 'residual') {
      writeFileSync(join(sandbox.root, 'unregistered-worker.lock'), 'synthetic unexplained residual');
      const maintenance = start('coordinator', 'maintain');
      const blocked = await maintenance.waitFor('maintenance-blocked');
      verify('unexplained residual blocks exclusive with no automatic deletion', () => {
        assert.equal(blocked.acquired, false);
        assert.equal(readFileSync(join(sandbox.root, 'unregistered-worker.lock'), 'utf8'), 'synthetic unexplained residual');
        assert.ok((blocked.residuals as { path: string; state: string }[]).some(row => row.path === 'unregistered-worker.lock' && row.state === 'unexpected'));
      });
      maintenance.command('cancel');
      assert.equal((await maintenance.exit).code, 0);
    } else if (name === 'child-race') {
      store = new ProbeStore(resourcesOf(sandbox), sandbox.storeId, bindingOf(sandbox));
      const runtime = start('runtime', 'hold', ['--wait-child-launch']);
      const reserved = await runtime.waitFor('child-reserved');
      const reservation = store.maintenanceStatus().activities.find(row => row.id === reserved.reservationId)!;
      assert.ok(reservation, 'controlled launch reservation observed');
      assert.equal(reservation.pid, null);
      assert.equal(reservation.launchPid, null);
      record(join(path, 'reserved-launch.json'), JSON.stringify(reservation));
      const coordinator = randomUUID();
      const closing = store.beginMaintenance(coordinator);
      runtime.command('launch');
      const childExit = await runtime.waitFor('controlled-task-exit');
      const parentExit = await runtime.waitFor('process-exit');
      const acquired = store.acquireMaintenance(coordinator);
      record(join(path, 'exit-settlement.json'), JSON.stringify({ closing, childExit, parentExit, acquired }, null, 2));
      verify('refused child and parent exit, then known launch settles to exclusive', () => {
        assert.equal(childExit.code, 1);
        assert.equal(parentExit.code, 1);
        assert.equal(acquired.acquired, true);
        assert.ok(acquired.observations.some(row => row.id === reservation.id && row.pid === childExit.pid && row.absent));
      });
      store.releaseMaintenance(coordinator);
      store.close(); store = undefined;
      const resumed = start('resumed-run', 'run');
      assert.equal((await resumed.exit).code, 0);
      assert.equal(resumed.observations.find(row => row.event === 'run-result')?.sends, 1);
    } else {
      const runtime = start('runtime', 'hold');
      await runtime.waitFor('runtime-ready');
      const maintenance = start('coordinator', 'maintain');
      const blocked = await maintenance.waitFor('maintenance-blocked');
      assert.equal(blocked.acquired, false);
      const refused = start('refused-start', 'run');
      assert.equal((await refused.exit).code, 1);
      assert.match(JSON.stringify(refused.observations), /admission-closed/);
      if (name === 'cancel') {
        maintenance.command('cancel');
        await maintenance.waitFor('maintenance-cancelled');
        assert.equal((await maintenance.exit).code, 0);
      }
      runtime.command('append');
      assert.equal((await runtime.waitFor('late-append-blocked')).reason, 'admission-closed');
      runtime.command('stop');
      assert.equal((await runtime.exit).code, 0);
      if (name === 'takeover') {
        maintenance.command('inspect');
        const before = await maintenance.waitFor('maintenance-status');
        maintenance.child.kill();
        assert.notEqual((await maintenance.exit).code, 0);
        const successor = start('successor', 'maintain');
        const exclusive = await successor.waitFor('maintenance-exclusive');
        assert.equal(exclusive.acquired, true);
        successor.command('inspect');
        const after = await successor.waitFor('maintenance-status');
        verify('stopped coordinator takeover preserves owning stream', () => assert.deepEqual(after.coordinatorStream, before.coordinatorStream));
        successor.command('release');
        assert.equal((await successor.exit).code, 0);
      } else if (name === 'release') {
        maintenance.command('acquire');
        await maintenance.waitFor('maintenance-exclusive');
        maintenance.command('release');
        assert.equal((await maintenance.exit).code, 0);
      }
      const resumed = start('resumed-run', 'run');
      assert.equal((await resumed.exit).code, 0);
      verify(`${name}: refused old work and successful fresh epoch`, () => assert.equal(resumed.observations.find(row => row.event === 'run-result')!.sends, 1));
    }
  } catch (failure) { error = (failure as Error).stack ?? String(failure); }
  finally {
    store?.close();
    for (const child of children) {
      if (child.proc.child.exitCode === null && child.proc.child.signalCode === null) child.proc.child.kill();
      await child.proc.exit.catch(() => {});
      record(join(path, `${child.name}.jsonl`), child.proc.observations.map(row => JSON.stringify(row)).join('\n') + '\n');
      record(join(path, `${child.name}.stderr.txt`), child.proc.stderr());
    }
    const snapshot = join(path, 'sandbox');
    mkdirSync(snapshot);
    for (const name of readdirSync(sandbox.root)) record(join(snapshot, name), readFileSync(join(sandbox.root, name)));
    verify(`${name}: raw canonical ownership, stop and residual evidence`, () => rawSnapshot(snapshot, db => {
      const fence = db.prepare('SELECT * FROM owner_fences').get()!;
      assert.equal(fence.state, 'open');
      if (name === 'ownership') {
        const expected = JSON.parse(readFileSync(join(path, 'ownership.json'), 'utf8'));
        const rows = db.prepare(`SELECT e.*,s.owner_kind,s.owner_id FROM execution_events e
          JOIN execution_streams s ON s.stream_id=e.stream_id`).all();
        assert.equal(rows.length, 3);
        for (const attempt of [expected.receipt, ...expected.attempts]) {
          const row = rows.find(row => row.attempt_id === attempt.attemptId)!;
          assert.equal(row.stream_id, attempt.streamId);
          assert.equal(row.owner_id, attempt.ownerId);
          assert.equal(row.owner_kind, attempt.ownerKind);
        }
      } else if (name === 'unknown-launch') {
        assert.equal(db.prepare("SELECT count(*) AS count FROM owner_activities WHERE pid IS NULL AND stop_state='unknown' AND parent_id IS NOT NULL").get()!.count, 1);
      } else if (name === 'residual') {
        assert.equal(db.prepare("SELECT state FROM maintenance_residuals WHERE path='unregistered-worker.lock'").get()!.state, 'unexpected');
      } else if (name !== 'cancel') {
        const rows = db.prepare(`SELECT a.*,s.owner_kind FROM owner_activities a JOIN execution_streams s ON s.stream_id=a.stream_id
          WHERE a.stop_state='absent'`).all();
        assert.ok(rows.some(row => row.owner_kind === 'session'));
        assert.ok(rows.some(row => row.owner_kind === 'job' && row.parent_id !== null));
        if (name === 'takeover') assert.ok(rows.some(row => row.owner_kind === 'maintenance'));
        assert.ok(rows.every(row => row.stop_method === 'node-process-kill-0/ESRCH' && Number.isFinite(Date.parse(String(row.stop_observed_at)))));
        assert.equal(db.prepare("SELECT count(*) AS count FROM maintenance_residuals WHERE state!='expected'").get()!.count, 0);
      }
    }));
    cases.push({ name, startedAt: started, finishedAt: new Date().toISOString(), error,
      commands: children.map(child => ({ name: child.name, command: [process.execPath, 'apps/cli/src/main.ts', ...child.args] })) });
    rmSync(sandbox.root, { recursive: true, force: true });
  }
}

for (const name of ['ownership', 'release', 'cancel', 'takeover', 'unknown-launch', 'residual', 'child-race']) await runCase(name);
const db = new DatabaseSync(':memory:');
const sqliteVersion = db.prepare('SELECT sqlite_version() AS version').get()!.version;
db.close();
const log = join(repo, 'artifacts', 'verification.log');
if (existsSync(log)) record(join(destination, 'verification.log'), readFileSync(log));
const status = cases.some(item => item.error) ? 'evidence-gap' : assertions.every(item => item.passed) ? 'pass' : 'fail';
const summary = {
  experimentId: 'T03-process-maintenance', schemaVersion: 1, specCommit: 'a3f253f9bef0415364b3b224e5eb4ba150111325',
  implementationCommit: git('rev-parse', 'HEAD'), implementationTree: git('rev-parse', 'HEAD^{tree}'), workingChanges: git('status', '--porcelain'),
  environment: { platform: platform(), release: release(), arch: arch(), host: hostname(), node: process.version, sqlite: sqliteVersion,
    runner: process.env.ImageOS ?? 'local', adapter: 'euler-p0@1', provider: 'local-counting', model: 'none' },
  fixture: { path: 'fixtures/first-turn.json', digest: fixtureDigest, rawFileDigest: digest(readFileSync(join(repo, 'fixtures/first-turn.json'))),
    heldOut: 'not-applicable: deterministic synthetic development fixture' },
  startedAt, finishedAt: new Date().toISOString(), status, cases, assertions, files,
  scope: 'T03 disposable stream ownership, process registration, controlled child, cancellation, exclusive release, coordinator takeover, unknown launch, refused-child recovery and residual evidence on this environment. No real model/provider, production root, full ledger, physical purge, OS sandbox or power-loss acceptance.',
};
record(join(destination, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ artifact: destination, status, assertions: assertions.length, failures: assertions.filter(item => !item.passed).length }));
if (status !== 'pass') process.exitCode = 1;
