import { randomUUID } from 'node:crypto';
import { writeSync } from 'node:fs';
import { AgentRun, CaptureRun, DEFAULT_BUDGET } from '@euler/core';
import { openProbe } from '../../src/probe.ts';
import { openSandbox, bindingOf } from '../../src/sandbox.ts';

const [root, point] = process.argv.slice(2);
const sandbox = openSandbox(root!);
const budget = { ...DEFAULT_BUDGET, contextLimit: 20000, maxTotalTokens: 100000, maxModelAttempts: 8 };
const route = { provider: 'synthetic', model: 'historian-crash-fixture', route: 'fixture', authNamespace: 'synthetic' };
const probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
const agent = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive }, route, budget);
agent.receive(randomUUID(), 'Synthetic crash-boundary decision: preserve result 47.');
const request = agent.nextModel()!, attempt = agent.startModel(request, request.payload);
agent.maySend(attempt.attemptId, request.payload);
agent.finishModel(attempt.attemptId, { text: 'Synthetic completed result 47.', calls: [], stop: 'end' });
let jobId: string | null = null;
function crash(): never {
  writeSync(1, JSON.stringify({ event: 'historian-crash', point, runId: agent.runId, jobId }) + '\n');
  process.kill(process.pid, 'SIGKILL'); throw new Error('process-was-not-killed');
}
if (point === 'after-raw') crash();
const job = probe.store.queueHistorianBoundary(probe.activity, agent.runId, { minBytes: 4096, maxBytes: 60000 })!;
jobId = job.jobId;
const lease = probe.store.claimCaptureJob(probe.activity, jobId, budget, 1000)!;
const source = new Proxy(probe.archive, { get(target, key) {
  if (key === 'append') return (id: string, ...args: Parameters<typeof target.append> extends [string, ...infer T] ? T : never) => {
    if (id === jobId && point === 'after-reply') crash();
    const result = target.append(id, ...args);
    if (id === jobId && point === 'after-body') crash();
    return result;
  };
  const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
} });
const historian = new CaptureRun(probe.store, lease, source, { historian: [{ ...route, capability: 'standard' }] }, undefined, 'capture-counting@1');
const pending = historian.nextModel()!, actual = historian.startModel(pending, pending.payload);
if (point === 'before-send') crash();
historian.maySend(actual.attemptId, pending.payload); probe.transport.send(pending.payload, actual);
if (point === 'after-send') crash();
historian.finishModel(actual.attemptId, { text: JSON.stringify({ result: 'pass', summary: 'Synthetic result retained.' }), calls: [], stop: 'end' });
crash();
