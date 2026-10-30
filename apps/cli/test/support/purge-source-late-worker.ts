import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentRun, CaptureRun, DEFAULT_BUDGET, sha256 } from '@euler/core';
import { bindingOf, openSandbox } from '../../src/sandbox.ts';
import { openProbe } from '../../src/probe.ts';

const [root, consumer] = process.argv.slice(2);
const sandbox = openSandbox(root!);
const budget = { ...DEFAULT_BUDGET, contextLimit: 40000, maxTotalTokens: 500000, maxModelAttempts: 12, maxToolCalls: 12 };
const route = { provider: 'synthetic', model: 'purge-late-fixture', route: 'fixture', authNamespace: 'synthetic', capability: 'standard' as const };
const probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
try {
  const { store, activity, archive } = probe;
  const source = archive.events().find(entry => entry.text === 'T21 source mem-1: synthetic fact zero.')!;
  let job;
  if (consumer === 'historian') {
    const { capability: _capability, ...agentRoute } = route;
    const foreground = new AgentRun(store, activity, { binding: bindingOf(sandbox), source: archive }, agentRoute, budget);
    foreground.receive(source.ack.eventId, source.text);
    const request = foreground.nextModel()!, attempt = foreground.startModel(request, request.payload);
    assert.equal(foreground.maySend(attempt.attemptId, request.payload), true);
    foreground.finishModel(attempt.attemptId, { text: 'T22a complete synthetic result.', calls: [], stop: 'end' });
    job = store.queueHistorianBoundary(activity, foreground.runId, { minBytes: 4096, maxBytes: 60000 })!;
  } else job = store.queueOwnerCapture(activity, archive.append(randomUUID(), '记住：仅处理 T22a 合成信息'));
  const lease = store.claimCaptureJob(activity, job.jobId, budget, 30000)!;
  const run = new CaptureRun(store, lease, archive, consumer === 'historian' ? { historian: [route] } : { proposer: [route], verifier: [route] });
  const request = run.nextModel()!, attempt = run.startModel(request, request.payload);
  assert.equal(run.maySend(attempt.attemptId, request.payload), true);
  probe.transport.send(request.payload, attempt);
  const coordinator = randomUUID(); store.beginMaintenance(coordinator);
  assert.equal(store.acquireMaintenance(coordinator).acquired, false);
  const path = join(sandbox.root, 'session.jsonl'), before = readFileSync(path);
  const observations: { action: string; reason: string }[] = [];
  for (const [action, call] of [
    ['append', () => archive.append(randomUUID(), 'T22a forbidden late archive body')],
    ['dispatch', () => store.requestMaySend(lease.activity, run.runId)],
    ['finish', () => run.finishModel(attempt.attemptId, { text: JSON.stringify({ result: 'pass', summary: 'T22a forbidden late summary', type: 'fact', content: 'T22a forbidden late memory' }), calls: [], stop: 'end' })],
  ] as const) {
    assert.throws(call, (error: Error) => { observations.push({ action, reason: error.message }); return /admission-closed|activity-stale/.test(error.message); });
  }
  assert.deepEqual(readFileSync(path), before);
  console.log(JSON.stringify({ event: 'late-source-blocked', consumer, observations, archiveHash: sha256(before), jobId: job.jobId }));
} finally { probe.close(); }
