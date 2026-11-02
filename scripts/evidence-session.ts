import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { arch, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sha256 } from '@euler/core';
import { AGENT_BUDGET } from '../apps/cli/src/agent-cli.ts';
import { startCli } from '../apps/cli/src/process-driver.ts';

assert.equal(process.platform, 'win32', 'Windows native file evidence requires Windows');
const directory = join('artifacts', 't54-' + Date.now()); mkdirSync(directory, { recursive: true });
const project = realpathSync.native(mkdtempSync(join(tmpdir(), 'euler-t54-evidence-')));
const configDir = mkdtempSync(join(tmpdir(), 'euler-t54-route-'));
const input = '  Explain the synthetic sample exactly: 蓝色 17.  ';
const content = 'T54 synthetic approved output.';
writeFileSync(join(project, 'AGENTS.md'), 'Use the confirmed synthetic T54 project.');
const bodies: string[] = [];
const server = createServer(async (request, response) => {
  let bytes = ''; for await (const part of request) bytes += part;
  bodies.push(bytes); writeFileSync(join(directory, `http-${bodies.length}.json`), bytes);
  const call = [2, 3].includes(bodies.length) ? { name: 'file_write', arguments: JSON.stringify({ path: 'output.txt', content }) }
    : bodies.length === 5 ? { name: 'memory_search', arguments: JSON.stringify({ query: 'T54 examples' }) } : null;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: call ? null : 'Synthetic response ' + bodies.length,
    ...(call ? { tool_calls: [{ id: 't54-' + bodies.length, type: 'function', function: call }] } : {}) }, finish_reason: call ? 'tool_calls' : 'stop' }] }));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const route = { provider: 'fixture', model: 't54-loopback', authNamespace: 'synthetic-test', credentialEnv: 'EULER_T54_TEST_KEY',
  baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, contextWindow: 32000, maxTokens: 1024,
  authorization: 'synthetic-test-only', budget: AGENT_BUDGET };
const config = join(configDir, 'route.json'); writeFileSync(config, JSON.stringify(route));
const fixtureHash = sha256(readFileSync(new URL(import.meta.url)));
const env = { ...process.env, EULER_T54_TEST_KEY: 'synthetic-loopback-only' };
const clients: ReturnType<typeof startCli>[] = [];
function start(name: string, args: string[]) {
  writeFileSync(join(directory, `${name}-command.json`), JSON.stringify(args));
  const cli = startCli(args, 150000, undefined, env); clients.push(cli);
  cli.child.stdout.on('data', bytes => appendFileSync(join(directory, `${name}-stdout.jsonl`), bytes));
  cli.child.stderr.on('data', bytes => appendFileSync(join(directory, `${name}-stderr.txt`), bytes));
  const send = (line: string) => { appendFileSync(join(directory, `${name}-stdin.txt`), line + '\n'); cli.command(line); };
  async function command(line: string, expect: string) {
    const at = cli.observations.length; send(line); return cli.waitFor(expect, at);
  }
  return { cli, send, command };
}
const receipt = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workingTree: execFileSync('git', ['status', '--short'], { encoding: 'utf8' }).trim(), fixtureHash,
  startedAt: new Date().toISOString(), platform: process.platform, release: release(), arch: arch(), node: process.version, route };
let root: string | undefined;
try {
  const create = start('create', ['session-create', '--owner', randomUUID(), '--host', randomUUID()]);
  assert.equal((await create.cli.exit).code, 0);
  root = create.cli.observations.find(e => e.event === 'session-created')!.root as string;
  const active = start('session', ['session', '--sandbox', root, '--transport-config', config]);
  await active.cli.waitFor('session-ready');
  const first = await active.command(input, 'session-result'); assert.equal(first.terminal, 'completed');
  assert.equal(bodies.length, 1); assert.equal(JSON.parse(JSON.parse(bodies[0]!).messages.at(-1).content).input, input);
  const projectId = randomUUID(); await active.command('/bind ' + JSON.stringify({ projectId, root: project }), 'session-bound');
  const approval = await active.command('Write the agreed synthetic content to output.txt.', 'file-approval');
  assert.equal(approval.content, content);
  const file = await active.command('approve ' + approval.token, 'session-result'); assert.equal(file.terminal, 'completed');
  assert.equal(readFileSync(join(project, 'output.txt'), 'utf8'), content);
  const memory = await active.command('记住偏好：T54 examples should be synthetic.', 'remember-result'); assert.equal(memory.status, 'activated');
  const info = await active.command('/info', 'info-list'); assert.equal((info.rows as unknown[]).length, 1);
  await active.command('/window', 'session-window');
  const next = await active.command('Look up my T54 examples preference.', 'session-result'); assert.equal(next.terminal, 'completed');
  assert.equal(bodies.length, 6); assert.ok(bodies[5]!.includes('T54 examples should be synthetic.'));
  active.send('/exit'); assert.equal((await active.cli.exit).code, 0);
  const reopen = start('reopen', ['session', '--sandbox', root]);
  const status = await reopen.cli.waitFor('session-ready'); assert.equal(status.networkCount, 0);
  assert.equal((status.project as { projectId: string }).projectId, projectId);
  assert.equal((status.runs as unknown[]).length, 3);
  reopen.send('/exit'); assert.equal((await reopen.cli.exit).code, 0);
  cpSync(root, join(directory, 'sandbox'), { recursive: true }); cpSync(project, join(directory, 'project'), { recursive: true });
  const db = new DatabaseSync(join(directory, 'sandbox', 'probe.sqlite'), { readOnly: true });
  try {
    const attempts = db.prepare('SELECT payload_hash,outcome FROM request_attempts ORDER BY rowid').all();
    assert.deepEqual(attempts.map(row => row.payload_hash), bodies.map(sha256));
    assert.ok(attempts.every(row => row.outcome === 'received'));
    const raw = readFileSync(join(directory, 'sandbox', 'session.jsonl'), 'utf8').trimEnd().split('\n').slice(1);
    assert.ok(raw.some(line => { const event = JSON.parse(line); return event.text === input && event.projectId === null; }));
    assert.equal(db.prepare('SELECT project_id FROM session_project_bindings').get()!.project_id, projectId);
    const summary = { ...receipt, status: 'pass', finishedAt: new Date().toISOString(), networkCount: bodies.length,
      sqlite: db.prepare('SELECT sqlite_version() AS sqlite').get()!.sqlite, schemaVersion: db.prepare('PRAGMA user_version').get()!.user_version,
      runIds: [first.runId, file.runId, next.runId], attempts, recordId: memory.recordId };
    writeFileSync(join(directory, 'receipt.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ directory, status: summary.status, networkCount: bodies.length }));
  } finally { db.close(); }
} catch (error) {
  writeFileSync(join(directory, 'receipt.json'), JSON.stringify({ ...receipt, status: 'failed', reason: String(error), networkCount: bodies.length }, null, 2));
  throw error;
} finally {
  for (const cli of clients) if (cli.child.exitCode === null && cli.child.signalCode === null) { cli.child.kill(); await cli.exit; }
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  if (root) rmSync(root, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true }); rmSync(configDir, { recursive: true, force: true });
}
