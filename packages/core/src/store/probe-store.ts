import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
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
  streamId: string;
}
export interface ExecutionOwner {
  kind: 'session' | 'job' | 'migration';
  id: string;
  authorizationId: string;
}
export interface ExecutionStream {
  streamId: string; ownerKind: 'session' | 'job' | 'maintenance' | 'migration'; ownerId: string;
  principalId: string; originHostId: string; projectId: string;
  authorization: { kind: 'synthetic-host-command'; id: string };
}
export interface AttemptOwnership {
  attemptId: string; runId: string; streamId: string; ownerKind: ExecutionStream['ownerKind']; ownerId: string;
}
export type MemoryType = 'fact' | 'preference' | 'decision' | 'insight' | 'episode';
export type MemoryLifecycle = 'candidate' | 'active' | 'superseded' | 'rejected' | 'tombstoned';
export type MemoryVerification = 'unverified' | 'verified' | 'conflicted' | 'stale';
export type MemoryScopeKind = 'project' | 'workspace' | 'personal' | 'session';
export interface MemoryScope { kind: MemoryScopeKind; id: string; resolved: boolean }
export interface MemoryCaptureOptions { type: MemoryType; scope: MemoryScope; appliesTo: string[]; claimKey?: string }
export interface MemoryRecord {
  schema: 'memory-record@1'; recordId: string; revisionId: string; revision: number; claimKey: string;
  content: string; contentHash: string; type: MemoryType; lifecycle: MemoryLifecycle;
  verification: MemoryVerification; scope: MemoryScope; appliesTo: string[]; source: SourceAck;
  conflictSetId: string | null; verificationRunId: string | null; headEventId: string; hash: string;
}
export interface MemoryOperation { status: 'committed' | 'no_op'; record: MemoryRecord; eventId: string | null }
export interface ConflictOperation { status: 'committed' | 'no_op'; left: MemoryOperation; right: MemoryOperation; conflictSetId: string | null }
export interface EvolutionProposalInput {
  target: string; expectedChange: string; owner: string; scope: MemoryScope; evidenceRefs: SourceAck[];
  evaluation: { schema: 'evaluation-contract@1'; level: 'L0' | 'L1' | 'L2' | 'L3'; assertions: string[] };
  supersedes?: string;
  targetType?: 'guidance' | 'skill' | 'code' | 'policy';
  risk?: 'low' | 'high';
}
export interface EvolutionProposal {
  schema: 'evolution-proposal@1'; proposalId: string; version: number; target: string;
  expectedChange: string; owner: string; scope: MemoryScope; evidenceRefs: SourceAck[]; input: SourceAck;
  targetType: 'guidance' | 'skill' | 'code' | 'policy'; risk: 'low' | 'high';
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
  coordinator_incarnation: string | null;
  coordinator_started_at: string | null;
  coordinator_stream: string | null;
  coordinator_activity: string | null;
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
  coordinator_incarnation TEXT, coordinator_started_at TEXT,
  coordinator_stream TEXT REFERENCES execution_streams(stream_id), coordinator_activity TEXT REFERENCES owner_activities(id),
  CHECK((state='open' AND coordinator IS NULL AND coordinator_pid IS NULL AND coordinator_incarnation IS NULL AND coordinator_started_at IS NULL AND coordinator_activity IS NULL)
    OR (state!='open' AND coordinator IS NOT NULL AND coordinator_pid>0 AND coordinator_incarnation IS NOT NULL
      AND coordinator_started_at IS NOT NULL AND coordinator_stream IS NOT NULL AND coordinator_activity IS NOT NULL)),
  UNIQUE(store_id, root_path, root_dev, root_ino)
) STRICT;
CREATE TABLE maintenance_residuals (
  store_id TEXT NOT NULL REFERENCES owner_fences(store_id), path TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('expected','unexpected','unknown')), observed_at TEXT NOT NULL,
  dev TEXT, ino TEXT, reason TEXT NOT NULL, PRIMARY KEY(store_id,path)
) STRICT;
CREATE TABLE execution_streams (
  stream_id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES owner_fences(store_id),
  owner_kind TEXT NOT NULL CHECK(owner_kind IN ('session','job','maintenance','migration')), owner_id TEXT NOT NULL,
  principal_id TEXT NOT NULL, origin_host_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(project_id),
  authorization_kind TEXT NOT NULL CHECK(authorization_kind='synthetic-host-command'), authorization_id TEXT NOT NULL,
  UNIQUE(store_id,owner_kind,owner_id), UNIQUE(store_id,stream_id)
) STRICT;
CREATE TABLE execution_events (
  event_id TEXT PRIMARY KEY, stream_id TEXT NOT NULL REFERENCES execution_streams(stream_id),
  seq INTEGER NOT NULL CHECK(seq>0), kind TEXT NOT NULL CHECK(kind='attempt-bound'),
  attempt_id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL, activity_id TEXT NOT NULL REFERENCES owner_activities(id),
  created_at TEXT NOT NULL, UNIQUE(stream_id,seq)
) STRICT;
CREATE TRIGGER execution_run_owner BEFORE INSERT ON execution_events
WHEN EXISTS(SELECT 1 FROM execution_events WHERE run_id=NEW.run_id AND stream_id!=NEW.stream_id)
BEGIN SELECT RAISE(ABORT,'run-owner-conflict'); END;
CREATE TABLE owner_activities (
  id TEXT PRIMARY KEY, store_id TEXT NOT NULL,
  pid INTEGER CHECK(pid>0), incarnation TEXT, started_at TEXT, epoch INTEGER NOT NULL CHECK(epoch>0),
  parent_id TEXT REFERENCES owner_activities(id), launch_pid INTEGER CHECK(launch_pid>0),
  root_path TEXT NOT NULL, root_dev TEXT NOT NULL, root_ino TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  stop_state TEXT CHECK(stop_state IN ('alive','absent','unknown')), stop_observed_at TEXT, stop_method TEXT,
  CHECK((pid IS NULL AND incarnation IS NULL AND started_at IS NULL AND parent_id IS NOT NULL)
    OR (pid IS NOT NULL AND incarnation IS NOT NULL AND started_at IS NOT NULL)),
  CHECK(launch_pid IS NULL OR (parent_id IS NOT NULL AND (pid IS NULL OR pid=launch_pid))),
  CHECK((stop_state IS NULL AND stop_observed_at IS NULL AND stop_method IS NULL)
    OR (stop_state IS NOT NULL AND stop_observed_at IS NOT NULL AND stop_method IS NOT NULL)),
  FOREIGN KEY(store_id,stream_id) REFERENCES execution_streams(store_id,stream_id),
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
CREATE TABLE projects (project_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL) STRICT;
CREATE TABLE project_resources (
  project_id TEXT NOT NULL REFERENCES projects(project_id), path TEXT NOT NULL, dev TEXT NOT NULL, ino TEXT NOT NULL,
  PRIMARY KEY(project_id,path)
) STRICT;
CREATE TABLE memory_scopes (
  kind TEXT NOT NULL CHECK(kind IN ('project','personal','session')), scope_id TEXT NOT NULL,
  resolved INTEGER NOT NULL CHECK(resolved IN (0,1)), owner_id TEXT NOT NULL,
  project_id TEXT REFERENCES projects(project_id), session_id TEXT,
  CHECK((kind='project' AND scope_id=project_id AND project_id IS NOT NULL AND session_id IS NULL AND resolved=1)
    OR (kind='personal' AND scope_id=owner_id AND project_id IS NULL AND session_id IS NULL AND resolved=1)
    OR (kind='session' AND scope_id=session_id AND session_id IS NOT NULL AND project_id IS NULL AND resolved=0)),
  PRIMARY KEY(kind,scope_id), UNIQUE(kind,scope_id,resolved)
) STRICT;
CREATE TABLE memory_records (
  record_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, claim_key TEXT NOT NULL, source_lineage TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE memory_revisions (
  revision_id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES memory_records(record_id), revision INTEGER NOT NULL CHECK(revision > 0),
  content TEXT NOT NULL, content_hash TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('fact','preference','decision','insight','episode')),
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('project','workspace','personal','session')), scope_id TEXT NOT NULL,
  scope_resolved INTEGER NOT NULL CHECK(scope_resolved IN (0,1)), source_json TEXT NOT NULL,
  source_event_id TEXT NOT NULL, source_hash TEXT NOT NULL, source_content_hash TEXT NOT NULL, source_locator TEXT NOT NULL,
  UNIQUE(record_id, revision), UNIQUE(record_id,revision_id),
  FOREIGN KEY(scope_kind,scope_id,scope_resolved) REFERENCES memory_scopes(kind,scope_id,resolved)
) STRICT;
CREATE TABLE memory_applicability (
  revision_id TEXT NOT NULL REFERENCES memory_revisions(revision_id), ordinal INTEGER NOT NULL CHECK(ordinal>=0), value TEXT NOT NULL,
  PRIMARY KEY(revision_id,ordinal), UNIQUE(revision_id,value)
) STRICT;
CREATE TABLE capture_jobs (
  job_id TEXT PRIMARY KEY, source_event_id TEXT NOT NULL UNIQUE, record_id TEXT NOT NULL REFERENCES memory_records(record_id),
  status TEXT NOT NULL CHECK(status IN ('captured','complete')), payload TEXT NOT NULL, payload_hash TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE provenance_refs (
  ref_id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES memory_records(record_id), revision_id TEXT NOT NULL REFERENCES memory_revisions(revision_id),
  owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, source_json TEXT NOT NULL, source_event_id TEXT NOT NULL, locator TEXT NOT NULL,
  content_hash TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT NOT NULL,
  FOREIGN KEY(record_id,revision_id) REFERENCES memory_revisions(record_id,revision_id)
) STRICT;
CREATE TABLE memory_heads (
  record_id TEXT PRIMARY KEY REFERENCES memory_records(record_id), revision_id TEXT NOT NULL REFERENCES memory_revisions(revision_id),
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('candidate','active','superseded','rejected','tombstoned')),
  verification TEXT NOT NULL CHECK(verification IN ('unverified','verified','conflicted','stale')),
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('project','workspace','personal','session')), scope_id TEXT NOT NULL,
  scope_resolved INTEGER NOT NULL CHECK(scope_resolved IN (0,1)), head_event_id TEXT NOT NULL,
  snapshot TEXT NOT NULL, snapshot_hash TEXT NOT NULL, conflict_set_id TEXT REFERENCES conflict_sets(conflict_set_id),
  verification_run_id TEXT,
  CHECK(verification!='verified' OR verification_run_id IS NOT NULL),
  FOREIGN KEY(record_id,revision_id,verification_run_id) REFERENCES verification_runs(record_id,revision_id,run_id),
  FOREIGN KEY(conflict_set_id,record_id) REFERENCES conflict_members(conflict_set_id,record_id),
  FOREIGN KEY(record_id,revision_id) REFERENCES memory_revisions(record_id,revision_id),
  FOREIGN KEY(record_id,head_event_id,revision_id) REFERENCES memory_events(record_id,event_id,revision_id),
  FOREIGN KEY(scope_kind,scope_id,scope_resolved) REFERENCES memory_scopes(kind,scope_id,resolved)
) STRICT;
CREATE TABLE memory_events (
  event_id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES memory_records(record_id), seq INTEGER NOT NULL CHECK(seq > 0), kind TEXT NOT NULL CHECK(kind IN ('capture','verify','activate','correct','auto-revise','forget','restore','conflict','rollback')),
  revision_id TEXT NOT NULL REFERENCES memory_revisions(revision_id), before_snapshot TEXT, after_snapshot TEXT NOT NULL,
  request_hash TEXT NOT NULL UNIQUE, origin_host_id TEXT NOT NULL, origin_seq INTEGER NOT NULL CHECK(origin_seq>0), batch_id TEXT,
  target_event_id TEXT,
  payload TEXT NOT NULL, payload_hash TEXT NOT NULL, source_event_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(record_id, seq),
  UNIQUE(origin_host_id,origin_seq),
  UNIQUE(record_id,event_id,revision_id), UNIQUE(record_id,event_id),
  FOREIGN KEY(record_id,target_event_id) REFERENCES memory_events(record_id,event_id),
  FOREIGN KEY(record_id,revision_id) REFERENCES memory_revisions(record_id,revision_id)
) STRICT;
CREATE TABLE projection_jobs (
  job_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('search','host-info')), event_id TEXT NOT NULL REFERENCES memory_events(event_id),
  owner_id TEXT NOT NULL, scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL, batch_id TEXT,
  payload TEXT NOT NULL, payload_hash TEXT NOT NULL, UNIQUE(kind,event_id)
) STRICT;
CREATE TABLE feedback_events (
  feedback_id TEXT PRIMARY KEY, record_id TEXT NOT NULL, head_event_id TEXT NOT NULL, revision_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind='retrieved'),
  FOREIGN KEY(record_id,head_event_id,revision_id) REFERENCES memory_events(record_id,event_id,revision_id)
) STRICT;
CREATE TABLE verification_runs (
  run_id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES memory_records(record_id), revision_id TEXT NOT NULL REFERENCES memory_revisions(revision_id),
  result TEXT NOT NULL CHECK(result IN ('pass','block','evidence-gap')), evidence_json TEXT NOT NULL, evidence_hash TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(record_id,revision_id,run_id),
  FOREIGN KEY(record_id,revision_id) REFERENCES memory_revisions(record_id,revision_id)
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
  scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL, scope_resolved INTEGER NOT NULL,
  request_hash TEXT NOT NULL UNIQUE, target_type TEXT NOT NULL, risk TEXT NOT NULL,
  UNIQUE(owner,scope_kind,scope_id,target,version),
  FOREIGN KEY(scope_kind,scope_id,scope_resolved) REFERENCES memory_scopes(kind,scope_id,resolved)
) STRICT;
CREATE TABLE verification_evidence (
  run_id TEXT NOT NULL REFERENCES verification_runs(run_id), ordinal INTEGER NOT NULL,
  source_owner TEXT NOT NULL, source_event_id TEXT NOT NULL, locator TEXT NOT NULL, hash TEXT NOT NULL, content_hash TEXT NOT NULL,
  PRIMARY KEY(run_id,ordinal)
) STRICT;
CREATE TABLE proposal_evidence (
  proposal_id TEXT NOT NULL REFERENCES evolution_proposals(proposal_id), ordinal INTEGER NOT NULL,
  source_owner TEXT NOT NULL, source_event_id TEXT NOT NULL, locator TEXT NOT NULL, hash TEXT NOT NULL, content_hash TEXT NOT NULL,
  PRIMARY KEY(proposal_id,ordinal)
) STRICT;
CREATE INDEX verification_source ON verification_evidence(source_owner,source_event_id);
CREATE INDEX proposal_source ON proposal_evidence(source_owner,source_event_id);
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
PRAGMA user_version=5;
` + ['execution_streams','execution_events','memory_applicability','projects','project_resources','memory_scopes','conflict_sets','conflict_members','verification_evidence','proposal_evidence','projection_jobs','feedback_events'].map(table => `
CREATE TRIGGER immutable_${table}_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER immutable_${table}_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'append-only'); END;
`).join('') + ['owner_activities','maintenance_residuals','execution_streams','execution_events','memory_records','memory_revisions','memory_events','memory_applicability','capture_jobs','provenance_refs',
  'verification_runs','verification_evidence','proposal_evidence','projection_jobs','feedback_events','conflict_sets','conflict_members','evolution_proposals'].map(table => `
CREATE TRIGGER owned_${table}_insert BEFORE INSERT ON ${table}
WHEN euler_store_writer()!=1 BEGIN SELECT RAISE(ABORT,'store-owned-identity'); END;
`).join('') + ['owner_activities','maintenance_residuals'].flatMap(table => ['UPDATE','DELETE'].map(operation => `
CREATE TRIGGER owned_${table}_${operation.toLowerCase()} BEFORE ${operation} ON ${table}
WHEN euler_store_writer()!=1 BEGIN SELECT RAISE(ABORT,'store-owned-identity'); END;
`)).join('');
export const probeSchemaDigest = sha256(DDL);

// P0 disposable schema; not migrations/001-initial.sql and not the execution ledger.
export class ProbeStore {
  readonly #db: DatabaseSync;
  readonly #storeId: string;
  readonly #binding: Binding;
  readonly #resources: StoreResources;
  readonly #readSource: ((input: SourceAck) => { text: string }) | undefined;
  #depth = 0;

  constructor(resources: StoreResources, storeId: string, binding: Binding, initialize = false,
    readSource?: (input: SourceAck) => { text: string }) {
    this.#readSource = readSource;
    this.#storeId = storeId;
    this.#binding = structuredClone(binding);
    this.#resources = structuredClone(resources);
    this.#verifyResources();
    this.#db = new DatabaseSync(resources.store.path);
    try {
      this.#db.function('euler_store_writer', () => this.#depth > 0 ? 1 : 0);
      this.#db.exec('PRAGMA busy_timeout=2000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
      const version = this.#db.prepare('PRAGMA user_version').get()!.user_version;
      if (initialize) {
        check(version === 0, 'already-initialized');
        this.#db.exec('PRAGMA journal_mode=WAL;');
        this.#transaction(() => {
          this.#db.exec(DDL);
          this.#db.prepare('INSERT INTO owner_fences VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, NULL, NULL, NULL, NULL)')
            .run(storeId, binding.ownerId, binding.hostId, binding.projectId, binding.sessionId, binding.branchId,
              resources.root.path, resources.root.identity.dev, resources.root.identity.ino,
              resources.source.path, resources.source.identity.dev, resources.source.identity.ino,
              resources.store.path, resources.store.identity.dev, resources.store.identity.ino, 'open');
          this.#db.prepare('INSERT INTO projects VALUES (?,?)').run(binding.projectId, binding.ownerId);
          this.#db.prepare('INSERT INTO project_resources VALUES (?,?,?,?)')
            .run(binding.projectId, resources.root.path, resources.root.identity.dev, resources.root.identity.ino);
          this.#db.prepare('INSERT INTO memory_scopes VALUES (?,?,?,?,?,?), (?,?,?,?,?,?), (?,?,?,?,?,?)')
            .run('project', binding.projectId, 1, binding.ownerId, binding.projectId, null,
              'personal', binding.ownerId, 1, binding.ownerId, null, null,
              'session', binding.sessionId, 0, binding.ownerId, null, binding.sessionId);
        });
      } else {
        check(version === 5, 'unsupported-probe-schema');
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
    const nested = this.#depth > 0;
    const savepoint = `store_${this.#depth}`;
    this.#db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    this.#depth++;
    try {
      const value = action();
      check(!(value instanceof Promise), 'async-store-transaction');
      this.#verifyResources();
      this.#db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
      return value;
    } catch (error) {
      this.#db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
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

  register(owner: ExecutionOwner = { kind: 'session', id: this.#binding.sessionId, authorizationId: this.#binding.sessionId }): Activity {
    return this.#transaction(() => {
      const fence = this.fence();
      check(fence.state === 'open', 'admission-closed');
      check(!this.#db.prepare('SELECT 1 FROM owner_activities WHERE store_id=? AND incarnation=? AND epoch!=?')
        .get(this.#storeId, processIdentity.incarnation, fence.epoch), 'stale-runtime-incarnation');
      check(owner && Object.keys(owner).every(key => ['kind','id','authorizationId'].includes(key))
        && ['session','job','migration'].includes(owner.kind), 'invalid-stream-owner');
      check(owner.kind !== 'session' || (owner.id === this.#binding.sessionId && owner.authorizationId === owner.id), 'invalid-stream-owner');
      const stream = this.#ensureStream(owner.kind, owner.id, owner.authorizationId);
      const activity = { ...processIdentity, id: randomUUID(), epoch: fence.epoch, root: structuredClone(this.#resources.root), streamId: stream.streamId };
      this.#db.prepare(`INSERT INTO owner_activities
        (id,store_id,pid,incarnation,started_at,epoch,root_path,root_dev,root_ino,stream_id) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(activity.id, this.#storeId, activity.pid, activity.incarnation, activity.startedAt, activity.epoch,
          activity.root.path, activity.root.identity.dev, activity.root.identity.ino, activity.streamId);
      return activity;
    });
  }

  reserveChild(activity: Activity): string {
    return this.withActivity(activity, () => {
      const id = randomUUID();
      const stream = this.#ensureStream('job', randomUUID(), activity.id);
      this.#db.prepare(`INSERT INTO owner_activities
        (id,store_id,epoch,parent_id,root_path,root_dev,root_ino,stream_id) VALUES (?,?,?,?,?,?,?,?)`)
        .run(id, this.#storeId, activity.epoch, activity.id, this.#resources.root.path,
          this.#resources.root.identity.dev, this.#resources.root.identity.ino, stream.streamId);
      return id;
    });
  }

  recordChildLaunch(parent: Activity, reservationId: string, pid: number): void {
    uuid(reservationId);
    check(Number.isSafeInteger(pid) && pid > 0, 'invalid-child-pid');
    this.#transaction(() => {
      // Reporting a previously reserved launch is control evidence, not new
      // admission; it must remain possible after closing or cancellation.
      const registered = this.#db.prepare(`SELECT * FROM owner_activities WHERE id=? AND store_id=? AND pid=?
        AND incarnation=? AND started_at=? AND epoch=? AND stream_id=?`)
        .get(parent.id, this.#storeId, processIdentity.pid, processIdentity.incarnation, processIdentity.startedAt, parent.epoch, parent.streamId);
      check(registered && registered.stop_state !== 'absent' && parent.pid === processIdentity.pid
        && parent.incarnation === processIdentity.incarnation && parent.startedAt === processIdentity.startedAt, 'invalid-parent-activity');
      const row = this.#db.prepare('SELECT * FROM owner_activities WHERE id=? AND store_id=?').get(reservationId, this.#storeId);
      check(row && row.parent_id === parent.id && (row.launch_pid === null || row.launch_pid === pid)
        && (row.pid === null || row.pid === pid), 'invalid-child-reservation');
      this.#db.prepare('UPDATE owner_activities SET launch_pid=? WHERE id=?').run(pid, reservationId);
    });
  }

  claimChild(reservationId: string): Activity {
    uuid(reservationId);
    return this.#transaction(() => {
      const fence = this.fence();
      check(fence.state === 'open', 'admission-closed');
      check(!this.#db.prepare('SELECT 1 FROM owner_activities WHERE store_id=? AND incarnation=? AND epoch!=?')
        .get(this.#storeId, processIdentity.incarnation, fence.epoch), 'stale-runtime-incarnation');
      const row = this.#db.prepare('SELECT * FROM owner_activities WHERE id=? AND store_id=?').get(reservationId, this.#storeId);
      check(row && row.parent_id !== null && row.pid === null && row.epoch === fence.epoch && row.stop_state !== 'absent'
        && (row.launch_pid === null || row.launch_pid === processIdentity.pid), 'invalid-child-reservation');
      const stream = this.#readStream(String(row.stream_id));
      check(stream.ownerKind === 'job' && stream.authorization.id === row.parent_id, 'stream-owner-evidence-gap');
      this.#db.prepare('UPDATE owner_activities SET pid=?,incarnation=?,started_at=?,launch_pid=? WHERE id=?')
        .run(processIdentity.pid, processIdentity.incarnation, processIdentity.startedAt, processIdentity.pid, reservationId);
      return { ...processIdentity, id: reservationId, epoch: fence.epoch, root: structuredClone(this.#resources.root), streamId: stream.streamId };
    });
  }

  #ensureStream(kind: ExecutionStream['ownerKind'], ownerId: string, authorizationId: string): ExecutionStream {
    uuid(ownerId); uuid(authorizationId);
    const existing = this.#db.prepare('SELECT stream_id FROM execution_streams WHERE store_id=? AND owner_kind=? AND owner_id=?')
      .get(this.#storeId, kind, ownerId);
    if (existing) {
      const stream = this.#readStream(String(existing.stream_id));
      check(stream.authorization.id === authorizationId, 'stream-authorization-conflict');
      return stream;
    }
    const id = randomUUID();
    this.#db.prepare('INSERT INTO execution_streams VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, this.#storeId, kind, ownerId, this.#binding.ownerId, this.#binding.hostId,
        this.#binding.projectId, 'synthetic-host-command', authorizationId);
    return this.#readStream(id);
  }

  #readStream(streamId: string): ExecutionStream {
    uuid(streamId);
    const row = this.#db.prepare('SELECT * FROM execution_streams WHERE stream_id=? AND store_id=?').get(streamId, this.#storeId);
    check(row && row.principal_id === this.#binding.ownerId && row.origin_host_id === this.#binding.hostId
      && row.project_id === this.#binding.projectId, 'stream-owner-evidence-gap');
    return { streamId, ownerKind: row.owner_kind as ExecutionStream['ownerKind'], ownerId: String(row.owner_id),
      principalId: String(row.principal_id), originHostId: String(row.origin_host_id), projectId: String(row.project_id),
      authorization: { kind: 'synthetic-host-command', id: String(row.authorization_id) } };
  }

  readStream(activity: Activity, streamId: string): ExecutionStream {
    return this.withActivity(activity, () => this.#readStream(streamId));
  }

  bindAttempt(activity: Activity, runId: string): AttemptOwnership {
    return this.withActivity(activity, () => {
      uuid(runId);
      const stream = this.#readStream(activity.streamId);
      check(stream.ownerKind !== 'maintenance', 'maintenance-business-unavailable');
      const attemptId = randomUUID();
      const seq = Number(this.#db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM execution_events WHERE stream_id=?').get(stream.streamId)!.seq);
      this.#db.prepare('INSERT INTO execution_events VALUES (?,?,?,?,?,?,?,?)')
        .run(randomUUID(), stream.streamId, seq, 'attempt-bound', attemptId, runId, activity.id, new Date().toISOString());
      return { attemptId, runId, streamId: stream.streamId, ownerKind: stream.ownerKind, ownerId: stream.ownerId };
    });
  }

  readAttempt(activity: Activity, attemptId: string): AttemptOwnership | null {
    return this.withActivity(activity, () => {
      uuid(attemptId);
      const row = this.#db.prepare(`SELECT e.* FROM execution_events e JOIN execution_streams s ON s.stream_id=e.stream_id
        WHERE e.attempt_id=? AND s.store_id=?`).get(attemptId, this.#storeId);
      if (!row) return null;
      const stream = this.#readStream(String(row.stream_id));
      return { attemptId, runId: String(row.run_id), streamId: stream.streamId, ownerKind: stream.ownerKind, ownerId: stream.ownerId };
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
        && row.epoch === activity.epoch && row.stream_id === activity.streamId
        && activity.pid === processIdentity.pid && activity.incarnation === processIdentity.incarnation
        && activity.startedAt === processIdentity.startedAt, 'admission-closed');
      check(this.#readStream(activity.streamId).ownerKind !== 'maintenance', 'maintenance-business-unavailable');
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
      check(Object.keys(options).every(key => ['type','scope','appliesTo','claimKey'].includes(key)), 'invalid-memory-options');
      this.#validateSource(input, content);
      const scope = this.#validateScope(options.scope);
      const appliesTo = this.#normalizeAppliesTo(options.appliesTo);
      const claimKey = options.claimKey ?? content.trim().normalize('NFC');
      check(typeof claimKey === 'string' && claimKey.length > 0 && Buffer.byteLength(claimKey) <= 65536, 'invalid-claim-key');
      check(['fact', 'preference', 'decision', 'insight', 'episode'].includes(options.type), 'invalid-memory-type');
      const existing = this.#db.prepare('SELECT * FROM memory_revisions WHERE source_event_id=?').get(input.eventId);
      if (existing) {
        const same = existing.content === content && existing.type === options.type && existing.scope_kind === scope.kind
          && existing.scope_id === scope.id && Number(existing.scope_resolved) === (scope.resolved ? 1 : 0)
          && JSON.stringify(this.#readAppliesTo(String(existing.revision_id))) === JSON.stringify(appliesTo)
          && existing.source_json === JSON.stringify(input);
        check(same, 'identity-conflict');
        const record = this.#readMemoryUnsafe(String(existing.record_id));
        check(record.claimKey === claimKey, 'identity-conflict');
        return { status: 'no_op', record, eventId: null };
      }
      const suppressed = this.#suppressed(claimKey, input.binding.sessionId, scope, appliesTo);
      if (suppressed) return { status: 'no_op', record: suppressed, eventId: null };
      const recordId = randomUUID();
      const revisionId = randomUUID();
      const eventId = randomUUID();
      const base = { schema: 'memory-record@1' as const, recordId, revisionId, revision: 1, claimKey,
        content, contentHash: sha256(content), type: options.type, lifecycle: 'candidate' as const,
        verification: 'unverified' as const, scope, appliesTo, source: structuredClone(input), conflictSetId: null, verificationRunId: null, headEventId: eventId };
      const record = this.#withMemoryHash(base);
      this.#db.prepare('INSERT INTO memory_records VALUES (?, ?, ?, ?, ?)')
        .run(recordId, this.#binding.ownerId, claimKey, input.binding.sessionId, new Date().toISOString());
      this.#insertRevision(record);
      const capturePayload = JSON.stringify({ schema: 'capture-job@1', source: input, recordId });
      this.#db.prepare('INSERT INTO capture_jobs VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), input.eventId, recordId, 'complete', capturePayload, sha256(capturePayload), new Date().toISOString());
      this.#appendMemoryEvent(null, record, 'capture', input.eventId, { automatic: true });
      return { status: 'committed', record, eventId };
    });
  }

  inspectMemory(activity: Activity, recordId: string) {
    return this.withActivity(activity, () => ({
      record: this.#readMemoryUnsafe(recordId),
      history: this.#db.prepare('SELECT event_id,seq,kind,payload,payload_hash FROM memory_events WHERE record_id=? ORDER BY seq').all(recordId)
        .map(row => ({ eventId: String(row.event_id), seq: Number(row.seq), kind: String(row.kind), payload: String(row.payload), digest: String(row.payload_hash) })),
    }));
  }

  pendingMemoryProjections(activity: Activity) {
    return this.withActivity(activity, () => this.#db.prepare('SELECT * FROM projection_jobs WHERE owner_id=? ORDER BY rowid').all(this.#binding.ownerId)
      .map(row => {
        check(sha256(String(row.payload)) === row.payload_hash, 'outbox-evidence-gap');
        const manifest = JSON.parse(String(row.payload));
        const event = this.#db.prepare('SELECT payload FROM memory_events WHERE event_id=?').get(String(row.event_id));
        check(event && manifest.schema === 'memory-outbox@1' && manifest.kind === row.kind && manifest.batchId === row.batch_id
          && manifest.events.length === 1 && JSON.stringify(manifest.events[0]) === event.payload, 'outbox-evidence-gap');
        return { jobId: String(row.job_id), kind: String(row.kind), eventId: String(row.event_id), batchId: row.batch_id,
          payload: String(row.payload), digest: String(row.payload_hash) };
      }));
  }

  readMemory(activity: Activity, recordId: string): MemoryRecord {
    return this.withActivity(activity, () => {
      uuid(recordId);
      return this.#readMemoryUnsafe(recordId);
    });
  }

  recoverMemory(activity: Activity, recordId: string): MemoryRecord {
    return this.withActivity(activity, () => {
      uuid(recordId);
      const record = this.#replayMemory(recordId);
      if (!this.#db.prepare('SELECT 1 FROM memory_heads WHERE record_id=?').get(recordId)) this.#saveHead(record);
      return this.#readMemoryUnsafe(recordId);
    });
  }

  recoverMemories(activity: Activity): MemoryRecord[] {
    return this.withActivity(activity, () => this.#db.prepare('SELECT record_id FROM memory_records WHERE owner_id=? ORDER BY rowid')
      .all(this.#binding.ownerId).map(row => this.recoverMemory(activity, String(row.record_id))));
  }

  listEligibleMemories(activity: Activity): MemoryRecord[] {
    return this.withActivity(activity, () => {
      const records = this.#db.prepare(`SELECT record_id FROM memory_heads
        WHERE lifecycle='active' AND verification='verified' AND scope_resolved=1
        AND ((scope_kind='project' AND scope_id=?) OR (scope_kind='personal' AND scope_id=?)) ORDER BY rowid`)
        .all(this.#binding.projectId, this.#binding.ownerId).map(row => this.#readMemoryUnsafe(String(row.record_id)))
        .filter(record => !record.conflictSetId && record.appliesTo.every(condition => ['cli', process.platform].includes(condition)));
      for (const record of records) {
        this.#db.prepare('INSERT INTO feedback_events VALUES (?,?,?,?,?)')
          .run(randomUUID(), record.recordId, record.headEventId, record.revisionId, 'retrieved');
      }
      return records;
    });
  }

  verifyMemory(activity: Activity, recordId: string, expected: MemoryRecord, result: 'pass' | 'block' | 'evidence-gap', evidence: SourceAck[]): MemoryOperation {
    return this.withActivity(activity, () => {
      const request = this.#requestDigest('verify', expected, { recordId, result, evidence });
      const replay = this.#replayed(request);
      if (replay) return replay;
      const current = this.#assertMemoryExpected(recordId, expected);
      check(['pass', 'block', 'evidence-gap'].includes(result), 'invalid-verification');
      check(Array.isArray(evidence), 'invalid-verification');
      for (const ref of evidence) this.#validateSource(ref);
      check(result !== 'pass' || evidence.length > 0, 'verification-evidence-required');
      const evidenceJson = JSON.stringify(evidence);
      const evidenceHash = sha256(evidenceJson);
      const prior = this.#db.prepare('SELECT 1 FROM verification_runs WHERE run_id=? AND record_id=? AND revision_id=? AND result=? AND evidence_hash=?')
        .get(current.verificationRunId, recordId, current.revisionId, result, evidenceHash);
      if (prior && current.verification === (result === 'pass' ? 'verified' : 'unverified')) return { status: 'no_op', record: current, eventId: null };
      const runId = this.#saveVerification(current, result, evidence);
      const after = this.#withMemoryHash({ ...current, verificationRunId: runId,
        lifecycle: result === 'block' && current.lifecycle !== 'tombstoned' ? 'rejected' : current.lifecycle,
        verification: result === 'pass' ? 'verified' : 'unverified', headEventId: randomUUID() });
      this.#appendMemoryEvent(current, after, 'verify', current.source.eventId, { runId, result, evidence: JSON.parse(evidenceJson), synthetic: true }, request);
      return { status: 'committed', record: after, eventId: after.headEventId };
    });
  }

  activateMemory(activity: Activity, recordId: string, expected: MemoryRecord): MemoryOperation {
    return this.withActivity(activity, () => {
      const request = this.#requestDigest('activate', expected, { recordId });
      const replay = this.#replayed(request);
      if (replay) return replay;
      const current = this.#assertMemoryExpected(recordId, expected);
      if (current.lifecycle === 'active' && current.verification === 'verified') return { status: 'no_op', record: current, eventId: null };
      check(current.lifecycle === 'candidate' && current.verification === 'verified' && current.scope.resolved && !current.conflictSetId, 'memory-not-eligible');
      check(!this.#suppressed(current.claimKey, current.source.binding.sessionId, current.scope, current.appliesTo), 'memory-suppressed');
      const after = this.#withMemoryHash({ ...current, lifecycle: 'active', headEventId: randomUUID() });
      this.#eligible(after);
      this.#appendMemoryEvent(current, after, 'activate', current.source.eventId, { automatic: true }, request);
      return { status: 'committed', record: after, eventId: after.headEventId };
    });
  }

  forgetMemory(activity: Activity, recordId: string, expected: MemoryRecord): MemoryOperation {
    return this.withActivity(activity, () => {
      const request = this.#requestDigest('forget', expected, { recordId });
      const replay = this.#replayed(request);
      if (replay) return replay;
      const current = this.#assertMemoryExpected(recordId, expected);
      check(current.lifecycle === 'active', 'memory-not-active');
      const after = this.#withMemoryHash({ ...current, lifecycle: 'tombstoned', headEventId: randomUUID() });
      this.#appendMemoryEvent(current, after, 'forget', current.source.eventId, { reversible: true }, request);
      return { status: 'committed', record: after, eventId: after.headEventId };
    });
  }

  restoreMemory(activity: Activity, recordId: string, expected: MemoryRecord): MemoryOperation {
    return this.withActivity(activity, () => {
      const request = this.#requestDigest('restore', expected, { recordId });
      const replay = this.#replayed(request);
      if (replay) return replay;
      const current = this.#assertMemoryExpected(recordId, expected);
      check(current.lifecycle === 'tombstoned', 'memory-not-tombstoned');
      check(current.verification === 'verified', 'memory-not-eligible');
      this.#eligible(current);
      const after = this.#withMemoryHash({ ...current, lifecycle: 'active', headEventId: randomUUID() });
      this.#appendMemoryEvent(current, after, 'restore', current.source.eventId, { reversible: true }, request);
      return { status: 'committed', record: after, eventId: after.headEventId };
    });
  }

  correctMemory(activity: Activity, recordId: string, expected: MemoryRecord, input: SourceAck, content: string): MemoryOperation {
    return this.withActivity(activity, () => {
      const request = this.memoryCorrectionRequestHash(recordId, expected, input, content);
      const replay = this.#replayed(request);
      if (replay) return replay;
      const current = this.#assertMemoryExpected(recordId, expected);
      check(current.lifecycle !== 'tombstoned', 'tombstoned-not-actionable');
      check(typeof content === 'string', 'invalid-memory-content');
      if (content.trim().normalize('NFC') === '' || content.trim().normalize('NFC') === current.content.trim().normalize('NFC')) {
        return { status: 'no_op', record: current, eventId: null };
      }
      this.#validateSource(input, content);
      const revisionId = randomUUID();
      const eventId = randomUUID();
      const base = { ...current, revisionId, revision: this.#nextRevision(recordId), content, contentHash: sha256(content),
        lifecycle: current.lifecycle, verification: 'unverified' as const, verificationRunId: null, source: structuredClone(input), headEventId: eventId };
      const after = this.#withMemoryHash(base);
      this.#insertRevision(after);
      this.#appendMemoryEvent(current, after, 'correct', input.eventId, { automatic: false }, request);
      return { status: 'committed', record: after, eventId };
    });
  }

  // Synthetic Store input only. A semantic verifier and live approval remain Core work.
  reviseMemory(activity: Activity, recordId: string, expected: MemoryRecord, input: SourceAck, content: string, evidence: SourceAck[]): MemoryOperation {
    return this.withActivity(activity, () => {
      const request = this.#requestDigest('auto-revise', expected, { recordId, input, content, evidence });
      const replay = this.#replayed(request);
      if (replay) return replay;
      const current = this.#assertMemoryExpected(recordId, expected);
      check(current.lifecycle === 'active', 'memory-not-active');
      this.#eligible(current);
      this.#validateSource(input, content);
      if (content.trim().normalize('NFC') === current.content.trim().normalize('NFC')) return { status: 'no_op', record: current, eventId: null };
      let after = this.#withMemoryHash({ ...current, revisionId: randomUUID(), revision: this.#nextRevision(recordId),
        content, contentHash: sha256(content), source: structuredClone(input), headEventId: randomUUID(), verificationRunId: null });
      this.#insertRevision(after);
      const verificationRunId = this.#saveVerification(after, 'pass', evidence);
      after = this.#withMemoryHash({ ...after, verificationRunId });
      this.#appendMemoryEvent(current, after, 'auto-revise', input.eventId, { automatic: true, synthetic: true, evidence }, request);
      return { status: 'committed', record: after, eventId: after.headEventId };
    });
  }

  conflictMemory(activity: Activity, leftId: string, leftExpected: MemoryRecord, rightId: string, rightExpected: MemoryRecord): ConflictOperation {
    return this.withActivity(activity, () => {
      check(leftId !== rightId, 'invalid-conflict');
      const leftRequest = this.#requestDigest('conflict', leftExpected, { leftId, rightId, rightExpected });
      const rightRequest = this.#requestDigest('conflict', rightExpected, { leftId, rightId, leftExpected });
      const replayLeft = this.#replayed(leftRequest);
      const replayRight = this.#replayed(rightRequest);
      if (replayLeft || replayRight) {
        check(replayLeft && replayRight && replayLeft.record.conflictSetId === replayRight.record.conflictSetId, 'memory-stale');
        return { status: 'no_op', left: replayLeft, right: replayRight, conflictSetId: replayLeft.record.conflictSetId };
      }
      const left = this.#assertMemoryExpected(leftId, leftExpected);
      const right = this.#assertMemoryExpected(rightId, rightExpected);
      if (left.verification === 'conflicted' && right.verification === 'conflicted' && left.conflictSetId === right.conflictSetId) {
        return { status: 'no_op', left: { status: 'no_op', record: left, eventId: null }, right: { status: 'no_op', record: right, eventId: null }, conflictSetId: null };
      }
      check(left.verification === 'verified' && right.verification === 'verified' && left.lifecycle !== 'tombstoned' && right.lifecycle !== 'tombstoned'
        && JSON.stringify(left.scope) === JSON.stringify(right.scope) && JSON.stringify(left.appliesTo) === JSON.stringify(right.appliesTo), 'invalid-conflict');
      const conflictSetId = randomUUID();
      this.#db.prepare('INSERT INTO conflict_sets VALUES (?, ?)').run(conflictSetId, new Date().toISOString());
      this.#db.prepare('INSERT INTO conflict_members VALUES (?, ?), (?, ?)').run(conflictSetId, leftId, conflictSetId, rightId);
      const nextLeft = this.#withMemoryHash({ ...left, verification: 'conflicted', conflictSetId, headEventId: randomUUID() });
      const nextRight = this.#withMemoryHash({ ...right, verification: 'conflicted', conflictSetId, headEventId: randomUUID() });
      this.#appendMemoryEvent(left, nextLeft, 'conflict', left.source.eventId, { conflictSetId, members: [leftId, rightId] }, leftRequest);
      this.#appendMemoryEvent(right, nextRight, 'conflict', right.source.eventId, { conflictSetId, members: [leftId, rightId] }, rightRequest);
      return { status: 'committed', left: { status: 'committed', record: nextLeft, eventId: nextLeft.headEventId },
        right: { status: 'committed', record: nextRight, eventId: nextRight.headEventId }, conflictSetId };
    });
  }

  rollbackMemory(activity: Activity, recordId: string, expected: MemoryRecord, targetEventId: string): MemoryOperation {
    return this.withActivity(activity, () => {
      uuid(targetEventId);
      const request = this.#requestDigest('rollback', expected, { recordId, targetEventId });
      const replay = this.#replayed(request);
      if (replay) return replay;
      const current = this.#assertMemoryExpected(recordId, expected);
      const event = this.#db.prepare('SELECT * FROM memory_events WHERE event_id=?').get(targetEventId);
      check(event && event.record_id === recordId && ['activate','auto-revise'].includes(String(event.kind)) && event.before_snapshot, 'rollback-not-actionable');
      const targetAfter = this.#parseMemorySnapshot(String(event.after_snapshot));
      check(this.#businessSnapshot(current) === this.#businessSnapshot(targetAfter), 'memory-stale');
      check(!this.#db.prepare("SELECT 1 FROM memory_events WHERE record_id=? AND kind='rollback' AND target_event_id=?")
        .get(recordId, targetEventId), 'rollback-not-actionable');
      const before = this.#parseMemorySnapshot(String(event.before_snapshot));
      check(before.verification === 'verified' && ['candidate','active'].includes(before.lifecycle), 'rollback-not-actionable');
      this.#eligible(before);
      const after = this.#withMemoryHash({ ...before, headEventId: randomUUID() });
      this.#appendMemoryEvent(current, after, 'rollback', current.source.eventId, { targetEventId, automatic: true }, request);
      return { status: 'committed', record: after, eventId: after.headEventId };
    });
  }

  saveEvolutionProposal(activity: Activity, input: SourceAck, proposal: EvolutionProposalInput): EvolutionProposal {
    return this.withActivity(activity, () => {
      this.#validateSource(input);
      check(Object.keys(proposal).every(key => ['target','expectedChange','owner','scope','evidenceRefs','evaluation','supersedes','targetType','risk'].includes(key)), 'invalid-proposal');
      check(typeof proposal.target === 'string' && proposal.target.length > 0 && Buffer.byteLength(proposal.target) <= 4096
        && typeof proposal.expectedChange === 'string' && proposal.expectedChange.length > 0 && Buffer.byteLength(proposal.expectedChange) <= 65536
        && proposal.owner === this.#binding.ownerId, 'invalid-proposal');
      const scope = this.#validateScope(proposal.scope);
      check(scope.resolved && Array.isArray(proposal.evidenceRefs) && proposal.evidenceRefs.length > 0 && proposal.evidenceRefs.length <= 32, 'invalid-proposal');
      for (const ref of proposal.evidenceRefs) this.#validateSource(ref);
      const evaluation = proposal.evaluation;
      check(evaluation?.schema === 'evaluation-contract@1' && ['L0','L1','L2','L3'].includes(evaluation.level)
        && Object.keys(evaluation).every(key => ['schema','level','assertions'].includes(key))
        && Array.isArray(evaluation.assertions) && evaluation.assertions.length > 0 && evaluation.assertions.length <= 32
        && evaluation.assertions.every(value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 4096), 'invalid-proposal');
      const targetType = proposal.targetType ?? 'guidance';
      const risk = proposal.risk ?? 'low';
      check(['guidance','skill','code','policy'].includes(targetType) && ['low','high'].includes(risk), 'invalid-proposal');
      const request = sha256(JSON.stringify({ input, proposal }));
      const existing = this.#db.prepare('SELECT proposal_id FROM evolution_proposals WHERE request_hash=?').get(request);
      if (existing) return this.readEvolutionProposal(activity, String(existing.proposal_id));
      const prior = proposal.supersedes ? this.readEvolutionProposal(activity, proposal.supersedes) : null;
      if (prior) check(prior.target === proposal.target && prior.owner === proposal.owner
        && JSON.stringify(prior.scope) === JSON.stringify(scope), 'invalid-proposal');
      const latest = this.#db.prepare(`SELECT proposal_id,version FROM evolution_proposals
        WHERE target=? AND owner=? AND scope_kind=? AND scope_id=? ORDER BY version DESC LIMIT 1`)
        .get(proposal.target, proposal.owner, scope.kind, scope.id);
      check((latest?.proposal_id ?? null) === (proposal.supersedes ?? null), 'proposal-stale');
      const version = Number(latest?.version ?? 0) + 1;
      const proposalId = randomUUID();
      const value: Omit<EvolutionProposal, 'hash'> = { schema: 'evolution-proposal@1', proposalId, version, target: proposal.target,
        expectedChange: proposal.expectedChange, owner: proposal.owner, scope, input: structuredClone(input),
        targetType, risk, evidenceRefs: structuredClone(proposal.evidenceRefs), evaluation: structuredClone(evaluation),
        supersedes: proposal.supersedes ?? null, inert: true };
      const payload = JSON.stringify(value);
      const result = { ...value, hash: sha256(payload) };
      this.#db.prepare('INSERT INTO evolution_proposals VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(proposalId, version, proposal.target, proposal.expectedChange, proposal.owner, JSON.stringify(scope),
          JSON.stringify(proposal.evidenceRefs), JSON.stringify(evaluation), proposal.supersedes ?? null, payload, result.hash,
          new Date().toISOString(), scope.kind, scope.id, 1, request, targetType, risk);
      for (const [ordinal, ref] of [input, ...proposal.evidenceRefs].entries()) {
        this.#db.prepare('INSERT INTO proposal_evidence VALUES (?,?,?,?,?,?,?)')
          .run(proposalId, ordinal, ref.binding.sessionId, ref.eventId, ref.locator, ref.hash, ref.contentHash);
      }
      return result;
    });
  }

  readEvolutionProposal(activity: Activity, proposalId: string): EvolutionProposal {
    return this.withActivity(activity, () => {
      uuid(proposalId);
      const row = this.#db.prepare('SELECT * FROM evolution_proposals WHERE proposal_id=? AND owner=?').get(proposalId, this.#binding.ownerId);
      check(row && sha256(String(row.payload)) === row.payload_hash, 'proposal-evidence-gap');
      const value = JSON.parse(String(row.payload)) as Omit<EvolutionProposal, 'hash'>;
      check(value.schema === 'evolution-proposal@1' && value.proposalId === row.proposal_id && value.version === row.version
        && value.target === row.target && value.expectedChange === row.expected_change && value.owner === row.owner
        && value.supersedes === row.supersedes && value.inert === true && value.targetType === row.target_type && value.risk === row.risk
        && JSON.stringify(value.scope) === row.scope_json && value.scope.kind === row.scope_kind && value.scope.id === row.scope_id
        && JSON.stringify(value.evaluation) === row.evaluation_json && JSON.stringify(value.evidenceRefs) === row.evidence_json, 'proposal-evidence-gap');
      this.#validateScope(value.scope);
      const refs = [value.input, ...value.evidenceRefs];
      this.#checkEvidenceRows('proposal_evidence', 'proposal_id', proposalId, refs);
      for (const ref of refs) this.#validateSource(ref);
      return { ...value, hash: String(row.payload_hash) };
    });
  }

  #checkEvidenceRows(table: 'verification_evidence' | 'proposal_evidence', key: 'run_id' | 'proposal_id', id: string, refs: SourceAck[]): void {
    const rows = this.#db.prepare(`SELECT * FROM ${table} WHERE ${key}=? ORDER BY ordinal`).all(id);
    check(rows.length === refs.length, 'evidence-reference-gap');
    for (const [ordinal, ref] of refs.entries()) {
      const row = rows[ordinal]!;
      check(row.ordinal === ordinal && row.source_owner === ref.binding.sessionId && row.source_event_id === ref.eventId
        && row.locator === ref.locator && row.hash === ref.hash && row.content_hash === ref.contentHash, 'evidence-reference-gap');
    }
  }

  #saveVerification(record: MemoryRecord, result: 'pass' | 'block' | 'evidence-gap', evidence: SourceAck[]): string {
    check(result !== 'pass' || evidence.length > 0, 'verification-evidence-required');
    const runId = randomUUID();
    const bytes = JSON.stringify(evidence);
    this.#db.prepare('INSERT INTO verification_runs VALUES (?,?,?,?,?,?,?)')
      .run(runId, record.recordId, record.revisionId, result, bytes, sha256(bytes), new Date().toISOString());
    for (const [ordinal, ref] of evidence.entries()) {
      this.#validateSource(ref);
      this.#db.prepare('INSERT INTO verification_evidence VALUES (?,?,?,?,?,?,?)')
        .run(runId, ordinal, ref.binding.sessionId, ref.eventId, ref.locator, ref.hash, ref.contentHash);
    }
    return runId;
  }
  #suppressed(claimKey: string, lineage: string, scope: MemoryScope, appliesTo: string[]): MemoryRecord | null {
    const rows = this.#db.prepare(`SELECT r.record_id FROM memory_records r JOIN memory_heads h ON h.record_id=r.record_id
      WHERE r.owner_id=? AND r.claim_key=? AND r.source_lineage=? AND h.scope_kind=? AND h.scope_id=? AND h.lifecycle='tombstoned'`)
      .all(this.#binding.ownerId, claimKey, lineage, scope.kind, scope.id);
    for (const row of rows) {
      const record = this.#readMemoryUnsafe(String(row.record_id));
      if (JSON.stringify(record.appliesTo) === JSON.stringify(appliesTo)) return record;
    }
    return null;
  }
  #validateSource(input: SourceAck, content?: string): void {
    check(input?.schema === 'cli-source-ack@1' && input.status === 'durable' && sameBinding(input.binding, this.#binding), 'source-scope-mismatch');
    uuid(input.eventId);
    check(/^[0-9a-f]{64}$/i.test(input.hash) && /^[0-9a-f]{64}$/i.test(input.contentHash)
      && typeof input.locator === 'string' && input.locator.length > 0 && Number.isSafeInteger(input.byteLength) && input.byteLength > 0, 'invalid-source-ref');
    check(this.#readSource, 'source-reader-unavailable');
    check(sha256(this.#readSource(input).text) === input.contentHash, 'source-evidence-gap');
    if (content !== undefined) check(typeof content === 'string' && content.length > 0 && Buffer.byteLength(content) <= 65536, 'invalid-memory-content');
  }
  #validateScope(scope: MemoryScope): MemoryScope {
    check(scope && ['project', 'workspace', 'personal', 'session'].includes(scope.kind) && typeof scope.id === 'string', 'invalid-memory-scope');
    uuid(scope.id);
    check(Object.keys(scope).every(key => ['kind','id','resolved'].includes(key)) && typeof scope.resolved === 'boolean', 'invalid-memory-scope');
    if (scope.kind === 'project') check(scope.id === this.#binding.projectId && scope.resolved, 'invalid-memory-scope');
    if (scope.kind === 'personal') check(scope.id === this.#binding.ownerId && scope.resolved, 'invalid-memory-scope');
    if (scope.kind === 'session') check(scope.id === this.#binding.sessionId && !scope.resolved, 'invalid-memory-scope');
    if (scope.kind === 'workspace') throw new Error('workspace-unavailable');
    return structuredClone(scope);
  }
  #normalizeAppliesTo(value: string[]): string[] {
    check(Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0 && Buffer.byteLength(item) <= 256), 'invalid-memory-scope');
    const normalized = [...value].sort();
    check(new Set(normalized).size === normalized.length, 'invalid-memory-scope');
    return normalized;
  }
  #businessSnapshot(record: MemoryRecord): string {
    const { hash: _hash, headEventId: _event, ...business } = record;
    return JSON.stringify(business);
  }
  #eligible(record: MemoryRecord): void {
    check(record.scope.resolved && record.verification === 'verified' && !record.conflictSetId, 'memory-not-eligible');
    this.#validateSource(record.source);
    this.#checkVerification(record, true);
  }
  #checkVerification(record: MemoryRecord, readSources = false): void {
    if (!record.verificationRunId) { check(record.verification !== 'verified', 'verification-evidence-gap'); return; }
    const row = this.#db.prepare('SELECT * FROM verification_runs WHERE run_id=?').get(record.verificationRunId);
    check(row && row.record_id === record.recordId && row.revision_id === record.revisionId
      && sha256(String(row.evidence_json)) === row.evidence_hash
      && (record.verification !== 'verified' || row.result === 'pass'), 'verification-evidence-gap');
    const evidence = JSON.parse(String(row.evidence_json)) as SourceAck[];
    this.#checkEvidenceRows('verification_evidence', 'run_id', record.verificationRunId, evidence);
    if (readSources) for (const ref of evidence) this.#validateSource(ref);
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
  #verifyRevision(record: MemoryRecord): void {
    const revision = this.#db.prepare('SELECT * FROM memory_revisions WHERE revision_id=?').get(record.revisionId);
    check(revision && revision.record_id === record.recordId && revision.revision === record.revision
      && revision.content === record.content && revision.content_hash === record.contentHash
      && revision.type === record.type && revision.scope_kind === record.scope.kind && revision.scope_id === record.scope.id
      && Number(revision.scope_resolved) === (record.scope.resolved ? 1 : 0)
      && JSON.stringify(this.#readAppliesTo(record.revisionId)) === JSON.stringify(record.appliesTo)
      && revision.source_json === JSON.stringify(record.source) && revision.source_event_id === record.source.eventId
      && revision.source_hash === record.source.hash && revision.source_content_hash === record.source.contentHash
      && revision.source_locator === record.source.locator && sha256(record.content) === record.contentHash, 'memory-evidence-gap');
  }
  #replayMemory(recordId: string): MemoryRecord {
    const owner = this.#db.prepare('SELECT owner_id,claim_key,source_lineage FROM memory_records WHERE record_id=?').get(recordId);
    check(owner?.owner_id === this.#binding.ownerId, 'memory-not-found');
    const events = this.#db.prepare('SELECT * FROM memory_events WHERE record_id=? ORDER BY seq').all(recordId);
    let previous: string | null = null;
    let current: MemoryRecord | null = null;
    for (const [index, event] of events.entries()) {
      check(Number(event.seq) === index + 1 && event.record_id === recordId && sha256(String(event.payload)) === event.payload_hash
        && event.before_snapshot === previous, 'memory-evidence-gap');
      const after = this.#parseMemorySnapshot(String(event.after_snapshot));
      const payload = JSON.parse(String(event.payload));
      check(payload.schema === 'memory-event@1' && payload.eventId === event.event_id && payload.recordId === recordId
        && payload.seq === event.seq && payload.kind === event.kind && payload.request === event.request_hash
        && JSON.stringify(payload.after) === event.after_snapshot
        && (payload.before === null ? null : JSON.stringify(payload.before)) === event.before_snapshot
        && payload.originHostId === event.origin_host_id && payload.originSeq === event.origin_seq && payload.batchId === event.batch_id
        && (payload.targetEventId ?? null) === event.target_event_id
        && after.recordId === recordId && after.headEventId === event.event_id && after.revisionId === event.revision_id,
      'memory-evidence-gap');
      this.#verifyRevision(after);
      check(after.claimKey === owner.claim_key && after.source.binding.sessionId === owner.source_lineage, 'memory-evidence-gap');
      this.#checkVerification(after);
      previous = String(event.after_snapshot);
      current = after;
    }
    check(current, 'memory-evidence-gap');
    return current;
  }
  #readMemoryUnsafe(recordId: string): MemoryRecord {
    const row = this.#db.prepare('SELECT * FROM memory_heads WHERE record_id=?').get(recordId);
    check(row, 'memory-evidence-gap');
    const record = this.#replayMemory(recordId);
    check(this.#snapshotBytes(record) === row.snapshot && record.hash === row.snapshot_hash
      && record.revisionId === row.revision_id && record.lifecycle === row.lifecycle
      && record.verification === row.verification && record.scope.kind === row.scope_kind && record.scope.id === row.scope_id
      && record.scope.resolved === Boolean(row.scope_resolved) && record.conflictSetId === row.conflict_set_id
      && record.verificationRunId === row.verification_run_id
      && record.headEventId === row.head_event_id, 'memory-evidence-gap');
    this.#validateScope(record.scope);
    this.#validateSource(record.source);
    this.#checkVerification(record, true);
    return record;
  }
  #assertMemoryExpected(recordId: string, expected: MemoryRecord): MemoryRecord {
    uuid(recordId);
    const current = this.#readMemoryUnsafe(recordId);
    check(expected?.recordId === recordId && expected.hash === sha256(this.#snapshotBytes(expected))
      && this.#snapshotBytes(expected) === this.#snapshotBytes(current) && expected.headEventId === current.headEventId, 'memory-stale');
    return current;
  }
  #nextRevision(recordId: string): number {
    return Number(this.#db.prepare('SELECT MAX(revision) AS version FROM memory_revisions WHERE record_id=?').get(recordId)!.version) + 1;
  }
  #readAppliesTo(revisionId: string): string[] {
    return this.#db.prepare('SELECT value FROM memory_applicability WHERE revision_id=? ORDER BY ordinal').all(revisionId)
      .map(row => String(row.value));
  }
  #insertRevision(record: MemoryRecord): void {
    this.#db.prepare('INSERT INTO memory_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(record.revisionId, record.recordId, record.revision, record.content, record.contentHash, record.type,
        record.scope.kind, record.scope.id, record.scope.resolved ? 1 : 0, JSON.stringify(record.source),
        record.source.eventId, record.source.hash, record.source.contentHash, record.source.locator);
    for (const [ordinal, value] of record.appliesTo.entries()) {
      this.#db.prepare('INSERT INTO memory_applicability VALUES (?,?,?)').run(record.revisionId, ordinal, value);
    }
    const provenance = { schema: 'provenance-ref@1', recordId: record.recordId, revisionId: record.revisionId,
      ownerKind: 'session', ownerId: record.source.binding.sessionId, source: record.source };
    const payload = JSON.stringify(provenance);
    this.#db.prepare('INSERT INTO provenance_refs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), record.recordId, record.revisionId, 'session', record.source.binding.sessionId, JSON.stringify(record.source),
        record.source.eventId, record.source.locator, record.source.contentHash, payload, sha256(payload));
  }
  #requestDigest(kind: string, expected: MemoryRecord | null, args: unknown): string {
    return sha256(JSON.stringify({ schema: 'memory-request@1', kind, expected, args }));
  }
  #replayed(request: string): MemoryOperation | null {
    const row = this.#db.prepare('SELECT * FROM memory_events WHERE request_hash=?').get(request);
    if (!row) return null;
    const record = this.#readMemoryUnsafe(String(row.record_id));
    check(record.headEventId === row.event_id, 'memory-stale');
    return { status: 'no_op', record, eventId: null };
  }
  // Freeze the full correction identity before dispatch, so an unknown outcome can be queried exactly.
  memoryCorrectionRequestHash(recordId: string, expected: MemoryRecord, input: SourceAck, content: string): string {
    return this.#requestDigest('correct', expected, { recordId, input, content });
  }
  // Reconcile a lost acknowledgement before deciding whether a mutation may be retried.
  lookupMemoryOperation(activity: Activity, recordId: string, requestHash: string): MemoryOperation | null {
    return this.withActivity(activity, () => {
      uuid(recordId);
      check(typeof requestHash === 'string' && /^[0-9a-f]{64}$/.test(requestHash), 'invalid-memory-request-hash');
      this.#replayMemory(recordId);
      const row = this.#db.prepare('SELECT * FROM memory_events WHERE record_id=? AND request_hash=?').get(recordId, requestHash);
      return row ? { status: 'committed', record: this.#parseMemorySnapshot(String(row.after_snapshot)), eventId: String(row.event_id) } : null;
    });
  }
  #appendMemoryEvent(before: MemoryRecord | null, after: MemoryRecord, kind: string, sourceEventId: string,
    metadata: Record<string, unknown>, request = this.#requestDigest(kind, before, { sourceEventId, metadata })): void {
    const seq = Number(this.#db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM memory_events WHERE record_id=?').get(after.recordId)!.seq) + 1;
    const beforeSnapshot = before ? this.#snapshotBytes(before) : null;
    const afterSnapshot = this.#snapshotBytes(after);
    const batchId = ['activate','auto-revise'].includes(kind) ? randomUUID() : null;
    const originSeq = Number(this.#db.prepare('SELECT COALESCE(MAX(origin_seq),0)+1 AS seq FROM memory_events WHERE origin_host_id=?').get(this.#binding.hostId)!.seq);
    const payload = JSON.stringify({ schema: 'memory-event@1', eventId: after.headEventId, recordId: after.recordId, seq, kind,
      originHostId: this.#binding.hostId, originSeq, batchId,
      request, before: before ? JSON.parse(beforeSnapshot!) : null, after: JSON.parse(afterSnapshot), ...metadata });
    this.#db.prepare('INSERT INTO memory_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(after.headEventId, after.recordId, seq, kind, after.revisionId, beforeSnapshot, afterSnapshot, request,
        this.#binding.hostId, originSeq, batchId, typeof metadata.targetEventId === 'string' ? metadata.targetEventId : null,
        payload, sha256(payload), sourceEventId, new Date().toISOString());
    this.#saveHead(after);
    for (const jobKind of batchId ? ['search','host-info'] : ['search']) {
      const manifest = JSON.stringify({ schema: 'memory-outbox@1', kind: jobKind, batchId, events: [JSON.parse(payload)] });
      this.#db.prepare('INSERT INTO projection_jobs VALUES (?,?,?,?,?,?,?,?,?)')
        .run(randomUUID(), jobKind, after.headEventId, this.#binding.ownerId, after.scope.kind, after.scope.id, batchId, manifest, sha256(manifest));
    }
  }
  #saveHead(after: MemoryRecord): void {
    const afterSnapshot = this.#snapshotBytes(after);
    this.#db.prepare(`INSERT INTO memory_heads(record_id,revision_id,lifecycle,verification,scope_kind,scope_id,scope_resolved,head_event_id,snapshot,snapshot_hash,conflict_set_id,verification_run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(record_id) DO UPDATE SET revision_id=excluded.revision_id,lifecycle=excluded.lifecycle,verification=excluded.verification,
      scope_kind=excluded.scope_kind,scope_id=excluded.scope_id,scope_resolved=excluded.scope_resolved,head_event_id=excluded.head_event_id,
      snapshot=excluded.snapshot,snapshot_hash=excluded.snapshot_hash,conflict_set_id=excluded.conflict_set_id,verification_run_id=excluded.verification_run_id`)
      .run(after.recordId, after.revisionId, after.lifecycle, after.verification, after.scope.kind, after.scope.id, after.scope.resolved ? 1 : 0,
        after.headEventId, afterSnapshot, sha256(afterSnapshot), after.conflictSetId, after.verificationRunId);
  }

  beginMaintenance(coordinator: string): Fence {
    uuid(coordinator);
    return this.#transaction(() => {
      const fence = this.fence();
      if (fence.state !== 'open') {
        if (fence.coordinator === coordinator && fence.coordinator_pid === process.pid
          && fence.coordinator_incarnation === processIdentity.incarnation) return fence;
        check(fence.coordinator_pid !== null && processAbsent(fence.coordinator_pid), 'maintenance-owned');
        this.#db.prepare(`UPDATE owner_activities SET stop_state='absent',stop_observed_at=?,stop_method='node-process-kill-0/ESRCH' WHERE id=?`)
          .run(new Date().toISOString(), fence.coordinator_activity);
      }
      const streamId = fence.state === 'open'
        ? this.#ensureStream('maintenance', coordinator, coordinator).streamId : fence.coordinator_stream!;
      this.#readStream(streamId);
      const activityId = randomUUID();
      this.#db.prepare(`INSERT INTO owner_activities
        (id,store_id,pid,incarnation,started_at,epoch,root_path,root_dev,root_ino,stream_id,stop_state,stop_observed_at,stop_method)
        VALUES (?,?,?,?,?,?,?,?,?,?,'alive',?,'coordinator-registration')`)
        .run(activityId, this.#storeId, process.pid, processIdentity.incarnation, processIdentity.startedAt, fence.epoch + 1,
          this.#resources.root.path, this.#resources.root.identity.dev, this.#resources.root.identity.ino, streamId, new Date().toISOString());
      this.#db.prepare(`UPDATE owner_fences SET state='closing',epoch=epoch+1,coordinator=?,coordinator_pid=?,
        coordinator_incarnation=?,coordinator_started_at=?,coordinator_stream=?,coordinator_activity=? WHERE store_id=?`)
        .run(coordinator, process.pid, processIdentity.incarnation, processIdentity.startedAt, streamId, activityId, this.#storeId);
      return this.fence();
    });
  }

  #assertCoordinator(coordinator: string): Fence {
    const fence = this.fence();
    check(fence.state !== 'open' && fence.coordinator === coordinator && fence.coordinator_pid === process.pid
      && fence.coordinator_incarnation === processIdentity.incarnation && fence.coordinator_started_at === processIdentity.startedAt, 'maintenance-owned');
    return fence;
  }

  acquireMaintenance(coordinator: string) {
    return this.#transaction(() => {
      const fence = this.#assertCoordinator(coordinator);
      const rows = this.#db.prepare('SELECT * FROM owner_activities WHERE store_id=? AND id!=?').all(this.#storeId, fence.coordinator_activity);
      const observations = rows.map(row => {
        let state: 'alive' | 'absent' | 'unknown' = 'absent';
        let method = 'node-process-kill-0/ESRCH';
        let observedAt = String(row.stop_observed_at ?? new Date().toISOString());
        const pid = row.pid ?? row.launch_pid;
        if (row.stop_state !== 'absent') {
          observedAt = new Date().toISOString();
          try {
            if (pid === null) { state = 'unknown'; method = 'unacknowledged-controlled-launch'; }
            else state = processAbsent(Number(pid)) ? 'absent' : 'alive';
          }
          catch { state = 'unknown'; method = 'process-exit-evidence-gap'; }
          this.#db.prepare('UPDATE owner_activities SET stop_state=?,stop_observed_at=?,stop_method=? WHERE id=?')
            .run(state, observedAt, method, String(row.id));
        }
        return { id: String(row.id), pid: pid === null ? null : Number(pid), incarnation: row.incarnation === null ? null : String(row.incarnation),
          absent: state === 'absent', state, observedAt, method };
      });
      const residuals = this.#scanResiduals();
      const acquired = observations.every(item => item.absent) && residuals.every(item => item.state === 'expected');
      this.#db.prepare('UPDATE owner_fences SET state=? WHERE store_id=?').run(acquired ? 'exclusive' : 'closing', this.#storeId);
      return { acquired, observations, residuals };
    });
  }

  #scanResiduals() {
    const observedAt = new Date().toISOString();
    const entries: { path: string; state: 'expected' | 'unexpected' | 'unknown'; observedAt: string; dev: string | null; ino: string | null; reason: string }[] = [];
    // These are the existing disposable adapter's carriers, not a cleanup allowlist.
    const known = new Set(['sandbox.json', basename(this.#resources.source.path), basename(this.#resources.store.path),
      `${basename(this.#resources.store.path)}-wal`, `${basename(this.#resources.store.path)}-shm`]);
    try {
      const names = readdirSync(this.#resources.root.path).sort();
      check(names.length <= 1024, 'residual-enumeration-limit');
      for (const path of names) {
        try {
          const stat = lstatSync(join(this.#resources.root.path, path), { bigint: true });
          const expected = known.has(path) && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n;
          entries.push({ path, state: expected ? 'expected' : 'unexpected', observedAt,
            dev: stat.dev.toString(), ino: stat.ino.toString(), reason: expected ? 'known-disposable-carrier' : 'unexplained-residual' });
        } catch {
          entries.push({ path, state: 'unknown', observedAt, dev: null, ino: null, reason: 'residual-inspection-evidence-gap' });
        }
      }
    } catch {
      entries.push({ path: '.', state: 'unknown', observedAt, dev: null, ino: null, reason: 'residual-enumeration-evidence-gap' });
    }
    this.#db.prepare('DELETE FROM maintenance_residuals WHERE store_id=?').run(this.#storeId);
    const insert = this.#db.prepare('INSERT INTO maintenance_residuals VALUES (?,?,?,?,?,?,?)');
    for (const entry of entries) insert.run(this.#storeId, entry.path, entry.state, observedAt, entry.dev, entry.ino, entry.reason);
    return entries;
  }

  releaseMaintenance(coordinator: string): Fence {
    const released = this.#transaction(() => {
      const fence = this.#assertCoordinator(coordinator);
      check(fence.state === 'exclusive', 'maintenance-not-exclusive');
      if (!this.acquireMaintenance(coordinator).acquired) return null;
      return this.#reopenMaintenance();
    });
    // Commit the new blocked evidence even when release is rejected.
    check(released, 'maintenance-residuals-or-participants');
    return released;
  }

  cancelMaintenance(coordinator: string): Fence {
    return this.#transaction(() => {
      this.#assertCoordinator(coordinator);
      // No irreversible maintenance operation is enabled in this synthetic slice.
      return this.#reopenMaintenance();
    });
  }

  #reopenMaintenance(): Fence {
    this.#db.prepare(`UPDATE owner_fences SET state='open',epoch=epoch+1,coordinator=NULL,coordinator_pid=NULL,
      coordinator_incarnation=NULL,coordinator_started_at=NULL,coordinator_activity=NULL WHERE store_id=?`).run(this.#storeId);
    return this.fence();
  }

  maintenanceStatus() {
    return this.#transaction(() => ({
      fence: this.fence(),
      coordinatorStream: this.fence().coordinator_stream ? this.#readStream(this.fence().coordinator_stream!) : null,
      streams: this.#db.prepare('SELECT stream_id FROM execution_streams WHERE store_id=? ORDER BY rowid').all(this.#storeId)
        .map(row => this.#readStream(String(row.stream_id))),
      residuals: this.#db.prepare('SELECT * FROM maintenance_residuals WHERE store_id=? ORDER BY path').all(this.#storeId)
        .map(row => ({ path: String(row.path), state: String(row.state), observedAt: String(row.observed_at),
          dev: row.dev === null ? null : String(row.dev), ino: row.ino === null ? null : String(row.ino), reason: String(row.reason) })),
      activities: this.#db.prepare('SELECT * FROM owner_activities WHERE store_id=? ORDER BY rowid').all(this.#storeId)
        .map(row => ({ id: String(row.id), pid: row.pid === null ? null : Number(row.pid), incarnation: row.incarnation === null ? null : String(row.incarnation),
          parentId: row.parent_id === null ? null : String(row.parent_id),
          launchPid: row.launch_pid === null ? null : Number(row.launch_pid), startedAt: row.started_at === null ? null : String(row.started_at),
          epoch: Number(row.epoch), streamId: String(row.stream_id), owner: this.#readStream(String(row.stream_id)),
          stop: row.stop_state === null ? null : { state: String(row.stop_state), observedAt: String(row.stop_observed_at), method: String(row.stop_method) },
          root: { path: String(row.root_path), identity: { dev: String(row.root_dev), ino: String(row.root_ino) } } })),
    }));
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
