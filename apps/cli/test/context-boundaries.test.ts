import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { AgentRun, DEFAULT_BUDGET, MemoryCorrections } from '@euler/core';
import { pumpAgent } from '../src/agent-pump.ts';
import { HttpModelTransport } from '../src/model-transport.ts';
import { bindingOf, createSandbox, createSandboxSession } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

const route = { provider: 'fake', model: 'bounded', route: 'fixture', authNamespace: 'synthetic' };
const budget = { ...DEFAULT_BUDGET, contextLimit: 20000, maxModelAttempts: 4, maxToolCalls: 4, maxTotalTokens: 100000 };
function toolTurn(run: AgentRun, id: string) {
  const request = run.nextModel()!;
  const attempt = run.startModel(request, request.payload);
  assert.equal(run.maySend(attempt.attemptId, request.payload), true);
  run.finishModel(attempt.attemptId, { text: '', stop: 'tools', calls: [{ id, name: 'controlled.echo', arguments: { text: id } }] });
  run.startTool(id); run.finishTool(id, id);
}

test('window rebuilding retains every admitted steering constraint in neutral and HTTP payloads', () => {
  const sandbox = createSandbox(), probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
  try {
    const run = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive }, route, budget);
    run.receive(randomUUID(), 'Complete the synthetic inspection.');
    toolTurn(run, 'one');
    run.receive(randomUUID(), 'Use JSON for the final answer.');
    run.receive(randomUUID(), 'Do not change any files.');
    toolTurn(run, 'two'); toolTurn(run, 'three');
    run.newWindow();
    const request = run.nextModel()!;
    assert.match(request.payload, /Use JSON for the final answer/);
    assert.match(request.payload, /Do not change any files/);
    const transport = new HttpModelTransport({ api: 'openai-completions', provider: route.provider, id: route.model,
      name: route.model, baseUrl: 'http://127.0.0.1:1/v1', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: budget.contextLimit, maxTokens: budget.outputReserve }, budget, () => 'synthetic');
    const neutral = JSON.parse(request.payload); neutral.route = 'http://127.0.0.1:1/v1';
    const encoded = transport.encode(neutral);
    assert.match(encoded, /Use JSON for the final answer/); assert.match(encoded, /Do not change any files/);
    run.cancel();
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('a newly settled memory operation between admission and send invalidates the old snapshot without sending', () => {
  const sandbox = createSandbox(), probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
  try {
    const record = probe.store.rememberMemory(probe.activity, { input: probe.archive.append(randomUUID(), '记住偏好：Atlas uses npm'), hostInfo: 'durable' }).record;
    const run = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive }, route, budget);
    run.receive(randomUUID(), 'Inspect the current synthetic preference.');
    const request = run.nextModel()!, attempt = run.startModel(request, request.payload);
    const corrections = new MemoryCorrections(probe.store, probe.activity, probe.archive);
    const preview = corrections.handle(corrections.receive(`correct ${record.recordId} "Another value"`));
    assert.equal(preview.kind, 'preview');
    if (preview.kind !== 'preview') throw new Error('preview missing');
    corrections.presented(preview.presentation);
    corrections.handle(corrections.receive(`cancel ${preview.presentation.token}`));
    probe.store.acknowledgeCorrectionOwner(probe.activity, preview.presentation.token);
    const delivery = probe.store.correctionDelivery(probe.activity, preview.presentation.token);
    probe.store.acknowledgeCorrectionModel(probe.activity, preview.presentation.token,
      probe.archive.append(delivery.summaryEventId, JSON.stringify(probe.store.correctionSummary(probe.activity, preview.presentation.token)), 'tool'));
    assert.throws(() => run.maySend(attempt.attemptId, request.payload), /operation-summary-stale/);
    assert.equal(run.status().cacheEpoch, null);
    run.cancel();
    assert.equal(probe.store.requestStatus(probe.activity, run.runId).attempts[0]!.outcome, 'cancelled-before-send');
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('lost archived bytes prevent unloading and repairing the same bytes permits a subsequent window', () => {
  const sandbox = createSandbox(), probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
  const path = join(sandbox.root, 'session.jsonl');
  try {
    const run = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive }, route, budget);
    run.receive(randomUUID(), 'Preserve exact synthetic evidence.');
    toolTurn(run, 'one'); toolTurn(run, 'two');
    const archived = readFileSync(path);
    writeFileSync(path, archived.toString('utf8').split('\n')[0]! + '\n');
    try {
      assert.throws(() => run.newWindow(), /source-evidence-gap/);
      assert.equal(run.status().windows.length, 1);
    } finally { writeFileSync(path, archived); }
    run.newWindow();
    assert.equal(run.status().windows.length, 2);
    assert.ok(run.nextModel());
    run.cancel();
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('fresh windows cannot reset the cumulative model budget or accept a late cancelled reply', async () => {
  const sandbox = createSandbox(), limits = { ...budget, maxModelAttempts: 2 };
  const probe = openProbe(sandbox, limits, undefined, undefined, undefined, true);
  try {
    const run = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive }, route, limits);
    run.receive(randomUUID(), 'Two attempts at most.');
    toolTurn(run, 'one'); run.newWindow(); toolTurn(run, 'two');
    assert.equal(run.nextModel(), null);
    assert.equal(run.status().terminal, 'budget-exhausted');
    assert.equal(run.status().attempts, 2);
    const continued = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive }, route, limits);
    continued.receive(randomUUID(), 'Explicitly authorized new run.');
    const pending = Promise.withResolvers<{ text: string; calls: []; stop: 'end' }>();
    const pumping = pumpAgent(continued, { async *stream(request, _signal, send) {
      send(request.payload); continued.cancel(); yield { kind: 'complete', reply: await pending.promise };
    }, async execute() { throw new Error('unexpected'); } });
    assert.equal((await pumping).terminal, 'cancelled');
    const count = probe.archive.inspect().eventCount;
    pending.resolve({ text: 'late', calls: [], stop: 'end' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(probe.archive.inspect().eventCount, count);
    assert.equal(continued.nextModel(), null);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('revoked discovery invalidates an already prepared epoch and a new local run does not inherit it', () => {
  const sandbox = createSandbox();
  const other = { ...bindingOf(sandbox), projectId: randomUUID(), sessionId: randomUUID() };
  createSandboxSession(sandbox, other);
  const probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
  try {
    const source = probe.archive.append(randomUUID(), 'Read the approved synthetic project.');
    const intent = probe.store.transitionIntent(probe.activity, null, source, { status: 'active', step: 'analysis' }, 'Read the approved synthetic project.');
    const decision = probe.archive.append(randomUUID(), JSON.stringify({ schema: 'memory-discovery-approval@1',
      intentId: intent.intentId, goalEventId: source.eventId, projectIds: [other.projectId], targets: {}, maxResults: 8, maxBytes: 32000 }));
    const grant = probe.store.authorizeMemoryDiscovery(probe.activity, decision, [other.projectId], 8, {}, 32000);
    const run = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive, discoveryGrantId: grant.grantId }, route, budget);
    run.receive(source.eventId, 'Read the approved synthetic project.');
    const prepared = run.nextModel()!;
    probe.store.revokeMemoryDiscovery(probe.activity, grant.grantId);
    assert.throws(() => run.startModel(prepared, prepared.payload), /discovery-not-authorized/);
    assert.equal(run.status().cacheEpoch, null);
    assert.equal(probe.store.requestStatus(probe.activity, run.runId).attempts.length, 0);
    run.cancel();
    const local = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive }, route, budget);
    local.receive(randomUUID(), 'Continue locally with new authorization.');
    assert.ok(local.nextModel()); local.cancel();
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('an unavailable source is a paired tool failure and the model can finish normally afterwards', async () => {
  const sandbox = createSandbox(), probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
  try {
    const run = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive }, route, budget);
    run.receive(randomUUID(), 'Inspect a missing synthetic reference and report the gap.');
    let requests = 0;
    const status = await pumpAgent(run, { async *stream(request, _signal, send) {
      send(request.payload); requests++;
      if (requests === 1) yield { kind: 'complete', reply: { text: '', stop: 'tools', calls: [{ id: 'missing', name: 'source.expand',
        arguments: { eventId: randomUUID(), offset: 0, limit: 32 } }] } };
      else {
        const result = JSON.parse(request.payload).p2.at(-1).results[0];
        assert.equal(result.outcome, 'failure');
        assert.deepEqual(JSON.parse(result.modelResult), { status: 'unavailable', reason: 'source-evidence-gap' });
        yield { kind: 'complete', reply: { text: 'Source unavailable; no unsupported conclusion.', stop: 'end', calls: [] } };
      }
    }, async execute() { throw new Error('Core source tools must not call Host effects'); } });
    assert.equal(status.terminal, 'completed'); assert.equal(requests, 2);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('a forgotten memory result cannot be resent as historical active content after a window change', () => {
  const sandbox = createSandbox(), probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
  try {
    const record = probe.store.rememberMemory(probe.activity, { input: probe.archive.append(randomUUID(), '记住偏好：Atlas uses npm'), hostInfo: 'durable' }).record;
    probe.store.drainSearchProjection(probe.activity);
    const run = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive }, route, budget);
    run.receive(randomUUID(), 'Inspect Atlas preferences.');
    const request = run.nextModel()!, attempt = run.startModel(request, request.payload);
    run.maySend(attempt.attemptId, request.payload);
    run.finishModel(attempt.attemptId, { text: '', stop: 'tools', calls: [{ id: 'memory', name: 'memory.search', arguments: { query: 'Atlas' } }] });
    run.startTool('memory');
    const result = run.coreToolResult('memory')!;
    assert.equal(result.outcome, 'success'); run.finishTool('memory', result.modelResult);
    probe.store.forgetMemory(probe.activity, record.recordId, record);
    run.newWindow();
    assert.throws(() => run.nextModel(), /memory-stale/);
    assert.equal(probe.store.requestStatus(probe.activity, run.runId).attempts.length, 1);
    run.cancel();
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
