import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createSandbox } from '../apps/cli/src/sandbox.ts';
import { startCli, sendCommand as send } from '../apps/cli/src/process-driver.ts';
import { bufferedCorrectionApproval, delayedCorrectionOutput } from '../apps/cli/test/support/memory-correction.ts';
import fixture from '../fixtures/t15-owner-correction.json' with { type: 'json' };

const repo = fileURLToPath(new URL('../', import.meta.url));
const startedAt = new Date().toISOString();
const destination = join(repo, 'artifacts', `t15-${startedAt.replace(/[:.]/g, '-')}`);
mkdirSync(destination, { recursive: true });
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const save = (path: string, bytes: string | Buffer) => { const target = join(destination, path); mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, bytes); return path; };
const checks: { id: string; passed: boolean; diagnostic?: string }[] = [];
const commands: { command: string[]; stdout: string; stderr: string; code: number | null; signal: string | null }[] = [];
type Cli = ReturnType<typeof startCli>;
const clients: Cli[] = [];
function launch(root: string, label: string, scenario?: string, env?: NodeJS.ProcessEnv) {
  const args = ['remember', '--sandbox', root, ...(scenario ? ['--scenario', scenario] : [])];
  const cli = startCli(args, undefined, undefined, env); clients.push(cli);
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  cli.child.stdout.on('data', (data: Buffer) => stdout.push(Buffer.from(data)));
  cli.child.stderr.on('data', (data: Buffer) => stderr.push(Buffer.from(data)));
  const captured = cli.exit.then(exit => { commands.push({ command: [process.execPath, 'apps/cli/src/main.ts', ...args],
    stdout: save(`${label}/stdout.txt`, Buffer.concat(stdout)), stderr: save(`${label}/stderr.txt`, Buffer.concat(stderr)), ...exit }); });
  return { ...cli, captured };
}
async function stop(cli: ReturnType<typeof launch>) { cli.command('stop'); assert.equal((await cli.exit).code, 0, cli.stderr()); await cli.captured; }
function verify(id: string, action: () => void) {
  try { action(); checks.push({ id, passed: true }); }
  catch (error) { checks.push({ id, passed: false, diagnostic: save(`${id}/error.txt`, (error as Error).stack ?? String(error)) }); }
}

// Read SQLite and original archive bytes independently of Store projection/read APIs.
function validate(root: string, id: string, operationId: string, token: string, receiptIds: unknown, earlySource?: string) {
  const lines = readFileSync(join(root, 'session.jsonl'), 'utf8').trimEnd().split('\n');
  const header = JSON.parse(lines.shift()!);
  const sources = lines.map(line => {
    const event = JSON.parse(line); assert.equal(JSON.stringify(event), line);
    return { event, ack: { schema: 'cli-source-ack@1', status: 'durable', binding: header.binding,
      eventId: event.eventId, locator: `cli-jsonl@1/${header.binding.sessionId}/${event.eventId}`,
      hash: digest(line), byteLength: Buffer.byteLength(line), contentHash: digest(event.text) } };
  });
  const source = (json: string) => { const match = sources.find(row => JSON.stringify(row.ack) === json); assert.ok(match); return match.event; };
  const db = new DatabaseSync(join(root, 'probe.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 18);
    const events = db.prepare('SELECT * FROM memory_events WHERE record_id=? ORDER BY seq').all(id);
    let previous: string | null = null;
    for (const row of events) {
      assert.equal(digest(String(row.payload)), row.payload_hash);
      const event = JSON.parse(String(row.payload));
      assert.equal(JSON.stringify(event.after), row.after_snapshot);
      assert.equal(row.before_snapshot, previous); previous = String(row.after_snapshot);
      assert.equal(event.after.headEventId, row.event_id);
    }
    const head = db.prepare('SELECT * FROM memory_heads WHERE record_id=?').get(id)!;
    assert.equal(head.snapshot, previous); assert.equal(head.snapshot_hash, digest(String(head.snapshot)));
    const after = JSON.parse(String(head.snapshot));
    assert.deepEqual([after.content, after.revision, after.lifecycle, after.verification], [fixture.corrected, 2, 'active', 'unverified']);
    const revisions = db.prepare('SELECT * FROM memory_revisions WHERE record_id=? ORDER BY revision').all(id);
    assert.deepEqual(revisions.map(row => row.content), [fixture.original, fixture.corrected]);
    for (const revision of revisions) { assert.equal(digest(String(revision.content)), revision.content_hash); source(String(revision.source_json)); }
    const corrections = events.filter(row => row.kind === 'correct'); assert.equal(corrections.length, 1);
    const correction = JSON.parse(String(corrections[0]!.payload));
    assert.equal(correction.ownerReceipt.operationId, operationId);
    const receipt = corrections[0]!;
    assert.equal(receipt.receipt_hash, digest(String(receipt.receipt_payload)));
    assert.deepEqual(JSON.parse(String(receipt.receipt_payload)), correction.ownerReceipt);
    assert.deepEqual(receiptIds, [receipt.receipt_id]);
    const operation = db.prepare('SELECT * FROM pending_operations WHERE operation_id=?').get(operationId)!;
    assert.equal(operation.state, 'committed'); assert.equal(operation.result_hash, digest(String(operation.result)));
    const delivery = db.prepare('SELECT * FROM host_operation_delivery WHERE operation_id=?').get(operationId)!;
    assert.equal(delivery.owner_ack, 1);
    assert.equal(delivery.approval_hash, digest(String(delivery.approval_source)));
    assert.equal(delivery.model_hash, digest(String(delivery.model_source)));
    const approval = source(String(delivery.approval_source)); assert.equal(approval.role, 'user');
    assert.equal(approval.text, `commit ${token} ${JSON.stringify(fixture.corrected)}`);
    if (earlySource) {
      const early = source(earlySource);
      assert.equal(early.role, 'user'); assert.equal(early.text, approval.text);
      assert.notEqual(early.eventId, approval.eventId);
      assert.ok(sources.findIndex(row => row.event.eventId === early.eventId) < sources.findIndex(row => row.event.eventId === approval.eventId));
    }
    const model = source(String(delivery.model_source)); assert.equal(model.role, 'tool');
    assert.ok(Buffer.byteLength(model.text) <= fixture.summaryMaxBytes);
    const summary = JSON.parse(model.text);
    assert.deepEqual(Object.keys(summary).sort(), ['schema', 'operationId', 'kind', 'status', 'records', 'reason'].sort());
    assert.equal(summary.schema, 'memory-operation-summary@1'); assert.equal(summary.status, 'committed');
    assert.deepEqual(summary.records, [{ recordId: id, revisionId: after.revisionId, revision: 2, lifecycle: 'active', verification: 'unverified' }]);
    const jobs = db.prepare('SELECT payload,payload_hash FROM capture_jobs').all().map(row => {
      assert.equal(digest(String(row.payload)), row.payload_hash); return JSON.parse(String(row.payload));
    });
    const reverify = jobs.filter(job => job.lane === 'reverification'); assert.equal(reverify.length, 1);
    assert.equal(reverify[0].recordId, id); assert.equal(reverify[0].expectedHead, after.headEventId);
  } finally { db.close(); }
}

for (const crash of [false, true]) {
  const label = crash ? 'crash' : 'normal';
  const sandbox = createSandbox();
  try {
    let cli = launch(sandbox.root, `${label}/initial`);
    await cli.waitFor('remember-ready');
    const remembered = await send(cli, `记住偏好：${fixture.original}`, 'remember-result');
    const id = String(remembered.recordId);
    const before = await send(cli, `ask ${fixture.original}`, 'ask-result');
    assert.ok((before.selected as string[]).includes(id));
    if (crash) { await stop(cli); cli = launch(sandbox.root, 'crash/commit', 'correction-after-commit'); await cli.waitFor('remember-ready'); }
    else {
      const noop = await send(cli, `correct ${id} ${JSON.stringify(fixture.original)}`, 'memory-result');
      verify('no-op', () => { assert.equal(noop.status, 'no_op'); assert.deepEqual(noop.receiptIds, []); });
      const draft = await send(cli, `correct ${id} ${JSON.stringify(fixture.supersededDraft)}`, 'memory-preview');
      const replacement = await send(cli, `correct ${id} ${JSON.stringify(fixture.cancelledDraft)}`, 'memory-preview');
      verify('supersession', () => assert.equal(replacement.supersedesOperationId, draft.operationId));
      const cancelled = await send(cli, `cancel ${replacement.token}`, 'memory-result');
      verify('cancel', () => { assert.equal(cancelled.status, 'cancelled'); assert.deepEqual(cancelled.receiptIds, []); });
    }
    const preview = await send(cli, `correct ${id} ${JSON.stringify(fixture.corrected)}`, 'memory-preview');
    assert.deepEqual(preview.diff, { before: fixture.original, after: fixture.corrected });
    let receiptIds: unknown;
    if (crash) {
      cli.command(`commit ${preview.token} ${JSON.stringify(fixture.corrected)}`);
      await cli.waitFor('correction-checkpoint'); cli.child.kill('SIGKILL'); await cli.exit; await cli.captured;
    } else {
      const committed = await send(cli, `commit ${preview.token} ${JSON.stringify(fixture.corrected)}`, 'memory-result');
      receiptIds = committed.receiptIds;
      verify('commit', () => { assert.equal(committed.status, 'committed'); assert.equal(committed.verification, 'queued'); });
      const duplicate = await send(cli, `commit ${preview.token} ${JSON.stringify(fixture.corrected)}`, 'memory-result');
      verify('duplicate', () => { assert.equal(duplicate.status, 'settled'); assert.deepEqual(duplicate.receiptIds, receiptIds); });
      const used = await send(cli, `used ${(before.receipt as { assemblyId: string }).assemblyId} ${id}`, 'memory-used');
      verify('used-snapshot', () => assert.equal((used.memories as { snapshot: { content: string } }[])[0]!.snapshot.content, fixture.original));
      await stop(cli);
    }
    cli = launch(sandbox.root, `${label}/replay`); await cli.waitFor('remember-ready');
    const replay = await send(cli, `replay ${preview.token}`, 'memory-result');
    const next = await send(cli, `ask ${fixture.corrected}`, 'ask-result');
    await stop(cli);
    verify(crash ? 'crash-after-commit' : 'restart-replay', () => {
      assert.equal(replay.status, 'committed'); if (receiptIds) assert.deepEqual(replay.receiptIds, receiptIds);
      assert.deepEqual(next.selected, []);
      const summaries = JSON.parse(String(next.payload)).operationSummaries;
      assert.equal(summaries.at(-1).status, 'committed');
      assert.equal(JSON.stringify(summaries).includes(fixture.corrected), false);
      validate(sandbox.root, id, String(preview.operationId), String(preview.token), replay.receiptIds);
    });
  } catch (error) { checks.push({ id: `${label}-execution`, passed: false, diagnostic: save(`${label}/error.txt`, (error as Error).stack ?? String(error)) }); }
  finally {
    for (const cli of clients) if (!cli.observations.some(row => row.event === 'process-exit')) { cli.child.kill('SIGKILL'); await cli.exit; }
    cpSync(sandbox.root, join(destination, label, 'raw-sandbox'), { recursive: true });
    rmSync(sandbox.root, { recursive: true, force: true });
  }
}
{
  const sandbox = createSandbox(), output = delayedCorrectionOutput(sandbox);
  try {
    save('buffered/output-delay.mjs', readFileSync(output.preload));
    const cli = launch(sandbox.root, 'buffered/session', undefined, output.env);
    await cli.waitFor('remember-ready');
    const remembered = await send(cli, `记住偏好：${fixture.original}`, 'remember-result');
    const id = String(remembered.recordId);
    const { preview, early, rejected } = await bufferedCorrectionApproval(cli, sandbox, id, fixture.corrected, output);
    save('buffered/early-source.json', JSON.stringify(early, null, 2) + '\n');
    const before = await send(cli, `inspect ${id}`, 'memory-inspect');
    const committed = await send(cli, `commit ${preview.token} ${JSON.stringify(fixture.corrected)}`, 'memory-result');
    await stop(cli);
    verify('buffered-approval', () => {
      assert.equal(rejected.status, 'unavailable'); assert.equal(rejected.reason, 'presentation-before-live-input-required');
      assert.deepEqual(rejected.receiptIds, []);
      assert.equal((before.targets as { content: string; revision: number }[])[0]!.content, fixture.original);
      assert.equal((before.targets as { revision: number }[])[0]!.revision, 1);
      assert.equal(committed.status, 'committed');
      validate(sandbox.root, id, preview.operationId!, preview.token, committed.receiptIds, JSON.stringify(early));
    });
  } catch (error) { checks.push({ id: 'buffered-approval', passed: false, diagnostic: save('buffered/error.txt', (error as Error).stack ?? String(error)) }); }
  finally {
    for (const cli of clients) if (!cli.observations.some(row => row.event === 'process-exit')) { cli.child.kill('SIGKILL'); await cli.exit; }
    cpSync(sandbox.root, join(destination, 'buffered', 'raw-sandbox'), { recursive: true });
    output.close(); rmSync(sandbox.root, { recursive: true, force: true });
  }
}
const artifacts: { path: string; bytes: number; sha256: string }[] = [];
function inventory(path: string) { for (const entry of readdirSync(path, { withFileTypes: true })) { const target = join(path, entry.name);
  if (entry.isDirectory()) inventory(target); else { const bytes = readFileSync(target); artifacts.push({ path: relative(destination, target).replaceAll('\\', '/'), bytes: bytes.length, sha256: digest(bytes) }); } } }
inventory(destination);
const passed = checks.length === fixture.cases.length && fixture.cases.every(id => checks.some(check => check.id === id && check.passed));
const receipt = { schema: 'owner-correction-evidence@1', startedAt, endedAt: new Date().toISOString(),
  result: passed ? 'evidence-gap' : 'failed', syntheticPassed: passed,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  dirty: execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim().length > 0,
  environment: { platform: platform(), release: release(), arch: arch(), node: process.version },
  fixtureDigest: digest(readFileSync(join(repo, 'fixtures/t15-owner-correction.json'))), commands, checks, artifacts,
  gaps: ['actual-provider-semantic-quality', 'long-session-correction-summary-compaction', 'other-platforms-require-their-own-receipts', 'non-cli-host-integration', 'production-data-and-migration'] };
save('receipt.json', JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ evidence: destination, result: receipt.result, syntheticPassed: passed, checks: checks.length }));
if (!passed) process.exitCode = 1;
