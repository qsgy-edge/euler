import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentRun, AnalysisArtifacts, CaptureRun, DEFAULT_BUDGET, encodeOwnerAgreement, fileIdentity, sha256 } from '@euler/core';
import type { AnalysisHeader, CaptureConfig, FileCapability, ModelReply, SourceAck } from '@euler/core';
import { createSandbox, bindingOf } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';
import { pumpCapture } from '../src/agent-pump.ts';
import { approvedSourceUnit } from './support/source-publication.ts';


test('a missing raw source blocks the Historian before a model request', () => {
  const value = setup(), path = join(value.sandbox.root, 'session.jsonl'), bytes = readFileSync(path);
  try {
    writeFileSync(path, bytes.toString('utf8').replace('Synthetic decision: Windows only;', 'Synthetic decision: unknown only;'));
    assert.equal(value.probe.store.claimCaptureJob(value.probe.activity, value.job.jobId, budget, 30000), null);
    assert.equal(value.probe.store.readCaptureJob(value.probe.activity, value.job.jobId).reason, 'source-evidence-gap');
    assert.equal(value.probe.transport.count, 0);
  } finally { writeFileSync(path, bytes); value.close(); }
});

test('an insufficient Historian capability publishes nothing and starts no model request', () => {
  const value = setup();
  try {
    const { run } = consumer(value, { historian: [{ ...route, capability: 'basic' }] });
    assert.equal(run.nextModel(), null);
    assert.equal(run.status().reason, 'historian-capability-insufficient');
    assert.equal(value.probe.transport.count, 0);
    assert.throws(() => value.probe.store.readCompartment(value.probe.activity, value.job.jobId), /compartment-unavailable/);
  } finally { value.close(); }
});

test('a completed durable range can enqueue its missing job by run identity after reopening', () => {
  const sandbox = createSandbox();
  let probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
  try {
    const { capability: _capability, ...agentRoute } = route;
    const agent = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive }, agentRoute, budget);
    agent.receive(randomUUID(), 'A synthetic complete task.');
    const request = agent.nextModel()!, attempt = agent.startModel(request, request.payload);
    agent.maySend(attempt.attemptId, request.payload);
    agent.finishModel(attempt.attemptId, { text: 'Exact synthetic task result.', calls: [], stop: 'end' });
    assert.deepEqual(probe.store.listCaptureJobs(probe.activity, 32, false, 'historian'), []);
    probe.close(); probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
    const job = probe.store.queueHistorianBoundary(probe.activity, agent.runId, { minBytes: 4096, maxBytes: 60000 })!;
    assert.ok(job);
    assert.equal(probe.store.queueHistorianBoundary(probe.activity, agent.runId, { minBytes: 4096, maxBytes: 60000 })!.jobId, job.jobId);
    assert.equal(job.range.length, 2);
    assert.equal(probe.archive.read(job.range[1]!).text, JSON.stringify({ text: 'Exact synthetic task result.', calls: [], stop: 'end' }));
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

const route = { provider: 'synthetic', model: 'historian-fixture', route: 'fixture', authNamespace: 'synthetic', capability: 'standard' as const };
const budget = { ...DEFAULT_BUDGET, contextLimit: 40000, maxTotalTokens: 500000, maxModelAttempts: 12, maxToolCalls: 12 };
function setup(live = false) {
  const sandbox = createSandbox(), probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
  const { capability: _capability, ...agentRoute } = route;
  const agent = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive }, agentRoute, budget);
  const release = live ? agent.observeExecution() : () => {};
  agent.receive(randomUUID(), 'Synthetic decision: Windows only; exact value 47.');
  for (const id of ['old','recent']) {
    const request = agent.nextModel()!, attempt = agent.startModel(request, request.payload);
    agent.maySend(attempt.attemptId, request.payload);
    agent.finishModel(attempt.attemptId, { text: 'Raw intermediate observations. '.repeat(180), calls: [{ id, name: 'controlled.echo', arguments: { text: id } }], stop: 'tools' });
    agent.startTool(id); agent.finishTool(id, 'Exact result 47 at fixture.ts:19');
  }
  const job = probe.store.queueHistorianBoundary(probe.activity, agent.runId, { minBytes: 1000, maxBytes: 30000 })!;
  if (!live) agent.cancel();
  return { sandbox, probe, agent, job, release, close() { release(); probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); } };
}
function consumer(value: ReturnType<typeof setup>, config: CaptureConfig = { historian: [route, { ...route, model: 'fallback' }] }) {
  const lease = value.probe.store.claimCaptureJob(value.probe.activity, value.job.jobId, budget, 30000)!;
  return { lease, run: new CaptureRun(value.probe.store, lease, value.probe.archive, config, undefined, 'capture-counting@1') };
}
function deliver(value: { probe: ReturnType<typeof openProbe> }, run: CaptureRun | AgentRun, text: string | ModelReply) {
  const request = run.nextModel()!; assert.ok(request);
  const attempt = run.startModel(request, request.payload);
  assert.equal(run.maySend(attempt.attemptId, request.payload), true);
  value.probe.transport.send(request.payload, attempt);
  run.finishModel(attempt.attemptId, typeof text === 'string' ? { text, calls: [], stop: 'end' } : text);
  return request;
}

for (const result of ['block','evidence-gap']) for (const toolCount of [0, 1, 17])
  test(`a Historian ${result} with ${toolCount} calls never uses fallback or publishes a compartment`, () => {
    const value = setup();
    try {
      const { run, lease } = consumer(value);
      const text = JSON.stringify({ result, reason: 'synthetic-negative' });
      deliver(value, run, { text, calls: Array.from({ length: toolCount }, (_, index) => ({
        id: 'unexpected-' + index, name: 'source.search', arguments: { query: 'synthetic' } })), stop: toolCount ? 'tools' : 'end' });
      assert.equal(run.status().stage, 'blocked');
      assert.equal(run.status().reason, 'historian-' + result);
      assert.equal(run.nextModel(), null);
      assert.equal(value.probe.transport.count, 1);
      const ledger = value.probe.store.requestStatus(lease.activity, run.runId);
      assert.equal(ledger.attempts.length, 1);
      assert.equal(ledger.events.filter(event => event.kind === 'capture/step@v1' && JSON.parse(event.payload).kind === 'tool').length, 0);
      const output = value.probe.archive.lookup(ledger.attempts[0]!.attemptId)!;
      assert.equal(JSON.parse(value.probe.archive.read(output).text).text, text);
      assert.throws(() => value.probe.store.readCompartment(value.probe.activity, value.job.jobId), /compartment-unavailable/);
    } finally { value.close(); }
  });

test('structured output failure uses a configured fallback with the original raw input and no previous summary', () => {
  const value = setup();
  try {
    const { run } = consumer(value);
    const first = deliver(value, run, 'INVALID-PRIOR-SUMMARY');
    const next = deliver(value, run, JSON.stringify({ result: 'pass', summary: 'A faithful synthetic summary.' }));
    assert.equal(JSON.parse(next.payload).model, 'fallback');
    assert.deepEqual(JSON.parse(next.payload).p3, JSON.parse(first.payload).p3);
    assert.deepEqual(JSON.parse(next.payload).p2, []);
    assert.doesNotMatch(next.payload, /INVALID-PRIOR-SUMMARY/);
    assert.equal(value.probe.transport.count, 2);
    assert.equal(run.status().stage, 'complete');
  } finally { value.close(); }
});

test('an unknown Historian attempt is reconciled without a second model request or a fabricated compartment', () => {
  const value = setup();
  try {
    const { run, lease } = consumer(value);
    const request = run.nextModel()!, attempt = run.startModel(request, request.payload);
    run.maySend(attempt.attemptId, request.payload); value.probe.transport.send(request.payload, attempt);
    run.fail(new Error('synthetic-response-lost'));
    assert.equal(run.status().stage, 'unknown');
    const ledger = value.probe.store.reconcileCaptureJob(value.probe.activity, value.job.jobId);
    assert.equal(ledger.attempts[0]!.outcome, 'unknown-sent');
    assert.equal(ledger.events.filter(event => event.kind === 'model/request-attempt-reconciled@v1').length, 1);
    assert.equal(value.probe.store.claimCaptureJob(value.probe.activity, value.job.jobId, budget, 30000), null);
    assert.equal(value.probe.store.requestStatus(lease.activity, run.runId).attempts.length, 1);
    assert.throws(() => value.probe.store.readCompartment(value.probe.activity, value.job.jobId), /compartment-unavailable/);
  } finally { value.close(); }
});

for (const afterAppend of [false, true]) test(`the Historian pump resumes publication without another send after an append failure, written=${afterAppend}`, async () => {
  const value = setup(), failure = new Error('synthetic-publication-interrupted');
  let reopened: ReturnType<typeof openProbe> | undefined, closed = false;
  try {
    const lease = value.probe.store.claimCaptureJob(value.probe.activity, value.job.jobId, budget, 30000)!;
    const deadline = value.probe.store.captureRuntime(lease).deadline;
    const source = new Proxy(value.probe.archive, { get(target, key) {
      if (key === 'append') return (id: string, ...args: Parameters<typeof target.append> extends [string, ...infer T] ? T : never) => {
        if (id !== value.job.jobId) return target.append(id, ...args);
        if (afterAppend) target.append(id, ...args);
        throw failure;
      };
      const field = Reflect.get(target, key, target); return typeof field === 'function' ? field.bind(target) : field;
    } });
    const run = new CaptureRun(value.probe.store, lease, source, { historian: [route] });
    await assert.rejects(pumpCapture(run, { async *stream(request, _signal, send) {
      const attempt = send(request.payload); value.probe.transport.send(request.payload, attempt);
      yield { kind: 'complete', reply: { text: JSON.stringify({ result: 'pass', summary: 'A faithful synthetic summary.' }), calls: [], stop: 'end' } };
    } }), error => error === failure);
    const attempts = value.probe.store.requestStatus(lease.activity, run.runId).attempts;
    assert.equal(attempts.length, 1); assert.equal(attempts[0]!.outcome, 'received');
    assert.equal(value.probe.transport.count, 1);
    assert.equal(Boolean(value.probe.archive.lookup(value.job.jobId)), afterAppend);
    assert.throws(() => value.probe.store.readCompartment(value.probe.activity, value.job.jobId), /compartment-unavailable/);
    assert.equal(run.nextModel(), null);
    value.probe.close(); closed = true;
    reopened = openProbe(value.sandbox, budget, undefined, undefined, undefined, true);
    for (const ref of value.job.range) reopened.archive.read(ref);
    const savedReply = JSON.parse(reopened.archive.read(reopened.archive.lookup(attempts[0]!.attemptId)!).text);
    assert.equal(JSON.parse(savedReply.text).result, 'pass');
    const next = reopened.store.claimCaptureJob(reopened.activity, value.job.jobId, budget, 30000);
    assert.ok(next, 'the saved response must remain claimable for publication');
    assert.equal(reopened.store.captureRuntime(next).deadline, deadline);
    const recovered = new CaptureRun(reopened.store, next, reopened.archive, { historian: [route] });
    assert.equal(recovered.runId, run.runId);
    assert.equal((await pumpCapture(recovered, { async *stream() { assert.fail('publication recovery must not call a model'); } })).stage, 'complete');
    assert.equal(reopened.transport.count, 0);
    assert.equal(reopened.store.requestStatus(next.activity, recovered.runId).attempts.length, 1);
    assert.equal(reopened.store.readCompartment(reopened.activity, value.job.jobId).body.summary, 'A faithful synthetic summary.');
    assert.equal(reopened.archive.events().filter(event => event.ack.eventId === value.job.jobId).length, 1);
  } finally { reopened?.close(); if (!closed) value.probe.close(); value.release(); rmSync(value.sandbox.root, { recursive: true, force: true }); }
});

for (const previouslySelected of [false, true])
  test(`a damaged compartment permits a raw-window send, previously selected=${previouslySelected}`, () => {
    const value = setup(true), path = join(value.sandbox.root, 'session.jsonl');
    let saved: Buffer | undefined;
    try {
      const { run } = consumer(value);
      deliver(value, run, JSON.stringify({ result: 'pass', summary: 'A faithful synthetic summary.' }));
      const compartment = value.probe.store.readCompartment(value.probe.activity, value.job.jobId);
      if (previouslySelected) {
        value.agent.newWindow();
        const selected = deliver(value, value.agent, { text: 'Continue after selection.', calls: [{ id: 'after-selection',
          name: 'controlled.echo', arguments: { text: 'continuation' } }], stop: 'tools' });
        assert.match(JSON.stringify(JSON.parse(selected.payload).p1.compartments), /A faithful synthetic summary/);
        const assembly = value.probe.store.requestStatus(value.probe.activity, value.agent.runId).assemblies
          .find(item => item.assemblyId === selected.assemblyId)!;
        assert(assembly.sources.some(source => source.eventId === compartment.source.eventId));
        value.agent.startTool('after-selection'); value.agent.finishTool('after-selection', 'Confirmed continuation result.');
      }
      saved = readFileSync(path);
      const lines = saved.toString('utf8').trimEnd().split('\n');
      const index = lines.findIndex(line => JSON.parse(line).eventId === compartment.source.eventId);
      assert.ok(index > 0); lines[index] = lines[index]!.replace('A faithful', 'X faithful');
      writeFileSync(path, lines.join('\n') + '\n');
      value.agent.newWindow();
      const next = value.agent.nextModel()!;
      const payload = JSON.parse(next.payload);
      assert.equal(payload.p1.compartments, undefined);
      assert.equal(payload.p1.compartmentGaps[0].jobId, value.job.jobId);
      assert.equal(payload.p2.length, 1);
      const current = value.probe.store.requestStatus(value.probe.activity, value.agent.runId).assemblies
        .find(item => item.assemblyId === next.assemblyId)!;
      assert(current.sources.every(source => source.eventId !== compartment.source.eventId));
      for (const source of current.sources) assert.doesNotThrow(() => value.probe.archive.read(source));
      const attempt = value.agent.startModel(next, next.payload);
      assert.equal(value.agent.maySend(attempt.attemptId, next.payload), true);
      value.probe.transport.send(next.payload, attempt);
      value.agent.finishModel(attempt.attemptId, { text: 'Continue with the raw window.', calls: [
        { id: 'raw-window-tool', name: 'controlled.echo', arguments: { text: 'raw continuation' } }], stop: 'tools' });
      value.agent.startTool('raw-window-tool'); value.agent.finishTool('raw-window-tool', 'Raw continuation complete.');
      deliver(value, value.agent, 'Completed with the raw window.');
      assert.equal(value.agent.status().terminal, 'completed');
    } finally { if (saved) writeFileSync(path, saved); value.close(); }
  });

test('a selected compartment that changes after preparation is rejected before any send', () => {
  const value = setup(true), path = join(value.sandbox.root, 'session.jsonl');
  try {
    const { run } = consumer(value);
    deliver(value, run, JSON.stringify({ result: 'pass', summary: 'A faithful synthetic summary.' }));
    value.agent.newWindow();
    const next = value.agent.nextModel()!, count = value.probe.transport.count;
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('A faithful synthetic summary.', 'X faithful synthetic summary.'));
    assert.throws(() => {
      const attempt = value.agent.startModel(next, next.payload);
      if (value.agent.maySend(attempt.attemptId, next.payload)) value.probe.transport.send(next.payload, attempt);
    }, /source-evidence-gap|compartment-integrity/);
    assert.equal(value.probe.transport.count, count);
  } finally { value.close(); }
});

test('historical raw corruption still blocks a prepared fresh-window send', () => {
  const value = setup(true), path = join(value.sandbox.root, 'session.jsonl');
  try {
    const { run } = consumer(value);
    deliver(value, run, JSON.stringify({ result: 'pass', summary: 'A faithful synthetic summary.' }));
    const compartment = value.probe.store.readCompartment(value.probe.activity, value.job.jobId);
    value.agent.newWindow();
    deliver(value, value.agent, { text: 'Continue after selection.', calls: [{ id: 'after-selection', name: 'controlled.echo', arguments: { text: 'continuation' } }], stop: 'tools' });
    value.agent.startTool('after-selection'); value.agent.finishTool('after-selection', 'Confirmed continuation.');
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
    const index = lines.findIndex(line => JSON.parse(line).eventId === compartment.source.eventId);
    lines[index] = lines[index]!.replace('A faithful', 'X faithful');
    writeFileSync(path, lines.join('\n') + '\n');
    value.agent.newWindow();
    const next = value.agent.nextModel()!, attempt = value.agent.startModel(next, next.payload), count = value.probe.transport.count;
    const raw = value.job.range.find(source => value.probe.archive.read(source).role === 'assistant')!;
    const rawIndex = lines.findIndex(line => JSON.parse(line).eventId === raw.eventId);
    lines[rawIndex] = lines[rawIndex]!.replaceAll('Raw intermediate observations.', 'Bad intermediate observations.');
    writeFileSync(path, lines.join('\n') + '\n');
    assert.throws(() => {
      if (value.agent.maySend(attempt.attemptId, next.payload)) value.probe.transport.send(next.payload, attempt);
    }, /source-evidence-gap/);
    assert.equal(value.probe.transport.count, count);
  } finally { value.close(); }
});

test('a settled run with a damaged historical compartment can recover after reopening', () => {
  const value = setup(true), path = join(value.sandbox.root, 'session.jsonl');
  let reopened: ReturnType<typeof openProbe> | undefined, closed = false;
  try {
    const { run } = consumer(value);
    deliver(value, run, JSON.stringify({ result: 'pass', summary: 'A faithful synthetic summary.' }));
    value.agent.newWindow(); deliver(value, value.agent, 'The original task is complete.');
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('A faithful synthetic summary.', 'X faithful synthetic summary.'));
    value.release(); value.probe.close(); closed = true;
    reopened = openProbe(value.sandbox, budget, undefined, undefined, undefined, true);
    const { capability: _capability, ...agentRoute } = route;
    const agent = new AgentRun(reopened.store, reopened.activity, { binding: bindingOf(value.sandbox), source: reopened.archive }, agentRoute, budget,
      { recovery: { relatedRunId: value.agent.runId, acceptDuplicateRisk: false } });
    agent.receive(randomUUID(), 'Continue from the archived raw evidence.');
    deliver({ probe: reopened }, agent, { text: 'Read the original source.', calls: [{ id: 'restore', name: 'source.expand',
      arguments: { eventId: value.job.range[0]!.eventId, offset: 0, limit: 4096 } }], stop: 'tools' });
    agent.startTool('restore');
    const result = agent.coreToolResult('restore')!;
    assert.equal(result.outcome, 'success'); assert.match(result.modelResult, /exact value 47/);
    agent.finishTool('restore', result.modelResult);
    deliver({ probe: reopened }, agent, 'Recovered original value 47.');
    assert.equal(agent.status().terminal, 'completed');
  } finally {
    reopened?.close(); if (!closed) value.probe.close(); value.release();
    rmSync(value.sandbox.root, { recursive: true, force: true });
  }
});

for (const historical of [false, true]) test('unknown reconciliation preserves current dependencies, damaged compartment historical=' + historical, () => {
  const value = setup(true), path = join(value.sandbox.root, 'session.jsonl');
  try {
    const { run } = consumer(value);
    deliver(value, run, JSON.stringify({ result: 'pass', summary: 'A faithful synthetic summary.' }));
    value.agent.newWindow();
    if (historical) {
      deliver(value, value.agent, { text: 'Continue after selection.', calls: [{ id: 'after-selection', name: 'controlled.echo', arguments: { text: 'continuation' } }], stop: 'tools' });
      value.agent.startTool('after-selection'); value.agent.finishTool('after-selection', 'Confirmed continuation.');
      writeFileSync(path, readFileSync(path, 'utf8').replaceAll('A faithful synthetic summary.', 'X faithful synthetic summary.'));
      value.agent.newWindow();
    }
    const request = value.agent.nextModel()!, attempt = value.agent.startModel(request, request.payload);
    assert.equal(value.agent.maySend(attempt.attemptId, request.payload), true);
    value.probe.transport.send(request.payload, attempt);
    if (!historical) writeFileSync(path, readFileSync(path, 'utf8').replaceAll('A faithful synthetic summary.', 'X faithful synthetic summary.'));
    const count = value.probe.transport.count;
    value.agent.fail();
    if (historical) {
      const ledger = value.probe.store.reconcileRequestAttempt(value.probe.activity, attempt.attemptId);
      assert.equal(ledger.events.filter(event => event.attemptId === attempt.attemptId && event.kind === 'model/request-attempt-reconciled@v1').length, 1);
      assert.equal(ledger.attempts.find(item => item.attemptId === attempt.attemptId)!.outcome, 'unknown-sent');
    } else assert.throws(() => value.probe.store.reconcileRequestAttempt(value.probe.activity, attempt.attemptId), /source-evidence-gap/);
    assert.equal(value.probe.transport.count, count);
  } finally { value.close(); }
});

test('another Store cannot borrow a live parent pump to start a Historian request', () => {
  const value = setup(true), peer = openProbe(value.sandbox, budget, undefined, undefined, undefined, true);
  try {
    const lease = peer.store.claimCaptureJob(peer.activity, value.job.jobId, budget, 30000)!;
    assert.throws(() => new CaptureRun(peer.store, lease, peer.archive, { historian: [route] }), /request-recovery-required/);
    assert.equal(peer.transport.count, 0);
    peer.store.stopCapture(lease, 'blocked', 'request-recovery-required');
    value.agent.cancel();
  } finally { peer.close(); value.close(); }
});

for (const corruption of ['none', 'text', 'user', 'tool']) test('raw recovery excludes background replies and compartment bodies, corruption=' + corruption, () => {
  const value = setup(), path = join(value.sandbox.root, 'session.jsonl');
  try {
    const { run } = consumer(value);
    deliver(value, run, JSON.stringify({ result: 'pass', summary: 'UNIQUEDERIVEDSUMMARY' }));
    const compartment = value.probe.store.readCompartment(value.probe.activity, value.job.jobId);
    if (corruption !== 'none') {
      const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
      for (const eventId of [compartment.source.eventId, compartment.attemptId]) {
        const index = lines.findIndex(line => JSON.parse(line).eventId === eventId);
        if (corruption === 'text') lines[index] = lines[index]!.replace('UNIQUEDERIVEDSUMMARY', 'DAMAGEDDERIVEDSUMMARY');
        else lines[index] = JSON.stringify({ ...JSON.parse(lines[index]!), role: corruption });
      }
      writeFileSync(path, lines.join('\n') + '\n');
    }
    const { capability: _capability, ...agentRoute } = route;
    const agent = new AgentRun(value.probe.store, value.probe.activity,
      { binding: bindingOf(value.sandbox), source: value.probe.archive }, agentRoute, budget);
    agent.receive(randomUUID(), 'Restore the archived exact values.');
    deliver(value, agent, { text: 'Search the archive.', calls: [{ id: 'search', name: 'source.search',
      arguments: { query: 'DERIVEDSUMMARY' } }], stop: 'tools' });
    agent.startTool('search');
    const searched = agent.coreToolResult('search')!;
    assert.equal(searched.outcome, 'success');
    const hits = JSON.parse(searched.modelResult).results as { eventId: string }[];
    assert.equal(hits.some(hit => [compartment.source.eventId, compartment.attemptId].includes(hit.eventId)), false);
    agent.finishTool('search', searched.modelResult);
    const refs = [compartment.source, value.probe.archive.lookup(compartment.attemptId)!, value.job.range[0]!];
    deliver(value, agent, { text: 'Recover exact raw evidence.', calls: refs.map((ref, index) => ({
      id: 'expand-' + index, name: 'source.expand', arguments: { eventId: ref.eventId, offset: 0, limit: 4096 } })), stop: 'tools' });
    for (let index = 0; index < refs.length; index++) {
      const id = 'expand-' + index;
      agent.startTool(id); const result = agent.coreToolResult(id)!;
      assert.equal(result.outcome, index < 2 ? 'failure' : 'success');
      if (index < 2) assert.match(result.modelResult, /source-derived/);
      else assert.match(result.modelResult, /exact value 47/);
      agent.finishTool(id, result.modelResult);
    }
    agent.cancel();
  } finally { value.close(); }
});

for (const target of ['body', 'reply'] as const) for (const operation of [
  'remember', 'untyped', 'agreement', 'capture', 'verification', 'reverification', 'feedback', 'proposal-input', 'proposal-evidence',
  'correction-preview', 'revise-input', 'revise-evidence',
] as const) test('derived identity cannot supply memory evidence: ' + target + '/' + operation, () => {
  const value = setup();
  try {
    const { store, activity, archive } = value.probe;
    const { run } = consumer(value);
    deliver(value, run, JSON.stringify({ result: 'pass', summary: 'Synthetic derived summary.' }));
    const compartment = store.readCompartment(activity, value.job.jobId);
    const owner = store.rememberMemory(activity, { input: archive.append(randomUUID(), '记住偏好：retain-original-owner-claim'), hostInfo: 'durable' });
    assert.equal(owner.status, 'activated');
    const record = owner.record, scope = record.scope;
    const proposal = { target: 'synthetic-guidance', expectedChange: 'Use synthetic evidence.', owner: value.sandbox.fixture.ownerId,
      scope, evidenceRefs: [record.source], evaluation: { schema: 'evaluation-contract@1' as const, level: 'L0' as const, assertions: ['Synthetic assertion.'] } };
    const eventId = target === 'body' ? compartment.source.eventId : compartment.attemptId;
    let text = 'synthetic-derived-input';
    if (operation === 'remember') text = '记住偏好：synthetic-derived-must-not-activate';
    else if (operation === 'untyped') text = '记住：synthetic-derived-must-not-queue';
    else if (operation === 'agreement') text = '建议记住偏好：synthetic-derived-proposal';
    else if (operation === 'reverification') text = JSON.stringify({ schema: 'memory-reverification-approval@1', recordId: record.recordId,
      revisionId: record.revisionId, headEventId: record.headEventId, sourceHash: record.source.hash });
    else if (operation === 'feedback') text = JSON.stringify({ schema: 'memory-feedback@1', kind: 'user_wrong', recordId: record.recordId,
      revisionId: record.revisionId, headEventId: record.headEventId });
    else if (operation === 'proposal-input') text = JSON.stringify({ schema: 'analysis-proposal-approval@1', proposal });
    const role = ['agreement', 'capture', 'verification', 'proposal-evidence'].includes(operation) ? 'assistant' : 'user';
    const path = join(value.sandbox.root, 'session.jsonl'), lines = readFileSync(path, 'utf8').trimEnd().split('\n');
    const index = lines.findIndex(line => JSON.parse(line).eventId === eventId);
    assert.ok(index > 0); lines[index] = JSON.stringify({ ...JSON.parse(lines[index]!), role, text });
    writeFileSync(path, lines.join('\n') + '\n');
    const input = archive.lookup(eventId)!;
    assert.equal(store.isCaptureOutput(activity, input), true);
    const jobs = store.listCaptureJobs(activity, 32, false, 'memory').map(job => job.jobId);
    const invoke = () => {
      switch (operation) {
        case 'remember': return store.rememberMemory(activity, { input, hostInfo: 'durable' });
        case 'untyped': return store.queueOwnerCapture(activity, input);
        case 'agreement': return store.rememberMemory(activity, { input: archive.append(randomUUID(), encodeOwnerAgreement('同意', input)), hostInfo: 'durable' });
        case 'capture': return store.captureMemory(activity, input, text, { type: 'preference', scope, appliesTo: [] });
        case 'verification': return store.verifyMemory(activity, record.recordId, record, 'pass', [input]);
        case 'reverification': return store.queueMemoryVerification(activity, record.recordId, record, input);
        case 'feedback': return store.recordMemoryFeedback(activity, record.recordId, record, input);
        case 'correction-preview': return store.previewMemoryOperation(activity, store.inspectMemoryPresentation(activity, [record.recordId]).token,
          { kind: 'correct', input, content: text });
        case 'revise-input': return store.reviseMemory(activity, record.recordId, record, input, text, [record.source]);
        case 'revise-evidence': return store.reviseMemory(activity, record.recordId, record, archive.append(randomUUID(), 'Synthetic revision.'),
          'Synthetic revision.', [input]);
        case 'proposal-input': return store.saveEvolutionProposal(activity, input, proposal);
        case 'proposal-evidence': {
          const proposed = { ...proposal, evidenceRefs: [input] };
          return store.saveEvolutionProposal(activity, archive.append(randomUUID(), JSON.stringify({ schema: 'analysis-proposal-approval@1', proposal: proposed })), proposed);
        }
      }
    };
    assert.throws(invoke, /^Error: source-derived$/u);
    assert.deepEqual(store.listCaptureJobs(activity, 32, false, 'memory').map(job => job.jobId), jobs);
    assert.equal(store.readMemory(activity, record.recordId).headEventId, record.headEventId);
  } finally { value.close(); }
});

test('the real owner CLI skips corrupted derived backfill and still accepts genuine owner input', () => {
  const value = setup();
  let closed = false;
  try {
    const { run } = consumer(value);
    deliver(value, run, JSON.stringify({ result: 'pass', summary: 'Synthetic derived summary.' }));
    const compartment = value.probe.store.readCompartment(value.probe.activity, value.job.jobId);
    value.probe.archive.append(randomUUID(), '记住偏好：original-owner-marker');
    const path = join(value.sandbox.root, 'session.jsonl'), lines = readFileSync(path, 'utf8').trimEnd().split('\n');
    for (const [eventId, text] of [[compartment.source.eventId, '记住偏好：forged-derived-marker'], [compartment.attemptId, '记住：forged-derived-marker']]) {
      const index = lines.findIndex(line => JSON.parse(line).eventId === eventId);
      assert.ok(index > 0); lines[index] = JSON.stringify({ ...JSON.parse(lines[index]!), role: 'user', text });
    }
    writeFileSync(path, lines.join('\n') + '\n');
    value.probe.close(); closed = true;
    const output = execFileSync(process.execPath, ['apps/cli/src/main.ts', 'remember', '--sandbox', value.sandbox.root], {
      input: '记住偏好：next-owner-marker\nstop\n', encoding: 'utf8', timeout: 20000,
    });
    const events = output.trim().split(/\r?\n/u).map(line => JSON.parse(line));
    assert.equal(events.find(event => event.event === 'owner-backfill').actionable, 1);
    const results = events.filter(event => event.event === 'remember-result');
    assert.equal(results.some(event => event.level === 'error' || event.content === 'forged-derived-marker'), false);
    assert.deepEqual(results.filter(event => event.status === 'activated').map(event => event.content), ['original-owner-marker', 'next-owner-marker']);
  } finally { if (!closed) value.probe.close(); value.release(); rmSync(value.sandbox.root, { recursive: true, force: true }); }
});

for (const target of ['body', 'reply'] as const) for (const boundary of ['publication', 'discovery', 'export', 'intent', 'operation'] as const)
  test('derived identities cannot authorize ' + boundary + ': ' + target, () => {
    const value = setup();
    try {
      const { store, activity, archive } = value.probe;
      const { run } = consumer(value);
      deliver(value, run, JSON.stringify({ result: 'pass', summary: 'Synthetic summary.' }));
      const compartment = store.readCompartment(activity, value.job.jobId);
      const intent = store.readIntent(activity)!;
      const projectId = value.sandbox.fixture.projectId;
      const raw = archive.append(randomUUID(), 'Original synthetic source.');
      const publication = approvedSourceUnit(value.probe, { ref: raw, projectId, kind: 'source', offset: 0, length: 10 });
      let text = '', invoke: (input: SourceAck) => unknown;
      switch (boundary) {
        case 'publication':
          text = archive.read(publication.approval).text;
          invoke = input => store.publishSourceUnit(activity, { ...publication, approval: input });
          break;
        case 'discovery':
          text = JSON.stringify({ schema: 'memory-discovery-approval@1', intentId: intent.intentId, goalEventId: intent.goalInput.eventId,
            projectIds: [projectId], targets: {}, maxResults: 10, maxBytes: 131072 });
          invoke = input => store.authorizeMemoryDiscovery(activity, input, [projectId], 10);
          break;
        case 'export': {
          const unit = store.publishSourceUnit(activity, publication), selection = [{ unitId: unit.unitId, hash: unit.contentHash }];
          text = JSON.stringify({ schema: 'analysis-export-approval@1', selection });
          invoke = input => store.renderAnalysisExport(activity, selection, input);
          break;
        }
        case 'intent':
          text = 'Synthetic owner task progress.';
          invoke = input => store.transitionIntent(activity, intent.eventId, input, { status: 'active', step: 'analysis' });
          break;
        case 'operation': {
          const record = store.rememberMemory(activity, { input: archive.append(randomUUID(), '记住偏好：keep-owner-approval'), hostInfo: 'durable' }).record;
          const preview = store.previewMemoryOperation(activity, store.inspectMemoryPresentation(activity, [record.recordId]).token, { kind: 'forget' });
          store.registerCorrectionDelivery(activity, preview.token);
          text = 'commit ' + preview.token + ' forget';
          invoke = input => store.recordCorrectionApproval(activity, preview.token, input);
          break;
        }
      }
      const eventId = target === 'body' ? compartment.source.eventId : compartment.attemptId;
      const path = join(value.sandbox.root, 'session.jsonl'), lines = readFileSync(path, 'utf8').trimEnd().split('\n');
      const index = lines.findIndex(line => JSON.parse(line).eventId === eventId);
      assert.ok(index > 0); lines[index] = JSON.stringify({ ...JSON.parse(lines[index]!), role: 'user', text });
      writeFileSync(path, lines.join('\n') + '\n');
      const input = archive.lookup(eventId)!;
      assert.equal(store.isCaptureOutput(activity, input), true);
      assert.throws(() => invoke(input), /^Error: source-derived$/u);
      assert.equal(store.readIntent(activity)!.eventId, intent.eventId);
      assert.doesNotThrow(() => invoke(archive.append(randomUUID(), text, 'user')));
    } finally { value.close(); }
  });

for (const target of ['body', 'reply', 'original'] as const) for (const depth of [1, 2])
  test('analysis evidence follows original identity through ' + depth + ' wrapper(s): ' + target, () => {
    const value = setup();
    try {
      const { store, activity, archive } = value.probe;
      const { run } = consumer(value);
      deliver(value, run, JSON.stringify({ result: 'pass', summary: 'Synthetic summary.' }));
      const compartment = store.readCompartment(activity, value.job.jobId);
      const intent = store.readIntent(activity)!, projectId = value.sandbox.fixture.projectId;
      let ref = target === 'original' ? value.job.range[0]!
        : archive.lookup(target === 'body' ? compartment.source.eventId : compartment.attemptId)!;
      assert.equal(store.isCaptureOutput(activity, ref), target !== 'original');
      let bodyOffset = 0;
      const body = 'Synthetic analysis handoff.';
      for (let layer = 0; layer < depth; layer++) {
        const excerpt = Array.from(archive.read(ref).text).slice(0, 10).join('');
        const artifactId = randomUUID();
        const header = { schema: 'analysis-artifact@1', kind: 'handoff', artifactId, version: 1,
          task: intent.goalInput, intentId: intent.intentId, supersedes: null, bodyHash: sha256(body), requestHash: sha256('synthetic-input'),
          evidence: [{ request: { ref, offset: 0, limit: 10 }, hash: sha256(excerpt), projectId }], coverage: { projects: [projectId], complete: false } };
        const prefix = '<!-- euler-analysis-artifact@1 ' + JSON.stringify(header) + ' -->\n\n';
        ref = archive.append(artifactId, prefix + body, 'assistant');
        bodyOffset = Array.from(prefix).length;
      }
      const publication = approvedSourceUnit(value.probe, { ref, projectId, kind: 'report-section', offset: bodyOffset, length: body.length });
      if (target !== 'original') {
        assert.throws(() => store.validateAnalysisSource(activity, ref), /^Error: source-derived$/u);
        assert.throws(() => store.publishSourceUnit(activity, publication), /^Error: source-derived$/u);
        assert.throws(() => store.captureMemory(activity, ref, body, { type: 'preference',
          scope: { kind: 'project', id: projectId, resolved: true }, appliesTo: [] }), /^Error: source-derived$/u);
        store.drainSourceProjection(activity);
        assert.equal(store.searchSources(activity, { query: 'handoff' }).results.length, 0);
      } else {
        assert.doesNotThrow(() => store.validateAnalysisSource(activity, ref));
        const unit = store.publishSourceUnit(activity, publication);
        assert.equal(store.captureMemory(activity, ref, body, { type: 'preference',
          scope: { kind: 'project', id: projectId, resolved: true }, appliesTo: [] }).record.lifecycle, 'candidate');
        const proposal = { target: 'synthetic-guidance', expectedChange: 'Use original evidence.', owner: value.sandbox.fixture.ownerId,
          scope: { kind: 'project' as const, id: projectId, resolved: true }, evidenceRefs: [], sourceUnits: [unit.unitId],
          evaluation: { schema: 'evaluation-contract@1' as const, level: 'L0' as const, assertions: ['Original evidence only.'] } };
        const approval = archive.append(randomUUID(), JSON.stringify({ schema: 'analysis-proposal-approval@1', proposal }));
        assert.equal(store.saveEvolutionProposal(activity, approval, proposal).sourceUnits![0], unit.unitId);
      }
    } finally { value.close(); }
  });

for (const target of ['body', 'reply'] as const) for (const field of ['task', 'supersedes', 'export'] as const)
  test('analysis metadata cannot reuse derived ' + field + ': ' + target, () => {
    const value = setup();
    try {
      const { store, activity, archive } = value.probe;
      const { run } = consumer(value);
      deliver(value, run, JSON.stringify({ result: 'pass', summary: 'Synthetic summary.' }));
      const compartment = store.readCompartment(activity, value.job.jobId), intent = store.readIntent(activity)!;
      const body = 'Synthetic handoff body.', projectId = value.sandbox.fixture.projectId;
      const header: AnalysisHeader = { schema: 'analysis-artifact@1', kind: 'handoff', artifactId: randomUUID(), version: 1,
        task: intent.goalInput, intentId: intent.intentId, supersedes: null, bodyHash: sha256(body), requestHash: sha256('synthetic-input'),
        evidence: [], coverage: { projects: [], complete: false } };
      let text = 'Synthetic task reference.', role: 'user' | 'assistant' = 'user';
      let selection: { unitId: string; hash: string }[] = [];
      if (field === 'supersedes') {
        text = '<!-- euler-analysis-artifact@1 ' + JSON.stringify(header) + ' -->\n\n' + body;
        role = 'assistant'; header.version = 2;
      } else if (field === 'export') {
        const source = archive.append(randomUUID(), 'Original selected source.');
        const unit = store.publishSourceUnit(activity, approvedSourceUnit(value.probe, { ref: source, projectId, kind: 'source', offset: 0, length: 10 }));
        selection = [{ unitId: unit.unitId, hash: unit.contentHash }];
        text = JSON.stringify({ schema: 'analysis-export-approval@1', selection });
        header.kind = 'export';
      }
      const eventId = target === 'body' ? compartment.source.eventId : compartment.attemptId;
      const path = join(value.sandbox.root, 'session.jsonl'), lines = readFileSync(path, 'utf8').trimEnd().split('\n');
      const index = lines.findIndex(line => JSON.parse(line).eventId === eventId);
      assert.ok(index > 0); lines[index] = JSON.stringify({ ...JSON.parse(lines[index]!), role, text });
      writeFileSync(path, lines.join('\n') + '\n');
      const derived = archive.lookup(eventId)!;
      assert.equal(store.isCaptureOutput(activity, derived), true);
      if (field === 'task') header.task = derived;
      else if (field === 'supersedes') header.supersedes = derived;
      else header.exportInputs = { selection, approval: derived };
      const prefix = '<!-- euler-analysis-artifact@1 ' + JSON.stringify(header) + ' -->\n\n';
      const wrapper = archive.append(randomUUID(), prefix + body, 'assistant');
      assert.throws(() => store.validateAnalysisSource(activity, wrapper), /^Error: source-derived$/u);
      assert.throws(() => store.publishSourceUnit(activity, approvedSourceUnit(value.probe, { ref: wrapper, projectId,
        kind: 'report-section', offset: Array.from(prefix).length, length: body.length })), /^Error: source-derived$/u);
    } finally { value.close(); }
  });

test('analysis version history remains usable beyond the evidence nesting limit', () => {
  const value = setup();
  try {
    const { store, activity, archive } = value.probe, artifacts = new AnalysisArtifacts(store, activity, archive);
    let prior = artifacts.saveHandoff({ eventId: randomUUID(), title: 'Synthetic history', markdown: 'Original v1', evidence: [] });
    for (let version = 2; version <= 20; version++) prior = artifacts.saveHandoff({ eventId: randomUUID(), title: 'Synthetic history',
      markdown: 'Original v' + version, evidence: [], supersedes: prior.ref });
    assert.equal(artifacts.read(prior.ref).version, 20);
    const unit = store.publishSourceUnit(activity, approvedSourceUnit(value.probe, { ref: prior.ref, projectId: value.sandbox.fixture.projectId,
      kind: 'report-section', offset: prior.bodyOffset, length: prior.body.length }));
    assert.equal(unit.contentHash, sha256('Original v20'));
  } finally { value.close(); }
});

test('an owner task can contain literal analysis syntax without becoming an artifact', () => {
  const sandbox = createSandbox(), probe = openProbe(sandbox);
  try {
    const text = '<!-- euler-analysis-artifact@1 explain this literal prefix';
    const input = probe.archive.append(randomUUID(), text);
    const intent = probe.store.transitionIntent(probe.activity, null, input, { status: 'active', step: 'explain' }, text);
    assert.equal(probe.store.readIntent(probe.activity)!.goal, text);
    assert.equal(probe.store.recoverIntent(probe.activity)!.eventId, intent.eventId);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('a compartment cannot be republished as a raw project source unit', () => {
  const value = setup();
  try {
    const { run } = consumer(value);
    deliver(value, run, JSON.stringify({ result: 'pass', summary: 'A synthetic summary.' }));
    const compartment = value.probe.store.readCompartment(value.probe.activity, value.job.jobId);
    const input = approvedSourceUnit(value.probe, { ref: compartment.source, kind: 'source',
      projectId: bindingOf(value.sandbox).projectId, offset: 0, length: 64 });
    assert.throws(() => value.probe.store.publishSourceUnit(value.probe.activity, input), /source-derived/);
  } finally { value.close(); }
});

test('an approval keeps its preceding complete proposal across incremental raw boundaries', () => {
  const value = setup(true);
  try {
    const proposal = value.agent.status().responses.at(-1)!.source;
    const preceding = value.probe.archive.read(proposal).text;
    const approval = value.agent.receive(randomUUID(), '同意');
    let job = value.job;
    for (const id of ['approved', 'continue']) {
      deliver(value, value.agent, { text: 'Continue the approved task.', calls: [{ id, name: 'controlled.echo', arguments: { text: id } }], stop: 'tools' });
      value.agent.startTool(id); value.agent.finishTool(id, 'Synthetic completed observation.');
      job = value.probe.store.queueHistorianBoundary(value.probe.activity, value.agent.runId, { minBytes: 1, maxBytes: 30000 })!;
    }
    value.agent.cancel();
    assert.ok(job.range.some(ref => ref.eventId === proposal.eventId));
    const { run } = consumer({ ...value, job });
    deliver(value, run, JSON.stringify({ result: 'pass', summary: 'The owner accepted the preceding proposal.' }));
    const compartment = value.probe.store.readCompartment(value.probe.activity, job.jobId);
    assert.equal(compartment.body.decisions.find(item => item.eventId === approval.eventId)!.precedingResponse, preceding);
  } finally { value.close(); }
});

test('an actual file approval and its presentation remain mandatory raw evidence', () => {
  const sandbox = createSandbox(), root = realpathSync.native(mkdtempSync(join(tmpdir(), 'euler-historian-files-')));
  const probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
  try {
    const binding = bindingOf(sandbox), { capability: _capability, ...agentRoute } = route;
    const source = probe.archive.append(randomUUID(), 'Owner binds this disposable synthetic file root; each write needs separate approval.', 'user');
    const files: FileCapability = { schema: 'file-capability@1', grantId: randomUUID(), binding,
      root: { path: root, identity: fileIdentity(root) }, source };
    const agent = new AgentRun(probe.store, probe.activity, { binding, source: probe.archive, files }, agentRoute, budget);
    agent.receive(randomUUID(), 'Write the synthetic approved fixture.');
    deliver({ probe }, agent, { text: 'Write this exact content.', calls: [{ id: 'write', name: 'file.write',
      arguments: { path: 'approved.txt', content: 'EXACT APPROVED CONTENT' } }], stop: 'tools' });
    const target = { path: join(root, 'approved.txt'), parent: files.root, identity: null };
    const presentation = agent.presentFile('write', target)!;
    agent.decideFile(presentation, 'approved');
    assert.ok(agent.startTool('write'));
    writeFileSync(target.path, presentation.content, { flag: 'wx' });
    agent.finishFile('write', { identity: fileIdentity(target.path), byteLength: Buffer.byteLength(presentation.content) });
    assert.equal(readFileSync(target.path, 'utf8'), presentation.content);
    deliver({ probe }, agent, { text: 'Approved write completed.', calls: [], stop: 'end' });
    const job = probe.store.queueHistorianBoundary(probe.activity, agent.runId, { minBytes: 1, maxBytes: 60000 })!;
    const file = agent.status().files[0]!, result = agent.status().tools[0]!.result!;
    for (const ref of [file.admission.source, file.approvalSource!, result.source])
      assert.ok(job.range.some(item => item.eventId === ref.eventId), 'complete file decision and result must share the raw range');
    const lease = probe.store.claimCaptureJob(probe.activity, job.jobId, budget, 30000)!;
    const historian = new CaptureRun(probe.store, lease, probe.archive, { historian: [route] }, undefined, 'capture-counting@1');
    deliver({ probe }, historian, JSON.stringify({ result: 'pass', summary: 'A synthetic approved file write.' }));
    const body = probe.store.readCompartment(probe.activity, job.jobId).body;
    assert.equal(body.decisions.find(item => item.eventId === file.approvalSource!.eventId)!.text, probe.archive.read(file.approvalSource!).text);
    assert.equal(body.results.find(item => item.eventId === file.admission.source.eventId)!.text, probe.archive.read(file.admission.source).text);
    assert.ok(body.citations.some(ref => ref.eventId === file.approvalSource!.eventId));
    assert.ok(body.citations.some(ref => ref.eventId === file.admission.source.eventId));
  } finally {
    probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true });
  }
});
