import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { arch, release } from 'node:os';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const args = parseArgs({ options: { 'transport-config': { type: 'string' } } });
const directory = join('artifacts', 't19-' + Date.now()); mkdirSync(directory, { recursive: true });
const startedAt = new Date().toISOString();
const fixture = JSON.parse(readFileSync('fixtures/t19-historian-cases.json', 'utf8'));
const scenarios = args.values['transport-config'] ? ['real'] : ['synthetic','protocol','block','evidence-gap','unknown','cancel'];
const observations: Record<string, unknown>[] = [];
let failure: string | null = null;
for (const scenario of scenarios) {
  const path = join(directory, scenario); mkdirSync(path);
  const command = ['apps/cli/src/main.ts', 'historian', '--scenario', scenario,
    ...(args.values['transport-config'] ? ['--transport-config', args.values['transport-config']] : [])];
  const child = spawnSync(process.execPath, command, { encoding: 'utf8', maxBuffer: 4_194_304 });
  writeFileSync(join(path, 'stdout.jsonl'), child.stdout ?? ''); writeFileSync(join(path, 'stderr.txt'), child.stderr ?? '');
  let root: string | undefined, copied = false;
  try {
    assert.equal(child.status, 0);
    const events = child.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    root = events.find(event => event.event === 'sandbox')?.root;
    assert.ok(root && basename(root).startsWith('euler-t01-'));
    const result = events.find(event => event.event === 'historian-result'); assert.ok(result);
    const reopened = spawnSync(process.execPath, ['apps/cli/src/main.ts', 'capture-status', '--sandbox', root, '--job', result.jobId], { encoding: 'utf8' });
    writeFileSync(join(path, 'reopened.stdout.jsonl'), reopened.stdout ?? ''); writeFileSync(join(path, 'reopened.stderr.txt'), reopened.stderr ?? '');
    assert.equal(reopened.status, 0);
    const status = reopened.stdout.trim().split('\n').map(line => JSON.parse(line)).find(event => event.event === 'capture-status');
    assert.equal(status.jobs[0].jobId, result.jobId); assert.equal(status.jobs[0].stage, result.stage);
    cpSync(root, join(path, 'sandbox'), { recursive: true }); copied = true;
    const db = new DatabaseSync(join(path, 'sandbox', 'probe.sqlite'), { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 26);
      const row = db.prepare('SELECT * FROM capture_jobs WHERE job_id=?').get(result.jobId)!;
      assert.equal(row.consumer, 'historian'); assert.equal(row.payload_hash, hash(String(row.payload)));
      const job = JSON.parse(String(row.payload)); assert.equal(job.rawHash, hash(JSON.stringify(job.range)));
      const work = db.prepare('SELECT * FROM capture_work WHERE job_id=?').get(result.jobId)!;
      const sourceLines = readFileSync(join(path, 'sandbox', 'session.jsonl'), 'utf8').trimEnd().split('\n');
      const header = JSON.parse(sourceLines.shift()!);
      const raw = new Map(sourceLines.map(line => { const value = JSON.parse(line); return [value.eventId, { line, ...value }] as const; }));
      const read = (ref: { binding: unknown; eventId: string; hash: string; contentHash: string; byteLength: number }) => {
        const entry = raw.get(ref.eventId); assert.ok(entry); assert.deepEqual(ref.binding, header.binding);
        assert.equal(hash(entry.line), ref.hash); assert.equal(hash(entry.text), ref.contentHash); assert.equal(Buffer.byteLength(entry.line), ref.byteLength);
        return entry;
      };
      job.range.forEach(read);
      const attempts = db.prepare('SELECT * FROM request_attempts WHERE run_id=? ORDER BY rowid').all(String(work.run_id));
      assert.equal(attempts.length, scenario === 'protocol' ? 2 : 1);
      const outputs = events.filter(event => event.event === 'historian-request' || event.event === 'historian-foreground-request');
      for (const output of outputs) {
        const attempt = db.prepare('SELECT * FROM request_attempts WHERE attempt_id=?').get(output.attemptId)!;
        assert.ok(attempt); assert.equal(attempt.payload_hash, hash(output.request.payload));
        assert.equal(attempt.byte_length, Buffer.byteLength(output.request.payload));
        const assembly = db.prepare('SELECT * FROM request_assemblies WHERE assembly_id=?').get(String(attempt.assembly_id))!;
        const budget = JSON.parse(String(assembly.budget));
        assert.ok(Number(attempt.byte_length) + budget.outputReserve + budget.safetyMargin <= budget.contextLimit);
        JSON.parse(String(assembly.sources)).forEach(read);
      }
      for (const event of db.prepare('SELECT payload,hash FROM request_events').all()) assert.equal(hash(String(event.payload)), event.hash);
      const published = db.prepare('SELECT * FROM compartments WHERE job_id=?').get(result.jobId);
      const success = ['synthetic','protocol','real'].includes(scenario);
      assert.equal(Boolean(published), success); assert.equal(work.stage, success ? 'complete' : ['unknown','cancel'].includes(scenario) ? 'unknown' : 'blocked');
      if (published) {
        const source = JSON.parse(String(published.source_json)), attemptId = String(published.attempt_id);
        assert.equal(published.hash, hash(JSON.stringify({ source, attemptId })));
        assert.ok(attempts.some(attempt => attempt.attempt_id === attemptId && attempt.outcome === 'received'));
        const body = JSON.parse(read(source).text);
        assert.equal(body.schema, 'compartment@1'); assert.deepEqual(body.citations, job.range);
        assert.ok(body.decisions.some((decision: { text: string }) => decision.text === fixture.input));
        assert.ok(body.results.some((item: { text: string }) => JSON.parse(item.text).modelResult === fixture.result));
        assert.deepEqual(body.applicability, { ownerId: header.binding.ownerId, projectId: header.binding.projectId, sessionId: header.binding.sessionId, runId: job.runId });
        const sent = outputs.filter(event => event.event === 'historian-foreground-request').at(-1)!;
        assert.deepEqual(JSON.parse(sent.request.payload).p1.compartments, [body]);
        const windows = db.prepare("SELECT payload FROM request_events WHERE run_id=? AND kind='agent/event@v1' ORDER BY seq").all(result.agentRunId)
          .map(row => JSON.parse(String(row.payload)).event).filter(event => event.kind === 'window-opened');
        assert.equal(windows.length, 2); assert.equal(windows[0].compartments, undefined); assert.equal(windows[1].compartments[0].jobId, result.jobId);
        assert.equal(JSON.parse(sent.request.payload).p2.length, 1);
      } else {
        assert.equal(result.selected, false);
        assert.equal(attempts[0]!.outcome, ['unknown','cancel'].includes(scenario) ? 'unknown-sent' : 'received');
      }
      for (const line of readFileSync(join(path, 'sandbox', 'counting-receiver.jsonl'), 'utf8').trimEnd().split('\n').slice(1)) {
        const receipt = JSON.parse(line); assert.equal(receipt.hash, hash(JSON.stringify(receipt.record)));
        const attempt = db.prepare('SELECT payload_hash,byte_length FROM request_attempts WHERE attempt_id=?').get(receipt.record.attemptId)!;
        assert.ok(attempt); assert.equal(attempt.payload_hash, receipt.record.payloadHash); assert.equal(attempt.byte_length, receipt.record.byteLength);
      }
      observations.push({ scenario, command: [process.execPath, ...command], exitCode: child.status,
        stdoutHash: hash(child.stdout), stderrHash: hash(child.stderr), restartExitCode: reopened.status,
        verified: ['raw-range-and-body-hashes','job-and-attempt-ownership','exact-mandatory-anchors','actual-payload-budgets','selection-boundary','process-reopen','failure-no-publication'],
        stage: work.stage, backgroundAttempts: attempts.length });
    } finally { db.close(); }
  } catch (error) {
    failure = error instanceof Error ? error.name + ':' + hash(error.message) : 'verification-failure';
    writeFileSync(join(path, 'verification-error.txt'), error instanceof Error ? error.stack ?? error.message : String(error));
  } finally { if (copied && root) rmSync(root, { recursive: true, force: true }); }
  if (failure) break;
}
const files = (path: string, prefix = ''): string[] => readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
  ? files(join(path, entry.name), prefix + entry.name + '/') : [prefix + entry.name]);
const receipt = { schema: 't19-historian-evidence@1', verdict: failure ? 'failed' : 'evidence-gap', syntheticPassed: !failure,
  startedAt, finishedAt: new Date().toISOString(), implementation: { commit: execFileSync('git', ['rev-parse','HEAD'], { encoding: 'utf8' }).trim(),
    dirty: !!execFileSync('git', ['status','--porcelain'], { encoding: 'utf8' }).trim() },
  environment: { platform: process.platform, arch: arch(), release: release(), node: process.version },
  fixtureDigest: hash(readFileSync('fixtures/t19-historian-cases.json')), observations, failure,
  gaps: ['external-provider-fidelity-and-long-session-quality','crash-or-torn-archive-append-closure-issue-38','backup-and-purge-T20-T22'],
  artifacts: files(directory).map(path => ({ path, sha256: hash(readFileSync(join(directory, path))) })) };
writeFileSync(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ directory, verdict: receipt.verdict, syntheticPassed: receipt.syntheticPassed, failure }));
if (failure) process.exitCode = 1;
