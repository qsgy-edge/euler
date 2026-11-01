import { writeSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { mock } from 'node:test';
import { CaptureRun, DEFAULT_BUDGET } from '@euler/core';
import type { ModelReply } from '@euler/core';
import { openProbe } from '../../src/probe.ts';
import { openSandbox } from '../../src/sandbox.ts';

const [root, callId, boundary] = process.argv.slice(2);
// The lease must cover the checkpoint; the parent uses real time to reclaim it.
mock.timers.enable({ apis: ['Date'], now: Date.now() });
const sandbox = openSandbox(root!), probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
const input = probe.archive.append(sandbox.fixture.eventId, '记住：项目测试应保留完整原始日志');
const job = probe.store.queueOwnerCapture(probe.activity, input);
const budget = { ...DEFAULT_BUDGET, maxModelAttempts: 8, maxToolCalls: 2, maxTotalTokens: 100000, contextLimit: 20000 };
const route = { provider: 'synthetic', model: 'capture-fixture', route: 'synthetic-capture', authNamespace: 'synthetic', capability: 'standard' as const };
const config = { proposer: [route], verifier: [route] };
const claim = () => new CaptureRun(probe.store, probe.store.claimCaptureJob(probe.activity, job.jobId, budget, 1000)!, probe.archive, config);
let run = claim();
function deliver(reply: ModelReply) {
  const request = run.nextModel()!;
  const attempt = run.startModel(request, request.payload);
  if (!run.maySend(attempt.attemptId, request.payload)) throw new Error('send-denied');
  probe.transport.send(request.payload, attempt);
  run.finishModel(attempt.attemptId, reply);
}
deliver({ text: JSON.stringify({ type: 'decision', content: '项目测试应保留完整原始日志' }), calls: [], stop: 'end' });
run = claim();
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql: string) {
  if (sql === 'COMMIT') {
    const row = this.prepare("SELECT payload FROM source_appends WHERE status='pending'").get();
    if (row) {
      const event = JSON.parse(JSON.parse(String(row.payload)).bytes);
      if (event.role === 'tool' && JSON.parse(event.text).callId === callId) {
        if (boundary === 'after') exec.call(this, sql);
        writeSync(1, JSON.stringify({ boundary, callId, eventId: event.eventId, output: event.text }) + '\n');
        process.kill(process.pid, 'SIGKILL'); throw new Error('process-was-not-killed');
      }
    }
  }
  return exec.call(this, sql);
};
deliver({ text: '', calls: [{ id: 'find', name: 'source.search', arguments: { query: '原始日志' } }], stop: 'tools' });
if (callId === 'read') deliver({ text: '', calls: [{ id: 'read', name: 'source.expand', arguments: { eventId: input.eventId, offset: 0, limit: 4096 } }], stop: 'tools' });
throw new Error('missed-crash-checkpoint');
