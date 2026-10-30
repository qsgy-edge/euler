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
import fixture from '../fixtures/t16-forget-restore.json' with { type: 'json' };

const repo = fileURLToPath(new URL('../', import.meta.url));
const startedAt = new Date().toISOString();
const destination = join(repo, 'artifacts', `t16-${startedAt.replace(/[:.]/g, '-')}`);
mkdirSync(destination, { recursive: true });
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const save = (path: string, bytes: string | Buffer) => {
  const target = join(destination, path); mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, bytes); return path;
};
const checks: { id: string; passed: boolean; diagnostic?: string }[] = [];
const commands: { command: string[]; stdout: string; stderr: string; code: number | null; signal: string | null }[] = [];
const clients: ReturnType<typeof startCli>[] = [];
function launch(root: string, label: string, scenario?: string) {
  const args = ['remember', '--sandbox', root, ...(scenario ? ['--scenario', scenario] : [])];
  const cli = startCli(args); clients.push(cli);
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  cli.child.stdout.on('data', (data: Buffer) => stdout.push(Buffer.from(data)));
  cli.child.stderr.on('data', (data: Buffer) => stderr.push(Buffer.from(data)));
  const captured = cli.exit.then(exit => commands.push({ command: [process.execPath, 'apps/cli/src/main.ts', ...args],
    stdout: save(`${label}/stdout.txt`, Buffer.concat(stdout)), stderr: save(`${label}/stderr.txt`, Buffer.concat(stderr)), ...exit }));
  return { ...cli, captured };
}
async function stop(cli: ReturnType<typeof launch>) {
  cli.command('stop'); assert.equal((await cli.exit).code, 0, cli.stderr()); await cli.captured;
}

// Recompute from closed SQLite and original JSONL; no Store replay, read or projection helpers.
function validate(root: string, recordId: string, tokens: { kind: 'forget' | 'restore'; token: string; operationId: string }[]) {
  const lines = readFileSync(join(root, 'session.jsonl'), 'utf8').trimEnd().split('\n');
  const header = JSON.parse(lines.shift()!);
  const sources = lines.map(line => {
    const event = JSON.parse(line); assert.equal(JSON.stringify(event), line);
    return { event, ack: { schema: 'cli-source-ack@1', status: 'durable', binding: header.binding,
      eventId: event.eventId, locator: `cli-jsonl@1/${header.binding.sessionId}/${event.eventId}`,
      hash: digest(line), byteLength: Buffer.byteLength(line), contentHash: digest(event.text) } };
  });
  const source = (json: string) => {
    const found = sources.find(row => JSON.stringify(row.ack) === json); assert.ok(found); return found.event;
  };
  const db = new DatabaseSync(join(root, 'probe.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 25);
    assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    const revisions = db.prepare('SELECT * FROM memory_revisions WHERE record_id=?').all(recordId);
    assert.equal(revisions.length, 1); assert.equal(revisions[0]!.content, fixture.original);
    assert.equal(revisions[0]!.content_hash, digest(fixture.original)); source(String(revisions[0]!.source_json));
    const events = db.prepare('SELECT * FROM memory_events WHERE record_id=? ORDER BY seq').all(recordId);
    let previous: string | null = null;
    const heads = new Set<string>();
    for (const row of events) {
      assert.equal(digest(String(row.payload)), row.payload_hash);
      const event = JSON.parse(String(row.payload));
      assert.equal(JSON.stringify(event.after), row.after_snapshot);
      assert.equal(row.before_snapshot, previous); previous = String(row.after_snapshot);
      assert.equal(event.after.headEventId, row.event_id);
      assert.equal(heads.has(event.after.headEventId), false); heads.add(event.after.headEventId);
      if (row.kind !== 'forget' && row.kind !== 'restore') continue;
      const operation = tokens.find(item => item.operationId === row.operation_id); assert.ok(operation);
      assert.equal(row.kind, operation.kind);
      assert.equal(event.before.revisionId, event.after.revisionId);
      assert.equal(event.after.lifecycle, row.kind === 'forget' ? 'tombstoned' : 'active');
      assert.equal(event.after.verification, 'verified');
      assert.equal(row.receipt_hash, digest(String(row.receipt_payload)));
      assert.deepEqual(event.ownerReceipt, JSON.parse(String(row.receipt_payload)));
      assert.equal(event.ownerReceipt.operationId, operation.operationId);
      if (row.kind === 'forget') {
        assert.equal(event.suppression.headEventId, event.before.headEventId);
        assert.equal(event.suppression.revisionId, event.before.revisionId);
        assert.equal(event.suppression.ownerId, header.binding.ownerId);
        assert.equal(event.suppression.contentHash, digest(fixture.original));
        assert.deepEqual(event.suppression.scope, event.before.scope);
        for (const ref of event.suppression.sources) source(JSON.stringify(ref));
        assert.ok(event.suppression.sources.length > 0);
      }
      const outbox = db.prepare("SELECT * FROM projection_jobs WHERE event_id=? AND kind='search'").all(String(row.event_id));
      assert.equal(outbox.length, 1); assert.equal(outbox[0]!.payload_hash, digest(String(outbox[0]!.payload)));
      const pending = db.prepare('SELECT * FROM pending_operations WHERE operation_id=?').get(operation.operationId)!;
      assert.equal(pending.state, 'committed'); assert.equal(pending.result_hash, digest(String(pending.result)));
      assert.deepEqual(JSON.parse(String(pending.result)).receiptIds, [row.receipt_id]);
      const delivery = db.prepare('SELECT * FROM host_operation_delivery WHERE operation_id=?').get(operation.operationId)!;
      assert.equal(delivery.owner_ack, 1);
      assert.equal(delivery.approval_hash, digest(String(delivery.approval_source)));
      assert.equal(delivery.model_hash, digest(String(delivery.model_source)));
      const approval = source(String(delivery.approval_source)); assert.equal(approval.role, 'user');
      assert.equal(approval.text, `commit ${operation.token} ${operation.kind}`);
      const model = source(String(delivery.model_source)); assert.equal(model.role, 'tool');
      assert.ok(Buffer.byteLength(model.text) <= fixture.summaryMaxBytes);
      const summary = JSON.parse(model.text);
      assert.equal(summary.kind, operation.kind); assert.equal(summary.status, 'committed');
      assert.deepEqual(Object.keys(summary).sort(), ['schema','operationId','kind','status','records','reason'].sort());
      assert.deepEqual(summary.records, [{ recordId, revisionId: event.after.revisionId, revision: 1,
        lifecycle: event.after.lifecycle, verification: 'verified' }]);
      assert.equal(model.text.includes(fixture.original), false);
    }
    assert.equal(events.filter(row => row.kind === 'forget' || row.kind === 'restore').length, tokens.length);
    const head = db.prepare('SELECT * FROM memory_heads WHERE record_id=?').get(recordId)!;
    assert.equal(head.snapshot, previous); assert.equal(head.snapshot_hash, digest(String(head.snapshot)));
    assert.equal(head.lifecycle, tokens.at(-1)!.kind === 'restore' ? 'active' : 'tombstoned');
    assert.equal(db.prepare("SELECT count(*) AS n FROM capture_jobs WHERE json_extract(payload,'$.lane')='reverification'").get()!.n, 0);
  } finally { db.close(); }
}

for (const id of fixture.cases) {
  const sandbox = createSandbox();
  try {
    let cli = launch(sandbox.root, `${id}/initial`);
    await cli.waitFor('remember-ready');
    const remembered = await send(cli, `记住偏好：${fixture.original}`, 'remember-result');
    const recordId = String(remembered.recordId);
    const before = await send(cli, `ask ${fixture.original}`, 'ask-result');
    assert.deepEqual(before.selected, [recordId]);
    const tokens: { kind: 'forget' | 'restore'; token: string; operationId: string }[] = [];
    for (const kind of ['forget', 'restore'] as const) {
      if (id === 'forget-after-commit' && kind === 'restore') break;
      const crash = id === `${kind}-after-commit`;
      if (crash) { await stop(cli); cli = launch(sandbox.root, `${id}/commit`, 'correction-after-commit'); await cli.waitFor('remember-ready'); }
      const preview = await send(cli, `${kind} ${recordId}`, 'memory-preview');
      assert.equal(preview.kind, kind);
      tokens.push({ kind, token: String(preview.token), operationId: String(preview.operationId) });
      if (crash) {
        cli.command(`commit ${preview.token} ${kind}`);
        await cli.waitFor('correction-checkpoint'); cli.child.kill('SIGKILL'); await cli.exit; await cli.captured;
        cli = launch(sandbox.root, `${id}/recovery`); await cli.waitFor('remember-ready');
      } else assert.equal((await send(cli, `commit ${preview.token} ${kind}`, 'memory-result')).status, 'committed');
      const replay = await send(cli, `replay ${preview.token}`, 'memory-result');
      assert.equal(replay.status, 'committed');
      const duplicate = await send(cli, `commit ${preview.token} ${kind}`, 'memory-result');
      assert.equal(duplicate.status, 'settled'); assert.deepEqual(duplicate.receiptIds, replay.receiptIds);
      const answer = await send(cli, `ask ${fixture.original}`, 'ask-result');
      assert.deepEqual(answer.selected, kind === 'forget' ? [] : [recordId]);
      assert.equal(JSON.parse(String(answer.payload)).operationSummaries.at(-1).kind, kind);
      if (kind === 'forget') {
        const repeated = await send(cli, `记住偏好：${fixture.original}`, 'remember-result');
        assert.equal(repeated.status, 'no_op'); assert.equal(repeated.recordId, recordId);
        const uncertain = await send(cli, `记住偏好：${fixture.paraphrase}`, 'remember-result');
        assert.equal(uncertain.status, 'blocked'); assert.equal(uncertain.reason, 'suppression-identity-evidence-gap');
        const inspected = await send(cli, `inspect ${recordId}`, 'memory-inspect');
        assert.equal((inspected.targets as { content: string }[])[0]!.content, fixture.original);
        const used = await send(cli, `used ${(before.receipt as { assemblyId: string }).assemblyId} ${recordId}`, 'memory-used');
        assert.equal((used.memories as { snapshot: { content: string } }[])[0]!.snapshot.content, fixture.original);
      }
    }
    await stop(cli);
    cli = launch(sandbox.root, `${id}/restart`); await cli.waitFor('remember-ready');
    const answer = await send(cli, `ask ${fixture.original}`, 'ask-result');
    assert.deepEqual(answer.selected, id === 'forget-after-commit' ? [] : [recordId]);
    await stop(cli);
    validate(sandbox.root, recordId, tokens);
    checks.push({ id, passed: true });
  } catch (error) {
    checks.push({ id, passed: false, diagnostic: save(`${id}/error.txt`, (error as Error).stack ?? String(error)) });
  } finally {
    for (const cli of clients) if (!cli.observations.some(row => row.event === 'process-exit')) { cli.child.kill('SIGKILL'); await cli.exit; }
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
const receipt = { schema: 'forget-restore-evidence@1', startedAt, endedAt: new Date().toISOString(),
  result: passed ? 'evidence-gap' : 'failed', syntheticPassed: passed,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  dirty: execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim().length > 0,
  environment: { platform: platform(), release: release(), arch: arch(), node: process.version },
  fixtureDigest: digest(readFileSync(join(repo, 'fixtures/t16-forget-restore.json'))), commands, checks, artifacts,
  gaps: ['actual-provider-semantic-quality', 'long-session-operation-summary-compaction', 'purge-closure-deletion-not-enabled',
    'other-platforms-require-their-own-receipts', 'non-cli-host-integration', 'production-data-and-migration'] };
save('receipt.json', JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ evidence: destination, result: receipt.result, syntheticPassed: passed, checks: checks.length }));
if (!passed) process.exitCode = 1;
