import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { AgentRun, DEFAULT_BUDGET, GuidanceSession, MemoryCorrections, fileIdentity } from '@euler/core';
import { pumpAgent } from '../src/agent-pump.ts';
import { bindingOf, createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

const route = { provider: 'fake', model: 'controlled', route: 'fixture', authNamespace: 'synthetic' };
const budget = { ...DEFAULT_BUDGET, contextLimit: 16000, outputReserve: 512,
  maxModelAttempts: 6, maxToolCalls: 6, maxTotalTokens: 300000 };

test('recognized guidance conflicts block Agent admission and an exact owner resolution permits a fresh assembly', () => {
  const sandbox = createSandbox(), probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
  try {
    const root = join(sandbox.root, 'project'); mkdirSync(root);
    const text = 'Output format: JSON.\nOutput format: XML.\n';
    writeFileSync(join(root, 'AGENTS.md'), text);
    const input = probe.archive.append(randomUUID(), 'Inspect the synthetic source.');
    probe.store.transitionIntent(probe.activity, null, input, { status: 'active', step: 'inspection' }, 'Inspect the synthetic source.');
    const session = new GuidanceSession(probe.store, probe.activity, probe.archive, {
      dataRoot: { path: sandbox.root, identity: fileIdentity(sandbox.root) },
      projects: [{ projectId: sandbox.fixture.projectId, root: { path: root, identity: fileIdentity(root) } }], sharedSkills: null, sources: [],
    });
    const target = { projectId: sandbox.fixture.projectId, path: join(root, 'example.ts') };
    const operation = { name: 'synthetic.read' as const, targets: [target.path] };
    const first = session.prepare([target]);
    const block = first.snapshot.guidance[0]!;
    session.recognize(['JSON', 'XML'].map(value => ({ locator: block.locator, hash: block.hash,
      quote: `Output format: ${value}.`, operation: operation.name, target: target.path, key: 'format', value })));
    const run = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive,
      guidance: { session, targets: [target], operation } }, route, budget);
    run.receive(input.eventId, 'Inspect the synthetic source.');
    assert.throws(() => run.nextModel(), /instruction-conflict/);
    assert.equal(run.status().attempts, 0);
    const latest = session.latest()!;
    const blocked = session.execute(latest.assemblyId, operation, { policy: true, capability: true, credential: true, approval: true },
      () => { throw new Error('conflicting effect must not execute'); });
    const conflict = blocked.conflicts[0]!;
    session.resolve(conflict.id, 'JSON', probe.archive.append(randomUUID(), `Resolve ${conflict.id}: JSON`), operation);
    assert.ok(run.nextModel()); run.cancel();
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('source search and bounded expansion recover a dropped tool result through the actual pump', async () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
  try {
    const run = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive }, route, budget);
    run.receive(randomUUID(), 'Inspect the synthetic trace and recover the exact old result when needed.');
    let turn = 0, recoveredEvent = '';
    const status = await pumpAgent(run, {
      async *stream(request, _signal, send) {
        send(request.payload); turn++;
        const payload = JSON.parse(request.payload);
        if (turn === 4) {
          const page = JSON.parse(payload.p2.at(-1).results[0].modelResult);
          assert.equal(page.status, 'ready');
          recoveredEvent = page.results.find((hit: { preview: string }) => hit.preview.includes('ARCHIVED-MARKER')).eventId;
        }
        if (turn === 5) {
          const result = payload.p2.at(-1).results[0];
          assert.equal(result.outcome, 'success');
          assert.match(JSON.parse(result.modelResult).text, /ARCHIVED-MARKER/);
          yield { kind: 'complete' as const, reply: { text: 'Recovered exact old result.', calls: [], stop: 'end' as const } }; return;
        }
        const call = turn <= 2 ? { id: `large-${turn}`, name: 'controlled.echo', arguments: { text: `step-${turn}` } }
          : turn === 3 ? { id: 'search', name: 'source.search', arguments: { query: 'ARCHIVED-MARKER', scope: 'session' } }
          : { id: 'expand', name: 'source.expand', arguments: { eventId: recoveredEvent, offset: 0, limit: 160 } };
        yield { kind: 'complete' as const, reply: { text: '', calls: [call], stop: 'tools' as const } };
      },
      async execute(call) {
        assert.equal(call.name, 'controlled.echo');
        return (call.id === 'large-1' ? 'ARCHIVED-MARKER: ' : 'Other result: ') + 'synthetic detail '.repeat(330);
      },
    });
    assert.equal(status.terminal, 'completed');
    assert.equal(turn, 5);
    assert.ok(status.windows.length > 1);
    assert.ok(recoveredEvent);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('settled operation history stays recoverable without making short requests exceed context after a session restart', () => {
  const sandbox = createSandbox();
  const limits = { ...budget, contextLimit: 10000 };
  let probe = openProbe(sandbox, limits, undefined, undefined, undefined, true);
  try {
    const record = probe.store.rememberMemory(probe.activity, {
      input: probe.archive.append(randomUUID(), '记住偏好：使用 npm'), hostInfo: 'durable' }).record;
    const corrections = new MemoryCorrections(probe.store, probe.activity, probe.archive);
    for (let index = 0; index < 40; index++) {
      const preview = corrections.handle(corrections.receive(`correct ${record.recordId} "value ${index}"`));
      assert.equal(preview.kind, 'preview');
      if (preview.kind !== 'preview') throw new Error('preview missing');
      corrections.presented(preview.presentation);
      corrections.handle(corrections.receive(`cancel ${preview.presentation.token}`));
      probe.store.acknowledgeCorrectionOwner(probe.activity, preview.presentation.token);
      const delivery = probe.store.correctionDelivery(probe.activity, preview.presentation.token);
      const summary = probe.store.correctionSummary(probe.activity, preview.presentation.token);
      probe.store.acknowledgeCorrectionModel(probe.activity, preview.presentation.token,
        probe.archive.append(delivery.summaryEventId, JSON.stringify(summary), 'tool'));
    }
    for (let reopen = 0; reopen < 2; reopen++) {
      const run = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive }, route, limits);
      run.receive(randomUUID(), 'Short synthetic question.');
      const request = run.nextModel();
      assert.ok(request);
      const payload = JSON.parse(request.payload);
      assert.ok(payload.p1.operationArchive.omitted > 0);
      assert.equal(payload.p1.operationArchive.count, 40);
      assert.ok(payload.p1.operationSummaries.length < 40);
      assert.equal(payload.p1.operationSummaries.at(-1).status, 'cancelled');
      assert.equal(probe.store.correctionModelSummaries(probe.activity).length, 40);
      assert.equal(probe.store.readMemory(probe.activity, record.recordId).content, '使用 npm');
      run.cancel();
      probe.close(); probe = openProbe(sandbox, limits, undefined, undefined, undefined, true);
    }
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('window reconstruction carries exact active guidance and a changed selected Skill durably invalidates dispatch', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
  try {
    const root = join(sandbox.root, 'project');
    const directory = join(root, '.agents', 'skills', 'check');
    mkdirSync(directory, { recursive: true });
    const body = '---\nname: check\ndescription: Synthetic check\n---\nKeep this exact instruction.\r\n';
    writeFileSync(join(directory, 'SKILL.md'), body);
    writeFileSync(join(root, 'AGENTS.md'), 'Use the synthetic fixture only.\n');
    const input = probe.archive.append(randomUUID(), 'Inspect synthetic source.');
    probe.store.transitionIntent(probe.activity, null, input, { status: 'active', step: 'inspection' }, 'Inspect synthetic source.');
    const session = new GuidanceSession(probe.store, probe.activity, probe.archive, {
      dataRoot: { path: sandbox.root, identity: fileIdentity(sandbox.root) },
      projects: [{ projectId: sandbox.fixture.projectId, root: { path: root, identity: fileIdentity(root) } }], sharedSkills: null, sources: [],
    });
    session.activate(session.select('check', sandbox.fixture.projectId).selected, sandbox.fixture.projectId, 'owner-explicit');
    const run = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive,
      guidance: { session, targets: [{ projectId: sandbox.fixture.projectId, path: join(root, 'example.ts') }],
        operation: { name: 'synthetic.read', targets: [join(root, 'example.ts')] } } }, route, budget);
    run.receive(input.eventId, 'Inspect synthetic source.');
    const first = run.nextModel()!;
    assert.equal(JSON.parse(first.payload).p0.guidance.find((item: { kind: string }) => item.kind === 'skill').text, body);
    const attempt = run.startModel(first, first.payload);
    run.maySend(attempt.attemptId, first.payload);
    run.finishModel(attempt.attemptId, { text: '', stop: 'tools', calls: [{ id: 'one', name: 'controlled.echo', arguments: { text: 'one' } }] });
    run.startTool('one'); run.finishTool('one', 'one');
    run.newWindow();
    const next = run.nextModel()!;
    assert.equal(JSON.parse(next.payload).p0.guidance.find((item: { kind: string }) => item.kind === 'skill').text, body);
    writeFileSync(join(directory, 'SKILL.md'), body + 'Changed instructions.\n');
    assert.throws(() => run.startModel(next, next.payload), /guidance-stale/);
    assert.equal(run.status().cacheEpoch, null);
    assert.equal(probe.store.requestStatus(probe.activity, run.runId).attempts.length, 1);
    run.cancel();
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('P2 appends retain a cache epoch while a fresh window gets independent window, epoch and assembly identities', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
  try {
    const run = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive }, route, budget);
    run.receive(randomUUID(), 'Inspect two synthetic steps.');
    for (let index = 0; index < 2; index++) {
      const request = run.nextModel()!;
      const attempt = run.startModel(request, request.payload);
      assert.equal(run.maySend(attempt.attemptId, request.payload), true);
      run.finishModel(attempt.attemptId, { text: '', stop: 'tools', calls: [{ id: `tool-${index}`, name: 'controlled.echo', arguments: { text: 'bounded' } }] });
      run.startTool(`tool-${index}`); run.finishTool(`tool-${index}`, 'bounded');
    }
    const before = probe.store.requestStatus(probe.activity, run.runId).assemblies;
    assert.ok(before[0]!.context);
    assert.equal(before[0]!.context!.cacheEpoch, before[1]!.context!.cacheEpoch);
    assert.equal(before[0]!.context!.windowId, before[1]!.context!.windowId);
    run.newWindow();
    const next = run.nextModel()!;
    const after = probe.store.requestStatus(probe.activity, run.runId).assemblies.at(-1)!;
    assert.notEqual(after.context!.windowId, before[0]!.context!.windowId);
    assert.notEqual(after.context!.cacheEpoch, before[0]!.context!.cacheEpoch);
    assert.notEqual(next.assemblyId, before[1]!.assemblyId);
    assert.equal(after.epoch, probe.activity.epoch);
    assert.notEqual(after.context!.windowId, next.assemblyId);
    run.cancel();
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('context pressure opens durable windows with the goal and latest complete ReAct pair while retaining the run budget', async () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
  try {
    const run = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive }, route, budget);
    run.receive(randomUUID(), 'Complete the synthetic four-step inspection and retain the original objective.');
    let requests = 0;
    const payloads: string[] = [];
    const status = await pumpAgent(run, {
      async *stream(request, _signal, send) {
        send(request.payload); payloads.push(request.payload); requests++;
        if (requests <= 4) yield { kind: 'complete' as const, reply: { text: '', stop: 'tools' as const,
          calls: [{ id: `step-${requests}`, name: 'controlled.echo', arguments: { text: `step-${requests}` } }] } };
        else yield { kind: 'complete' as const, reply: { text: 'All four steps complete.', stop: 'end' as const, calls: [] } };
      },
      async execute(call) { return `${call.id}:` + 'synthetic detail '.repeat(330); },
    });
    assert.equal(status.terminal, 'completed');
    assert.equal(requests, 5);
    assert.equal(status.attempts, 5);
    const ledger = probe.store.requestStatus(probe.activity, run.runId);
    const windows = ledger.events.filter(event => event.kind === 'agent/event@v1')
      .map(event => JSON.parse(event.payload).event).filter(event => event.kind === 'window-opened');
    assert.ok(windows.length >= 2);
    assert.equal(new Set(windows.map(window => window.windowId)).size, windows.length);
    const last = JSON.parse(payloads.at(-1)!);
    assert.match(last.p3.intent.goal, /original objective/);
    assert.equal(last.p2.length, 1);
    assert.equal(last.p2[0].assistant.calls[0].id, 'step-4');
    assert.equal(last.p2[0].results[0].callId, 'step-4');
    assert.equal(payloads.at(-1)!.includes('step-1:'), false);
    assert.ok(payloads.every(payload => Buffer.byteLength(payload) + budget.outputReserve + budget.safetyMargin <= budget.contextLimit));
    for (const response of status.responses) assert.ok(probe.archive.read(response.source).text);
    for (const tool of status.tools) assert.match(probe.archive.read(tool.result!.source).text, /synthetic detail/);
    assert.equal(ledger.run.budget.maxModelAttempts, 6);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
