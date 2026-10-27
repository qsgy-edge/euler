import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { API_VERSION } from '@euler/core';
import { createSandbox, createSandboxSession, bindingOf } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';
import { backupSandbox } from '../src/backup.ts';
import { runBackupCli } from './support/backup-cli.ts';
import { compareCandidate, verifiedCandidate } from './support/memory-evolution.ts';
import { approvedSourceUnit, saveApprovedProposal } from './support/source-publication.ts';

const evidence = new Map<string, string>();
function fixture(name: string) {
  const sandbox = createSandbox(), root = process.env.EULER_BACKUP_RELATIONS_EVIDENCE;
  if (root) {
    const path = join(root, String(evidence.size + 1).padStart(2, '0'));
    mkdirSync(path, { recursive: true }); evidence.set(sandbox.root, path);
    writeFileSync(join(path, 'case.json'), JSON.stringify({ name, root: sandbox.root }, null, 2));
  }
  return sandbox;
}
function preserve(root: string, stage: string) {
  const path = evidence.get(root);
  if (path) cpSync(root, join(path, stage), { recursive: true, filter: source => !source.endsWith('-shm') });
}
function discardFixture(root: string) {
  preserve(root, 'final');
  rmSync(root, { recursive: true, force: true });
}

function damage(root: string, table: string, action: (db: DatabaseSync) => void) {
  preserve(root, 'before');
  const db = new DatabaseSync(join(root, 'probe.sqlite'));
  try {
    db.function('euler_store_writer', () => 1);
    for (const row of db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name=? AND sql LIKE '%UPDATE%'").all(table))
      db.exec(`DROP TRIGGER "${String(row.name).replaceAll('"', '""')}"`);
    action(db);
    assert.equal(db.prepare('PRAGMA quick_check').get()!.quick_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
  preserve(root, 'damaged');
}

for (const field of ['adapter', 'authorized-at', 'execution-owner']) test(`audit rejects a request whose frozen ${field} disagrees`, t => {
  const sandbox = fixture(t.name);
  const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  const other = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const turn = probe.session.prepare(randomUUID(), 'A synthetic attempt with a frozen request identity');
    const runId = probe.session.runId;
    const attempt = probe.store.startRequestAttempt(probe.activity, { runId, assemblyId: turn.assemblyId,
      payloadHash: turn.payloadHash, byteLength: Buffer.byteLength(turn.payload), adapterVersion: API_VERSION });
    const table = field === 'adapter' ? 'request_attempts' : field === 'authorized-at' ? 'request_runs' : 'execution_events';
    damage(sandbox.root, table, db => {
      if (field === 'adapter') db.prepare("UPDATE request_attempts SET adapter_version='unsupported@1' WHERE attempt_id=?").run(attempt.attemptId);
      else if (field === 'authorized-at') db.prepare("UPDATE request_runs SET authorized_at='2099-01-01T00:00:00.000Z' WHERE run_id=?").run(runId);
      else db.prepare("UPDATE execution_events SET activity_id=? WHERE attempt_id=? AND kind='attempt-bound'").run(other.activity.id, attempt.attemptId);
    });
    assert.throws(() => probe.store.auditStore(probe.activity), /ledger-evidence-gap/);
  } finally { other.store.close(); probe.store.close(); discardFixture(sandbox.root); }
});

for (const field of ['digest', 'source-row']) test(`audit rejects a comparison verification with corrupt ${field}`, t => {
  const sandbox = fixture(t.name), probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const first = verifiedCandidate(probe, '本项目在 Windows 使用 PowerShell', { appliesTo: ['platform:win32'] }).record!;
    probe.store.promoteMemory(probe.activity, first.recordId, first);
    const second = verifiedCandidate(probe, '本项目在 Linux 使用 Bash', { appliesTo: ['platform:linux'] });
    probe.store.promoteMemory(probe.activity, second.record!.recordId, second.record!);
    const settled = compareCandidate(probe, second.jobId, 'distinct')!;
    damage(sandbox.root, field === 'digest' ? 'verification_runs' : 'verification_evidence', db => {
      const row = db.prepare("SELECT json_extract(payload,'$.runId') AS run_id FROM memory_events WHERE kind='comparison' AND json_extract(payload,'$.result')='pass' LIMIT 1").get()!;
      if (field === 'digest') db.prepare('UPDATE verification_runs SET evidence_hash=? WHERE run_id=?').run('0'.repeat(64), row.run_id!);
      else db.prepare('UPDATE verification_evidence SET hash=? WHERE run_id=?').run('0'.repeat(64), row.run_id!);
    });
    assert.throws(() => probe.store.readMemory(probe.activity, settled.record!.recordId), /comparison-evidence-gap|evidence-reference-gap/);
    assert.throws(() => probe.store.auditStore(probe.activity), /comparison-evidence-gap|evidence-reference-gap|verification-evidence-gap/);
  } finally { probe.store.close(); discardFixture(sandbox.root); }
});

test('audit rejects a capture work comparison linked to an unrelated event', t => {
  const sandbox = fixture(t.name), probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const first = verifiedCandidate(probe, '本项目保留原始日志').record!;
    probe.store.promoteMemory(probe.activity, first.recordId, first);
    const second = verifiedCandidate(probe, '本项目保存原始日志');
    probe.store.promoteMemory(probe.activity, second.record!.recordId, second.record!);
    damage(sandbox.root, 'capture_work', db => {
      const event = db.prepare("SELECT event_id FROM memory_events WHERE record_id=? AND kind='capture'").get(second.record!.recordId)!;
      assert.equal(db.prepare("UPDATE capture_work SET comparison_event_id=? WHERE job_id=? AND stage='comparing'").run(event.event_id!, second.jobId).changes, 1);
    });
    assert.throws(() => probe.store.auditStore(probe.activity), /comparison-evidence-gap/);
  } finally { probe.store.close(); discardFixture(sandbox.root); }
});

test('audit rejects workspace membership whose owner disagrees with its project', t => {
  const sandbox = fixture(t.name), probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const workspaceId = randomUUID();
    probe.store.bindWorkspace(probe.activity, workspaceId, [sandbox.fixture.projectId]);
    damage(sandbox.root, 'workspaces', db => db.prepare('UPDATE workspaces SET owner_id=? WHERE workspace_id=?').run(randomUUID(), workspaceId));
    assert.throws(() => probe.store.auditStore(probe.activity), /guidance-scope-unresolved/);
  } finally { probe.store.close(); discardFixture(sandbox.root); }
});

for (const kind of ['sessioN','job','missing']) test(`a corrupt recovery owner kind ${kind} cannot reopen an old session`, t => {
  const sandbox = fixture(t.name);
  try {
    assert.equal(runBackupCli(sandbox.root, 'run').status, 0);
    const backed = runBackupCli(sandbox.root, 'backup'); assert.equal(backed.status, 0, backed.stderr);
    const id = backed.events.find(e => e.event === 'backup-result').snapshot.id;
    const restored = runBackupCli(sandbox.root, 'restore-snapshot', ['--snapshot', id]); assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    assert.equal(runBackupCli(sandbox.root, 'run').status, 1);
    damage(sandbox.root, 'store_recovered_owners', db => {
      if (kind === 'missing') {
        db.exec('DROP TRIGGER immutable_store_recovered_owners_delete');
        assert.equal(db.prepare("DELETE FROM store_recovered_owners WHERE kind='session' AND owner_id=?").run(sandbox.fixture.sessionId).changes, 1);
      } else assert.equal(db.prepare("UPDATE store_recovered_owners SET kind=? WHERE kind='session' AND owner_id=?").run(kind, sandbox.fixture.sessionId).changes, 1);
    });
    const result = runBackupCli(sandbox.root, 'run');
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.events.find(e => e.event === 'error').reason, /snapshot-recovery-evidence-gap|recovered-stream-blocked/);
  } finally { discardFixture(sandbox.root); }
});

test('migration checkpoint rejects a corrupt existing snapshot catalog digest', async t => {
  const sandbox = fixture(t.name);
  try {
    assert.equal(runBackupCli(sandbox.root, 'run').status, 0);
    const saved = await backupSandbox(sandbox);
    damage(sandbox.root, 'store_snapshots', db => db.prepare('UPDATE store_snapshots SET digest=? WHERE snapshot_id=?').run('0'.repeat(64), saved.snapshot!.id));
    await assert.rejects(() => backupSandbox(sandbox, 'migration'), /snapshot-manifest-mismatch/);
  } finally { discardFixture(sandbox.root); }
});

function discovery(probe: ReturnType<typeof openProbe>, projectId: string) {
  const text = 'Atlas source for an authorized query';
  const ref = probe.archive.append(randomUUID(), text);
  probe.store.publishSourceUnit(probe.activity, approvedSourceUnit(probe, { ref, projectId, kind: 'source', offset: 0, length: text.length }));
  probe.store.drainSourceProjection(probe.activity);
  const intent = probe.store.readIntent(probe.activity)!;
  const targets = { [projectId]: { component: 'engine' } };
  const approval = probe.archive.append(randomUUID(), JSON.stringify({ schema: 'memory-discovery-approval@1',
    intentId: intent.intentId, goalEventId: intent.goalInput.eventId, projectIds: [projectId], targets, maxResults: 8, maxBytes: 131072 }));
  return probe.store.authorizeMemoryDiscovery(probe.activity, approval, [projectId], 8, targets);
}

for (const state of ['active','revoked']) for (const field of ['digest','target'])
  test(`audit rejects corrupt ${field} in a ${state} discovery grant`, t => {
    const sandbox = fixture(t.name), probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    try {
      const { grantId } = discovery(probe, sandbox.fixture.projectId);
      if (state === 'revoked') probe.store.revokeMemoryDiscovery(probe.activity, grantId);
      damage(sandbox.root, field === 'digest' ? 'memory_discovery_grants' : 'memory_discovery_targets', db => {
        if (field === 'digest') db.prepare('UPDATE memory_discovery_grants SET consent_hash=? WHERE grant_id=?').run('0'.repeat(64), grantId);
        else db.prepare("UPDATE memory_discovery_targets SET component='other' WHERE grant_id=?").run(grantId);
      });
      assert.throws(() => probe.store.auditStore(probe.activity), /discovery-not-authorized/);
    } finally { probe.store.close(); discardFixture(sandbox.root); }
  });

test('audit reads historical discovery approval in its own project and session', t => {
  const sandbox = fixture(t.name);
  const binding = { ...bindingOf(sandbox), projectId: randomUUID(), sessionId: randomUUID(), branchId: randomUUID() };
  createSandboxSession(sandbox, binding);
  const origin = openProbe(sandbox, undefined, undefined, binding, undefined, true);
  const reader = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const { grantId } = discovery(origin, binding.projectId);
    const intent = origin.store.readIntent(origin.activity)!;
    const done = origin.archive.append(randomUUID(), 'Complete the approved task');
    origin.store.transitionIntent(origin.activity, intent.eventId, done, { status: 'completed', step: 'done' });
    assert.throws(() => reader.store.assertMemoryDiscovery(reader.activity, grantId), /discovery-not-authorized/);
    reader.store.auditStore(reader.activity);
  } finally { reader.store.close(); origin.store.close(); discardFixture(sandbox.root); }
});

for (const field of ['request_hash','page_hash']) test(`audit rejects a source query receipt with corrupt ${field}`, t => {
  const sandbox = fixture(t.name), probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const { grantId } = discovery(probe, sandbox.fixture.projectId);
    const request = { query: 'Atlas', grantId, queryId: randomUUID() };
    const page = probe.store.searchSources(probe.activity, request);
    assert.equal(page.results.length, 1);
    damage(sandbox.root, 'source_query_receipts', db => {
      assert.equal(db.prepare(`UPDATE source_query_receipts SET ${field}=? WHERE grant_id=? AND query_id=?`)
        .run('0'.repeat(64), grantId, request.queryId).changes, 1);
    });
    assert.throws(() => probe.store.assertSourceSearchResult(probe.activity, request, page), /source-query-result-stale|source-query-evidence-gap/);
    assert.throws(() => probe.store.auditStore(probe.activity), /source-query-evidence-gap/);
  } finally { probe.store.close(); discardFixture(sandbox.root); }
});

for (const field of ['intent','source','proposal','feedback']) test(`audit rejects a corrupted ${field} idempotency key`, t => {
  const sandbox = fixture(t.name), probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const tables = { intent: ['intent_events','transition_hash'], source: ['source_units','request_hash'],
      proposal: ['evolution_proposals','request_hash'], feedback: ['feedback_events','identity_hash'] } as const;
    if (field === 'intent') {
      const goal = probe.archive.append(randomUUID(), 'Preserve the original transition identity');
      probe.store.transitionIntent(probe.activity, null, goal, { status: 'active', step: 'first' }, 'Preserve the original transition identity');
    } else if (field === 'source') discovery(probe, sandbox.fixture.projectId);
    else if (field === 'proposal') {
      const ref = probe.archive.append(randomUUID(), 'Evidence for a synthetic proposal');
      saveApprovedProposal(probe, { target: 'AGENTS.md', expectedChange: 'Keep local logs', owner: sandbox.fixture.ownerId,
        scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, evidenceRefs: [ref],
        evaluation: { schema: 'evaluation-contract@1', level: 'L0', assertions: ['Keep the log'] } });
    } else {
      const input = probe.archive.append(randomUUID(), '记住偏好：在本机保留日志');
      const result = probe.store.rememberMemory(probe.activity, { input, hostInfo: 'durable' });
      assert.equal(result.status, 'activated');
      const record = result.record!;
      const feedback = probe.archive.append(randomUUID(), JSON.stringify({ schema: 'memory-feedback@1', kind: 'user_helpful',
        recordId: record.recordId, revisionId: record.revisionId, headEventId: record.headEventId }));
      probe.store.recordMemoryFeedback(probe.activity, record.recordId, record, feedback);
    }
    const [table, column] = tables[field as keyof typeof tables];
    damage(sandbox.root, table, db => assert.equal(db.prepare(`UPDATE ${table} SET ${column}=?`).run('0'.repeat(64)).changes, 1));
    assert.throws(() => probe.store.auditStore(probe.activity), /intent-evidence-gap|source-evidence-gap|proposal-evidence-gap|feedback-evidence-gap/);
  } finally { probe.store.close(); discardFixture(sandbox.root); }
});

test('audit rejects capture work referencing another execution owner', t => {
  const sandbox = fixture(t.name), probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const job = verifiedCandidate(probe, '本项目保存合成日志');
    const runId = probe.session.runId;
    damage(sandbox.root, 'capture_work', db => assert.equal(db.prepare('UPDATE capture_work SET run_id=? WHERE job_id=?').run(runId, job.jobId).changes, 1));
    assert.throws(() => probe.store.auditStore(probe.activity), /request-scope-mismatch/);
  } finally { probe.store.close(); discardFixture(sandbox.root); }
});
