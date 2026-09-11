import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { createSandbox, openSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';
import { startCli } from '../src/process-driver.ts';

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

test('separate CLI processes rebuild the same active memory head', { timeout: 15000 }, async () => {
  const sandbox = createSandbox();
  try {
    const writer = startCli(['memory', '--sandbox', sandbox.root]);
    assert.equal((await writer.exit).code, 0);
    const written = writer.observations.find(item => item.event === 'memory-result')!;
    const reader = startCli(['recover', '--sandbox', sandbox.root]);
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
      assert.throws(() => probe.store.rollbackMemory(probe.activity, activated.record.recordId, activated.record, activated.eventId!), /memory-stale/);
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
