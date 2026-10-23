import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { startCli, sendCommand as send } from '../apps/cli/src/process-driver.ts';
import { bindingOf, createSandboxSession } from '../apps/cli/src/sandbox.ts';
import { openProbe } from '../apps/cli/src/probe.ts';
import { rollbackFixture } from '../apps/cli/test/support/memory-rollback.ts';
import { API_VERSION } from '@euler/core';
import fixture from '../fixtures/t17-batch-rollback.json' with { type: 'json' };

const repo = fileURLToPath(new URL('../', import.meta.url)), startedAt = new Date().toISOString();
const destination = join(repo, 'artifacts', `t17-${startedAt.replace(/[:.]/g, '-')}`);
mkdirSync(destination, { recursive: true });
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const save = (path: string, bytes: string | Buffer) => {
  const target = join(destination, path); mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, bytes); return path;
};
const checks: { id: string; passed: boolean; diagnostic?: string }[] = [];
const commands: { command: string[]; stdout: string; stderr: string; code: number | null; signal: string | null }[] = [];
type Client = ReturnType<typeof startCli> & { captured: Promise<number> };
const clients: Client[] = [];
function launch(root: string, label: string, crash = false): Client {
  const args = ['remember', '--sandbox', root, ...(crash ? ['--scenario', 'correction-after-commit'] : [])];
  const cli = startCli(args), stdout: Buffer[] = [], stderr: Buffer[] = [];
  cli.child.stdout.on('data', (bytes: Buffer) => stdout.push(Buffer.from(bytes)));
  cli.child.stderr.on('data', (bytes: Buffer) => stderr.push(Buffer.from(bytes)));
  const captured = cli.exit.then(exit => commands.push({ command: [process.execPath, 'apps/cli/src/main.ts', ...args],
    stdout: save(`${label}/stdout.txt`, Buffer.concat(stdout)), stderr: save(`${label}/stderr.txt`, Buffer.concat(stderr)), ...exit }));
  const client = { ...cli, captured }; clients.push(client); return client;
}
async function stop(cli: ReturnType<typeof launch>) {
  cli.command('stop'); assert.equal((await cli.exit).code, 0, cli.stderr()); await cli.captured;
}
const snapshot = (value: { hash?: string; [key: string]: unknown }) => {
  const { hash: _hash, ...body } = value; return JSON.stringify(body);
};

// Independent checks of closed SQLite and actual JSONL/stdout bytes; no Store replay or read helpers.
function validate(root: string, token: string, expected: 'committed' | 'cancelled' | 'stale', selected: string[], memberCount: number, stdoutPaths: string[]) {
  const lines = readFileSync(join(root, 'session.jsonl'), 'utf8').trimEnd().split('\n');
  const header = JSON.parse(lines.shift()!);
  const archive = lines.map(line => {
    const event = JSON.parse(line); assert.equal(JSON.stringify(event), line);
    return { event, ack: { schema: 'cli-source-ack@1', status: 'durable', binding: header.binding,
      eventId: event.eventId, locator: `cli-jsonl@1/${header.binding.sessionId}/${event.eventId}`,
      hash: digest(line), byteLength: Buffer.byteLength(line), contentHash: digest(event.text) } };
  });
  const source = (ref: string) => { const found = archive.find(row => JSON.stringify(row.ack) === ref); assert.ok(found); return found.event; };
  const observations = stdoutPaths.flatMap(path => readFileSync(join(destination, path), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
  const db = new DatabaseSync(join(root, 'probe.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 21);
    assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('SELECT sqlite_version() AS version').get()!.version, process.versions.sqlite);
    const stored = db.prepare('SELECT * FROM host_presentations WHERE token=?').get(token)!;
    assert.equal(digest(String(stored.payload)), stored.payload_hash);
    const presentation = JSON.parse(String(stored.payload)); assert.deepEqual(presentation.eventIds, selected);
    const batch = db.prepare('SELECT * FROM activation_batches WHERE batch_id=?').get(presentation.batchId)!;
    assert.equal(batch.payload, presentation.batchPayload); assert.equal(digest(String(batch.payload)), batch.payload_hash);
    assert.equal(batch.payload_hash, presentation.batchDigest); assert.equal(batch.member_count, memberCount);
    const manifest = JSON.parse(String(batch.payload));
    const events = db.prepare('SELECT * FROM memory_events WHERE batch_id=? ORDER BY batch_ordinal').all(presentation.batchId);
    assert.equal(JSON.stringify(manifest.events), '[' + events.map(row => row.payload).join(',') + ']');
    assert.deepEqual(manifest.events.slice(0, fixture.contents.length).map((event: { after: { content: string } }) => event.after.content), fixture.contents);
    const pending = db.prepare('SELECT * FROM pending_operations WHERE operation_id=?').get(presentation.operationId)!;
    assert.equal(pending.state, expected); assert.equal(digest(String(pending.result)), pending.result_hash);
    const result = JSON.parse(String(pending.result)); assert.deepEqual(result.expected, presentation.targets);
    const changed = db.prepare('SELECT * FROM memory_events WHERE operation_id=? ORDER BY origin_seq').all(presentation.operationId);
    assert.equal(changed.length, expected === 'committed' ? selected.length : 0);
    assert.deepEqual(result.receiptIds, changed.map(row => row.receipt_id));
    const delivery = db.prepare('SELECT * FROM host_operation_delivery WHERE operation_id=?').get(presentation.operationId)!;
    assert.equal(delivery.owner_ack, 1);
    if (expected === 'cancelled') assert.equal(delivery.approval_source, null);
    else {
      assert.equal(digest(String(delivery.approval_source)), delivery.approval_hash);
      const approval = source(String(delivery.approval_source));
      assert.equal(approval.role, 'user'); assert.equal(approval.text, `commit ${token} rollback`);
      assert.equal(archive.filter(row => row.event.text === approval.text).length, 2); // accepted input and settled replay
    }
    assert.equal(digest(String(delivery.model_source)), delivery.model_hash);
    const model = source(String(delivery.model_source)); assert.equal(model.role, 'tool');
    assert.equal(model.eventId, delivery.summary_event_id);
    assert.equal(archive.filter(row => row.event.eventId === delivery.summary_event_id).length, 1);
    assert.ok(Buffer.byteLength(model.text) <= fixture.summaryMaxBytes);
    const summary = JSON.parse(model.text); assert.equal(summary.status, expected); assert.equal(summary.kind, 'rollback');
    assert.equal(summary.recordCount, selected.length);
    assert.deepEqual(Object.keys(summary).sort(), ['schema', 'operationId', 'kind', 'status', 'records', 'reason', 'recordCount'].sort());
    assert.deepEqual(summary.records, presentation.targets.map((target: { recordId: string }) => {
      const current = result.current.find((record: { recordId: string }) => record.recordId === target.recordId);
      return { recordId: target.recordId, revisionId: current?.revisionId ?? null, revision: current?.revision ?? null,
        lifecycle: current?.lifecycle ?? null, verification: current?.verification ?? null };
    }));
    const assemblies = db.prepare('SELECT * FROM request_assemblies').all(); assert.ok(assemblies.length > 0);
    for (const assembly of assemblies) {
      assert.equal(assembly.route, 'local-counting'); assert.equal(assembly.model, 'none');
      const request = observations.find(row => row.event === 'ask-result' && row.receipt?.assemblyId === assembly.assembly_id);
      assert.ok(request && typeof request.payload === 'string');
      assert.equal(digest(request.payload), assembly.payload_hash);
      assert.equal(Buffer.byteLength(request.payload), assembly.byte_length);
      const payload = JSON.parse(request.payload); assert.deepEqual(payload.operationSummaries, [summary]);
      assert.deepEqual(db.prepare('SELECT DISTINCT adapter_version FROM request_attempts WHERE assembly_id=?').all(String(assembly.assembly_id))
        .map(row => row.adapter_version), [API_VERSION]);
    }
    for (const content of fixture.contents) assert.equal(model.text.includes(content), false);
    for (const [index, row] of changed.entries()) {
      assert.equal(row.kind, 'rollback'); assert.equal(row.target_event_id, selected[index]);
      assert.equal(row.event_id, presentation.updateEventIds[index]); assert.equal(row.record_id, presentation.targets[index].recordId);
      assert.equal(digest(String(row.receipt_payload)), row.receipt_hash);
      const receipt = JSON.parse(String(row.receipt_payload)); assert.equal(receipt.operationId, presentation.operationId);
      const original = manifest.events.find((event: { eventId: string }) => event.eventId === selected[index]);
      const after = JSON.parse(String(row.after_snapshot));
      assert.deepEqual({ ...after, headEventId: original.before.headEventId }, original.before);
      assert.equal(row.before_snapshot, snapshot(result.expected[index])); assert.equal(row.after_snapshot, snapshot(result.current[index]));
    }
    for (const event of manifest.events) {
      const revisions = db.prepare('SELECT * FROM memory_revisions WHERE record_id=?').all(event.recordId); assert.equal(revisions.length, 1);
      assert.equal(revisions[0]!.content_hash, digest(String(revisions[0]!.content))); source(String(revisions[0]!.source_json));
      const history = db.prepare('SELECT * FROM memory_events WHERE record_id=? ORDER BY seq').all(event.recordId);
      let previous: string | null = null;
      for (const row of history) {
        assert.equal(digest(String(row.payload)), row.payload_hash);
        const payload = JSON.parse(String(row.payload)); assert.equal(payload.eventId, row.event_id);
        assert.equal(row.before_snapshot, previous); assert.equal(JSON.stringify(payload.after), row.after_snapshot);
        assert.equal(payload.after.headEventId, row.event_id); previous = String(row.after_snapshot);
        assert.equal(payload.ownerReceipt === null ? null : JSON.stringify(payload.ownerReceipt), row.receipt_payload);
        if (row.kind === 'rollback') {
          const jobs = db.prepare("SELECT * FROM projection_jobs WHERE event_id=? AND kind='search'").all(String(row.event_id));
          assert.equal(jobs.length, 1); assert.equal(digest(String(jobs[0]!.payload)), jobs[0]!.payload_hash);
        }
      }
      const head = db.prepare('SELECT * FROM memory_heads WHERE record_id=?').get(event.recordId)!;
      assert.equal(head.snapshot, previous); assert.equal(head.snapshot_hash, digest(String(head.snapshot)));
    }
    const info = db.prepare('SELECT * FROM host_info_batches WHERE batch_id=?').get(presentation.batchId)!;
    assert.equal(info.digest, batch.payload_hash); assert.equal(info.read_state, 'read'); assert.equal(info.delivery, 'delivered');
    const ownerLine = readFileSync(join(root, 'owner-info.jsonl'), 'utf8').trimEnd().split('\n').slice(1)
      .find(line => JSON.parse(line).entryId === info.entry_id)!;
    assert.equal(digest(ownerLine), info.entry_hash); assert.equal(JSON.parse(ownerLine).payload, batch.payload);
    const owner = observations.filter(row => row.event === 'memory-owner-entry' && row.operationId === presentation.operationId);
    assert.ok(owner.length >= 1);
    for (const entry of owner) {
      assert.deepEqual(entry.eventIds, selected); assert.deepEqual(entry.result, result);
      assert.equal(entry.requiresReselection, expected === 'stale');
      if (expected === 'committed') {
        const { hash, ...receipt } = entry.receipt; assert.equal(digest(JSON.stringify(receipt)), hash);
        assert.equal(receipt.batchDigest, batch.payload_hash); assert.equal(receipt.operationId, presentation.operationId);
        assert.deepEqual(receipt.members.map((member: { eventId: string }) => member.eventId), selected);
        assert.deepEqual(receipt.members.map((member: { receipt: unknown }) => member.receipt), changed.map(row => JSON.parse(String(row.receipt_payload))));
        assert.deepEqual(receipt.members.map((member: { after: unknown }) => member.after), result.current);
      } else assert.equal(entry.receipt, null);
    }
  } finally { db.close(); }
}

for (const id of fixture.cases) {
  const memberCount = id === 'maximum' ? fixture.maxMemberCount : fixture.memberCount;
  const { sandbox, probe, batch } = rollbackFixture(memberCount); probe.close();
  const start = commands.length;
  try {
    let cli = launch(sandbox.root, `${id}/initial`, id === 'after-commit'); await cli.waitFor('remember-ready');
    await send(cli, `info ${batch.batchId}`, 'info-read');
    const selected = (id === 'subset' ? [batch.events[0]!, batch.events[2]!] : batch.events).map(event => event.eventId);
    const preview = await send(cli, `rollback ${batch.batchId} ${selected.join(' ')}`, 'memory-preview');
    assert.deepEqual(preview.eventIds, selected); assert.equal(preview.batchPayload, batch.payload);
    if (id === 'concurrent-change') {
      const binding = { ...bindingOf(sandbox), sessionId: randomUUID() }; createSandboxSession(sandbox, binding);
      const other = openProbe(sandbox, undefined, undefined, binding, undefined, true);
      try { const last = batch.events.at(-1)!; other.store.forgetMemory(other.activity, last.recordId, last.after); }
      finally { other.close(); }
    }
    const expected = id === 'cancel' ? 'cancelled' : id === 'concurrent-change' ? 'stale' : 'committed';
    if (id === 'after-commit') {
      cli.command(String(preview.command)); await cli.waitFor('correction-checkpoint'); cli.child.kill('SIGKILL'); await cli.exit; await cli.captured;
      cli = launch(sandbox.root, `${id}/recovery`); await cli.waitFor('remember-ready');
    } else assert.equal((await send(cli, id === 'cancel' ? String(preview.cancel) : String(preview.command), 'memory-result')).status, expected);
    assert.equal((await send(cli, String(preview.command), 'memory-result')).status, 'settled');
    await stop(cli);
    cli = launch(sandbox.root, `${id}/restart`); await cli.waitFor('remember-ready');
    assert.equal((await send(cli, `replay ${preview.token}`, 'memory-result')).status, expected);
    const answer = await send(cli, 'ask 合成批次偏好', 'ask-result');
    const active = batch.events.filter(event => expected === 'committed' ? !selected.includes(event.eventId)
      : id !== 'concurrent-change' || event !== batch.events.at(-1)).map(event => event.recordId).sort();
    assert.deepEqual((answer.selected as string[]).sort(), active);
    await stop(cli);
    validate(sandbox.root, String(preview.token), expected, selected, memberCount, commands.slice(start).map(command => command.stdout));
    checks.push({ id, passed: true });
  } catch (error) {
    checks.push({ id, passed: false, diagnostic: save(`${id}/error.txt`, (error as Error).stack ?? String(error)) });
  } finally {
    for (const cli of clients) if (!cli.observations.some(row => row.event === 'process-exit')) { cli.child.kill('SIGKILL'); await cli.exit; }
    await Promise.all(clients.map(cli => cli.captured));
    cpSync(sandbox.root, join(destination, id, 'raw-sandbox'), { recursive: true });
    rmSync(sandbox.root, { recursive: true, force: true });
  }
}
const artifacts: { path: string; bytes: number; sha256: string }[] = [];
function inventory(path: string) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const target = join(path, entry.name);
    if (entry.isDirectory()) inventory(target);
    else { const bytes = readFileSync(target); artifacts.push({ path: relative(destination, target).replaceAll('\\', '/'), bytes: bytes.length, sha256: digest(bytes) }); }
  }
}
inventory(destination);
const passed = checks.length === fixture.cases.length && checks.every(check => check.passed);
const receipt = { schema: 'batch-rollback-evidence@1', startedAt, endedAt: new Date().toISOString(),
  result: passed ? 'evidence-gap' : 'failed', syntheticPassed: passed,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  dirty: execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim().length > 0,
  implementationTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repo, encoding: 'utf8' }).trim(),
  specReferences: ['15:I15-I17', '11:rollback', '14:Two presentation planes/Required terminal states', '12:X-09/X-10/X-11'],
  environment: { platform: platform(), release: release(), arch: arch(), node: process.version, sqlite: process.versions.sqlite },
  execution: { transport: 'local-counting', providerVersion: 'not-applicable', model: 'none', modelVersion: 'not-applicable', adapterVersion: API_VERSION },
  heldOut: { applicability: 'not-used-by-this-synthetic-fixture' },
  controlledEffects: ['disposable-sqlite', 'synthetic-session-jsonl', 'synthetic-owner-info-jsonl', 'local-counting-receiver', 'cli-stdout-stderr'],
  fixtureDigest: digest(readFileSync(join(repo, 'fixtures/t17-batch-rollback.json'))), commands, checks, artifacts,
  gaps: ['actual-provider-semantic-quality', 'long-session-operation-summary-compaction', 'purge-closure-deletion-not-enabled',
    'source-append-crash-and-unknown-outcomes', 'other-platforms-require-their-own-receipts', 'non-cli-host-integration', 'production-data-and-migration'] };
save('receipt.json', JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ evidence: destination, result: receipt.result, syntheticPassed: passed, checks: checks.length }));
if (!passed) process.exitCode = 1;
