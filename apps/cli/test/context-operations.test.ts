import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { AgentRun, DEFAULT_BUDGET, MemoryCorrections } from '@euler/core';
import { pumpAgent } from '../src/agent-pump.ts';
import { bindingOf } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';
import { rollbackFixture } from './support/memory-rollback.ts';

const limits = { ...DEFAULT_BUDGET, contextLimit: 9000, outputReserve: 256, safetyMargin: 256, maxModelAttempts: 6, maxTotalTokens: 200000 };

test('mixed settled memory operations remain bounded after restart without restoring old truth or truncating rollback members', async () => {
  const { sandbox, probe: initial, batch, candidates } = rollbackFixture(2);
  let probe = initial;
  try {
    const corrected = probe.store.rememberMemory(probe.activity, {
      input: probe.archive.append(randomUUID(), '记住偏好：CORRECT-T18 original value'), hostInfo: 'durable' }).record;
    const restored = probe.store.rememberMemory(probe.activity, {
      input: probe.archive.append(randomUUID(), '记住偏好：RESTORE-T18 stable value'), hostInfo: 'durable' }).record;
    const core = new MemoryCorrections(probe.store, probe.activity, probe.archive);
    const tokens: string[] = [];
    const preview = (text: string) => {
      const reply = core.handle(core.receive(text));
      assert.equal(reply.kind, 'preview'); if (reply.kind !== 'preview') throw new Error('preview-required');
      core.presented(reply.presentation); tokens.push(reply.presentation.token); return reply.presentation;
    };
    const settle = (text: string, expected: string) => {
      const reply = core.handle(core.receive(text));
      assert.equal(reply.kind === 'result' && reply.result.status, expected);
    };
    for (let round = 0; round < 2; round++) {
      const text = `CORRECT-T18 revision ${round}`;
      const correction = preview(`correct ${corrected.recordId} ${JSON.stringify(text)}`);
      settle(`commit ${correction.token} ${JSON.stringify(text)}`, 'committed');
      const forgotten = preview(`forget ${restored.recordId}`);
      settle(`commit ${forgotten.token} forget`, 'committed');
      assert.equal(probe.store.readMemory(probe.activity, restored.recordId).lifecycle, 'tombstoned');
      const restoration = preview(`restore ${restored.recordId}`);
      assert.notEqual(restoration.token, forgotten.token);
      settle(`commit ${restoration.token} restore`, 'committed');
      const obsolete = preview(`correct ${corrected.recordId} "discarded ${round}"`);
      const replacement = preview(`correct ${corrected.recordId} "cancelled ${round}"`);
      assert.equal(replacement.supersedesOperationId, obsolete.operationId);
      settle(`replay ${obsolete.token}`, 'superseded');
      settle(`cancel ${replacement.token}`, 'cancelled');
      assert.equal(probe.store.readMemory(probe.activity, corrected.recordId).content, text);
    }
    const rollback = preview(`rollback ${batch.batchId} ${batch.events.map(event => event.eventId).join(' ')}`);
    settle(`commit ${rollback.token} rollback`, 'committed');
    for (const token of tokens) {
      probe.store.acknowledgeCorrectionOwner(probe.activity, token);
      const delivery = probe.store.correctionDelivery(probe.activity, token);
      const summary = probe.store.correctionSummary(probe.activity, token);
      probe.store.acknowledgeCorrectionModel(probe.activity, token,
        probe.archive.append(delivery.summaryEventId, JSON.stringify(summary), 'tool'));
    }
    const canonical = [corrected.recordId, restored.recordId, ...candidates.map(record => record.recordId)]
      .map(id => probe.store.readMemory(probe.activity, id));
    const history = probe.store.correctionModelSummaries(probe.activity);
    assert.equal(history.length, tokens.length);
    assert.deepEqual(new Set(history.map(summary => summary.kind)), new Set(['correct', 'forget', 'restore', 'rollback']));
    assert.ok(history.some(summary => summary.status === 'superseded'));
    assert.ok(history.some(summary => summary.status === 'cancelled'));
    for (let pass = 0; pass < 2; pass++) {
      probe.store.drainSearchProjection(probe.activity);
      assert.deepEqual(canonical.map(record => probe.store.readMemory(probe.activity, record.recordId)), canonical);
      assert.deepEqual(probe.store.correctionModelSummaries(probe.activity), history);
      assert.throws(() => probe.store.assertRetrievedMemory(probe.activity, corrected), /memory-stale/);
      assert.throws(() => probe.store.assertRetrievedMemory(probe.activity, restored), /memory-stale/);
      assert.ok(candidates.every(record => probe.store.readMemory(probe.activity, record.recordId).lifecycle === 'candidate'));
      const run = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive },
        { provider: 'fake', model: 'bounded', route: 'fixture', authNamespace: 'synthetic' }, limits);
      run.receive(randomUUID(), 'Inspect current memory, retaining the settled operation receipt.');
      let turn = 0;
      await pumpAgent(run, { async *stream(request, _signal, send) {
        const payload = JSON.parse(request.payload);
        assert.ok(Buffer.byteLength(request.payload) + limits.outputReserve + limits.safetyMargin <= limits.contextLimit);
        assert.ok(payload.p1.operationArchive.omitted > 0);
        const latest = payload.p1.operationSummaries.at(-1);
        assert.equal(latest.kind, 'rollback'); assert.equal(latest.records.length, 2);
        assert.ok(latest.records.every((record: { lifecycle: string }) => record.lifecycle === 'candidate'));
        if (turn) {
          const page = JSON.parse(payload.p2.at(-1).results[0].modelResult);
          const facts = page.results.filter((item: { kind: string }) => item.kind === 'memory');
          if (turn === 2) assert.equal(facts[0]?.record.content, restored.content);
          else assert.equal(facts.length, 0);
        }
        send(request.payload); turn++;
        const query = ['CORRECT-T18', 'RESTORE-T18', '合成批次偏好'][turn - 1];
        yield { kind: 'complete', reply: query ? { text: '', stop: 'tools', calls: [
          { id: `query-${turn}`, name: 'memory.search', arguments: { query } },
        ] } : { text: 'Only current eligible memory remains available.', calls: [], stop: 'end' } };
      }, async execute() { throw new Error('unexpected-host-tool'); } });
      assert.equal(run.status().terminal, 'completed');
      if (pass === 0) { probe.close(); probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true); }
    }
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
