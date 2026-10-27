import { CaptureRun, DEFAULT_BUDGET } from '@euler/core';
import { mock } from 'node:test';
import { openProbe } from '../../src/probe.ts';
import { openSandbox } from '../../src/sandbox.ts';

const [root, point] = process.argv.slice(2);
// Keep the lease live until the intended crash; the parent uses real time for recovery.
mock.timers.enable({ apis: ['Date'], now: Date.now() });
const probe = openProbe(openSandbox(root!), undefined, undefined, undefined, undefined, true);
const source = probe.archive.append('ca710000-0000-4000-8000-000000000002', '记住：崩溃测试保留原始日志');
const job = probe.store.queueOwnerCapture(probe.activity, source);
const budget = { ...DEFAULT_BUDGET, contextLimit: 20000, maxTotalTokens: 100000, maxModelAttempts: 8 };
const route = { provider: 'synthetic', model: 'crash-fixture', route: 'synthetic-capture', authNamespace: 'synthetic', capability: 'standard' as const };
const lease = probe.store.claimCaptureJob(probe.activity, job.jobId, budget, 1000)!;
const run = new CaptureRun(probe.store, lease, probe.archive, { proposer: [route], verifier: [route] }, undefined, 'capture-counting@1');
const request = run.nextModel()!;
const attempt = run.startModel(request, request.payload);
if (point !== 'before-send') {
  if (!run.maySend(attempt.attemptId, request.payload)) throw new Error('send-denied');
  probe.transport.send(request.payload, attempt);
}
if (point === 'after-proposal') run.finishModel(attempt.attemptId,
  { text: JSON.stringify({ type: 'decision', content: '崩溃测试保留原始日志' }), calls: [], stop: 'end' });
process.kill(process.pid, 'SIGKILL');
