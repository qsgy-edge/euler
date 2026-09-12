import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { createSandbox, createSandboxSession, openSandbox, bindingOf } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';
import { startCli } from '../src/process-driver.ts';

test('a losing correction cannot reconcile another request as its own commit', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const input = probe.archive.append(sandbox.fixture.eventId, sandbox.fixture.text);
    const c = probe.store.captureMemory(probe.activity, input, 'Original', {
      type: 'fact', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: [],
    });
    const winnerSource = probe.archive.append(randomUUID(), 'Winner evidence');
    const loserSource = probe.archive.append(randomUUID(), 'Loser evidence');
    const winnerRequest = probe.store.memoryCorrectionRequestHash(c.record.recordId, c.record, winnerSource, 'Corrected');
    const loserRequest = probe.store.memoryCorrectionRequestHash(c.record.recordId, c.record, loserSource, 'Corrected');
    const winner = probe.store.correctMemory(probe.activity, c.record.recordId, c.record, winnerSource, 'Corrected');
    assert.throws(() => probe.store.correctMemory(probe.activity, c.record.recordId, c.record, loserSource, 'Corrected'), /memory-stale/);
    assert.equal(probe.store.lookupMemoryOperation(probe.activity, c.record.recordId, loserRequest), null);
    assert.deepEqual(probe.store.lookupMemoryOperation(probe.activity, c.record.recordId, winnerRequest), winner);
    const differentContent = probe.store.memoryCorrectionRequestHash(c.record.recordId, c.record, winnerSource, 'Another correction');
    assert.equal(probe.store.lookupMemoryOperation(probe.activity, c.record.recordId, differentContent), null);
    assert.throws(() => probe.store.lookupMemoryOperation(probe.activity, c.record.recordId, c.record.headEventId), /invalid-memory-request-hash/);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('cross-project reconciliation cannot read another project operation or receipt', () => {
  const sandbox = createSandbox();
  const otherBinding = { ...bindingOf(sandbox), projectId: randomUUID(), sessionId: randomUUID() };
  createSandboxSession(sandbox, otherBinding);
  const first = openProbe(sandbox);
  const second = openProbe(sandbox, undefined, undefined, otherBinding);
  const db = new DatabaseSync(`${sandbox.root}/probe.sqlite`);
  try {
    const input = first.archive.append(sandbox.fixture.eventId, 'Project A source');
    const captured = first.store.captureMemory(first.activity, input, 'Project A fact', {
      type: 'fact', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: [],
    });
    const correction = first.archive.append(randomUUID(), 'Project A correction source');
    const request = first.store.memoryCorrectionRequestHash(captured.record.recordId, captured.record, correction, 'Project A corrected');
    const committed = first.store.correctMemory(first.activity, captured.record.recordId, captured.record, correction, 'Project A corrected');
    assert.throws(() => second.store.lookupMemoryOperation(second.activity, captured.record.recordId, request), /invalid-memory-scope/);
    const receiptId = String(db.prepare('SELECT receipt_id FROM memory_events WHERE event_id=?').get(committed.eventId)!.receipt_id);
    assert.throws(() => second.store.readOwnerReceipt(second.activity, receiptId), /invalid-memory-scope/);
  } finally { db.close(); second.close(); first.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
for (const relationship of ['verification-record', 'verification-revision', 'rollback-record', 'conflict-member']) {
  test(`SQLite independently rejects a mismatched ${relationship} relationship`, () => {
    const sandbox = createSandbox();
    const probe = openProbe(sandbox);
    const db = new DatabaseSync(`${sandbox.root}/probe.sqlite`);
    db.exec('PRAGMA foreign_keys=ON');
    try {
      const input = probe.archive.append(sandbox.fixture.eventId, sandbox.fixture.text);
      const options = { type: 'fact' as const, scope: { kind: 'project' as const, id: sandbox.fixture.projectId, resolved: true }, appliesTo: [] };
      const c = probe.store.captureMemory(probe.activity, input, 'One', options);
      const v = probe.store.verifyMemory(probe.activity, c.record.recordId, c.record, 'pass', [input]);
      const source = probe.archive.append(randomUUID(), 'Other evidence');
      const other = probe.store.captureMemory(probe.activity, source, 'Two', options);
      const verifiedOther = probe.store.verifyMemory(probe.activity, other.record.recordId, other.record, 'pass', [source]);
      if (relationship === 'verification-record') {
        assert.throws(() => db.prepare('UPDATE memory_heads SET verification_run_id=? WHERE record_id=?')
          .run(verifiedOther.record.verificationRunId, c.record.recordId), /FOREIGN KEY/);
      } else if (relationship === 'verification-revision') {
        probe.store.correctMemory(probe.activity, c.record.recordId, v.record, source, 'New revision');
        assert.throws(() => db.prepare('UPDATE memory_heads SET verification_run_id=? WHERE record_id=?')
          .run(v.record.verificationRunId, c.record.recordId), /FOREIGN KEY/);
      } else if (relationship === 'conflict-member') {
        const conflict = probe.store.conflictMemory(probe.activity, c.record.recordId, v.record, other.record.recordId, verifiedOther.record);
        const thirdSource = probe.archive.append(randomUUID(), 'Unrelated record');
        const third = probe.store.captureMemory(probe.activity, thirdSource, 'Three', options);
        assert.throws(() => db.prepare('UPDATE memory_heads SET conflict_set_id=? WHERE record_id=?')
          .run(conflict.conflictSetId, third.record.recordId), /FOREIGN KEY/);
      } else {
        // Deliberately bypass only the writer guard to test the independent SQL relationship.
        db.function('euler_store_writer', () => 1);
        assert.throws(() => db.prepare(`INSERT INTO memory_events
          SELECT ?,record_id,seq+100,'rollback',revision_id,before_snapshot,after_snapshot,?,origin_host_id,origin_seq+100,NULL,?,payload,payload_hash,source_event_id,created_at,NULL,NULL,NULL,NULL,NULL
          FROM memory_events WHERE event_id=?`).run(randomUUID(), randomUUID(), other.record.headEventId, c.record.headEventId), /FOREIGN KEY/);
      }
    } finally { db.close(); probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
  });
}

test('same lineage and canonical claim stay suppressed until a separate restore', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const input = probe.archive.append(sandbox.fixture.eventId, sandbox.fixture.text);
    const options = { type: 'preference' as const, claimKey: 'synthetic/route',
      scope: { kind: 'project' as const, id: sandbox.fixture.projectId, resolved: true }, appliesTo: [] };
    const c = probe.store.captureMemory(probe.activity, input, 'Use local', options);
    const v = probe.store.verifyMemory(probe.activity, c.record.recordId, c.record, 'pass', [input]);
    const a = probe.store.activateMemory(probe.activity, c.record.recordId, v.record);
    const tombstone = probe.store.forgetMemory(probe.activity, c.record.recordId, a.record);
    const newInput = probe.archive.append(randomUUID(), 'Same claim in a later source version');
    const repeated = probe.store.captureMemory(probe.activity, newInput, 'Prefer local route', options);
    assert.equal(repeated.status, 'no_op');
    assert.deepEqual(repeated.record, tombstone.record);
    const restored = probe.store.restoreMemory(probe.activity, c.record.recordId, tombstone.record);
    const corrected = probe.store.correctMemory(probe.activity, c.record.recordId, restored.record, newInput, 'Use remote');
    assert.equal(corrected.record.verification, 'unverified');
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('SQLite rejects forged identities and cross-record references; caught failures leave no partial mutation', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  const db = new DatabaseSync(`${sandbox.root}/probe.sqlite`);
  db.exec('PRAGMA foreign_keys=ON');
  try {
    const input = probe.archive.append(sandbox.fixture.eventId, sandbox.fixture.text);
    const options = { type: 'fact' as const, scope: { kind: 'project' as const, id: sandbox.fixture.projectId, resolved: true }, appliesTo: [] };
    const c = probe.store.captureMemory(probe.activity, input, 'One', options);
    const otherInput = probe.archive.append(randomUUID(), 'Second source');
    const d = probe.store.captureMemory(probe.activity, otherInput, 'Two', options);
    assert.throws(() => db.prepare('INSERT INTO memory_records VALUES (?,?,?,?,?)').run(randomUUID(), sandbox.fixture.ownerId, 'x', 'y', 'now'), /euler_store_writer|store-owned/);
    for (const [column, value] of [['revision_id', d.record.revisionId], ['head_event_id', d.record.headEventId], ['conflict_set_id', randomUUID()]]) {
      assert.throws(() => db.prepare(`UPDATE memory_heads SET ${column}=? WHERE record_id=?`).run(value!, c.record.recordId), /FOREIGN KEY/);
    }
    const tables = ['memory_records','memory_revisions','memory_events','provenance_refs','projection_jobs'];
    const counts = () => tables.map(table => db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
    const before = counts();
    db.exec("CREATE TRIGGER fail_head BEFORE UPDATE ON memory_heads BEGIN SELECT RAISE(ABORT,'injected-head-failure'); END");
    probe.store.withActivity(probe.activity, () => {
      assert.throws(() => probe.store.correctMemory(probe.activity, c.record.recordId, c.record, otherInput, 'New content'), /injected-head-failure/);
    });
    db.exec('DROP TRIGGER fail_head');
    assert.deepEqual(counts(), before);
    assert.deepEqual(probe.store.recoverMemory(probe.activity, c.record.recordId), c.record);
  } finally { db.close(); probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('source loss blocks verification and exposure, and no-op/exposure create no mutation receipts', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  const db = new DatabaseSync(`${sandbox.root}/probe.sqlite`);
  try {
    const input = probe.archive.append(sandbox.fixture.eventId, sandbox.fixture.text);
    const c = probe.store.captureMemory(probe.activity, input, 'Synthetic fact', {
      type: 'fact', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: [],
    });
    const v = probe.store.verifyMemory(probe.activity, c.record.recordId, c.record, 'pass', [input]);
    const a = probe.store.activateMemory(probe.activity, c.record.recordId, v.record);
    const count = () => db.prepare('SELECT count(*) AS n FROM memory_events').get()!.n;
    const before = count();
    probe.store.listEligibleMemories(probe.activity);
    probe.store.correctMemory(probe.activity, c.record.recordId, a.record, input, '  Synthetic fact  ');
    probe.store.correctMemory(probe.activity, c.record.recordId, a.record, input, '');
    assert.equal(count(), before);
    assert.deepEqual(probe.store.readMemory(probe.activity, c.record.recordId), a.record);
    assert.equal(db.prepare('SELECT count(*) AS n FROM feedback_events').get()!.n, 1);
    const bytes = readFileSync(`${sandbox.root}/session.jsonl`, 'utf8');
    writeFileSync(`${sandbox.root}/session.jsonl`, bytes.replace(sandbox.fixture.text, 'Changed source'));
    assert.throws(() => probe.store.listEligibleMemories(probe.activity), /source-evidence-gap/);
    assert.throws(() => probe.store.verifyMemory(probe.activity, c.record.recordId, a.record, 'pass', [input]), /source-evidence-gap/);
  } finally { db.close(); probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('a later evidence gap revokes eligibility even when the same result exists in history', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const input = probe.archive.append(sandbox.fixture.eventId, sandbox.fixture.text);
    const c = probe.store.captureMemory(probe.activity, input, 'Synthetic fact', {
      type: 'fact', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: [],
    });
    const gap = probe.store.verifyMemory(probe.activity, c.record.recordId, c.record, 'evidence-gap', []);
    const v = probe.store.verifyMemory(probe.activity, c.record.recordId, gap.record, 'pass', [input]);
    const active = probe.store.activateMemory(probe.activity, c.record.recordId, v.record);
    const revoked = probe.store.verifyMemory(probe.activity, c.record.recordId, active.record, 'evidence-gap', []);
    assert.equal(revoked.status, 'committed');
    assert.equal(revoked.record.verification, 'unverified');
    assert.deepEqual(probe.store.listEligibleMemories(probe.activity), []);
    assert.equal(probe.store.verifyMemory(probe.activity, c.record.recordId, revoked.record, 'evidence-gap', []).status, 'no_op');
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('automatic revisions roll back in sequence using fresh CAS without duplicating old content', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const input = probe.archive.append(sandbox.fixture.eventId, sandbox.fixture.text);
    const options = { type: 'fact' as const, scope: { kind: 'project' as const, id: sandbox.fixture.projectId, resolved: true }, appliesTo: [] };
    const c = probe.store.captureMemory(probe.activity, input, 'Original', options);
    const v = probe.store.verifyMemory(probe.activity, c.record.recordId, c.record, 'pass', [input]);
    const original = probe.store.activateMemory(probe.activity, c.record.recordId, v.record).record;
    const sourceA = probe.archive.append('00000000-0000-4000-8000-000000000041', 'Evidence A');
    const a = probe.store.reviseMemory(probe.activity, original.recordId, original, sourceA, 'A', [sourceA]);
    const sourceB = probe.archive.append('00000000-0000-4000-8000-000000000042', 'Evidence B');
    const b = probe.store.reviseMemory(probe.activity, original.recordId, a.record, sourceB, 'B', [sourceB]);
    const undoB = probe.store.rollbackMemory(probe.activity, original.recordId, b.record, b.eventId!);
    assert.equal(undoB.record.revisionId, a.record.revisionId);
    assert.throws(() => probe.store.rollbackMemory(probe.activity, original.recordId, a.record, a.eventId!), /memory-stale/);
    const undoA = probe.store.rollbackMemory(probe.activity, original.recordId, undoB.record, a.eventId!);
    assert.equal(undoA.record.revisionId, original.revisionId);
    assert.equal(undoA.record.content, 'Original');
    assert.notEqual(undoA.record.headEventId, original.headEventId);
    const corrected = probe.store.correctMemory(probe.activity, original.recordId, undoA.record, sourceB, 'Owner correction');
    assert.equal(corrected.record.revision, 4);
    assert.throws(() => probe.store.rollbackMemory(probe.activity, original.recordId, corrected.record, corrected.eventId!), /rollback-not-actionable/);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('a missing memory head is rebuilt from its events without new history', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const input = probe.archive.append(sandbox.fixture.eventId, sandbox.fixture.text);
    const captured = probe.store.captureMemory(probe.activity, input, 'Recover me', {
      type: 'decision', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: [],
    });
    const db = new DatabaseSync(`${sandbox.root}/probe.sqlite`);
    try { db.prepare('DELETE FROM memory_heads WHERE record_id=?').run(captured.record.recordId); }
    finally { db.close(); }
    assert.deepEqual(probe.store.recoverMemories(probe.activity), [captured.record]);
    assert.deepEqual(probe.store.readMemory(probe.activity, captured.record.recordId), captured.record);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('unbound workspace scope is rejected and incompatible applicability never becomes eligible', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const input = probe.archive.append(sandbox.fixture.eventId, sandbox.fixture.text);
    assert.throws(() => probe.store.captureMemory(probe.activity, input, 'Unbound workspace', {
      type: 'fact', scope: { kind: 'workspace', id: '00000000-0000-4000-8000-000000000088', resolved: true }, appliesTo: [],
    }), /workspace-unavailable/);
    const candidate = probe.store.captureMemory(probe.activity, input, 'Only another host', {
      type: 'fact', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: ['other-host'],
    });
    const verified = probe.store.verifyMemory(probe.activity, candidate.record.recordId, candidate.record, 'pass', [input]);
    probe.store.activateMemory(probe.activity, verified.record.recordId, verified.record);
    assert.deepEqual(probe.store.listEligibleMemories(probe.activity), []);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('Store capture rejects a forged durable source identity before creating a record', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const input = probe.archive.append(sandbox.fixture.eventId, sandbox.fixture.text);
    assert.throws(() => probe.store.captureMemory(probe.activity,
      { ...input, eventId: '00000000-0000-4000-8000-000000000099' }, 'Forged source', {
        type: 'fact', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: [],
      }), /source-evidence-gap/);
    assert.deepEqual(probe.store.recoverMemories(probe.activity), []);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('a rewritten head with a recomputed digest cannot override the immutable event chain', () => {
  const sandbox = createSandbox();
  try {
    const probe = openProbe(sandbox);
    const input = probe.archive.append(sandbox.fixture.eventId, sandbox.fixture.text);
    const captured = probe.store.captureMemory(probe.activity, input, 'Candidate only', {
      type: 'fact', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: [] });
    probe.close();
    const db = new DatabaseSync(`${sandbox.root}/probe.sqlite`);
    try {
      const row = db.prepare('SELECT snapshot FROM memory_heads WHERE record_id=?').get(captured.record.recordId)!;
      const changed = JSON.parse(String(row.snapshot));
      changed.lifecycle = 'active';
      const bytes = JSON.stringify(changed);
      db.prepare('UPDATE memory_heads SET snapshot=?,snapshot_hash=?,lifecycle=? WHERE record_id=?')
        .run(bytes, createHash('sha256').update(bytes).digest('hex'), 'active', captured.record.recordId);
    } finally { db.close(); }
    const reopened = openProbe(sandbox);
    try { assert.throws(() => reopened.store.recoverMemory(reopened.activity, captured.record.recordId), /memory-evidence-gap/); }
    finally { reopened.close(); }
  } finally { rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('separate CLI processes from different cwd rebuild the same active memory head', { timeout: 15000 }, async () => {
  const sandbox = createSandbox();
  try {
    const writer = startCli(['memory', '--sandbox', sandbox.root]);
    assert.equal((await writer.exit).code, 0);
    const written = writer.observations.find(item => item.event === 'memory-result')!;
    const reader = startCli(['recover', '--sandbox', sandbox.root], 15000, sandbox.root);
    assert.equal((await reader.exit).code, 0);
    const recovered = reader.observations.find(item => item.event === 'recovered')!;
    const writtenMemory = (written.eligible as Record<string, unknown>[])[0]!;
    assert.deepEqual(recovered.memories, [writtenMemory]);
    const recoveredMemory = (recovered.memories as Record<string, unknown>[])[0]!;
    assert.equal(recoveredMemory.headEventId, writtenMemory.headEventId);
    assert.equal(recoveredMemory.hash, writtenMemory.hash);
  } finally { rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('a scoped candidate is captured, verified, activated and recovered through the Store API', () => {
  const sandbox = createSandbox();
  try {
    const first = openProbe(sandbox);
    const input = first.archive.append(sandbox.fixture.eventId, sandbox.fixture.text);
    const options = { type: 'decision' as const,
      scope: { kind: 'project' as const, id: sandbox.fixture.projectId, resolved: true }, appliesTo: ['cli'] };
    const captured = first.store.captureMemory(first.activity, input, 'Use the synthetic project store.', options);
    assert.equal(captured.record.lifecycle, 'candidate');
    assert.equal(captured.record.verification, 'unverified');
    assert.deepEqual(first.store.listEligibleMemories(first.activity), []);
    const repeated = first.store.captureMemory(first.activity, input, 'Use the synthetic project store.', options);
    assert.equal(repeated.status, 'no_op');
    assert.deepEqual(repeated.record, captured.record);
    const verified = first.store.verifyMemory(first.activity, captured.record.recordId, captured.record, 'pass', [input]);
    assert.equal(verified.record.lifecycle, 'candidate');
    const activated = first.store.activateMemory(first.activity, verified.record.recordId, verified.record);
    assert.deepEqual(first.store.listEligibleMemories(first.activity), [activated.record]);
    first.close();
    const second = openProbe(openSandbox(sandbox.root));
    try {
      assert.deepEqual(second.store.readMemory(second.activity, activated.record.recordId), activated.record);
    } finally { second.close(); }
  } finally { rmSync(sandbox.root, { recursive: true, force: true }); }
});


test('forget, restore and correction use full head CAS and never revive an old event identity', () => {
  const sandbox = createSandbox();
  try {
    const probe = openProbe(sandbox);
    try {
      const input = probe.archive.append(sandbox.fixture.eventId, sandbox.fixture.text);
      const options = { type: 'preference' as const,
        scope: { kind: 'project' as const, id: sandbox.fixture.projectId, resolved: true }, appliesTo: [] };
      const candidate = probe.store.captureMemory(probe.activity, input, 'Prefer the local route.', options);
      const verified = probe.store.verifyMemory(probe.activity, candidate.record.recordId, candidate.record, 'pass', [input]);
      const active = probe.store.activateMemory(probe.activity, verified.record.recordId, verified.record);
      const forgotten = probe.store.forgetMemory(probe.activity, active.record.recordId, active.record);
      assert.equal(forgotten.record.lifecycle, 'tombstoned');
      assert.equal(probe.store.forgetMemory(probe.activity, active.record.recordId, active.record).status, 'no_op');
      const restored = probe.store.restoreMemory(probe.activity, active.record.recordId, forgotten.record);
      assert.equal(restored.record.lifecycle, 'active');
      assert.notEqual(restored.record.headEventId, active.record.headEventId);
      assert.notEqual(restored.record.headEventId, forgotten.record.headEventId);
      assert.throws(() => probe.store.forgetMemory(probe.activity, active.record.recordId, active.record), /memory-stale/);
      assert.throws(() => probe.store.correctMemory(probe.activity, restored.record.recordId, forgotten.record,
        input, 'a different preference'), /memory-stale/);
      const same = probe.store.correctMemory(probe.activity, restored.record.recordId, restored.record,
        input, restored.record.content);
      assert.equal(same.status, 'no_op');
      const correctionInput = probe.archive.append('00000000-0000-4000-8000-000000000007', 'Owner correction source');
      const corrected = probe.store.correctMemory(probe.activity, restored.record.recordId, restored.record,
        correctionInput, 'A corrected preference');
      assert.equal(corrected.record.lifecycle, 'active');
      assert.equal(corrected.record.verification, 'unverified');
      assert.equal(probe.store.listEligibleMemories(probe.activity).length, 0);
    } finally { probe.close(); }
    const db = new DatabaseSync(`${sandbox.root}/probe.sqlite`);
    try {
      assert.throws(() => db.prepare('UPDATE memory_events SET payload=payload').run(), /append-only/);
      assert.throws(() => db.prepare('UPDATE memory_revisions SET content=content').run(), /append-only/);
    } finally { db.close(); }
  } finally { rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('rollback restores the verified candidate and conflict isolates both records', () => {
  const sandbox = createSandbox();
  try {
    const probe = openProbe(sandbox);
    try {
      const make = (eventId: string, sourceText: string, content: string) => {
        const input = probe.archive.append(eventId, sourceText);
        const candidate = probe.store.captureMemory(probe.activity, input, content, {
          type: 'fact', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: [] });
        const verified = probe.store.verifyMemory(probe.activity, candidate.record.recordId, candidate.record, 'pass', [input]);
        return { input, verified, candidate };
      };
      const rollback = make('00000000-0000-4000-8000-000000000008', 'Activation source', 'Activation content');
      const activated = probe.store.activateMemory(probe.activity, rollback.candidate.record.recordId, rollback.verified.record);
      const undone = probe.store.rollbackMemory(probe.activity, activated.record.recordId, activated.record, activated.eventId!);
      assert.equal(undone.record.lifecycle, 'candidate');
      assert.equal(undone.record.verification, 'verified');
      assert.notEqual(undone.record.headEventId, activated.record.headEventId);
      assert.equal(probe.store.rollbackMemory(probe.activity, activated.record.recordId, activated.record, activated.eventId!).status, 'no_op');
      const left = make('00000000-0000-4000-8000-000000000009', 'Conflict source A', 'A');
      const right = make('00000000-0000-4000-8000-00000000000a', 'Conflict source B', 'B');
      const conflict = probe.store.conflictMemory(probe.activity, left.candidate.record.recordId, left.verified.record,
        right.candidate.record.recordId, right.verified.record);
      assert.equal(conflict.left.record.verification, 'conflicted');
      assert.equal(conflict.right.record.verification, 'conflicted');
      assert.equal(probe.store.listEligibleMemories(probe.activity).length, 0);
    } finally { probe.close(); }
  } finally { rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('unresolved candidates stay out of eligibility and proposals remain versioned and inert', () => {
  const sandbox = createSandbox();
  try {
    const probe = openProbe(sandbox);
    try {
      const input = probe.archive.append(sandbox.fixture.eventId, sandbox.fixture.text);
      const candidate = probe.store.captureMemory(probe.activity, input, 'Session-only candidate', {
        type: 'insight', scope: { kind: 'session', id: sandbox.fixture.sessionId, resolved: false }, appliesTo: [] });
      assert.equal(candidate.record.scope.resolved, false);
      assert.deepEqual(probe.store.listEligibleMemories(probe.activity), []);
      const proposal = probe.store.saveEvolutionProposal(probe.activity, input, {
        target: 'AGENTS.md', expectedChange: 'Document the local rule', owner: sandbox.fixture.ownerId,
        scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, evidenceRefs: [input],
        evaluation: { schema: 'evaluation-contract@1', level: 'L0', assertions: ['source hash matches'] },
      });
      assert.equal(proposal.inert, true);
      assert.equal(proposal.supersedes, null);
      const revised = probe.store.saveEvolutionProposal(probe.activity, input, {
        target: 'AGENTS.md', expectedChange: 'Document the revised local rule', owner: sandbox.fixture.ownerId,
        scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, evidenceRefs: [input],
        evaluation: { schema: 'evaluation-contract@1', level: 'L1', assertions: ['source hash matches', 'scope matches'] },
        supersedes: proposal.proposalId,
      });
      assert.equal(revised.version, 2);
      assert.equal(revised.inert, true);
      assert.throws(() => probe.store.saveEvolutionProposal(probe.activity, input, {
        target: 'AGENTS.md', expectedChange: 'bad', owner: sandbox.fixture.ownerId,
        scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, evidenceRefs: [input],
        evaluation: { schema: 'evaluation-contract@1', level: 'L0', assertions: [] }, accepted: true,
      } as never), /invalid-proposal/);
    } finally { probe.close(); }
  } finally { rmSync(sandbox.root, { recursive: true, force: true }); }
});
