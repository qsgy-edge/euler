import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform, release, arch } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { sha256 } from '@euler/core';
import { createSandbox, resourcesOf } from '../apps/cli/src/sandbox.ts';
import type { Sandbox } from '../apps/cli/src/sandbox.ts';

const repo = fileURLToPath(new URL('../', import.meta.url));
const startedAt = new Date().toISOString();
const destination = join(repo, 'artifacts', `t13-${startedAt.replace(/[:.]/g, '-')}`);
mkdirSync(destination, { recursive: true });
const fixtureBytes = readFileSync(join(repo, 'fixtures/t13-capture-cases.json'));
const fixture = JSON.parse(fixtureBytes.toString('utf8')) as { schema: string; input: string; claim: { content: string; type: string };
  cases: { id: string; scenario: string; stage: string; verification: string | null; attempts: number }[];
  handoff: { section: string; privateText: string } };
const commands: { id: string; command: string[]; startedAt: string; endedAt: string; exitCode: number | null; signal: string | null;
  stdout: string; stderr: string; spawnError: boolean }[] = [];
const assertions: { id: string; passed: boolean; diagnostic?: string }[] = [];
const roots: { id: string; path: string; retainedCopy: string }[] = [];
const actualStdout: string[] = [];
const pathOf = (path: string) => relative(destination, path).replaceAll('\\', '/');
function record(path: string, bytes: string | Buffer): string {
  const target = join(destination, path); mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, bytes); return path;
}
function check(id: string, action: () => void): void {
  try { action(); assertions.push({ id, passed: true }); }
  catch (error) { const diagnostic = record(`errors/${id}.txt`, error instanceof Error ? error.stack ?? error.message : String(error));
    assertions.push({ id, passed: false, diagnostic }); }
}
function invoke(id: string, args: string[], crash = false): string {
  const start = new Date().toISOString();
  const result = spawnSync(process.execPath, args, { cwd: repo, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  const stdout = result.stdout ?? '', stderr = result.stderr ?? '';
  actualStdout.push(stdout);
  commands.push({ id, command: [process.execPath, ...args], startedAt: start, endedAt: new Date().toISOString(), exitCode: result.status,
    signal: result.signal, stdout: record(`processes/${id}.stdout.txt`, stdout), stderr: record(`processes/${id}.stderr.txt`, stderr), spawnError: !!result.error });
  assert.equal(result.error, undefined);
  if (crash) { assert(result.signal === 'SIGKILL' || result.status !== 0); assert.doesNotMatch(stderr, /Error:|ERR_/); }
  else assert.equal(result.status, 0);
  return stdout;
}
function raw(sandbox: Sandbox) {
  const lines = readFileSync(join(sandbox.root, 'session.jsonl'), 'utf8').trimEnd().split('\n');
  const header = JSON.parse(lines.shift()!);
  const events = lines.map(line => ({ line, event: JSON.parse(line) as { schema: string; eventId: string; role: string; text: string } }));
  assert.equal(header.schema, 'cli-session@1');
  const ack = (eventId: string) => {
    const item = events.find(item => item.event.eventId === eventId); assert(item);
    assert.equal(item.line, JSON.stringify(item.event));
    return { schema: 'cli-source-ack@1', status: 'durable', binding: header.binding, eventId,
      locator: `cli-jsonl@1/${header.binding.sessionId}/${eventId}`, hash: sha256(item.line), byteLength: Buffer.byteLength(item.line), contentHash: sha256(item.event.text) };
  };
  return { header, events, ack };
}
function database(sandbox: Sandbox, run: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(resourcesOf(sandbox).store.path, { readOnly: true });
  try { assert.equal(db.prepare('PRAGMA quick_check').get()!.quick_check, 'ok'); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); run(db); }
  finally { db.close(); }
}
function keep(id: string, sandbox: Sandbox): void {
  const copy = join(destination, 'raw', id);
  cpSync(sandbox.root, copy, { recursive: true, errorOnExist: true, force: false });
  roots.push({ id, path: sandbox.root, retainedCopy: pathOf(copy) });
}

check('fixture', () => { assert.equal(fixture.schema, 't13-capture-cases@1'); assert.equal(fixture.cases.length, 5); });
record('fixture.json', fixtureBytes);
for (const entry of fixture.cases) {
  const sandbox = createSandbox();
  try {
    check(entry.id, () => {
      const stdout = invoke(`${entry.id}-run`, ['apps/cli/src/main.ts', 'capture', '--sandbox', sandbox.root, '--scenario', entry.scenario]);
      const before = readFileSync(join(sandbox.root, 'counting-receiver.jsonl'), 'utf8');
      invoke(`${entry.id}-replay`, ['apps/cli/src/main.ts', 'capture', '--sandbox', sandbox.root, '--scenario', entry.scenario]);
      assert.equal(readFileSync(join(sandbox.root, 'counting-receiver.jsonl'), 'utf8'), before);
      const archive = raw(sandbox);
      database(sandbox, db => {
        const jobs = db.prepare('SELECT * FROM capture_jobs').all(); assert.equal(jobs.length, 1);
        const job = jobs[0]!; const payload = JSON.parse(String(job.payload));
        assert.equal(sha256(String(job.payload)), job.payload_hash);
        assert.equal(archive.events.find(item => item.event.eventId === payload.source.eventId)!.event.text, fixture.input);
        assert.deepEqual(payload.source, archive.ack(payload.source.eventId));
        assert.deepEqual(payload.range, [payload.source]); assert.equal(payload.ownerId, archive.header.binding.ownerId);
        const work = db.prepare('SELECT * FROM capture_work WHERE job_id=?').get(String(job.job_id))!;
        assert.equal(work.stage, entry.stage);
        const stream = db.prepare('SELECT * FROM execution_streams WHERE owner_kind=\'job\' AND owner_id=?').get(String(job.job_id))!;
        const run = db.prepare('SELECT * FROM request_runs WHERE run_id=?').get(String(work.run_id))!;
        assert.equal(run.stream_id, stream.stream_id); assert.equal(run.owner_id, job.job_id);
        const attempts = db.prepare('SELECT * FROM request_attempts WHERE run_id=? ORDER BY rowid').all(String(run.run_id));
        assert.equal(attempts.length, entry.attempts);
        const requests = stdout.trim().split('\n').map(line => JSON.parse(line)).filter(item => item.event === 'capture-request');
        assert.equal(requests.length, entry.attempts);
        const receiver = before.trim().split('\n').slice(1).map(line => JSON.parse(line));
        assert.equal(receiver.length, entry.attempts);
        for (const attempt of attempts) {
          const request = requests.find(item => item.attemptId === attempt.attempt_id); assert(request);
          const accepted = receiver.find(item => item.record.attemptId === attempt.attempt_id); assert(accepted);
          assert.equal(sha256(JSON.stringify(accepted.record)), accepted.hash);
          assert.equal(sha256(request.request.payload), attempt.payload_hash);
          assert.equal(Buffer.byteLength(request.request.payload), attempt.byte_length);
          assert.equal(accepted.record.payloadHash, attempt.payload_hash);
          const assembly = db.prepare('SELECT * FROM request_assemblies WHERE assembly_id=?').get(String(attempt.assembly_id))!;
          const envelope = JSON.parse(request.request.payload);
          const route = JSON.parse(String(assembly.route));
          assert.equal(envelope.model, route.actual.model); assert.equal(envelope.provider, route.actual.provider);
          if (route.role === 'verifier') {
            assert(assembly.claim_head_event_id);
            const claim = JSON.parse(String(db.prepare('SELECT after_snapshot FROM memory_events WHERE event_id=?').get(assembly.claim_head_event_id)!.after_snapshot));
            assert.equal(JSON.parse(envelope.p3.messages[0].content).claim.content, claim.content);
            if (envelope.p2.length === 0) assert.equal(envelope.p3.intent.step, 'verifier');
          }
        }
        assert.equal(db.prepare("SELECT count(*) AS n FROM memory_heads WHERE lifecycle='active'").get()!.n, 0);
        assert.equal(db.prepare('SELECT count(*) AS n FROM host_info_batches').get()!.n, 0);
        if (entry.verification === null) assert.equal(work.record_id, null);
        else {
          const head = db.prepare('SELECT * FROM memory_heads WHERE record_id=?').get(String(work.record_id))!;
          const snapshot = JSON.parse(String(head.snapshot));
          assert.equal(sha256(String(head.snapshot)), head.snapshot_hash);
          assert.equal(snapshot.content, fixture.claim.content); assert.equal(snapshot.type, fixture.claim.type);
          assert.equal(snapshot.verification, entry.verification);
          const first = db.prepare('SELECT after_snapshot FROM memory_events WHERE record_id=? ORDER BY seq LIMIT 1').get(String(work.record_id))!;
          assert.equal(JSON.parse(String(first.after_snapshot)).verification, 'unverified');
          assert.equal(JSON.parse(String(first.after_snapshot)).lifecycle, 'candidate');
          const verification = db.prepare('SELECT * FROM verification_runs WHERE run_id=?').get(String(head.verification_run_id))!;
          assert.equal(verification.verifier, 'independent-verifier@1');
          assert.equal(sha256(String(verification.evidence_json)), verification.evidence_hash);
          for (const ref of JSON.parse(String(verification.evidence_json))) assert.deepEqual(ref, archive.ack(ref.eventId));
          if (entry.verification === 'verified') {
            const tools = archive.events.filter(item => item.event.role === 'tool').map(item => JSON.parse(item.event.text));
            assert(tools.some(item => item.schema === 'capture-tool@1' && JSON.parse(item.modelResult).results));
            assert(tools.some(item => item.schema === 'capture-tool@1' && JSON.parse(item.modelResult).ref?.eventId === payload.source.eventId));
          }
        }
      });
    });
  } finally { keep(entry.id, sandbox); }
}

for (const point of ['before-send','after-send','after-proposal']) {
  const id = `crash-${point}`, sandbox = createSandbox();
  try {
    check(id, () => {
      invoke(id, ['apps/cli/test/support/capture-crash-worker.ts', sandbox.root, point], true);
      let jobId = '';
      database(sandbox, db => { jobId = String(db.prepare('SELECT job_id FROM capture_work').get()!.job_id); });
      invoke(`${id}-status`, ['apps/cli/src/main.ts', 'capture-status', '--sandbox', sandbox.root, '--job', jobId]);
      if (point !== 'after-proposal') invoke(`${id}-query`, ['apps/cli/src/main.ts', 'capture-reconcile', '--sandbox', sandbox.root, '--job', jobId]);
      database(sandbox, db => {
        const attempts = db.prepare('SELECT * FROM request_attempts').all(); assert.equal(attempts.length, 1);
        assert.equal(attempts[0]!.outcome, point === 'after-proposal' ? 'received' : 'unknown-sent');
        if (point !== 'after-proposal') {
          const receipt = db.prepare("SELECT payload FROM request_events WHERE kind='model/request-attempt-reconciled@v1'").get()!;
          assert.equal(JSON.parse(String(receipt.payload)).evidence.outcome, point === 'before-send' ? 'not-received' : 'received');
        }
        assert.equal(db.prepare("SELECT count(*) AS n FROM memory_heads WHERE lifecycle='active'").get()!.n, 0);
      });
    });
  } finally { keep(id, sandbox); }
}

const handoff = createSandbox();
try {
  check('handoff', () => {
    const stdout = invoke('handoff', ['apps/cli/src/main.ts', 'handoff', '--sandbox', handoff.root, '--scenario', 'synthetic']);
    const result = stdout.trim().split('\n').map(line => JSON.parse(line)).find(item => item.event === 'handoff-result');
    const archive = raw(handoff);
    const documents = archive.events.filter(item => item.event.text.startsWith('<!-- euler-analysis-artifact@1 ')).map(item => {
      const split = item.event.text.indexOf(' -->\n\n');
      const header = JSON.parse(item.event.text.slice('<!-- euler-analysis-artifact@1 '.length, split));
      const body = item.event.text.slice(split + ' -->\n\n'.length);
      assert.equal(sha256(body), header.bodyHash);
      return { item, header, body };
    });
    assert.equal(documents.length, 2);
    const exported = documents.find(doc => doc.header.kind === 'export')!;
    assert.equal(exported.body, result.markdown); assert.equal(sha256(result.markdown), result.exportHash);
    assert(exported.body.includes(fixture.handoff.section)); assert(!exported.body.includes(fixture.handoff.privateText));
    database(handoff, db => {
      const unit = db.prepare('SELECT * FROM source_units').get()!;
      const report = documents.find(doc => doc.header.kind === 'report')!;
      const selected = Array.from(report.item.event.text).slice(Number(unit.offset), Number(unit.offset) + Number(unit.length)).join('');
      assert.equal(selected, fixture.handoff.section); assert.equal(sha256(selected), unit.content_hash);
      assert.equal(unit.source_owner, archive.header.binding.sessionId);
      assert.equal(unit.source_project_id, archive.header.binding.projectId);
      assert.equal(db.prepare('SELECT count(*) AS n FROM memory_records').get()!.n, 0);
      assert.equal(db.prepare('SELECT count(*) AS n FROM request_attempts').get()!.n, 0);
    });
  });
} finally { keep('handoff', handoff); }

record('console-output.txt', actualStdout.join(''));
const artifacts: { path: string; sha256: string; byteLength: number }[] = [];
function inventory(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) inventory(path);
    else { const bytes = readFileSync(path); artifacts.push({ path: pathOf(path), sha256: sha256(bytes), byteLength: bytes.length }); }
  }
}
inventory(destination);
const git = (...args: string[]) => execFileSync('git', ['--no-optional-locks', ...args], { cwd: repo, encoding: 'utf8' }).trim();
const passed = assertions.length === 10 && assertions.every(item => item.passed);
const receipt = { schema: 't13-capture-evidence@1', status: passed ? 'evidence-gap' : 'failed', syntheticChecksPassed: passed,
  command: [process.execPath, ...process.argv.slice(1)], startedAt, endedAt: new Date().toISOString(), exitCode: passed ? 0 : 1,
  implementation: { commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain').length > 0, diffHash: sha256(git('diff', 'HEAD')) },
  environment: { platform: platform(), release: release(), arch: arch(), node: process.version }, fixtureDigest: sha256(fixtureBytes),
  commands, assertions, artifactDigests: artifacts, controlledSideEffects: { retainedSyntheticRoots: roots },
  evidenceGaps: ['real-provider-and-model-quality', 'non-cli-host-integration', 't20-backup-and-recovery-owner',
    't22-controlled-purge-closure', 't24-combined-acceptance', 't11-38-torn-archive-append-faults'] };
const encoded = JSON.stringify(receipt, null, 2) + '\n';
assert([fixture.input, fixture.claim.content, fixture.handoff.section, fixture.handoff.privateText]
  .every(body => !encoded.includes(body) && !encoded.includes(JSON.stringify(body).slice(1, -1))), 'receipt-body-leak');
record('receipt.json', encoded);
console.log(JSON.stringify({ receipt: join(destination, 'receipt.json'), status: receipt.status, syntheticChecksPassed: passed,
  assertions: assertions.length, failures: assertions.filter(item => !item.passed).map(item => item.id) }));
if (!passed) process.exitCode = 1;
