import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { arch, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { cliEntry } from '../apps/cli/src/process-driver.ts';
import { openProbe } from '../apps/cli/src/probe.ts';
import { OWNER_INFO_FILE, createSandbox, fixture as bindingFixture } from '../apps/cli/src/sandbox.ts';
import type { Sandbox } from '../apps/cli/src/sandbox.ts';

// T12 evidence: real CLI processes over disposable synthetic roots; every verdict below is
// recomputed from retained raw archive/owner-info/SQLite bytes, not from the CLI's own report.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const copyTree = (source: string, target: string): void => {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(target, entry.name);
    if (entry.isDirectory()) copyTree(from, to); else copyFileSync(from, to);
  }
};
const listFiles = (root: string, prefix = ''): string[] => readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(entry => {
  const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
  return entry.isDirectory() ? listFiles(root, relative) : [relative];
});
const startedAt = new Date().toISOString();
const mainStderr: string[] = [];
const originalStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: string | Uint8Array, ...args: any[]) => {
  mainStderr.push(Buffer.from(chunk).toString('utf8'));
  return originalStderrWrite(chunk, ...args);
}) as typeof process.stderr.write;

const fixturePath = new URL('../fixtures/t12-owner-memory-cases.json', import.meta.url);
const expectedDigest = '4f19240cedc6312cfbfa362778458c934f36afc9e44261125759454591d221f4';
const bytes = readFileSync(fixturePath);
const fixtureDigest = sha256(bytes);
assert.equal(fixtureDigest, expectedDigest, 'T12 fixture changed');
const fixture = JSON.parse(bytes.toString('utf8')) as {
  schema: string;
  main: { preference: string; proposal: string; agreement: string; fact: string; question: string; forgedProposal: string };
  crash: { statement: string }; writeFailure: { statement: string; question: string }; unavailable: { statement: string };
  boundaries: { unscoped: string; untyped: string; proposal: string; decline: string; orphanAgreement: string; broken: string };
  ownerChanges: { preference: string; decision: string; correctionSource: string; correction: string };
};
assert.equal(fixture.schema, 't12-owner-memory-cases@1');
// Every memory/source body in the fixture; none may appear in the receipt (bodies stay in the retained raw roots).
const fixtureBodies = Object.entries(fixture).filter(([key]) => key !== 'schema')
  .flatMap(([, group]) => Object.values(group as Record<string, string>))
  .flatMap(text => text.replace(/^(propose |ask )/u, '').split('\\n'))
  .map(line => line.replace(/^(建议)?记住(偏好|决定|事实)?[：:]\s*/u, '').replace(/^更正[：:]\s*/u, '').trim())
  .filter(body => body.length > 2);
const directory = join('artifacts', `t12-${Date.now()}`);
mkdirSync(join(directory, 'processes'), { recursive: true });
mkdirSync(join(directory, 'errors'), { recursive: true });
let diagnosticCount = 0;
// Full exception details belong to owner-held raw artifacts, never to receipt fields.
function diagnostic(kind: string, error: unknown): string {
  const raw = error instanceof Error ? error.stack ?? error.message : String(error);
  const path = `errors/${++diagnosticCount}-${kind}.txt`;
  writeFileSync(join(directory, path), raw, { flag: 'wx' });
  return `${kind}: ${path} sha256=${sha256(raw)}`;
}

interface Observation { event: string; [key: string]: unknown }
type ProcessReceipt = { label: string; command: string; args: string[]; cwd: string; startedAt: string; finishedAt: string;
  code: number | null; signal: string | null; stdout: { path: string; sha256: string }; stderr: { path: string; sha256: string } };
const processes: ProcessReceipt[] = [];
const outputs = new Map<string, Observation[]>();
// Children still running when a scenario ends are killed and reaped there, so their receipts are complete.
const running = new Map<ChildProcess, Promise<unknown>>();

// One real CLI child: raw stdout/stderr bytes and exit/signal are recorded as produced.
function drive(label: string, args: string[]) {
  const child = spawn(process.execPath, [cliEntry, ...args], { cwd: repo, stdio: 'pipe', windowsHide: true });
  child.stdin.on('error', () => {}); // a killed child may close stdin first; exit/signal is still recorded
  const started = new Date().toISOString();
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  const observations: Observation[] = [];
  let pending = '';
  let failure: Error | null = null;
  let closed = false;
  child.once('error', error => { failure ??= error; });
  child.stdout.on('data', (chunk: Buffer) => {
    stdout.push(chunk);
    pending += chunk.toString('utf8');
    let index: number;
    while ((index = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      if (line && !failure) {
        try { observations.push(JSON.parse(line) as Observation); }
        catch (error) { failure = error instanceof Error ? error : new Error('invalid-child-output'); child.kill('SIGKILL'); }
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const guard = setTimeout(() => child.kill('SIGKILL'), 60000);
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolveExit, rejectExit) => child.once('close', (code, signal) => {
    clearTimeout(guard);
    closed = true;
    try {
    if (pending.trim() && !failure) failure = new Error('incomplete-child-output');
    const out = Buffer.concat(stdout), err = Buffer.concat(stderr);
    const name = `processes/${String(processes.length + 1).padStart(2, '0')}-${label}`;
    writeFileSync(join(directory, `${name}.stdout.txt`), out, { flag: 'wx' });
    writeFileSync(join(directory, `${name}.stderr.txt`), err, { flag: 'wx' });
    processes.push({ label, command: process.execPath, args: [cliEntry, ...args], cwd: repo, startedAt: started,
      finishedAt: new Date().toISOString(), code, signal,
      stdout: { path: `${name}.stdout.txt`, sha256: sha256(out) }, stderr: { path: `${name}.stderr.txt`, sha256: sha256(err) } });
    outputs.set(label, observations);
    } catch (error) { failure ??= error instanceof Error ? error : new Error('child-evidence-write-failed'); }
    finally { running.delete(child); }
    if (failure) rejectExit(failure); else resolveExit({ code, signal });
  }));
  // Observe rejection even when it races an nth() wait; runScenario still reaps and retains.
  void exit.catch(() => {});
  running.set(child, exit);
  async function nth(event: string, index = 0): Promise<Observation> {
    const deadline = Date.now() + 30000;
    for (;;) {
      if (failure) throw failure;
      const hits = observations.filter(item => item.event === event);
      if (hits.length > index) return hits[index]!;
      if (closed || child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) {
        throw new Error(`${label}: missing ${event}#${index}: ${Buffer.concat(stderr).toString('utf8').slice(-2000)}`);
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 10));
    }
  }
  async function send(line: string, event: string): Promise<Observation> {
    const index = observations.filter(item => item.event === event).length;
    child.stdin.write(line + '\n');
    return nth(event, index);
  }
  async function stop(): Promise<{ code: number | null; signal: string | null }> {
    child.stdin.end('stop\n');
    return exit;
  }
  return { child, observations, exit, nth, send, stop };
}

const roots = new Map<string, string>();
const controlledSideEffects: { path: string; disposition: 'remove' | 'retain'; existsAtFinish: boolean }[] = [];
function retain(name: string, root: string): void {
  const target = join(directory, 'raw', name);
  copyTree(root, target);
  roots.set(name, target);
  rmSync(root, { recursive: true, force: true });
  controlledSideEffects.push({ path: root, disposition: 'remove', existsAtFinish: existsSync(root) });
}

const KILLS = ['crash-before-activation-commit', 'crash-after-activation-commit', 'crash-before-info-append', 'crash-after-info-append',
  'crash-after-info-delivery', 'crash-before-info-read', 'crash-after-info-read'] as const;
const facts: Record<string, unknown> = {};
let scenarioError: string | null = null;
// Each scenario retains its synthetic root and reaps its children even when it fails part-way.
async function runScenario(name: string, body: (sandbox: Sandbox) => Promise<void>): Promise<void> {
  const sandbox = createSandbox();
  try { await body(sandbox); }
  finally {
    for (const [child, exit] of [...running]) { child.kill('SIGKILL'); await exit.catch(() => {}); }
    retain(name, sandbox.root);
  }
}
try {
  await runScenario('main', async sandbox => {
    const main = drive('main', ['remember', '--sandbox', sandbox.root, '--synthetic-proposals']);
    await main.nth('remember-ready');
    const preference = await main.send(fixture.main.preference, 'remember-result');
    await main.send(fixture.main.proposal, 'assistant-proposal');
    const decision = await main.send(fixture.main.agreement, 'remember-result');
    await main.send(fixture.main.fact, 'remember-result');
    await main.send('info', 'info-list');
    await main.send(`info ${preference.batchId}`, 'info-read');
    await main.send(fixture.main.question, 'ask-result');
    assert.equal((await main.stop()).code, 0);
    await drive('main-info-query', ['info', '--sandbox', sandbox.root]).exit;
    await drive('main-info-open', ['info', '--sandbox', sandbox.root, '--batch', String(decision.batchId)]).exit;
    const restart = drive('main-restart', ['remember', '--sandbox', sandbox.root]);
    await restart.nth('remember-ready');
    await restart.send(fixture.main.forgedProposal, 'command-rejected');
    assert.equal((await restart.stop()).code, 0);
  });
  for (const scenario of KILLS) {
    await runScenario(scenario, async sandbox => {
      const crashing = drive(scenario, ['remember', '--sandbox', sandbox.root, '--scenario', scenario]);
      await crashing.nth('remember-ready');
      if (scenario === 'crash-before-info-read' || scenario === 'crash-after-info-read') {
        const remembered = await crashing.send(fixture.crash.statement, 'remember-result');
        crashing.child.stdin.write(`info ${remembered.batchId}\n`);
      } else crashing.child.stdin.write(fixture.crash.statement + '\n');
      await crashing.nth('owner-checkpoint');
      crashing.child.kill('SIGKILL');
      await crashing.exit;
      if (scenario === 'crash-after-activation-commit') await drive(`${scenario}-info-query`, ['info', '--sandbox', sandbox.root]).exit;
      const restarted = drive(`${scenario}-restart`, ['remember', '--sandbox', sandbox.root]);
      await restarted.nth('remember-ready');
      assert.equal((await restarted.stop()).code, 0);
    });
  }
  await runScenario('write-failure', async sandbox => {
    const info = join(sandbox.root, OWNER_INFO_FILE);
    const cli = drive('write-failure', ['remember', '--sandbox', sandbox.root]);
    try {
      await cli.nth('remember-ready');
      chmodSync(info, 0o444);
      let blocked = false;
      try { closeSync(openSync(info, 'a')); } catch { blocked = true; }
      facts.writeFailurePrecondition = blocked;
      await cli.send(fixture.writeFailure.statement, 'remember-result');
      await cli.send(fixture.writeFailure.question, 'ask-refused');
      chmodSync(info, 0o644);
      await cli.send(fixture.writeFailure.question, 'ask-result');
      assert.equal((await cli.stop()).code, 0);
    } finally { chmodSync(info, 0o644); }
  });
  await runScenario('unavailable', async sandbox => {
    const plain = drive('unavailable', ['remember', '--sandbox', sandbox.root, '--host-info', 'unavailable']);
    await plain.nth('remember-ready');
    await plain.send(fixture.unavailable.statement, 'remember-result');
    assert.equal((await plain.stop()).code, 0);
    const durable = drive('unavailable-durable-restart', ['remember', '--sandbox', sandbox.root]);
    await durable.nth('remember-ready');
    assert.equal((await durable.stop()).code, 0);
  });
  await runScenario('boundaries', async sandbox => {
    const cli = drive('boundaries', ['remember', '--sandbox', sandbox.root, '--no-active-project', '--synthetic-proposals']);
    await cli.nth('remember-ready');
    await cli.send(fixture.boundaries.unscoped, 'remember-result');
    await cli.send(fixture.boundaries.untyped, 'remember-result');
    await cli.send(fixture.boundaries.proposal, 'assistant-proposal');
    await cli.send(fixture.boundaries.decline, 'remember-result');
    await cli.send(fixture.boundaries.orphanAgreement, 'remember-result');
    const archive = join(sandbox.root, 'session.jsonl');
    copyFileSync(archive, `${archive}.copy`);
    renameSync(`${archive}.copy`, archive);
    await cli.send(fixture.boundaries.broken, 'remember-result');
    assert.equal((await cli.stop()).code, 0);
  });
  await runScenario('owner-changes', async sandbox => {
    const cli = drive('owner-changes', ['remember', '--sandbox', sandbox.root]);
    await cli.nth('remember-ready');
    const preference = await cli.send(fixture.ownerChanges.preference, 'remember-result');
    const decision = await cli.send(fixture.ownerChanges.decision, 'remember-result');
    assert.equal((await cli.stop()).code, 0);
    // Later owner changes arrive through the Store API (their Host entries are T15-T17); then the CLI restarts.
    const probe = openProbe(sandbox);
    try {
      const rolled = probe.store.readMemory(probe.activity, String(preference.recordId));
      const activation = probe.store.inspectMemory(probe.activity, rolled.recordId).history.find(event => event.kind === 'activate');
      assert(activation, 'owner-changes: activation event');
      probe.store.rollbackMemory(probe.activity, rolled.recordId, rolled, activation.eventId);
      const current = probe.store.readMemory(probe.activity, String(decision.recordId));
      probe.store.correctMemory(probe.activity, current.recordId, current,
        probe.archive.append(randomUUID(), fixture.ownerChanges.correctionSource), fixture.ownerChanges.correction);
    } finally { probe.close(); }
    const restarted = drive('owner-changes-restart', ['remember', '--sandbox', sandbox.root]);
    await restarted.nth('remember-ready');
    assert.equal((await restarted.stop()).code, 0);
    await drive('owner-changes-info', ['info', '--sandbox', sandbox.root, '--batch', String(preference.batchId)]).exit;
  });
} catch (error) { scenarioError = diagnostic('scenario-failed', error); }

type Row = Record<string, unknown>;
type RawEvent = { schema: string; eventId: string; role: string; text: string; rawLine: string };
const OWNER = /^记住(偏好|决定|事实)[：:]\s*(\S[^\n]*)$/u;
const PROPOSAL = /^建议记住(偏好|决定|事实)[：:]\s*(\S[^\n]*)$/u;
const TYPES: Record<string, string> = { 偏好: 'preference', 决定: 'decision', 事实: 'fact' };
const byEvent = (label: string, event: string) => (outputs.get(label) ?? []).filter(item => item.event === event);

function validateRoot(name: string, root: string) {
  const archiveText = readFileSync(join(root, 'session.jsonl'), 'utf8');
  assert(archiveText.endsWith('\n'), `${name}: archive incomplete`);
  const lines = archiveText.slice(0, -1).split('\n');
  const header = JSON.parse(lines.shift()!) as { schema: string; binding: Record<string, string> };
  assert.equal(header.schema, 'cli-session@1');
  for (const key of ['ownerId', 'hostId', 'projectId', 'sessionId', 'branchId']) {
    assert.equal(header.binding[key], (bindingFixture as unknown as Record<string, string>)[key], `${name}: binding ${key}`);
  }
  const seen = new Set<string>();
  const archive = lines.map(rawLine => {
    const event = JSON.parse(rawLine) as Omit<RawEvent, 'rawLine'>;
    assert.equal(rawLine, JSON.stringify(event), `${name}: archive line is not canonical`);
    assert(!seen.has(event.eventId), `${name}: duplicate archive identity`);
    seen.add(event.eventId);
    return { ...event, rawLine };
  });
  const ackOf = (event: RawEvent) => ({ schema: 'cli-source-ack@1', status: 'durable', binding: header.binding, eventId: event.eventId,
    locator: `cli-jsonl@1/${header.binding.sessionId}/${event.eventId}`, hash: sha256(event.rawLine),
    byteLength: Buffer.byteLength(event.rawLine), contentHash: sha256(event.text) });
  const archiveEvent = (ref: { eventId: string }) => {
    const event = archive.find(item => item.eventId === ref.eventId);
    assert(event, `${name}: evidence ref not in archive`);
    assert.deepEqual(ref, ackOf(event), `${name}: evidence ref does not match archive bytes`);
    return event;
  };
  const infoText = readFileSync(join(root, 'owner-info.jsonl'), 'utf8');
  assert(infoText.endsWith('\n'), `${name}: owner info incomplete`);
  const infoLines = infoText.slice(0, -1).split('\n');
  assert.equal(JSON.parse(infoLines.shift()!).schema, 'owner-info@1');
  const entries = infoLines.map(line => ({ record: JSON.parse(line) as Row, entryHash: sha256(line), line }));
  for (const entry of entries) {
    assert.equal(entry.line, JSON.stringify(entry.record));
    assert.equal(sha256(String(entry.record.payload)), entry.record.digest, `${name}: owner entry digest`);
  }
  assert.equal(new Set(entries.map(entry => entry.record.batchId)).size, entries.length, `${name}: duplicate owner entry`);
  const db = new DatabaseSync(join(root, 'probe.sqlite'), { readOnly: true });
  try {
    const all = (sql: string, ...args: (string | number)[]) => db.prepare(sql).all(...args) as Row[];
    const records = all('SELECT record_id FROM memory_records ORDER BY rowid').map(row => String(row.record_id));
    const summary: Row = { records: records.length, active: 0, batches: 0 };
    for (const recordId of records) {
      const history = all('SELECT * FROM memory_events WHERE record_id=? ORDER BY seq', recordId);
      for (const event of history) assert.equal(sha256(String(event.payload)), event.payload_hash, `${name}: event payload hash`);
      const capture = JSON.parse(String(history[0]!.after_snapshot)) as Row & { scope: { resolved: boolean } };
      assert.deepEqual([history[0]!.kind, capture.lifecycle, capture.verification], ['capture', 'candidate', 'unverified'], `${name}: first capture`);
      for (const event of history.filter(item => item.kind === 'verify')) {
        const run = all('SELECT * FROM verification_runs WHERE run_id=?', String(JSON.parse(String(event.payload)).runId))[0]!;
        assert.equal(run.evidence_hash, sha256(String(run.evidence_json)), `${name}: verification evidence hash`);
        const refs = JSON.parse(String(run.evidence_json)) as { eventId: string }[];
        const owner = archiveEvent(refs.at(-1)!);
        assert.equal(owner.role, 'user', `${name}: verification not anchored on an owner event`);
        let type: string;
        const direct = OWNER.exec(owner.text.trim());
        if (direct) { assert.equal(refs.length, 1); type = TYPES[direct[1]!]!; } else {
          const agreement = JSON.parse(owner.text) as { schema: string; text: string; proposal: { eventId: string } };
          assert.equal(agreement.schema, 'owner-agreement@1');
          assert.deepEqual(agreement.proposal, refs[0]);
          const proposal = archiveEvent(refs[0]!);
          assert.equal(proposal.role, 'assistant');
          const marks = proposal.text.split('\n').map(line => PROPOSAL.exec(line.trim())).filter(Boolean);
          assert.equal(marks.length, 1, `${name}: proposal marker`);
          type = TYPES[marks[0]![1]!]!;
        }
        assert.equal(run.verifier, 'owner-fast-lane@1');
        assert.deepEqual([run.result, run.reason], type === 'fact' ? ['evidence-gap', 'objective-fact-authority-required'] : ['pass', null],
          `${name}: fast-lane verdict`);
      }
      const activations = history.filter(item => item.kind === 'activate');
      if (activations.length) {
        summary.active = Number(summary.active) + 1;
        // Later owner events (rollback/correct/forget) may follow, but there is only ever one fast-lane activation.
        assert.deepEqual([history.slice(0, 3).map(item => item.kind), activations.length], [['capture', 'verify', 'activate'], 1],
          `${name}: activation chain`);
        const after = JSON.parse(String(activations[0]!.after_snapshot)) as Row & { type: string; scope: { resolved: boolean } };
        assert.deepEqual([after.lifecycle, after.verification, after.scope.resolved], ['active', 'verified', true]);
        assert.notEqual(after.type, 'fact', `${name}: fact activated`);
        assert.equal(all("SELECT 1 FROM verification_runs WHERE record_id=? AND result='pass' AND verifier='owner-fast-lane@1'", recordId).length, 1);
        assert(activations[0]!.batch_id, `${name}: activation without batch`);
      }
    }
    const batches = all('SELECT * FROM activation_batches ORDER BY rowid');
    summary.batches = batches.length;
    for (const batch of batches) {
      assert.equal(sha256(String(batch.payload)), batch.payload_hash, `${name}: batch digest`);
      const members = all('SELECT payload FROM memory_events WHERE batch_id=? ORDER BY batch_ordinal', String(batch.batch_id));
      assert.deepEqual(JSON.parse(String(batch.payload)).events, members.map(row => JSON.parse(String(row.payload))), `${name}: manifest members`);
      const jobs = all("SELECT * FROM projection_jobs WHERE kind='host-info' AND batch_id=?", String(batch.batch_id));
      assert.equal(jobs.length, 1, `${name}: host-info job per batch`);
      assert.equal(sha256(String(jobs[0]!.payload)), jobs[0]!.payload_hash);
      const info = all('SELECT * FROM host_info_batches WHERE batch_id=?', String(batch.batch_id));
      assert.equal(info.length, 1, `${name}: Info row per batch`);
      assert.equal(info[0]!.digest, batch.payload_hash, `${name}: Info digest`);
      assert.equal(info[0]!.job_id, jobs[0]!.job_id);
      const entry = entries.find(item => item.record.batchId === batch.batch_id);
      if (info[0]!.delivery === 'delivered') {
        assert(entry, `${name}: delivered without owner entry`);
        assert.deepEqual([info[0]!.entry_id, info[0]!.entry_hash, entry.record.digest], [entry.record.entryId, entry.entryHash, batch.payload_hash]);
      }
    }
    for (const entry of entries) assert(batches.some(batch => batch.batch_id === entry.record.batchId), `${name}: orphan owner entry`);
    assert.equal(all(`SELECT 1 FROM memory_heads h JOIN memory_revisions r ON r.record_id=h.record_id AND r.revision_id=h.revision_id
      WHERE h.lifecycle='active' AND (h.scope_resolved=0 OR r.type='fact')`).length, 0, `${name}: ineligible active head`);
    summary.info = all('SELECT delivery, read_state FROM host_info_batches ORDER BY rowid').map(row => [row.delivery, row.read_state]);
    summary.entries = entries.length;
    summary.verificationRuns = Number(all('SELECT count(*) AS n FROM verification_runs')[0]!.n);
    const pendingCaptures = all("SELECT * FROM capture_jobs WHERE status='pending'");
    for (const job of pendingCaptures) {
      assert.equal(job.record_id, null);
      assert.equal(sha256(String(job.payload)), job.payload_hash);
      const pending = JSON.parse(String(job.payload));
      assert.equal(pending.reason, 'memory-type-required');
      const event = archiveEvent(pending.source);
      assert.equal(event.role, 'user');
      assert(/^记住[：:]/u.test(event.text.trim()), `${name}: pending owner capture source`);
      assert.deepEqual(pending.range, [pending.source]);
    }
    summary.pendingCaptures = pendingCaptures.length;
    summary.payloadHashes = all('SELECT payload_hash FROM request_assemblies').map(row => String(row.payload_hash));
    const receiver = readFileSync(join(root, 'counting-receiver.jsonl'), 'utf8').trimEnd().split('\n').slice(1)
      .map(line => JSON.parse(line) as { record: { payloadHash: string }; hash: string });
    for (const item of receiver) assert.equal(item.hash, sha256(JSON.stringify(item.record)), `${name}: receiver record hash`);
    summary.received = receiver.map(item => item.record.payloadHash);
    summary.usedMemories = all('SELECT used_memories FROM request_assemblies').map(row => JSON.parse(String(row.used_memories)) as { recordId: string }[]);
    summary.digests = [...batches.map(batch => String(batch.payload_hash)), ...batches.map(batch => String(batch.batch_id)),
      ...entries.map(entry => String(entry.record.entryId)), ...entries.map(entry => entry.entryHash)];
    summary.archive = archive.map(event => ({ role: event.role, eventId: event.eventId }));
    summary.scopes = all('SELECT scope_kind, scope_resolved FROM memory_heads ORDER BY rowid').map(row => [row.scope_kind, row.scope_resolved]);
    summary.heads = all(`SELECT h.record_id, h.lifecycle, h.verification, h.scope_resolved, r.type, r.content FROM memory_heads h
      JOIN memory_revisions r ON r.record_id=h.record_id AND r.revision_id=h.revision_id ORDER BY h.rowid`)
      .map(row => ({ recordId: String(row.record_id), lifecycle: row.lifecycle, verification: row.verification,
        resolved: row.scope_resolved === 1, type: row.type, content: String(row.content) }));
    summary.histories = Object.fromEntries(records.map(recordId => [recordId,
      all('SELECT kind FROM memory_events WHERE record_id=? ORDER BY seq', recordId).map(row => String(row.kind))]));
    return summary;
  } finally { db.close(); }
}

const rawValidation = (() => {
  try {
    assert.equal(scenarioError, null, 'scenario did not complete');
    const summaries = new Map([...roots].map(([name, root]) => [name, validateRoot(name, root)]));
    type Head = { recordId: string; lifecycle: string; verification: string; resolved: boolean; type: string; content: string };
    const main = summaries.get('main')!;
    // Which records are the preference and the fact comes from SQLite, not from what the CLI printed.
    const mainHeads = main.heads as Head[];
    const preferenceHead = mainHeads.find(head => head.type === 'preference')!;
    const factHead = mainHeads.find(head => head.type === 'fact')!;
    assert(preferenceHead && factHead && mainHeads.length === 3, 'main: canonical heads');
    assert.deepEqual([main.records, main.active, main.batches, main.entries], [3, 2, 2, 2], 'main: canonical counts');
    assert.deepEqual(main.info, [['delivered', 'read'], ['delivered', 'read']], 'main: Info state after open');
    const asked = byEvent('main', 'ask-result');
    assert.equal(asked.length, 1, 'main: one model dispatch');
    const payload = String(asked[0]!.payload);
    assert((main.payloadHashes as string[]).includes(sha256(payload)) && (main.received as string[]).includes(sha256(payload)),
      'main: stdout payload is not the ledgered and received bytes');
    for (const identity of main.digests as string[]) assert.equal(payload.includes(identity), false, 'main: Info identity reached the model');
    const sent = JSON.parse(payload).memories as { kind: string; recordId: string }[];
    for (const item of sent) {
      const head = mainHeads.find(row => row.recordId === item.recordId);
      assert(item.kind === 'untrusted-memory' && head && head.lifecycle === 'active' && head.verification === 'verified'
        && head.resolved && head.type !== 'fact', 'main: model received an ineligible memory');
    }
    assert(sent.some(item => item.recordId === preferenceHead.recordId) && !sent.some(item => item.recordId === factHead.recordId),
      'main: model memory set');
    const used = (main.usedMemories as { recordId: string }[][]).flat().map(item => item.recordId);
    assert(used.includes(preferenceHead.recordId) && !used.includes(factHead.recordId), 'main: used memory set');
    assert.equal(byEvent('main-restart', 'command-rejected')[0]?.reason, 'synthetic-proposals-disabled', 'main: forged proposal accepted');
    assert.equal((main.archive as { role: string }[]).filter(event => event.role === 'assistant').length, 1, 'main: forged assistant event');
    assert.deepEqual(byEvent('main-restart', 'remember-result'), [], 'main: restart re-activated');
    assert.deepEqual(byEvent('main-restart', 'info-notice'), [], 'main: restart re-delivered');
    for (const scenario of KILLS) {
      const summary = summaries.get(scenario)!;
      assert.deepEqual([summary.records, summary.active, summary.batches, summary.entries], [1, 1, 1, 1], `${scenario}: exactly once`);
      const read = scenario === 'crash-after-info-read' ? 'read' : 'unread';
      assert.deepEqual(summary.info, [['delivered', read]], `${scenario}: Info state`);
      assert.equal(byEvent(scenario, 'owner-checkpoint').length, 1, `${scenario}: kill point reached`);
      const restartNotices = byEvent(`${scenario}-restart`, 'info-notice').length;
      assert.equal(restartNotices, ['crash-after-info-delivery', 'crash-before-info-read', 'crash-after-info-read'].includes(scenario) ? 0 : 1,
        `${scenario}: redelivery count`);
    }
    const query = byEvent('crash-after-activation-commit-info-query', 'info-list')[0];
    assert.deepEqual([query?.pending, query?.unread], [1, 1], 'no-session query sees the pending batch');
    const failure = summaries.get('write-failure')!;
    assert.equal(facts.writeFailurePrecondition, true, 'write-failure precondition');
    assert.deepEqual([failure.records, failure.active, failure.entries, failure.info], [1, 1, 1, [['delivered', 'unread']]]);
    const failed = byEvent('write-failure', 'remember-result')[0];
    assert.deepEqual([failed?.status, failed?.info, failed?.level], ['activated', 'pending-redelivery', 'error']);
    assert.equal(byEvent('write-failure', 'ask-refused')[0]?.reason, 'host-info-recovery-required');
    assert.equal(byEvent('write-failure', 'info-notice').length, 1);
    const unavailable = summaries.get('unavailable')!;
    const blocked = byEvent('unavailable', 'remember-result')[0];
    assert.deepEqual([blocked?.status, blocked?.stage, blocked?.reason, blocked?.batchId], ['blocked', 'verified', 'host-info-unavailable', null]);
    assert.deepEqual([unavailable.records, unavailable.active, unavailable.verificationRuns, unavailable.entries], [1, 1, 1, 1]);
    const boundaries = summaries.get('boundaries')!;
    assert.deepEqual([boundaries.records, boundaries.active, boundaries.batches, boundaries.entries, boundaries.verificationRuns], [1, 0, 0, 0, 0]);
    assert.deepEqual(boundaries.scopes, [['session', 0]]);
    assert.equal(boundaries.pendingCaptures, 1, 'boundaries: untyped remember has a durable job');
    assert.deepEqual(byEvent('boundaries', 'remember-result').map(item => [item.status, item.reason]), [
      ['blocked', 'scope-unresolved'], ['needs-input', 'memory-type-required'], ['cancelled', 'owner-declined'],
      ['not-actionable', 'agreement-target-missing'], ['error', 'file-identity-changed']]);
    const changes = summaries.get('owner-changes')!;
    const changeHeads = changes.heads as Head[];
    const rolled = changeHeads.find(head => head.type === 'preference')!;
    const corrected = changeHeads.find(head => head.type === 'decision')!;
    assert.deepEqual([changes.records, changes.active, changes.batches, changes.entries], [2, 2, 2, 2], 'owner-changes: counts');
    const histories = changes.histories as Record<string, string[]>;
    assert.deepEqual([histories[rolled.recordId], rolled.lifecycle], [['capture', 'verify', 'activate', 'rollback'], 'candidate'],
      'owner-changes: the rollback survived the restart');
    assert.deepEqual([histories[corrected.recordId], corrected.lifecycle, corrected.content === fixture.ownerChanges.correction],
      [['capture', 'verify', 'activate', 'correct'], 'active', true], 'owner-changes: the correction survived the restart');
    assert.deepEqual(changes.info, [['delivered', 'read'], ['delivered', 'unread']], 'owner-changes: Info state');
    for (const event of ['remember-result', 'info-notice', 'info-error', 'command-error']) {
      assert.deepEqual(byEvent('owner-changes-restart', event), [], `owner-changes: restart emitted ${event}`);
    }
    const [member] = (byEvent('owner-changes-info', 'info-view')[0]?.members ?? []) as { recordId: string; after: { lifecycle: string };
      current: { lifecycle: string } | null; changed: boolean }[];
    assert.deepEqual([member?.recordId, member?.after.lifecycle, member?.current?.lifecycle, member?.changed],
      [rolled.recordId, 'active', 'candidate', true], 'owner-changes: Info shows the frozen activation and the current rollback');
    return { status: 'pass' as const, roots: [...summaries.keys()] };
  } catch (error) { return { status: 'fail' as const, error: diagnostic('raw-validation-failed', error) }; }
})();

const focusedArgs = ['--test', 'apps/cli/test/owner-memory.test.ts', 'apps/cli/test/owner-memory-cli.test.ts'];
const focusedStartedAt = new Date().toISOString();
const focused = spawnSync(process.execPath, focusedArgs, { cwd: repo, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const focusedFinishedAt = new Date().toISOString();
const focusedPass = focused.status === 0 && focused.signal === null && !focused.error;
writeFileSync(join(directory, 'focused-test.txt'), String(focused.stdout ?? ''), { flag: 'wx' });
writeFileSync(join(directory, 'focused-stderr.txt'), String(focused.stderr ?? ''), { flag: 'wx' });
processes.push({ label: 'focused-tests', command: process.execPath, args: focusedArgs, cwd: repo, startedAt: focusedStartedAt,
  finishedAt: focusedFinishedAt, code: focused.status, signal: focused.signal,
  stdout: { path: 'focused-test.txt', sha256: sha256(String(focused.stdout ?? '')) }, stderr: { path: 'focused-stderr.txt', sha256: sha256(String(focused.stderr ?? '')) } });

const assertions = [
  { name: 'real CLI scenarios complete', passed: scenarioError === null },
  { name: 'independent raw archive/owner-info/SQLite validation passes', passed: rawValidation.status === 'pass' },
  { name: 'focused T12 tests pass', passed: focusedPass },
].map(assertion => assertion.passed ? assertion : { ...assertion, error: scenarioError ?? (rawValidation.status === 'fail' ? rawValidation.error : 'assertion failed') });
// Mandatory 12 X-07/X-11 items this ticket does not exercise stay explicit gaps (never pass).
const evidenceGaps = [
  'X-11: Info after a logical purge of a batch member (no body resurrection, redacted batch not rebuilt) is unverified; purge is T21/T22b, whose closure must include host_info_batches and owner-info.jsonl',
  'X-07: later project confirmation of a session-local unresolved candidate has no Host entry yet and is unverified',
  'Untyped explicit remember requests persist as pending capture jobs; semantic extraction/processing of that normal-lane queue belongs to T13 and is not exercised here',
  'The agreed assistant proposal is a synthetic archive event (--synthetic-proposals); real provider/model turns and authenticated owner UI remain unverified',
  'Non-CLI Host modes (Pi TUI/RPC/JSON/print) and their X-10/X-11 presentation evidence are deferred',
  'Source append crash/unknown outcome for the owner statement itself remains unverified (#38)',
  'Other OS host results require their matching CI artifacts',
];
type EvidenceStatus = 'pass' | 'fail' | 'evidence-gap';
const runtimeStatus = assertions.every(assertion => assertion.passed) ? 'pass' : 'fail';
const status: EvidenceStatus = runtimeStatus === 'fail' ? 'fail' : evidenceGaps.length ? 'evidence-gap' : 'pass';
const exitCode = status === 'fail' ? 1 : 0;
const stripped = new Set(['content', 'text', 'payload', 'members', 'accepted', 'commands', 'infoPath']);
const observations = Object.fromEntries([...outputs].map(([label, items]) => [label,
  JSON.parse(JSON.stringify(items, (key, value) => stripped.has(key) ? undefined : value))]));
const writeConsole = (receiptStatus: EvidenceStatus, receiptError: string | null) => JSON.stringify({
  path: join(directory, 'summary.json'), status: receiptStatus, passed: receiptStatus === 'pass',
  evidenceGap: receiptStatus === 'evidence-gap', fixtureDigest, scenarioError, receiptError }) + '\n';
writeFileSync(join(directory, 'fixture.json'), bytes, { flag: 'wx' });
let consoleOutput = writeConsole(status, null);
writeFileSync(join(directory, 'console-output.txt'), consoleOutput, { flag: 'wx' });
writeFileSync(join(directory, 'main-stderr.txt'), mainStderr.join(''), { flag: 'wx' });
const finishedAt = new Date().toISOString();
const git = (...args: string[]) => execFileSync('git', ['--no-optional-locks', ...args], { cwd: repo, encoding: 'utf8' }).trim();
const files = listFiles(directory).filter(path => path !== 'summary.json').map(path => ({ path, sha256: sha256(readFileSync(join(directory, path))) }));
const digestOf = (path: string) => files.find(file => file.path === path)!.sha256;
const mainProcess: ProcessReceipt = { label: 'evidence-runner', command: process.execPath, args: [...process.execArgv, ...process.argv.slice(1)], cwd: repo,
  startedAt, finishedAt, code: exitCode, signal: null,
  stdout: { path: 'console-output.txt', sha256: digestOf('console-output.txt') }, stderr: { path: 'main-stderr.txt', sha256: digestOf('main-stderr.txt') } };
controlledSideEffects.push({ path: directory, disposition: 'retain', existsAtFinish: existsSync(directory) });
const database = files.filter(file => file.path.startsWith('raw/') && /probe\.sqlite(-wal|-shm)?$/.test(file.path));
const output = {
  schema: 't12-owner-memory-evidence@1', schemaVersion: 1, experimentId: 'X-07/X-10/X-11/T12-owner-memory-fast-lane-synthetic',
  specCommit: '56217fc292a1a640805ee65096d60ff014430db3',
  authorityRefs: ['https://github.com/qsgy-edge/euler/issues/12', 'docs/implementation/t12-owner-memory-fast-lane.md',
    'docs/architecture/issues/12-build-evidence-experiment-matrix.md#x-11--按模式验收-durable-pending-与恢复',
    'docs/architecture/issues/15-euler-v1-spec.md (I05/I06/I07/I17)'],
  command: { executable: process.execPath, args: [...process.execArgv, ...process.argv.slice(1)], cwd: repo },
  startedAt, finishedAt, implementationCommit: git('rev-parse', 'HEAD'), implementationTree: git('rev-parse', 'HEAD^{tree}'), workingTree: git('status', '--short'),
  environment: { platform: process.platform, release: release(), architecture: arch(), node: process.version,
    sqlite: process.versions.sqlite ?? 'unknown', provider: 'none: local counting transport only', model: 'none',
    adapter: 'euler-cli-owner-session@1', runner: process.env.CI ? 'CI' : 'local' },
  fixture: { path: 'fixtures/t12-owner-memory-cases.json', rawDigest: fixtureDigest, digest: fixtureDigest, synthetic: true, heldOut: false },
  heldOut: { digest: null, owner: null, sealedCommit: null, releasedCommit: null, contaminationCaseIds: [], replacementCaseIds: [],
    applicability: 'not-applicable: deterministic synthetic fixture; no held-out quality claim' },
  processes: [mainProcess, ...processes], assertions, files, controlledSideEffects,
  artifactDigests: { stdout: mainProcess.stdout, stderr: mainProcess.stderr, database,
    sidecars: files.filter(file => file.path.startsWith('raw/') && !database.includes(file)) },
  independentValidation: { method: 'raw archive/owner-info/SQLite recomputation with node:crypto and a documented-grammar check; no Core replay',
    verifier: { path: 'scripts/evidence-owner-memory.ts', sha256: sha256(readFileSync(new URL('./evidence-owner-memory.ts', import.meta.url))) },
    status: rawValidation.status },
  rawValidation, observations, scenarioError, focusedPass, status, exit: { code: exitCode, signal: null as string | null }, evidenceGaps,
  receiptError: null as string | null,
};
function validateReceipt(receipt: typeof output) {
  for (const key of ['schema', 'schemaVersion', 'experimentId', 'specCommit', 'authorityRefs', 'command', 'startedAt', 'finishedAt',
    'implementationCommit', 'implementationTree', 'workingTree', 'environment', 'fixture', 'heldOut', 'processes', 'assertions', 'files',
    'controlledSideEffects', 'artifactDigests', 'independentValidation', 'status', 'exit', 'evidenceGaps'] as const) assert.ok(Object.hasOwn(receipt, key), `missing ${key}`);
  assert.ok(receipt.authorityRefs.length > 0);
  assert.ok(['pass', 'fail', 'evidence-gap'].includes(receipt.status));
  if (receipt.status === 'pass') assert.equal(receipt.evidenceGaps.length, 0);
  if (receipt.status === 'evidence-gap') assert(receipt.evidenceGaps.length > 0);
  for (const key of ['platform', 'release', 'architecture', 'node', 'sqlite', 'provider', 'model', 'adapter'] as const) assert.ok(receipt.environment[key]);
  for (const key of ['digest', 'owner', 'sealedCommit', 'releasedCommit', 'contaminationCaseIds', 'replacementCaseIds', 'applicability'] as const) {
    assert.ok(Object.hasOwn(receipt.heldOut, key), `missing heldOut.${key}`);
  }
  assert.equal(receipt.fixture.rawDigest, sha256(readFileSync(join(repo, receipt.fixture.path))));
  assert.ok(receipt.command.executable && receipt.command.args.length > 0 && receipt.command.cwd);
  assert.ok(Date.parse(receipt.finishedAt) >= Date.parse(receipt.startedAt));
  assert.ok(receipt.assertions.length > 0 && receipt.assertions.every(assertion => Object.hasOwn(assertion, 'name') && Object.hasOwn(assertion, 'passed')));
  assert.ok(receipt.processes.length > 2);
  for (const item of receipt.processes) {
    assert.ok(item.command && item.args && item.cwd && Date.parse(item.finishedAt) >= Date.parse(item.startedAt));
    assert.ok(Object.hasOwn(item, 'code') && Object.hasOwn(item, 'signal'));
    assert.equal(item.stdout.sha256, receipt.files.find(file => file.path === item.stdout.path)?.sha256, `stdout digest: ${item.label}`);
    assert.equal(item.stderr.sha256, receipt.files.find(file => file.path === item.stderr.path)?.sha256, `stderr digest: ${item.label}`);
  }
  assert.equal(receipt.exit.code, receipt.status === 'fail' ? 1 : 0);
  assert.ok(receipt.artifactDigests.database.length > 0 && receipt.artifactDigests.sidecars.length > 0);
  assert.equal(receipt.independentValidation.verifier.sha256, sha256(readFileSync(join(repo, receipt.independentValidation.verifier.path))));
  const serialized = JSON.stringify(receipt);
  assert.ok(fixtureBodies.length > 0, 'fixture body extraction');
  for (const [index, body] of fixtureBodies.entries()) {
    assert.equal(serialized.includes(body), false, `receipt embeds fixture body #${index}`);
  }
  for (const file of receipt.files) {
    assert.ok(!file.path.startsWith('/') && !file.path.split('/').includes('..'));
    assert.equal(file.sha256, sha256(readFileSync(join(directory, file.path))), `raw digest: ${file.path}`);
  }
  for (const effect of receipt.controlledSideEffects) assert.equal(effect.existsAtFinish, effect.disposition === 'retain', effect.path);
}
let receiptError: string | null = null;
try { validateReceipt(output); }
catch (error) { receiptError = diagnostic('receipt-validation-failed', error); }
if (receiptError) {
  output.receiptError = receiptError;
  output.status = 'fail';
  output.exit.code = 1;
  output.independentValidation.status = 'fail';
  mainProcess.code = 1;
  consoleOutput = writeConsole('fail', receiptError);
  writeFileSync(join(directory, 'console-output.txt'), consoleOutput);
  const stdoutFile = output.files.find(file => file.path === 'console-output.txt')!;
  stdoutFile.sha256 = sha256(consoleOutput);
  mainProcess.stdout.sha256 = stdoutFile.sha256;
}
// Include diagnostics created by receipt validation itself.
for (const path of listFiles(join(directory, 'errors')).map(name => `errors/${name}`)) {
  if (!output.files.some(file => file.path === path)) output.files.push({ path, sha256: sha256(readFileSync(join(directory, path))) });
}
const serializedOutput = JSON.stringify(output, null, 2) + '\n';
if (fixtureBodies.some(body => serializedOutput.includes(body))) {
  // Fail closed: never re-emit the rejected object. Keep it only in the owner-held raw area.
  const rawPath = 'errors/rejected-receipt.json';
  writeFileSync(join(directory, rawPath), serializedOutput, { flag: 'wx' });
  const safeFailure = { schema: 't12-owner-memory-evidence-failure@1', status: 'fail', exit: { code: 1, signal: null },
    reason: 'receipt-body-rejected', raw: { path: rawPath, sha256: sha256(serializedOutput) } };
  consoleOutput = JSON.stringify({ path: join(directory, 'summary.json'), status: 'fail', reason: safeFailure.reason }) + '\n';
  writeFileSync(join(directory, 'console-output.txt'), consoleOutput);
  writeFileSync(join(directory, 'summary.json'), JSON.stringify(safeFailure, null, 2) + '\n', { flag: 'wx' });
  process.exitCode = 1;
} else {
  writeFileSync(join(directory, 'summary.json'), serializedOutput, { flag: 'wx' });
  if (output.status === 'fail') process.exitCode = 1;
}
process.stdout.write(consoleOutput);
