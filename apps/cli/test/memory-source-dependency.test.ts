import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { AgentRun, API_VERSION, DEFAULT_BUDGET, requireProject } from '@euler/core';
import { openProbe } from '../src/probe.ts';
import { bindingOf, createSandbox } from '../src/sandbox.ts';

const budget = { ...DEFAULT_BUDGET, contextLimit: 24000, maxTotalTokens: 96000, maxModelAttempts: 3, maxToolCalls: 4 };
const route = { provider: 'fake', model: 'source-dependency', route: 'fixture', authNamespace: 'synthetic' };

for (const mode of ['active', 'revoked', 'orphaned', 'event-copy', 'search-copy'] as const)
test(`memory provenance retains its original output grant at dispatch (${mode})`, () => {
  const sandbox = createSandbox(), binding = bindingOf(sandbox);
  const probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
  let reader: AgentRun | undefined;
  try {
    const goalText = 'Analyze the approved local archive evidence.';
    const goal = probe.archive.append(randomUUID(), goalText);
    const intent = probe.store.transitionIntent(probe.activity, null, goal, { status: 'active', step: 'analysis' }, goalText);
    const projectIds = [requireProject(binding)];
    const consent = probe.archive.append(randomUUID(), JSON.stringify({ schema: 'memory-discovery-approval@1',
      intentId: intent.intentId, goalEventId: goal.eventId, projectIds, targets: {}, maxResults: 8, maxBytes: 131072 }));
    const { grantId } = probe.store.authorizeMemoryDiscovery(probe.activity, consent, projectIds, 8);
    const writer = new AgentRun(probe.store, probe.activity,
      { binding, source: probe.archive, discoveryGrantId: grantId }, route, budget);
    writer.receive(randomUUID(), 'Record the approved original archive decision.');
    const first = writer.nextModel()!;
    const firstAttempt = writer.startModel(first, first.payload);
    assert.equal(writer.maySend(firstAttempt.attemptId, first.payload), true);
    const canary = `SOURCE_DEPENDENCY_${randomUUID()}`;
    writer.finishModel(firstAttempt.attemptId, { text: `${canary}: the archive opens at 07:45.`, calls: [], stop: 'end' });
    assert.equal(writer.status().terminal, 'completed');
    const source = writer.status().responses[0]!.source;
    const original = probe.archive.read(source).text;
    assert.ok(original.includes(canary));
    assert.ok(probe.store.requestStatus(probe.activity, writer.runId).events.some(event => {
      if (event.kind !== 'agent/event@v1') return false;
      const item = JSON.parse(event.payload).event;
      return item.kind === 'source-access' && item.sourceEventId === source.eventId && item.discoveryGrantId === grantId;
    }));
    const candidate = probe.store.captureMemory(probe.activity, source, 'The archive has an approved opening decision.',
      { type: 'fact', scope: { kind: 'project', id: requireProject(binding), resolved: true }, appliesTo: [] }).record;
    const verified = probe.store.verifyMemory(probe.activity, candidate.recordId, candidate, 'pass', [source]).record;
    const record = probe.store.activateMemory(probe.activity, verified.recordId, verified).record;

    let orphan: ReturnType<typeof probe.archive.append> | undefined;
    const readerSource = mode === 'orphaned' ? {
      lookup: probe.archive.lookup.bind(probe.archive), read: probe.archive.read.bind(probe.archive),
      expand: probe.archive.expand.bind(probe.archive), events: probe.archive.events.bind(probe.archive),
      append(eventId: string, text: string, role: 'user' | 'assistant' | 'tool' = 'user') {
        const ref = probe.archive.append(eventId, text, role);
        if (role === 'tool' && !orphan) { orphan = ref; throw new Error('synthetic-lost-ack'); }
        return ref;
      },
    } : probe.archive;
    reader = new AgentRun(probe.store, probe.activity, { binding, source: readerSource }, route, budget);
    reader.receive(randomUUID(), 'Recover the exact prior archive decision.');
    const request = reader.nextModel()!;
    const attempt = reader.startModel(request, request.payload);
    assert.equal(reader.maySend(attempt.attemptId, request.payload), true);
    reader.finishModel(attempt.attemptId, { text: '', stop: 'tools', calls: [
      { id: 'recover', name: 'source.expand', arguments: { recordId: record.recordId, offset: 0, limit: 4096 } },
    ] });
    assert.ok(reader.startTool('recover'));
    const recovered = reader.coreToolResult('recover')!;
    assert.equal(recovered.outcome, 'success');
    assert.equal(JSON.parse(recovered.modelResult).text, original);
    if (mode === 'orphaned') {
      assert.throws(() => reader!.finishTool('recover', recovered.modelResult, recovered.outcome), /synthetic-lost-ack/);
      assert.ok(orphan);
      probe.store.revokeMemoryDiscovery(probe.activity, grantId);
      assert.throws(() => probe.store.expandSource(probe.activity, { ref: orphan!, offset: 0, limit: 4096 }), /discovery-not-authorized/);
      return;
    }
    reader.finishTool('recover', recovered.modelResult, recovered.outcome);
    const frozen = reader.nextModel()!;
    assert.ok(frozen.payload.includes(canary));
    const ledger = probe.store.requestStatus(probe.activity, reader.runId);
    assert.deepEqual(ledger.assemblies.at(-1)!.usedMemories.map(use => use.recordId), [record.recordId]);
    assert.equal(ledger.assemblies.at(-1)!.context?.discoveryGrantId, undefined);

    if (mode === 'revoked') {
      probe.store.revokeMemoryDiscovery(probe.activity, grantId);
      assert.equal(probe.store.requestStatus(probe.activity, reader.runId).run.state, 'authorized');
      assert.throws(() => probe.store.retrieveMemorySource(probe.activity,
        { recordId: record.recordId, offset: 0, limit: 4096 }), /discovery-not-authorized/);
      assert.throws(() => probe.store.startRequestAttempt(probe.activity, { runId: reader!.runId,
        assemblyId: frozen.assemblyId, payloadHash: frozen.payloadHash, byteLength: Buffer.byteLength(frozen.payload),
        adapterVersion: API_VERSION }), /discovery-not-authorized/);
      assert.equal(probe.store.requestStatus(probe.activity, reader.runId).attempts.length, 1);
      const copied = reader.status().tools[0]!.result!.source;
      assert.throws(() => probe.store.expandSource(probe.activity, { ref: copied, offset: 0, limit: 4096 }), /discovery-not-authorized/);
    } else {
      const send = reader.startModel(frozen, frozen.payload);
      assert.equal(reader.maySend(send.attemptId, frozen.payload), true);
      reader.finishModel(send.attemptId, { text: 'The original states 07:45.', calls: [], stop: 'end' });
      assert.equal(reader.status().terminal, 'completed');
      assert.equal(probe.store.requestStatus(probe.activity, reader.runId).attempts.at(-1)!.outcome, 'received');
      if (mode === 'event-copy' || mode === 'search-copy') {
        const firstCopy = reader.status().tools[0]!.result!.source;
        reader = new AgentRun(probe.store, probe.activity, { binding, source: probe.archive }, route, budget);
        reader.receive(randomUUID(), 'Check the recovered source again.');
        const input = reader.nextModel()!, sent = reader.startModel(input, input.payload);
        assert.equal(reader.maySend(sent.attemptId, input.payload), true);
        const call = mode === 'event-copy'
          ? { id: 'copy', name: 'source.expand', arguments: { eventId: firstCopy.eventId, offset: 0, limit: 4096 } }
          : { id: 'copy', name: 'source.search', arguments: { query: canary } };
        reader.finishModel(sent.attemptId, { text: '', stop: 'tools', calls: [call] });
        assert.ok(reader.startTool('copy'));
        const copied = reader.coreToolResult('copy')!;
        assert.equal(copied.outcome, 'success');
        reader.finishTool('copy', copied.modelResult, copied.outcome);
        const secondCopy = reader.status().tools[0]!.result!.source;
        assert.ok(probe.store.expandSource(probe.activity, { ref: secondCopy, offset: 0, limit: 4096 }).text.includes(canary));
        probe.store.revokeMemoryDiscovery(probe.activity, grantId);
        assert.throws(() => probe.store.expandSource(probe.activity, { ref: secondCopy, offset: 0, limit: 4096 }), /discovery-not-authorized/);
        assert.throws(() => reader!.nextModel(), /discovery-not-authorized/);
      }
    }
  } finally {
    if (mode !== 'orphaned') reader?.cancel();
    probe.close(); rmSync(sandbox.root, { recursive: true, force: true });
  }
});
