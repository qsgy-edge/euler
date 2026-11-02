import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { AgentStatus, ProbeBudget, RequestStatus, SourceAck } from '@euler/core';
import { AGENT_BUDGET } from '../src/agent-cli.ts';
import { openProbe } from '../src/probe.ts';
import { startCli, sendCommand } from '../src/process-driver.ts';
import { openSandbox } from '../src/sandbox.ts';

type Cli = ReturnType<typeof startCli>;
type DurableRun = { runId: string; terminal: AgentStatus['terminal']; attempts: { attemptId: string; outcome: string }[];
  sealed: boolean; relatedRunId: string | null };

function answer(response: ServerResponse, text: string, tool = false) {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: tool ? null : text,
    ...(tool ? { tool_calls: [{ id: 'synthetic-search', type: 'function', function: {
      name: 'memory_search', arguments: JSON.stringify({ query: 'synthetic recovery sentinel' }),
    } }] } : {}) }, finish_reason: tool ? 'tool_calls' : 'stop' }] }));
}

async function fixture(t: TestContext, respond: (response: ServerResponse, ordinal: number) => void,
  budget: ProbeBudget = AGENT_BUDGET) {
  const clients: Cli[] = [], roots: string[] = [], bodies: string[] = [], responses: ServerResponse[] = [];
  const received = new EventEmitter();
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    bodies.push(body); responses.push(response); received.emit('request');
    respond(response, bodies.length);
  });
  t.after(async () => {
    for (const cli of clients) await closeCli(cli);
    if (server.listening) {
      const closed = once(server, 'close'); server.closeAllConnections(); server.close(); await closed;
    }
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const bootstrap = startCli(['session-create', '--owner', randomUUID(), '--host', randomUUID()]);
  clients.push(bootstrap);
  assert.equal((await bootstrap.exit).code, 0, JSON.stringify(bootstrap.observations));
  const created = bootstrap.observations.find(item => item.event === 'session-created');
  assert.ok(created);
  const root = created.root as string;
  const directory = mkdtempSync(join(tmpdir(), 'euler-t54-recovery-'));
  roots.push(root, directory);
  const config = join(directory, 'route.json');
  writeFileSync(config, JSON.stringify({ provider: 'fixture', model: 'synthetic-recovery',
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    authNamespace: 'synthetic-test', credentialEnv: 'EULER_RECOVERY_TEST_KEY', contextWindow: 32000, maxTokens: 1024,
    authorization: 'synthetic-test-only', budget }));
  async function launch() {
    // Match interactive-session.test.ts: configured startup runs the real prerequisite suite.
    const cli = startCli(['session', '--sandbox', root, '--transport-config', config], 150000, undefined,
      { ...process.env, EULER_RECOVERY_TEST_KEY: 'synthetic-recovery-key' });
    clients.push(cli);
    const ready = await cli.waitFor('session-ready');
    assert.deepEqual(ready.binding, created!.binding);
    assert.ok(ready.route);
    return cli;
  }
  async function request(ordinal: number) {
    const signal = AbortSignal.timeout(15000);
    while (bodies.length < ordinal) await once(received, 'request', { signal });
    return responses[ordinal - 1]!;
  }
  function inspect(runId: string) {
    const probe = openProbe(openSandbox(root), budget, undefined, undefined, undefined, true);
    try {
      const status = probe.store.agentStatus(probe.activity, runId);
      return { status, ledger: probe.store.requestStatus(probe.activity, runId),
        inputs: status.inputs.map(input => ({ ...input, text: probe.archive.read(input.source).text })) };
    } finally { probe.close(); }
  }
  function projectRoot() {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'euler-t54-recovery-project-'))); roots.push(root);
    writeFileSync(join(root, 'AGENTS.md'), 'T54 bound guidance survives an interrupted run.'); return root;
  }
  return { launch, request, inspect, bodies, budget, projectRoot };
}

async function closeCli(cli: Cli) {
  if (cli.child.exitCode !== null || cli.child.signalCode !== null) { await cli.exit; return; }
  cli.command('/exit'); cli.child.stdin.end();
  const timer = setTimeout(() => cli.child.kill(), 15000);
  try { await cli.exit; } finally { clearTimeout(timer); }
}

// /status is an ordered stdin barrier, so unsupported commands fail immediately rather than waiting for a nonexistent event.
async function acknowledged(cli: Cli, command: string, event: string) {
  const from = cli.observations.length;
  cli.command(command);
  await sendCommand(cli, '/status', 'session-status');
  const observation = cli.observations.slice(from).find(item => item.event === event);
  assert.ok(observation, JSON.stringify(cli.observations.slice(from)));
  return observation;
}

async function cancelledRequest(f: Awaited<ReturnType<typeof fixture>>, cli: Cli) {
  const input = await sendCommand(cli, 'Synthetic request held in flight.', 'session-input');
  const held = await f.request(1);
  const result = await sendCommand(cli, '/cancel', 'session-result');
  assert.equal(result.runId, input.runId);
  assert.equal(result.terminal, 'cancelled');
  const before = f.inspect(input.runId as string);
  assert.equal(before.ledger.attempts.length, 1);
  assert.equal(before.ledger.attempts[0]!.outcome, 'unknown-sent');
  return { runId: input.runId as string, held, before };
}

test('session /follow-up and /queue preserve Core modes while only follow-up starts a linked run', async t => {
  const f = await fixture(t, (response, ordinal) => { if (ordinal > 1) answer(response, 'Synthetic follow-up answer.'); });
  const cli = await f.launch();
  const initial = await sendCommand(cli, 'Synthetic initial question.', 'session-input');
  const held = await f.request(1);
  const followText = '  Synthetic follow-up exact text 蓝色.  ', queueText = 'Synthetic queued-only sentinel.';
  const follow = await acknowledged(cli, '/follow-up ' + followText, 'session-input');
  const queued = await acknowledged(cli, '/queue ' + queueText, 'session-input');
  assert.equal(follow.mode, 'follow-up'); assert.equal(queued.mode, 'queue');
  assert.equal(follow.runId, initial.runId); assert.equal(queued.runId, initial.runId);
  const pending = f.inspect(initial.runId as string);
  assert.deepEqual(pending.inputs.slice(1).map(input => [input.mode, input.state, input.text]),
    [['follow-up', 'received', followText], ['queue', 'received', queueText]]);
  assert.equal(f.bodies.length, 1);
  assert.equal(f.bodies[0]!.includes('follow-up exact'), false);
  assert.equal(f.bodies[0]!.includes(queueText), false);
  const from = cli.observations.length;
  answer(held, 'Synthetic initial answer.');
  const first = await cli.waitFor('session-result', from);
  const next = await cli.waitFor('session-result', cli.observations.indexOf(first) + 1);
  assert.equal(first.terminal, 'completed'); assert.equal(next.terminal, 'completed');
  assert.notEqual(first.runId, next.runId);
  const linked = f.inspect(next.runId as string);
  assert.equal(linked.ledger.run.relatedRunId, first.runId);
  assert.equal(linked.inputs[0]!.source.eventId, (follow.source as SourceAck).eventId);
  assert.equal(linked.inputs[0]!.text, followText);
  assert.equal(linked.inputs[0]!.state, 'bound-to-assembly');
  assert.equal(f.inspect(first.runId as string).inputs.at(-1)!.state, 'received');
  assert.equal(f.bodies[1]!.includes(queueText), false);
  await closeCli(cli);
  assert.equal(f.bodies.length, 2);
});

test('session /cancel keeps an in-flight HTTP attempt unknown and ignores a late tool response', async t => {
  const f = await fixture(t, () => {}), cli = await f.launch();
  const { runId, held, before } = await cancelledRequest(f, cli);
  assert.equal(before.status.responses.length, 0);
  assert.equal(before.status.tools.length, 0);
  answer(held, 'Synthetic late response must be ignored.', true);
  await sendCommand(cli, '/status', 'session-status');
  await closeCli(cli);
  const after = f.inspect(runId);
  assert.deepEqual(after.status, before.status);
  assert.deepEqual(after.ledger.attempts, before.ledger.attempts);
  assert.equal(f.bodies.length, 1);
});

test('session restart reports durable unknown runs without sending and explicit /resume authorizes a fresh linked budget', async t => {
  const budget = { ...AGENT_BUDGET, maxModelAttempts: 1 };
  const f = await fixture(t, (response, ordinal) => { if (ordinal > 1) answer(response, 'Synthetic resumed answer.'); }, budget);
  const cli = await f.launch();
  await sendCommand(cli, '/bind ' + JSON.stringify({ projectId: randomUUID(), root: f.projectRoot() }), 'session-bound');
  const { runId, before } = await cancelledRequest(f, cli);
  await closeCli(cli);
  const reopened = await f.launch();
  const status = await sendCommand(reopened, '/status', 'session-status');
  assert.equal(status.networkCount, 0);
  assert.equal(f.bodies.length, 1);
  assert.ok(Array.isArray(status.runs), JSON.stringify(status));
  const durable = (status.runs as DurableRun[]).find(run => run.runId === runId);
  assert.ok(durable);
  assert.equal(durable.terminal, 'cancelled'); assert.equal(durable.sealed, true); assert.equal(durable.relatedRunId, null);
  assert.deepEqual(durable.attempts.map(attempt => [attempt.attemptId, attempt.outcome]),
    before.ledger.attempts.map(attempt => [attempt.attemptId, attempt.outcome]));
  const unavailable = await sendCommand(reopened, '/reconcile ' + before.ledger.attempts[0]!.attemptId, 'session-command-rejected');
  assert.equal(unavailable.reason, 'reconciliation-reader-unavailable');
  const newText = 'new synthetic text';
  const rejected = await sendCommand(reopened, '/resume ' + JSON.stringify({ relatedRunId: runId,
    acceptDuplicateRisk: false, input: newText }), 'session-command-rejected');
  assert.equal(rejected.reason, 'duplicate-risk-approval-required');
  assert.equal(f.bodies.length, 1);
  const from = reopened.observations.length;
  const resumed = await acknowledged(reopened, '/resume ' + JSON.stringify({ relatedRunId: runId,
    acceptDuplicateRisk: true, input: newText }), 'session-input');
  const result = await reopened.waitFor('session-result', from);
  assert.equal(result.runId, resumed.runId); assert.notEqual(result.runId, runId);
  assert.equal(result.terminal, 'completed'); assert.equal(result.networkCount, 1);
  const fresh = f.inspect(result.runId as string), old = f.inspect(runId);
  assert.equal(fresh.ledger.run.relatedRunId, runId);
  assert.deepEqual(fresh.ledger.run.budget, budget);
  assert.equal(fresh.ledger.events[0]!.kind, 'run-authorized');
  assert.notEqual(fresh.ledger.events[0]!.eventId, before.ledger.events[0]!.eventId);
  assert.equal(fresh.ledger.attempts.length, 1); assert.equal(fresh.ledger.attempts[0]!.outcome, 'received');
  assert.equal(fresh.inputs[0]!.text, newText);
  assert.deepEqual(old.ledger, before.ledger); assert.deepEqual(old.status, before.status);
  assert.equal(JSON.parse(JSON.parse(f.bodies[1]!).messages.at(-1).content).input, newText);
  await closeCli(reopened);
  assert.equal(f.bodies.length, 2);
});

test('session /window after a completed turn schedules a Core window before the next plain input sends', async t => {
  const f = await fixture(t, response => answer(response, 'Synthetic window answer.')), cli = await f.launch();
  const first = await sendCommand(cli, 'Synthetic first window question.', 'session-result');
  assert.equal(first.terminal, 'completed');
  const before = f.inspect(first.runId as string);
  const scheduled = await acknowledged(cli, '/window', 'session-window');
  assert.equal(scheduled.status, 'scheduled'); assert.equal(f.bodies.length, 1);
  const text = 'Synthetic question after the explicit window.';
  const next = await sendCommand(cli, text, 'session-result');
  assert.equal(next.terminal, 'completed'); assert.notEqual(next.runId, first.runId);
  const after = f.inspect(next.runId as string);
  const window = after.status.windows.find(item => item.reason === 'explicit');
  assert.ok(window);
  assert.equal(after.ledger.assemblies[0]!.context!.windowId, window.windowId);
  assert.equal(after.inputs[0]!.text, text);
  assert.deepEqual(f.inspect(first.runId as string).ledger, before.ledger);
  assert.equal(f.bodies.length, 2);
  const queued = await acknowledged(cli, '/queue Synthetic held after completion.', 'session-input');
  assert.equal(f.inspect(queued.runId as string).inputs[0]!.mode, 'queue');
  assert.equal(f.inspect(queued.runId as string).inputs[0]!.state, 'received');
  await closeCli(cli);
  assert.equal(f.bodies.length, 2);
});

test('session maxModelAttempts:1 stops after a portable Core tool response without a second HTTP request', async t => {
  const f = await fixture(t, response => answer(response, '', true), { ...AGENT_BUDGET, maxModelAttempts: 1 });
  const cli = await f.launch();
  const result = await sendCommand(cli, 'Search for the synthetic recovery sentinel.', 'session-result');
  assert.equal(result.terminal, 'budget-exhausted');
  const state = f.inspect(result.runId as string);
  assert.equal(state.status.terminal, 'budget-exhausted'); assert.equal(state.status.attempts, 1);
  assert.equal(state.status.tools.length, 1);
  assert.equal(state.status.tools[0]!.name, 'memory.search');
  assert.ok(state.status.tools[0]!.result);
  assert.equal(state.ledger.attempts[0]!.outcome, 'received');
  assert.equal((result.ledger as RequestStatus).run.budget.maxModelAttempts, 1);
  await closeCli(cli);
  assert.equal(f.bodies.length, 1);
});
