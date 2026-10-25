import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { AgentRun, CaptureRun, DEFAULT_BUDGET } from '@euler/core';
import type { NeutralRequest } from '@euler/core';
import { HttpModelTransport } from '../src/model-transport.ts';
import { bindingOf, createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

const route = { provider: 'synthetic', model: 'historian-fixture', route: 'fixture', authNamespace: 'synthetic', capability: 'standard' as const };
const budget = { ...DEFAULT_BUDGET, contextLimit: 40000, maxTotalTokens: 500000, maxModelAttempts: 12, maxToolCalls: 12 };

function completeTurn(run: AgentRun, id: string, text: string) {
  const request = run.nextModel()!;
  assert.ok(request);
  const attempt = run.startModel(request, request.payload);
  assert.equal(run.maySend(attempt.attemptId, request.payload), true);
  run.finishModel(attempt.attemptId, { text, calls: [{ id, name: 'controlled.echo', arguments: { text: id } }], stop: 'tools' });
  run.startTool(id); run.finishTool(id, `Result ${id}: exact value 47; fixture.ts:19`);
}

test('background generation leaves the prefix unchanged until a complete window boundary selects the compartment', () => {
  const sandbox = createSandbox(), probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
  let stopObserving: (() => void) | undefined;
  try {
    const { capability: _capability, ...agentRoute } = route;
    const run = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive }, agentRoute, budget);
    stopObserving = run.observeExecution();
    run.receive(randomUUID(), 'Retain this synthetic goal.');
    completeTurn(run, 'first', 'Long raw observation. '.repeat(240));
    completeTurn(run, 'recent', 'The most recent pair remains complete.');
    const before = run.status().cacheEpoch;
    const job = probe.store.queueHistorianBoundary(probe.activity, run.runId, { minBytes: 1000, maxBytes: 30000 })!;
    const lease = probe.store.claimCaptureJob(probe.activity, job.jobId, budget, 30000)!;
    const historian = new CaptureRun(probe.store, lease, probe.archive, { historian: [route] });
    const request = historian.nextModel()!;
    const attempt = historian.startModel(request, request.payload);
    assert.equal(historian.maySend(attempt.attemptId, request.payload), true);
    historian.finishModel(attempt.attemptId, { text: JSON.stringify({ result: 'pass', summary: 'A completed synthetic observation.' }), calls: [], stop: 'end' });
    assert.deepEqual(run.status().cacheEpoch, before);
    assert.equal(run.status().windows.length, 1);
    run.newWindow();
    const selected = run.nextModel()!;
    const payload = JSON.parse(selected.payload);
    assert.equal(payload.p1.compartments[0].summary, 'A completed synthetic observation.');
    assert.equal(payload.p2.length, 1);
    assert.equal(payload.p2[0].results[0].callId, 'recent');
    assert.notEqual(run.status().cacheEpoch!.cacheEpoch, before!.cacheEpoch);
    assert.match(JSON.stringify(payload.p1.compartments[0].results), /Result first/);
    const selectedAttempt = run.startModel(selected, selected.payload);
    assert.equal(run.maySend(selectedAttempt.attemptId, selected.payload), true);
    run.finishModel(selectedAttempt.attemptId, { text: 'Done.', calls: [], stop: 'end' });
    assert.equal(run.status().terminal, 'completed');
  } finally { stopObserving?.(); probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

for (const http of [false, true]) for (const largeTail of [false, true])
  test(`compartment selection follows the complete request budget, HTTP=${http}, large mandatory tail=${largeTail}`, () => {
  const sandbox = createSandbox(), probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
  let stopObserving: (() => void) | undefined;
  try {
    const { capability: _capability, ...agentRoute } = route;
    const transport = http ? new HttpModelTransport({ api: 'openai-completions', provider: route.provider, id: route.model,
      name: 'Fixture', baseUrl: 'http://127.0.0.1:1/v1', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: budget.contextLimit, maxTokens: budget.outputReserve }, budget, () => 'synthetic-header') : null;
    if (http) agentRoute.route = 'http://127.0.0.1:1/v1';
    let assembled: NeutralRequest | undefined;
    const encode = (value: NeutralRequest) => transport ? transport.encode(value) : JSON.stringify(value);
    const run = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive,
      encode: value => { assembled = structuredClone(value); return encode(value); } }, agentRoute, budget);
    stopObserving = run.observeExecution();
    run.receive(randomUUID(), 'Synthetic exact decision: ' + 'D'.repeat(4000));
    completeTurn(run, 'first', 'Long raw observation. '.repeat(240));
    completeTurn(run, 'recent', 'The most recent pair remains complete.');
    const job = probe.store.queueHistorianBoundary(probe.activity, run.runId, { minBytes: 1000, maxBytes: 30000 })!;
    const lease = probe.store.claimCaptureJob(probe.activity, job.jobId, budget, 30000)!;
    const historian = new CaptureRun(probe.store, lease, probe.archive, { historian: [route] });
    const request = historian.nextModel()!, attempt = historian.startModel(request, request.payload);
    assert.equal(historian.maySend(attempt.attemptId, request.payload), true);
    historian.finishModel(attempt.attemptId, { text: JSON.stringify({ result: 'pass', summary: 'S'.repeat(8000) }), calls: [], stop: 'end' });
    const compartment = probe.store.readCompartment(probe.activity, job.jobId);
    assert(Buffer.byteLength(JSON.stringify(compartment.body)) > (budget.contextLimit - budget.outputReserve - budget.safetyMargin) / 3);
    if (largeTail) run.receive(randomUUID(), 'Current mandatory input: ' + 'T'.repeat(16000));
    run.newWindow();
    const next = run.nextModel()!; assert.ok(next);
    const payload = assembled!;
    const withCompartment = { ...payload, p1: { ...payload.p1, compartments: [compartment.body] } };
    const wouldFit = Buffer.byteLength(encode(withCompartment)) + budget.outputReserve + budget.safetyMargin <= budget.contextLimit;
    assert.equal(wouldFit, !largeTail);
    assert.equal('compartments' in payload.p1, !largeTail);
    assert(Buffer.byteLength(next.payload) + budget.outputReserve + budget.safetyMargin <= budget.contextLimit);
    assert.equal(payload.p2.at(-1)!.results[0]!.callId, 'recent');
    if (largeTail) assert.match(payload.p3.messages[0]!.content, /^Current mandatory input: T{16000}$/);
    const nextAttempt = run.startModel(next, next.payload);
    assert.equal(run.maySend(nextAttempt.attemptId, next.payload), true);
    run.finishModel(nextAttempt.attemptId, { text: 'Complete within the available budget.', calls: [], stop: 'end' });
  } finally { stopObserving?.(); probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('a stable compartment retains exact decisions, results and source citations without regenerating the same raw range', () => {
  const sandbox = createSandbox();
  let probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
  try {
    const { capability: _capability, ...agentRoute } = route;
    const run = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive }, agentRoute, budget);
    run.receive(randomUUID(), 'Synthetic decision: keep the Windows-only boundary and the exact test result.');
    completeTurn(run, 'one', 'Synthetic investigation detail. '.repeat(200));
    completeTurn(run, 'two', 'Continue from the exact result.');
    const job = probe.store.queueHistorianBoundary(probe.activity, run.runId, { minBytes: 1000, maxBytes: 30000 })!;
    assert.ok(job);
    assert.equal(job.consumer, 'historian');
    assert.equal(probe.store.queueHistorianBoundary(probe.activity, run.runId, { minBytes: 1000, maxBytes: 30000 })!.jobId, job.jobId);
    run.cancel();
    const lease = probe.store.claimCaptureJob(probe.activity, job.jobId, budget, 30000)!;
    const historian = new CaptureRun(probe.store, lease, probe.archive, { historian: [route] });
    const request = historian.nextModel()!;
    const input = JSON.parse(JSON.parse(request.payload).p3.messages[0].content);
    assert.match(JSON.stringify(input), /Synthetic investigation detail/);
    assert.equal(JSON.parse(request.payload).p3.intent.step, 'historian');
    const attempt = historian.startModel(request, request.payload);
    assert.equal(historian.maySend(attempt.attemptId, request.payload), true);
    historian.finishModel(attempt.attemptId, { text: JSON.stringify({ result: 'pass', summary: 'The synthetic investigation completed its first observation.' }), calls: [], stop: 'end' });
    const compartment = probe.store.readCompartment(probe.activity, job.jobId);
    assert.match(JSON.stringify(compartment.body.decisions), /Windows-only/);
    assert.match(JSON.stringify(compartment.body.results), /exact value 47; fixture.ts:19/);
    assert.deepEqual(compartment.body.citations, job.range);
    assert.equal(compartment.attemptId, attempt.attemptId);
    assert.equal(probe.store.claimCaptureJob(probe.activity, job.jobId, budget, 30000), null);
    assert.equal(historian.nextModel(), null);
    assert.equal(probe.store.readCaptureJob(probe.activity, job.jobId).record, null);
    probe.close(); probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
    assert.deepEqual(probe.store.readCompartment(probe.activity, job.jobId), compartment);
    assert.equal(probe.store.claimCaptureJob(probe.activity, job.jobId, budget, 30000), null);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
