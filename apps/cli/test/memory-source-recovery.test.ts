import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { AgentRun, API_VERSION, DEFAULT_BUDGET } from '@euler/core';
import { pumpAgent } from '../src/agent-pump.ts';
import { bindingOf, createSandbox, createSandboxSession, createSessionSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

const route = { provider: 'fake', model: 'source-recovery', route: 'fixture', authNamespace: 'synthetic' };
const budget = { ...DEFAULT_BUDGET, contextLimit: 24000, maxTotalTokens: 96000, maxModelAttempts: 3, maxToolCalls: 4 };

function fixture(mode: 'same' | 'bound-grant' | 'unbound-grant' = 'same', sourcePadding = '') {
  const sandbox = mode === 'unbound-grant' ? createSessionSandbox(randomUUID(), randomUUID()) : createSandbox();
  const binding = bindingOf(sandbox);
  const history = { ...binding, projectId: mode === 'same' ? binding.projectId! : randomUUID(), sessionId: randomUUID(), branchId: randomUUID() };
  createSandboxSession(sandbox, history);
  const writer = openProbe(sandbox, budget, undefined, history, undefined, true);
  const text = 'Original decision: the archive window opens at 07:45. 原文标识：松林。' + sourcePadding;
  const source = writer.archive.append(randomUUID(), text, 'user');
  const candidate = writer.store.captureMemory(writer.activity, source, 'The archive window has a previously agreed opening time.',
    { type: 'fact', scope: { kind: 'project', id: history.projectId, resolved: true }, appliesTo: [] }).record;
  const verified = writer.store.verifyMemory(writer.activity, candidate.recordId, candidate, 'pass', [source]).record;
  const record = writer.store.activateMemory(writer.activity, verified.recordId, verified).record;
  writer.store.drainSearchProjection(writer.activity);
  writer.close();
  const probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
  return { sandbox, binding, history, probe, record, text, source,
    close() { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); } };
}

test('a model recovers an unpublished memory source from another session in the same project', async () => {
  const f = fixture();
  try {
    const run = new AgentRun(f.probe.store, f.probe.activity, { binding: f.binding, source: f.probe.archive }, route, budget);
    run.receive(randomUUID(), 'Recover the exact original archive-window decision.');
    let requests = 0;
    let recovered: ReturnType<typeof f.probe.store.retrieveMemorySource> | undefined;
    const result = await pumpAgent(run, {
      async *stream(request, _signal, send) {
        send(request.payload);
        if (++requests === 1) yield { kind: 'complete', reply: { text: '', stop: 'tools', calls: [
          { id: 'recover', name: 'source.expand', arguments: { recordId: f.record.recordId, offset: 0, limit: 4096 } },
        ] } };
        else {
          recovered = JSON.parse(JSON.parse(request.payload).p2.at(-1).results[0].modelResult);
          yield { kind: 'complete', reply: { text: 'The original states 07:45.', calls: [], stop: 'end' } };
        }
      },
      async execute() { throw new Error('unexpected-host-tool'); },
    });
    assert.equal(result.terminal, 'completed');
    assert.equal(requests, 2);
    assert.equal(recovered?.text, f.text);
    assert.deepEqual(recovered?.ref, f.source);
    assert.equal(recovered?.truncated, false);
    assert.equal(recovered?.record.headEventId, f.record.headEventId);
    const assembly = f.probe.store.requestStatus(f.probe.activity, run.runId).assemblies.at(-1)!;
    assert.deepEqual(assembly.usedMemories.map(use => use.recordId), [f.record.recordId]);
  } finally { f.close(); }
});

for (const mode of ['bound-grant', 'unbound-grant'] as const)
test(`only the current task grant permits cross-project memory provenance recovery (${mode})`, async () => {
  const f = fixture(mode);
  try {
    const request = { recordId: f.record.recordId, offset: 0, limit: 4096 };
    assert.throws(() => f.probe.store.retrieveMemorySource(f.probe.activity, request), /scope|project/);
    const goal = f.probe.archive.append(randomUUID(), 'Check the approved historical project evidence.');
    const intent = f.probe.store.transitionIntent(f.probe.activity, null, goal, { status: 'active', step: 'analysis' }, 'Check the approved historical project evidence.');
    const consent = f.probe.archive.append(randomUUID(), JSON.stringify({ schema: 'memory-discovery-approval@1', intentId: intent.intentId,
      goalEventId: goal.eventId, projectIds: [f.history.projectId], targets: {}, maxResults: 2, maxBytes: 64000 }));
    const { grantId } = f.probe.store.authorizeMemoryDiscovery(f.probe.activity, consent, [f.history.projectId], 2, {}, 64000);
    const run = new AgentRun(f.probe.store, f.probe.activity,
      { binding: f.binding, source: f.probe.archive, discoveryGrantId: grantId }, route, budget);
    run.receive(randomUUID(), 'Recover this approved original.');
    let requests = 0, text: string | undefined;
    await pumpAgent(run, {
      async *stream(payload, _signal, send) {
        send(payload.payload);
        if (++requests === 2) text = JSON.parse(JSON.parse(payload.payload).p2.at(-1).results[0].modelResult).text;
        yield { kind: 'complete', reply: requests === 1 ? { text: '', stop: 'tools', calls: [
          { id: 'recover', name: 'source.expand', arguments: request },
        ] } : { text: 'The original has been recovered.', calls: [], stop: 'end' } };
      },
      async execute() { throw new Error('unexpected-host-tool'); },
    });
    assert.equal(run.status().terminal, 'completed');
    assert.equal(text, f.text);
    // Freezing and sending the same recovered snapshot do not consume another read.
    assert.equal(f.probe.store.retrieveMemorySource(f.probe.activity, { ...request, grantId }).text, f.text);
    assert.throws(() => f.probe.store.retrieveMemorySource(f.probe.activity, { ...request, grantId }), /discovery-budget-exhausted/);
    f.probe.store.revokeMemoryDiscovery(f.probe.activity, grantId);
    assert.throws(() => f.probe.store.retrieveMemorySource(f.probe.activity, { ...request, grantId }), /discovery-not-authorized/);
  } finally { f.close(); }
});

test('a recovered memory source is refused at durable dispatch after forget while owner history stays readable', () => {
  const f = fixture();
  try {
    const run = new AgentRun(f.probe.store, f.probe.activity, { binding: f.binding, source: f.probe.archive }, route, budget);
    run.receive(randomUUID(), 'Recover the original archive-window decision.');
    const first = run.nextModel()!, attempt = run.startModel(first, first.payload);
    assert.equal(run.maySend(attempt.attemptId, first.payload), true);
    run.finishModel(attempt.attemptId, { text: '', stop: 'tools', calls: [
      { id: 'recover', name: 'source.expand', arguments: { recordId: f.record.recordId, offset: 0, limit: 4096 } },
    ] });
    assert.ok(run.startTool('recover'));
    const result = run.coreToolResult('recover')!;
    assert.equal(result.outcome, 'success');
    run.finishTool('recover', result.modelResult, result.outcome);
    const frozen = run.nextModel()!;
    f.probe.store.forgetMemory(f.probe.activity, f.record.recordId, f.record);
    assert.throws(() => f.probe.store.startRequestAttempt(f.probe.activity, { runId: run.runId,
      assemblyId: frozen.assemblyId, payloadHash: frozen.payloadHash, byteLength: Buffer.byteLength(frozen.payload), adapterVersion: API_VERSION }), /memory-stale/);
    assert.equal(f.probe.store.requestStatus(f.probe.activity, run.runId).attempts.length, 1);
    assert.throws(() => f.probe.store.retrieveMemorySource(f.probe.activity,
      { recordId: f.record.recordId, offset: 0, limit: 4096 }), /memory-stale/);
    assert.equal(f.probe.store.expandSource(f.probe.activity,
      { recordId: f.record.recordId, offset: 0, limit: 4096 }).text, f.text);
    run.cancel();
  } finally { f.close(); }
});

test('an actual memory search prefetches its exact provenance into the current tail without changing the tool history', async () => {
  const f = fixture();
  try {
    const run = new AgentRun(f.probe.store, f.probe.activity, { binding: f.binding, source: f.probe.archive }, route, budget);
    run.receive(randomUUID(), 'Find the earlier archive-window decision and its exact original.');
    const payloads: string[] = [];
    await pumpAgent(run, {
      async *stream(request, _signal, send) {
        send(request.payload); payloads.push(request.payload);
        yield { kind: 'complete', reply: payloads.length === 1 ? { text: '', stop: 'tools', calls: [
          { id: 'search', name: 'memory.search', arguments: { query: 'archive' } },
        ] } : { text: 'The original states 07:45.', calls: [], stop: 'end' } };
      },
      async execute() { throw new Error('unexpected-host-tool'); },
    });
    assert.equal(run.status().terminal, 'completed');
    assert.equal(payloads.length, 2);
    assert.equal(payloads[0]!.includes(f.text), false);
    assert.equal(payloads[0]!.includes(f.record.content), false);
    const next = JSON.parse(payloads[1]!);
    assert.equal(next.p3.sourceRecovery?.[0].status, 'ready');
    assert.equal(next.p3.sourceRecovery[0].recordId, f.record.recordId);
    assert.equal(next.p3.sourceRecovery[0].excerpt.text, f.text);
    const tool = run.status().tools[0]!.result!;
    const archived = JSON.parse(f.probe.archive.read(tool.source).text);
    assert.equal(next.p2.at(-1).results[0].modelResult, archived.modelResult);
    assert.deepEqual(archived.sourceRecovery, next.p3.sourceRecovery);
    assert.equal(archived.modelResult.includes(f.text), false);
  } finally { f.close(); }
});

test('optional source prefetch yields its tail space so an otherwise fitting memory tool round can finish', async () => {
  const f = fixture('same', ' details'.repeat(1000));
  try {
    const tight = { ...budget, contextLimit: 12000 };
    const run = new AgentRun(f.probe.store, f.probe.activity, { binding: f.binding, source: f.probe.archive }, route, tight);
    run.receive(randomUUID(), 'Recall the archive decision. ' + 'Current detail. '.repeat(100));
    const payloads: string[] = [];
    await pumpAgent(run, {
      async *stream(request, _signal, send) {
        send(request.payload); payloads.push(request.payload);
        yield { kind: 'complete', reply: payloads.length === 1 ? { text: '', stop: 'tools', calls: [
          { id: 'search', name: 'memory.search', arguments: { query: 'archive' } },
        ] } : { text: 'The remembered decision is available; full source can be paged separately.', calls: [], stop: 'end' } };
      },
      async execute() { throw new Error('unexpected-host-tool'); },
    });
    assert.equal(run.status().terminal, 'completed');
    assert.equal(payloads.length, 2);
    const next = JSON.parse(payloads[1]!);
    assert.equal(JSON.parse(next.p2.at(-1).results[0].modelResult).results[0].record.recordId, f.record.recordId);
    assert.equal(next.p3.sourceRecovery?.[0].reason, 'source-recovery-context-budget');
    assert.ok(Buffer.byteLength(payloads[1]!) + tight.outputReserve + tight.safetyMargin <= tight.contextLimit);
  } finally { f.close(); }
});

test('prefetched provenance remains frozen through a later tool batch in the same ReAct turn', async () => {
  const f = fixture();
  try {
    const run = new AgentRun(f.probe.store, f.probe.activity, { binding: f.binding, source: f.probe.archive }, route, budget);
    run.receive(randomUUID(), 'Recover the archive decision, then perform the follow-up echo.');
    const payloads: string[] = [];
    await pumpAgent(run, {
      async *stream(request, _signal, send) {
        send(request.payload); payloads.push(request.payload);
        const calls = payloads.length === 1 ? [{ id: 'search', name: 'memory.search', arguments: { query: 'archive' } }]
          : payloads.length === 2 ? [{ id: 'echo', name: 'controlled.echo', arguments: { text: 'follow-up' } }] : [];
        yield { kind: 'complete', reply: { text: calls.length ? '' : 'The original states 07:45.', calls, stop: calls.length ? 'tools' : 'end' } };
      },
      async execute(call) { assert.equal(call.name, 'controlled.echo'); return 'follow-up complete'; },
    });
    assert.equal(run.status().terminal, 'completed');
    assert.equal(payloads.length, 3);
    const second = JSON.parse(payloads[1]!), third = JSON.parse(payloads[2]!);
    assert.equal(second.p3.sourceRecovery[0].excerpt.text, f.text);
    assert.deepEqual(third.p3.sourceRecovery, second.p3.sourceRecovery);
    assert.equal(third.p2[0].results[0].modelResult, second.p2[0].results[0].modelResult);
  } finally { f.close(); }
});
