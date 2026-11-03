import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { appendFileSync, cpSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { release } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sha256 } from '@euler/core';
import { startCli } from '../apps/cli/src/process-driver.ts';
import { AGENT_BUDGET } from '../apps/cli/src/agent-cli.ts';

const directory = join('artifacts', 't55-' + Date.now());
mkdirSync(directory, { recursive: true });
const clients: ReturnType<typeof startCli>[] = [], roots: string[] = [];
const checks: string[] = [];
const receipt = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workingTree: execFileSync('git', ['status', '--short'], { encoding: 'utf8' }).trim(),
  fixtureHash: sha256(readFileSync(new URL(import.meta.url))), startedAt: new Date().toISOString(),
  platform: process.platform, release: release(), node: process.version };
function start(name: string, args: string[]) {
  writeFileSync(join(directory, name + '-command.json'), JSON.stringify(args));
  const cli = startCli(args, 150000, undefined, { ...process.env, EULER_SCOPE_TEST_KEY: 'synthetic-scope-only' }); clients.push(cli);
  cli.child.stdout.on('data', bytes => appendFileSync(join(directory, name + '-stdout.jsonl'), bytes));
  cli.child.stderr.on('data', bytes => appendFileSync(join(directory, name + '-stderr.txt'), bytes));
  const send = (line: string) => { appendFileSync(join(directory, name + '-stdin.txt'), line + '\n'); cli.command(line); };
  async function command(line: string, event: string) {
    const at = cli.observations.length; send(line); return cli.waitFor(event, at);
  }
  return { cli, send, command, async close() { send('/exit'); assert.equal((await cli.exit).code, 0); } };
}
function database<T>(root: string, inspect: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(root, 'probe.sqlite'), { readOnly: true });
  try { return inspect(db); } finally { db.close(); }
}
function snapshot(root: string, name: string) { cpSync(root, join(directory, name), { recursive: true }); }

try {
  const create = start('create', ['session-create', '--owner', randomUUID(), '--host', randomUUID()]);
  assert.equal((await create.cli.exit).code, 0);
  const created = create.cli.observations.find(event => event.event === 'session-created')!;
  const root = created.root as string; roots.push(root);
  const wrongOwner = start('wrong-owner', ['session-create', '--sandbox', root, '--owner', randomUUID()]);
  assert.equal((await wrongOwner.cli.exit).code, 1);
  assert.ok(wrongOwner.cli.observations.some(event => event.event === 'error' && event.reason === 'store-binding-mismatch'));
  checks.push('wrong owner is refused by the actual CLI store binding');
  const before = start('before', ['session', '--sandbox', root]);
  await before.cli.waitFor('session-ready');
  const initial = await before.command('记住偏好：T55 initial segment uses blue.', 'remember-result');
  assert.equal(initial.reason, 'scope-unresolved');
  await before.command('/task Work on the synthetic shop.', 'session-task');
  const old = await before.command('记住决定：T55 shop prices use yuan.', 'remember-result');
  await before.command('/task Work on the synthetic game.', 'session-task');
  const current = await before.command('记住决定：T55 game scores are integers.', 'remember-result');
  const independent = await before.command('记住偏好：T55 game examples use fictional players.', 'remember-result');
  assert.equal(current.reason, 'scope-unresolved');
  assert.equal(independent.reason, 'scope-unresolved');
  assert.deepEqual((await before.command('/memory T55', 'session-memory')).results, []);
  await before.close();
  snapshot(root, 'before');
  const original = database(root, db => ({
    revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY rowid').all(),
    events: db.prepare('SELECT * FROM memory_events ORDER BY rowid').all(),
    jobs: db.prepare('SELECT * FROM capture_jobs ORDER BY rowid').all(),
  }));
  const archive = readFileSync(join(root, 'session.jsonl'));
  checks.push('unbound candidates are absent from normal search');
  renameSync(join(root, 'session.jsonl'), join(root, 'unavailable-source.jsonl'));
  try {
    const missing = start('source-unavailable', ['session', '--sandbox', root]);
    assert.equal((await missing.cli.exit).code, 1);
    assert.equal(missing.cli.observations.some(event => event.event === 'session-ready'), false);
    database(root, db => assert.equal(db.prepare("SELECT count(*) AS n FROM memory_events WHERE kind='resolve-scope'").get()!.n, 0));
  } finally { renameSync(join(root, 'unavailable-source.jsonl'), join(root, 'session.jsonl')); }
  checks.push('unavailable original archive prevents continuation');

  const projectId = randomUUID(), bind = '/bind ' + JSON.stringify({ projectId, root: null });
  const after = start('bind', ['session', '--sandbox', root]);
  await after.cli.waitFor('session-ready');
  await after.command(bind, 'session-bound');
  await after.command('/drain', 'session-drained');
  const page = await after.command('/memory T55', 'session-memory');
  const ids = (page.results as { unitId: string }[]).map(item => item.unitId).sort();
  assert.deepEqual(ids, [current.recordId, independent.recordId].sort());
  const info = await after.command('/info', 'info-list');
  assert.equal((info.rows as unknown[]).length, 2);
  await after.command(bind, 'session-bound');
  const wrong = await after.command('/bind ' + JSON.stringify({ projectId: randomUUID(), root: null }), 'session-command-rejected');
  assert.equal(wrong.reason, 'session-project-already-bound');
  assert.equal((await after.command('/status', 'session-status')).networkCount, 0);
  await after.close();
  snapshot(root, 'after');
  database(root, db => {
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 30);
    assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    for (const row of original.revisions) assert.deepEqual(db.prepare('SELECT * FROM memory_revisions WHERE revision_id=?').get(row.revision_id!), row);
    for (const row of original.events) assert.deepEqual(db.prepare('SELECT * FROM memory_events WHERE event_id=?').get(row.event_id!), row);
    for (const row of original.jobs) assert.deepEqual(db.prepare('SELECT * FROM capture_jobs WHERE job_id=?').get(row.job_id!), row);
    for (const recordId of [current.recordId, independent.recordId]) {
      const revisions = db.prepare('SELECT * FROM memory_revisions WHERE record_id=? ORDER BY revision').all(String(recordId));
      assert.equal(revisions.length, 2);
      assert.equal(revisions[0]!.scope_kind, 'session');
      assert.equal(revisions[1]!.scope_kind, 'project');
      assert.equal(revisions[1]!.scope_id, projectId);
      assert.equal(revisions[1]!.source_project_id, null);
      assert.equal(revisions[1]!.source_json, revisions[0]!.source_json);
      assert.equal(db.prepare("SELECT count(*) AS n FROM memory_events WHERE record_id=? AND kind='resolve-scope'").get(String(recordId))!.n, 1);
      assert.equal(db.prepare("SELECT count(*) AS n FROM memory_events WHERE record_id=? AND kind='activate'").get(String(recordId))!.n, 1);
    }
    for (const recordId of [initial.recordId, old.recordId]) {
      const head = db.prepare('SELECT lifecycle,scope_kind FROM memory_heads WHERE record_id=?').get(String(recordId))!;
      assert.equal(head.lifecycle, 'candidate');
      assert.equal(head.scope_kind, 'session');
    }
  });
  assert.deepEqual(readFileSync(join(root, 'session.jsonl')).subarray(0, archive.length), archive);
  checks.push('only current task continues; initial and previous tasks remain local', 'same records gain exactly one immutable project revision',
    'old archive/revisions/events/capture jobs unchanged', 'duplicate confirmation is idempotent; conflicting project refused',
    'deterministic fast lane activates with durable Info and zero provider sends');

  const reopened = start('reopen', ['session', '--sandbox', root]);
  await reopened.cli.waitFor('session-ready');
  assert.equal(((await reopened.command('/info', 'info-list')).rows as unknown[]).length, 2);
  const preview = await reopened.command(`forget ${current.recordId}`, 'memory-preview');
  assert.equal((await reopened.command(`commit ${preview.token} forget`, 'memory-result')).status, 'committed');
  await reopened.command(bind, 'session-bound');
  await reopened.command('/drain', 'session-drained');
  assert.deepEqual(((await reopened.command('/memory T55', 'session-memory')).results as { unitId: string }[]).map(item => item.unitId), [independent.recordId]);
  await reopened.close();
  snapshot(root, 'forgotten');
  checks.push('restart does not duplicate Info; forget survives repeated confirmation/drain');
  const backup = start('backup', ['backup', '--sandbox', root]);
  assert.equal((await backup.cli.exit).code, 0, JSON.stringify(backup.cli.observations));
  snapshot(root, 'backed-up');
  const purge = start('purge', ['purge', '--sandbox', root, '--record', String(current.recordId)]);
  const manifest = await purge.cli.waitFor('purge-preview');
  assert.equal((await purge.command(String(manifest.phrase), 'purge-result')).status, 'logical-commit');
  assert.equal((await purge.command('cleanup', 'purge-result')).status, 'controlled-complete');
  assert.equal((await purge.cli.exit).code, 0);
  const cleaned = start('cleaned', ['session', '--sandbox', root]);
  await cleaned.cli.waitFor('session-ready');
  await cleaned.command(bind, 'session-bound');
  await cleaned.command('/drain', 'session-drained');
  assert.deepEqual(((await cleaned.command('/memory T55', 'session-memory')).results as { unitId: string }[]).map(item => item.unitId), [independent.recordId]);
  await cleaned.close();
  snapshot(root, 'purged');
  const cleanBackup = start('purged-backup', ['backup', '--sandbox', root]);
  assert.equal((await cleanBackup.cli.exit).code, 0, JSON.stringify(cleanBackup.cli.observations));
  checks.push('backup integrity audit passes before and after purge', 'purge removes target without deleting independent sibling or shared binding');
  const normalCreate = start('normal-create', ['session-create', '--owner', randomUUID(), '--host', randomUUID()]);
  assert.equal((await normalCreate.cli.exit).code, 0);
  const normalRoot = normalCreate.cli.observations.find(event => event.event === 'session-created')!.root as string;
  roots.push(normalRoot);
  const normalBefore = start('normal-before', ['session', '--sandbox', normalRoot]);
  await normalBefore.cli.waitFor('session-ready');
  const claim = 'T55 rawscope verification keeps original evidence.';
  await normalBefore.command('记住：' + claim, 'remember-result');
  await normalBefore.command('/bind ' + JSON.stringify({ projectId: randomUUID(), root: null }), 'session-bound');
  await normalBefore.close();
  snapshot(normalRoot, 'normal-before');
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    requests.push(body); writeFileSync(join(directory, `normal-http-${requests.length}.json`), body);
    const { messages } = JSON.parse(body), tail = JSON.parse(messages.at(-1).content);
    const results = messages.filter((message: { role: string }) => message.role === 'tool')
      .map((message: { content: string }) => JSON.parse(JSON.parse(message.content).result));
    const expanded = results.find((result: { ref?: unknown; text?: string }) => result.ref && typeof result.text === 'string');
    const search = results.find((result: { results?: unknown[] }) => result.results);
    const call = tail.intent.step === 'proposer' || expanded ? null : search
      ? { name: 'source_expand', arguments: JSON.stringify({ eventId: search.results[0].ref.eventId, offset: 0, limit: 4096 }) }
      : { name: 'source_search', arguments: JSON.stringify({ query: 'rawscope' }) };
    const content = call ? null : tail.intent.step === 'proposer'
      ? JSON.stringify({ type: 'decision', content: claim }) : JSON.stringify({ result: 'pass', evidence: [expanded.ref] });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content,
      ...(call ? { tool_calls: [{ id: 'scope-' + requests.length, type: 'function', function: call }] } : {}) },
      finish_reason: call ? 'tool_calls' : 'stop' }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const config = join(directory, 'normal-route.json');
    writeFileSync(config, JSON.stringify({ provider: 'fixture', model: 'scope-capture',
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, authNamespace: 'synthetic',
      credentialEnv: 'EULER_SCOPE_TEST_KEY', contextWindow: 32000, maxTokens: 1024, authorization: 'synthetic-test-only',
      captureCapability: 'standard', budget: { ...AGENT_BUDGET, maxModelAttempts: 8, maxTotalTokens: 256000 } }));
    const normal = start('normal-verify', ['session', '--sandbox', normalRoot, '--capture-config', config]);
    await normal.cli.waitFor('session-ready');
    const result = await normal.command('/drain', 'session-drained');
    const jobs = result.capture as { stage: string; record: { recordId: string; lifecycle: string; source: { binding: { projectId: string | null } } } }[];
    assert.equal(jobs.length, 1); assert.equal(jobs[0]!.record.lifecycle, 'active', JSON.stringify(jobs));
    assert.equal(jobs[0]!.record.source.binding.projectId, null); assert.equal(requests.length, 4);
    assert.equal(((await normal.command('/memory rawscope', 'session-memory')).results as unknown[]).length, 1);
    assert.equal(((await normal.command('/info', 'info-list')).rows as unknown[]).length, 1);
    await normal.close();
    const normalRestart = start('normal-reopen', ['session', '--sandbox', normalRoot]);
    await normalRestart.cli.waitFor('session-ready');
    await normalRestart.command('/drain', 'session-drained');
    assert.equal(((await normalRestart.command('/memory rawscope', 'session-memory')).results as unknown[]).length, 1);
    assert.equal(requests.length, 4); await normalRestart.close();
    snapshot(normalRoot, 'normal-after');
    database(normalRoot, db => {
      assert.deepEqual(db.prepare('SELECT payload_hash FROM request_attempts ORDER BY rowid').all().map(row => row.payload_hash), requests.map(sha256));
      assert.equal(db.prepare('SELECT count(*) AS n FROM capture_scope_resolutions').get()!.n, 1);
      assert.equal(db.prepare("SELECT count(*) AS n FROM memory_events WHERE kind='activate'").get()!.n, 1);
    });
    checks.push('ordinary CLI untyped continuation uses four actual loopback HTTP requests and independent source tools',
      'normal lane retains original null-project source, single activation and durable Info after restart');
  } finally { server.closeAllConnections(); const closed = once(server, 'close'); server.close(); await closed; }
  writeFileSync(join(directory, 'receipt.json'), JSON.stringify({ ...receipt, status: 'pass', finishedAt: new Date().toISOString(),
    checks, normalHttpRequests: requests.length, projectId, records: { initial: initial.recordId, old: old.recordId, current: current.recordId, independent: independent.recordId },
    evidenceGaps: ['External-provider semantic quality remains T24 B3; normal-lane transport here is controlled loopback.'],
  }, null, 2));
  console.log(JSON.stringify({ directory, status: 'pass', checks }));
} catch (error) {
  writeFileSync(join(directory, 'receipt.json'), JSON.stringify({ ...receipt, status: 'failed', checks, reason: String(error) }, null, 2));
  for (const cli of clients) if (cli.child.exitCode === null && cli.child.signalCode === null) { cli.child.kill(); await cli.exit; }
  for (const [index, root] of roots.entries()) snapshot(root, 'failed-' + index);
  throw error;
} finally {
  for (const cli of clients) if (cli.child.exitCode === null && cli.child.signalCode === null) { cli.child.kill(); await cli.exit; }
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}
