import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { CaptureRun, DEFAULT_BUDGET } from '@euler/core';
import type { ModelReply } from '@euler/core';
import { createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

const route = { provider: 'synthetic', model: 'capture-fixture', route: 'synthetic-capture', authNamespace: 'synthetic', capability: 'standard' as const };

test('the background run records real job attempts and gives the Verifier a fresh source-tool context', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const source = probe.archive.append(randomUUID(), '记住：项目测试应保留完整原始日志');
    const job = probe.store.queueOwnerCapture(probe.activity, source);
    const lease = probe.store.claimCaptureJob(probe.activity, job.jobId,
      { ...DEFAULT_BUDGET, maxModelAttempts: 8, maxTotalTokens: 100000, contextLimit: 20000 }, 30000)!;
    let run = new CaptureRun(probe.store, lease, probe.archive, { proposer: [route], verifier: [route] });
    const deliver = (reply: ModelReply) => {
      let request = run.nextModel();
      if (!request && run.status().stage === 'verifying') {
        const next = probe.store.claimCaptureJob(probe.activity, job.jobId,
          { ...DEFAULT_BUDGET, maxModelAttempts: 8, maxTotalTokens: 100000, contextLimit: 20000 }, 30000)!;
        run = new CaptureRun(probe.store, next, probe.archive, { proposer: [route], verifier: [route] });
        request = run.nextModel();
      }
      assert(request);
      const attempt = run.startModel(request, request.payload);
      assert.equal(run.maySend(attempt.attemptId, request.payload), true);
      probe.transport.send(request.payload, attempt);
      run.finishModel(attempt.attemptId, reply);
      return JSON.parse(request.payload);
    };
    const proposer = deliver({ text: JSON.stringify({ type: 'decision', content: '项目测试应保留完整原始日志' }), calls: [], stop: 'end' });
    assert.match(JSON.stringify(proposer), /记住/);
    const verifier = deliver({ text: '', calls: [{ id: 'find', name: 'source.search', arguments: { query: '原始日志' } }], stop: 'tools' });
    assert.equal(verifier.p2.length, 0);
    assert(verifier.p0.tools.every((tool: { available: boolean }) => tool.available));
    assert.deepEqual(verifier.p0.tools.find((tool: { name: string }) => tool.name === 'source.expand').parameters.required, ['eventId','offset','limit']);
    assert.doesNotMatch(JSON.stringify(verifier.p3), /记住：/);
    deliver({ text: '', calls: [{ id: 'read', name: 'source.expand', arguments: { eventId: source.eventId, offset: 0, limit: 4096 } }], stop: 'tools' });
    deliver({ text: JSON.stringify({ result: 'pass', evidence: [source] }), calls: [], stop: 'end' });
    assert.equal(run.nextModel(), null);
    const result = probe.store.readCaptureJob(probe.activity, job.jobId);
    assert.equal(result.record!.verification, 'verified');
    assert.equal(result.record!.lifecycle, 'candidate');
    const ledger = probe.store.requestStatus(lease.activity, run.runId);
    assert.equal(ledger.run.ownerKind, 'job');
    assert.equal(ledger.run.ownerId, job.jobId);
    assert.equal(ledger.attempts.length, 4);
    assert(ledger.attempts.every(attempt => attempt.outcome === 'received'));
    assert.equal(probe.transport.count, 4);
    assert.doesNotMatch(JSON.stringify(ledger.events), /项目测试应保留完整原始日志/);
    assert.equal(probe.store.listHostInfo(probe.activity).length, 0);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
