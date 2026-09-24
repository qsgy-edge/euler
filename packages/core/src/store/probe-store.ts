import { replayAgent } from '../context/agent-state.ts';
import type { AgentEvent, AgentStatus } from '../context/agent-state.ts';
import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { userInfo } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { check, sameBinding, sha256, uuid, validateBudget } from '../contracts.ts';
import type { Binding, ProbeBudget, SourceAck } from '../contracts.ts';
import { REQUEST_ENCODING, REQUEST_HASH_ALGORITHM, assemblyIdentityHash, deriveAssemblyState, freezeRequestPayload } from './request-ledger.ts';
import type { RequestAssembly, RequestAssemblyInput, RequestAttempt, RequestEvent, RequestEventKind, RequestRun, RequestStatus, RequestReconciliation } from './request-ledger.ts';

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
  kind: 'session' | 'job' | 'maintenance' | 'migration';
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
export interface MemoryCaptureOptions { type: MemoryType; scope: MemoryScope; appliesTo: string[]; claimKey?: string;
  validFrom?: string; validUntil?: string }
export interface MemoryRecord {
  schema: 'memory-record@1'; recordId: string; revisionId: string; revision: number; claimKey: string;
  content: string; contentHash: string; type: MemoryType; lifecycle: MemoryLifecycle;
  verification: MemoryVerification; scope: MemoryScope; appliesTo: string[]; source: SourceAck;
  validFrom: string | null; validUntil: string | null;
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
export interface SearchTarget { agent?: string; platform?: string; component?: string }
export interface MemoryDiscoveryApproval {
  schema: 'memory-discovery-approval@1'; intentId: string; goalEventId: string;
  projectIds: string[]; targets: Record<string, SearchTarget>; maxResults: number; maxBytes: number;
}
export interface SearchRequest { query: string; limit?: number; byteBudget?: number; cursor?: string; grantId?: string;
  noActiveProject?: true; target?: SearchTarget }
export type SearchResult = { kind: 'memory'; unitId: string; record: MemoryRecord; exposureMode: 'normal' | 'reference_only'; rank: number;
  projectId: string; targetProjectId: string; target: SearchTarget; applicability: 'applicable' | 'needs-verification' }
  | { kind: 'status'; unitId: string; claimRef: string; verification: MemoryVerification;
    reason: 'stale' | 'conflicted' | 'expired' | 'not-yet-valid'; conflictSetId: string | null;
    projectId: string; targetProjectId: string; target: SearchTarget; exposureMode: 'status_only'; rank: number };
export interface SearchPage { status: 'ready' | 'dirty' | 'unavailable'; results: SearchResult[];
  coverage: { allowedProjects: string[]; inspectedProjects: string[]; unavailableProjects: string[];
    candidateCount: number | null; complete: false; reason: string | null };
  truncated: boolean; nextCursor: string | null }
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
  schema_version INTEGER NOT NULL CHECK(schema_version=10), ddl_hash TEXT NOT NULL,
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
CREATE TABLE request_runs (
  run_id TEXT PRIMARY KEY, stream_id TEXT NOT NULL REFERENCES execution_streams(stream_id), owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL, authorization_id TEXT NOT NULL, activity_id TEXT NOT NULL REFERENCES owner_activities(id),
  epoch INTEGER NOT NULL, budget TEXT NOT NULL, intent_event_id TEXT, intent_hash TEXT, related_run_id TEXT,
  authorized_at TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('authorized','revoked','sealed'))
) STRICT;
CREATE TABLE request_events (
  event_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES request_runs(run_id),
  seq INTEGER NOT NULL CHECK(seq>0),
  kind TEXT NOT NULL CHECK(kind IN ('agent/event@v1','run-authorized','run-revoked','run-sealed','run-recovery-gap','model/request-attempt-reconciled@v1','context/assembly@v1','model/request-attempt-started@v1','model/request-attempt-finished@v1')),
  attempt_id TEXT REFERENCES request_attempts(attempt_id), activity_id TEXT NOT NULL REFERENCES owner_activities(id),
  created_at TEXT NOT NULL, payload TEXT NOT NULL, hash TEXT NOT NULL, UNIQUE(run_id,seq)
) STRICT;
CREATE TABLE request_assemblies (
  assembly_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES request_runs(run_id), epoch INTEGER NOT NULL,
  route TEXT NOT NULL, model TEXT NOT NULL, policy_hash TEXT NOT NULL, estimator TEXT NOT NULL,
  identity_hash TEXT NOT NULL, payload_hash TEXT NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length>0),
  estimated_tokens INTEGER NOT NULL CHECK(estimated_tokens>0), budget TEXT NOT NULL, sources TEXT NOT NULL,
  intent_event_id TEXT, intent_hash TEXT, zones TEXT NOT NULL, selection TEXT NOT NULL, degradation TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('not-dispatched','unknown-sent','finished')),
  UNIQUE(run_id,identity_hash)
) STRICT;
CREATE TABLE request_attempts (
  attempt_id TEXT PRIMARY KEY REFERENCES execution_events(attempt_id),
  assembly_id TEXT NOT NULL REFERENCES request_assemblies(assembly_id),
  run_id TEXT NOT NULL REFERENCES request_runs(run_id), ordinal INTEGER NOT NULL CHECK(ordinal>0),
  payload_hash TEXT NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length>0), encoding TEXT NOT NULL,
  hash_algorithm TEXT NOT NULL, adapter_version TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
  outcome TEXT NOT NULL CHECK(outcome IN ('unknown-sent','received','cancelled-before-send')),
  UNIQUE(assembly_id,ordinal)
) STRICT;
CREATE TABLE projects (project_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL) STRICT;
CREATE TABLE project_resources (
  project_id TEXT NOT NULL REFERENCES projects(project_id), path TEXT NOT NULL, dev TEXT NOT NULL, ino TEXT NOT NULL,
  PRIMARY KEY(project_id,path)
) STRICT;
CREATE TABLE memory_discovery_grants (
  grant_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(session_id),
  intent_id TEXT NOT NULL, consent TEXT NOT NULL, consent_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  max_results INTEGER NOT NULL CHECK(max_results>0 AND max_results<=128),
  used_results INTEGER NOT NULL DEFAULT 0 CHECK(used_results>=0 AND used_results<=max_results),
  max_bytes INTEGER NOT NULL CHECK(max_bytes>0 AND max_bytes<=1000000),
  used_bytes INTEGER NOT NULL DEFAULT 0 CHECK(used_bytes>=0 AND used_bytes<=max_bytes),
  max_queries INTEGER NOT NULL CHECK(max_queries>0 AND max_queries<=128),
  used_queries INTEGER NOT NULL DEFAULT 0 CHECK(used_queries>=0 AND used_queries<=max_queries),
  UNIQUE(session_id,intent_id)
) STRICT;
CREATE TABLE memory_discovery_projects (
  grant_id TEXT NOT NULL REFERENCES memory_discovery_grants(grant_id), project_id TEXT NOT NULL REFERENCES projects(project_id),
  PRIMARY KEY(grant_id,project_id)
) STRICT;
CREATE TABLE memory_discovery_targets (
  grant_id TEXT NOT NULL, project_id TEXT NOT NULL, agent TEXT, platform TEXT, component TEXT,
  CHECK(agent IS NOT NULL OR platform IS NOT NULL OR component IS NOT NULL),
  PRIMARY KEY(grant_id,project_id),
  FOREIGN KEY(grant_id,project_id) REFERENCES memory_discovery_projects(grant_id,project_id)
) STRICT;
CREATE TRIGGER immutable_discovery_targets_update BEFORE UPDATE ON memory_discovery_targets BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER immutable_discovery_targets_delete BEFORE DELETE ON memory_discovery_targets BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER immutable_discovery_grant BEFORE UPDATE ON memory_discovery_grants
WHEN NEW.grant_id!=OLD.grant_id OR NEW.owner_id!=OLD.owner_id OR NEW.session_id!=OLD.session_id
  OR NEW.intent_id!=OLD.intent_id OR NEW.consent!=OLD.consent OR NEW.consent_hash!=OLD.consent_hash
  OR NEW.max_results!=OLD.max_results OR NEW.max_bytes!=OLD.max_bytes OR (OLD.state='revoked' AND NEW.state!='revoked')
  OR NEW.used_results<OLD.used_results OR NEW.used_bytes<OLD.used_bytes
BEGIN SELECT RAISE(ABORT,'discovery-grant-immutable'); END;
CREATE TRIGGER immutable_discovery_projects_update BEFORE UPDATE ON memory_discovery_projects BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER immutable_discovery_projects_delete BEFORE DELETE ON memory_discovery_projects BEGIN SELECT RAISE(ABORT,'append-only'); END;
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
  valid_from TEXT, valid_until TEXT, source_project_id TEXT NOT NULL REFERENCES projects(project_id),
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
PRAGMA user_version=10;
` + ['workspaces','workspace_projects','memory_discovery_projects','memory_discovery_targets','presentation_targets','activation_batches','schema_meta','sessions','execution_streams','execution_events','memory_applicability','request_events','projects','project_resources','memory_scopes','conflict_sets','conflict_members','verification_evidence','proposal_evidence','projection_jobs','feedback_events'].map(table => `
CREATE TRIGGER immutable_${table}_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER immutable_${table}_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'append-only'); END;
`).join('') + ['memory_heads','intent_heads','owner_fences','workspaces','workspace_projects','host_presentations','pending_operations','presentation_targets','activation_batches','schema_meta','sessions','intent_events','owner_activities','maintenance_residuals','execution_streams','execution_events','request_runs','request_events','request_assemblies','request_attempts','memory_records','memory_revisions','memory_events','memory_applicability','capture_jobs','provenance_refs',
  'verification_runs','verification_evidence','proposal_evidence','projection_jobs','feedback_events','search_projection_jobs','conflict_sets','conflict_members','evolution_proposals','memory_discovery_grants','memory_discovery_targets'].map(table => `
CREATE TRIGGER owned_${table}_insert BEFORE INSERT ON ${table}
WHEN euler_store_writer()!=1 BEGIN SELECT RAISE(ABORT,'store-owned-identity'); END;
`).join('') + ['memory_heads','intent_heads','owner_fences','memory_discovery_grants','host_presentations','pending_operations','owner_activities','maintenance_residuals','request_runs','request_assemblies','request_attempts'].flatMap(table => ['UPDATE','DELETE'].map(operation => `
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
  readonly #queryRequest: ((attempt: RequestAttempt) => RequestReconciliation) | undefined;
  readonly #readSource: ((input: SourceAck) => { text: string; role?: 'user' | 'assistant' | 'tool' }) | undefined;
  #depth = 0;
  #committingOperation: string | null = null;

  constructor(resources: StoreResources, storeId: string, binding: Binding, initialize = false,
    readSource?: (input: SourceAck) => { text: string; role?: 'user' | 'assistant' | 'tool' }, appId = 'euler', queryRequest?: (attempt: RequestAttempt) => RequestReconciliation) {
    this.#queryRequest = queryRequest;
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
          this.#db.prepare('INSERT INTO schema_meta VALUES (1,?,10,?,?,?)')
            .run(storeId, probeSchemaDigest, appId, userInfo().username);
        });
      } else {
        check(version === 10, 'unsupported-probe-schema');
        check(this.#db.prepare('PRAGMA journal_mode').get()!.journal_mode === 'wal', 'invalid-journal-mode');
      }
      const schema = this.#db.prepare('SELECT * FROM schema_meta WHERE singleton=1').get();
      check(schema && schema.store_id === storeId && schema.schema_version === 10 && schema.ddl_hash === probeSchemaDigest
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

  guidanceMembership(activity: Activity, projectIds: string[]): { ownerId: string; projects: { projectId: string; workspaceId: string | null }[] } {
    return this.withActivity(activity, () => {
      check(projectIds.length <= 32 && new Set(projectIds).size === projectIds.length, 'guidance-scope-unresolved');
      return { ownerId: this.#binding.ownerId, projects: projectIds.map(projectId => {
        const row = this.#db.prepare(`SELECT p.owner_id,w.workspace_id,w.owner_id AS workspace_owner
          FROM projects p LEFT JOIN workspace_projects m ON m.project_id=p.project_id
          LEFT JOIN workspaces w ON w.workspace_id=m.workspace_id WHERE p.project_id=?`).get(projectId);
        check(row?.owner_id === this.#binding.ownerId
          && (row.workspace_id === null || row.workspace_owner === this.#binding.ownerId), 'guidance-scope-unresolved');
        return { projectId, workspaceId: row.workspace_id === null ? null : String(row.workspace_id) };
      }) };
    });
  }

  // Host-only synthetic owner decision; a search request or model text cannot create this grant.
  authorizeMemoryDiscovery(activity: Activity, consent: SourceAck, projectIds: string[], maxResults: number,
    targets: Record<string, SearchTarget> = {}, maxBytes = 131072): { grantId: string } {
    return this.withActivity(activity, () => {
      const intent = this.readIntent(activity);
      check(intent?.status === 'active' && !this.#discoveryTaskCompleted(intent.intentId), 'discovery-consent-required');
      const approval = this.#readDiscoveryApproval(consent, intent);
      check(JSON.stringify(approval.projectIds) === JSON.stringify(projectIds) && approval.maxResults === maxResults
        && approval.maxBytes === maxBytes && JSON.stringify(approval.targets) === JSON.stringify(targets), 'discovery-consent-required');
      check(Array.isArray(projectIds) && projectIds.length > 0 && projectIds.length <= 32
        && new Set(projectIds).size === projectIds.length && Number.isSafeInteger(maxResults)
        && maxResults > 0 && maxResults <= 128 && Number.isSafeInteger(maxBytes)
        && maxBytes > 0 && maxBytes <= 1000000, 'invalid-discovery-grant');
      for (const projectId of projectIds) {
        uuid(projectId);
        check(this.#db.prepare('SELECT 1 FROM projects WHERE project_id=? AND owner_id=?')
          .get(projectId, this.#binding.ownerId), 'discovery-project-unavailable');
      }
      check(validDiscoveryTargets(targets, projectIds), 'invalid-discovery-target');
      const payload = JSON.stringify(consent);
      const previous = this.#db.prepare('SELECT grant_id,consent_hash,state FROM memory_discovery_grants WHERE session_id=? AND intent_id=?')
        .get(this.#binding.sessionId, intent.intentId);
      if (previous) {
        check(previous.consent_hash === sha256(payload) && previous.state === 'active', 'discovery-already-authorized');
        return { grantId: String(previous.grant_id) };
      }
      const grantId = randomUUID();
      this.#db.prepare(`INSERT INTO memory_discovery_grants
        (grant_id,owner_id,session_id,intent_id,consent,consent_hash,state,max_results,max_bytes,max_queries)
        VALUES (?,?,?,?,?,?,'active',?,?,?)`)
        .run(grantId, this.#binding.ownerId, this.#binding.sessionId, intent.intentId, payload, sha256(payload),
          maxResults, maxBytes, Math.min(128, Math.max(8, maxResults * 4)));
      for (const projectId of projectIds) this.#db.prepare('INSERT INTO memory_discovery_projects VALUES (?,?)').run(grantId, projectId);
      for (const [projectId, target] of Object.entries(targets)) this.#db.prepare('INSERT INTO memory_discovery_targets VALUES (?,?,?,?,?)')
        .run(grantId, projectId, target.agent ?? null, target.platform ?? null, target.component ?? null);
      return { grantId };
    });
  }

  #readDiscoveryApproval(consent: SourceAck, intent: Intent): MemoryDiscoveryApproval {
    check(sameBinding(consent?.binding, this.#binding) && consent.eventId !== intent.goalInput.eventId, 'discovery-consent-required');
    this.#validateSource(consent);
    const source = this.#readSource!(consent);
    check(source.role === 'user', 'discovery-consent-required');
    const text = source.text;
    check(Buffer.byteLength(text) <= 8192, 'discovery-consent-required');
    let approval: MemoryDiscoveryApproval;
    try { approval = JSON.parse(text) as MemoryDiscoveryApproval; }
    catch { throw new Error('discovery-consent-required'); }
    check(approval?.schema === 'memory-discovery-approval@1' && approval.intentId === intent.intentId
      && approval.goalEventId === intent.goalInput.eventId && Array.isArray(approval.projectIds)
      && approval.projectIds.length > 0 && approval.projectIds.length <= 32
      && new Set(approval.projectIds).size === approval.projectIds.length
      && approval.projectIds.every(id => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id))
      && Number.isSafeInteger(approval.maxResults) && approval.maxResults > 0 && approval.maxResults <= 128
      && Number.isSafeInteger(approval.maxBytes) && approval.maxBytes > 0 && approval.maxBytes <= 1000000
      && validDiscoveryTargets(approval.targets, approval.projectIds)
      && Object.keys(approval).sort().join(',') === ['schema','intentId','goalEventId','projectIds','targets','maxResults','maxBytes'].sort().join(','),
    'discovery-consent-required');
    return approval;
  }

  revokeMemoryDiscovery(activity: Activity, grantId: string): void {
    this.withActivity(activity, () => {
      uuid(grantId);
      const changed = this.#db.prepare(`UPDATE memory_discovery_grants SET state='revoked'
        WHERE grant_id=? AND owner_id=? AND session_id=? AND state='active'`)
        .run(grantId, this.#binding.ownerId, this.#binding.sessionId);
      check(changed.changes === 1, 'discovery-not-authorized');
    });
  }

  #discoveryTaskCompleted(intentId: string): boolean {
    return Boolean(this.#db.prepare(`SELECT 1 FROM intent_events
      WHERE session_id=? AND branch_id=? AND intent_id=? AND status='completed' LIMIT 1`)
      .get(this.#binding.sessionId, this.#binding.branchId, intentId));
  }

  #discoveryProjects(activity: Activity, grantId: string): { projects: string[]; remaining: number; remainingBytes: number;
    remainingQueries: number; targets: Map<string, SearchTarget> } {
    uuid(grantId);
    const row = this.#db.prepare('SELECT * FROM memory_discovery_grants WHERE grant_id=? AND owner_id=? AND session_id=?')
      .get(grantId, this.#binding.ownerId, this.#binding.sessionId);
    check(row?.state === 'active', 'discovery-not-authorized');
    const intent = this.readIntent(activity);
    check(intent?.status === 'active' && intent.intentId === row.intent_id
      && !this.#discoveryTaskCompleted(intent.intentId)
      && sha256(String(row.consent)) === row.consent_hash, 'discovery-not-authorized');
    const consent = JSON.parse(String(row.consent)) as SourceAck;
    const approval = this.#readDiscoveryApproval(consent, intent);
    const projects = this.#db.prepare(`SELECT m.project_id FROM memory_discovery_projects m
      JOIN projects p ON p.project_id=m.project_id AND p.owner_id=? WHERE m.grant_id=? ORDER BY m.project_id`)
      .all(this.#binding.ownerId, grantId).map(project => String(project.project_id));
    check(projects.length > 0 && projects.length <= 32
      && JSON.stringify([...approval.projectIds].sort()) === JSON.stringify(projects)
      && approval.maxResults === row.max_results && approval.maxBytes === row.max_bytes
      && row.max_queries === Math.min(128, Math.max(8, approval.maxResults * 4)), 'discovery-not-authorized');
    const targets = new Map<string, SearchTarget>();
    for (const item of this.#db.prepare('SELECT * FROM memory_discovery_targets WHERE grant_id=?').all(grantId)) {
      check(projects.includes(String(item.project_id)), 'discovery-not-authorized');
      targets.set(String(item.project_id), {
        ...(item.agent === null ? {} : { agent: String(item.agent) }),
        ...(item.platform === null ? {} : { platform: String(item.platform) }),
        ...(item.component === null ? {} : { component: String(item.component) }),
      });
    }
    for (const projectId of projects) for (const key of ['agent','platform','component'] as const) {
      check((targets.get(projectId)?.[key] ?? null) === (approval.targets[projectId]?.[key] ?? null), 'discovery-not-authorized');
    }
    return { projects, targets, remaining: Number(row.max_results) - Number(row.used_results),
      remainingBytes: Number(row.max_bytes) - Number(row.used_bytes),
      remainingQueries: Number(row.max_queries) - Number(row.used_queries) };
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
        && ['session','job','maintenance','migration'].includes(owner.kind), 'invalid-stream-owner');
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

  // --- I11/T06 request ledger: durable, recoverable request facts. ----------------
  // Content stays in the owner source archive; these rows hold only the frozen
  // references, hashes, budgets and states. Receipts are log-only (Ticket 09 §14).

  #requestEvent(runId: string, kind: RequestEventKind, attemptId: string | null, payload: string, activityId: string): RequestEvent {
    const seq = Number(this.#db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM request_events WHERE run_id=?').get(runId)!.seq);
    const eventId = randomUUID();
    const createdAt = new Date().toISOString();
    const hash = sha256(payload);
    this.#db.prepare('INSERT INTO request_events VALUES (?,?,?,?,?,?,?,?,?)')
      .run(eventId, runId, seq, kind, attemptId, activityId, createdAt, payload, hash);
    return { eventId, runId, seq, kind, attemptId, activityId, createdAt, payload, hash };
  }

  #requestRun(activity: Activity, runId: string): RequestRun {
    uuid(runId);
    const row = this.#db.prepare('SELECT * FROM request_runs WHERE run_id=?').get(runId);
    check(row, 'unknown-run');
    check(row.stream_id === activity.streamId, 'request-scope-mismatch');
    const budget = JSON.parse(String(row.budget)) as ProbeBudget;
    validateBudget(budget);
    return {
      runId, streamId: String(row.stream_id), ownerKind: String(row.owner_kind) as RequestRun['ownerKind'],
      ownerId: String(row.owner_id), authorizationId: String(row.authorization_id), activityId: String(row.activity_id),
      epoch: Number(row.epoch), budget, intent: row.intent_event_id ? { eventId: String(row.intent_event_id), hash: String(row.intent_hash) } : null,
      relatedRunId: row.related_run_id ? String(row.related_run_id) : null,
      authorizedAt: String(row.authorized_at), state: String(row.state) as RequestRun['state'],
    };
  }

  #requestAssembly(row: Record<string, unknown>): RequestAssembly {
    return {
      assemblyId: String(row.assembly_id), runId: String(row.run_id), epoch: Number(row.epoch),
      route: String(row.route), model: String(row.model), policyHash: String(row.policy_hash),
      estimator: String(row.estimator) as RequestAssembly['estimator'], identityHash: String(row.identity_hash),
      payloadHash: String(row.payload_hash), byteLength: Number(row.byte_length),
      estimatedTokens: Number(row.estimated_tokens), budget: JSON.parse(String(row.budget)),
      sources: JSON.parse(String(row.sources)),
      intent: row.intent_event_id ? { eventId: String(row.intent_event_id), hash: String(row.intent_hash) } : null,
      zones: JSON.parse(String(row.zones)), selection: JSON.parse(String(row.selection)),
      degradation: String(row.degradation) as RequestAssembly['degradation'],
    };
  }

  #requestAttempt(row: Record<string, unknown>, run: RequestRun): RequestAttempt {
    return {
      attemptId: String(row.attempt_id), runId: String(row.run_id), streamId: run.streamId,
      ownerKind: run.ownerKind, ownerId: run.ownerId, assemblyId: String(row.assembly_id),
      ordinal: Number(row.ordinal), payloadHash: String(row.payload_hash), byteLength: Number(row.byte_length),
      encoding: String(row.encoding) as RequestAttempt['encoding'],
      hashAlgorithm: String(row.hash_algorithm) as RequestAttempt['hashAlgorithm'],
      adapterVersion: String(row.adapter_version), startedAt: String(row.started_at),
      finishedAt: row.finished_at ? String(row.finished_at) : null,
      outcome: String(row.outcome) as RequestAttempt['outcome'],
    };
  }

  #requestRecoveryGate(activity: Activity, relatedRunId: string | null, currentRunId?: string): void {
    const stream = this.#readStream(activity.streamId);
    // An unrelated session or already-open run must not bypass an unresolved
    // request in the same principal/project. An explicit recovery successor
    // consumes that recovery decision; any unknown in the successor blocks again.
    const blockers = this.#db.prepare(`SELECT DISTINCT r.run_id FROM request_runs r
      JOIN execution_streams s ON s.stream_id=r.stream_id
      WHERE s.project_id=? AND s.principal_id=? AND r.run_id!=?
      AND (EXISTS(SELECT 1 FROM request_attempts a WHERE a.run_id=r.run_id AND a.outcome='unknown-sent')
        OR EXISTS(SELECT 1 FROM request_events e WHERE e.run_id=r.run_id AND e.kind='run-recovery-gap')
        OR (EXISTS(SELECT 1 FROM request_events e WHERE e.run_id=r.run_id AND e.kind='agent/event@v1')
          AND (NOT EXISTS(SELECT 1 FROM request_events e WHERE e.run_id=r.run_id AND e.kind='agent/event@v1' AND json_extract(e.payload,'$.event.kind')='terminal')
            OR EXISTS(SELECT 1 FROM request_events e WHERE e.run_id=r.run_id AND e.kind='agent/event@v1' AND json_extract(e.payload,'$.event.result.outcome')='unknown'))))
      AND NOT EXISTS(SELECT 1 FROM request_runs child WHERE child.related_run_id=r.run_id)`)
      .all(stream.projectId, stream.principalId, currentRunId ?? '');
    check(blockers.every(row => row.run_id === relatedRunId), 'request-recovery-required');
  }

  authorizeRequestRun(activity: Activity, runId: string, input: { budget: ProbeBudget; intent: { eventId: string; hash: string } | null; relatedRunId: string | null; acceptDuplicateRisk?: boolean }): RequestRun {
    return this.withActivity(activity, () => {
      uuid(runId);
      validateBudget(input.budget);
      if (input.relatedRunId) {
        uuid(input.relatedRunId);
        const previous = this.requestStatus(activity, input.relatedRunId);
        check(previous.sealed, 'recovery-run-not-sealed');
        check(!this.#db.prepare('SELECT 1 FROM request_runs WHERE related_run_id=?').get(input.relatedRunId), 'recovery-already-authorized');
        const runtimeEvents = previous.events.filter(event => event.kind === 'agent/event@v1').map(event => JSON.parse(event.payload).event as AgentEvent);
        const runtime = runtimeEvents.length ? replayAgent(runtimeEvents, previous.attempts.length) : null;
        const settledRuntime = runtime?.terminal && runtime.tools.every(tool => tool.result && tool.result.outcome !== 'unknown')
          && previous.attempts.every(attempt => attempt.outcome !== 'unknown-sent');
        const unresolved = !settledRuntime && (Boolean(runtime && (!runtime.terminal || runtime.tools.some(tool => !tool.result || tool.result.outcome === 'unknown')))
          || previous.attempts.some(attempt => attempt.outcome === 'received' || (attempt.outcome === 'unknown-sent'
          && !previous.events.some(event => event.attemptId === attempt.attemptId && event.kind === 'model/request-attempt-reconciled@v1'
            && (JSON.parse(event.payload) as { evidence: { outcome: string } }).evidence.outcome === 'not-received'))));
        check((!unresolved && !previous.events.some(event => event.kind === 'run-recovery-gap'))
          || input.acceptDuplicateRisk === true, 'duplicate-risk-approval-required');
        this.#verifyRequestSources(previous.assemblies);
      }
      this.#requestRecoveryGate(activity, input.relatedRunId);
      if (input.intent) { uuid(input.intent.eventId); check(input.intent.hash.length === 64, 'invalid-intent-ref'); }
      const stream = this.#readStream(activity.streamId);
      check(!this.#db.prepare('SELECT 1 FROM request_runs WHERE run_id=?').get(runId), 'run-identity-conflict');
      const authorizedAt = new Date().toISOString();
      this.#db.prepare('INSERT INTO request_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(runId, stream.streamId, stream.ownerKind, stream.ownerId, stream.authorization.id, activity.id,
          activity.epoch, JSON.stringify(input.budget), input.intent?.eventId ?? null, input.intent?.hash ?? null,
          input.relatedRunId, authorizedAt, 'authorized');
      this.#requestEvent(runId, 'run-authorized', null, JSON.stringify({ schema: 'run-authorized@1', runId,
        streamId: stream.streamId, ownerKind: stream.ownerKind, ownerId: stream.ownerId,
        authorizationId: stream.authorization.id, activityId: activity.id, epoch: activity.epoch,
        budget: input.budget, intent: input.intent, relatedRunId: input.relatedRunId,
        acceptDuplicateRisk: input.acceptDuplicateRisk === true, authorizedAt }), activity.id);
      return this.#requestRun(activity, runId);
    });
  }

  appendRequestAssembly(activity: Activity, input: RequestAssemblyInput): RequestAssembly {
    return this.withActivity(activity, () => {
      const run = this.#requestRun(activity, input.runId);
      check(run.state === 'authorized' && run.epoch === activity.epoch, 'run-not-admissible');
      check(input.degradation === 'none' && input.estimator === 'utf8-bytes-upper-bound@1'
        && input.route.length > 0 && input.model.length > 0 && input.policyHash.length === 64
        && input.sources.length > 0 && input.sources.every(source => source.schema === 'cli-source-ack@1' && source.status === 'durable')
        && input.selection.length === input.sources.length, 'invalid-assembly');
      validateBudget(input.budget);
      check(Object.entries(run.budget).every(([key, value]) => input.budget[key as keyof ProbeBudget] === value), 'assembly-budget-mismatch');
      check(input.epoch === run.epoch, 'assembly-epoch-mismatch');
      check(input.selection.every((item, index) => item.ordinal === index && item.hash === input.sources[index]?.hash
        && item.reason === 'mandatory-source'), 'invalid-assembly-selection');
      const frozen = freezeRequestPayload(input.payload);
      check(frozen.payloadHash === input.payloadHash && frozen.byteLength === input.byteLength
        && input.byteLength > 0 && input.estimatedTokens === input.byteLength, 'payload-freeze-mismatch');
      const identityHash = assemblyIdentityHash(input);
      const existing = this.#db.prepare('SELECT * FROM request_assemblies WHERE run_id=? AND identity_hash=?')
        .get(input.runId, identityHash);
      if (existing) {
        check(existing.payload_hash === input.payloadHash && existing.byte_length === input.byteLength
          && existing.epoch === input.epoch && existing.route === input.route && existing.model === input.model
          && existing.policy_hash === input.policyHash && existing.estimator === input.estimator
          && existing.estimated_tokens === input.estimatedTokens && existing.budget === JSON.stringify(input.budget)
          && existing.sources === JSON.stringify(input.sources)
          && existing.intent_event_id === (input.intent?.eventId ?? null)
          && existing.intent_hash === (input.intent?.hash ?? null)
          && existing.zones === JSON.stringify(input.zones) && existing.selection === JSON.stringify(input.selection)
          && existing.degradation === input.degradation, 'assembly-identity-conflict');
        return this.#requestAssembly(existing);
      }
      const assemblyId = randomUUID();
      this.#db.prepare('INSERT INTO request_assemblies VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(assemblyId, input.runId, input.epoch, input.route, input.model, input.policyHash, input.estimator,
          identityHash, input.payloadHash, input.byteLength, input.estimatedTokens, JSON.stringify(input.budget),
          JSON.stringify(input.sources), input.intent?.eventId ?? null, input.intent?.hash ?? null,
          JSON.stringify(input.zones), JSON.stringify(input.selection), input.degradation, 'not-dispatched');
      this.#requestEvent(input.runId, 'context/assembly@v1', null, JSON.stringify({
        schema: 'context/assembly@v1', assemblyId, runId: input.runId, epoch: input.epoch, route: input.route,
        model: input.model, policyHash: input.policyHash, estimator: input.estimator, payloadHash: input.payloadHash,
        byteLength: input.byteLength, estimatedTokens: input.estimatedTokens, budget: input.budget,
        zones: input.zones, selection: input.selection,
        sources: input.sources.map(source => ({ eventId: source.eventId, hash: source.hash })),
        intent: input.intent, degradation: input.degradation,
      }), activity.id);
      return this.#requestAssembly(this.#db.prepare('SELECT * FROM request_assemblies WHERE assembly_id=?').get(assemblyId)!);
    });
  }

  revokeRequestRun(activity: Activity, runId: string): RequestRun {
    return this.withActivity(activity, () => {
      const run = this.#requestRun(activity, runId);
      if (run.state === 'revoked') return run;
      check(run.state === 'authorized', 'run-sealed');
      this.#db.prepare("UPDATE request_runs SET state='revoked' WHERE run_id=?").run(runId);
      this.#requestEvent(runId, 'run-revoked', null, JSON.stringify({ schema: 'run-revoked@1', runId,
        activityId: activity.id, revokedAt: new Date().toISOString() }), activity.id);
      return this.#requestRun(activity, runId);
    });
  }

  sealRequestRun(activity: Activity, runId: string): RequestRun {
    return this.withActivity(activity, () => {
      const run = this.#requestRun(activity, runId);
      if (run.state === 'sealed') return run;
      this.#db.prepare("UPDATE request_runs SET state='sealed' WHERE run_id=?").run(runId);
      this.#requestEvent(runId, 'run-sealed', null, JSON.stringify({ schema: 'run-sealed@1', runId,
        activityId: activity.id, sealedAt: new Date().toISOString() }), activity.id);
      return this.#requestRun(activity, runId);
    });
  }

  startRequestAttempt(activity: Activity, input: { runId: string; assemblyId: string; payloadHash: string; byteLength: number; adapterVersion: string }): RequestAttempt {
    return this.withActivity(activity, () => {
      const run = this.#requestRun(activity, input.runId);
      check(run.state === 'authorized' && run.epoch === activity.epoch, 'run-not-admissible');
      uuid(input.assemblyId);
      check(input.payloadHash.length === 64 && input.byteLength > 0 && input.adapterVersion.length > 0, 'invalid-attempt');
      const status = this.requestStatus(activity, input.runId);
      this.#requestRecoveryGate(activity, status.run.relatedRunId, input.runId);
      const currentIntent = this.readIntent(activity);
      const frozenAssembly = status.assemblies.find(item => item.assemblyId === input.assemblyId);
      check(frozenAssembly && currentIntent?.eventId === frozenAssembly.intent?.eventId
        && currentIntent?.hash === frozenAssembly.intent?.hash && currentIntent?.status === 'active', 'intent-stale');
      this.#verifyRequestSources([frozenAssembly]);
      const assembly = this.#db.prepare('SELECT * FROM request_assemblies WHERE assembly_id=? AND run_id=?')
        .get(input.assemblyId, input.runId);
      check(assembly, 'unknown-assembly');
      const attempts = Number(this.#db.prepare('SELECT COUNT(*) AS n FROM request_attempts WHERE run_id=?').get(input.runId)!.n);
      check(attempts < run.budget.maxModelAttempts, 'attempt-budget-exhausted');
      const usedTokens = Number(this.#db.prepare('SELECT COALESCE(SUM(byte_length),0) AS n FROM request_attempts WHERE run_id=?').get(input.runId)!.n);
      const reserved = input.byteLength + run.budget.outputReserve + run.budget.safetyMargin;
      check(reserved <= run.budget.contextLimit, 'context-budget-exhausted');
      check(usedTokens + attempts * (run.budget.outputReserve + run.budget.safetyMargin) + reserved <= run.budget.maxTotalTokens, 'token-budget-exhausted');
      check(!this.#db.prepare("SELECT 1 FROM request_attempts WHERE run_id=? AND outcome='unknown-sent'").get(input.runId), 'unknown-attempt-requires-reconciliation');
      check(assembly.payload_hash === input.payloadHash && assembly.byte_length === input.byteLength, 'attempt-payload-mismatch');
      // Admission linearization point: the attempt/activity registration commits
      // atomically with the re-verified authorization snapshot (Ticket 09 §15a).
      const ownership = this.bindAttempt(activity, input.runId);
      const ordinal = Number(this.#db.prepare('SELECT COUNT(*) AS n FROM request_attempts WHERE assembly_id=?')
        .get(input.assemblyId)!.n) + 1;
      const startedAt = new Date().toISOString();
      this.#db.prepare('INSERT INTO request_attempts VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(ownership.attemptId, input.assemblyId, input.runId, ordinal, input.payloadHash, input.byteLength,
          REQUEST_ENCODING, REQUEST_HASH_ALGORITHM, input.adapterVersion, startedAt, null, 'unknown-sent');
      this.#db.prepare("UPDATE request_assemblies SET state='unknown-sent' WHERE assembly_id=?").run(input.assemblyId);
      this.#requestEvent(input.runId, 'model/request-attempt-started@v1', ownership.attemptId, JSON.stringify({
        schema: 'model/request-attempt-started@v1', attemptId: ownership.attemptId, runId: input.runId,
        assemblyId: input.assemblyId, ordinal, route: String(assembly.route), model: String(assembly.model),
        payloadHash: input.payloadHash, byteLength: input.byteLength, encoding: REQUEST_ENCODING,
        hashAlgorithm: REQUEST_HASH_ALGORITHM, adapterVersion: input.adapterVersion, startedAt,
      }), activity.id);
      return this.#requestAttempt(this.#db.prepare('SELECT * FROM request_attempts WHERE attempt_id=?').get(ownership.attemptId)!, run);
    });
  }

  assertDispatchBoundary(): void {
    check(this.#depth === 0, 'dispatch-inside-transaction');
  }

  requestMaySend(activity: Activity, runId: string): boolean {
    return this.withActivity(activity, () => {
      const status = this.requestStatus(activity, runId);
      this.#verifyRequestSources(status.assemblies);
      const attempt = status.attempts.find(item => item.outcome === 'unknown-sent');
      const assembly = status.assemblies.find(item => item.assemblyId === attempt?.assemblyId);
      const currentIntent = this.readIntent(activity);
      return status.run.state === 'authorized' && status.run.epoch === activity.epoch
        && Boolean(assembly && currentIntent?.status === 'active'
          && currentIntent.eventId === assembly.intent?.eventId && currentIntent.hash === assembly.intent?.hash);
    });
  }

  finishRequestAttempt(activity: Activity, input: { attemptId: string; outcome: 'received' | 'cancelled-before-send'; usage?: { count: number; inputTokens?: number; outputTokens?: number; modelHash?: string; finishReason?: string } | null }): RequestAttempt {
    return this.withActivity(activity, () => {
      uuid(input.attemptId);
      check(input.outcome === 'received' || input.outcome === 'cancelled-before-send', 'invalid-attempt-outcome');
      if (input.usage) {
        check(Number.isSafeInteger(input.usage.count) && input.usage.count > 0, 'invalid-usage');
        for (const value of [input.usage.inputTokens, input.usage.outputTokens]) check(value === undefined || (Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000), 'invalid-usage');
        check(input.usage.modelHash === undefined || /^[0-9a-f]{64}$/.test(input.usage.modelHash), 'invalid-model-hash');
        check(input.usage.finishReason === undefined || ['end', 'tools', 'length', 'error'].includes(input.usage.finishReason), 'invalid-finish-reason');
      }
      const row = this.#db.prepare('SELECT * FROM request_attempts WHERE attempt_id=?').get(input.attemptId);
      check(row, 'unknown-attempt');
      const run = this.#requestRun(activity, String(row.run_id));
      const status = this.requestStatus(activity, run.runId);
      this.#verifyRequestSources(status.assemblies.filter(item => item.assemblyId === row.assembly_id));
      const ownership = this.#db.prepare("SELECT activity_id FROM execution_events WHERE attempt_id=? AND kind='attempt-bound'")
        .get(input.attemptId);
      check(ownership?.activity_id === activity.id, 'attempt-owner-mismatch');
      check(row.outcome === 'unknown-sent', 'attempt-settled-or-unknown');
      const finishedAt = new Date().toISOString();
      this.#db.prepare('UPDATE request_attempts SET outcome=?, finished_at=? WHERE attempt_id=?')
        .run(input.outcome, finishedAt, input.attemptId);
      const outcomes = this.#db.prepare('SELECT outcome FROM request_attempts WHERE assembly_id=? ORDER BY ordinal')
        .all(String(row.assembly_id)).map(attempt => ({ outcome: String(attempt.outcome) as RequestAttempt['outcome'] }));
      this.#db.prepare('UPDATE request_assemblies SET state=? WHERE assembly_id=?')
        .run(deriveAssemblyState(outcomes), String(row.assembly_id));
      this.#requestEvent(String(row.run_id), 'model/request-attempt-finished@v1', input.attemptId, JSON.stringify({
        schema: 'model/request-attempt-finished@v1', attemptId: input.attemptId, runId: String(row.run_id),
        assemblyId: String(row.assembly_id), ordinal: Number(row.ordinal), outcome: input.outcome,
        finishedAt, usage: input.usage ?? null,
      }), activity.id);
      return this.#requestAttempt(this.#db.prepare('SELECT * FROM request_attempts WHERE attempt_id=?').get(input.attemptId)!,
        this.#requestRun(activity, String(row.run_id)));
    });
  }

  #verifyRequestSources(assemblies: RequestAssembly[]): void {
    for (const assembly of assemblies) for (const source of assembly.sources) this.#validateSource(source);
  }

  reconcileRequestAttempt(activity: Activity, attemptId: string): RequestStatus {
    return this.withActivity(activity, () => {
      uuid(attemptId);
      const row = this.#db.prepare('SELECT run_id FROM request_attempts WHERE attempt_id=?').get(attemptId);
      check(row, 'unknown-attempt');
      const status = this.requestStatus(activity, String(row.run_id));
      const attempt = status.attempts.find(attempt => attempt.attemptId === attemptId);
      check(attempt?.outcome === 'unknown-sent', 'attempt-not-unknown');
      check(this.#queryRequest, 'reconciliation-reader-unavailable');
      const owner = this.#db.prepare(`SELECT a.pid FROM execution_events e JOIN owner_activities a ON a.id=e.activity_id
        WHERE e.attempt_id=? AND e.kind='attempt-bound'`).get(attemptId);
      // Establish absence before reading the receiver, so a final send between
      // an empty observation and process exit cannot be mistaken for absence.
      const senderAbsent = Boolean(owner?.pid && processAbsent(Number(owner.pid)));
      const evidence = this.#queryRequest(attempt);
      check(evidence.attemptId === attemptId && evidence.runId === attempt.runId
        && evidence.payloadHash === attempt.payloadHash && evidence.byteLength === attempt.byteLength
        && /^[0-9a-f]{64}$/.test(evidence.receiptHash)
        && ['received', 'not-received'].includes(evidence.outcome), 'invalid-reconciliation-evidence');
      if (evidence.outcome === 'not-received') check(senderAbsent, 'attempt-owner-still-live');
      this.#verifyRequestSources(status.assemblies);
      check(!status.events.some(event => event.attemptId === attemptId && event.kind === 'model/request-attempt-reconciled@v1'), 'attempt-already-reconciled');
      this.#requestEvent(status.run.runId, 'model/request-attempt-reconciled@v1', attemptId, JSON.stringify({
        schema: 'model/request-attempt-reconciled@v1', runId: status.run.runId, attemptId,
        evidence, reconciledAt: new Date().toISOString(),
      }), activity.id);
      return this.requestStatus(activity, status.run.runId);
    });
  }

  markRequestRecoveryGap(activity: Activity, runId: string): void {
    this.withActivity(activity, () => {
      const status = this.requestStatus(activity, runId);
      if (status.events.some(event => event.kind === 'run-recovery-gap')) return;
      if (status.run.state === 'authorized') this.revokeRequestRun(activity, runId);
      this.#requestEvent(runId, 'run-recovery-gap', null, JSON.stringify({
        schema: 'run-recovery-gap@1', runId, observedAt: new Date().toISOString(),
      }), activity.id);
    });
  }

  requestStatus(activity: Activity, runId: string): RequestStatus {
    return this.withActivity(activity, () => {
      const run = this.#requestRun(activity, runId);
      const events = this.#db.prepare('SELECT * FROM request_events WHERE run_id=? ORDER BY seq').all(runId);
      const assemblies = this.#db.prepare('SELECT * FROM request_assemblies WHERE run_id=? ORDER BY rowid').all(runId);
      const attempts = this.#db.prepare('SELECT * FROM request_attempts WHERE run_id=? ORDER BY rowid').all(runId);
      check(events.length > 0 && events[0]!.kind === 'run-authorized', 'ledger-evidence-gap');
      const authorization = JSON.parse(String(events[0]!.payload));
      check(authorization.runId === run.runId && authorization.streamId === run.streamId
        && authorization.epoch === run.epoch && JSON.stringify(authorization.budget) === JSON.stringify(run.budget)
        && authorization.relatedRunId === run.relatedRunId, 'ledger-evidence-gap');
      for (const [index, row] of events.entries()) {
        check(row.seq === index + 1 && sha256(String(row.payload)) === row.hash, 'ledger-evidence-gap');
        const payload = JSON.parse(String(row.payload)) as Record<string, unknown>;
        check(payload.runId === runId, 'ledger-evidence-gap');
        if (row.kind === 'context/assembly@v1') {
          check(row.attempt_id === null && assemblies.some(assembly => assembly.assembly_id === payload.assemblyId), 'ledger-evidence-gap');
        } else if (row.kind === 'model/request-attempt-started@v1' || row.kind === 'model/request-attempt-finished@v1' || row.kind === 'model/request-attempt-reconciled@v1') {
          check(row.attempt_id === payload.attemptId && attempts.some(attempt => attempt.attempt_id === row.attempt_id), 'ledger-evidence-gap');
        } else check(row.attempt_id === null, 'ledger-evidence-gap');
      }
      const startedEvents = new Set(events.filter(row => row.kind === 'model/request-attempt-started@v1').map(row => String(row.attempt_id)));
      const finishedEvents = new Set(events.filter(row => row.kind === 'model/request-attempt-finished@v1').map(row => String(row.attempt_id)));
      const assemblyEvents = new Set(events.filter(row => row.kind === 'context/assembly@v1')
        .map(row => (JSON.parse(String(row.payload)) as { assemblyId: string }).assemblyId));
      check(assemblyEvents.size === assemblies.length
        && assemblies.every(assembly => assemblyEvents.has(String(assembly.assembly_id))), 'ledger-evidence-gap');
      check((run.state === 'authorized') === !events.some(row => row.kind === 'run-revoked' || row.kind === 'run-sealed'), 'ledger-evidence-gap');
      check(run.state !== 'revoked' || events.some(row => row.kind === 'run-revoked'), 'ledger-evidence-gap');
      check(run.state !== 'sealed' || events.some(row => row.kind === 'run-sealed'), 'ledger-evidence-gap');
      for (const assembly of assemblies) {
        const decodedAssembly = this.#requestAssembly(assembly);
        check(assemblyIdentityHash(decodedAssembly) === assembly.identity_hash, 'ledger-evidence-gap');
        const receipt = events.find(event => event.kind === 'context/assembly@v1'
          && (JSON.parse(String(event.payload)) as { assemblyId: string }).assemblyId === assembly.assembly_id);
        check(receipt, 'ledger-evidence-gap');
        const assemblyPayload = JSON.parse(String(receipt.payload));
        for (const key of ['runId', 'epoch', 'route', 'model', 'policyHash', 'estimator', 'payloadHash', 'byteLength',
          'estimatedTokens', 'budget', 'zones', 'selection', 'intent', 'degradation'] as const) {
          check(JSON.stringify(assemblyPayload[key]) === JSON.stringify(decodedAssembly[key]), 'ledger-evidence-gap');
        }
        check(JSON.stringify(assemblyPayload.sources) === JSON.stringify(decodedAssembly.sources.map(source => ({ eventId: source.eventId, hash: source.hash }))), 'ledger-evidence-gap');
        const assemblyAttempts = attempts.filter(attempt => attempt.assembly_id === assembly.assembly_id);
        for (const [index, attempt] of assemblyAttempts.entries()) {
          check(attempt.ordinal === index + 1 && attempt.payload_hash === assembly.payload_hash
            && attempt.byte_length === assembly.byte_length, 'ledger-evidence-gap');
          check(startedEvents.has(String(attempt.attempt_id)), 'ledger-evidence-gap');
          const startedPayload = JSON.parse(String(events.find(event => event.kind === 'model/request-attempt-started@v1'
            && event.attempt_id === attempt.attempt_id)!.payload));
          check(startedPayload.payloadHash === attempt.payload_hash && startedPayload.byteLength === attempt.byte_length
            && startedPayload.assemblyId === assembly.assembly_id && startedPayload.ordinal === attempt.ordinal
            && startedPayload.route === assembly.route && startedPayload.model === assembly.model, 'ledger-evidence-gap');
          const finished = events.find(event => event.kind === 'model/request-attempt-finished@v1' && event.attempt_id === attempt.attempt_id);
          if (finished) check(JSON.parse(String(finished.payload)).outcome === attempt.outcome, 'ledger-evidence-gap');
          check((attempt.outcome === 'unknown-sent') === !finishedEvents.has(String(attempt.attempt_id)), 'ledger-evidence-gap');
        }
        check(assembly.state === deriveAssemblyState(assemblyAttempts
          .map(attempt => ({ outcome: String(attempt.outcome) as RequestAttempt['outcome'] }))), 'ledger-evidence-gap');
      }
      for (const attempt of attempts) check(assemblies.some(assembly => assembly.assembly_id === attempt.assembly_id), 'ledger-evidence-gap');
      return {
        run,
        events: events.map(row => ({ eventId: String(row.event_id), runId, seq: Number(row.seq),
          kind: String(row.kind) as RequestEventKind, attemptId: row.attempt_id ? String(row.attempt_id) : null,
          activityId: String(row.activity_id), createdAt: String(row.created_at),
          payload: String(row.payload), hash: String(row.hash) })),
        assemblies: assemblies.map(row => ({ ...this.#requestAssembly(row), state: String(row.state) as RequestStatus['assemblies'][number]['state'] })),
        attempts: attempts.map(row => this.#requestAttempt(row, run)),
        revoked: run.state === 'revoked', sealed: run.state === 'sealed',
      };
    });
  }
  assertToolAdmission(activity: Activity, runId: string): void {
    this.withActivity(activity, () => {
      const ledger = this.requestStatus(activity, runId);
      check(ledger.run.activityId === activity.id && ledger.run.state === 'authorized', 'run-not-admissible');
      this.#requestRecoveryGate(activity, ledger.run.relatedRunId, runId);
      this.#verifyRequestSources(ledger.assemblies);
      const assembly = ledger.assemblies.at(-1);
      const intent = this.readIntent(activity);
      check(assembly && intent?.status === 'active' && intent.eventId === assembly.intent?.eventId && intent.hash === assembly.intent.hash, 'intent-stale');
      check(Date.now() - Date.parse(ledger.run.authorizedAt) < ledger.run.budget.wallClockMs, 'run-deadline');
    });
  }
  appendAgentEvent(activity: Activity, runId: string, event: AgentEvent): AgentStatus {
    return this.withActivity(activity, () => {
      const ledger = this.requestStatus(activity, runId);
      check(ledger.run.activityId === activity.id, 'agent-owner-mismatch');
      if (event.kind === 'tool-started' || event.kind === 'file-prepared' || event.kind === 'file-approved') this.assertToolAdmission(activity, runId);
      const events = ledger.events.filter(item => item.kind === 'agent/event@v1')
        .map(item => JSON.parse(item.payload).event as AgentEvent);
      const result = replayAgent([...events, event], ledger.attempts.length);
      if ('source' in event) this.#validateSource(event.source);
      if (event.kind === 'opened' && event.files) this.#validateSource(event.files.source);
      if (event.kind === 'file-prepared') this.#validateSource(event.admission.source);
      if (event.kind === 'tool-result') this.#validateSource(event.result.source);
      if (event.kind === 'response') check(ledger.attempts.some(attempt => attempt.attemptId === event.attemptId && attempt.outcome === 'received'), 'response-not-received');
      this.#requestEvent(runId, 'agent/event@v1', null, JSON.stringify({ runId, event }), activity.id);
      return result;
    });
  }

  agentStatus(activity: Activity, runId: string): AgentStatus {
    const ledger = this.requestStatus(activity, runId);
    return replayAgent(ledger.events.filter(item => item.kind === 'agent/event@v1')
      .map(item => JSON.parse(item.payload).event as AgentEvent), ledger.attempts.length);
  }

  bindAttempt(activity: Activity, runId: string): AttemptOwnership {
    return this.withActivity(activity, () => {
      uuid(runId);
      const stream = this.#readStream(activity.streamId);
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
      // Ordinary maintenance workers obey this same open-fence/epoch gate.
      // Exclusive coordinators remain fenced; owner kind never bypasses it.
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
      if (snapshot.status === 'completed') this.#db.prepare(`UPDATE memory_discovery_grants SET state='revoked'
        WHERE session_id=? AND intent_id=? AND state='active'`).run(this.#binding.sessionId, snapshot.intentId);
      return { ...snapshot, hash };
    });
  }

  captureMemory(activity: Activity, input: SourceAck, content: string, options: MemoryCaptureOptions): MemoryOperation {
    return this.withActivity(activity, () => {
      check(Object.keys(options).every(key => ['type','scope','appliesTo','claimKey','validFrom','validUntil'].includes(key)), 'invalid-memory-options');
      const scope = this.#validateScope(options.scope);
      this.#validateSource(input, content, scope);
      const validFrom = options.validFrom ?? null, validUntil = options.validUntil ?? null;
      for (const value of [validFrom, validUntil]) if (value !== null) {
        check(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
          && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value, 'invalid-memory-validity');
      }
      check(!validFrom || !validUntil || validFrom < validUntil, 'invalid-memory-validity');
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
          && existing.valid_from === validFrom && existing.valid_until === validUntil
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
        verification: 'unverified' as const, scope, appliesTo, source: structuredClone(input), validFrom, validUntil,
        conflictSetId: null, verificationRunId: null, headEventId: eventId };
      const record = this.#withMemoryHash(base);
      this.#db.prepare('INSERT INTO memory_records VALUES (?, ?, ?, ?, ?)')
        .run(recordId, this.#binding.ownerId, claimKey, input.binding.sessionId, new Date().toISOString());
      this.#insertRevision(record);
      const capturePayload = JSON.stringify({ schema: 'capture-job@1', source: input, recordId });
      this.#db.prepare('INSERT INTO capture_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), input.eventId, recordId, 'complete', capturePayload, sha256(capturePayload), new Date().toISOString(), input.binding.sessionId);
      this.#appendMemoryEvent(null, record, 'capture', input.eventId, { automatic: true },
        this.#requestDigest('capture', null, { input, content, scope, type: options.type, appliesTo, claimKey, validFrom, validUntil }));
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
        WHERE j.kind='search' AND p.job_id IS NULL AND j.owner_id=? AND ${this.#visibleScopeSql('j')}
        ORDER BY j.rowid LIMIT ?`).all(this.#binding.ownerId, ...this.#scopeParameters(), limit);
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
        const exposure = memoryProjectionExposure(record);
        const old = this.#db.prepare('SELECT rowid FROM search_documents WHERE unit_id=?').get(record.recordId);
        if (old) this.#db.prepare('DELETE FROM search_fts WHERE rowid=?').run(Number(old.rowid));
        this.#db.prepare('DELETE FROM search_documents WHERE unit_id=?').run(record.recordId);
        if (exposure) {
          const indexed = `${normalizeSearchText(record.content)} ${cjkBigrams(record.content)}`.trim();
          this.#db.prepare(`INSERT INTO search_documents
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(record.recordId, this.#binding.ownerId, record.recordId, record.revisionId,
            record.source.binding.projectId, record.scope.kind, record.scope.id, record.lifecycle, record.verification, exposure, indexed,
            record.contentHash, record.revision, 'latin-cjk@3', generation);
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
      const canonical = this.#db.prepare(`SELECT record_id FROM memory_heads
        WHERE ${this.#visibleScopeSql('memory_heads')}`).all(...this.#scopeParameters());
      this.#db.prepare(`DELETE FROM search_documents WHERE (owner_id=? AND ${this.#visibleScopeSql('search_documents')})
        OR EXISTS (SELECT 1 FROM memory_heads h JOIN memory_records r ON r.record_id=h.record_id
          WHERE h.record_id=search_documents.record_id AND r.owner_id=? AND ${this.#visibleScopeSql('h')})`)
        .run(this.#binding.ownerId, ...this.#scopeParameters(), this.#binding.ownerId, ...this.#scopeParameters());
      const receipts: SearchProjectionReceipt[] = [];
      for (const row of canonical) {
        const record = this.#readMemoryUnsafe(String(row.record_id));
        const exposure = memoryProjectionExposure(record);
        if (!exposure) continue;
        const indexed = `${normalizeSearchText(record.content)} ${cjkBigrams(record.content)}`.trim();
        const generation = record.revision;
        this.#db.prepare(`INSERT INTO search_documents VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(record.recordId, this.#binding.ownerId,
          record.recordId, record.revisionId, record.source.binding.projectId, record.scope.kind, record.scope.id, record.lifecycle,
          record.verification, exposure, indexed, record.contentHash, record.revision, 'latin-cjk@3', generation);
        receipts.push({ jobId: '', eventId: record.headEventId, status: 'done', generation, reason: 'rebuild' });
      }
      this.#db.exec(`DROP TABLE search_fts;
        CREATE VIRTUAL TABLE search_fts USING fts5(content, content='search_documents', content_rowid='rowid');
        INSERT INTO search_fts(search_fts) VALUES ('rebuild');`);
      return receipts;
    });
  }

  searchMemories(activity: Activity, request: SearchRequest): SearchPage {
    return this.withActivity(activity, () => {
      check(request && typeof request === 'object' && Object.keys(request).every(key =>
        ['query','limit','byteBudget','cursor','grantId','target','noActiveProject'].includes(key)), 'invalid-search-request');
      check(request.noActiveProject === undefined || request.noActiveProject === true, 'invalid-search-request');
      const limit = request.limit ?? 10;
      const byteBudget = request.byteBudget ?? 8192;
      check(Number.isSafeInteger(limit) && limit > 0 && limit <= 32, 'invalid-search-limit');
      check(Number.isSafeInteger(byteBudget) && byteBudget > 0 && byteBudget <= 65536, 'invalid-search-budget');
      check(typeof request.query === 'string' && Buffer.byteLength(request.query) <= 4096, 'invalid-search-query');
      check(request.target === undefined || validSearchTarget(request.target), 'invalid-search-target');
      const terms = searchTerms(request.query);
      const groups = searchGroups(request.query);
      const grant = request.grantId ? this.#discoveryProjects(activity, request.grantId) : null;
      check(!grant || request.target === undefined, 'invalid-search-target');
      const projects = grant?.projects ?? [this.#binding.projectId];
      const coverage: SearchPage['coverage'] = { allowedProjects: projects, inspectedProjects: [], unavailableProjects: [],
        candidateCount: null, complete: false, reason: null };
      const unavailableCoverage = (reason: string): SearchPage['coverage'] =>
        ({ ...coverage, unavailableProjects: projects, reason });
      if (!grant && request.noActiveProject) return { status: 'ready', results: [],
        coverage: { ...coverage, allowedProjects: [], inspectedProjects: [], reason: 'no-active-project' },
        truncated: false, nextCursor: null };
      if (grant) {
        if (grant.remainingQueries === 0) return { status: 'unavailable', results: [],
          coverage: unavailableCoverage('task-query-budget-exhausted'), truncated: true, nextCursor: null };
        const charged = this.#db.prepare(`UPDATE memory_discovery_grants SET used_queries=used_queries+1
          WHERE grant_id=? AND state='active' AND used_queries<max_queries`).run(request.grantId!);
        check(charged.changes === 1, 'discovery-budget-stale');
      }
      const scopeSql = this.#searchScopeSql('h', projects);
      const scopeArgs = this.#searchScopeArgs(projects);
      const sourceSql = grant ? ` AND v.source_project_id IN (${projects.map(() => '?').join(',')})` : '';
      const projectedSourceSql = grant ? ` AND d.project_id IN (${projects.map(() => '?').join(',')})` : '';
      const missing = this.#db.prepare(`SELECT 1 FROM memory_heads h JOIN memory_records r ON r.record_id=h.record_id
        JOIN memory_revisions v ON v.revision_id=h.revision_id
        LEFT JOIN search_documents d ON d.record_id=h.record_id
        WHERE r.owner_id=? AND ${scopeSql}${sourceSql} AND h.lifecycle='active' AND h.scope_resolved=1
          AND h.verification IN ('verified','stale','conflicted')
          AND (d.unit_id IS NULL OR d.owner_id!=r.owner_id OR d.project_id!=v.source_project_id
            OR d.scope_kind!=h.scope_kind OR d.scope_id!=h.scope_id OR d.content_hash!=v.content_hash
            OR d.tokenizer_version!='latin-cjk@3' OR d.source_seq!=v.revision
            OR d.exposure_mode!=CASE WHEN h.verification='verified' AND h.conflict_set_id IS NULL THEN 'normal' ELSE 'status_only' END
            OR d.revision_id!=h.revision_id OR d.lifecycle!=h.lifecycle OR d.verification!=h.verification)
        LIMIT 1`).get(this.#binding.ownerId, ...scopeArgs, ...(grant ? projects : []));
      const extra = this.#db.prepare(`SELECT 1 FROM search_documents d
        LEFT JOIN memory_heads h ON h.record_id=d.record_id
        LEFT JOIN memory_records r ON r.record_id=d.record_id
        LEFT JOIN memory_revisions v ON v.revision_id=h.revision_id
        WHERE d.owner_id=? AND ${this.#searchScopeSql('d', projects)}${projectedSourceSql}
          AND (h.record_id IS NULL OR r.record_id IS NULL OR v.revision_id IS NULL
            OR r.owner_id!=d.owner_id OR d.unit_id!=d.record_id OR d.project_id!=v.source_project_id
            OR d.scope_kind!=h.scope_kind OR d.scope_id!=h.scope_id OR d.content_hash!=v.content_hash
            OR d.tokenizer_version!='latin-cjk@3' OR d.source_seq!=v.revision
            OR d.exposure_mode!=CASE WHEN h.verification='verified' AND h.conflict_set_id IS NULL THEN 'normal' ELSE 'status_only' END
            OR h.lifecycle!='active' OR h.scope_resolved!=1 OR d.revision_id!=h.revision_id
            OR d.lifecycle!=h.lifecycle OR d.verification!=h.verification) LIMIT 1`)
        .get(this.#binding.ownerId, ...scopeArgs, ...(grant ? projects : []));
      if (missing || extra) return { status: 'dirty', results: [], coverage: unavailableCoverage('index-lag'), truncated: true, nextCursor: null };
      try { this.#db.exec("INSERT INTO search_fts(search_fts,rank) VALUES ('integrity-check',1)"); }
      catch { return { status: 'dirty', results: [], coverage: unavailableCoverage('fts-integrity-gap'), truncated: true, nextCursor: null }; }
      if (!terms.length) return { status: 'ready', results: [], coverage: { ...coverage, reason: 'unsupported-query' }, truncated: false, nextCursor: null };
      if (terms.length > 16) return { status: 'unavailable', results: [],
        coverage: unavailableCoverage('query-term-limit'), truncated: true, nextCursor: null };
      if (grant && (grant.remaining === 0 || grant.remainingBytes === 0)) return { status: 'unavailable', results: [],
        coverage: unavailableCoverage('task-budget-exhausted'), truncated: true, nextCursor: null };
      const match = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ');
      let rows: Record<string, unknown>[];
      try {
        rows = this.#db.prepare(`SELECT d.* FROM search_fts
          JOIN search_documents d ON d.rowid=search_fts.rowid
          JOIN memory_records r ON r.record_id=d.record_id
          WHERE search_fts MATCH ? AND d.owner_id=? AND ${this.#searchScopeSql('d', projects)}${projectedSourceSql}
          ORDER BY r.rowid LIMIT 257`).all(
          match, this.#binding.ownerId, ...scopeArgs, ...(grant ? projects : []));
      } catch { return { status: 'unavailable', results: [], coverage: unavailableCoverage('index-unavailable'), truncated: true, nextCursor: null }; }
      if (rows.length > 256) return { status: 'unavailable', results: [],
        coverage: unavailableCoverage('candidate-limit'), truncated: true, nextCursor: null };
      const candidates: SearchResult[] = [];
      const lanes = groups.map(() => [] as SearchResult[]);
      const seen = new Set<string>();
      const now = Date.now();
      for (const row of rows) {
        let record: MemoryRecord;
        try {
          record = this.#readMemoryUnsafe(String(row.record_id), projects);
          const exposure = memoryProjectionExposure(record);
          check(exposure && row.unit_id === record.recordId && row.revision_id === record.revisionId
            && row.scope_kind === record.scope.kind && row.scope_id === record.scope.id
            && row.project_id === record.source.binding.projectId
            && row.tokenizer_version === 'latin-cjk@3'
            && row.exposure_mode === exposure
            && String(row.content_hash) === record.contentHash
            && String(row.content) === `${normalizeSearchText(record.content)} ${cjkBigrams(record.content)}`.trim(), 'search-evidence-gap');
        } catch (error) {
          const reason = error instanceof Error && error.message === 'search-evidence-gap' ? 'search-evidence-gap' : 'canonical-evidence-gap';
          return { status: 'unavailable', results: [], coverage: unavailableCoverage(reason), truncated: true, nextCursor: null };
        }
        const words = normalizeSearchText(record.content).split(' ');
        const matchingGroups = groups.flatMap((group, index) =>
          words.some(word => group.kind === 'han' ? word.includes(group.text) : word === group.text) ? [index] : []);
        if (!numericContextMatches(groups, words) || matchingGroups.length === 0) continue;
        const rank = -matchingGroups.length;
        const projectId = record.source.binding.projectId;
        const targetProjects = record.scope.kind === 'project' ? [record.scope.id]
          : record.scope.kind === 'personal' ? projects
          : record.scope.kind === 'workspace' ? this.#db.prepare(`SELECT project_id FROM workspace_projects
            WHERE workspace_id=? AND project_id IN (${projects.map(() => '?').join(',')}) ORDER BY project_id`)
              .all(record.scope.id, ...projects).map(row => String(row.project_id)) : [];
        const temporal = memoryTemporalStatus(record, now);
        const parsedConditions = record.appliesTo.map(parseMemoryCondition);
        if (parsedConditions.some(condition => !condition)) continue;
        const applicabilityKey = [...new Set(parsedConditions.map(condition => `${condition!.kind}:${condition!.value}`))].sort();
        for (const targetProjectId of targetProjects) {
          const target = grant ? (grant.targets.get(targetProjectId) ?? {}) : (request.target ?? { agent: 'cli', platform: process.platform });
          let applicability = memoryApplicability(record.appliesTo, target);
          if (grant && applicability === 'applicable' && (!target.agent || !target.platform)) applicability = 'needs-verification';
          if (!grant && request.target && (request.target.agent !== undefined && request.target.agent !== 'cli'
            || request.target.platform !== undefined && request.target.platform !== process.platform)) applicability = 'needs-verification';
          if (applicability === 'inapplicable') continue;
          const key = record.conflictSetId ? `conflict:${projectId}:${targetProjectId}:${record.conflictSetId}`
            : JSON.stringify([projectId, targetProjectId, record.scope.kind, record.scope.id, record.claimKey,
              applicabilityKey, temporal ?? 'current', record.verification]);
          if (seen.has(key)) continue;
          seen.add(key);
          if (record.verification !== 'verified' || record.conflictSetId || temporal) {
            const reason = temporal ?? (record.verification === 'stale' ? 'stale' : 'conflicted');
            candidates.push({ kind: 'status', unitId: record.recordId, claimRef: sha256(record.claimKey),
              verification: record.verification, reason, conflictSetId: record.conflictSetId,
              projectId, targetProjectId, target, exposureMode: 'status_only', rank });
          } else candidates.push({ kind: 'memory', unitId: record.recordId, record, projectId, targetProjectId, target,
            applicability, exposureMode: applicability === 'needs-verification' ? 'reference_only' : 'normal', rank });
          if (candidates.length > 256) return { status: 'unavailable', results: [],
            coverage: unavailableCoverage('candidate-limit'), truncated: true, nextCursor: null };
          const hit = candidates[candidates.length - 1]!;
          for (const index of matchingGroups) lanes[index]!.push(hit);
        }
      }
      for (const lane of lanes) lane.sort((a, b) => a.rank - b.rank);
      const fused: SearchResult[] = [];
      const selected = new Set<SearchResult>();
      while (fused.length < candidates.length) {
        let advanced = false;
        for (const lane of lanes) {
          const next = lane.find(hit => !selected.has(hit));
          if (!next) continue;
          fused.push(next);
          selected.add(next);
          advanced = true;
        }
        if (!advanced) break;
      }
      candidates.splice(0, candidates.length, ...fused);
      coverage.inspectedProjects = projects;
      coverage.candidateCount = candidates.length;
      const fingerprint = sha256(JSON.stringify(candidates.map(hit => [hit.unitId, hit.projectId, hit.targetProjectId,
        hit.kind === 'memory' ? hit.record.headEventId : hit.reason])));
      const cursorScope = sha256(JSON.stringify([this.#binding.sessionId, request.grantId ?? null, request.query, request.target ?? null, projects]));
      let offset = 0;
      if (request.cursor !== undefined) {
        check(typeof request.cursor === 'string' && request.cursor.length <= 2048, 'invalid-search-cursor');
        let cursor: { schema?: string; scope?: string; fingerprint?: string; offset?: number };
        try { cursor = JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8')); }
        catch { throw new Error('invalid-search-cursor'); }
        check(cursor.schema === 'memory-search-cursor@1' && cursor.scope === cursorScope
          && cursor.fingerprint === fingerprint && Number.isSafeInteger(cursor.offset)
          && cursor.offset! > 0 && cursor.offset! <= candidates.length, 'invalid-search-cursor');
        offset = cursor.offset!;
      }
      const results: SearchResult[] = [];
      let bytes = 0, end = offset, skipped = 0;
      const remaining = grant?.remaining ?? limit;
      const remainingBytes = grant?.remainingBytes ?? byteBudget;
      const pageBytes = Math.min(byteBudget, remainingBytes);
      for (; end < candidates.length && results.length < Math.min(limit, remaining); end++) {
        const candidate = candidates[end]!;
        const size = Buffer.byteLength(JSON.stringify(candidate));
        if (size > pageBytes) { skipped++; continue; }
        if (bytes + size > pageBytes) break;
        results.push(candidate);
        bytes += size;
      }
      if (!results.length && candidates.length > offset) return { status: 'unavailable', results: [],
        coverage: { ...coverage, unavailableProjects: projects, reason: 'result-over-budget' }, truncated: true, nextCursor: null };
      if (grant && results.length) {
        const updated = this.#db.prepare(`UPDATE memory_discovery_grants
          SET used_results=used_results+?, used_bytes=used_bytes+? WHERE grant_id=? AND state='active'
            AND used_results+?<=max_results AND used_bytes+?<=max_bytes`)
          .run(results.length, bytes, request.grantId!, results.length, bytes);
        check(updated.changes === 1, 'discovery-budget-stale');
      }
      const truncated = end < candidates.length || skipped > 0;
      const exhausted = grant && (results.length >= grant.remaining || bytes >= grant.remainingBytes || grant.remainingQueries === 1);
      const nextCursor = end < candidates.length && !exhausted
        ? Buffer.from(JSON.stringify({ schema: 'memory-search-cursor@1', scope: cursorScope, fingerprint, offset: end })).toString('base64url') : null;
      const reason = skipped ? 'oversized-candidate-skipped'
        : truncated && exhausted ? grant?.remainingQueries === 1 ? 'task-query-budget-exhausted' : 'task-budget-exhausted' : null;
      return { status: 'ready', results, coverage: { ...coverage, reason }, truncated, nextCursor };
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

  #searchScopeSql(alias: 'd' | 'h', projects: readonly string[]): string {
    const ids = projects.map(() => '?').join(',');
    return `((${alias}.scope_kind='project' AND ${alias}.scope_id IN (${ids}))
      OR (${alias}.scope_kind='personal' AND ${alias}.scope_id=?)
      OR (${alias}.scope_kind='workspace' AND EXISTS
        (SELECT 1 FROM workspace_projects w WHERE w.workspace_id=${alias}.scope_id AND w.project_id IN (${ids}))))`;
  }

  #searchScopeArgs(projects: readonly string[]): string[] {
    return [...projects, this.#binding.ownerId, ...projects];
  }

  #visibleScopeSql(alias: 'projection_jobs' | 'memory_heads' | 'v' | 'd' | 'j' | 'search_documents' | 'h'): string {
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
        .filter(record => !record.conflictSetId && !memoryTemporalStatus(record, Date.now())
          && memoryApplicability(record.appliesTo, { agent: 'cli', platform: process.platform }) === 'applicable');
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
    targetScope: MemoryScope = { kind: 'project', id: this.#binding.projectId, resolved: true }, projects: readonly string[] = [this.#binding.projectId]): void {
    check(input?.schema === 'cli-source-ack@1' && input.status === 'durable'
      && input.binding.ownerId === this.#binding.ownerId && input.binding.hostId === this.#binding.hostId, 'source-scope-mismatch');
    this.#validateScope(targetScope, projects);
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

  #validateScope(scope: MemoryScope, projects: readonly string[] = [this.#binding.projectId]): MemoryScope {
    check(scope && ['project', 'workspace', 'personal', 'session'].includes(scope.kind) && typeof scope.id === 'string', 'invalid-memory-scope');
    uuid(scope.id);
    check(Object.keys(scope).every(key => ['kind','id','resolved'].includes(key)) && typeof scope.resolved === 'boolean', 'invalid-memory-scope');
    if (scope.kind === 'project') check(projects.includes(scope.id) && scope.resolved, 'invalid-memory-scope');
    if (scope.kind === 'personal') check(scope.id === this.#binding.ownerId && scope.resolved, 'invalid-memory-scope');
    if (scope.kind === 'session') check(scope.id === this.#binding.sessionId && !scope.resolved, 'invalid-memory-scope');
    if (scope.kind === 'workspace') {
      check(scope.resolved && this.#db.prepare(`SELECT 1 FROM workspace_projects m JOIN workspaces w ON w.workspace_id=m.workspace_id
        WHERE m.workspace_id=? AND m.project_id IN (${projects.map(() => '?').join(',')}) AND w.owner_id=?`)
        .get(scope.id, ...projects, this.#binding.ownerId), 'workspace-unavailable');
    }
    return structuredClone(scope);
  }
  #normalizeAppliesTo(value: string[]): string[] {
    check(Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0
      && Buffer.byteLength(item) <= 256 && parseMemoryCondition(item) !== null), 'invalid-memory-scope');
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
    check(!memoryTemporalStatus(record, Date.now()), 'memory-not-current');
    this.#validateSource(record.source, undefined, record.scope);
    this.#checkVerification(record, true);
  }
  #checkVerification(record: MemoryRecord, readSources = false, projects: readonly string[] = [this.#binding.projectId]): void {
    if (!record.verificationRunId) { check(record.verification !== 'verified', 'verification-evidence-gap'); return; }
    const row = this.#db.prepare('SELECT * FROM verification_runs WHERE run_id=?').get(record.verificationRunId);
    check(row && row.record_id === record.recordId && row.revision_id === record.revisionId
      && sha256(String(row.evidence_json)) === row.evidence_hash
      && (record.verification !== 'verified' || row.result === 'pass'), 'verification-evidence-gap');
    const evidence = JSON.parse(String(row.evidence_json)) as SourceAck[];
    this.#checkEvidenceRows('verification_evidence', 'run_id', record.verificationRunId, evidence);
    if (readSources) for (const ref of evidence) this.#validateSource(ref, undefined, record.scope, projects);
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
      && revision.type === record.type && revision.valid_from === record.validFrom && revision.valid_until === record.validUntil
      && revision.source_project_id === record.source.binding.projectId && revision.scope_kind === record.scope.kind && revision.scope_id === record.scope.id
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
  #readMemoryUnsafe(recordId: string, projects: readonly string[] = [this.#binding.projectId]): MemoryRecord {
    const row = this.#db.prepare('SELECT * FROM memory_heads WHERE record_id=?').get(recordId);
    check(row, 'memory-evidence-gap');
    const record = this.#replayMemory(recordId);
    check(this.#snapshotBytes(record) === row.snapshot && record.hash === row.snapshot_hash
      && record.revisionId === row.revision_id && record.lifecycle === row.lifecycle
      && record.verification === row.verification && record.scope.kind === row.scope_kind && record.scope.id === row.scope_id
      && record.scope.resolved === Boolean(row.scope_resolved) && record.conflictSetId === row.conflict_set_id
      && record.verificationRunId === row.verification_run_id
      && record.headEventId === row.head_event_id, 'memory-evidence-gap');
    this.#validateScope(record.scope, projects);
    this.#validateSource(record.source, undefined, record.scope, projects);
    this.#checkVerification(record, true, projects);
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
    this.#db.prepare('INSERT INTO memory_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(record.revisionId, record.recordId, record.revision, record.content, record.contentHash, record.type,
        record.validFrom, record.validUntil, record.source.binding.projectId,
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

  #controlledFiles() {
    const rows = this.#db.prepare(`SELECT e.run_id,e.payload,e.hash,s.principal_id,s.project_id FROM request_events e
      JOIN request_runs r ON r.run_id=e.run_id JOIN execution_streams s ON s.stream_id=r.stream_id
      WHERE s.store_id=? AND e.kind='agent/event@v1' ORDER BY e.run_id,e.seq`).all(this.#storeId);
    const runs = new Map<string, { events: AgentEvent[]; ownerId: string; projectId: string }>();
    for (const row of rows) {
      check(sha256(String(row.payload)) === row.hash, 'file-cleanup-evidence-gap');
      const runId = String(row.run_id);
      const run = runs.get(runId) ?? { events: [], ownerId: String(row.principal_id), projectId: String(row.project_id) };
      run.events.push(JSON.parse(String(row.payload)).event as AgentEvent); runs.set(runId, run);
    }
    return [...runs].flatMap(([runId, run]) => {
      const state = replayAgent(run.events, 0);
      return state.files.filter(file => file.admission.operation === 'file.write').map(file => {
        const tool = state.tools.find(tool => tool.callId === file.admission.callId)!;
        const receipt = file.reconciled ?? tool.result?.file;
        return { runId, callId: tool.callId, ownerId: run.ownerId, projectId: run.projectId,
          root: file.admission.root, parent: file.admission.target.parent, path: file.admission.target.path,
          identity: receipt?.identity ?? file.admission.target.identity, source: file.admission.source,
          responsibility: file.admission.cleanup, started: tool.started,
          state: receipt ? 'recorded' : ['file-create-conflict', 'file-create-denied'].includes(file.failureReason ?? tool.result?.errorClass ?? '') ? 'no_effect'
            : tool.started ? 'unknown' : 'not_started' };
      });
    });
  }
  #scanResiduals() {
    const observedAt = new Date().toISOString();
    const entries: { path: string; state: 'expected' | 'unexpected' | 'unknown'; observedAt: string; dev: string | null; ino: string | null; reason: string }[] = [];
    // These are the existing disposable adapter's carriers, not a cleanup allowlist.
    const sources = this.#db.prepare('SELECT source_path,source_dev,source_ino FROM sessions WHERE store_id=?').all(this.#storeId);
    const sourceNames = sources.map(row => basename(String(row.source_path)));
    const known = new Set(['sandbox.json', 'counting-receiver.jsonl', ...sourceNames, basename(this.#resources.store.path),
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
    for (const file of this.#controlledFiles().filter(file => file.started && file.state !== 'no_effect')) {
      try {
        sameFile(file.root.path, file.root.identity);
        sameFile(file.parent.path, file.parent.identity);
        check(file.state === 'recorded' && file.identity, 'file-cleanup-evidence-gap');
        sameFile(file.path, file.identity);
        entries.push({ path: file.path, state: 'expected', observedAt, dev: file.identity.dev, ino: file.identity.ino,
          reason: 'registered-project-copy:host-project-resource' });
      } catch {
        entries.push({ path: file.path, state: 'unknown', observedAt, dev: file.identity?.dev ?? null, ino: file.identity?.ino ?? null,
          reason: 'project-copy-reconciliation-required' });
      }
    }
    const unique = new Map<string, (typeof entries)[number]>();
    for (const entry of entries) if (!unique.has(entry.path) || entry.state !== 'expected') unique.set(entry.path, entry);
    this.#db.prepare('DELETE FROM maintenance_residuals WHERE store_id=?').run(this.#storeId);
    const insert = this.#db.prepare('INSERT INTO maintenance_residuals VALUES (?,?,?,?,?,?,?)');
    for (const entry of unique.values()) insert.run(this.#storeId, entry.path, entry.state, observedAt, entry.dev, entry.ino, entry.reason);
    return [...unique.values()];
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
      controlledFiles: this.#controlledFiles(),
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

function memoryTemporalStatus(record: Pick<MemoryRecord, 'validFrom' | 'validUntil'>, now: number): 'not-yet-valid' | 'expired' | null {
  return record.validFrom && now < Date.parse(record.validFrom) ? 'not-yet-valid'
    : record.validUntil && now >= Date.parse(record.validUntil) ? 'expired' : null;
}

function memoryProjectionExposure(record: MemoryRecord): 'normal' | 'status_only' | null {
  if (record.lifecycle !== 'active' || !record.scope.resolved
    || !['verified','stale','conflicted'].includes(record.verification)) return null;
  return record.verification === 'verified' && !record.conflictSetId ? 'normal' : 'status_only';
}

function validSearchTarget(value: unknown, required = false): value is SearchTarget {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && (!required || Object.keys(value).length > 0)
    && Object.keys(value).every(key => ['agent','platform','component'].includes(key))
    && Object.values(value).every(item => typeof item === 'string' && item.length > 0 && Buffer.byteLength(item) <= 128));
}

function validDiscoveryTargets(targets: Record<string, SearchTarget>, projectIds: readonly string[]): boolean {
  return Boolean(targets && typeof targets === 'object' && !Array.isArray(targets)
    && Object.entries(targets).every(([projectId, target]) => projectIds.includes(projectId) && validSearchTarget(target, true)));
}

function parseMemoryCondition(condition: string): { kind: keyof SearchTarget; value: string } | null {
  const parts = condition.split(':');
  if (parts.length === 1 && /^[^:\s]+$/u.test(condition)) {
    return { kind: ['win32','linux','darwin'].includes(condition) ? 'platform' : 'agent', value: condition };
  }
  if (parts.length === 2 && ['agent','platform','component'].includes(parts[0]!)
    && /^[^:\s]+$/u.test(parts[1]!)) return { kind: parts[0] as keyof SearchTarget, value: parts[1]! };
  return null;
}

function memoryApplicability(conditions: readonly string[], target: SearchTarget):
  'applicable' | 'needs-verification' | 'inapplicable' {
  let unknown = false;
  for (const condition of conditions) {
    const parsed = parseMemoryCondition(condition);
    if (!parsed) return 'inapplicable';
    const actual = target[parsed.kind];
    if (actual === undefined) unknown = true;
    else if (actual !== parsed.value) return 'inapplicable';
  }
  return unknown ? 'needs-verification' : 'applicable';
}

function searchRuns(value: string): { text: string; kind: 'han' | 'latin' }[] {
  const runs: { text: string; kind: 'han' | 'latin' }[] = [];
  let previousKind: 'han' | 'latin' | null = null;
  for (const char of value.normalize('NFKC').toLowerCase()) {
    const kind = /\p{Script=Han}/u.test(char) ? 'han' : /[\p{L}\p{N}]/u.test(char) ? 'latin' : null;
    if (!kind) { previousKind = null; continue; }
    const previous = runs[runs.length - 1];
    if (previous && previousKind === kind) previous.text += char;
    else runs.push({ text: char, kind });
    previousKind = kind;
  }
  return runs;
}

function searchGroups(value: string): { text: string; kind: 'han' | 'latin' }[] {
  return searchRuns(value).filter(run => Array.from(run.text).length >= 2 || /^\p{N}$/u.test(run.text));
}

function searchTerms(value: string): string[] {
  return [...new Set(searchGroups(value).flatMap(group => group.kind === 'han'
    ? Array.from(group.text).slice(0, -1).map((char, index) => char + Array.from(group.text)[index + 1]) : [group.text]))];
}

function numericContextMatches(groups: { text: string; kind: 'han' | 'latin' }[], words: string[]): boolean {
  return groups.every((group, index) => {
    if (!/\p{N}/u.test(group.text)) return true;
    if (!words.includes(group.text)) return false;
    const previous = groups[index - 1];
    const next = groups[index + 1];
    const left = previous?.kind === 'latin' && !/\p{N}/u.test(previous.text) ? previous.text : null;
    const right = next?.kind === 'latin' && !/\p{N}/u.test(next.text) ? next.text : null;
    if (left || right) {
      return words.some((word, position) => word === group.text
        && (!left || words[position - 1] === left) && (!right || words[position + 1] === right));
    }
    return true;
  });
}

function normalizeSearchText(value: string): string {
  return searchRuns(value).map(run => run.text).join(' ');
}
function cjkBigrams(value: string): string {
  return searchRuns(value).filter(run => run.kind === 'han').flatMap(run => {
    const chars = Array.from(run.text);
    return chars.slice(0, -1).map((char, index) => `${char}${chars[index + 1]}`);
  }).join(' ');
}

function processAbsent(pid: number): boolean {
  check(Number.isSafeInteger(pid) && pid > 0, 'invalid-process-identity');
  try { process.kill(pid, 0); return false; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    throw new Error('process-exit-evidence-gap', { cause: error });
  }
}
