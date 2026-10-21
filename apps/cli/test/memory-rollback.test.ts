import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { MemoryCorrections } from '@euler/core';
import { bindingOf, createSandboxSession } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';
import { rollbackFixture } from './support/memory-rollback.ts';

function fixture(count = 2) {
  const { sandbox, probe, candidates, batch } = rollbackFixture(count);
  const core = new MemoryCorrections(probe.store, probe.activity, probe.archive);
  const select = (eventIds = batch.events.map(event => event.eventId), batchId = batch.batchId) => {
    const reply = core.handle(core.receive(`rollback ${batchId} ${eventIds.join(' ')}`));
    assert.equal(reply.kind, 'preview');
    if (reply.kind !== 'preview') throw new Error('preview required');
    return reply.presentation;
  };
  const result = (text: string) => {
    const reply = core.handle(core.receive(text));
    assert.equal(reply.kind, 'result');
    if (reply.kind !== 'result') throw new Error('result required');
    return reply;
  };
  return { sandbox, probe, core, batch, candidates, select, result,
    close() { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); } };
}

test('selection is exact: empty, duplicate, foreign and manually corrected events cannot be submitted', () => {
  const f = fixture();
  try {
    assert.equal(f.result(`rollback ${f.batch.batchId}`).result.status, 'invalid_identity');
    assert.equal(f.result(`rollback ${f.batch.batchId} ${f.batch.events[0]!.eventId} ${f.batch.events[0]!.eventId}`).result.status, 'invalid_identity');
    assert.equal(f.result(`rollback ${f.batch.batchId} ${f.batch.events[0]!.eventId} ${randomUUID()}`).result.status, 'invalid_identity');
    const event = f.batch.events[0]!;
    const source = f.probe.archive.append(randomUUID(), 'Owner correction');
    const corrected = f.probe.store.correctMemory(f.probe.activity, event.recordId, event.after, source, 'Owner correction');
    assert.equal(f.result(`rollback ${f.batch.batchId} ${corrected.eventId}`).result.status, 'invalid_identity');
    assert.equal(f.result(`rollback ${f.batch.batchId} ${event.eventId}`).result.status, 'stale');
    assert.equal(f.probe.store.recoverMemoryOperations(f.probe.activity).length, 0);
  } finally { f.close(); }
});

test('rollback rejects fabricated, buffered, substituted and missing approval, and supports explicit cancellation', () => {
  const f = fixture();
  try {
    const preview = f.select(), text = `commit ${preview.token} rollback`;
    const early = f.core.receive(text);
    assert.equal(f.core.handle({ eventId: early.eventId }).kind === 'result', true);
    f.core.presented(preview);
    const rejected = f.core.handle(early);
    assert.equal(rejected.kind === 'result' && rejected.result.status, 'unavailable');
    assert.equal(f.result(`commit ${preview.token} restore`).result.status, 'invalid_identity');
    assert.equal(f.result(`commit ${preview.token}`).result.status, 'invalid_identity');
    const substituted = f.core.handle(f.core.receive(`rollback ${f.batch.batchId} ${preview.eventIds.join(' ')}`), {
      id: randomUUID(), name: 'memory.preview', arguments: { operation: 'rollback', batchId: f.batch.batchId, eventIds: [preview.eventIds[0]] },
    });
    assert.equal(substituted.kind === 'result' && substituted.result.status, 'invalid_identity');
    assert.equal(f.result(`cancel ${preview.token}`).result.status, 'cancelled');
    assert.equal(f.result(text).result.status, 'settled');
    assert.deepEqual(f.probe.store.listEligibleMemories(f.probe.activity).map(record => record.recordId).sort(),
      f.batch.events.map(event => event.recordId).sort());
    const next = f.select(), replacement = f.select([f.batch.events[1]!.eventId]);
    assert.equal(replacement.supersedesOperationId, next.operationId);
    assert.equal(f.result(`commit ${next.token} rollback`).result.status, 'settled');
    assert.equal(f.result(`replay ${next.token}`).result.status, 'superseded');
  } finally { f.close(); }
});

test('another card cannot inherit success exemptions or silently shrink its selection', () => {
  const f = fixture();
  const binding = { ...bindingOf(f.sandbox), sessionId: randomUUID() }; createSandboxSession(f.sandbox, binding);
  const other = openProbe(f.sandbox, undefined, undefined, binding, undefined, true);
  const core = new MemoryCorrections(other.store, other.activity, other.archive);
  try {
    const loser = f.select(); f.core.presented(loser);
    const first = f.batch.events[0]!, second = f.batch.events[1]!;
    const preview = core.handle(core.receive(`rollback ${f.batch.batchId} ${first.eventId}`));
    assert.equal(preview.kind, 'preview'); if (preview.kind !== 'preview') throw new Error('preview required');
    core.presented(preview.presentation);
    const winner = core.handle(core.receive(`commit ${preview.presentation.token} rollback`));
    assert.equal(winner.kind === 'result' && winner.result.status, 'committed');
    const stale = f.result(`commit ${loser.token} rollback`);
    assert.equal(stale.result.status, 'stale'); assert.deepEqual(stale.result.receiptIds, []);
    assert.equal(f.probe.store.readMemory(f.probe.activity, second.recordId).headEventId, second.eventId);
    assert.deepEqual(f.probe.store.readMemoryPresentation(f.probe.activity, loser.token).eventIds, loser.eventIds);
    const remaining = f.select([second.eventId]); f.core.presented(remaining);
    assert.equal(f.result(`commit ${remaining.token} rollback`).result.status, 'committed');
    assert.equal(core.result(preview.presentation.token).kind === 'result', true);
    assert.equal(other.store.memoryOperationStatus(other.activity, preview.presentation.token).status, 'committed');
  } finally { other.close(); f.close(); }
});

test('fresh previews undo B then A while a pre-B card stays stale and revisions are never duplicated', () => {
  const f = fixture(1);
  const binding = { ...bindingOf(f.sandbox), sessionId: randomUUID() }; createSandboxSession(f.sandbox, binding);
  const other = openProbe(f.sandbox, undefined, undefined, binding, undefined, true);
  const core = new MemoryCorrections(other.store, other.activity, other.archive);
  try {
    const original = f.batch.events[0]!.after;
    const aSource = f.probe.archive.append(randomUUID(), 'A source');
    const a = f.probe.store.reviseMemory(f.probe.activity, original.recordId, original, aSource, 'A', [aSource]);
    f.probe.store.registerHostInfo(f.probe.activity);
    const aBatch = f.probe.store.listHostInfo(f.probe.activity).at(-1)!.batchId;
    const old = core.handle(core.receive(`rollback ${aBatch} ${a.eventId}`));
    assert.equal(old.kind, 'preview'); if (old.kind !== 'preview') throw new Error('preview required');
    core.presented(old.presentation);
    const bSource = f.probe.archive.append(randomUUID(), 'B source');
    const b = f.probe.store.reviseMemory(f.probe.activity, original.recordId, a.record, bSource, 'B', [bSource]);
    f.probe.store.registerHostInfo(f.probe.activity);
    const bBatch = f.probe.store.listHostInfo(f.probe.activity).at(-1)!.batchId;
    assert.equal(f.result(`rollback ${bBatch} ${a.eventId} ${b.eventId}`).result.status, 'invalid_identity');
    const undoB = f.select([b.eventId!], bBatch); f.core.presented(undoB);
    assert.equal(f.result(`commit ${undoB.token} rollback`).result.status, 'committed');
    const rejected = core.handle(core.receive(`commit ${old.presentation.token} rollback`));
    assert.equal(rejected.kind === 'result' && rejected.result.status, 'stale');
    const receiptB = f.probe.store.rollbackReceipt(f.probe.activity, undoB.token);
    const undoA = f.select([a.eventId!], aBatch); f.core.presented(undoA);
    assert.equal(f.result(`commit ${undoA.token} rollback`).result.status, 'committed');
    const current = f.probe.store.readMemory(f.probe.activity, original.recordId);
    assert.equal(current.revisionId, original.revisionId); assert.equal(current.content, original.content);
    assert.notEqual(current.headEventId, original.headEventId);
    f.probe.store.forgetMemory(f.probe.activity, current.recordId, current);
    assert.deepEqual(f.probe.store.rollbackReceipt(f.probe.activity, undoB.token), receiptB);
    const history = f.probe.store.inspectMemory(f.probe.activity, original.recordId).history;
    assert.equal(history.filter(event => event.kind === 'rollback').length, 2);
    assert.equal(new Set(history.map(event => JSON.parse(event.payload).after.revisionId)).size, 3);
  } finally { other.close(); f.close(); }
});

test('failure on the last member rolls back all changes, outboxes and receipts', () => {
  const f = fixture(), db = new DatabaseSync(join(f.sandbox.root, 'probe.sqlite'));
  try {
    const preview = f.select(); f.core.presented(preview);
    const histories = f.batch.events.map(event => f.probe.store.inspectMemory(f.probe.activity, event.recordId).history);
    db.exec(`CREATE TRIGGER fail_last BEFORE INSERT ON projection_jobs WHEN NEW.kind='search'
      AND json_extract(NEW.payload,'$.events[0].recordId')='${f.batch.events[1]!.recordId}'
      BEGIN SELECT RAISE(ABORT,'injected-last-member-failure'); END;`);
    const reply = f.result(`commit ${preview.token} rollback`);
    assert.equal(reply.result.status, 'error'); assert.equal(reply.canonical, 'unchanged');
    assert.deepEqual(reply.result.receiptIds, []);
    for (const [index, event] of f.batch.events.entries()) {
      assert.deepEqual(f.probe.store.readMemory(f.probe.activity, event.recordId), event.after);
      assert.deepEqual(f.probe.store.inspectMemory(f.probe.activity, event.recordId).history, histories[index]);
    }
  } finally { db.close(); f.close(); }
});

test('historical restore target must still have valid source evidence at commit', () => {
  const f = fixture(1);
  try {
    const original = f.batch.events[0]!.after;
    const source = f.probe.archive.append(randomUUID(), 'Current evidence');
    const revision = f.probe.store.reviseMemory(f.probe.activity, original.recordId, original, source, 'Current', [source]);
    f.probe.store.registerHostInfo(f.probe.activity);
    const batchId = f.probe.store.listHostInfo(f.probe.activity).at(-1)!.batchId;
    const preview = f.select([revision.eventId!], batchId); f.core.presented(preview);
    const archive = join(f.sandbox.root, 'session.jsonl');
    writeFileSync(archive, readFileSync(archive, 'utf8').replace('合成批次来源 0', '合成批次来源 X'));
    const reply = f.result(`commit ${preview.token} rollback`);
    assert.equal(reply.result.status, 'stale'); assert.deepEqual(reply.result.receiptIds, []);
    assert.equal(f.probe.store.correctionSummary(f.probe.activity, preview.token).status, 'stale');
  } finally { f.close(); }
});

for (const failure of ['missing-event', 'incomplete-event', 'duplicate-target'] as const)
test('selected batch integrity failure settles without changing other members: ' + failure, () => {
  const f = fixture(), db = new DatabaseSync(join(f.sandbox.root, 'probe.sqlite'));
  try {
    const preview = f.select(); f.core.presented(preview);
    const event = f.batch.events[0]!;
    if (failure === 'missing-event') {
      db.exec('PRAGMA foreign_keys=OFF; DROP TRIGGER immutable_memory_events_delete');
      db.prepare('DELETE FROM memory_events WHERE event_id=?').run(event.eventId);
    } else if (failure === 'incomplete-event') {
      db.exec('DROP TRIGGER immutable_memory_events_update');
      db.prepare('UPDATE memory_events SET before_snapshot=NULL WHERE event_id=?').run(event.eventId);
    } else {
      db.exec('DROP TRIGGER immutable_activation_batches_update');
      const changed = JSON.parse(f.batch.payload); changed.events[1] = changed.events[0];
      const payload = JSON.stringify(changed);
      db.prepare('UPDATE activation_batches SET payload=?,payload_hash=? WHERE batch_id=?')
        .run(payload, createHash('sha256').update(payload).digest('hex'), f.batch.batchId);
    }
    const reply = f.result(`commit ${preview.token} rollback`);
    assert.equal(reply.result.status, 'stale'); assert.deepEqual(reply.result.receiptIds, []);
    assert.equal(f.result(`commit ${preview.token} rollback`).result.status, 'settled');
    assert.deepEqual(f.probe.store.readMemory(f.probe.activity, f.batch.events[1]!.recordId), f.batch.events[1]!.after);
    assert.equal(f.probe.store.correctionSummary(f.probe.activity, preview.token).status, 'stale');
  } finally { db.close(); f.close(); }
});

test('expired historical revision cannot be restored after preview', t => {
  const f = fixture(1);
  try {
    const now = Date.now(); t.mock.timers.enable({ apis: ['Date'], now });
    const source = f.probe.archive.append(randomUUID(), '短期事实');
    const candidate = f.probe.store.captureMemory(f.probe.activity, source, '短期事实', { type: 'fact',
      scope: f.candidates[0]!.scope, appliesTo: [], validUntil: new Date(now + 1000).toISOString() }).record;
    const verified = f.probe.store.verifyMemory(f.probe.activity, candidate.recordId, candidate, 'pass', [source]).record;
    const original = f.probe.store.activateMemory(f.probe.activity, verified.recordId, verified).record;
    const replacementSource = f.probe.archive.append(randomUUID(), '更新事实');
    const revised = f.probe.store.reviseMemory(f.probe.activity, original.recordId, original, replacementSource, '更新事实', [replacementSource]);
    f.probe.store.registerHostInfo(f.probe.activity);
    const batchId = f.probe.store.listHostInfo(f.probe.activity).at(-1)!.batchId;
    const preview = f.select([revised.eventId!], batchId); f.core.presented(preview);
    t.mock.timers.tick(1001);
    const reply = f.result(`commit ${preview.token} rollback`);
    assert.equal(reply.result.status, 'stale'); assert.deepEqual(reply.result.receiptIds, []);
    assert.equal(f.probe.store.readMemory(f.probe.activity, original.recordId).revisionId, revised.record.revisionId);
  } finally { f.close(); }
});

test('the largest supported batch has a bounded model summary without dropping owner receipt members', () => {
  const f = fixture(32);
  try {
    const preview = f.select(); f.core.presented(preview);
    const reply = f.result(`commit ${preview.token} rollback`);
    assert.equal(reply.result.status, 'committed');
    assert.equal(reply.result.receiptIds.length, 32);
    const summary = f.probe.store.correctionSummary(f.probe.activity, preview.token);
    assert.deepEqual(summary.records.map(record => record.recordId), preview.targets.map(record => record.recordId));
    assert.ok(summary.records.every(record => record.revision === 1 && record.lifecycle === 'candidate' && record.verification === 'verified'));
    assert.ok(Buffer.byteLength(JSON.stringify(summary)) <= 8192);
    assert.equal('recordCount' in summary && summary.recordCount, 32);
    assert.equal('truncated' in summary, false);
    assert.equal(JSON.stringify(summary).includes('合成批次偏好'), false);
  } finally { f.close(); }
});

test('changed batch bytes settle the whole selection, keep the frozen preview, and require reselection', () => {
  const f = fixture(), db = new DatabaseSync(join(f.sandbox.root, 'probe.sqlite'));
  try {
    const preview = f.select(); f.core.presented(preview);
    db.exec('DROP TRIGGER immutable_activation_batches_update');
    const payload = JSON.stringify({ ...JSON.parse(f.batch.payload), events: JSON.parse(f.batch.payload).events.reverse() });
    db.prepare('UPDATE activation_batches SET payload=?,payload_hash=? WHERE batch_id=?')
      .run(payload, createHash('sha256').update(payload).digest('hex'), f.batch.batchId);
    const reply = f.result(`commit ${preview.token} rollback`);
    assert.equal(reply.result.status, 'stale');
    assert.deepEqual(reply.result.receiptIds, []);
    assert.equal(f.result(`commit ${preview.token} rollback`).result.status, 'settled');
    assert.deepEqual(f.probe.store.readMemoryPresentation(f.probe.activity, preview.token), preview);
    assert.equal(f.probe.store.correctionSummary(f.probe.activity, preview.token).status, 'stale');
    for (const event of f.batch.events) assert.deepEqual(f.probe.store.readMemory(f.probe.activity, event.recordId), event.after);
  } finally { db.close(); f.close(); }
});

test('one live approval rolls back the selected fixed batch with complete snapshots and immutable receipts', () => {
  const f = fixture();
  try {
    const preview = f.select();
    assert.equal(preview.batchPayload, f.batch.payload);
    assert.equal(preview.batchDigest, f.batch.digest);
    assert.deepEqual(preview.eventIds, f.batch.events.map(event => event.eventId));
    assert.deepEqual(preview.targets, f.batch.events.map(event => event.after));
    f.core.presented(preview);
    const committed = f.result(`commit ${preview.token} rollback`);
    assert.equal(committed.result.status, 'committed');
    assert.equal(committed.canonical, 'committed');
    assert.equal(committed.result.receiptIds.length, 2);
    const receipt = f.probe.store.rollbackReceipt(f.probe.activity, preview.token);
    assert.equal(receipt.operationId, preview.operationId);
    assert.equal(receipt.batchId, f.batch.batchId);
    assert.deepEqual(receipt.members.map(member => member.eventId), preview.eventIds);
    assert.deepEqual(receipt.members.map(member => member.receipt.receiptId), committed.result.receiptIds);
    assert.deepEqual(f.probe.store.rollbackReceipt(f.probe.activity, preview.token), receipt);
    for (const [index, event] of f.batch.events.entries()) {
      const current = f.probe.store.readMemory(f.probe.activity, event.recordId);
      assert.equal(current.lifecycle, 'candidate');
      assert.equal(current.revisionId, event.before.revisionId);
      assert.equal(current.content, event.before.content);
      assert.equal(current.headEventId, preview.updateEventIds[index]);
      const receipt = f.probe.store.readOwnerReceipt(f.probe.activity, committed.result.receiptIds[index]!);
      assert.equal(receipt.operationId, preview.operationId);
      assert.equal(receipt.kind, 'rollback');
    }
    assert.deepEqual(f.probe.store.listEligibleMemories(f.probe.activity), []);
    assert.equal(f.probe.store.readActivationBatch(f.probe.activity, f.batch.batchId).payload, f.batch.payload);
    assert.equal(f.result(`commit ${preview.token} rollback`).result.status, 'settled');
    assert.deepEqual(f.result(`replay ${preview.token}`).result.receiptIds, committed.result.receiptIds);
  } finally { f.close(); }
});
