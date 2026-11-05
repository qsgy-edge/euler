import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { AGENT_BUDGET } from '../src/agent-cli.ts';
import { startCli, sendCommand } from '../src/process-driver.ts';
import { inspectProjectRuleRanges, sha256 } from '@euler/core';
import type { PurgeCarrierSelection, PurgeManifest } from '@euler/core';

const rule = '通报落款使用「签收灯：青砚」。', other = '日期必须使用 ISO 8601。';
async function setup(t: TestContext) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'euler-rule-'))), projectId = randomUUID();
  const bootstrap = startCli(['session-create', '--owner', randomUUID(), '--host', randomUUID()]);
  assert.equal((await bootstrap.exit).code, 0);
  const sandbox = String(bootstrap.observations.find(o => o.event === 'session-created')!.root);
  const children: ReturnType<typeof startCli>[] = [];
  t.after(async () => {
    for (const cli of children) if (cli.child.exitCode === null && cli.child.signalCode === null) cli.child.kill();
    await Promise.all(children.map(cli => cli.exit));
    rmSync(root, { recursive: true, force: true }); rmSync(sandbox, { recursive: true, force: true });
  });
  const start = (args: string[], env?: NodeJS.ProcessEnv) => {
    const cli = startCli(args, args.includes('--transport-config') ? 150000 : 15000, undefined, env);
    children.push(cli);
    return cli;
  };
  const cli = start(['session', '--sandbox', sandbox]); await cli.waitFor('session-ready');
  return { cli, start, sandbox, file: join(root, 'AGENTS.md'), root, projectId, bind: '/bind ' + JSON.stringify({ projectId, root }) };
}

async function modelRoute(t: TestContext, root: string, respond: (body: string) => object) {
  const server = createServer(async (req, res) => { let body = ''; for await (const chunk of req) body += chunk;
  res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [respond(body)] })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const route = join(root, 'route.json'); writeFileSync(route, JSON.stringify({ provider: 'fixture', model: 'rule-reader', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    authNamespace: 'test', credentialEnv: 'EULER_RULE_TEST', authorization: 'synthetic-test-only', contextWindow: AGENT_BUDGET.contextLimit, maxTokens: AGENT_BUDGET.outputReserve, budget: AGENT_BUDGET }));
  return route;
}
const localEnv = { ...process.env, EULER_RULE_TEST: 'local-fixture' };
const done = { message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' };

test('a started rule cleanup accepts partial erasure only within the frozen ranges', () => {
  const prefix = 'Independent rule\r\n', bytes = Buffer.from(prefix + rule + '\r\n'), id = randomUUID();
  const range = { offset: Buffer.byteLength(prefix), bytes: Buffer.byteLength(rule) };
  const erased = Buffer.from(bytes); erased.fill(32, range.offset, range.offset + range.bytes);
  const selection: PurgeCarrierSelection = { role: 'project-output', file: { path: '/project/AGENTS.md', identity: { dev: '1', ino: '2' } },
    hash: sha256(bytes), bytes: bytes.length, entries: [{ id, hash: sha256(id + ':' + sha256(rule)) }],
    ruleCleanup: { ranges: [range], afterHash: sha256(erased) } };
  assert.deepEqual(inspectProjectRuleRanges(selection, bytes), erased);
  const partial = Buffer.from(bytes); partial.fill(32, range.offset, range.offset + Math.floor(range.bytes / 2));
  assert.throws(() => inspectProjectRuleRanges(selection, partial), /purge-project-output-changed/);
  assert.deepEqual(inspectProjectRuleRanges(selection, partial, true), erased);
  partial[0] = 120;
  assert.throws(() => inspectProjectRuleRanges(selection, partial, true), /purge-project-output-changed/);
});

test('setting a rule neither grants a file root nor turns natural conversation into a write', async t => {
  const { cli, bind } = await setup(t);
  assert.equal((await sendCommand(cli, '设为项目规则：' + rule, 'session-command-rejected')).reason, 'project-rule-root-required');
  assert.equal((await sendCommand(cli, '以后都这样。', 'session-command-rejected')).reason, 'explicit-route-model-auth-budget-required');
  if (process.platform !== 'win32') {
    await sendCommand(cli, bind, 'session-bound');
    assert.equal((await sendCommand(cli, '设为项目规则：' + rule, 'session-command-rejected')).reason, 'project-rule-file-unavailable');
  }
  cli.command('/exit'); assert.equal((await cli.exit).code, 0);
});

test('owner rule preview, rejection, publication and selective privacy purge use the actual project file', { skip: process.platform !== 'win32' }, async t => {
  const { cli, start, sandbox, file, bind, root } = await setup(t);
  await sendCommand(cli, bind, 'session-bound');
  const mem = await sendCommand(cli, '记住偏好：' + rule, 'remember-result'); assert.equal(mem.status, 'activated');
  assert.ok(!existsSync(file));
  const second = await sendCommand(cli, '记住偏好：' + other, 'remember-result'); assert.equal(second.status, 'activated');
  let offer = await sendCommand(cli, '设为项目规则：' + other, 'file-approval');
  assert.equal(offer.path, file); assert.ok(!existsSync(file)); assert.equal(offer.content, other + '\n');
  assert.equal((await sendCommand(cli, String(offer.rejectCommand), 'project-rule-result')).saved, false); assert.ok(!existsSync(file));
  offer = await sendCommand(cli, '设为项目规则：' + rule, 'file-approval');
  assert.equal((await sendCommand(cli, String(offer.command), 'project-rule-result')).saved, true);
  offer = await sendCommand(cli, '设为项目规则：' + other, 'file-approval');
  assert.equal(offer.content, rule + '\n' + other + '\n'); assert.equal(readFileSync(file, 'utf8'), rule + '\n');
  assert.equal((await sendCommand(cli, String(offer.command), 'project-rule-result')).saved, true);
  assert.equal(readFileSync(file, 'utf8'), offer.content); assert.equal((await sendCommand(cli, '/status', 'session-status')).networkCount, 0);
  assert.equal((await sendCommand(cli, '设为项目规则：' + rule, 'session-command-rejected')).reason, 'project-rule-already-present');
  cli.command('/exit'); assert.equal((await cli.exit).code, 0);
  const original = readFileSync(file, 'utf8'); writeFileSync(file, original + rule + '\n');
  const purge = start(['purge', '--sandbox', sandbox, '--record', String(mem.recordId)]);
  try {
    const rejected = await purge.waitFor('purge-rejected'); assert.match(String(rejected.reason), /project-rule-owner-review-required/);
    assert.equal(readFileSync(file, 'utf8'), original + rule + '\n');
  } finally { writeFileSync(file, original + '另一条手写规则。\n'); }
  const preview = await sendCommand(purge, 'acquire', 'purge-preview');
  const selected = (preview.manifest as PurgeManifest).carriers.find(c => c.file.path === file)!;
  assert.equal(selected.ruleCleanup?.ranges.length, 1);
  assert.equal((await sendCommand(purge, String(preview.phrase), 'purge-result')).status, 'logical-commit');
  assert.equal((await sendCommand(purge, 'cleanup', 'purge-result')).status, 'controlled-complete');
  assert.equal((await purge.exit).code, 0);
  const retained = readFileSync(file, 'utf8'); assert.equal(retained, ' '.repeat(Buffer.byteLength(rule)) + '\n' + other + '\n另一条手写规则。\n');
  for (const name of readdirSync(sandbox)) assert.ok(!readFileSync(join(sandbox, name)).includes(Buffer.from(rule)), name);
  const create = start(['session-create', '--sandbox', sandbox]); assert.equal((await create.exit).code, 0);
  const session = (create.observations.find(o => o.event === 'session-created')!.binding as { sessionId: string }).sessionId;
  const bodies: string[] = [], route = await modelRoute(t, root, body => { bodies.push(body); return done; });
  const reader = start(['session', '--sandbox', sandbox, '--session', session, '--transport-config', route], localEnv);
  await reader.waitFor('session-ready'); await sendCommand(reader, bind, 'session-bound');
  assert.equal((await sendCommand(reader, '写维护通报。', 'session-result')).terminal, 'completed');
  const body = JSON.parse(bodies[0]!); const guidance = body.messages.find((m: { role: string; content: string }) => m.role === 'system' && m.content.includes('local-guidance'));
  assert.ok(JSON.parse(guidance.content).blocks.some((b: {text:string}) => b.text === retained)); assert.ok(!bodies[0]!.includes(rule));
  reader.command('/exit'); assert.equal((await reader.exit).code, 0);
  const later = start(['purge', '--sandbox', sandbox, '--record', String(second.recordId)]);
  const next = await later.waitFor('purge-preview');
  assert.equal((next.manifest as PurgeManifest).carriers.find(c => c.file.path === file)?.ruleCleanup?.ranges.length, 1);
  await sendCommand(later, String(next.phrase), 'purge-result');
  assert.equal((await sendCommand(later, 'cleanup', 'purge-result')).status, 'controlled-complete');
  assert.equal((await later.exit).code, 0); assert.ok(readFileSync(file, 'utf8').endsWith('另一条手写规则。\n'));
  assert.ok(!readFileSync(file, 'utf8').includes(other));
});

for (const fault of ['before', 'partial', 'complete']) test(`interrupted rule erasure resumes after ${fault} write without changing unrelated bytes`, { skip: process.platform !== 'win32' }, async t => {
  const { cli, start, sandbox, file, bind } = await setup(t);
  writeFileSync(file, other + '\r\n'); await sendCommand(cli, bind, 'session-bound');
  const mem = await sendCommand(cli, '记住偏好：' + rule, 'remember-result');
  const offer = await sendCommand(cli, '设为项目规则：' + rule, 'file-approval');
  assert.equal((await sendCommand(cli, String(offer.command), 'project-rule-result')).saved, true);
  cli.command('/exit'); assert.equal((await cli.exit).code, 0);
  const before = readFileSync(file);
  const worker = (fault: string) => {
    const child = spawnSync(process.execPath, ['apps/cli/test/support/project-rule-purge-worker.ts', sandbox, String(mem.recordId), fault], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr); return child.stdout;
  };
  worker(fault);
  assert.deepEqual(readFileSync(file).subarray(0, Buffer.byteLength(other + '\r\n')), before.subarray(0, Buffer.byteLength(other + '\r\n')));
  if (fault === 'partial') {
    const partial = readFileSync(file), changed = Buffer.from(partial); changed[0] = 120; writeFileSync(file, changed);
    assert.equal(JSON.parse(worker('acquire')).acquired, false, 'unrelated bytes cannot change after the checkpoint');
    assert.deepEqual(readFileSync(file), changed); writeFileSync(file, partial);
  }
  assert.equal(JSON.parse(worker('acquire')).acquired, true, 'interrupted rule bytes must not permanently block maintenance');
  const resume = start(['purge', '--sandbox', sandbox]); await resume.waitFor('purge-result');
  assert.equal((await sendCommand(resume, 'cleanup', 'purge-result')).status, 'controlled-complete');
  assert.equal((await resume.exit).code, 0);
  assert.equal(readFileSync(file, 'utf8'), other + '\r\n' + ' '.repeat(Buffer.byteLength(rule)) + '\r\n');
});

test('an ordinary model-proposed addition retains the unrelated pre-existing AGENTS bytes through purge', { skip: process.platform !== 'win32' }, async t => {
  const { cli, start, sandbox, file, root, bind } = await setup(t);
  const derived = '青砚已签收，通报请使用这条新落款。';
  const original = '\uFEFF# Local\r\n\r\n' + other, content = original + '\r\n' + derived + '\r\n';
  writeFileSync(file, original); await sendCommand(cli, bind, 'session-bound');
  const mem = await sendCommand(cli, '记住偏好：' + rule, 'remember-result'); assert.equal(mem.status, 'activated');
  cli.command('/exit'); await cli.exit;
  let requests = 0, readOnly = false, observed = '';
  const route = await modelRoute(t, root, body => {
    if (readOnly) { observed = body; return done; }
    requests++; const tools = (JSON.parse(body).messages as { role: string; content: string }[]).filter(m => m.role === 'tool');
    const last = tools.at(-1)?.content;
    if (last && !last.includes(String(mem.recordId)) && !last.includes('file-guidance-refresh-required')) return done;
    const fn = !last ? { name: 'memory_search', arguments: JSON.stringify({ query: '青砚' }) }
      : { name: 'file_write', arguments: JSON.stringify({ path: 'AGENTS.md', content }) };
    return { message: { role: 'assistant', content: null, tool_calls: [{ id: 'rule-' + requests, type: 'function', function: fn }] }, finish_reason: 'tool_calls' };
  });
  const writer = start(['session', '--sandbox', sandbox, '--transport-config', route], localEnv); await writer.waitFor('session-ready');
  const preview = await sendCommand(writer, '以后按以前的青砚落款写通报。', 'file-approval'); assert.equal(preview.content, content);
  assert.deepEqual(preview.ruleMemoryIds, [mem.recordId]);
  const written = await sendCommand(writer, String(preview.command), 'session-result'); assert.equal(written.terminal, 'completed');
  assert.equal(readFileSync(file, 'utf8'), content); writer.command('/exit'); await writer.exit;
  const next = start(['session-create', '--sandbox', sandbox]); await next.exit;
  const session = (next.observations.find(o => o.event === 'session-created')!.binding as { sessionId: string }).sessionId;
  readOnly = true;
  const reader = start(['session', '--sandbox', sandbox, '--session', session, '--transport-config', route], localEnv);
  await reader.waitFor('session-ready'); await sendCommand(reader, bind, 'session-bound');
  await sendCommand(reader, '写通报。', 'session-result'); assert.ok(observed.includes(derived));
  reader.command('/exit'); await reader.exit;
  const purge = start(['purge', '--sandbox', sandbox, '--record', String(mem.recordId)]), plan = await purge.waitFor('purge-preview');
  assert.equal((plan.manifest as PurgeManifest).carriers.find(c => c.file.path === file)?.ruleCleanup?.ranges.length, 1);
  await sendCommand(purge, String(plan.phrase), 'purge-result'); assert.equal((await sendCommand(purge, 'cleanup', 'purge-result')).status, 'controlled-complete');
  await purge.exit; assert.equal(readFileSync(file, 'utf8'), original + '\r\n' + ' '.repeat(Buffer.byteLength(derived)) + '\r\n');
  for (const name of readdirSync(sandbox)) assert.ok(!readFileSync(join(sandbox, name)).includes(Buffer.from(derived)), name);
});
