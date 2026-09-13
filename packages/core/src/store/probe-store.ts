import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { userInfo } from 'node:os';
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
export type MemoryChange = { kind: 'correct'; input: SourceAck; content: string }
  | { kind: 'forget' | 'restore' }
  | { kind: 'rollback'; batchId: string; eventIds: string[] };
export interface MemoryPresentation {
  schema: 'memory-presentation@1'; presentationId: string; operationId: string | null; token: string;
  sessionId: string; branchId: string; epoch: number; ordinal: number; kind: 'inspect' | MemoryChange['kind'];
  originatingPresentationId: string | null; supersedesOperationId: string | null;
  targets: MemoryRecord[]; input: SourceAck | null; content: string | null;
  batchId: string | null; eventIds: string[]; updateEventIds: string[]; batchPayload: string | null; batchDigest: string | null; hash: string;
}
export interface MemoryOperationResult {
  status: 'pending' | 'committed' | 'superseded' | 'cancelled' | 'stale' | 'no_op' | 'unavailable' | 'error' | 'settled' | 'invalid_identity';
  operationId: string | null; receiptIds: string[]; expected: MemoryRecord[]; current: MemoryRecord[]; reason: string | null;
}
export interface OwnerReceipt {
  schema: 'owner-receipt@1'; receiptId: string; operationId: string; kind: string; subjectRef: string;
  beforeRevision: number | null; afterRevision: number; outcome: 'committed';
}
export interface ActivationBatch {
  schema: 'activation-batch@1'; batchId: string; ownerId: string; scope: MemoryScope;
  events: { eventId: string; recordId: string; before: MemoryRecord; after: MemoryRecord }[];
  payload: string; digest: string;
}
export interface MemoryOperation { status: 'committed' | 'no_op'; record: MemoryRecord; eventId: string | null }
export interface SearchResult { unitId: string; record: MemoryRecord; exposureMode: 'normal' | 'status_only'; rank: number }
export interface SearchProjectionReceipt { jobId: string; eventId: string; status: 'done' | 'failed'; generation: number; reason: string | null }
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
CREATE TABLE schema_meta (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), store_id TEXT NOT NULL REFERENCES owner_fences(store_id),
  schema_version INTEGER NOT NULL CHECK(schema_version=7), ddl_hash TEXT NOT NULL,
  app_id TEXT NOT NULL, os_user TEXT NOT NULL
) STRICT;
CREATE TABLE owner_fences (
  store_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, host_id TEXT NOT NULL,
  root_path TEXT NOT NULL, root_dev TEXT NOT NULL, root_ino TEXT NOT NULL,
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
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY, branch_id TEXT NOT NULL, store_id TEXT NOT NULL REFERENCES owner_fences(store_id),
  owner_id TEXT NOT NULL, host_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(project_id),
  source_path TEXT NOT NULL UNIQUE, source_dev TEXT NOT NULL, source_ino TEXT NOT NULL,
  UNIQUE(session_id,branch_id), UNIQUE(session_id,branch_id,project_id)
) STRICT;
CREATE TABLE intent_events (
  event_id TEXT PRIMARY KEY, intent_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0),
  session_id TEXT NOT NULL, branch_id TEXT NOT NULL,
  input_event_id TEXT NOT NULL, expected_event_id TEXT REFERENCES intent_events(event_id),
  status TEXT NOT NULL CHECK(status IN ('active','paused','completed','needs-input')),
  input_hash TEXT NOT NULL, input_content_hash TEXT NOT NULL, input_locator TEXT NOT NULL, input_bytes INTEGER NOT NULL CHECK(input_bytes > 0),
  goal_input_event_id TEXT NOT NULL, goal_input_hash TEXT NOT NULL, goal_input_content_hash TEXT NOT NULL,
  goal_input_locator TEXT NOT NULL, goal_input_bytes INTEGER NOT NULL CHECK(goal_input_bytes > 0),
  transition_hash TEXT NOT NULL, snapshot TEXT NOT NULL, hash TEXT NOT NULL,
  UNIQUE(session_id, branch_id, version), UNIQUE(session_id, branch_id, input_event_id),
  UNIQUE(session_id,branch_id,event_id), FOREIGN KEY(session_id,branch_id) REFERENCES sessions(session_id,branch_id),
  FOREIGN KEY(session_id,branch_id,expected_event_id) REFERENCES intent_events(session_id,branch_id,event_id)
) STRICT;
CREATE TABLE intent_heads (
  session_id TEXT NOT NULL, branch_id TEXT NOT NULL,
  event_id TEXT NOT NULL REFERENCES intent_events(event_id), PRIMARY KEY(session_id, branch_id),
  FOREIGN KEY(session_id,branch_id,event_id) REFERENCES intent_events(session_id,branch_id,event_id)
) STRICT;
CREATE TRIGGER intent_sequence BEFORE INSERT ON intent_events
WHEN NEW.version!=(SELECT COALESCE(MAX(version),0)+1 FROM intent_events WHERE session_id=NEW.session_id AND branch_id=NEW.branch_id)
  OR NEW.expected_event_id IS NOT (SELECT event_id FROM intent_events WHERE session_id=NEW.session_id AND branch_id=NEW.branch_id ORDER BY version DESC LIMIT 1)
BEGIN SELECT RAISE(ABORT,'intent-sequence-conflict'); END;
CREATE TRIGGER immutable_intent_update BEFORE UPDATE ON intent_events BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER immutable_intent_delete BEFORE DELETE ON intent_events BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TABLE projects (project_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL) STRICT;
CREATE TABLE project_resources (
  project_id TEXT NOT NULL REFERENCES projects(project_id), path TEXT NOT NULL, dev TEXT NOT NULL, ino TEXT NOT NULL,
  PRIMARY KEY(project_id,path)
) STRICT;
CREATE TABLE workspaces (workspace_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL) STRICT;
CREATE TABLE workspace_projects (
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id), project_id TEXT NOT NULL UNIQUE REFERENCES projects(project_id),
  PRIMARY KEY(workspace_id,project_id)
) STRICT;
CREATE TABLE memory_scopes (
  kind TEXT NOT NULL CHECK(kind IN ('project','workspace','personal','session')), scope_id TEXT NOT NULL,
  resolved INTEGER NOT NULL CHECK(resolved IN (0,1)), owner_id TEXT NOT NULL,
  project_id TEXT REFERENCES projects(project_id), session_id TEXT REFERENCES sessions(session_id), workspace_id TEXT REFERENCES workspaces(workspace_id),
  CHECK((kind='project' AND scope_id=project_id AND project_id IS NOT NULL AND session_id IS NULL AND workspace_id IS NULL AND resolved=1)
    OR (kind='workspace' AND scope_id=workspace_id AND workspace_id IS NOT NULL AND project_id IS NULL AND session_id IS NULL AND resolved=1)
    OR (kind='personal' AND scope_id=owner_id AND project_id IS NULL AND session_id IS NULL AND workspace_id IS NULL AND resolved=1)
    OR (kind='session' AND scope_id=session_id AND session_id IS NOT NULL AND project_id IS NULL AND workspace_id IS NULL AND resolved=0)),
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
  job_id TEXT PRIMARY KEY, source_event_id TEXT NOT NULL, record_id TEXT NOT NULL UNIQUE REFERENCES memory_records(record_id),
  status TEXT NOT NULL CHECK(status IN ('captured','complete')), payload TEXT NOT NULL, payload_hash TEXT NOT NULL, created_at TEXT NOT NULL,
  source_owner TEXT NOT NULL REFERENCES sessions(session_id), UNIQUE(source_owner,source_event_id)
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
  request_hash TEXT NOT NULL UNIQUE, origin_host_id TEXT NOT NULL, origin_seq INTEGER NOT NULL CHECK(origin_seq>0),
  batch_id TEXT REFERENCES activation_batches(batch_id) DEFERRABLE INITIALLY DEFERRED,
  target_event_id TEXT,
  payload TEXT NOT NULL, payload_hash TEXT NOT NULL, source_event_id TEXT NOT NULL, created_at TEXT NOT NULL,
  batch_ordinal INTEGER CHECK(batch_ordinal>=0),
  operation_id TEXT REFERENCES pending_operations(operation_id), receipt_id TEXT UNIQUE, receipt_payload TEXT, receipt_hash TEXT,
  CHECK((batch_id IS NULL)=(batch_ordinal IS NULL)),
  CHECK((receipt_id IS NULL AND receipt_payload IS NULL AND receipt_hash IS NULL AND operation_id IS NULL)
    OR (receipt_id IS NOT NULL AND receipt_payload IS NOT NULL AND receipt_hash IS NOT NULL)),
  UNIQUE(batch_id,batch_ordinal), UNIQUE(batch_id,record_id), UNIQUE(record_id, seq),
  UNIQUE(origin_host_id,origin_seq),
  UNIQUE(record_id,event_id,revision_id), UNIQUE(record_id,event_id),
  FOREIGN KEY(record_id,target_event_id) REFERENCES memory_events(record_id,event_id),
  FOREIGN KEY(record_id,revision_id) REFERENCES memory_revisions(record_id,revision_id)
) STRICT;
CREATE TABLE host_presentations (
  presentation_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, branch_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal>0), epoch INTEGER NOT NULL CHECK(epoch>0), token TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('inspect','correct','forget','restore','rollback')),
  operation_id TEXT UNIQUE REFERENCES pending_operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  originating_id TEXT REFERENCES host_presentations(presentation_id), supersedes_operation_id TEXT REFERENCES pending_operations(operation_id),
  batch_id TEXT REFERENCES activation_batches(batch_id), batch_digest TEXT,
  payload TEXT NOT NULL, payload_hash TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN (0,1)),
  CHECK((kind='inspect' AND operation_id IS NULL AND originating_id IS NULL) OR (kind!='inspect' AND operation_id IS NOT NULL AND originating_id IS NOT NULL)),
  CHECK((batch_id IS NULL)=(batch_digest IS NULL)),
  FOREIGN KEY(session_id,branch_id) REFERENCES sessions(session_id,branch_id),
  FOREIGN KEY(session_id,originating_id) REFERENCES host_presentations(session_id,presentation_id),
  FOREIGN KEY(session_id,supersedes_operation_id) REFERENCES pending_operations(session_id,operation_id),
  UNIQUE(session_id,ordinal), UNIQUE(session_id,presentation_id), UNIQUE(operation_id,presentation_id)
) STRICT;
CREATE TABLE presentation_targets (
  presentation_id TEXT NOT NULL REFERENCES host_presentations(presentation_id), ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  record_id TEXT NOT NULL, revision_id TEXT NOT NULL, head_event_id TEXT NOT NULL,
  lifecycle TEXT NOT NULL, verification TEXT NOT NULL, scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL,
  selected_event_id TEXT, snapshot TEXT NOT NULL, snapshot_hash TEXT NOT NULL, update_event_id TEXT UNIQUE,
  PRIMARY KEY(presentation_id,ordinal), UNIQUE(presentation_id,record_id),
  FOREIGN KEY(record_id,head_event_id,revision_id) REFERENCES memory_events(record_id,event_id,revision_id),
  FOREIGN KEY(record_id,selected_event_id) REFERENCES memory_events(record_id,event_id),
  FOREIGN KEY(scope_kind,scope_id) REFERENCES memory_scopes(kind,scope_id)
) STRICT;
CREATE TRIGGER presentation_event_reservation BEFORE INSERT ON presentation_targets
WHEN (SELECT kind='inspect' FROM host_presentations WHERE presentation_id=NEW.presentation_id) != (NEW.update_event_id IS NULL)
BEGIN SELECT RAISE(ABORT,'presentation-event-mismatch'); END;
CREATE TABLE pending_operations (
  operation_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, presentation_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('pending','committed','superseded','cancelled','stale','no_op','unavailable','error')),
  result TEXT, result_hash TEXT, presentation_hash TEXT NOT NULL,
  CHECK((state='pending' AND result IS NULL AND result_hash IS NULL) OR (state!='pending' AND result IS NOT NULL AND result_hash IS NOT NULL)),
  FOREIGN KEY(session_id,presentation_id) REFERENCES host_presentations(session_id,presentation_id),
  UNIQUE(session_id,operation_id),
  FOREIGN KEY(operation_id,presentation_id) REFERENCES host_presentations(operation_id,presentation_id)
) STRICT;
CREATE TRIGGER operation_event_target BEFORE INSERT ON memory_events
WHEN NEW.operation_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM pending_operations o JOIN host_presentations p ON p.presentation_id=o.presentation_id
  JOIN presentation_targets t ON t.presentation_id=p.presentation_id
  WHERE o.operation_id=NEW.operation_id AND o.state='pending' AND p.kind=NEW.kind AND o.presentation_hash=p.payload_hash
    AND t.record_id=NEW.record_id AND t.snapshot=NEW.before_snapshot AND t.update_event_id=NEW.event_id
    AND t.selected_event_id IS NEW.target_event_id
)
BEGIN SELECT RAISE(ABORT,'operation-target-mismatch'); END;
CREATE UNIQUE INDEX session_pending ON pending_operations(session_id) WHERE state='pending';
CREATE TRIGGER settled_operation_immutable BEFORE UPDATE ON pending_operations
WHEN OLD.state!='pending' OR NEW.operation_id!=OLD.operation_id OR NEW.session_id!=OLD.session_id OR NEW.presentation_id!=OLD.presentation_id
  OR NEW.presentation_hash!=OLD.presentation_hash
BEGIN SELECT RAISE(ABORT,'settled-operation-immutable'); END;
CREATE TABLE activation_batches (
  batch_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL,
  member_count INTEGER NOT NULL CHECK(member_count>0 AND member_count<=32), payload TEXT NOT NULL, payload_hash TEXT NOT NULL,
  FOREIGN KEY(scope_kind,scope_id) REFERENCES memory_scopes(kind,scope_id)
) STRICT;
CREATE TABLE projection_jobs (
  job_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('search','host-info')), event_id TEXT NOT NULL REFERENCES memory_events(event_id),
  owner_id TEXT NOT NULL, scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL, batch_id TEXT,
  payload TEXT NOT NULL, payload_hash TEXT NOT NULL, UNIQUE(kind,event_id)
) STRICT;
CREATE TABLE search_documents (
  unit_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, record_id TEXT NOT NULL UNIQUE REFERENCES memory_records(record_id),
  revision_id TEXT NOT NULL, project_id TEXT NOT NULL, scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL,
  lifecycle TEXT NOT NULL, verification TEXT NOT NULL, exposure_mode TEXT NOT NULL CHECK(exposure_mode IN ('normal','status_only')),
  content TEXT NOT NULL, content_hash TEXT NOT NULL, source_seq INTEGER NOT NULL, tokenizer_version TEXT NOT NULL,
  projection_generation INTEGER NOT NULL CHECK(projection_generation > 0)
) STRICT;
CREATE VIRTUAL TABLE search_fts USING fts5(content, content='search_documents', content_rowid='rowid');
CREATE TABLE search_projection_jobs (
  job_id TEXT PRIMARY KEY REFERENCES projection_jobs(job_id), status TEXT NOT NULL CHECK(status IN ('done','failed')),
  processed_generation INTEGER NOT NULL CHECK(processed_generation > 0), processed_at TEXT NOT NULL, reason TEXT
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
CREATE TRIGGER immutable_search_projection_jobs_update BEFORE UPDATE ON search_projection_jobs BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER immutable_search_projection_jobs_delete BEFORE DELETE ON search_projection_jobs BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE INDEX memory_heads_eligibility ON memory_heads(lifecycle, verification, scope_kind, scope_id, scope_resolved);
PRAGMA user_version=7;
` + ['workspaces','workspace_projects','presentation_targets','activation_batches','schema_meta','sessions','execution_streams','execution_events','memory_applicability','projects','project_resources','memory_scopes','conflict_sets','conflict_members','verification_evidence','proposal_evidence','projection_jobs','feedback_events'].map(table => `
CREATE TRIGGER immutable_${table}_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER immutable_${table}_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'append-only'); END;
`).join('') + ['memory_heads','intent_heads','owner_fences','workspaces','workspace_projects','host_presentations','pending_operations','presentation_targets','activation_batches','schema_meta','sessions','intent_events','owner_activities','maintenance_residuals','execution_streams','execution_events','memory_records','memory_revisions','memory_events','memory_applicability','capture_jobs','provenance_refs',
  'verification_runs','verification_evidence','proposal_evidence','projection_jobs','feedback_events','search_projection_jobs','conflict_sets','conflict_members','evolution_proposals'].map(table => `
CREATE TRIGGER owned_${table}_insert BEFORE INSERT ON ${table}
WHEN euler_store_writer()!=1 BEGIN SELECT RAISE(ABORT,'store-owned-identity'); END;
`).join('') + ['memory_heads','intent_heads','owner_fences','host_presentations','pending_operations','owner_activities','maintenance_residuals'].flatMap(table => ['UPDATE','DELETE'].map(operation => `
CREATE TRIGGER owned_${table}_${operation.toLowerCase()} BEFORE ${operation} ON ${table}
WHEN euler_store_writer()!=1 BEGIN SELECT RAISE(ABORT,'store-owned-identity'); END;
`)).join('') + `
CREATE TRIGGER immutable_presentation_delete BEFORE DELETE ON host_presentations BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER immutable_pending_delete BEFORE DELETE ON pending_operations BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER immutable_presentation_update BEFORE UPDATE ON host_presentations
WHEN NEW.acknowledged<OLD.acknowledged OR ${['presentation_id','session_id','branch_id','ordinal','epoch','token','kind','operation_id',
  'originating_id','supersedes_operation_id','batch_id','batch_digest','payload','payload_hash'].map(column => `NEW.${column} IS NOT OLD.${column}`).join(' OR ')}
BEGIN SELECT RAISE(ABORT,'append-only'); END;
`;
export const probeSchemaDigest = sha256(DDL);

// P0 disposable schema; not migrations/001-initial.sql and not the execution ledger.
export class ProbeStore {
  readonly #db: DatabaseSync;
  readonly #storeId: string;
  readonly #binding: Binding;
  readonly #resources: StoreResources;
  readonly #readSource: ((input: SourceAck) => { text: string }) | undefined;
  #depth = 0;
  #committingOperation: string | null = null;

  constructor(resources: StoreResources, storeId: string, binding: Binding, initialize = false,
    readSource?: (input: SourceAck) => { text: string }, appId = 'euler') {
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
          this.#db.prepare(`INSERT INTO owner_fences
            (store_id,owner_id,host_id,root_path,root_dev,root_ino,store_path,store_dev,store_ino,state,epoch)
            VALUES (?,?,?,?,?,?,?,?,?,'open',1)`)
            .run(storeId, binding.ownerId, binding.hostId, resources.root.path, resources.root.identity.dev, resources.root.identity.ino,
              resources.store.path, resources.store.identity.dev, resources.store.identity.ino);
          this.#insertSession(binding, resources.source);
          this.#db.prepare('INSERT INTO schema_meta VALUES (1,?,7,?,?,?)')
            .run(storeId, probeSchemaDigest, appId, userInfo().username);
        });
      } else {
        check(version === 7, 'unsupported-probe-schema');
        check(this.#db.prepare('PRAGMA journal_mode').get()!.journal_mode === 'wal', 'invalid-journal-mode');
      }
      const schema = this.#db.prepare('SELECT * FROM schema_meta WHERE singleton=1').get();
      check(schema && schema.store_id === storeId && schema.schema_version === 7 && schema.ddl_hash === probeSchemaDigest
        && schema.app_id === appId && schema.os_user === userInfo().username, 'store-schema-identity-mismatch');
      const row = this.#db.prepare('SELECT * FROM owner_fences WHERE store_id=?').get(storeId);
      check(row && row.owner_id === binding.ownerId && row.host_id === binding.hostId, 'store-binding-mismatch');
      check(JSON.stringify(this.sessionSource(binding)) === JSON.stringify(resources.source), 'store-binding-mismatch');
      this.fence();
    } catch (error) { this.#db.close(); throw error; }
  }

  #insertSession(binding: Binding, source: BoundFile): void {
    for (const value of Object.values(binding)) uuid(value);
    check(Object.keys(binding).length === 5 && binding.ownerId === this.#binding.ownerId
      && binding.hostId === this.#binding.hostId, 'store-binding-mismatch');
    check(dirname(source.path) === this.#resources.root.path, 'store-resource-mismatch');
    sameFile(source.path, source.identity);
    const project = this.#db.prepare('SELECT owner_id FROM projects WHERE project_id=?').get(binding.projectId);
    check(!project || project.owner_id === binding.ownerId, 'store-binding-mismatch');
    this.#db.prepare('INSERT OR IGNORE INTO projects VALUES (?,?)').run(binding.projectId, binding.ownerId);
    this.#db.prepare('INSERT OR IGNORE INTO project_resources VALUES (?,?,?,?)')
      .run(binding.projectId, this.#resources.root.path, this.#resources.root.identity.dev, this.#resources.root.identity.ino);
    this.#db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?)')
      .run(binding.sessionId, binding.branchId, this.#storeId, binding.ownerId, binding.hostId, binding.projectId,
        source.path, source.identity.dev, source.identity.ino);
    this.#db.prepare(`INSERT OR IGNORE INTO memory_scopes(kind,scope_id,resolved,owner_id,project_id,session_id)
      VALUES (?,?,?,?,?,?), (?,?,?,?,?,?), (?,?,?,?,?,?)`)
      .run('project', binding.projectId, 1, binding.ownerId, binding.projectId, null,
        'personal', binding.ownerId, 1, binding.ownerId, null, null,
        'session', binding.sessionId, 0, binding.ownerId, null, binding.sessionId);
  }

  // Trusted synthetic Host registration; no model tool exposes identity mutation.
  bindSession(activity: Activity, binding: Binding, source: BoundFile): void {
    this.withActivity(activity, () => this.#insertSession(binding, source));
  }

  bindWorkspace(activity: Activity, workspaceId: string, projectIds: string[]): void {
    this.withActivity(activity, () => {
      uuid(workspaceId);
      check(Array.isArray(projectIds) && projectIds.length > 0 && projectIds.length <= 32
        && projectIds.includes(this.#binding.projectId) && new Set(projectIds).size === projectIds.length, 'invalid-workspace-membership');
      for (const projectId of projectIds) {
        uuid(projectId);
        const project = this.#db.prepare('SELECT owner_id FROM projects WHERE project_id=?').get(projectId);
        check(project?.owner_id === this.#binding.ownerId, 'invalid-workspace-membership');
      }
      this.#db.prepare('INSERT INTO workspaces VALUES (?,?)').run(workspaceId, this.#binding.ownerId);
      for (const projectId of projectIds) this.#db.prepare('INSERT INTO workspace_projects VALUES (?,?)').run(workspaceId, projectId);
      this.#db.prepare('INSERT INTO memory_scopes VALUES (?,?,1,?,NULL,NULL,?)')
        .run('workspace', workspaceId, this.#binding.ownerId, workspaceId);
    });
  }

  sessionSource(binding: Binding): BoundFile {
    check(binding.ownerId === this.#binding.ownerId && binding.hostId === this.#binding.hostId, 'store-binding-mismatch');
    const row = this.#db.prepare(`SELECT * FROM sessions WHERE session_id=? AND branch_id=? AND store_id=?
      AND owner_id=? AND host_id=? AND project_id=?`)
      .get(binding.sessionId, binding.branchId, this.#storeId, binding.ownerId, binding.hostId, binding.projectId);
    check(row, 'store-binding-mismatch');
    return { path: String(row.source_path), identity: { dev: String(row.source_dev), ino: String(row.source_ino) } };
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
    for (const kind of ['root', 'store'] as const) {
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
      check(stream.authorization.id === authorizationId && stream.projectId === this.#binding.projectId, 'stream-authorization-conflict');
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
    check(row && row.principal_id === this.#binding.ownerId && row.origin_host_id === this.#binding.hostId, 'stream-owner-evidence-gap');
    return { streamId, ownerKind: row.owner_kind as ExecutionStream['ownerKind'], ownerId: String(row.owner_id),
      principalId: String(row.principal_id), originHostId: String(row.origin_host_id), projectId: String(row.project_id),
      authorization: { kind: 'synthetic-host-command', id: String(row.authorization_id) } };
  }

  readStream(activity: Activity, streamId: string): ExecutionStream {
    return this.withActivity(activity, () => {
      const stream = this.#readStream(streamId);
      check(stream.projectId === this.#binding.projectId, 'stream-owner-evidence-gap');
      return stream;
    });
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
      const stream = this.readStream(activity, String(row.stream_id));
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
      const stream = this.#readStream(activity.streamId);
      check(stream.ownerKind !== 'maintenance', 'maintenance-business-unavailable');
      check(stream.projectId === this.#binding.projectId
        && (stream.ownerKind !== 'session' || stream.ownerId === this.#binding.sessionId), 'stream-owner-evidence-gap');
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
      check(!this.#db.prepare('SELECT 1 FROM intent_events WHERE session_id=? AND branch_id=? AND version>?')
        .get(this.#binding.sessionId, this.#binding.branchId, row.version!), 'intent-evidence-gap');
      return this.#readIntentSnapshot(row);
    });
  }

  #readIntentSnapshot(row: Record<string, unknown>): Intent {
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
    this.#validateSource(intent.input);
    this.#validateSource(intent.goalInput);
    return { ...intent, hash: String(row.hash) };
  }

  recoverIntent(activity: Activity): Intent | null {
    return this.withActivity(activity, () => {
      const rows = this.#db.prepare('SELECT * FROM intent_events WHERE session_id=? AND branch_id=? ORDER BY version')
        .all(this.#binding.sessionId, this.#binding.branchId);
      let latest: Intent | null = null;
      for (const [index, row] of rows.entries()) {
        check(row.version === index + 1 && row.expected_event_id === (latest?.eventId ?? null), 'intent-evidence-gap');
        const next = this.#readIntentSnapshot(row);
        check(!latest || (next.intentId === latest.intentId && next.goal === latest.goal
          && JSON.stringify(next.goalInput) === JSON.stringify(latest.goalInput)
          && JSON.stringify(next.constraints) === JSON.stringify(latest.constraints)), 'intent-evidence-gap');
        latest = next;
      }
      const head = this.#db.prepare('SELECT event_id FROM intent_heads WHERE session_id=? AND branch_id=?')
        .get(this.#binding.sessionId, this.#binding.branchId);
      if (!head && latest) {
        this.#db.prepare('INSERT INTO intent_heads VALUES (?,?,?)')
          .run(this.#binding.sessionId, this.#binding.branchId, latest.eventId);
      } else check((head?.event_id ?? null) === (latest?.eventId ?? null), 'intent-evidence-gap');
      return latest;
    });
  }

  transitionIntent(activity: Activity, expected: string | null, input: SourceAck, transition: IntentTransition, initialGoal?: string): Intent {
    return this.withActivity(activity, () => {
      check(sameBinding(input.binding, this.#binding) && input.status === 'durable', 'source-scope-mismatch');
      this.#validateSource(input);
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
      const scope = this.#validateScope(options.scope);
      this.#validateSource(input, content, scope);
      const appliesTo = this.#normalizeAppliesTo(options.appliesTo);
      const claimKey = options.claimKey ?? content.trim().normalize('NFC');
      check(typeof claimKey === 'string' && claimKey.length > 0 && Buffer.byteLength(claimKey) <= 65536, 'invalid-claim-key');
      check(['fact', 'preference', 'decision', 'insight', 'episode'].includes(options.type), 'invalid-memory-type');
      const existing = this.#db.prepare(`SELECT r.*,j.payload AS capture_payload,j.payload_hash AS capture_hash FROM capture_jobs j
        JOIN memory_revisions r ON r.record_id=j.record_id AND r.revision=1
        WHERE j.source_owner=? AND j.source_event_id=?`).get(input.binding.sessionId, input.eventId);
      if (existing) {
        const job = JSON.parse(String(existing.capture_payload));
        check(sha256(String(existing.capture_payload)) === existing.capture_hash && job.schema === 'capture-job@1'
          && job.recordId === existing.record_id && JSON.stringify(job.source) === JSON.stringify(input), 'capture-evidence-gap');
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
      this.#db.prepare('INSERT INTO capture_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), input.eventId, recordId, 'complete', capturePayload, sha256(capturePayload), new Date().toISOString(), input.binding.sessionId);
      this.#appendMemoryEvent(null, record, 'capture', input.eventId, { automatic: true },
        this.#requestDigest('capture', null, { input, content, scope, type: options.type, appliesTo, claimKey }));
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

  inspectMemoryPresentation(activity: Activity, recordIds: string[]): MemoryPresentation {
    return this.withActivity(activity, () => {
      check(Array.isArray(recordIds) && recordIds.length > 0 && recordIds.length <= 32
        && new Set(recordIds).size === recordIds.length, 'invalid-presentation-targets');
      const targets = recordIds.map(id => this.readMemory(activity, id));
      return this.#savePresentation(activity, { kind: 'inspect', targets, operationId: null, originatingPresentationId: null,
        supersedesOperationId: null, input: null, content: null, batchId: null, eventIds: [], updateEventIds: [], batchPayload: null, batchDigest: null });
    });
  }

  previewMemoryOperation(activity: Activity, inspectToken: string, change: MemoryChange): MemoryPresentation {
    return this.withActivity(activity, () => {
      const inspect = this.readMemoryPresentation(activity, inspectToken);
      check(inspect.kind === 'inspect' && inspect.epoch === activity.epoch, 'invalid-presentation-identity');
      const targets = inspect.targets.map(target => this.#assertMemoryExpected(target.recordId, target));
      check(change && ['correct','forget','restore','rollback'].includes(change.kind), 'invalid-memory-operation');
      const keys = change.kind === 'correct' ? ['kind','input','content'] : change.kind === 'rollback' ? ['kind','batchId','eventIds'] : ['kind'];
      check(Object.keys(change).every(key => keys.includes(key)), 'invalid-memory-operation');
      let batch: ActivationBatch | null = null;
      if (change.kind === 'correct') {
        check(targets.length === 1 && targets[0]!.lifecycle !== 'tombstoned', 'tombstoned-not-actionable');
        check(typeof change.content === 'string' && Buffer.byteLength(change.content) <= 65536, 'invalid-memory-content');
        this.#validateSource(change.input, undefined, targets[0]!.scope);
      } else if (change.kind === 'rollback') {
        batch = this.#readActivationBatch(change.batchId);
        check(Array.isArray(change.eventIds) && change.eventIds.length === targets.length
          && new Set(change.eventIds).size === change.eventIds.length, 'invalid-batch-selection');
        for (const [index, target] of targets.entries()) {
          const event = batch.events.find(event => event.eventId === change.eventIds[index]);
          check(event && event.recordId === target.recordId, 'invalid-batch-selection');
          this.#assertRollbackTarget(target, event.eventId);
        }
      } else {
        for (const target of targets) {
          check(target.lifecycle === (change.kind === 'forget' ? 'active' : 'tombstoned'), 'memory-not-actionable');
          if (change.kind === 'restore') this.#eligible(target);
        }
      }
      const previous = this.#db.prepare("SELECT p.token FROM pending_operations o JOIN host_presentations p ON p.presentation_id=o.presentation_id WHERE o.session_id=? AND o.state='pending'")
        .get(this.#binding.sessionId);
      const old = previous ? this.readMemoryPresentation(activity, String(previous.token)) : null;
      if (old) this.#settleOperation(old, 'superseded', [], [], 'new-preview');
      const presentation = this.#savePresentation(activity, { kind: change.kind, targets, operationId: randomUUID(),
        originatingPresentationId: inspect.presentationId, supersedesOperationId: old?.operationId ?? null,
        input: change.kind === 'correct' ? change.input : null, content: change.kind === 'correct' ? change.content : null,
        batchId: batch?.batchId ?? null, batchPayload: batch?.payload ?? null, batchDigest: batch?.digest ?? null,
        eventIds: change.kind === 'rollback' ? change.eventIds : [], updateEventIds: targets.map(() => randomUUID()) });
      this.#db.prepare("INSERT INTO pending_operations VALUES (?,?,?,'pending',NULL,NULL,?)")
        .run(presentation.operationId!, presentation.sessionId, presentation.presentationId, presentation.hash);
      return presentation;
    });
  }

  #savePresentation(activity: Activity,
    body: Pick<MemoryPresentation, 'kind' | 'targets' | 'operationId' | 'originatingPresentationId' | 'supersedesOperationId'
      | 'input' | 'content' | 'batchId' | 'batchPayload' | 'batchDigest' | 'eventIds' | 'updateEventIds'>): MemoryPresentation {
    const ordinal = Number(this.#db.prepare('SELECT COALESCE(MAX(ordinal),0)+1 AS n FROM host_presentations WHERE session_id=?').get(this.#binding.sessionId)!.n);
    const snapshot: Omit<MemoryPresentation, 'hash'> = { schema: 'memory-presentation@1', presentationId: randomUUID(), token: randomUUID(),
      sessionId: this.#binding.sessionId, branchId: this.#binding.branchId, epoch: activity.epoch, ordinal, ...structuredClone(body) };
    const payload = JSON.stringify(snapshot);
    const hash = sha256(payload);
    this.#db.prepare(`INSERT INTO host_presentations
      (presentation_id,session_id,branch_id,ordinal,epoch,token,kind,operation_id,originating_id,supersedes_operation_id,batch_id,batch_digest,payload,payload_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(snapshot.presentationId, snapshot.sessionId, snapshot.branchId, ordinal, snapshot.epoch, snapshot.token, snapshot.kind,
        snapshot.operationId, snapshot.originatingPresentationId, snapshot.supersedesOperationId, snapshot.batchId, snapshot.batchDigest, payload, hash);
    for (const [index, target] of snapshot.targets.entries()) {
      this.#db.prepare('INSERT INTO presentation_targets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(snapshot.presentationId, index, target.recordId, target.revisionId, target.headEventId, target.lifecycle, target.verification,
          target.scope.kind, target.scope.id, snapshot.eventIds[index] ?? null, this.#snapshotBytes(target), target.hash, snapshot.updateEventIds[index] ?? null);
    }
    return { ...snapshot, hash };
  }

  readMemoryPresentation(activity: Activity, token: string): MemoryPresentation {
    return this.withActivity(activity, () => {
      const row = this.#db.prepare('SELECT * FROM host_presentations WHERE token=? AND session_id=? AND branch_id=?')
        .get(token, this.#binding.sessionId, this.#binding.branchId);
      check(row && sha256(String(row.payload)) === row.payload_hash, 'invalid-presentation-identity');
      const value = JSON.parse(String(row.payload)) as Omit<MemoryPresentation, 'hash'>;
      check(value.schema === 'memory-presentation@1' && value.presentationId === row.presentation_id && value.token === row.token
        && value.sessionId === row.session_id && value.branchId === row.branch_id && value.epoch === row.epoch && value.ordinal === row.ordinal
        && value.kind === row.kind && value.operationId === row.operation_id && value.originatingPresentationId === row.originating_id
        && value.supersedesOperationId === row.supersedes_operation_id && value.batchId === row.batch_id && value.batchDigest === row.batch_digest
        && Array.isArray(value.eventIds) && Array.isArray(value.updateEventIds)
        && value.updateEventIds.length === (value.kind === 'inspect' ? 0 : value.targets.length)
        && value.eventIds.length === (value.kind === 'rollback' ? value.targets.length : 0)
        && (value.kind === 'correct' ? typeof value.content === 'string' && value.input !== null && value.targets.length === 1
          : value.content === null && value.input === null),
      'presentation-evidence-gap');
      if (value.operationId) {
        const operation = this.#db.prepare('SELECT presentation_hash FROM pending_operations WHERE operation_id=? AND presentation_id=?')
          .get(value.operationId, value.presentationId);
        check(operation?.presentation_hash === row.payload_hash, 'presentation-evidence-gap');
      }
      const targets = this.#db.prepare('SELECT * FROM presentation_targets WHERE presentation_id=? ORDER BY ordinal').all(value.presentationId);
      check(targets.length === value.targets.length && targets.length > 0, 'presentation-evidence-gap');
      for (const [index, target] of value.targets.entries()) {
        const stored = targets[index]!;
        if (value.kind !== 'inspect') uuid(value.updateEventIds[index]!);
        check(stored.ordinal === index && stored.record_id === target.recordId && stored.revision_id === target.revisionId
          && stored.head_event_id === target.headEventId && stored.lifecycle === target.lifecycle && stored.verification === target.verification
          && stored.scope_kind === target.scope.kind && stored.scope_id === target.scope.id
          && stored.selected_event_id === (value.eventIds[index] ?? null) && stored.update_event_id === (value.updateEventIds[index] ?? null)
          && stored.snapshot === this.#snapshotBytes(target)
          && stored.snapshot_hash === target.hash && target.hash === sha256(String(stored.snapshot)), 'presentation-evidence-gap');
        const event = this.#db.prepare('SELECT after_snapshot FROM memory_events WHERE event_id=? AND record_id=?').get(target.headEventId, target.recordId);
        check(event?.after_snapshot === stored.snapshot, 'presentation-evidence-gap');
      }
      if (value.batchId) {
        const batch = this.#readActivationBatch(value.batchId);
        check(value.batchDigest === batch.digest && value.batchPayload === batch.payload, 'batch-evidence-gap');
      }
      return { ...value, hash: String(row.payload_hash) };
    });
  }

  // Durable output acknowledgement only. The synthetic driver supplies it after
  // output; a production Host must establish real input authority before commit.
  acknowledgeMemoryPresentation(activity: Activity, token: string, digest: string): void {
    this.withActivity(activity, () => {
      const presentation = this.readMemoryPresentation(activity, token);
      check(presentation.hash === digest && presentation.epoch === activity.epoch, 'invalid-presentation-identity');
      this.#db.prepare('UPDATE host_presentations SET acknowledged=1 WHERE presentation_id=?').run(presentation.presentationId);
    });
  }

  memoryOperationStatus(activity: Activity, token: string): MemoryOperationResult {
    return this.withActivity(activity, () => {
      const row = this.#db.prepare(`SELECT o.* FROM pending_operations o JOIN host_presentations p ON p.presentation_id=o.presentation_id
        WHERE p.token=? AND p.session_id=? AND p.branch_id=?`).get(token, this.#binding.sessionId, this.#binding.branchId);
      if (!row) return { status: 'invalid_identity', operationId: null, receiptIds: [], expected: [], current: [], reason: 'unknown-token' };
      const presentation = this.readMemoryPresentation(activity, token);
      if (row.state === 'pending') return { status: 'pending', operationId: presentation.operationId,
        receiptIds: [], expected: presentation.targets, current: [], reason: null };
      check(sha256(String(row.result)) === row.result_hash, 'operation-evidence-gap');
      const result = JSON.parse(String(row.result)) as MemoryOperationResult;
      check(result.status === row.state && result.operationId === row.operation_id
        && JSON.stringify(result.expected) === JSON.stringify(presentation.targets), 'operation-evidence-gap');
      const receipts = this.#db.prepare('SELECT receipt_id FROM memory_events WHERE operation_id=? ORDER BY origin_seq').all(result.operationId!);
      check(JSON.stringify(result.receiptIds) === JSON.stringify(receipts.map(event => event.receipt_id)), 'operation-evidence-gap');
      for (const id of result.receiptIds) this.readOwnerReceipt(activity, id);
      return result;
    });
  }

  recoverMemoryOperations(activity: Activity) {
    return this.withActivity(activity, () => this.#db.prepare(`SELECT p.token,p.acknowledged FROM pending_operations o
      JOIN host_presentations p ON p.presentation_id=o.presentation_id WHERE p.session_id=? AND p.branch_id=? ORDER BY p.ordinal`)
      .all(this.#binding.sessionId, this.#binding.branchId).map(row => ({
        presentation: this.readMemoryPresentation(activity, String(row.token)),
        result: this.memoryOperationStatus(activity, String(row.token)), acknowledged: row.acknowledged === 1,
      })));
  }

  #settleOperation(presentation: MemoryPresentation, status: Exclude<MemoryOperationResult['status'], 'pending' | 'invalid_identity' | 'settled'>,
    current: MemoryRecord[], receiptIds: string[], reason: string | null): MemoryOperationResult {
    check(status !== 'committed' || receiptIds.length === presentation.targets.length, 'operation-receipt-gap');
    check(status === 'committed' || receiptIds.length === 0, 'operation-receipt-gap');
    const result: MemoryOperationResult = { status, operationId: presentation.operationId, receiptIds,
      expected: presentation.targets, current, reason };
    const payload = JSON.stringify(result);
    const changed = this.#db.prepare("UPDATE pending_operations SET state=?,result=?,result_hash=? WHERE operation_id=? AND state='pending'")
      .run(status, payload, sha256(payload), presentation.operationId!);
    check(changed.changes === 1, 'operation-already-settled');
    return result;
  }

  cancelMemoryOperation(activity: Activity, token: string): MemoryOperationResult {
    return this.withActivity(activity, () => {
      const status = this.memoryOperationStatus(activity, token);
      if (status.status === 'invalid_identity') return status;
      if (status.status !== 'pending') return { ...status, status: 'settled' };
      return this.#settleOperation(this.readMemoryPresentation(activity, token), 'cancelled', [], [], null);
    });
  }

  // Store transaction seam for the controlled synthetic Host. ProbeSession keeps
  // memory.commit unavailable; this primitive is not an approval signal or UI.
  commitMemoryOperation(activity: Activity, token: string): MemoryOperationResult {
    return this.withActivity(activity, () => {
      const status = this.memoryOperationStatus(activity, token);
      if (status.status === 'invalid_identity') return status;
      if (status.status !== 'pending') return { ...status, status: 'settled' };
      const presentation = this.readMemoryPresentation(activity, token);
      if (presentation.epoch !== activity.epoch) return this.#settleOperation(presentation, 'stale', [], [], 'epoch-changed');
      const ack = this.#db.prepare('SELECT acknowledged FROM host_presentations WHERE presentation_id=?').get(presentation.presentationId)!;
      if (ack.acknowledged !== 1) return this.#settleOperation(presentation, 'unavailable', [], [], 'presentation-not-acknowledged');
      const current: MemoryRecord[] = [];
      try {
        return this.#transaction(() => {
          for (const expected of presentation.targets) current.push(this.#readMemoryUnsafe(expected.recordId));
          for (const [index, expected] of presentation.targets.entries()) {
            check(expected.hash === current[index]!.hash && this.#snapshotBytes(expected) === this.#snapshotBytes(current[index]!), 'memory-stale');
          }
          check(this.#committingOperation === null, 'nested-owner-operation');
          this.#committingOperation = presentation.operationId;
          try {
            const changed = current.map((target, index) => {
              if (presentation.kind === 'correct') return this.correctMemory(activity, target.recordId, target, presentation.input!, presentation.content!);
              if (presentation.kind === 'forget') return this.forgetMemory(activity, target.recordId, target);
              if (presentation.kind === 'restore') return this.restoreMemory(activity, target.recordId, target);
              check(presentation.kind === 'rollback', 'invalid-memory-operation');
              return this.rollbackMemory(activity, target.recordId, target, presentation.eventIds[index]!);
            });
            const receipts = this.#db.prepare('SELECT receipt_id FROM memory_events WHERE operation_id=? ORDER BY origin_seq').all(presentation.operationId!);
            return this.#settleOperation(presentation, changed.every(item => item.status === 'no_op') ? 'no_op' : 'committed',
              changed.map(item => item.record), receipts.map(row => String(row.receipt_id)), null);
          } finally { this.#committingOperation = null; }
        });
      } catch (error) {
        const reason = (error as Error).message;
        return this.#settleOperation(presentation, reason === 'memory-stale' ? 'stale' : 'error', current, [], reason);
      }
    });
  }

  readOwnerReceipt(activity: Activity, receiptId: string): OwnerReceipt {
    return this.withActivity(activity, () => {
      uuid(receiptId);
      const row = this.#db.prepare('SELECT * FROM memory_events WHERE receipt_id=?').get(receiptId);
      check(row && sha256(String(row.receipt_payload)) === row.receipt_hash, 'receipt-evidence-gap');
      const record = this.#readMemoryUnsafe(String(row.record_id));
      this.#validateScope(record.scope);
      const receipt = JSON.parse(String(row.receipt_payload)) as OwnerReceipt;
      check(receipt.schema === 'owner-receipt@1' && receipt.receiptId === receiptId
        && receipt.operationId === (row.operation_id ?? row.event_id) && receipt.kind === row.kind
        && receipt.outcome === 'committed' && JSON.stringify(JSON.parse(String(row.payload)).ownerReceipt) === row.receipt_payload,
      'receipt-evidence-gap');
      return receipt;
    });
  }

  #assertRollbackTarget(current: MemoryRecord, targetEventId: string): MemoryRecord {
    uuid(targetEventId);
    const event = this.#db.prepare('SELECT * FROM memory_events WHERE event_id=?').get(targetEventId);
    check(event && event.record_id === current.recordId && ['activate','auto-revise'].includes(String(event.kind)) && event.before_snapshot, 'rollback-not-actionable');
    const targetAfter = this.#parseMemorySnapshot(String(event.after_snapshot));
    check(this.#businessSnapshot(current) === this.#businessSnapshot(targetAfter), 'memory-stale');
    check(!this.#db.prepare("SELECT 1 FROM memory_events WHERE record_id=? AND kind='rollback' AND target_event_id=?")
      .get(current.recordId, targetEventId), 'rollback-not-actionable');
    const before = this.#parseMemorySnapshot(String(event.before_snapshot));
    check(before.verification === 'verified' && ['candidate','active'].includes(before.lifecycle), 'rollback-not-actionable');
    this.#eligible(before);
    return before;
  }

  drainSearchProjection(activity: Activity, limit = 32): SearchProjectionReceipt[] {
    return this.withActivity(activity, () => {
      check(Number.isSafeInteger(limit) && limit > 0 && limit <= 128, 'invalid-projection-limit');
      const jobs = this.#db.prepare(`SELECT j.*, j.rowid AS projection_rowid FROM projection_jobs j
        LEFT JOIN search_projection_jobs p ON p.job_id=j.job_id
        WHERE j.kind='search' AND p.job_id IS NULL ORDER BY j.rowid LIMIT ?`).all(limit);
      const receipts: SearchProjectionReceipt[] = [];
      for (const job of jobs) {
        const payload = String(job.payload);
        check(sha256(payload) === job.payload_hash, 'outbox-evidence-gap');
        const manifest = JSON.parse(payload) as { schema: string; kind: string; events: unknown[] };
        check(manifest.schema === 'memory-outbox@1' && manifest.kind === 'search' && manifest.events.length === 1, 'outbox-evidence-gap');
        const event = manifest.events[0] as { eventId?: string; recordId?: string };
        check(event.eventId === job.event_id && typeof event.recordId === 'string', 'outbox-evidence-gap');
        const record = this.#readMemoryUnsafe(event.recordId);
        const generation = Number(job.projection_rowid);
        const eligible = record.lifecycle === 'active' && record.verification === 'verified' && record.scope.resolved
          && !record.conflictSetId && record.appliesTo.every(condition => ['cli', process.platform].includes(condition));
        const old = this.#db.prepare('SELECT rowid FROM search_documents WHERE unit_id=?').get(record.recordId);
        if (old) this.#db.prepare('DELETE FROM search_fts WHERE rowid=?').run(Number(old.rowid));
        this.#db.prepare('DELETE FROM search_documents WHERE unit_id=?').run(record.recordId);
        if (eligible) {
          const indexed = `${normalizeSearchText(record.content)} ${cjkBigrams(record.content)}`.trim();
          this.#db.prepare(`INSERT INTO search_documents
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(record.recordId, this.#binding.ownerId, record.recordId, record.revisionId,
            this.#binding.projectId, record.scope.kind, record.scope.id, record.lifecycle, record.verification, 'normal', indexed,
            record.contentHash, record.revision, 'cjk-2gram@1', generation);
          const row = this.#db.prepare('SELECT rowid FROM search_documents WHERE unit_id=?').get(record.recordId);
          this.#db.prepare('INSERT INTO search_fts(rowid,content) VALUES (?,?)').run(Number(row!.rowid), indexed);
        }
        this.#db.prepare('INSERT INTO search_projection_jobs VALUES (?,?,?,?,?)')
          .run(String(job.job_id), 'done', generation, new Date().toISOString(), null);
        receipts.push({ jobId: String(job.job_id), eventId: String(job.event_id), status: 'done', generation, reason: null });
      }
      return receipts;
    });
  }

  rebuildSearchProjection(activity: Activity): SearchProjectionReceipt[] {
    return this.withActivity(activity, () => {
      this.#db.exec('DROP TABLE search_fts; CREATE VIRTUAL TABLE search_fts USING fts5(content, content=\'search_documents\', content_rowid=\'rowid\'); DELETE FROM search_documents;');
      const receipts: SearchProjectionReceipt[] = [];
      const eligible = this.#db.prepare(`SELECT record_id FROM memory_heads WHERE lifecycle='active' AND verification='verified'
        AND scope_resolved=1 AND ${this.#visibleScopeSql('memory_heads')}`).all(...this.#scopeParameters());
      for (const row of eligible) {
        const record = this.#readMemoryUnsafe(String(row.record_id));
        if (record.conflictSetId || !record.appliesTo.every(condition => ['cli', process.platform].includes(condition))) continue;
        const indexed = `${normalizeSearchText(record.content)} ${cjkBigrams(record.content)}`.trim();
        const generation = record.revision;
        this.#db.prepare(`INSERT INTO search_documents VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(record.recordId, this.#binding.ownerId,
          record.recordId, record.revisionId, this.#binding.projectId, record.scope.kind, record.scope.id, record.lifecycle,
          record.verification, 'normal', indexed, record.contentHash, record.revision, 'cjk-2gram@1', generation);
        const inserted = this.#db.prepare('SELECT rowid FROM search_documents WHERE unit_id=?').get(record.recordId);
        this.#db.prepare('INSERT INTO search_fts(rowid,content) VALUES (?,?)').run(Number(inserted!.rowid), indexed);
        receipts.push({ jobId: '', eventId: record.headEventId, status: 'done', generation, reason: 'rebuild' });
      }
      return receipts;
    });
  }

  searchMemories(activity: Activity, query: string, limit = 10): SearchResult[] {
    return this.withActivity(activity, () => {
      check(Number.isSafeInteger(limit) && limit > 0 && limit <= 32, 'invalid-search-limit');
      const indexed = `${normalizeSearchText(query)} ${cjkBigrams(query)}`.trim();
      const rows = this.#db.prepare(`SELECT d.*, bm25(search_fts) AS rank FROM search_fts
        JOIN search_documents d ON d.rowid=search_fts.rowid
        WHERE search_fts MATCH ? AND d.owner_id=? AND ${this.#visibleScopeSql('d')} ORDER BY rank LIMIT ?`).all(
        indexed, this.#binding.ownerId, ...this.#scopeParameters(), limit);
      return rows.map(row => {
        const record = this.#readMemoryUnsafe(String(row.record_id));
        const eligible = record.lifecycle === 'active' && record.verification === 'verified' && record.scope.resolved
          && !record.conflictSetId && record.appliesTo.every(condition => ['cli', process.platform].includes(condition));
        check(eligible, 'search-evidence-gap');
        this.#validateScope(record.scope);
        return { unitId: String(row.unit_id), record, exposureMode: String(row.exposure_mode) as 'normal' | 'status_only', rank: Number(row.rank) };
      });
    });
  }

  pendingMemoryProjections(activity: Activity) {
    return this.withActivity(activity, () => this.#db.prepare(`SELECT * FROM projection_jobs
      WHERE owner_id=? AND ${this.#visibleScopeSql('projection_jobs')} ORDER BY rowid`)
      .all(this.#binding.ownerId, ...this.#scopeParameters())
      .map(row => {
        check(sha256(String(row.payload)) === row.payload_hash, 'outbox-evidence-gap');
        const manifest = JSON.parse(String(row.payload));
        const event = this.#db.prepare('SELECT payload FROM memory_events WHERE event_id=?').get(String(row.event_id));
        check(event && manifest.schema === 'memory-outbox@1' && manifest.kind === row.kind && manifest.batchId === row.batch_id,
          'outbox-evidence-gap');
        if (row.kind === 'host-info') {
          const batch = this.#readActivationBatch(String(row.batch_id));
          check(JSON.stringify(manifest.events) === JSON.stringify(JSON.parse(batch.payload).events)
            && manifest.events[0].eventId === row.event_id, 'outbox-evidence-gap');
        } else check(manifest.events.length === 1 && JSON.stringify(manifest.events[0]) === event.payload, 'outbox-evidence-gap');
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

  #visibleScopeSql(alias: 'projection_jobs' | 'memory_heads' | 'v' | 'd'): string {
    return `((${alias}.scope_kind='project' AND ${alias}.scope_id=?) OR (${alias}.scope_kind='personal' AND ${alias}.scope_id=?)
      OR (${alias}.scope_kind='session' AND ${alias}.scope_id=?) OR (${alias}.scope_kind='workspace' AND EXISTS
        (SELECT 1 FROM workspace_projects w WHERE w.workspace_id=${alias}.scope_id AND w.project_id=?)))`;
  }

  #scopeParameters(): string[] {
    return [this.#binding.projectId, this.#binding.ownerId, this.#binding.sessionId, this.#binding.projectId];
  }

  recoverMemories(activity: Activity): MemoryRecord[] {
    return this.withActivity(activity, () => this.#db.prepare(`SELECT r.record_id FROM memory_records r WHERE r.owner_id=?
      AND EXISTS(SELECT 1 FROM memory_revisions v WHERE v.record_id=r.record_id AND ${this.#visibleScopeSql('v')}) ORDER BY r.rowid`)
      .all(this.#binding.ownerId, ...this.#scopeParameters()).map(row => this.recoverMemory(activity, String(row.record_id))));
  }

  listEligibleMemories(activity: Activity): MemoryRecord[] {
    return this.withActivity(activity, () => {
      const records = this.#db.prepare(`SELECT record_id FROM memory_heads
        WHERE lifecycle='active' AND verification='verified' AND scope_resolved=1
        AND ${this.#visibleScopeSql('memory_heads')} ORDER BY rowid`)
        .all(...this.#scopeParameters()).map(row => this.#readMemoryUnsafe(String(row.record_id)))
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
      for (const ref of evidence) this.#validateSource(ref, undefined, current.scope);
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

  activateMemoryBatch(activity: Activity, expected: MemoryRecord[]): ActivationBatch {
    return this.withActivity(activity, () => {
      check(Array.isArray(expected) && expected.length > 0 && expected.length <= 32, 'invalid-activation-batch');
      check(new Set(expected.map(record => record.recordId)).size === expected.length, 'duplicate-batch-target');
      const scope = expected[0]!.scope;
      const current = expected.map(record => this.#assertMemoryExpected(record.recordId, record));
      for (const record of current) {
        check(JSON.stringify(record.scope) === JSON.stringify(scope), 'mixed-batch-scope');
        check(record.lifecycle === 'candidate', 'memory-not-eligible');
        this.#eligible(record);
        check(!this.#suppressed(record.claimKey, record.source.binding.sessionId, record.scope, record.appliesTo), 'memory-suppressed');
      }
      const batchId = randomUUID();
      for (const [ordinal, record] of current.entries()) {
        const after = this.#withMemoryHash({ ...record, lifecycle: 'active', headEventId: randomUUID() });
        this.#appendMemoryEvent(record, after, 'activate', record.source.eventId, { automatic: true },
          this.#requestDigest('activate', record, { recordId: record.recordId }), { batchId, ordinal });
      }
      this.#saveActivationBatch(batchId, scope);
      return this.#readActivationBatch(batchId);
    });
  }

  readActivationBatch(activity: Activity, batchId: string): ActivationBatch {
    return this.withActivity(activity, () => this.#readActivationBatch(batchId));
  }

  #readActivationBatch(batchId: string): ActivationBatch {
    uuid(batchId);
    const row = this.#db.prepare('SELECT * FROM activation_batches WHERE batch_id=? AND owner_id=?').get(batchId, this.#binding.ownerId);
    check(row && sha256(String(row.payload)) === row.payload_hash, 'batch-evidence-gap');
    const manifest = JSON.parse(String(row.payload));
    const events = this.#db.prepare('SELECT * FROM memory_events WHERE batch_id=? ORDER BY batch_ordinal').all(batchId);
    check(manifest.schema === 'activation-batch@1' && manifest.batchId === batchId && manifest.ownerId === row.owner_id
      && manifest.scope.kind === row.scope_kind && manifest.scope.id === row.scope_id && manifest.scope.resolved === true
      && events.length === row.member_count && events.length === manifest.events.length, 'batch-evidence-gap');
    this.#validateScope(manifest.scope);
    const members = events.map((event, ordinal) => {
      check(event.batch_ordinal === ordinal && ['activate','auto-revise'].includes(String(event.kind))
        && sha256(String(event.payload)) === event.payload_hash
        && JSON.stringify(manifest.events[ordinal]) === event.payload, 'batch-evidence-gap');
      this.#replayMemory(String(event.record_id));
      const before = this.#parseMemorySnapshot(String(event.before_snapshot));
      const after = this.#parseMemorySnapshot(String(event.after_snapshot));
      check(JSON.stringify(after.scope) === JSON.stringify(manifest.scope), 'batch-evidence-gap');
      return { eventId: String(event.event_id), recordId: String(event.record_id), before, after };
    });
    return { schema: 'activation-batch@1', batchId, ownerId: String(row.owner_id), scope: manifest.scope,
      events: members, payload: String(row.payload), digest: String(row.payload_hash) };
  }

  #saveActivationBatch(batchId: string, scope: MemoryScope): void {
    const events = this.#db.prepare('SELECT event_id,payload FROM memory_events WHERE batch_id=? ORDER BY batch_ordinal').all(batchId);
    const payload = JSON.stringify({ schema: 'activation-batch@1', batchId, ownerId: this.#binding.ownerId, scope,
      events: events.map(event => JSON.parse(String(event.payload))) });
    this.#db.prepare('INSERT INTO activation_batches VALUES (?,?,?,?,?,?,?)')
      .run(batchId, this.#binding.ownerId, scope.kind, scope.id, events.length, payload, sha256(payload));
    this.#saveOutbox('host-info', String(events[0]!.event_id), scope, batchId, events.map(event => JSON.parse(String(event.payload))));
  }

  #ownerEventId(recordId: string): string {
    if (!this.#committingOperation) return randomUUID();
    const row = this.#db.prepare(`SELECT t.update_event_id FROM pending_operations o
      JOIN presentation_targets t ON t.presentation_id=o.presentation_id
      WHERE o.operation_id=? AND o.state='pending' AND t.record_id=?`).get(this.#committingOperation, recordId);
    check(row, 'operation-target-mismatch');
    const eventId = String(row.update_event_id);
    uuid(eventId);
    return eventId;
  }

  forgetMemory(activity: Activity, recordId: string, expected: MemoryRecord): MemoryOperation {
    return this.withActivity(activity, () => {
      const request = this.#requestDigest('forget', expected, { recordId });
      const replay = this.#replayed(request);
      if (replay) return replay;
      const current = this.#assertMemoryExpected(recordId, expected);
      check(current.lifecycle === 'active', 'memory-not-active');
      const after = this.#withMemoryHash({ ...current, lifecycle: 'tombstoned', headEventId: this.#ownerEventId(recordId) });
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
      const after = this.#withMemoryHash({ ...current, lifecycle: 'active', headEventId: this.#ownerEventId(recordId) });
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
      this.#validateSource(input, content, current.scope);
      const revisionId = randomUUID();
      const nextEventId = this.#ownerEventId(recordId);
      uuid(nextEventId);
      const base = { ...current, revisionId, revision: this.#nextRevision(recordId), content, contentHash: sha256(content),
        lifecycle: current.lifecycle, verification: 'unverified' as const, verificationRunId: null, source: structuredClone(input), headEventId: nextEventId };
      const after = this.#withMemoryHash(base);
      this.#insertRevision(after);
      this.#appendMemoryEvent(current, after, 'correct', input.eventId, { automatic: false }, request);
      return { status: 'committed', record: after, eventId: nextEventId };
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
      this.#validateSource(input, content, current.scope);
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
      const before = this.#assertRollbackTarget(current, targetEventId);
      const after = this.#withMemoryHash({ ...before, headEventId: this.#ownerEventId(recordId) });
      this.#appendMemoryEvent(current, after, 'rollback', current.source.eventId, { targetEventId, automatic: true }, request);
      return { status: 'committed', record: after, eventId: after.headEventId };
    });
  }

  saveEvolutionProposal(activity: Activity, input: SourceAck, proposal: EvolutionProposalInput): EvolutionProposal {
    return this.withActivity(activity, () => {
      check(Object.keys(proposal).every(key => ['target','expectedChange','owner','scope','evidenceRefs','evaluation','supersedes','targetType','risk'].includes(key)), 'invalid-proposal');
      check(typeof proposal.target === 'string' && proposal.target.length > 0 && Buffer.byteLength(proposal.target) <= 4096
        && typeof proposal.expectedChange === 'string' && proposal.expectedChange.length > 0 && Buffer.byteLength(proposal.expectedChange) <= 65536
        && proposal.owner === this.#binding.ownerId, 'invalid-proposal');
      const scope = this.#validateScope(proposal.scope);
      this.#validateSource(input, undefined, scope);
      check(scope.resolved && Array.isArray(proposal.evidenceRefs) && proposal.evidenceRefs.length > 0 && proposal.evidenceRefs.length <= 32, 'invalid-proposal');
      for (const ref of proposal.evidenceRefs) this.#validateSource(ref, undefined, scope);
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
      for (const ref of refs) this.#validateSource(ref, undefined, value.scope);
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
      this.#validateSource(ref, undefined, record.scope);
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
  #validateSource(input: SourceAck, content?: string,
    targetScope: MemoryScope = { kind: 'project', id: this.#binding.projectId, resolved: true }): void {
    check(input?.schema === 'cli-source-ack@1' && input.status === 'durable'
      && input.binding.ownerId === this.#binding.ownerId && input.binding.hostId === this.#binding.hostId, 'source-scope-mismatch');
    this.#validateScope(targetScope);
    check(this.#sourceAllowedForScope(input.binding, targetScope), 'source-scope-mismatch');
    const source = this.sessionSource(input.binding);
    sameFile(source.path, source.identity);
    uuid(input.eventId);
    check(/^[0-9a-f]{64}$/i.test(input.hash) && /^[0-9a-f]{64}$/i.test(input.contentHash)
      && typeof input.locator === 'string' && input.locator.length > 0 && Number.isSafeInteger(input.byteLength) && input.byteLength > 0, 'invalid-source-ref');
    check(this.#readSource, 'source-reader-unavailable');
    check(sha256(this.#readSource(input).text) === input.contentHash, 'source-evidence-gap');
    if (content !== undefined) {
      check(typeof content === 'string' && content.length > 0 && Buffer.byteLength(content) <= 65536, 'invalid-memory-content');
    }
  }
  #sourceAllowedForScope(binding: Binding, scope: MemoryScope): boolean {
    if (scope.kind === 'project') return binding.projectId === scope.id;
    if (scope.kind === 'session') return binding.sessionId === scope.id;
    if (scope.kind === 'personal') return binding.ownerId === scope.id;
    return Boolean(this.#db.prepare(`SELECT 1 FROM workspace_projects m JOIN workspaces w ON w.workspace_id=m.workspace_id
      WHERE m.workspace_id=? AND m.project_id=? AND w.owner_id=?`).get(scope.id, binding.projectId, this.#binding.ownerId));
  }

  #validateScope(scope: MemoryScope): MemoryScope {
    check(scope && ['project', 'workspace', 'personal', 'session'].includes(scope.kind) && typeof scope.id === 'string', 'invalid-memory-scope');
    uuid(scope.id);
    check(Object.keys(scope).every(key => ['kind','id','resolved'].includes(key)) && typeof scope.resolved === 'boolean', 'invalid-memory-scope');
    if (scope.kind === 'project') check(scope.id === this.#binding.projectId && scope.resolved, 'invalid-memory-scope');
    if (scope.kind === 'personal') check(scope.id === this.#binding.ownerId && scope.resolved, 'invalid-memory-scope');
    if (scope.kind === 'session') check(scope.id === this.#binding.sessionId && !scope.resolved, 'invalid-memory-scope');
    if (scope.kind === 'workspace') {
      check(scope.resolved && this.#db.prepare(`SELECT 1 FROM workspace_projects m JOIN workspaces w ON w.workspace_id=m.workspace_id
        WHERE m.workspace_id=? AND m.project_id=? AND w.owner_id=?`).get(scope.id, this.#binding.projectId, this.#binding.ownerId), 'workspace-unavailable');
    }
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
    this.#validateSource(record.source, undefined, record.scope);
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
    if (readSources) for (const ref of evidence) this.#validateSource(ref, undefined, record.scope);
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
        && payload.batchOrdinal === event.batch_ordinal && payload.operationId === event.operation_id
        && (payload.ownerReceipt === null ? event.receipt_id === null && event.receipt_payload === null && event.receipt_hash === null
          : payload.ownerReceipt.receiptId === event.receipt_id && JSON.stringify(payload.ownerReceipt) === event.receipt_payload
            && sha256(String(event.receipt_payload)) === event.receipt_hash)
        && (payload.targetEventId ?? null) === event.target_event_id
        && after.recordId === recordId && after.headEventId === event.event_id && after.revisionId === event.revision_id,
      'memory-evidence-gap');
      this.#verifyRevision(after);
      check(after.claimKey === owner.claim_key
        && (index > 0 || after.source.binding.sessionId === owner.source_lineage), 'memory-evidence-gap');
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
    this.#validateSource(record.source, undefined, record.scope);
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
      this.#readMemoryUnsafe(recordId);
      const row = this.#db.prepare('SELECT * FROM memory_events WHERE record_id=? AND request_hash=?').get(recordId, requestHash);
      if (!row) return null;
      const record = this.#parseMemorySnapshot(String(row.after_snapshot));
      this.#validateScope(record.scope);
      return { status: 'committed', record, eventId: String(row.event_id) };
    });
  }
  #appendMemoryEvent(before: MemoryRecord | null, after: MemoryRecord, kind: string, sourceEventId: string,
    metadata: Record<string, unknown>, request = this.#requestDigest(kind, before, { sourceEventId, metadata }),
    batch?: { batchId: string; ordinal: number }): void {
    const seq = Number(this.#db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM memory_events WHERE record_id=?').get(after.recordId)!.seq) + 1;
    const beforeSnapshot = before ? this.#snapshotBytes(before) : null;
    const afterSnapshot = this.#snapshotBytes(after);
    const batchId = batch?.batchId ?? (['activate','auto-revise'].includes(kind) ? randomUUID() : null);
    const batchOrdinal = batchId ? batch?.ordinal ?? 0 : null;
    const originSeq = Number(this.#db.prepare('SELECT COALESCE(MAX(origin_seq),0)+1 AS seq FROM memory_events WHERE origin_host_id=?').get(this.#binding.hostId)!.seq);
    const ownerReceipt: OwnerReceipt | null = ['correct','forget','restore','rollback'].includes(kind)
      ? { schema: 'owner-receipt@1', receiptId: randomUUID(), operationId: this.#committingOperation ?? after.headEventId,
        kind, subjectRef: randomUUID(), beforeRevision: before?.revision ?? null, afterRevision: after.revision, outcome: 'committed' } : null;
    const receiptPayload = ownerReceipt ? JSON.stringify(ownerReceipt) : null;
    const payload = JSON.stringify({ schema: 'memory-event@1', eventId: after.headEventId, recordId: after.recordId, seq, kind,
      originHostId: this.#binding.hostId, originSeq, batchId, batchOrdinal, operationId: this.#committingOperation, ownerReceipt,
      request, before: before ? JSON.parse(beforeSnapshot!) : null, after: JSON.parse(afterSnapshot), ...metadata });
    this.#db.prepare(`INSERT INTO memory_events
      (event_id,record_id,seq,kind,revision_id,before_snapshot,after_snapshot,request_hash,origin_host_id,origin_seq,batch_id,
       target_event_id,payload,payload_hash,source_event_id,created_at,batch_ordinal,operation_id,receipt_id,receipt_payload,receipt_hash)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(after.headEventId, after.recordId, seq, kind, after.revisionId, beforeSnapshot, afterSnapshot, request,
        this.#binding.hostId, originSeq, batchId, typeof metadata.targetEventId === 'string' ? metadata.targetEventId : null,
        payload, sha256(payload), sourceEventId, new Date().toISOString(), batchOrdinal, this.#committingOperation,
        ownerReceipt?.receiptId ?? null, receiptPayload, receiptPayload ? sha256(receiptPayload) : null);
    this.#saveHead(after);
    this.#saveOutbox('search', after.headEventId, after.scope, batchId, [JSON.parse(payload)]);
    if (batchId && !batch) this.#saveActivationBatch(batchId, after.scope);
  }

  #saveOutbox(kind: 'search' | 'host-info', eventId: string, scope: MemoryScope, batchId: string | null, events: unknown[]): void {
    const manifest = JSON.stringify({ schema: 'memory-outbox@1', kind, batchId, events });
    this.#db.prepare('INSERT INTO projection_jobs VALUES (?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(), kind, eventId, this.#binding.ownerId, scope.kind, scope.id, batchId, manifest, sha256(manifest));
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
    const sources = this.#db.prepare('SELECT source_path,source_dev,source_ino FROM sessions WHERE store_id=?').all(this.#storeId);
    const sourceNames = sources.map(row => basename(String(row.source_path)));
    const known = new Set(['sandbox.json', ...sourceNames, basename(this.#resources.store.path),
      `${basename(this.#resources.store.path)}-wal`, `${basename(this.#resources.store.path)}-shm`]);
    try {
      const names = readdirSync(this.#resources.root.path).sort();
      check(names.length <= 1024, 'residual-enumeration-limit');
      for (const path of names) {
        try {
          const stat = lstatSync(join(this.#resources.root.path, path), { bigint: true });
          const source = sources.find(row => basename(String(row.source_path)) === path);
          const identityMatches = !source || (source.source_dev === stat.dev.toString() && source.source_ino === stat.ino.toString());
          const expected = known.has(path) && identityMatches && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n;
          entries.push({ path, state: expected ? 'expected' : 'unexpected', observedAt,
            dev: stat.dev.toString(), ino: stat.ino.toString(), reason: expected ? 'known-disposable-carrier' : 'unexplained-residual' });
        } catch {
          entries.push({ path, state: 'unknown', observedAt, dev: null, ino: null, reason: 'residual-inspection-evidence-gap' });
        }
      }
      for (const source of sourceNames) if (!names.includes(source)) entries.push({ path: source, state: 'unknown', observedAt,
        dev: null, ino: null, reason: 'registered-source-missing' });
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

function normalizeSearchText(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function cjkBigrams(value: string): string {
  const chars = Array.from(value.normalize('NFC')).filter(char => /\p{Script=Han}/u.test(char));
  return chars.slice(0, -1).map((char, index) => `${char}${chars[index + 1]}`).join(' ');
}

function processAbsent(pid: number): boolean {
  check(Number.isSafeInteger(pid) && pid > 0, 'invalid-process-identity');
  try { process.kill(pid, 0); return false; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    throw new Error('process-exit-evidence-gap', { cause: error });
  }
}
