import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_BUDGET } from '../src/agent-cli.ts';
import { openSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';
import { startCli, sendCommand } from '../src/process-driver.ts';

function temporary(t: TestContext, prefix: string) {
  const path = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

async function createSession(t: TestContext) {
  const ownerId = randomUUID(), hostId = randomUUID();
  const cli = startCli(['session-create', '--owner', ownerId, '--host', hostId]);
  const exit = await cli.exit;
  assert.equal(exit.code, 0, JSON.stringify(cli.observations));
  const created = cli.observations.find(item => item.event === 'session-created');
  assert.ok(created);
  t.after(() => rmSync(created.root as string, { recursive: true, force: true }));
  return { root: created.root as string, binding: created.binding as { ownerId: string; hostId: string; projectId: string | null; sessionId: string; branchId: string }, ownerId, hostId };
}

test('explicit disposable session bootstrap reopens the same unbound identity without a model route', async t => {
  const session = await createSession(t);
  assert.equal(session.binding.ownerId, session.ownerId);
  assert.equal(session.binding.hostId, session.hostId);
  assert.equal(session.binding.projectId, null);
  const cli = startCli(['session', '--sandbox', session.root]);
  try {
    const ready = await cli.waitFor('session-ready');
    assert.deepEqual(ready.binding, session.binding);
    assert.equal(ready.project, null);
    const status = await sendCommand(cli, '/status', 'session-status');
    assert.deepEqual(status.binding, session.binding);
    assert.equal(status.networkCount, 0);
    const missing = await sendCommand(cli, 'Explain this synthetic session.', 'session-command-rejected');
    assert.equal(missing.reason, 'explicit-route-model-auth-budget-required');
    assert.equal(missing.sends, 0);
    for (const text of ["Don't use jargon; explain this synthetic example.", '不要术语，解释合成示例。', '是否可以简化？', '同意',
      'feedback on this design, please', 'approve this approach', 'info about this example', 'used as a synthetic example', 'source of this idea?']) {
      const at = cli.observations.length; cli.command(text);
      const refused = await Promise.race(['session-command-rejected', 'memory-result', 'remember-result'].map(event => cli.waitFor(event, at)));
      assert.equal(refused.reason, 'explicit-route-model-auth-budget-required', JSON.stringify(refused));
    }
  } finally {
    cli.command('/exit');
    cli.child.stdin.end();
    assert.equal((await cli.exit).code, 0);
  }
});

test('configured ordinary stdin reaches the durable archive and HTTP route unchanged, then accepts another request', async t => {
  const session = await createSession(t), bodies: string[] = [];
  let agreedRecordId: string;
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    bodies.push(body);
    response.setHeader('content-type', 'application/json');
    const result = JSON.parse(body).messages.filter((message: { role: string }) => message.role === 'tool').at(-1);
    const call = bodies.length === 5 ? { name: 'source_search', arguments: JSON.stringify({ query: '蓝色', scope: 'session' }) }
      : bodies.length === 6 && JSON.parse(JSON.parse(result.content).result).results?.length ? { name: 'source_expand', arguments: JSON.stringify({ eventId: JSON.parse(JSON.parse(result.content).result).results[0].eventId, offset: 0, limit: 512 }) } : null;
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: call ? null : bodies.length === 8 ? '建议记住偏好：T54 agreed synthetic examples.' : 'Synthetic answer ' + bodies.length,
      ...(call ? { tool_calls: [{ id: 'raw-' + bodies.length, type: 'function', function: call }] } : {}) }, finish_reason: call ? 'tool_calls' : 'stop' }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const directory = temporary(t, 'euler-t54-http-'), config = join(directory, 'route.json');
  writeFileSync(config, JSON.stringify({ provider: 'fixture', model: 'session-http', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    authNamespace: 'synthetic-test', credentialEnv: 'EULER_SESSION_TEST_KEY', contextWindow: 32000, maxTokens: 1024,
    authorization: 'synthetic-test-only', budget: AGENT_BUDGET }));
  const cli = startCli(['session', '--sandbox', session.root, '--transport-config', config], 150000, undefined,
    { ...process.env, EULER_SESSION_TEST_KEY: 'synthetic-session-test-key' });
  const first = '  Explain my synthetic question exactly: 蓝色 17.  ', second = '不要术语，解释我刚才的合成问题。';
  try {
    const ready = await cli.waitFor('session-ready');
    assert.ok(ready.route, JSON.stringify(cli.observations));
    const result = await sendCommand(cli, first, 'session-result');
    assert.equal(result.terminal, 'completed', JSON.stringify(cli.observations));
    assert.equal(result.text, 'Synthetic answer 1');
    assert.equal(bodies.length, 1);
    assert.equal(JSON.parse(JSON.parse(bodies[0]!).messages.at(-1).content).input, first);
    const next = await sendCommand(cli, second, 'session-result');
    assert.equal(next.terminal, 'completed', JSON.stringify(cli.observations));
    assert.equal(next.text, 'Synthetic answer 2');
    assert.equal(bodies.length, 2);
    assert.notEqual(next.runId, result.runId);
    assert.ok(JSON.parse(bodies[1]!).messages.some((message: { content: string }) => message.content === first));
    const projectId = randomUUID();
    await sendCommand(cli, '/bind ' + JSON.stringify({ projectId, root: null }), 'session-bound');
    const boundResult = await sendCommand(cli, 'Now continue in the confirmed project.', 'session-result');
    assert.equal(boundResult.terminal, 'completed', JSON.stringify(cli.observations));
    assert.equal(bodies.length, 3);
    const at = cli.observations.length; cli.command('同意');
    const agreement = await Promise.race(['session-result', 'remember-result', 'memory-result'].map(event => cli.waitFor(event, at)));
    assert.equal(agreement.event, 'session-result', JSON.stringify(agreement));
    assert.equal(bodies.length, 4);
    assert.equal(JSON.parse(JSON.parse(bodies[3]!).messages.at(-1).content).input, '同意');
    const recovered = await sendCommand(cli, 'Find and recover the original blue question.', 'session-result');
    assert.equal(recovered.terminal, 'completed', JSON.stringify(recovered.status));
    assert.equal(bodies.length, 7, JSON.stringify(recovered.status));
    const raw = JSON.parse(bodies[6]!).messages.filter((message: { role: string }) => message.role === 'tool').at(-1);
    assert.equal(JSON.parse(JSON.parse(raw.content).result).text, first);
    const memory = await sendCommand(cli, '记住偏好：T54 concise examples are preferred.', 'remember-result');
    assert.equal(memory.status, 'activated', JSON.stringify(cli.observations));
    const inspect = await sendCommand(cli, `inspect ${memory.recordId}`, 'memory-inspect');
    assert.equal((inspect.targets as { content: string }[])[0]!.content, 'T54 concise examples are preferred.');
    const preview = await sendCommand(cli, `forget ${memory.recordId}`, 'memory-preview');
    const committed = await sendCommand(cli, `commit ${preview.token} forget`, 'memory-result');
    assert.equal(committed.status, 'committed');
    const restored = await sendCommand(cli, `restore ${memory.recordId}`, 'memory-preview');
    assert.equal((await sendCommand(cli, `commit ${restored.token} restore`, 'memory-result')).status, 'committed');
    const proposed = await sendCommand(cli, 'Propose a synthetic preference to remember.', 'session-result');
    assert.equal(proposed.text, '建议记住偏好：T54 agreed synthetic examples.');
    const ownerAgreement = '  同意  ';
    const beforeAgreement = cli.observations.length; cli.command(ownerAgreement);
    const accepted = await Promise.race(['remember-result', 'session-result', 'session-command-rejected'].map(event => cli.waitFor(event, beforeAgreement)));
    assert.equal(accepted.status, 'activated', JSON.stringify(accepted));
    assert.equal(accepted.content, 'T54 agreed synthetic examples.');
    agreedRecordId = accepted.recordId as string;
    assert.equal((accepted.range as string[])[0], (proposed.status as { responses: { source: { eventId: string } }[] }).responses.at(-1)!.source.eventId);
    assert.equal(bodies.length, 8);
    const agreementSource = await sendCommand(cli, '/expand ' + JSON.stringify({ eventId: (accepted.range as string[]).at(-1), offset: 0, limit: 512 }), 'session-source');
    assert.equal(agreementSource.text, ownerAgreement);
    const persisted = await sendCommand(cli, `/request ${result.runId}`, 'session-request');
    assert.equal((persisted.ledger as { attempts: unknown[] }).attempts.length, 1);
    const firstInput = (persisted.status as { inputs: { state: string; source: { eventId: string } }[] }).inputs[0]!;
    assert.equal(firstInput.state, 'bound-to-assembly');
    const original = await sendCommand(cli, '/expand ' + JSON.stringify({ eventId: firstInput.source.eventId, offset: 0, limit: 512 }), 'session-source');
    assert.equal(original.text, first);
  } finally {
    cli.command('/exit'); cli.child.stdin.end(); await cli.exit;
    server.closeAllConnections(); server.close(); await once(server, 'close');
  }
  const reopened = startCli(['session', '--sandbox', session.root]);
  try {
    await reopened.waitFor('session-ready');
    assert.equal(reopened.observations.some(event => event.event === 'remember-result' && event.status === 'error'), false, JSON.stringify(reopened.observations));
  } finally { reopened.command('/exit'); await reopened.exit; }
  const backup = startCli(['backup', '--sandbox', session.root]);
  assert.equal((await backup.exit).code, 0, JSON.stringify(backup.observations));
  const purge = startCli(['purge', '--sandbox', session.root, '--record', agreedRecordId!]);
  try {
    const preview = await purge.waitFor('purge-preview');
    assert.equal((await sendCommand(purge, preview.phrase as string, 'purge-result')).status, 'logical-commit');
    const cleaned = await sendCommand(purge, 'cleanup', 'purge-result');
    assert.equal(cleaned.status, 'controlled-complete', JSON.stringify(purge.observations));
    await purge.exit;
  } finally { if (purge.child.exitCode === null) { purge.child.stdin.end(); await purge.exit; } }
  const cleaned = startCli(['session', '--sandbox', session.root]);
  try {
    await cleaned.waitFor('session-ready');
    const found = await sendCommand(cleaned, '/memory T54 agreed', 'session-memory');
    assert.equal((found.results as { unitId: string }[]).some(record => record.unitId === agreedRecordId), false);
  } finally { cleaned.command('/exit'); await cleaned.exit; }
});

test('configured model and approved native files share one bound session with guidance and later stdin', { skip: process.platform !== 'win32' }, async t => {
  const session = await createSession(t), projectId = randomUUID();
  const root = temporary(t, 'euler-t54-project-');
  writeFileSync(join(root, 'AGENTS.md'), 'T54 local guidance: keep synthetic file outputs precise.');
  mkdirSync(join(root, 'nested'));
  writeFileSync(join(root, 'nested', 'AGENTS.md'), 'T54 nested guidance: inspect these rules before writing.');
  const binder = startCli(['session', '--sandbox', session.root]);
  await binder.waitFor('session-ready');
  await sendCommand(binder, '/bind ' + JSON.stringify({ projectId, root }), 'session-bound');
  binder.command('/exit'); await binder.exit;
  const bodies: string[] = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    bodies.push(body);
    const call = bodies.length <= 2 ? { name: 'file_write', arguments: JSON.stringify({ path: 'nested/answer.txt', content: 'T54 native output' }) }
      : bodies.length === 4 ? { name: 'memory_search', arguments: JSON.stringify({ query: 'T54 synthetic output' }) }
      : bodies.length === 6 || bodies.length === 7 ? { name: 'file_write', arguments: JSON.stringify({ path: 'nested/rejected.txt', content: 'Do not write this.' }) } : null;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: call ? null : 'T54 file completed',
      ...(call ? { tool_calls: [{ id: 't54-' + bodies.length, type: 'function', function: call }] } : {}) }, finish_reason: call ? 'tool_calls' : 'stop' }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const config = join(temporary(t, 'euler-t54-route-'), 'route.json');
  writeFileSync(config, JSON.stringify({ provider: 'fixture', model: 'file-session-http', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    authNamespace: 'synthetic-test', credentialEnv: 'EULER_SESSION_TEST_KEY', contextWindow: 32000, maxTokens: 1024,
    authorization: 'synthetic-test-only', budget: AGENT_BUDGET }));
  const cli = startCli(['session', '--sandbox', session.root, '--transport-config', config], 150000, undefined,
    { ...process.env, EULER_SESSION_TEST_KEY: 'synthetic-session-test-key' });
  try {
    const ready = await cli.waitFor('session-ready');
    assert.equal(ready.files, 'windows-handles');
    const approval = await sendCommand(cli, 'Write a synthetic answer to nested/answer.txt.', 'file-approval');
    assert.equal(approval.content, 'T54 native output');
    assert.equal(bodies.length, 2);
    assert.ok(bodies[1]!.includes('T54 nested guidance'));
    cli.command(`approve ${approval.token}`);
    const result = await cli.waitFor('session-result');
    assert.equal(result.terminal, 'completed', JSON.stringify(cli.observations));
    assert.equal(readFileSync(join(root, 'nested', 'answer.txt'), 'utf8'), 'T54 native output');
    assert.ok(bodies[0]!.includes('T54 local guidance'));
    const memory = await sendCommand(cli, '记住偏好：T54 synthetic output is answer.txt.', 'remember-result');
    assert.equal(memory.status, 'activated');
    const next = await sendCommand(cli, 'Continue with the same synthetic files and memory.', 'session-result');
    assert.equal(next.terminal, 'completed', JSON.stringify(cli.observations));
    assert.ok(bodies.at(-1)!.includes('T54 synthetic output is answer.txt.'));
    const start = cli.observations.length;
    cli.command('Offer another synthetic file for rejection.');
    const rejected = await Promise.race(['file-approval', 'session-result', 'session-command-rejected'].map(event => cli.waitFor(event, start)));
    assert.equal(rejected.event, 'file-approval', JSON.stringify(JSON.parse(bodies.at(-1)!).messages.filter((message: { role: string }) => message.role === 'tool')));
    const denied = await sendCommand(cli, `reject ${rejected.token}`, 'session-result');
    assert.equal(denied.terminal, 'completed');
    assert.equal(existsSync(join(root, 'nested', 'rejected.txt')), false);
  } finally {
    cli.command('/exit'); cli.child.stdin.end(); await cli.exit;
    server.closeAllConnections(); server.close(); await once(server, 'close');
  }
});

test('configured capture and Historian drain through the ordinary session and preserve raw recovery', async t => {
  const session = await createSession(t), bodies: string[] = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    bodies.push(body);
    const policy = JSON.parse(body).messages[0].content as string;
    const text = policy.startsWith('Summarize only') ? JSON.stringify({ result: 'pass', summary: 'T54 archived exchange summary.' })
      : policy.startsWith('Capture synthetic') ? 'null' : 'T54 ordinary response.';
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const config = join(temporary(t, 'euler-t54-background-'), 'route.json');
  writeFileSync(config, JSON.stringify({ provider: 'fixture', model: 'session-background', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    authNamespace: 'synthetic-test', credentialEnv: 'EULER_SESSION_TEST_KEY', contextWindow: 32000, maxTokens: 1024,
    authorization: 'synthetic-test-only', captureCapability: 'standard', budget: AGENT_BUDGET }));
  const cli = startCli(['session', '--sandbox', session.root, '--transport-config', config, '--capture-config', config, '--historian-config', config],
    150000, undefined, { ...process.env, EULER_SESSION_TEST_KEY: 'synthetic-session-test-key' });
  try {
    await cli.waitFor('session-ready');
    await sendCommand(cli, '/bind ' + JSON.stringify({ projectId: randomUUID(), root: null }), 'session-bound');
    const invalidBinding = await sendCommand(cli, '/bind ' + JSON.stringify({ projectId: randomUUID(), root: null }), 'session-command-rejected');
    assert.equal(invalidBinding.reason, 'session-project-already-bound');
    const response = await sendCommand(cli, 'T54 keep this synthetic original.', 'session-result');
    assert.equal(response.terminal, 'completed');
    cli.command('/drain'); await sendCommand(cli, '/status', 'session-status');
    const drained = cli.observations.find(event => event.event === 'session-drained');
    assert.ok(drained, JSON.stringify(cli.observations.slice(-4)));
    assert.ok((drained.historian as { stage: string }[]).some(job => job.stage === 'complete'), JSON.stringify(cli.observations));
    assert.ok((drained.capture as { stage: string }[]).some(job => job.stage === 'complete'));
    assert.equal(bodies.length, 3);
    const probe = openProbe(openSandbox(session.root), AGENT_BUDGET, undefined, undefined, undefined, true);
    try {
      const job = probe.store.listCaptureJobs(probe.activity, 16, false, 'historian')[0]!;
      const summary = probe.store.readCompartment(probe.activity, job.jobId);
      assert.equal(summary.body.summary, 'T54 archived exchange summary.');
      assert.throws(() => probe.store.expandSource(probe.activity, { ref: summary.source, offset: 0, limit: 128 }), /source-derived/);
    } finally { probe.close(); }
    await sendCommand(cli, '/window', 'session-window');
    const next = await sendCommand(cli, 'Continue after the recorded boundary.', 'session-result');
    assert.equal(next.terminal, 'completed');
  } finally {
    cli.command('/exit'); cli.child.stdin.end(); await cli.exit;
    server.closeAllConnections(); server.close(); await once(server, 'close');
  }
});

test('configured capture resumes queued owner input at startup and after the next owner command', async t => {
  const session = await createSession(t), seed = startCli(['session', '--sandbox', session.root]);
  await seed.waitFor('session-ready');
  await sendCommand(seed, '/bind ' + JSON.stringify({ projectId: randomUUID(), root: null }), 'session-bound');
  await sendCommand(seed, '记住：T54 pending before restart.', 'remember-result');
  seed.command('/exit'); await seed.exit;
  const bodies: string[] = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk; bodies.push(body);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'null' }, finish_reason: 'stop' }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const config = join(temporary(t, 'euler-t54-auto-capture-'), 'route.json');
  writeFileSync(config, JSON.stringify({ provider: 'fixture', model: 'owner-capture', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    authNamespace: 'synthetic-test', credentialEnv: 'EULER_SESSION_TEST_KEY', contextWindow: 32000, maxTokens: 1024,
    authorization: 'synthetic-test-only', captureCapability: 'standard', budget: AGENT_BUDGET }));
  const cli = startCli(['session', '--sandbox', session.root, '--capture-config', config], 150000, undefined,
    { ...process.env, EULER_SESSION_TEST_KEY: 'synthetic-session-test-key' });
  try {
    await cli.waitFor('session-ready');
    const started = await Promise.race([cli.waitFor('capture-prerequisites-started'), new Promise<null>(resolve => { const timer = setTimeout(() => resolve(null), 5000); timer.unref(); })]);
    assert.ok(started, 'startup did not schedule the pending owner job');
    const first = await cli.waitFor('capture-queue');
    assert.ok((first.jobs as { stage: string }[]).some(job => job.stage === 'complete'), JSON.stringify(first));
    assert.equal(bodies.length, 1);
    const at = cli.observations.length;
    await sendCommand(cli, '记住：T54 new live owner job.', 'remember-result');
    const second = await cli.waitFor('capture-queue', at);
    assert.ok((second.jobs as { stage: string }[]).some(job => job.stage === 'complete'), JSON.stringify(second));
    assert.equal(bodies.length, 2);
    const buffered = await createSession(t);
    const cancelled = startCli(['session', '--sandbox', buffered.root, '--capture-config', config], 150000, undefined,
      { ...process.env, EULER_SESSION_TEST_KEY: 'synthetic-session-test-key' });
    try {
      await cancelled.waitFor('session-ready');
      cancelled.child.stdin.write('/bind ' + JSON.stringify({ projectId: randomUUID(), root: null }) + '\n记住：T54 cancelled owner job.\n/cancel\n/drain\n');
      await cancelled.waitFor('session-drained');
      assert.equal(bodies.length, 2, JSON.stringify(cancelled.observations));
      assert.equal((await sendCommand(cancelled, '/status', 'session-status')).project, null);
    } finally { cancelled.command('/exit'); await cancelled.exit; }
  } finally {
    cli.command('/exit'); await cli.exit;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('a later unbound session selects an existing project without inheriting its scope before confirmation', async t => {
  const first = await createSession(t), projectId = randomUUID();
  const owner = startCli(['session', '--sandbox', first.root]);
  await owner.waitFor('session-ready');
  await sendCommand(owner, '/bind ' + JSON.stringify({ projectId, root: null }), 'session-bound');
  const remembered = await sendCommand(owner, '记住偏好：T54 shared project examples.', 'remember-result');
  assert.equal(remembered.status, 'activated');
  owner.command('/exit'); await owner.exit;
  const creator = startCli(['session-create', '--sandbox', first.root]);
  assert.equal((await creator.exit).code, 0, JSON.stringify(creator.observations));
  const created = creator.observations.find(event => event.event === 'session-created')!;
  const binding = created.binding as { sessionId: string; projectId: null };
  assert.notEqual(binding.sessionId, first.binding.sessionId); assert.equal(binding.projectId, null);
  const next = startCli(['session', '--sandbox', first.root, '--session', binding.sessionId]);
  try {
    await next.waitFor('session-ready');
    assert.deepEqual((await sendCommand(next, '/memory T54', 'session-memory')).results, []);
    const deniedSource = await sendCommand(next, `source ${remembered.recordId}`, 'session-command-rejected');
    assert.equal(deniedSource.reason, 'invalid-memory-scope');
    const goal = await sendCommand(next, '/task Compare synthetic project evidence.', 'session-task');
    await sendCommand(next, '/bind ' + JSON.stringify({ projectId, root: null }), 'session-bound');
    const found = await sendCommand(next, '/memory T54', 'session-memory');
    assert.equal((found.results as { unitId: string }[])[0]!.unitId, remembered.recordId);
    const beforeSource = next.observations.length; next.command(`source ${remembered.recordId}`);
    const recovered = await Promise.race(['memory-source', 'session-command-rejected'].map(event => next.waitFor(event, beforeSource)));
    assert.equal(recovered.event, 'memory-source', JSON.stringify(recovered));
    assert.equal(recovered.text, '记住偏好：T54 shared project examples.');
    const grant = await sendCommand(next, '/grant ' + JSON.stringify({ projectIds: [projectId], targets: {}, maxResults: 8, maxBytes: 8192 }), 'session-grant');
    assert.ok(goal.intentId && grant.grantId);
    const at = next.observations.length;
    next.command('/memory T54');
    const granted = await Promise.race(['session-memory', 'session-command-rejected'].map(event => next.waitFor(event, at)));
    assert.equal(granted.event, 'session-memory', JSON.stringify(granted));
    assert.equal((granted.results as { unitId: string }[])[0]!.unitId, remembered.recordId);
  } finally { next.command('/exit'); await next.exit; }
  const backup = startCli(['backup', '--sandbox', first.root]);
  assert.equal((await backup.exit).code, 0, JSON.stringify(backup.observations));
});

test('purge removes a bound-session memory and its backup without erasing the confirmed project', async t => {
  const session = await createSession(t), projectId = randomUUID();
  const cli = startCli(['session', '--sandbox', session.root]);
  await cli.waitFor('session-ready');
  await sendCommand(cli, '/bind ' + JSON.stringify({ projectId, root: null }), 'session-bound');
  const memory = await sendCommand(cli, '记住偏好：T54 erase this synthetic memory.', 'remember-result');
  assert.equal(memory.status, 'activated');
  cli.command('/exit'); await cli.exit;
  const backup = startCli(['backup', '--sandbox', session.root]);
  assert.equal((await backup.exit).code, 0, JSON.stringify(backup.observations));
  const purge = startCli(['purge', '--sandbox', session.root, '--record', memory.recordId as string]);
  try {
    const preview = await purge.waitFor('purge-preview');
    const committed = await sendCommand(purge, preview.phrase as string, 'purge-result');
    assert.equal(committed.status, 'logical-commit');
    const complete = await sendCommand(purge, 'cleanup', 'purge-result');
    assert.equal(complete.status, 'controlled-complete', JSON.stringify(purge.observations));
    assert.equal((await purge.exit).code, 0);
  } finally { if (purge.child.exitCode === null) { purge.child.stdin.end(); await purge.exit; } }
  const reopened = startCli(['session', '--sandbox', session.root]);
  try {
    const ready = await reopened.waitFor('session-ready');
    assert.equal((ready.project as { projectId: string }).projectId, projectId);
    assert.deepEqual((await sendCommand(reopened, '/memory T54', 'session-memory')).results, []);
  } finally { reopened.command('/exit'); await reopened.exit; }
});

test('pre-binding cancelled correction delivery survives binding, restart and backup without promoting its candidate', async t => {
  const session = await createSession(t), cli = startCli(['session', '--sandbox', session.root]);
  try {
    await cli.waitFor('session-ready');
    const candidate = await sendCommand(cli, '记住偏好：T54 unresolved correction source.', 'remember-result');
    assert.equal(candidate.reason, 'scope-unresolved');
    const preview = await sendCommand(cli, `correct ${candidate.recordId} "T54 proposed new text."`, 'memory-preview');
    const cancelled = await sendCommand(cli, `cancel ${preview.token}`, 'memory-result');
    assert.equal(cancelled.status, 'cancelled');
    await sendCommand(cli, '/bind ' + JSON.stringify({ projectId: randomUUID(), root: null }), 'session-bound');
    const at = cli.observations.length; cli.command(`replay ${preview.token}`);
    const replayed = await Promise.race(['memory-result', 'memory-delivery-error', 'session-command-rejected'].map(event => cli.waitFor(event, at)));
    assert.equal(replayed.status, 'cancelled', JSON.stringify(replayed));
    const inspected = await sendCommand(cli, `inspect ${candidate.recordId}`, 'memory-inspect');
    assert.deepEqual((inspected.targets as { scope: unknown }[])[0]!.scope, { kind: 'session', id: session.binding.sessionId, resolved: false });
    assert.deepEqual((await sendCommand(cli, '/memory T54', 'session-memory')).results, []);
  } finally { cli.command('/exit'); await cli.exit; }
  const reopened = startCli(['session', '--sandbox', session.root]);
  try { await reopened.waitFor('session-ready'); assert.equal(reopened.observations.some(event => event.event === 'memory-delivery-error'), false); }
  finally { reopened.command('/exit'); await reopened.exit; }
  const backup = startCli(['backup', '--sandbox', session.root]);
  assert.equal((await backup.exit).code, 0, JSON.stringify(backup.observations));
});

test('unbound and confirmed session identities participate in public backup and restore', async t => {
  const session = await createSession(t), projectId = randomUUID();
  const before = startCli(['backup', '--sandbox', session.root]);
  assert.equal((await before.exit).code, 0, JSON.stringify(before.observations));
  const old = before.observations.find(event => event.event === 'backup-result')!;
  assert.ok(old);
  const cli = startCli(['session', '--sandbox', session.root]);
  await cli.waitFor('session-ready');
  await sendCommand(cli, '记住偏好：T54 unresolved backup candidate.', 'remember-result');
  await sendCommand(cli, '/bind ' + JSON.stringify({ projectId, root: null }), 'session-bound');
  await sendCommand(cli, '记住偏好：T54 resolved backup candidate.', 'remember-result');
  cli.command('/exit'); await cli.exit;
  const after = startCli(['backup', '--sandbox', session.root]);
  assert.equal((await after.exit).code, 0, JSON.stringify(after.observations));
  const restore = startCli(['restore-snapshot', '--sandbox', session.root, '--snapshot', (old.snapshot as { id: string }).id]);
  assert.equal((await restore.exit).code, 0, JSON.stringify(restore.observations));
  const reopened = startCli(['session', '--sandbox', session.root]);
  try {
    const ready = await reopened.waitFor('session-ready');
    assert.deepEqual(ready.binding, session.binding);
    assert.equal(ready.project, null);
    assert.equal(ready.networkCount, 0);
  } finally { reopened.command('/exit'); await reopened.exit; }
});

test('an unbound session confirms an explicitly selected project and reopens without changing its source identity', async t => {
  const session = await createSession(t), projectId = randomUUID();
  const cli = startCli(['session', '--sandbox', session.root]);
  try {
    await cli.waitFor('session-ready');
    const unresolved = await sendCommand(cli, '记住偏好：T54 unbound response should be concise.', 'remember-result');
    assert.equal(unresolved.reason, 'scope-unresolved');
    const bound = await sendCommand(cli, '/bind ' + JSON.stringify({ projectId, root: null }), 'session-bound');
    assert.equal((bound.project as { projectId: string }).projectId, projectId);
    assert.deepEqual(bound.binding, session.binding);
    const remembered = await sendCommand(cli, '记住偏好：T54 bound response should include examples.', 'remember-result');
    assert.equal(remembered.status, 'activated', JSON.stringify(cli.observations));
    const page = await sendCommand(cli, '/memory T54', 'session-memory');
    assert.equal((page.results as unknown[]).length, 1);
    const info = await sendCommand(cli, '/info', 'info-list');
    assert.equal((info.rows as unknown[]).length, 1);
  } finally { cli.command('/exit'); cli.child.stdin.end(); assert.equal((await cli.exit).code, 0); }
  const reopened = startCli(['session', '--sandbox', session.root]);
  try {
    const ready = await reopened.waitFor('session-ready');
    assert.deepEqual(ready.binding, session.binding);
    assert.equal((ready.project as { projectId: string }).projectId, projectId);
    const rejected = await sendCommand(reopened, '/bind ' + JSON.stringify({ projectId: randomUUID(), root: null }), 'session-command-rejected');
    assert.equal(rejected.reason, 'session-project-already-bound');
  } finally { reopened.command('/exit'); reopened.child.stdin.end(); assert.equal((await reopened.exit).code, 0); }
});

