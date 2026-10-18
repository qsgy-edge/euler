import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { CaptureRun, DEFAULT_BUDGET } from '@euler/core';
import type { ModelReply } from '@euler/core';
import { createSandbox, createSandboxSession, bindingOf } from '../src/sandbox.ts';
import { drainCaptures } from '../src/capture.ts';
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

test('a project job consumed in another session keeps its response and tool output ownership across restart', async () => {
  const sandbox = createSandbox();
  const original = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  const source = original.archive.append(randomUUID(), '记住：跨会话合成证据');
  const job = original.store.queueOwnerCapture(original.activity, source);
  original.close();
  const consumer = { ...bindingOf(sandbox), sessionId: randomUUID() };
  const peer = { ...consumer, sessionId: randomUUID() };
  const outsider = { ...consumer, sessionId: randomUUID(), projectId: randomUUID() };
  for (const binding of [consumer, peer, outsider]) createSandboxSession(sandbox, binding);
  let probe = openProbe(sandbox, undefined, undefined, consumer, undefined, true);
  const budget = { ...DEFAULT_BUDGET, contextLimit: 20000, maxTotalTokens: 100000, maxModelAttempts: 8 };
  try {
    const visible = probe.archive.append(randomUUID(), '建议记住决定：前台合成提议', 'assistant');
    assert.equal(probe.store.isCaptureOutput(probe.activity, visible), false);
    let calls = 0;
    const results = await drainCaptures(probe, { batch: 1, deadlineMs: 30000, budget,
      config: { proposer: [route], verifier: [route] }, adapterVersion: 'capture-counting@1', host: {
        async *stream(request, _signal, send) {
          const attempt = send(request.payload); probe.transport.send(request.payload, attempt);
          const reply: ModelReply = calls === 0
            ? { text: JSON.stringify({ type: 'decision', content: '跨会话合成证据' }), calls: [], stop: 'end' }
            : calls === 1 ? { text: '', calls: [{ id: 'search', name: 'source.search', arguments: { query: '合成证据' } }], stop: 'tools' }
            : calls === 2 ? { text: '', calls: [{ id: 'expand', name: 'source.expand', arguments: { eventId: source.eventId, offset: 0, limit: 4096 } }], stop: 'tools' }
            : { text: JSON.stringify({ result: 'pass', evidence: [source] }), calls: [], stop: 'end' };
          // The response append can precede its step receipt; its durable attempt still owns it.
          const raw = probe.archive.append(attempt.attemptId, JSON.stringify(reply), 'assistant');
          assert.equal(probe.store.isCaptureOutput(probe.activity, raw), true);
          calls++;
          yield { kind: 'complete', reply };
        },
      } });
    assert.equal(calls, 4);
    assert.equal(results[0]!.jobId, job.jobId);
    assert.equal(results[0]!.record!.verification, 'verified');
    assert.equal(results[0]!.source.binding.sessionId, source.binding.sessionId);
    const outputs = probe.archive.events().filter(event => event.ack.eventId !== visible.eventId);
    assert.equal(outputs.length, 6);
    assert.equal(outputs.filter(event => event.role === 'tool').length, 2);
    probe.close(); probe = openProbe(sandbox, undefined, undefined, consumer, undefined, true);
    for (const event of outputs) {
      assert.equal(event.ack.binding.sessionId, consumer.sessionId);
      assert.equal(probe.store.isCaptureOutput(probe.activity, event.ack), true);
    }
    assert.equal(probe.archive.events().findLast(event => !probe.store.isCaptureOutput(probe.activity, event.ack))!.ack.eventId, visible.eventId);
    for (const binding of [peer, outsider]) {
      const other = openProbe(sandbox, undefined, undefined, binding, undefined, true);
      try {
        for (const event of outputs) {
          const copied = other.archive.append(event.ack.eventId, event.text, event.role);
          assert.equal(other.store.isCaptureOutput(other.activity, copied), false, 'a copied event ID cannot replace the recorded output binding');
          assert.throws(() => other.store.isCaptureOutput(other.activity, event.ack), /source-scope-mismatch/);
        }
      } finally { other.close(); }
    }
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
