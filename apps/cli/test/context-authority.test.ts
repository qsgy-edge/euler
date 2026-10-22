import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { AgentRun, API_VERSION, DEFAULT_BUDGET } from '@euler/core';
import type { AgentHost, SourceAck } from '@euler/core';
import { pumpAgent } from '../src/agent-pump.ts';
import { bindingOf, createSandbox, createSandboxSession } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';
import { approvedSourceUnit } from './support/source-publication.ts';

const route = { provider: 'fake', model: 'authority', route: 'fixture', authNamespace: 'synthetic' };
const budget = { ...DEFAULT_BUDGET, contextLimit: 24000, maxModelAttempts: 6, maxToolCalls: 6, maxTotalTokens: 200000 };
function fixture() {
  const sandbox = createSandbox();
  const foreignBinding = { ...bindingOf(sandbox), projectId: randomUUID(), sessionId: randomUUID() };
  createSandboxSession(sandbox, foreignBinding);
  const foreign = openProbe(sandbox, budget, undefined, foreignBinding, undefined, true);
  const probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
  const text = 'PRIVATE-T18-NEEDLE: synthetic cross-project evidence.';
  const source = foreign.archive.append(randomUUID(), text);
  const unit = foreign.store.publishSourceUnit(foreign.activity, approvedSourceUnit(foreign, {
    ref: source, projectId: foreignBinding.projectId, kind: 'source', offset: 0, length: text.length }));
  foreign.store.drainSourceProjection(foreign.activity);
  const goal = probe.archive.append(randomUUID(), 'Analyze the explicitly approved synthetic project.');
  const intent = probe.store.transitionIntent(probe.activity, null, goal, { status: 'active', step: 'analysis' }, 'Analyze the explicitly approved synthetic project.');
  const consent = probe.archive.append(randomUUID(), JSON.stringify({ schema: 'memory-discovery-approval@1', intentId: intent.intentId,
    goalEventId: goal.eventId, projectIds: [foreignBinding.projectId], targets: {}, maxResults: 32, maxBytes: 64000 }));
  const { grantId } = probe.store.authorizeMemoryDiscovery(probe.activity, consent, [foreignBinding.projectId], 32, {}, 64000);
  const run = (source: AgentHost['source'] = probe.archive) => {
    const value = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source, discoveryGrantId: grantId }, route, budget);
    value.receive(randomUUID(), 'Read the approved evidence and retain its exact source.'); return value;
  };
  let closed = false;
  const closeProbe = () => { if (!closed) { probe.close(); closed = true; } };
  return { sandbox, foreign, probe, text, unit, goal, grantId, run, closeProbe,
    close() { closeProbe(); foreign.close(); rmSync(sandbox.root, { recursive: true, force: true }); } };
}

for (const end of ['revoke', 'task-completed', 'local-only'] as const)
test(`archived cross-project tool and assistant copies retain their access dependency across restart: ${end}`, async () => {
  const f = fixture();
  let reopened: ReturnType<typeof openProbe> | undefined;
  try {
    const run = f.run(); let requests = 0;
    await pumpAgent(run, { async *stream(request, _signal, send) {
      send(request.payload); requests++;
      yield { kind: 'complete', reply: requests === 1
        ? { text: '', stop: 'tools', calls: [{ id: 'read', name: 'source.expand', arguments: { unitId: f.unit.unitId, offset: 0, limit: 128 } }] }
        : { text: f.text, stop: 'end', calls: [] } };
    }, async execute() { throw new Error('unexpected Host tool'); } });
    assert.equal(run.status().terminal, 'completed');
    const refs = [run.status().tools[0]!.result!.source, run.status().responses.at(-1)!.source];
    assert.ok(refs.every(ref => f.probe.store.expandSource(f.probe.activity, { ref, offset: 0, limit: 4096 }).text.includes('PRIVATE-T18-NEEDLE')));
    if (end === 'revoke') f.probe.store.revokeMemoryDiscovery(f.probe.activity, f.grantId);
    else if (end === 'task-completed') {
      const intent = f.probe.store.readIntent(f.probe.activity)!;
      f.probe.store.transitionIntent(f.probe.activity, intent.eventId, f.probe.archive.append(randomUUID(), 'End analysis.'), { status: 'completed', step: 'done' });
    }
    f.closeProbe();
    reopened = openProbe(f.sandbox, budget, undefined, undefined, undefined, true);
    for (const ref of refs) {
      if (end !== 'local-only') assert.throws(() => reopened!.store.expandSource(reopened!.activity, { ref, offset: 0, limit: 4096 }), /discovery-not-authorized/);
      assert.throws(() => reopened!.store.assertSourceAccess(reopened!.activity, ref), /discovery-not-authorized/);
    }
    assert.equal(reopened.store.listCaptureJobs(reopened.activity).length, 0);
    assert.equal(reopened.store.expandSource(reopened.activity, { ref: f.goal, offset: 0, limit: 128 }).text, 'Analyze the explicitly approved synthetic project.');
    {
      const prior = reopened.store.recoverIntent(reopened.activity)!;
      const local = new AgentRun(reopened.store, reopened.activity, { binding: bindingOf(f.sandbox), source: reopened.archive }, route, budget);
      const nextGoal = 'LOCAL-RESUME-T18: start a new local task and report unavailable references.';
      const nextInput = local.receive(randomUUID(), nextGoal); let turn = 0;
      await pumpAgent(local, { async *stream(request, _signal, send) {
        send(request.payload); turn++;
        if (end === 'task-completed') assert.equal(JSON.parse(request.payload).p3.intent.goal, nextGoal);
        if (turn > 1) {
          const result = JSON.parse(request.payload).p2.at(-1).results[0];
          assert.equal(result.modelResult.includes(f.text), false);
          if (turn === 2 || turn === 5) {
            assert.equal(result.outcome, 'success');
            const page = JSON.parse(result.modelResult);
            assert.ok(page.coverage.unauthorized > 0);
            assert.ok(page.results.every((hit: { eventId: string }) => refs.every(ref => ref.eventId !== hit.eventId)));
            if (turn === 5) assert.ok(page.results.some((hit: { role: string; preview: string }) => hit.role === 'user' && hit.preview.includes('LOCAL-RESUME-T18')));
          } else assert.equal(result.outcome, 'failure');
        }
        const call = turn === 1 ? { id: 'search', name: 'source.search', arguments: { query: 'PRIVATE-T18-NEEDLE', scope: 'session' } }
          : turn <= 3 ? { id: `expand-${turn}`, name: 'source.expand', arguments: { eventId: refs[turn - 2]!.eventId, offset: 0, limit: 4096 } }
          : turn === 4 ? { id: 'local-search', name: 'source.search', arguments: { query: 'LOCAL-RESUME-T18 PRIVATE-T18-NEEDLE', scope: 'session' } } : null;
        yield { kind: 'complete', reply: call ? { text: '', calls: [call], stop: 'tools' } : { text: 'References unavailable.', calls: [], stop: 'end' } };
      }, async execute() { throw new Error('unexpected Host tool'); } });
      assert.equal(local.status().terminal, 'completed');
      assert.equal(turn, 5);
      const current = reopened.store.recoverIntent(reopened.activity)!;
      if (end === 'task-completed') {
        assert.notEqual(current.intentId, prior.intentId);
        assert.equal(current.goal, nextGoal); assert.deepEqual(current.goalInput, nextInput);
        assert.equal(current.version, prior.version + 1);
        assert.throws(() => reopened!.store.assertMemoryDiscovery(reopened!.activity, f.grantId), /discovery-not-authorized/);
      } else assert.equal(current.intentId, prior.intentId);
      reopened.close(); reopened = openProbe(f.sandbox, budget, undefined, undefined, undefined, true);
      assert.deepEqual(reopened.store.recoverIntent(reopened.activity), current);
    }
  } finally { reopened?.close(); f.close(); }
});

test('a cross-project memory stays reference-only while its exact revision is admitted and recorded', async () => {
  const f = fixture();
  try {
    const record = f.foreign.store.rememberMemory(f.foreign.activity, {
      input: f.foreign.archive.append(randomUUID(), '记住偏好：FOREIGN-T18-MEMORY uses npm'), hostInfo: 'durable' }).record;
    f.foreign.store.drainSearchProjection(f.foreign.activity);
    const run = f.run(); let requests = 0;
    await pumpAgent(run, { async *stream(request, _signal, send) {
      send(request.payload); requests++;
      if (requests === 2) {
        const hit = JSON.parse(JSON.parse(request.payload).p2.at(-1).results[0].modelResult).results[0];
        assert.equal(hit.record.recordId, record.recordId); assert.equal(hit.exposureMode, 'reference_only');
        const assembly = f.probe.store.requestStatus(f.probe.activity, run.runId).assemblies.at(-1)!;
        assert.deepEqual(assembly.usedMemories, [{ recordId: record.recordId, revisionId: record.revisionId,
          headEventId: record.headEventId, hash: record.hash, contentHash: record.contentHash, reason: 'retrieved-memory' }]);
      }
      yield { kind: 'complete', reply: requests === 1 ? { text: '', stop: 'tools', calls: [
        { id: 'memory', name: 'memory.search', arguments: { query: 'FOREIGN-T18-MEMORY' } },
      ] } : { text: 'Current target applicability needs verification.', stop: 'end', calls: [] } };
    }, async execute() { throw new Error('unexpected Host tool'); } });
    assert.equal(run.status().terminal, 'completed'); assert.equal(requests, 2);
    assert.equal(f.foreign.store.readMemory(f.foreign.activity, record.recordId).hash, record.hash);
  } finally { f.close(); }
});

test('revocation from another Store invalidates the frozen epoch and the Store admission transaction rejects it', () => {
  const f = fixture();
  const revoker = openProbe(f.sandbox, budget, undefined, undefined, undefined, true);
  try {
    const run = f.run(); const request = run.nextModel()!;
    revoker.store.revokeMemoryDiscovery(revoker.activity, f.grantId);
    assert.equal(run.status().cacheEpoch, null);
    assert.throws(() => f.probe.store.startRequestAttempt(f.probe.activity, { runId: run.runId, assemblyId: request.assemblyId,
      payloadHash: request.payloadHash, byteLength: Buffer.byteLength(request.payload), adapterVersion: API_VERSION }), /run-not-admissible|cache-epoch-stale|discovery-not-authorized/);
    assert.equal(f.probe.store.requestStatus(f.probe.activity, run.runId).attempts.length, 0);
    run.cancel();
  } finally { revoker.close(); f.close(); }
});

test('an output appended before a lost acknowledgement is protected even without a tool-result event', async () => {
  const f = fixture(); let orphan: SourceAck | undefined;
  try {
    const archive = f.probe.archive;
    const source: AgentHost['source'] = { lookup: archive.lookup.bind(archive), read: archive.read.bind(archive), expand: archive.expand.bind(archive),
      append(eventId: string, text: string, role: 'user' | 'assistant' | 'tool' = 'user') {
        const ref = archive.append(eventId, text, role);
        if (role === 'tool' && !orphan) { orphan = ref; throw new Error('synthetic-lost-ack'); }
        return ref;
      } };
    const run = f.run(source);
    await pumpAgent(run, { async *stream(request, _signal, send) {
      send(request.payload); yield { kind: 'complete', reply: { text: '', stop: 'tools', calls: [
        { id: 'read', name: 'source.expand', arguments: { unitId: f.unit.unitId, offset: 0, limit: 128 } },
      ] } };
    }, async execute() { throw new Error('unexpected Host tool'); } });
    assert.equal(run.status().terminal, 'blocked-unknown'); assert.ok(orphan);
    f.probe.store.revokeMemoryDiscovery(f.probe.activity, f.grantId);
    assert.throws(() => f.probe.store.expandSource(f.probe.activity, { ref: orphan!, offset: 0, limit: 4096 }), /discovery-not-authorized/);
  } finally { f.close(); }
});
