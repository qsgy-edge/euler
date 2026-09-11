import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { check, sameBinding, sha256, uuid } from '../contracts.ts';
import type { Binding, SourceAck } from '../contracts.ts';

export interface FileIdentity { dev: string; ino: string }
export interface BoundFile { path: string; identity: FileIdentity }
export interface StoreResources { root: BoundFile; source: BoundFile; store: BoundFile }

export function fileIdentity(path: string): FileIdentity {
  const stat = lstatSync(path, { bigint: true });
  check(!stat.isSymbolicLink() && (stat.isDirectory() || stat.nlink === 1n), 'unsafe-file-identity');
  return { dev: String(stat.dev), ino: String(stat.ino) };
}
export function sameFile(path: string, identity: FileIdentity): void {
  const actual = fileIdentity(path);
  check(actual.dev === identity.dev && actual.ino === identity.ino, 'file-identity-changed');
}

export interface Activity {
  id: string;
  pid: number;
  incarnation: string;
  startedAt: string;
  epoch: number;
  root: BoundFile;
}
export type MemoryType = 'fact' | 'preference' | 'decision' | 'insight' | 'episode';
export type MemoryLifecycle = 'candidate' | 'active' | 'superseded' | 'rejected' | 'tombstoned';
export type MemoryVerification = 'unverified' | 'verified' | 'conflicted' | 'stale';
export type MemoryScopeKind = 'project' | 'workspace' | 'personal' | 'session';
export interface MemoryScope { kind: MemoryScopeKind; id: string; resolved: boolean }
export interface MemoryCaptureOptions { type: MemoryType; scope: MemoryScope; appliesTo: string[] }
export interface MemoryRecord {
  schema: 'memory-record@1'; recordId: string; revisionId: string; revision: number;
  content: string; contentHash: string; type: MemoryType; lifecycle: MemoryLifecycle;
  verification: MemoryVerification; scope: MemoryScope; appliesTo: string[]; source: SourceAck;
  conflictSetId: string | null; headEventId: string; hash: string;
}
export interface MemoryOperation { status: 'committed' | 'no_op'; record: MemoryRecord; eventId: string | null }
export interface ConflictOperation { status: 'committed' | 'no_op'; left: MemoryOperation; right: MemoryOperation; conflictSetId: string | null }
export interface EvolutionProposalInput {
  target: string; expectedChange: string; owner: string; scope: MemoryScope; evidenceRefs: SourceAck[];
  evaluation: { schema: 'evaluation-contract@1'; level: 'L0' | 'L1' | 'L2' | 'L3'; assertions: string[] };
  supersedes?: string;
}
export interface EvolutionProposal {
  schema: 'evolution-proposal@1'; proposalId: string; version: number; target: string;
  expectedChange: string; owner: string; scope: MemoryScope; evidenceRefs: SourceAck[];
  evaluation: EvolutionProposalInput['evaluation']; supersedes: string | null; inert: true; hash: string;
}
const processIdentity = Object.freeze({ pid: process.pid, incarnation: randomUUID(), startedAt: new Date(performance.timeOrigin).toISOString() });
export interface Intent {
  schema: 'intent@1';
  intentId: string;
  eventId: string;
  version: number;
  binding: Binding;
  goal: string;
  constraints: string[];
  step: string;
  status: 'active' | 'paused' | 'completed' | 'needs-input';
  input: SourceAck;
  goalInput: SourceAck;
  hash: string;
}
export type IntentTransition = Pick<Intent, 'step' | 'status'>;
interface Fence {
  store_id: string;
  state: 'open' | 'closing' | 'exclusive';
  epoch: number;
  coordinator: string | null;
  coordinator_pid: number | null;
}

const DDL = `
CREATE TABLE owner_fences (
  store_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, host_id TEXT NOT NULL,
  project_id TEXT NOT NULL, session_id TEXT NOT NULL, branch_id TEXT NOT NULL,
  root_path TEXT NOT NULL, root_dev TEXT NOT NULL, root_ino TEXT NOT NULL,
  source_path TEXT NOT NULL, source_dev TEXT NOT NULL, source_ino TEXT NOT NULL,
  store_path TEXT NOT NULL, store_dev TEXT NOT NULL, store_ino TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('open','closing','exclusive')),
  epoch INTEGER NOT NULL CHECK(epoch > 0), coordinator TEXT, coordinator_pid INTEGER,
  UNIQUE(store_id, root_path, root_dev, root_ino)
) STRICT;
CREATE TABLE owner_activities (
  id TEXT PRIMARY KEY, store_id TEXT NOT NULL,
  pid INTEGER NOT NULL, incarnation TEXT NOT NULL, started_at TEXT NOT NULL, epoch INTEGER NOT NULL,
  root_path TEXT NOT NULL, root_dev TEXT NOT NULL, root_ino TEXT NOT NULL,
  FOREIGN KEY(store_id, root_path, root_dev, root_ino) REFERENCES owner_fences(store_id, root_path, root_dev, root_ino)
) STRICT;
CREATE TABLE intent_events (
  event_id TEXT PRIMARY KEY, intent_id TEXT NOT NULL, version INTEGER NOT NULL,
  session_id TEXT NOT NULL, branch_id TEXT NOT NULL,
  input_event_id TEXT NOT NULL, expected_event_id TEXT REFERENCES intent_events(event_id),
  status TEXT NOT NULL CHECK(status IN ('active','paused','completed','needs-input')),
  input_hash TEXT NOT NULL, input_content_hash TEXT NOT NULL, input_locator TEXT NOT NULL, input_bytes INTEGER NOT NULL CHECK(input_bytes > 0),
  goal_input_event_id TEXT NOT NULL, goal_input_hash TEXT NOT NULL, goal_input_content_hash TEXT NOT NULL,
  goal_input_locator TEXT NOT NULL, goal_input_bytes INTEGER NOT NULL CHECK(goal_input_bytes > 0),
  transition_hash TEXT NOT NULL, snapshot TEXT NOT NULL, hash TEXT NOT NULL,
  UNIQUE(session_id, branch_id, version), UNIQUE(session_id, branch_id, input_event_id)
) STRICT;
CREATE TABLE intent_heads (
  session_id TEXT NOT NULL, branch_id TEXT NOT NULL,
  event_id TEXT NOT NULL REFERENCES intent_events(event_id), PRIMARY KEY(session_id, branch_id)
) STRICT;
CREATE TRIGGER immutable_intent_update BEFORE UPDATE ON intent_events BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER immutable_intent_delete BEFORE DELETE ON intent_events BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TABLE memory_records (
  record_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE memory_revisions (
  revision_id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES memory_records(record_id), revision INTEGER NOT NULL CHECK(revision > 0),
  content TEXT NOT NULL, content_hash TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('fact','preference','decision','insight','episode')),
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('project','workspace','personal','session')), scope_id TEXT NOT NULL,
  scope_resolved INTEGER NOT NULL CHECK(scope_resolved IN (0,1)), applies_to TEXT NOT NULL, source_json TEXT NOT NULL,
  source_event_id TEXT NOT NULL UNIQUE, source_hash TEXT NOT NULL, source_content_hash TEXT NOT NULL, source_locator TEXT NOT NULL,
  UNIQUE(record_id, revision)
) STRICT;
CREATE TABLE capture_jobs (
  job_id TEXT PRIMARY KEY, source_event_id TEXT NOT NULL UNIQUE, record_id TEXT NOT NULL REFERENCES memory_records(record_id),
  status TEXT NOT NULL CHECK(status IN ('captured','complete')), payload TEXT NOT NULL, payload_hash TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE provenance_refs (
  ref_id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES memory_records(record_id), revision_id TEXT NOT NULL REFERENCES memory_revisions(revision_id),
  owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, source_json TEXT NOT NULL, source_event_id TEXT NOT NULL, locator TEXT NOT NULL,
  content_hash TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT NOT NULL
) STRICT;
CREATE TABLE memory_heads (
  record_id TEXT PRIMARY KEY REFERENCES memory_records(record_id), revision_id TEXT NOT NULL REFERENCES memory_revisions(revision_id),
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('candidate','active','superseded','rejected','tombstoned')),
  verification TEXT NOT NULL CHECK(verification IN ('unverified','verified','conflicted','stale')),
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('project','workspace','personal','session')), scope_id TEXT NOT NULL,
  scope_resolved INTEGER NOT NULL CHECK(scope_resolved IN (0,1)), head_event_id TEXT NOT NULL,
  snapshot TEXT NOT NULL, snapshot_hash TEXT NOT NULL, conflict_set_id TEXT
) STRICT;
CREATE TABLE memory_events (
  event_id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES memory_records(record_id), seq INTEGER NOT NULL CHECK(seq > 0), kind TEXT NOT NULL,
  revision_id TEXT NOT NULL REFERENCES memory_revisions(revision_id), before_snapshot TEXT, after_snapshot TEXT NOT NULL,
  payload TEXT NOT NULL, payload_hash TEXT NOT NULL, source_event_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(record_id, seq)
) STRICT;
CREATE TABLE verification_runs (
  run_id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES memory_records(record_id), revision_id TEXT NOT NULL REFERENCES memory_revisions(revision_id),
  result TEXT NOT NULL CHECK(result IN ('pass','block','evidence-gap')), evidence_json TEXT NOT NULL, evidence_hash TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE conflict_sets (conflict_set_id TEXT PRIMARY KEY, created_at TEXT NOT NULL) STRICT;
CREATE TABLE conflict_members (
  conflict_set_id TEXT NOT NULL REFERENCES conflict_sets(conflict_set_id), record_id TEXT NOT NULL REFERENCES memory_records(record_id),
  PRIMARY KEY(conflict_set_id, record_id)
) STRICT;
CREATE TABLE evolution_proposals (
  proposal_id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version > 0), target TEXT NOT NULL, expected_change TEXT NOT NULL,
  owner TEXT NOT NULL, scope_json TEXT NOT NULL, evidence_json TEXT NOT NULL, evaluation_json TEXT NOT NULL,
  supersedes TEXT REFERENCES evolution_proposals(proposal_id), payload TEXT NOT NULL, payload_hash TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(target, version)
) STRICT;
CREATE TRIGGER immutable_memory_records_update BEFORE UPDATE ON memory_records BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER immutable_memory_records_delete BEFORE DELETE ON memory_records BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER immutable_memory_revisions_update BEFORE UPDATE ON memory_revisions BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER immutable_memory_revisions_delete BEFORE DELETE ON memory_revisions BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER immutable_memory_events_update BEFORE UPDATE ON memory_events BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER immutable_memory_events_delete BEFORE DELETE ON memory_events BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER immutable_verification_runs_update BEFORE UPDATE ON verification_runs BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER immutable_verification_runs_delete BEFORE DELETE ON verification_runs BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER immutable_capture_jobs_update BEFORE UPDATE ON capture_jobs BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER immutable_capture_jobs_delete BEFORE DELETE ON capture_jobs BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER immutable_provenance_refs_update BEFORE UPDATE ON provenance_refs BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER immutable_provenance_refs_delete BEFORE DELETE ON provenance_refs BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER immutable_evolution_proposals_update BEFORE UPDATE ON evolution_proposals BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER immutable_evolution_proposals_delete BEFORE DELETE ON evolution_proposals BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE INDEX memory_heads_eligibility ON memory_heads(lifecycle, verification, scope_kind, scope_id, scope_resolved);
PRAGMA user_version=2;
`;
export const probeSchemaDigest = sha256(DDL);

// P0 disposable schema; not migrations/001-initial.sql and not the execution ledger.
export class ProbeStore {
  readonly #db: DatabaseSync;
  readonly #storeId: string;
  readonly #binding: Binding;
  readonly #resources: StoreResources;
  #depth = 0;

  constructor(resources: StoreResources, storeId: string, binding: Binding, initialize = false) {
    this.#storeId = storeId;
    this.#binding = structuredClone(binding);
    this.#resources = structuredClone(resources);
    this.#verifyResources();
    this.#db = new DatabaseSync(resources.store.path);
    try {
      this.#db.exec('PRAGMA busy_timeout=2000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
      const version = this.#db.prepare('PRAGMA user_version').get()!.user_version;
      if (initialize) {
        check(version === 0, 'already-initialized');
        this.#db.exec('PRAGMA journal_mode=WAL;');
        this.#transaction(() => {
          this.#db.exec(DDL);
          this.#db.prepare('INSERT INTO owner_fences VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL)')
            .run(storeId, binding.ownerId, binding.hostId, binding.projectId, binding.sessionId, binding.branchId,
              resources.root.path, resources.root.identity.dev, resources.root.identity.ino,
              resources.source.path, resources.source.identity.dev, resources.source.identity.ino,
              resources.store.path, resources.store.identity.dev, resources.store.identity.ino, 'open');
        });
      } else {
        check(version === 2, 'unsupported-probe-schema');
        check(this.#db.prepare('PRAGMA journal_mode').get()!.journal_mode === 'wal', 'invalid-journal-mode');
      }
      const row = this.#db.prepare('SELECT * FROM owner_fences WHERE store_id=?').get(storeId);
      check(row && row.owner_id === binding.ownerId && row.host_id === binding.hostId
        && row.project_id === binding.projectId && row.session_id === binding.sessionId && row.branch_id === binding.branchId, 'store-binding-mismatch');
      this.fence();
    } catch (error) { this.#db.close(); throw error; }
  }

  #verifyResources(): void {
    for (const resource of Object.values(this.#resources)) sameFile(resource.path, resource.identity);
  }

  #transaction<T>(action: () => T): T {
    this.#verifyResources();
    if (this.#depth) return action();
    this.#db.exec('BEGIN IMMEDIATE');
    this.#depth++;
    try {
      const value = action();
      check(!(value instanceof Promise), 'async-store-transaction');
      this.#verifyResources();
      this.#db.exec('COMMIT');
      return value;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    } finally { this.#depth--; }
  }

  fence(): Fence {
    this.#verifyResources();
    const row = this.#db.prepare('SELECT * FROM owner_fences WHERE store_id=?').get(this.#storeId);
    check(row, 'missing-owner-fence');
    for (const kind of ['root', 'source', 'store'] as const) {
      const resource = this.#resources[kind];
      check(row[`${kind}_path`] === resource.path && row[`${kind}_dev`] === resource.identity.dev
        && row[`${kind}_ino`] === resource.identity.ino, 'store-resource-mismatch');
    }
    return row as unknown as Fence;
  }

  register(): Activity {
    return this.#transaction(() => {
      const fence = this.fence();
      check(fence.state === 'open', 'admission-closed');
      const activity = { ...processIdentity, id: randomUUID(), epoch: fence.epoch, root: structuredClone(this.#resources.root) };
      this.#db.prepare('INSERT INTO owner_activities VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(activity.id, this.#storeId, activity.pid, activity.incarnation, activity.startedAt, activity.epoch,
          activity.root.path, activity.root.identity.dev, activity.root.identity.ino);
      return activity;
    });
  }

  withActivity<T>(activity: Activity, action: () => T): T {
    return this.#transaction(() => {
      const fence = this.fence();
      const row = this.#db.prepare('SELECT * FROM owner_activities WHERE id=?').get(activity.id);
      check(fence.state === 'open' && fence.epoch === activity.epoch && row
        && row.incarnation === processIdentity.incarnation && row.pid === process.pid && row.store_id === this.#storeId
        && row.root_path === this.#resources.root.path && row.root_dev === this.#resources.root.identity.dev
        && row.root_ino === this.#resources.root.identity.ino
        && JSON.stringify(activity.root) === JSON.stringify(this.#resources.root)
        && row.epoch === activity.epoch, 'admission-closed');
      return action();
    });
  }

  readIntent(activity: Activity): Intent | null {
    return this.withActivity(activity, () => {
      const row = this.#db.prepare(`SELECT e.* FROM intent_heads h JOIN intent_events e ON h.event_id=e.event_id
        WHERE h.session_id=? AND h.branch_id=?`).get(this.#binding.sessionId, this.#binding.branchId);
      if (!row) {
        const event = this.#db.prepare('SELECT 1 FROM intent_events WHERE session_id=? AND branch_id=? LIMIT 1').get(this.#binding.sessionId, this.#binding.branchId);
        check(!event, 'intent-evidence-gap');
        return null;
      }
      const snapshot = String(row.snapshot);
      check(sha256(snapshot) === row.hash, 'intent-evidence-gap');
      const intent = JSON.parse(snapshot) as Omit<Intent, 'hash'>;
      check(intent.schema === 'intent@1' && intent.eventId === row.event_id && intent.version === row.version
        && intent.intentId === row.intent_id && intent.status === row.status
        && intent.input.eventId === row.input_event_id && intent.input.hash === row.input_hash
        && intent.input.contentHash === row.input_content_hash
        && intent.input.locator === row.input_locator && intent.input.byteLength === row.input_bytes
        && intent.goalInput.eventId === row.goal_input_event_id && intent.goalInput.hash === row.goal_input_hash
        && intent.goalInput.contentHash === row.goal_input_content_hash
        && intent.goalInput.locator === row.goal_input_locator && intent.goalInput.byteLength === row.goal_input_bytes
        && sameBinding(intent.input.binding, this.#binding) && sameBinding(intent.goalInput.binding, this.#binding)
        && sameBinding(intent.binding, this.#binding), 'intent-evidence-gap');
      return { ...intent, hash: String(row.hash) };
    });
  }

  recoverIntent(activity: Activity): Intent | null {
    return this.withActivity(activity, () => {
      const current = this.readIntent(activity);
      const rows = this.#db.prepare('SELECT * FROM intent_events WHERE session_id=? AND branch_id=? ORDER BY version')
        .all(this.#binding.sessionId, this.#binding.branchId);
      let prior: string | null = null;
      for (const [index, row] of rows.entries()) {
        check(row.version === index + 1 && row.expected_event_id === prior && sha256(String(row.snapshot)) === row.hash, 'intent-evidence-gap');
        prior = String(row.event_id);
      }
      check(prior === (current?.eventId ?? null), 'intent-evidence-gap');
      return current;
    });
  }

  transitionIntent(activity: Activity, expected: string | null, input: SourceAck, transition: IntentTransition, initialGoal?: string): Intent {
    return this.withActivity(activity, () => {
      check(sameBinding(input.binding, this.#binding) && input.status === 'durable', 'source-scope-mismatch');
      uuid(input.eventId);
      check(transition && typeof transition === 'object'
        && Object.keys(transition).every(key => key === 'step' || key === 'status'), 'invalid-transition');
      check(['active', 'paused', 'completed', 'needs-input'].includes(transition.status)
        && typeof transition.step === 'string' && transition.step.length > 0 && Buffer.byteLength(transition.step) <= 1024, 'invalid-transition');
      const transitionHash = sha256(JSON.stringify({ expected, input, transition, initialGoal: initialGoal ?? null }));
      const previous = this.#db.prepare('SELECT * FROM intent_events WHERE session_id=? AND branch_id=? AND input_event_id=?')
        .get(this.#binding.sessionId, this.#binding.branchId, input.eventId);
      if (previous) {
        check(previous.transition_hash === transitionHash, 'identity-conflict');
        return { ...JSON.parse(String(previous.snapshot)), hash: previous.hash } as Intent;
      }
      const current = this.readIntent(activity);
      check((current?.eventId ?? null) === expected, 'intent-stale');
      check(current || (typeof initialGoal === 'string' && Buffer.byteLength(initialGoal) <= 65536
        && sha256(initialGoal) === input.contentHash), 'intent-needs-input');
      const snapshot: Omit<Intent, 'hash'> = {
        schema: 'intent@1', intentId: current?.intentId ?? randomUUID(), eventId: randomUUID(),
        version: (current?.version ?? 0) + 1, binding: this.#binding,
        goal: current?.goal ?? initialGoal!, constraints: current?.constraints ?? ['synthetic-only', 'local-counting-transport-only'],
        step: transition.step, status: transition.status, input, goalInput: current?.goalInput ?? input,
      };
      const bytes = JSON.stringify(snapshot);
      const hash = sha256(bytes);
      this.#db.prepare('INSERT INTO intent_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(snapshot.eventId, snapshot.intentId, snapshot.version, this.#binding.sessionId, this.#binding.branchId,
          input.eventId, expected, snapshot.status, input.hash, input.contentHash, input.locator, input.byteLength,
          snapshot.goalInput.eventId, snapshot.goalInput.hash, snapshot.goalInput.contentHash, snapshot.goalInput.locator, snapshot.goalInput.byteLength,
          transitionHash, bytes, hash);
      this.#db.prepare(`INSERT INTO intent_heads VALUES (?, ?, ?) ON CONFLICT(session_id,branch_id) DO UPDATE SET event_id=excluded.event_id`)
        .run(this.#binding.sessionId, this.#binding.branchId, snapshot.eventId);
      return { ...snapshot, hash };
    });
  }

  captureMemory(activity: Activity, input: SourceAck, content: string, options: MemoryCaptureOptions): MemoryOperation {
    return this.withActivity(activity, () => {
      check(Object.keys(options).every(key => key === 'type' || key === 'scope' || key === 'appliesTo'), 'invalid-memory-options');
      this.#validateSource(input, content);
      const scope = this.#validateScope(options.scope);
      const appliesTo = this.#normalizeAppliesTo(options.appliesTo);
      check(['fact', 'preference', 'decision', 'insight', 'episode'].includes(options.type), 'invalid-memory-type');
      const existing = this.#db.prepare('SELECT * FROM memory_revisions WHERE source_event_id=?').get(input.eventId);
      if (existing) {
        const same = existing.content === content && existing.type === options.type && existing.scope_kind === scope.kind
          && existing.scope_id === scope.id && Number(existing.scope_resolved) === (scope.resolved ? 1 : 0)
          && existing.applies_to === JSON.stringify(appliesTo) && existing.source_json === JSON.stringify(input);
        check(same, 'identity-conflict');
        return { status: 'no_op', record: this.#readMemoryUnsafe(String(existing.record_id)), eventId: null };
      }
      const recordId = randomUUID();
      const revisionId = randomUUID();
      const eventId = randomUUID();
      const base = { schema: 'memory-record@1' as const, recordId, revisionId, revision: 1,
        content, contentHash: sha256(content), type: options.type, lifecycle: 'candidate' as const,
        verification: 'unverified' as const, scope, appliesTo, source: structuredClone(input), conflictSetId: null, headEventId: eventId };
      const record = this.#withMemoryHash(base);
      this.#db.prepare('INSERT INTO memory_records VALUES (?, ?, ?)').run(recordId, this.#binding.ownerId, new Date().toISOString());
      this.#insertRevision(record);
      const capturePayload = JSON.stringify({ schema: 'capture-job@1', source: input, recordId });
      this.#db.prepare('INSERT INTO capture_jobs VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), input.eventId, recordId, 'complete', capturePayload, sha256(capturePayload), new Date().toISOString());
      this.#appendMemoryEvent(null, record, 'capture', input.eventId, { automatic: true });
      return { status: 'committed', record, eventId };
    });
  }

  readMemory(activity: Activity, recordId: string): MemoryRecord {
    return this.withActivity(activity, () => {
      uuid(recordId);
      return this.#readMemoryUnsafe(recordId);
    });
  }

  recoverMemory(activity: Activity, recordId: string): MemoryRecord {
    return this.readMemory(activity, recordId);
  }

  recoverMemories(activity: Activity): MemoryRecord[] {
    return this.withActivity(activity, () => this.#db.prepare('SELECT record_id FROM memory_heads ORDER BY rowid').all()
      .map(row => this.#readMemoryUnsafe(String(row.record_id))));
  }

  listEligibleMemories(activity: Activity): MemoryRecord[] {
    return this.withActivity(activity, () => this.#db.prepare(`SELECT record_id FROM memory_heads
      WHERE lifecycle='active' AND verification='verified' AND scope_resolved=1
      AND ((scope_kind='project' AND scope_id=?) OR (scope_kind='personal' AND scope_id=?))
      ORDER BY rowid`).all(this.#binding.projectId, this.#binding.ownerId)
      .map(row => this.#readMemoryUnsafe(String(row.record_id))));
  }

  verifyMemory(activity: Activity, recordId: string, expected: MemoryRecord, result: 'pass' | 'block' | 'evidence-gap', evidence: SourceAck[]): MemoryOperation {
    return this.withActivity(activity, () => {
      const current = this.#assertMemoryExpected(recordId, expected);
      check(['pass', 'block', 'evidence-gap'].includes(result), 'invalid-verification');
      check(Array.isArray(evidence), 'invalid-verification');
      for (const ref of evidence) this.#validateSource(ref);
      check(result !== 'pass' || evidence.length > 0, 'verification-evidence-required');
      const evidenceJson = JSON.stringify(evidence);
      const evidenceHash = sha256(evidenceJson);
      const prior = this.#db.prepare('SELECT 1 FROM verification_runs WHERE record_id=? AND revision_id=? AND result=? AND evidence_hash=?')
        .get(recordId, current.revisionId, result, evidenceHash);
      if (prior) return { status: 'no_op', record: current, eventId: null };
      const runId = randomUUID();
      this.#db.prepare('INSERT INTO verification_runs VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(runId, recordId, current.revisionId, result, evidenceJson, evidenceHash, new Date().toISOString());
      const after = this.#withMemoryHash({ ...current, verification: result === 'pass' ? 'verified' : 'unverified', headEventId: randomUUID() });
      this.#appendMemoryEvent(current, after, 'verify', current.source.eventId, { runId, result, evidence: JSON.parse(evidenceJson) });
      return { status: 'committed', record: after, eventId: after.headEventId };
    });
  }

  activateMemory(activity: Activity, recordId: string, expected: MemoryRecord): MemoryOperation {
    return this.withActivity(activity, () => {
      const current = this.#assertMemoryExpected(recordId, expected);
      if (current.lifecycle === 'active' && current.verification === 'verified') return { status: 'no_op', record: current, eventId: null };
      check(current.lifecycle === 'candidate' && current.verification === 'verified' && current.scope.resolved, 'memory-not-eligible');
      const after = this.#withMemoryHash({ ...current, lifecycle: 'active', headEventId: randomUUID() });
      this.#appendMemoryEvent(current, after, 'activate', current.source.eventId, { automatic: true });
      return { status: 'committed', record: after, eventId: after.headEventId };
    });
  }

  forgetMemory(activity: Activity, recordId: string, expected: MemoryRecord): MemoryOperation {
    return this.withActivity(activity, () => {
      const current = this.#assertMemoryExpected(recordId, expected);
      check(current.lifecycle === 'active', 'memory-not-active');
      const after = this.#withMemoryHash({ ...current, lifecycle: 'tombstoned', headEventId: randomUUID() });
      this.#appendMemoryEvent(current, after, 'forget', current.source.eventId, { reversible: true });
      return { status: 'committed', record: after, eventId: after.headEventId };
    });
  }

  restoreMemory(activity: Activity, recordId: string, expected: MemoryRecord): MemoryOperation {
    return this.withActivity(activity, () => {
      const current = this.#assertMemoryExpected(recordId, expected);
      check(current.lifecycle === 'tombstoned', 'memory-not-tombstoned');
      check(current.verification === 'verified', 'memory-not-eligible');
      const after = this.#withMemoryHash({ ...current, lifecycle: 'active', headEventId: randomUUID() });
      this.#appendMemoryEvent(current, after, 'restore', current.source.eventId, { reversible: true });
      return { status: 'committed', record: after, eventId: after.headEventId };
    });
  }

  correctMemory(activity: Activity, recordId: string, expected: MemoryRecord, input: SourceAck, content: string): MemoryOperation {
    return this.withActivity(activity, () => {
      const current = this.#assertMemoryExpected(recordId, expected);
      check(current.lifecycle !== 'tombstoned', 'tombstoned-not-actionable');
      this.#validateSource(input, content);
      if (sha256(content) === current.contentHash) return { status: 'no_op', record: current, eventId: null };
      const revisionId = randomUUID();
      const eventId = randomUUID();
      const base = { ...current, revisionId, revision: current.revision + 1, content, contentHash: sha256(content),
        lifecycle: current.lifecycle, verification: 'unverified' as const, source: structuredClone(input), headEventId: eventId };
      const after = this.#withMemoryHash(base);
      this.#insertRevision(after);
      this.#appendMemoryEvent(current, after, 'correct', input.eventId, { automatic: false });
      return { status: 'committed', record: after, eventId };
    });
  }

  conflictMemory(activity: Activity, leftId: string, leftExpected: MemoryRecord, rightId: string, rightExpected: MemoryRecord): ConflictOperation {
    return this.withActivity(activity, () => {
      check(leftId !== rightId, 'invalid-conflict');
      const left = this.#assertMemoryExpected(leftId, leftExpected);
      const right = this.#assertMemoryExpected(rightId, rightExpected);
      if (left.verification === 'conflicted' && right.verification === 'conflicted') {
        return { status: 'no_op', left: { status: 'no_op', record: left, eventId: null }, right: { status: 'no_op', record: right, eventId: null }, conflictSetId: null };
      }
      const conflictSetId = randomUUID();
      this.#db.prepare('INSERT INTO conflict_sets VALUES (?, ?)').run(conflictSetId, new Date().toISOString());
      this.#db.prepare('INSERT INTO conflict_members VALUES (?, ?), (?, ?)').run(conflictSetId, leftId, conflictSetId, rightId);
      const nextLeft = this.#withMemoryHash({ ...left, verification: 'conflicted', conflictSetId, headEventId: randomUUID() });
      const nextRight = this.#withMemoryHash({ ...right, verification: 'conflicted', conflictSetId, headEventId: randomUUID() });
      this.#appendMemoryEvent(left, nextLeft, 'conflict', left.source.eventId, { conflictSetId, members: [leftId, rightId] });
      this.#appendMemoryEvent(right, nextRight, 'conflict', right.source.eventId, { conflictSetId, members: [leftId, rightId] });
      return { status: 'committed', left: { status: 'committed', record: nextLeft, eventId: nextLeft.headEventId },
        right: { status: 'committed', record: nextRight, eventId: nextRight.headEventId }, conflictSetId };
    });
  }

  rollbackMemory(activity: Activity, recordId: string, expected: MemoryRecord, targetEventId: string): MemoryOperation {
    return this.withActivity(activity, () => {
      uuid(targetEventId);
      const current = this.#assertMemoryExpected(recordId, expected);
      const event = this.#db.prepare('SELECT * FROM memory_events WHERE event_id=?').get(targetEventId);
      check(event && event.record_id === recordId && event.kind === 'activate' && event.before_snapshot, 'rollback-not-actionable');
      const targetAfter = this.#parseMemorySnapshot(String(event.after_snapshot));
      check(this.#snapshotBytes(current) === this.#snapshotBytes(targetAfter), 'memory-stale');
      const before = this.#parseMemorySnapshot(String(event.before_snapshot));
      check(before.verification === 'verified' && before.lifecycle === 'candidate', 'rollback-not-actionable');
      const after = this.#withMemoryHash({ ...before, headEventId: randomUUID() });
      this.#appendMemoryEvent(current, after, 'rollback', current.source.eventId, { targetEventId, automatic: true });
      return { status: 'committed', record: after, eventId: after.headEventId };
    });
  }

  saveEvolutionProposal(activity: Activity, input: SourceAck, proposal: EvolutionProposalInput & Record<string, unknown>): EvolutionProposal {
    return this.withActivity(activity, () => {
      this.#validateSource(input);
      const keys = Object.keys(proposal);
      check(keys.every(key => ['target', 'expectedChange', 'owner', 'scope', 'evidenceRefs', 'evaluation', 'supersedes'].includes(key)), 'invalid-proposal');
      check(typeof proposal.target === 'string' && proposal.target.length > 0 && Buffer.byteLength(proposal.target) <= 4096
        && typeof proposal.expectedChange === 'string' && proposal.expectedChange.length > 0
        && typeof proposal.owner === 'string' && proposal.owner === this.#binding.ownerId, 'invalid-proposal');
      const scope = this.#validateScope(proposal.scope);
      check(scope.kind !== 'session', 'invalid-proposal');
      check(proposal.evidenceRefs.length > 0, 'invalid-proposal');
      for (const ref of proposal.evidenceRefs) this.#validateSource(ref);
      check(proposal.evaluation?.schema === 'evaluation-contract@1' && ['L0', 'L1', 'L2', 'L3'].includes(proposal.evaluation.level)
        && Array.isArray(proposal.evaluation.assertions), 'invalid-proposal');
      const prior = proposal.supersedes ? this.#db.prepare('SELECT * FROM evolution_proposals WHERE proposal_id=?').get(proposal.supersedes) : null;
      if (proposal.supersedes) check(prior && prior.target === proposal.target, 'invalid-proposal');
      const version = Number(this.#db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM evolution_proposals WHERE target=?').get(proposal.target)!.version) + 1;
      const proposalId = randomUUID();
      const value = { schema: 'evolution-proposal@1' as const, proposalId, version, target: proposal.target,
        expectedChange: proposal.expectedChange, owner: proposal.owner, scope, evidenceRefs: structuredClone(proposal.evidenceRefs),
        evaluation: structuredClone(proposal.evaluation), supersedes: proposal.supersedes ?? null, inert: true as const };
      const payload = JSON.stringify(value);
      const result = { ...value, hash: sha256(payload) };
      this.#db.prepare('INSERT INTO evolution_proposals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(proposalId, version, proposal.target, proposal.expectedChange, proposal.owner, JSON.stringify(scope),
          JSON.stringify(proposal.evidenceRefs), JSON.stringify(proposal.evaluation), proposal.supersedes ?? null, payload, result.hash, new Date().toISOString());
      return result;
    });
  }

  #validateSource(input: SourceAck, content?: string): void {
    check(input?.schema === 'cli-source-ack@1' && input.status === 'durable' && sameBinding(input.binding, this.#binding), 'source-scope-mismatch');
    uuid(input.eventId);
    check(/^[0-9a-f]{64}$/i.test(input.hash) && /^[0-9a-f]{64}$/i.test(input.contentHash)
      && typeof input.locator === 'string' && input.locator.length > 0 && Number.isSafeInteger(input.byteLength) && input.byteLength > 0, 'invalid-source-ref');
    if (content !== undefined) check(typeof content === 'string' && content.length > 0 && Buffer.byteLength(content) <= 65536, 'invalid-memory-content');
  }
  #validateScope(scope: MemoryScope): MemoryScope {
    check(scope && ['project', 'workspace', 'personal', 'session'].includes(scope.kind) && typeof scope.id === 'string', 'invalid-memory-scope');
    uuid(scope.id);
    if (scope.kind === 'project') check(scope.id === this.#binding.projectId && scope.resolved, 'invalid-memory-scope');
    if (scope.kind === 'personal') check(scope.id === this.#binding.ownerId && scope.resolved, 'invalid-memory-scope');
    if (scope.kind === 'session') check(scope.id === this.#binding.sessionId && !scope.resolved, 'invalid-memory-scope');
    if (scope.kind === 'workspace') check(scope.resolved, 'invalid-memory-scope');
    return structuredClone(scope);
  }
  #normalizeAppliesTo(value: string[]): string[] {
    check(Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0 && Buffer.byteLength(item) <= 256), 'invalid-memory-scope');
    const normalized = [...value].sort();
    check(new Set(normalized).size === normalized.length, 'invalid-memory-scope');
    return normalized;
  }
  #withMemoryHash(record: Omit<MemoryRecord, 'hash'> & { hash?: string }): MemoryRecord {
    const { hash: _hash, ...snapshot } = record;
    return { ...snapshot, hash: sha256(JSON.stringify(snapshot)) };
  }
  #snapshotBytes(record: MemoryRecord): string {
    const { hash: _hash, ...snapshot } = record;
    return JSON.stringify(snapshot);
  }
  #parseMemorySnapshot(value: string): MemoryRecord {
    const record = JSON.parse(value) as Omit<MemoryRecord, 'hash'>;
    check(record.schema === 'memory-record@1' && typeof record.recordId === 'string' && typeof record.headEventId === 'string', 'memory-evidence-gap');
    return this.#withMemoryHash(record);
  }
  #readMemoryUnsafe(recordId: string): MemoryRecord {
    const row = this.#db.prepare('SELECT * FROM memory_heads WHERE record_id=?').get(recordId);
    check(row, 'memory-not-found');
    check(sha256(String(row.snapshot)) === String(row.snapshot_hash), 'memory-evidence-gap');
    const record = this.#parseMemorySnapshot(String(row.snapshot));
    const revision = this.#db.prepare('SELECT * FROM memory_revisions WHERE revision_id=?').get(String(row.revision_id));
    check(revision && revision.record_id === recordId && revision.content === record.content && revision.content_hash === record.contentHash
      && revision.type === record.type && revision.scope_kind === record.scope.kind && revision.scope_id === record.scope.id
      && Number(revision.scope_resolved) === (record.scope.resolved ? 1 : 0) && revision.applies_to === JSON.stringify(record.appliesTo)
      && revision.source_json === JSON.stringify(record.source) && revision.source_event_id === record.source.eventId
      && revision.source_hash === record.source.hash && revision.source_content_hash === record.source.contentHash
      && revision.source_locator === record.source.locator && sha256(record.content) === record.contentHash, 'memory-evidence-gap');
    const events = this.#db.prepare('SELECT * FROM memory_events WHERE record_id=? ORDER BY seq').all(recordId);
    let previous: string | null = null;
    for (const [index, event] of events.entries()) {
      check(Number(event.seq) === index + 1 && event.record_id === recordId && sha256(String(event.payload)) === event.payload_hash
        && (event.before_snapshot === previous), 'memory-evidence-gap');
      const after = this.#parseMemorySnapshot(String(event.after_snapshot));
      const payload = JSON.parse(String(event.payload)) as { after?: unknown };
      check(after.recordId === recordId && after.revisionId === event.revision_id && JSON.stringify(payload.after) === String(event.after_snapshot), 'memory-evidence-gap');
      previous = String(event.after_snapshot);
    }
    check(events.length > 0 && String(events.at(-1)!.event_id) === String(row.head_event_id)
      && previous === String(row.snapshot), 'memory-evidence-gap');
    check(record.recordId === recordId && record.revisionId === row.revision_id && record.lifecycle === row.lifecycle
      && record.verification === row.verification && record.scope.kind === row.scope_kind && record.scope.id === row.scope_id
      && record.scope.resolved === Boolean(row.scope_resolved) && record.conflictSetId === (row.conflict_set_id === null ? null : String(row.conflict_set_id))
      && record.headEventId === row.head_event_id, 'memory-evidence-gap');
    return record;
  }
  #assertMemoryExpected(recordId: string, expected: MemoryRecord): MemoryRecord {
    uuid(recordId);
    const current = this.#readMemoryUnsafe(recordId);
    check(expected?.recordId === recordId && expected.hash === sha256(this.#snapshotBytes(expected))
      && this.#snapshotBytes(expected) === this.#snapshotBytes(current) && expected.headEventId === current.headEventId, 'memory-stale');
    return current;
  }
  #insertRevision(record: MemoryRecord): void {
    this.#db.prepare('INSERT INTO memory_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(record.revisionId, record.recordId, record.revision, record.content, record.contentHash, record.type,
        record.scope.kind, record.scope.id, record.scope.resolved ? 1 : 0, JSON.stringify(record.appliesTo), JSON.stringify(record.source),
        record.source.eventId, record.source.hash, record.source.contentHash, record.source.locator);
    const provenance = { schema: 'provenance-ref@1', recordId: record.recordId, revisionId: record.revisionId,
      ownerKind: 'source', ownerId: record.source.binding.sessionId, source: record.source };
    const payload = JSON.stringify(provenance);
    this.#db.prepare('INSERT INTO provenance_refs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), record.recordId, record.revisionId, 'session', record.source.binding.sessionId, JSON.stringify(record.source),
        record.source.eventId, record.source.locator, record.source.contentHash, payload, sha256(payload));
  }
  #appendMemoryEvent(before: MemoryRecord | null, after: MemoryRecord, kind: string, sourceEventId: string, metadata: Record<string, unknown>): void {
    const seq = Number(this.#db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM memory_events WHERE record_id=?').get(after.recordId)!.seq) + 1;
    const beforeSnapshot = before ? this.#snapshotBytes(before) : null;
    const afterSnapshot = this.#snapshotBytes(after);
    const payload = JSON.stringify({ schema: 'memory-event@1', eventId: after.headEventId, recordId: after.recordId, seq, kind,
      before: before ? JSON.parse(beforeSnapshot!) : null, after: JSON.parse(afterSnapshot), ...metadata });
    this.#db.prepare('INSERT INTO memory_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(after.headEventId, after.recordId, seq, kind, after.revisionId, beforeSnapshot, afterSnapshot, payload, sha256(payload), sourceEventId, new Date().toISOString());
    this.#db.prepare(`INSERT INTO memory_heads(record_id,revision_id,lifecycle,verification,scope_kind,scope_id,scope_resolved,head_event_id,snapshot,snapshot_hash,conflict_set_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(record_id) DO UPDATE SET revision_id=excluded.revision_id,lifecycle=excluded.lifecycle,verification=excluded.verification,
      scope_kind=excluded.scope_kind,scope_id=excluded.scope_id,scope_resolved=excluded.scope_resolved,head_event_id=excluded.head_event_id,
      snapshot=excluded.snapshot,snapshot_hash=excluded.snapshot_hash,conflict_set_id=excluded.conflict_set_id`)
      .run(after.recordId, after.revisionId, after.lifecycle, after.verification, after.scope.kind, after.scope.id, after.scope.resolved ? 1 : 0,
        after.headEventId, afterSnapshot, sha256(afterSnapshot), after.conflictSetId);
  }

  beginMaintenance(coordinator: string): Fence {
    return this.#transaction(() => {
      const fence = this.fence();
      if (fence.state !== 'open' && fence.coordinator !== coordinator) {
        check(fence.coordinator_pid !== null && processAbsent(fence.coordinator_pid), 'maintenance-owned');
      }
      if (fence.coordinator !== coordinator) {
        this.#db.prepare(`UPDATE owner_fences SET state='closing',epoch=epoch+1,coordinator=?,coordinator_pid=? WHERE store_id=?`)
          .run(coordinator, process.pid, this.#storeId);
      }
      return this.fence();
    });
  }

  acquireMaintenance(coordinator: string): { acquired: boolean; observations: { id: string; pid: number; incarnation: string; absent: boolean; observedAt: string; method: string }[] } {
    return this.#transaction(() => {
      const fence = this.fence();
      check(fence.coordinator === coordinator && fence.coordinator_pid === process.pid && fence.state !== 'open', 'maintenance-owned');
      const rows = this.#db.prepare('SELECT * FROM owner_activities WHERE store_id=?').all(this.#storeId);
      const observations = rows.map(row => ({
        id: String(row.id), pid: Number(row.pid), incarnation: String(row.incarnation),
        absent: processAbsent(Number(row.pid)), observedAt: new Date().toISOString(), method: 'node-process-kill-0/ESRCH',
      }));
      const acquired = observations.every(item => item.absent);
      if (acquired) this.#db.prepare("UPDATE owner_fences SET state='exclusive' WHERE store_id=?").run(this.#storeId);
      return { acquired, observations };
    });
  }

  releaseMaintenance(coordinator: string): Fence {
    return this.#transaction(() => {
      const fence = this.fence();
      check(fence.coordinator === coordinator && fence.coordinator_pid === process.pid && fence.state === 'exclusive', 'maintenance-not-exclusive');
      this.#db.prepare('DELETE FROM owner_activities WHERE store_id=?').run(this.#storeId);
      this.#db.prepare("UPDATE owner_fences SET state='open',epoch=epoch+1,coordinator=NULL,coordinator_pid=NULL WHERE store_id=?").run(this.#storeId);
      return this.fence();
    });
  }

  diagnostics(): { sqlite: string; journalMode: unknown; synchronous: unknown; foreignKeys: unknown; busyTimeout: unknown } {
    return {
      sqlite: String(this.#db.prepare('SELECT sqlite_version() AS version').get()!.version),
      journalMode: this.#db.prepare('PRAGMA journal_mode').get()!.journal_mode,
      synchronous: this.#db.prepare('PRAGMA synchronous').get()!.synchronous,
      foreignKeys: this.#db.prepare('PRAGMA foreign_keys').get()!.foreign_keys,
      busyTimeout: this.#db.prepare('PRAGMA busy_timeout').get()!.timeout,
    };
  }
  close(): void { this.#db.close(); }
}

function processAbsent(pid: number): boolean {
  check(Number.isSafeInteger(pid) && pid > 0, 'invalid-process-identity');
  try { process.kill(pid, 0); return false; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    throw new Error('process-exit-evidence-gap', { cause: error });
  }
}
