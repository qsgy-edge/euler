import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { arch, hostname, platform, release, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const startedAt = new Date().toISOString();
const destination = resolve(repo, 'artifacts', `t01-${startedAt.replace(/[:.]/g, '-')}`);
mkdirSync(destination, { recursive: true });
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const git = (...args: string[]) => execFileSync('git', ['--no-optional-locks', ...args], { cwd: repo, encoding: 'utf8' }).trim();
const fixturePath = join(repo, 'fixtures', 'first-turn.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const cases: Record<string, unknown>[] = [];
const assertions: { name: string; passed: boolean; error?: string }[] = [];
const files: { path: string; sha256: string }[] = [];
function record(path: string, bytes: string | Buffer) {
  writeFileSync(path, bytes);
  files.push({ path: relative(destination, path).replaceAll('\\', '/'), sha256: digest(readFileSync(path)) });
}
function verify(name: string, check: () => void) {
  try { check(); assertions.push({ name, passed: true }); }
  catch (error) { assertions.push({ name, passed: false, error: (error as Error).message }); }
}
function runCase(name: string, args: string[]) {
  const caseRoot = join(destination, name);
  mkdirSync(caseRoot);
  const start = new Date().toISOString();
  const command = [process.execPath, join(repo, 'apps/cli/src/main.ts'), ...args];
  const result = spawnSync(command[0]!, command.slice(1), { cwd: repo, encoding: 'utf8', timeout: 20000, maxBuffer: 2_000_000 });
  record(join(caseRoot, 'stdout.jsonl'), result.stdout ?? '');
  record(join(caseRoot, 'stderr.txt'), result.stderr ?? '');
  const lines = (result.stdout ?? '').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, any>);
  cases.push({ name, command, startedAt: start, finishedAt: new Date().toISOString(), exitCode: result.status, signal: result.signal, error: result.error?.message ?? null });
  const sandbox = lines.find(line => line.event === 'sandbox');
  if (sandbox) {
    mkdirSync(join(caseRoot, 'sandbox'));
    for (const file of readdirSync(String(sandbox.root))) {
      const source = join(String(sandbox.root), file);
      const target = join(caseRoot, 'sandbox', file);
      copyFileSync(source, target);
      files.push({ path: relative(destination, target).replaceAll('\\', '/'), sha256: digest(readFileSync(target)) });
    }
  }
  return { lines, result, sandbox, snapshot: join(caseRoot, 'sandbox') };
}

// Independent verifier: derive expected receipts from the fixture, raw carrier
// and canonical SQLite rows. No Core/Host code or previously reported ack is used.
function verifyRawState(snapshot: string, reportedSource: unknown, reportedIntent: unknown) {
  const { ownerId, hostId, projectId, sessionId, branchId } = fixture;
  const binding = { ownerId, hostId, projectId, sessionId, branchId };
  const carrier = readFileSync(join(snapshot, 'session.jsonl'));
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(carrier).split('\n');
  assert.equal(raw.length, 3);
  assert.equal(raw[2], '');
  assert.deepEqual(JSON.parse(raw[0]!), { schema: 'cli-session@1', binding });
  assert.equal(raw[1], JSON.stringify({ schema: 'cli-input@1', eventId: fixture.eventId, role: 'user', text: fixture.text }));
  const source = {
    schema: 'cli-source-ack@1', status: 'durable', binding, eventId: fixture.eventId,
    locator: `cli-jsonl@1/${sessionId}/${fixture.eventId}`, hash: digest(raw[1]!), byteLength: Buffer.byteLength(raw[1]!), contentHash: digest(fixture.text),
  };
  assert.deepEqual(reportedSource, source);

  // SQLite can create WAL side files even when queried read-only. Work on a
  // private copy so validation never changes the recorded raw artifacts.
  const temporary = mkdtempSync(join(tmpdir(), 'euler-t01-verify-'));
  try {
    for (const file of ['probe.sqlite', 'probe.sqlite-wal', 'probe.sqlite-shm']) {
      if (existsSync(join(snapshot, file))) copyFileSync(join(snapshot, file), join(temporary, file));
    }
    const db = new DatabaseSync(join(temporary, 'probe.sqlite'), { readOnly: true });
    try {
      const events = db.prepare('SELECT * FROM intent_events ORDER BY version').all();
      assert.equal(events.length, 1);
      const row = events[0]!;
      assert.deepEqual(db.prepare('SELECT session_id,branch_id,event_id FROM intent_heads').all().map(value => ({ ...value })),
        [{ session_id: sessionId, branch_id: branchId, event_id: row.event_id }]);
      assert.equal(row.expected_event_id, null);
      assert.equal(row.session_id, sessionId);
      assert.equal(row.branch_id, branchId);
      assert.equal(row.status, 'active');
      for (const prefix of ['input', 'goal_input']) {
        assert.equal(row[`${prefix}_event_id`], fixture.eventId);
        assert.equal(row[`${prefix}_hash`], source.hash);
        assert.equal(row[`${prefix}_content_hash`], source.contentHash);
        assert.equal(row[`${prefix}_locator`], source.locator);
        assert.equal(row[`${prefix}_bytes`], source.byteLength);
      }
      assert.match(String(row.intent_id), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.match(String(row.event_id), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      const intent = {
        schema: 'intent@1', intentId: row.intent_id, eventId: row.event_id, version: 1, binding,
        goal: fixture.text, constraints: fixture.constraints, step: 'first-turn', status: 'active', input: source, goalInput: source,
      };
      assert.equal(row.version, 1);
      assert.equal(row.snapshot, JSON.stringify(intent));
      assert.equal(row.hash, digest(String(row.snapshot)));
      assert.equal(row.transition_hash, digest(JSON.stringify({ expected: null, input: source,
        transition: { step: 'first-turn', status: 'active' }, initialGoal: fixture.text })));
      assert.deepEqual(reportedIntent, { ...intent, hash: row.hash });

      const manifest = JSON.parse(readFileSync(join(snapshot, 'sandbox.json'), 'utf8'));
      const fence = db.prepare('SELECT * FROM owner_fences').get()!;
      assert.equal(fence.store_id, manifest.storeId);
      for (const [column, value] of Object.entries({ owner_id: ownerId, host_id: hostId, project_id: projectId, session_id: sessionId, branch_id: branchId })) assert.equal(fence[column], value);
      for (const [kind, path, identity] of [
        ['root', manifest.root, manifest.rootIdentity],
        ['source', join(manifest.root, 'session.jsonl'), manifest.archiveIdentity],
        ['store', join(manifest.root, 'probe.sqlite'), manifest.storeIdentity],
      ] as const) {
        assert.equal(fence[`${kind}_path`], path);
        assert.equal(fence[`${kind}_dev`], identity.dev);
        assert.equal(fence[`${kind}_ino`], identity.ino);
      }
      const activities = db.prepare('SELECT * FROM owner_activities').all();
      assert.ok(activities.length >= 1);
      for (const activity of activities) {
        assert.equal(activity.store_id, manifest.storeId);
        assert.equal(activity.root_path, manifest.root);
        assert.equal(activity.root_dev, manifest.rootIdentity.dev);
        assert.equal(activity.root_ino, manifest.rootIdentity.ino);
      }
    } finally { db.close(); }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

function verifyMaintenanceRawState(snapshot: string, lines: Record<string, any>[]) {
  const manifest = JSON.parse(readFileSync(join(snapshot, 'sandbox.json'), 'utf8'));
  const temporary = mkdtempSync(join(tmpdir(), 'euler-t01-maintenance-'));
  for (const file of ['probe.sqlite', 'probe.sqlite-wal', 'probe.sqlite-shm']) {
    if (existsSync(join(snapshot, file))) copyFileSync(join(snapshot, file), join(temporary, file));
  }
  const db = new DatabaseSync(join(temporary, 'probe.sqlite'), { readOnly: true });
  try {
    const fence = db.prepare('SELECT * FROM owner_fences').get() as Record<string, any>;
    assert.equal(fence.store_id, manifest.storeId);
    assert.equal(fence.state, 'open');
    assert.equal(fence.epoch, 3);
    assert.equal(fence.coordinator, null);
    assert.equal(fence.coordinator_pid, null);
    assert.ok(Number(db.prepare('SELECT COUNT(*) AS count FROM owner_activities').get()!.count) >= 1);
    for (const [kind, path, identity] of [
      ['root', manifest.root, manifest.rootIdentity],
      ['source', join(manifest.root, 'session.jsonl'), manifest.archiveIdentity],
      ['store', join(manifest.root, 'probe.sqlite'), manifest.storeIdentity],
    ] as const) {
      assert.equal(fence[`${kind}_path`], path);
      assert.equal(fence[`${kind}_dev`], identity.dev);
      assert.equal(fence[`${kind}_ino`], identity.ino);
    }
    const states = lines.filter(line => ['maintenance-closing', 'maintenance-blocked', 'maintenance-exclusive', 'maintenance-released'].includes(line.event))
      .map(line => line.fence).filter(Boolean).map(fence => ({ state: fence.state, epoch: fence.epoch }));
    assert.deepEqual(states, [
      { state: 'closing', epoch: 2 }, { state: 'exclusive', epoch: 2 }, { state: 'open', epoch: 3 },
    ]);
  } finally { db.close(); rmSync(temporary, { recursive: true, force: true }); }
}

let infrastructureError: string | null = null;
try {
  for (const scenario of ['success', 'blocked', 'archive-failure', 'cancelled', 'archive-only']) {
    const item = runCase(scenario, [scenario]);
    const expected = scenario === 'success' || scenario === 'archive-only' ? 0 : 1;
    verify(`${scenario}: expected exit`, () => assert.equal(item.result.status, expected));
    const result = item.lines.find(line => line.event === 'run-result');
    const sourceObservation = item.lines.find(line => line.event === 'source-ack');
    if (sourceObservation) verify(`${scenario}: receipts match raw source and SQLite`, () =>
      verifyRawState(item.snapshot, sourceObservation.ack, sourceObservation.intent));
    verify(`${scenario}: send count`, () => assert.equal(result?.sends, scenario === 'cancelled' ? 0 : fixture.expectedSends[scenario]));
    if (scenario === 'success') {
      verify('transport payload bytes and digest', () => {
        assert.equal(result!.payloads.length, 1);
        assert.equal(digest(result!.payloads[0]), result!.receipt.payloadHash);
        assert.equal(Buffer.byteLength(result!.payloads[0]), result!.receipt.byteLength);
        const payload = JSON.parse(result!.payloads[0]);
        assert.deepEqual(payload.messages.map((message: { role: string }) => message.role), ['system', 'user']);
        assert.equal(payload.messages[1].content, fixture.text);
        assert.equal(result!.receipt.formalLedger, false);
      });
    }
    if (scenario === 'archive-failure') verify('archive failure has no source ack', () => assert.equal(item.lines.some(line => line.event === 'source-ack'), false));
    if (scenario === 'archive-only') {
      const ack = item.lines.find(line => line.event === 'source-ack')!;
      const recovery = runCase('restart', ['recover', '--sandbox', item.sandbox!.root]);
      verify('restart recovers exact identity/hash/intent with zero sends', () => {
        assert.equal(recovery.result.status, 0);
        const recovered = recovery.lines.find(line => line.event === 'recovered')!;
        assert.deepEqual(recovered.source, ack.ack);
        assert.deepEqual(recovered.intent, ack.intent);
        verifyRawState(recovery.snapshot, recovered.source, recovered.intent);
        assert.equal(recovered.sends, 0);
      });
      const duplicate = runCase('duplicate', ['run', '--scenario', 'archive-only', '--sandbox', item.sandbox!.root]);
      verify('duplicate event remains single', () => {
        assert.equal(duplicate.result.status, 0);
        assert.equal(duplicate.lines.find(line => line.event === 'run-result')!.eventCount, 1);
        const raw = readFileSync(join(item.sandbox!.root, 'session.jsonl'), 'utf8').split('\n');
        assert.equal(raw.length, 3);
        assert.equal(digest(raw[1]!), ack.ack.hash);
        const observed = duplicate.lines.find(line => line.event === 'source-ack')!;
        verifyRawState(duplicate.snapshot, observed.ack, observed.intent);
      });
      verify('self-consistent forged receipts fail raw-source validation', () => {
        for (const forged of [
          { ...ack.ack, byteLength: ack.ack.byteLength + 1 },
          { ...ack.ack, locator: 'cli-jsonl@1/other/event' },
          { ...ack.ack, binding: { ...ack.ack.binding, projectId: 'other' } },
        ]) assert.throws(() => verifyRawState(item.snapshot, forged, ack.intent), assert.AssertionError);
        const { hash: _hash, ...snapshot } = ack.intent;
        const forgedIntent = { ...snapshot, goal: 'Unapproved different goal' };
        assert.throws(() => verifyRawState(item.snapshot, ack.ack,
          { ...forgedIntent, hash: digest(JSON.stringify(forgedIntent)) }), assert.AssertionError);
      });
    }
  }
  const lifecycle = runCase('maintenance', ['maintenance']);
  verify('maintenance raw SQLite fence and resource evidence', () => verifyMaintenanceRawState(lifecycle.snapshot, lifecycle.lines));
  verify('maintenance includes real exits, exclusion, release and successful new run', () => {
    assert.equal(lifecycle.result.status, 0);
    const events = lifecycle.lines.map(line => line.event);
    for (const event of ['runtime-ready', 'maintenance-blocked', 'late-append-blocked', 'controlled-task-exit', 'runtime-exit', 'maintenance-exclusive', 'maintenance-released', 'maintenance-exit', 'resumed-run']) assert.ok(events.includes(event), event);
    const observed = lifecycle.lines.find(line => line.event === 'maintenance-blocked')!;
    assert.ok(observed.observations.length >= 2);
    assert.ok(observed.observations.some((item: { absent: boolean }) => !item.absent));
    const exclusive = lifecycle.lines.find(line => line.event === 'maintenance-exclusive')!;
    assert.ok(exclusive.observations.every((item: { absent: boolean }) => item.absent));
    assert.equal(lifecycle.lines.find(line => line.event === 'runtime-exit')!.code, 0);
    assert.equal(lifecycle.lines.find(line => line.event === 'controlled-task-exit')!.code, 0);
    assert.equal(lifecycle.lines.find(line => line.event === 'resumed-run')!.sends, 1);
  });
} catch (error) { infrastructureError = (error as Error).stack ?? String(error); }

const sqlite = new DatabaseSync(':memory:');
const sqliteVersion = sqlite.prepare('SELECT sqlite_version() AS version').get()!.version;
sqlite.close();
const verificationLog = join(repo, 'artifacts', 'verification.log');
if (existsSync(verificationLog)) record(join(destination, 'verification.log'), readFileSync(verificationLog));
const manifest = {
  experimentId: 'T01-synthetic', schemaVersion: 1,
  specCommit: 'a3f253f9bef0415364b3b224e5eb4ba150111325',
  specRefs: ['I01-I03', 'I08-I11', 'I18', 'D8.1/P0', 'X-04/X-06/X-12 synthetic subsets'],
  implementationCommit: git('rev-parse', 'HEAD'), implementationTree: git('rev-parse', 'HEAD^{tree}'), workingChanges: git('status', '--porcelain'),
  environment: { platform: platform(), release: release(), arch: arch(), host: hostname(), node: process.version, sqlite: sqliteVersion, runner: process.env.RUNNER_IMAGE ?? process.env.ImageOS ?? 'local', adapter: 'euler-p0@1', provider: 'local-counting', model: 'none' },
  fixture: { path: 'fixtures/first-turn.json', digest: digest(JSON.stringify(fixture)), rawFileDigest: digest(readFileSync(fixturePath)), eventId: fixture.eventId, heldOut: 'not-applicable: deterministic development fixture; no held-out quality claim' },
  startedAt, finishedAt: new Date().toISOString(), cases, assertions, files, infrastructureError,
  status: infrastructureError ? 'evidence-gap' : assertions.every(item => item.passed) ? 'pass' : 'fail',
  scope: 'Only T01 synthetic paths on the recorded environment; no full X-card, power-loss, physical purge, provider, production, or cutover acceptance.',
};
record(join(destination, 'summary.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ artifact: destination, status: manifest.status, assertions: assertions.length, failures: assertions.filter(item => !item.passed).length }));
if (manifest.status !== 'pass') process.exitCode = 1;
