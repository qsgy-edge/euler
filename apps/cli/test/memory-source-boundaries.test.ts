import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { AgentRun, DEFAULT_BUDGET } from '@euler/core';
import { pumpAgent } from '../src/agent-pump.ts';
import { bindingOf, createSandbox, createSandboxSession } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

const budget = { ...DEFAULT_BUDGET, contextLimit: 24000, maxTotalTokens: 96000, maxModelAttempts: 3, maxToolCalls: 4 };

function authorize(probe: ReturnType<typeof openProbe>, projectIds: string[],
  targets: Record<string, { agent: string; platform: string }>, maxResults: number) {
  const goal = 'Analyze the approved project evidence.';
  const input = probe.archive.append(randomUUID(), goal);
  const intent = probe.store.transitionIntent(probe.activity, null, input, { status: 'active', step: 'analysis' }, goal);
  const consent = probe.archive.append(randomUUID(), JSON.stringify({ schema: 'memory-discovery-approval@1',
    intentId: intent.intentId, goalEventId: input.eventId, projectIds, targets, maxResults, maxBytes: 131072 }));
  return probe.store.authorizeMemoryDiscovery(probe.activity, consent, projectIds, maxResults, targets).grantId;
}

test('an applicable nonmember target cannot authorize an inapplicable workspace memory source', () => {
  const sandbox = createSandbox();
  const binding = bindingOf(sandbox);
  const nonmember = { ...binding, projectId: randomUUID(), sessionId: randomUUID(), branchId: randomUUID() };
  createSandboxSession(sandbox, nonmember);
  const probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
  try {
    const workspaceId = randomUUID();
    probe.store.bindWorkspace(probe.activity, workspaceId, [sandbox.fixture.projectId]);
    const requiredPlatform = process.platform === 'linux' ? 'win32' : 'linux';
    const source = probe.archive.append(randomUUID(), 'The workspace socket requires its approved target platform.');
    const captured = probe.store.captureMemory(probe.activity, source, 'Workspace socket platform decision', {
      type: 'fact', scope: { kind: 'workspace', id: workspaceId, resolved: true }, appliesTo: [`platform:${requiredPlatform}`],
    }).record;
    const verified = probe.store.verifyMemory(probe.activity, captured.recordId, captured, 'pass', [source]).record;
    const record = probe.store.activateMemory(probe.activity, verified.recordId, verified).record;
    probe.store.drainSearchProjection(probe.activity);
    const projects = [sandbox.fixture.projectId, nonmember.projectId];
    const grantId = authorize(probe, projects, {
      [sandbox.fixture.projectId]: { agent: 'cli', platform: process.platform },
      [nonmember.projectId]: { agent: 'cli', platform: requiredPlatform },
    }, 4);

    const page = probe.store.searchMemories(probe.activity, { query: 'socket', grantId });
    assert.equal(page.status, 'ready');
    assert.deepEqual(page.results, []);
    assert.throws(() => probe.store.retrieveMemorySource(probe.activity,
      { recordId: record.recordId, offset: 0, limit: 4096, grantId }), /memory-inapplicable/);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('two workspace target hits recover one source and charge one provenance read', async () => {
  const sandbox = createSandbox();
  const binding = bindingOf(sandbox);
  const member = { ...binding, projectId: randomUUID(), sessionId: randomUUID(), branchId: randomUUID() };
  createSandboxSession(sandbox, member);
  const probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
  try {
    const projects = [sandbox.fixture.projectId, member.projectId];
    const workspaceId = randomUUID();
    probe.store.bindWorkspace(probe.activity, workspaceId, projects);
    const text = 'The shared socket decision uses port 7443.';
    const source = probe.archive.append(randomUUID(), text);
    const captured = probe.store.captureMemory(probe.activity, source, 'Workspace socket port decision', {
      type: 'fact', scope: { kind: 'workspace', id: workspaceId, resolved: true }, appliesTo: [],
    }).record;
    const verified = probe.store.verifyMemory(probe.activity, captured.recordId, captured, 'pass', [source]).record;
    const record = probe.store.activateMemory(probe.activity, verified.recordId, verified).record;
    probe.store.drainSearchProjection(probe.activity);
    const grantId = authorize(probe, projects, {
      [sandbox.fixture.projectId]: { agent: 'cli', platform: process.platform },
      [member.projectId]: { agent: 'cli', platform: process.platform },
    }, 4);
    const run = new AgentRun(probe.store, probe.activity, { binding, source: probe.archive, discoveryGrantId: grantId },
      { provider: 'fake', model: 'source-boundaries', route: 'fixture', authNamespace: 'synthetic' }, budget);
    run.receive(randomUUID(), 'Find the shared socket decision for both projects.');
    const payloads: string[] = [];
    await pumpAgent(run, {
      async *stream(request, _signal, send) {
        send(request.payload); payloads.push(request.payload);
        yield { kind: 'complete', reply: payloads.length === 1 ? { text: '', stop: 'tools', calls: [
          { id: 'search', name: 'memory.search', arguments: { query: 'socket' } },
        ] } : { text: 'Both projects share the original port decision.', calls: [], stop: 'end' } };
      },
      async execute() { throw new Error('unexpected-host-tool'); },
    });
    assert.equal(run.status().terminal, 'completed');
    assert.equal(payloads.length, 2);
    const next = JSON.parse(payloads[1]!);
    const result = JSON.parse(next.p2.at(-1).results[0].modelResult);
    assert.equal(result.results.length, 2);
    assert.deepEqual(new Set(result.results.map((hit: { targetProjectId: string }) => hit.targetProjectId)), new Set(projects));
    assert.ok(result.results.every((hit: { unitId: string }) => hit.unitId === record.recordId));
    const archived = JSON.parse(probe.archive.read(run.status().tools[0]!.result!.source).text);
    assert.equal(archived.sourceRecovery.length, 1);
    assert.equal(archived.sourceRecovery[0].status, 'ready');
    assert.equal(archived.sourceRecovery[0].recordId, record.recordId);
    assert.equal(archived.sourceRecovery[0].excerpt.text, text);
    assert.deepEqual(next.p3.sourceRecovery, archived.sourceRecovery);

    // Two target results and one recovered source leave one of the four authorized reads.
    const request = { recordId: record.recordId, offset: 0, limit: 4096, grantId };
    assert.equal(probe.store.retrieveMemorySource(probe.activity, request).text, text);
    assert.throws(() => probe.store.retrieveMemorySource(probe.activity, request), /discovery-budget-exhausted/);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
