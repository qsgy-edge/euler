import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { release, arch } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { API_VERSION, ProbeSession, sha256 } from '@euler/core';
import { bindingOf, createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

const worker = fileURLToPath(new URL('../../../scripts/request-ledger-worker.ts', import.meta.url));
const evidenceDirectory = fileURLToPath(new URL(`../../../artifacts/t06-crash-${process.platform}-${Date.now()}/`, import.meta.url));
mkdirSync(evidenceDirectory, { recursive: true });
const implementationCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const implementationStatus = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
const implementationDiffHash = sha256(execFileSync('git', ['diff', 'HEAD'], { encoding: 'utf8' }));
const points = ['assembly-before', 'assembly-appended', 'assembly-after', 'started-before', 'started-appended', 'started-after', 'received', 'finished-before', 'finished-appended', 'finished-after', 'normal'];
for (const kind of ['session', 'job', 'maintenance', 'migration'] as const) for (const point of points) {
  test(`real ${kind} process crash at ${point} has independently recomputable ledger`, { timeout: 15000 }, async t => {
    const sandbox = createSandbox();
    const ownerId = randomUUID();
    const child = spawn(process.execPath, [worker, sandbox.root, kind, ownerId, point], { stdio: 'pipe', windowsHide: true });
    let stderr = '';
    child.stderr.on('data', value => { stderr += value; });
    const output: Record<string, unknown>[] = [];
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject); child.once('close', resolve);
    });
    void exited.catch(() => {});
    const lines = createInterface({ input: child.stdout });
    let killed = false;
    lines.on('line', line => {
      const value = JSON.parse(line) as Record<string, unknown>;
      output.push(value);
      if (value.event === 'checkpoint') { killed = true; child.kill('SIGKILL'); }
    });
    const guard = setTimeout(() => child.kill('SIGKILL'), 10000);
    try {
      const code = await exited;
      clearTimeout(guard);
      assert.ok(output.some(item => item.event === 'ready'), stderr);
      assert.equal(killed, point !== 'normal', stderr);
      if (point === 'normal') assert.equal(code, 0, stderr);
      const runId = String(output.find(item => item.event === 'ready')!.runId);
      const db = new DatabaseSync(join(sandbox.root, 'probe.sqlite'), { readOnly: true });
      let assemblies: Record<string, unknown>[];
      let attempts: Record<string, unknown>[];
      let events: Record<string, unknown>[];
      let databaseMetadata: object;
      try {
        assert.deepEqual(db.prepare('PRAGMA quick_check').all().map(row => row.quick_check), ['ok']);
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
        databaseMetadata = { sqliteVersion: db.prepare('SELECT sqlite_version() AS version').get()!.version,
          schemaVersion: db.prepare('PRAGMA user_version').get()!.user_version,
          journalMode: db.prepare('PRAGMA journal_mode').get()!.journal_mode,
          synchronous: db.prepare('PRAGMA synchronous').get()!.synchronous,
          run: db.prepare('SELECT * FROM request_runs WHERE run_id=?').get(runId),
          owner: db.prepare('SELECT * FROM execution_streams WHERE stream_id=(SELECT stream_id FROM request_runs WHERE run_id=?)').get(runId) };
        assemblies = db.prepare('SELECT * FROM request_assemblies WHERE run_id=?').all(runId);
        attempts = db.prepare('SELECT * FROM request_attempts WHERE run_id=?').all(runId);
        events = db.prepare('SELECT * FROM request_events WHERE run_id=? ORDER BY seq').all(runId);
        for (const [index, event] of events.entries()) {
          assert.equal(event.seq, index + 1);
          assert.equal(event.hash, sha256(String(event.payload)));
        }
        assert.equal(db.prepare('SELECT owner_kind FROM request_runs WHERE run_id=?').get(runId)!.owner_kind, kind);
      } finally { db.close(); }
      const receiverPath = join(sandbox.root, 'counting-receiver.jsonl');
      const receiverBytes = readFileSync(receiverPath, 'utf8');
      const receiver = receiverBytes.trim().split('\n').slice(1).map(line => JSON.parse(line).record);
      const sent = ['received', 'finished-before', 'finished-appended', 'finished-after', 'normal'].includes(point);
      const started = !['assembly-before', 'assembly-appended', 'assembly-after', 'started-before', 'started-appended'].includes(point);
      const finished = ['finished-after', 'normal'].includes(point);
      assert.equal(receiver.length, sent ? 1 : 0);
      assert.equal(assemblies.length, ['assembly-before', 'assembly-appended'].includes(point) ? 0 : 1);
      assert.equal(attempts.length, started ? 1 : 0);
      assert.equal(events.filter(e => e.kind === 'model/request-attempt-started@v1').length, started ? 1 : 0);
      assert.equal(events.filter(e => e.kind === 'model/request-attempt-finished@v1').length, finished ? 1 : 0);
      if (sent) assert.equal(receiver[0].payloadHash, attempts[0]!.payload_hash);
      if (started) assert.equal(attempts[0]!.outcome, finished ? 'received' : 'unknown-sent');
      const probe = openProbe(sandbox, undefined, kind === 'session' ? undefined : { kind, id: ownerId, authorizationId: ownerId }, undefined, undefined, true);
      try {
        const recovered = probe.store.requestStatus(probe.activity, runId);
        assert.equal(probe.transport.count, 0);
        if (started && !finished) {
          assert.equal(recovered.assemblies[0]!.state, 'unknown-sent');
          assert.throws(() => probe.session, /request-recovery-required/);
          const reconciled = probe.store.reconcileRequestAttempt(probe.activity, recovered.attempts[0]!.attemptId);
          const observation = JSON.parse(reconciled.events.at(-1)!.payload).evidence;
          assert.equal(observation.outcome, sent ? 'received' : 'not-received');
          assert.equal(reconciled.attempts[0]!.outcome, 'unknown-sent');
          probe.store.sealRequestRun(probe.activity, runId);
          const host = { version: API_VERSION, binding: bindingOf(sandbox), source: probe.archive, transport: probe.transport } as const;
          if (sent) assert.throws(() => new ProbeSession(probe.store, probe.activity, host, undefined,
            { relatedRunId: runId, acceptDuplicateRisk: false }), /duplicate-risk-approval-required/);
          else {
            const resumed = new ProbeSession(probe.store, probe.activity, host, undefined,
              { relatedRunId: runId, acceptDuplicateRisk: false });
            assert.equal(resumed.dispatch(resumed.prepare(sandbox.fixture.eventId, sandbox.fixture.text)).outcome, 'received');
            resumed.close();
          }
        }
      } finally { probe.close(); }
      const rawEvidence = JSON.stringify({ schema: 'dispatch-barriers@v1', kind, point, runId,
        fixtureDigest: sandbox.fixtureDigest, platform: process.platform, node: process.version,
        implementationCommit, implementationStatus, implementationDiffHash, osRelease: release(), architecture: arch(),
        runner: process.env.GITHUB_ACTIONS ? { kind: 'github-actions', runId: process.env.GITHUB_RUN_ID } : { kind: 'local' },
        database: databaseMetadata, sandbox, sourceSnapshot: readFileSync(join(sandbox.root, 'session.jsonl'), 'utf8'),
        receiverBytes, assemblies, attempts, events, receiver, processObservations: output }, null, 2);
      const artifact = join(evidenceDirectory, `${kind}-${point}.json`);
      writeFileSync(artifact, rawEvidence + '\n');
      t.diagnostic(JSON.stringify({ schema: 'dispatch-barriers@v1', kind, point, runId, fixtureDigest: sandbox.fixtureDigest,
        platform: process.platform, node: process.version, artifact, artifactHash: sha256(rawEvidence + '\n'), sends: receiver.length, attempts: attempts.length,
        events: events.map(e => ({ kind: e.kind, hash: e.hash })), status: 'pass' }));
    } finally {
      clearTimeout(guard);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      lines.close();
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  });
}

for (const revokeFirst of [true, false]) test(`two connections serialize revoke and started (revokeFirst=${revokeFirst})`, () => {
  const sandbox = createSandbox();
  const first = openProbe(sandbox);
  const second = openProbe(sandbox);
  const exec = DatabaseSync.prototype.exec;
  try {
    const turn = first.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
    const runId = first.session.runId;
    if (revokeFirst) second.store.revokeRequestRun(second.activity, runId);
    else {
      const start = first.store.startRequestAttempt.bind(first.store);
      let admitted = false;
      first.store.startRequestAttempt = (activity, input) => {
        const attempt = start(activity, input);
        admitted = true;
        return attempt;
      };
      DatabaseSync.prototype.exec = function(sql) {
        const result = exec.call(this, sql);
        if (sql === 'COMMIT' && admitted) {
          admitted = false;
          second.store.revokeRequestRun(second.activity, runId);
        }
        return result;
      };
    }
    assert.throws(() => first.session.dispatch(turn), revokeFirst ? /run-not-admissible/ : /run-cancelled/);
    const status = first.store.requestStatus(first.activity, runId);
    assert.equal(status.attempts.length, revokeFirst ? 0 : 1);
    if (!revokeFirst) assert.equal(status.attempts[0]!.outcome, 'cancelled-before-send');
    assert.equal(first.transport.count, 0);
  } finally { DatabaseSync.prototype.exec = exec; second.close(); first.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
