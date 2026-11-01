import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createSandbox } from '../../src/sandbox.ts';

const worker = fileURLToPath(new URL('./archive-crash-worker.ts', import.meta.url));
export const archiveCrashCases = [
  ...['reservation-uncommitted', 'reservation-committed', 'before-write', 'partial-write', 'after-write', 'after-fsync', 'after-readback', 'before-ack', 'ack-committed', 'ack-returned']
    .map(point => ({ scenario: 'input', point })),
  ...['owner', 'agreement', 'response', 'tool', 'file-presentation', 'file-approval', 'guidance', 'report'].flatMap(scenario =>
    ['partial-write', 'before-ack'].map(point => ({ scenario, point }))),
  { scenario: 'projection', point: 'publication-pending' },
];
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

async function processRun(directory: string, name: string, args: string[], kill: boolean) {
  const startedAt = new Date().toISOString();
  const child = spawn(process.execPath, [worker, ...args], { stdio: 'pipe', windowsHide: true });
  const observations: any[] = [];
  let stdout = '', stderr = '', killedAtCheckpoint = false;
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const value = JSON.parse(line); observations.push(value);
    if (value.event === 'remember-ready') child.stdin.end(args[1] === 'owner-recover' ? 'stop\n'
      : args[2] === 'agreement' ? '同意\n' : '记住事实：Atlas 需要保留原始输入。\n');
    if (kill && value.event === 'checkpoint') { killedAtCheckpoint = child.kill('SIGKILL'); }
  });
  const guard = setTimeout(() => child.kill('SIGKILL'), 15000);
  let exit: { code: number | null; signal: NodeJS.Signals | null };
  try {
    exit = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
    });
  } finally { clearTimeout(guard); lines.close(); }
  writeFileSync(join(directory, `${name}.stdout.jsonl`), stdout);
  writeFileSync(join(directory, `${name}.stderr.txt`), stderr);
  const result = { command: [process.execPath, worker, ...args], startedAt, finishedAt: new Date().toISOString(),
    ...exit, killedAtCheckpoint, stdout: `${name}.stdout.jsonl`, stderr: `${name}.stderr.txt` };
  writeFileSync(join(directory, `${name}.process.json`), JSON.stringify(result, null, 2));
  if (kill) { assert.equal(killedAtCheckpoint, true, stderr); assert.notEqual(exit.code, 0); }
  else { assert.equal(exit.code, 0, stderr); assert.equal(exit.signal, null); }
  return { process: result, observations };
}
function inspect(root: string) {
  const db = new DatabaseSync(join(root, 'probe.sqlite'), { readOnly: true });
  try {
    assert.deepEqual(db.prepare('PRAGMA quick_check').all().map(row => row.quick_check), ['ok']);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    return {
      pending: db.prepare("SELECT * FROM source_appends WHERE status='pending'").all(),
      acknowledged: db.prepare("SELECT * FROM source_appends WHERE status='durable'").all(),
      captures: Number(db.prepare('SELECT count(*) AS n FROM capture_jobs').get()!.n),
      memories: Number(db.prepare('SELECT count(*) AS n FROM memory_records').get()!.n),
      offloads: Number(db.prepare("SELECT count(*) AS n FROM request_assemblies WHERE degradation IN ('compact','window')").get()!.n),
      requests: db.prepare('SELECT kind,payload FROM request_events ORDER BY rowid').all(),
      jobs: db.prepare('SELECT * FROM source_projection_jobs').all(),
      documents: db.prepare("SELECT * FROM search_documents WHERE owner_kind='session'").all(),
    };
  } finally { db.close(); }
}
export async function runArchiveCrashCase(directory: string, scenario: string, point: string) {
  mkdirSync(directory, { recursive: true });
  const sandbox = createSandbox();
  try {
    const crash = await processRun(directory, 'crash', [sandbox.root, 'append', scenario, point], true);
    cpSync(sandbox.root, join(directory, 'interrupted'), { recursive: true });
    const before = inspect(sandbox.root), beforeBytes = readFileSync(join(sandbox.root, 'session.jsonl'));
    const ready = crash.observations.find(item => item.event === 'ready');
    assert.equal(before.captures, 0); assert.equal(before.memories, 0); assert.equal(before.offloads, 0);
    assert.equal(before.requests.filter(row => row.kind === 'agent/event@v1' && JSON.parse(String(row.payload)).event.kind === 'window-opened'
      && JSON.parse(String(row.payload)).event.firstResponse > 0).length, 0);
    assert.equal(readFileSync(join(sandbox.root, 'counting-receiver.jsonl'), 'utf8').trim().split('\n').length, 1);
    if (scenario === 'projection') {
      assert.equal(before.pending.length, 0); assert.equal(before.jobs.length, 1); assert.equal(before.jobs[0]!.status, 'pending');
      assert.equal(before.documents.length, 0);
    } else {
      assert.equal(before.pending.length, ['reservation-uncommitted', 'ack-committed', 'ack-returned'].includes(point) ? 0 : 1);
      if (before.pending.length) {
        const row = before.pending[0]!, pending = JSON.parse(String(row.payload));
        assert.equal(row.payload_hash, hash(String(row.payload)));
        assert.equal(pending.eventId, row.source_event_id);
        assert.equal(pending.prefixHash, hash(beforeBytes.subarray(0, pending.offset)));
        const tail = beforeBytes.subarray(pending.offset), expected = Buffer.from(pending.bytes);
        assert.ok(tail.equals(expected.subarray(0, tail.length)));
        if (point === 'before-write' || point === 'reservation-committed') assert.equal(tail.length, 0);
        else if (point === 'partial-write') assert.ok(tail.length > 0 && tail.length < expected.length);
        else assert.equal(tail.length, expected.length);
      }
      if (scenario === 'response') assert.equal(before.requests.filter(row => row.kind === 'agent/event@v1'
        && JSON.parse(String(row.payload)).event.kind === 'response').length, 0);
      if (scenario === 'tool') assert.equal(before.requests.filter(row => row.kind === 'agent/event@v1'
        && JSON.parse(String(row.payload)).event.kind === 'tool-result').length, 0);
    }
    if (scenario === 'file-presentation' || scenario === 'file-approval') {
      const forbidden = scenario === 'file-presentation' ? 'file-prepared' : 'file-approved';
      assert.equal(before.requests.filter(row => row.kind === 'agent/event@v1' && JSON.parse(String(row.payload)).event.kind === forbidden).length, 0);
    }
    const recovery = await processRun(directory, 'recovery', [sandbox.root, scenario === 'projection' ? 'projection-recover' : 'recover'], false);
    if (point === 'reservation-uncommitted') await processRun(directory, 'explicit-retry', [sandbox.root, 'retry', scenario, ready.eventId], false);
    cpSync(sandbox.root, join(directory, 'recovered'), { recursive: true });
    const after = inspect(sandbox.root), afterBytes = readFileSync(join(sandbox.root, 'session.jsonl'));
    assert.equal(after.pending.length, 0);
    assert.ok(afterBytes.subarray(0, beforeBytes.length).equals(beforeBytes), 'reconciliation must not overwrite any surviving byte');
    assert.equal(afterBytes.at(-1), 10);
    const lines = afterBytes.toString('utf8').trim().split('\n'), header = JSON.parse(lines.shift()!);
    const events = lines.map(line => ({ line, value: JSON.parse(line) }));
    assert.equal(new Set(events.map(item => item.value.eventId)).size, events.length);
    for (const row of after.acknowledged) {
      assert.equal(row.payload_hash, hash(String(row.payload)));
      const ack = JSON.parse(String(row.payload)), event = events.find(item => item.value.eventId === ack.eventId)!;
      assert.ok(event); assert.equal(ack.hash, hash(event.line)); assert.equal(ack.contentHash, hash(event.value.text));
      assert.equal(ack.byteLength, Buffer.byteLength(event.line)); assert.deepEqual(ack.binding, header.binding);
    }
    if (point === 'ack-committed') {
      assert.equal(before.acknowledged.length, 1);
      assert.deepEqual(after.acknowledged, before.acknowledged);
    }
    const recovered = recovery.observations.find(item => item.event === 'recovered');
    if (scenario !== 'projection') {
      assert.equal(recovered.sends, 0); assert.equal(recovered.blindAppends, 0);
      assert.equal(recovered.events.length, point === 'reservation-uncommitted' ? 0 : events.length);
      for (const ack of recovered.events) {
        const event = events.find(item => item.value.eventId === ack.eventId)!;
        assert.ok(event); assert.equal(ack.hash, hash(event.line)); assert.equal(ack.contentHash, hash(event.value.text));
        assert.equal(ack.byteLength, Buffer.byteLength(event.line)); assert.deepEqual(ack.binding, header.binding);
        assert.equal(ack.locator, `cli-jsonl@1/${header.binding.sessionId}/${ack.eventId}`);
      }
      if (before.pending.length) {
        const pending = JSON.parse(String(before.pending[0]!.payload));
        assert.equal(events.filter(item => item.value.eventId === pending.eventId).length, 1);
        assert.equal(events.find(item => item.value.eventId === pending.eventId)!.line + '\n', pending.bytes);
        assert.deepEqual(recovered.acks, [recovered.events.find((ack: { eventId: string }) => ack.eventId === pending.eventId)]);
        assert.equal(recovered.writtenBytes, Buffer.byteLength(pending.bytes) - (beforeBytes.length - pending.offset));
      }
      if (scenario === 'input') assert.equal(events.length, 1);
      assert.equal(after.captures, 0); assert.equal(after.memories, 0);
    } else {
      assert.equal(after.jobs.length, 1); assert.equal(after.jobs[0]!.job_id, before.jobs[0]!.job_id);
      assert.equal(after.jobs[0]!.status, 'done'); assert.equal(after.documents.length, 1);
      const second = await processRun(directory, 'second-drain', [sandbox.root, 'projection-recover'], false);
      assert.deepEqual(inspect(sandbox.root).jobs, after.jobs);
      assert.equal(second.observations.find(item => item.event === 'projection-recovered').result.results.length, 1);
    }
    if (scenario === 'owner' || scenario === 'agreement') {
      await processRun(directory, 'owner-backfill', [sandbox.root, 'owner-recover'], false);
      const restored = inspect(sandbox.root);
      assert.equal(restored.memories, 1);
      await processRun(directory, 'owner-backfill-again', [sandbox.root, 'owner-recover'], false);
      assert.equal(inspect(sandbox.root).memories, 1);
      cpSync(sandbox.root, join(directory, 'owner-backfilled'), { recursive: true });
    }
    const observation = { scenario, point, status: 'pass', processes: [crash.process, recovery.process],
      interruptedHash: hash(beforeBytes), recoveredHash: hash(afterBytes), eventCount: events.length,
      pendingCountBefore: before.pending.length, pendingCountAfter: after.pending.length,
      capturesBefore: before.captures, capturesAfter: after.captures, offloadsBefore: before.offloads, sends: 0,
      blindAppends: recovered?.blindAppends ?? 0, recoveryBytesWritten: recovered?.writtenBytes ?? 0,
      assertions: ['original bytes preserved', 'one event per identity', 'ack hashes recomputed from raw bytes',
        'zero dependent capture/activation/dispatch before ack', 'pending identity settled in another process',
        ...(scenario === 'projection' ? ['same projection job settled once across two process restarts'] : [])] };
    writeFileSync(join(directory, 'case.json'), JSON.stringify(observation, null, 2) + '\n');
    return observation;
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
    if (scenario.startsWith('file-')) rmSync(`${sandbox.root}-project`, { recursive: true, force: true });
  }
}
export function artifactFiles(root: string, prefix = ''): { path: string; hash: string }[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(entry => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? artifactFiles(root, path) : [{ path, hash: hash(readFileSync(join(root, path))) }];
  });
}
