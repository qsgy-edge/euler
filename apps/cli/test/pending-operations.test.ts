import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { createSandbox, createSandboxSession, bindingOf } from '../src/sandbox.ts';
import { DatabaseSync } from 'node:sqlite';
import { openProbe } from '../src/probe.ts';

function candidate(probe: ReturnType<typeof openProbe>, projectId: string, content = 'Original fact') {
  const input = probe.archive.append(randomUUID(), content);
  const captured = probe.store.captureMemory(probe.activity, input, content, {
    type: 'fact', scope: { kind: 'project', id: projectId, resolved: true }, appliesTo: [],
  });
  return { input, record: captured.record };
}

// Synthetic Host only: no approval fixture is exposed through the model tool surface.
test('a preview persists its full canonical snapshot, replaces the session pending and settles with one receipt', () => {
  const sandbox = createSandbox();
  let probe = openProbe(sandbox);
  try {
    const input = probe.archive.append(randomUUID(), 'Original fact');
    const captured = probe.store.captureMemory(probe.activity, input, 'Original fact', {
      type: 'fact', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: [],
    });
    const inspect = probe.store.inspectMemoryPresentation(probe.activity, [captured.record.recordId]);
    const source = probe.archive.append(randomUUID(), 'Corrected fact');
    const first = probe.store.previewMemoryOperation(probe.activity, inspect.token, { kind: 'correct', input: source, content: 'Corrected fact' });
    const replacement = probe.store.previewMemoryOperation(probe.activity, inspect.token, { kind: 'correct', input: source, content: 'Corrected fact' });
    assert.equal(replacement.supersedesOperationId, first.operationId);
    assert.equal(replacement.updateEventIds.length, 1);
    assert.match(replacement.updateEventIds[0]!, /^[0-9a-f-]{36}$/);
    assert.equal(probe.store.memoryOperationStatus(probe.activity, first.token).status, 'superseded');
    assert.deepEqual(replacement.targets, [captured.record]);
    probe.close();
    probe = openProbe(sandbox);
    assert.deepEqual(probe.store.readMemoryPresentation(probe.activity, replacement.token), replacement);
    probe.store.acknowledgeMemoryPresentation(probe.activity, replacement.token, replacement.hash);
    const result = probe.store.commitMemoryOperation(probe.activity, replacement.token);
    assert.equal(result.status, 'committed');
    assert.equal(result.receiptIds.length, 1);
    assert.equal(probe.store.readOwnerReceipt(probe.activity, result.receiptIds[0]!).operationId, replacement.operationId);
    assert.equal(probe.store.readMemory(probe.activity, captured.record.recordId).content, 'Corrected fact');
    assert.equal(probe.store.readMemory(probe.activity, captured.record.recordId).headEventId, replacement.updateEventIds[0]);
    assert.deepEqual(probe.store.memoryOperationStatus(probe.activity, replacement.token), result);
    assert.equal(probe.store.commitMemoryOperation(probe.activity, replacement.token).status, 'settled');
    assert.throws(() => probe.session.tool('memory.commit', input), /tool-unavailable/);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('shared-scope previews admit member evidence consistently with direct correction', () => {
  const sandbox = createSandbox();
  const member = { ...bindingOf(sandbox), projectId: randomUUID(), sessionId: randomUUID() };
  const outsider = { ...bindingOf(sandbox), projectId: randomUUID(), sessionId: randomUUID() };
  for (const binding of [member, outsider]) createSandboxSession(sandbox, binding);
  const first = openProbe(sandbox);
  const second = openProbe(sandbox, undefined, undefined, member);
  const third = openProbe(sandbox, undefined, undefined, outsider);
  try {
    const workspaceId = randomUUID();
    first.store.bindWorkspace(first.activity, workspaceId, [sandbox.fixture.projectId, member.projectId]);
    for (const scope of [
      { kind: 'workspace' as const, id: workspaceId, resolved: true },
      { kind: 'personal' as const, id: sandbox.fixture.ownerId, resolved: true },
    ]) {
      const source = first.archive.append(randomUUID(), `${scope.kind} original`);
      const record = first.store.captureMemory(first.activity, source, 'Original', { type: 'fact', scope, appliesTo: [] }).record;
      const inspect = first.store.inspectMemoryPresentation(first.activity, [record.recordId]);
      const input = second.archive.append(randomUUID(), `${scope.kind} corrected`);
      if (scope.kind === 'workspace') {
        const foreign = third.archive.append(randomUUID(), 'Unauthorized correction');
        assert.throws(() => first.store.previewMemoryOperation(first.activity, inspect.token,
          { kind: 'correct', input: foreign, content: 'Unauthorized correction' }), /source-scope-mismatch/);
      }
      const preview = first.store.previewMemoryOperation(first.activity, inspect.token, { kind: 'correct', input, content: 'Corrected' });
      first.store.acknowledgeMemoryPresentation(first.activity, preview.token, preview.hash);
      const committed = first.store.commitMemoryOperation(first.activity, preview.token);
      assert.equal(committed.status, 'committed');
      assert.equal(committed.current[0]!.source.binding.projectId, member.projectId);
      assert.deepEqual(second.store.readMemory(second.activity, record.recordId), committed.current[0]);
    }
  } finally { third.close(); second.close(); first.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('two sessions keep separate pending slots and only one correction of a shared head can commit', () => {
  const sandbox = createSandbox();
  const binding = { ...bindingOf(sandbox), sessionId: randomUUID() };
  createSandboxSession(sandbox, binding);
  const first = openProbe(sandbox);
  const second = openProbe(sandbox, undefined, undefined, binding);
  try {
    const { record } = candidate(first, sandbox.fixture.projectId);
    const previews = [first, second].map((probe, index) => {
      const inspected = probe.store.inspectMemoryPresentation(probe.activity, [record.recordId]);
      const input = probe.archive.append(randomUUID(), `Correction ${index}`);
      const preview = probe.store.previewMemoryOperation(probe.activity, inspected.token, { kind: 'correct', input, content: `Correction ${index}` });
      probe.store.acknowledgeMemoryPresentation(probe.activity, preview.token, preview.hash);
      return preview;
    });
    assert.equal(first.store.memoryOperationStatus(first.activity, previews[0]!.token).status, 'pending');
    assert.equal(second.store.memoryOperationStatus(second.activity, previews[1]!.token).status, 'pending');
    assert.equal(second.store.commitMemoryOperation(second.activity, previews[0]!.token).status, 'invalid_identity');
    const winner = first.store.commitMemoryOperation(first.activity, previews[0]!.token);
    const loser = second.store.commitMemoryOperation(second.activity, previews[1]!.token);
    assert.equal(winner.status, 'committed');
    assert.equal(loser.status, 'stale');
    assert.deepEqual(loser.expected, [record]);
    assert.equal(loser.current[0]!.content, 'Correction 0');
    assert.deepEqual(loser.receiptIds, []);
    assert.deepEqual(second.store.readMemory(second.activity, record.recordId), winner.current[0]);
  } finally { second.close(); first.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('missing output acknowledgement, cancellation and empty correction settle without a mutation receipt', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const { record, input } = candidate(probe, sandbox.fixture.projectId);
    const inspect = probe.store.inspectMemoryPresentation(probe.activity, [record.recordId]);
    const create = () => probe.store.previewMemoryOperation(probe.activity, inspect.token, { kind: 'correct', input, content: '' });
    const absent = create();
    assert.equal(probe.store.commitMemoryOperation(probe.activity, absent.token).status, 'unavailable');
    const cancelled = create();
    assert.equal(probe.store.cancelMemoryOperation(probe.activity, cancelled.token).status, 'cancelled');
    assert.equal(probe.store.commitMemoryOperation(probe.activity, cancelled.token).status, 'settled');
    const empty = create();
    probe.store.acknowledgeMemoryPresentation(probe.activity, empty.token, empty.hash);
    const result = probe.store.commitMemoryOperation(probe.activity, empty.token);
    assert.equal(result.status, 'no_op');
    assert.deepEqual(result.receiptIds, []);
    assert.deepEqual(probe.store.readMemory(probe.activity, record.recordId), record);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('batch rollback reports every current target and makes no partial change when one member is stale', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const candidates = ['One', 'Two'].map(content => {
      const { input, record } = candidate(probe, sandbox.fixture.projectId, content);
      return probe.store.verifyMemory(probe.activity, record.recordId, record, 'pass', [input]).record;
    });
    const batch = probe.store.activateMemoryBatch(probe.activity, candidates);
    const inspect = probe.store.inspectMemoryPresentation(probe.activity, batch.events.map(event => event.recordId));
    const preview = probe.store.previewMemoryOperation(probe.activity, inspect.token,
      { kind: 'rollback', batchId: batch.batchId, eventIds: batch.events.map(event => event.eventId) });
    probe.store.acknowledgeMemoryPresentation(probe.activity, preview.token, preview.hash);
    const first = batch.events[0]!.after;
    const forgotten = probe.store.forgetMemory(probe.activity, first.recordId, first).record;
    const result = probe.store.commitMemoryOperation(probe.activity, preview.token);
    assert.equal(result.status, 'stale');
    assert.deepEqual(result.current, [forgotten, batch.events[1]!.after]);
    assert.deepEqual(result.receiptIds, []);
    assert.deepEqual(probe.store.readMemory(probe.activity, batch.events[1]!.recordId), batch.events[1]!.after);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('storage rejects forged presentation identities and re-signed batch payloads without changing canonical state', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  const db = new DatabaseSync(`${sandbox.root}/probe.sqlite`);
  try {
    const records = ['One', 'Two'].map(content => {
      const { input, record } = candidate(probe, sandbox.fixture.projectId, content);
      return probe.store.verifyMemory(probe.activity, record.recordId, record, 'pass', [input]).record;
    });
    const batch = probe.store.activateMemoryBatch(probe.activity, records);
    const inspect = probe.store.inspectMemoryPresentation(probe.activity, batch.events.map(event => event.recordId));
    const preview = probe.store.previewMemoryOperation(probe.activity, inspect.token,
      { kind: 'rollback', batchId: batch.batchId, eventIds: batch.events.map(event => event.eventId) });
    assert.throws(() => probe.store.acknowledgeMemoryPresentation(probe.activity, preview.token, '0'.repeat(64)), /invalid-presentation-identity/);
    assert.equal(probe.store.commitMemoryOperation(probe.activity, randomUUID()).status, 'invalid_identity');
    assert.throws(() => db.prepare('UPDATE host_presentations SET token=? WHERE token=?').run(randomUUID(), preview.token), /append-only|euler_store_writer/);
    assert.throws(() => db.prepare('UPDATE presentation_targets SET snapshot=snapshot').run(), /append-only/);
    assert.throws(() => db.prepare('UPDATE activation_batches SET payload=payload').run(), /append-only/);
    assert.throws(() => db.prepare('INSERT INTO host_presentations SELECT * FROM host_presentations').run(), /euler_store_writer/);
    // Deliberately bypass the SQL update guard to test independent payload/event validation.
    db.exec('DROP TRIGGER immutable_activation_batches_update');
    const changed = JSON.parse(batch.payload);
    changed.events.reverse();
    const payload = JSON.stringify(changed);
    db.prepare('UPDATE activation_batches SET payload=?,payload_hash=? WHERE batch_id=?').run(payload, createHash('sha256').update(payload).digest('hex'), batch.batchId);
    assert.throws(() => probe.store.readActivationBatch(probe.activity, batch.batchId), /batch-evidence-gap/);
    assert.throws(() => probe.store.readMemoryPresentation(probe.activity, preview.token), /batch-evidence-gap/);
    assert.equal(probe.store.readMemory(probe.activity, batch.events[0]!.recordId).headEventId, batch.events[0]!.eventId);
  } finally { db.close(); probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('forget, restore and rollback commit only their own frozen event identities', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const { input, record } = candidate(probe, sandbox.fixture.projectId);
    const verified = probe.store.verifyMemory(probe.activity, record.recordId, record, 'pass', [input]);
    const batch = probe.store.activateMemoryBatch(probe.activity, [verified.record]);
    for (const kind of ['forget', 'restore', 'rollback'] as const) {
      const inspect = probe.store.inspectMemoryPresentation(probe.activity, [record.recordId]);
      const preview = probe.store.previewMemoryOperation(probe.activity, inspect.token, kind === 'rollback'
        ? { kind, batchId: batch.batchId, eventIds: [batch.events[0]!.eventId] } : { kind });
      const reserved = preview.updateEventIds[0]!;
      assert.notEqual(reserved, inspect.targets[0]!.headEventId);
      if (kind === 'rollback') {
        assert.deepEqual(preview.eventIds, [batch.events[0]!.eventId]);
        assert.notEqual(preview.eventIds[0], inspect.targets[0]!.headEventId);
      }
      probe.store.acknowledgeMemoryPresentation(probe.activity, preview.token, preview.hash);
      const result = probe.store.commitMemoryOperation(probe.activity, preview.token);
      assert.equal(result.status, 'committed');
      assert.equal(result.current[0]!.headEventId, reserved);
      assert.equal(probe.store.readOwnerReceipt(probe.activity, result.receiptIds[0]!).kind, kind);
    }
    assert.equal(probe.store.readMemory(probe.activity, record.recordId).lifecycle, 'candidate');
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('pending identity binds the complete displayed correction and rollback selection', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  const db = new DatabaseSync(`${sandbox.root}/probe.sqlite`);
  try {
    const { input, record } = candidate(probe, sandbox.fixture.projectId);
    const verified = probe.store.verifyMemory(probe.activity, record.recordId, record, 'pass', [input]);
    const batch = probe.store.activateMemoryBatch(probe.activity, [verified.record]);
    const inspect = probe.store.inspectMemoryPresentation(probe.activity, [record.recordId]);
    const correction = probe.archive.append(randomUUID(), 'Displayed body');
    const differentSource = probe.archive.append(randomUUID(), 'Unapproved source');
    db.function('euler_store_writer', () => 1);
    db.exec('DROP TRIGGER immutable_presentation_update');
    for (const field of ['content', 'input', 'eventIds']) {
      const preview = probe.store.previewMemoryOperation(probe.activity, inspect.token, field === 'eventIds'
        ? { kind: 'rollback', batchId: batch.batchId, eventIds: [batch.events[0]!.eventId] }
        : { kind: 'correct', input: correction, content: 'Displayed body' });
      const original = db.prepare('SELECT payload,payload_hash FROM host_presentations WHERE token=?').get(preview.token)!;
      const body = JSON.parse(String(original.payload));
      if (field === 'content') body.content = 'Changed after display';
      if (field === 'input') body.input = differentSource;
      if (field === 'eventIds') body.eventIds.push(randomUUID());
      const payload = JSON.stringify(body);
      db.prepare('UPDATE host_presentations SET payload=?,payload_hash=? WHERE token=?')
        .run(payload, createHash('sha256').update(payload).digest('hex'), preview.token);
      assert.throws(() => probe.store.readMemoryPresentation(probe.activity, preview.token), /presentation-evidence-gap/);
      assert.deepEqual(probe.store.readMemory(probe.activity, record.recordId), batch.events[0]!.after);
      db.prepare('UPDATE host_presentations SET payload=?,payload_hash=? WHERE token=?').run(original.payload!, original.payload_hash!, preview.token);
      probe.store.cancelMemoryOperation(probe.activity, preview.token);
    }
  } finally { db.close(); probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('a re-signed presentation cannot replace its reserved mutation event', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  const db = new DatabaseSync(`${sandbox.root}/probe.sqlite`);
  try {
    const { record } = candidate(probe, sandbox.fixture.projectId);
    const inspected = probe.store.inspectMemoryPresentation(probe.activity, [record.recordId]);
    const input = probe.archive.append(randomUUID(), 'Correction');
    const preview = probe.store.previewMemoryOperation(probe.activity, inspected.token, { kind: 'correct', input, content: 'Correction' });
    db.function('euler_store_writer', () => 1);
    db.exec('DROP TRIGGER immutable_presentation_update');
    const row = db.prepare('SELECT payload FROM host_presentations WHERE token=?').get(preview.token)!;
    const body = JSON.parse(String(row.payload));
    body.updateEventIds[0] = randomUUID();
    const payload = JSON.stringify(body);
    db.prepare('UPDATE host_presentations SET payload=?,payload_hash=? WHERE token=?')
      .run(payload, createHash('sha256').update(payload).digest('hex'), preview.token);
    assert.throws(() => probe.store.readMemoryPresentation(probe.activity, preview.token), /presentation-evidence-gap/);
    assert.deepEqual(probe.store.readMemory(probe.activity, record.recordId), record);
  } finally { db.close(); probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('a failure after the memory event rolls back mutation and receipt before settling the operation error', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  const db = new DatabaseSync(`${sandbox.root}/probe.sqlite`);
  try {
    const { record } = candidate(probe, sandbox.fixture.projectId);
    const inspect = probe.store.inspectMemoryPresentation(probe.activity, [record.recordId]);
    const input = probe.archive.append(randomUUID(), 'Changed');
    const preview = probe.store.previewMemoryOperation(probe.activity, inspect.token, { kind: 'correct', input, content: 'Changed' });
    probe.store.acknowledgeMemoryPresentation(probe.activity, preview.token, preview.hash);
    db.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON projection_jobs BEGIN SELECT RAISE(ABORT,'injected-outbox-failure'); END");
    const result = probe.store.commitMemoryOperation(probe.activity, preview.token);
    assert.equal(result.status, 'error');
    assert.match(result.reason!, /injected-outbox-failure/);
    assert.deepEqual(result.receiptIds, []);
    assert.deepEqual(probe.store.readMemory(probe.activity, record.recordId), record);
    assert.equal(db.prepare('SELECT count(*) AS n FROM memory_events WHERE receipt_id IS NOT NULL').get()!.n, 0);
    assert.equal(probe.store.memoryOperationStatus(probe.activity, preview.token).status, 'error');
  } finally { db.close(); probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
