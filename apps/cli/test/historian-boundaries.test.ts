import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentRun, CaptureRun, DEFAULT_BUDGET, fileIdentity } from '@euler/core';
import type { CaptureConfig, FileCapability, ModelReply } from '@euler/core';
import { createSandbox, bindingOf } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';
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

for (const result of ['block','evidence-gap']) test('a Historian ' + result + ' never uses the configured fallback or publishes a compartment', () => {
  const value = setup();
  try {
    const { run } = consumer(value);
    deliver(value, run, JSON.stringify({ result, reason: 'synthetic-negative' }));
    assert.equal(run.status().stage, 'blocked');
    assert.equal(run.nextModel(), null);
    assert.equal(value.probe.transport.count, 1);
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

test('a received response survives reopening before artifact publication without another lossy generation', () => {
  const value = setup();
  let reopened: ReturnType<typeof openProbe> | undefined, closed = false;
  try {
    const lease = value.probe.store.claimCaptureJob(value.probe.activity, value.job.jobId, budget, 30000)!;
    const source = new Proxy(value.probe.archive, { get(target, key) {
      if (key === 'append') return (id: string, ...args: Parameters<typeof target.append> extends [string, ...infer T] ? T : never) => {
        if (id === value.job.jobId) throw new Error('synthetic-publication-interrupted');
        return target.append(id, ...args);
      };
      const field = Reflect.get(target, key, target); return typeof field === 'function' ? field.bind(target) : field;
    } });
    const run = new CaptureRun(value.probe.store, lease, source, { historian: [route] });
    assert.throws(() => deliver(value, run, JSON.stringify({ result: 'pass', summary: 'A faithful synthetic summary.' })), /synthetic-publication-interrupted/);
    value.probe.store.pauseCapture(lease);
    value.probe.close(); closed = true;
    reopened = openProbe(value.sandbox, budget, undefined, undefined, undefined, true);
    const next = reopened.store.claimCaptureJob(reopened.activity, value.job.jobId, budget, 30000)!;
    const recovered = new CaptureRun(reopened.store, next, reopened.archive, { historian: [route] });
    assert.equal(recovered.nextModel(), null);
    assert.equal(recovered.status().stage, 'complete');
    assert.equal(reopened.store.requestStatus(next.activity, recovered.runId).attempts.length, 1);
    assert.equal(reopened.store.readCompartment(reopened.activity, value.job.jobId).body.summary, 'A faithful synthetic summary.');
  } finally { reopened?.close(); if (!closed) value.probe.close(); value.release(); rmSync(value.sandbox.root, { recursive: true, force: true }); }
});

test('a damaged optional compartment falls back to a raw window with an explicit gap', () => {
  const value = setup(true), path = join(value.sandbox.root, 'session.jsonl');
  let saved: Buffer | undefined;
  try {
    const { run } = consumer(value);
    deliver(value, run, JSON.stringify({ result: 'pass', summary: 'A faithful synthetic summary.' }));
    const compartment = value.probe.store.readCompartment(value.probe.activity, value.job.jobId);
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
    writeFileSync(path, saved); saved = undefined; value.agent.cancel();
  } finally { if (saved) writeFileSync(path, saved); value.close(); }
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
