import { CORE_TOOLS, sha256 } from '../contracts.ts';
import type { ProbeBudget, SourceAck } from '../contracts.ts';
import type { AttemptOwnership, ExecutionStream } from './probe-store.ts';

// T06 / I11 / Ticket 09 §13-16: durable, recoverable request ledger facts.
// The ledger stores only references, hashes, budgets and states — never request
// content. Receipts are log-only and never enter the model payload.

export type RequestOwnerKind = ExecutionStream['ownerKind'];
export type RequestRunState = 'authorized' | 'revoked' | 'sealed';
export type RequestAssemblyState = 'not-dispatched' | 'unknown-sent' | 'finished';
export type RequestAttemptOutcome = 'unknown-sent' | 'received' | 'cancelled-before-send';
export type RequestEventKind =
  | 'agent/event@v1'
  | 'run-authorized' | 'run-revoked' | 'run-sealed' | 'run-recovery-gap'
  | 'model/request-attempt-reconciled@v1'
  | 'context/assembly@v1'
  | 'model/request-attempt-started@v1' | 'model/request-attempt-finished@v1';

export interface RequestReconciliation {
  attemptId: string; runId: string; payloadHash: string; byteLength: number;
  outcome: 'received' | 'not-received'; receiptHash: string;
}

export interface RequestRecovery {
  relatedRunId: string;
  acceptDuplicateRisk: boolean;
}

export interface RequestRun {
  runId: string; streamId: string; ownerKind: RequestOwnerKind; ownerId: string;
  authorizationId: string; activityId: string; epoch: number; budget: ProbeBudget;
  intent: { eventId: string; hash: string } | null; relatedRunId: string | null;
  authorizedAt: string; state: RequestRunState;
}

// The payload is frozen at assembly time (hash + byte length + estimator) and is
// never persisted; the ledger keeps only the frozen identity facts.
export interface RequestAssemblyInput {
  runId: string; epoch: number; route: string; model: string; policyHash: string;
  estimator: 'utf8-bytes-upper-bound@1';
  sources: SourceAck[]; intent: { eventId: string; hash: string } | null;
  payload: string; payloadHash: string; byteLength: number; estimatedTokens: number;
  budget: ProbeBudget; zones: { p0: number; p1: number; p2: number; p3: number };
  selection: { ordinal: number; hash: string; reason: 'mandatory-source' }[];
  degradation: 'none';
}
export interface RequestAssembly extends Omit<RequestAssemblyInput, 'payload'> {
  assemblyId: string; identityHash: string;
}
export interface RequestAttempt extends AttemptOwnership {
  assemblyId: string; ordinal: number; payloadHash: string; byteLength: number;
  encoding: 'utf8-json@1'; hashAlgorithm: 'sha256'; adapterVersion: string;
  startedAt: string; finishedAt: string | null; outcome: RequestAttemptOutcome;
}
export interface RequestEvent {
  eventId: string; runId: string; seq: number; kind: RequestEventKind;
  attemptId: string | null; activityId: string; createdAt: string;
  payload: string; hash: string;
}
export interface RequestStatus {
  run: RequestRun;
  events: RequestEvent[];
  assemblies: (RequestAssembly & { state: RequestAssemblyState })[];
  attempts: RequestAttempt[];
  revoked: boolean; sealed: boolean;
}

// Standing synthetic Host policy frozen into every assembly identity.
export const REQUEST_POLICY_HASH = sha256(JSON.stringify({
  coreTools: CORE_TOOLS, estimator: 'utf8-bytes-upper-bound@1',
}));

export const REQUEST_ENCODING = 'utf8-json@1';
export const REQUEST_HASH_ALGORITHM = 'sha256';

export function freezeRequestPayload(payload: string): { payloadHash: string; byteLength: number } {
  return { payloadHash: sha256(payload), byteLength: Buffer.byteLength(payload) };
}

// Assembly identity covers every non-attempt input (Ticket 09 §15): a change in
// content, route, model, policy, epoch, budget, selection or sources creates a
// new assembly ID; only attempt-specific transport metadata may differ between
// legal retries of the same complete payload.
export function assemblyIdentityHash(input: Omit<RequestAssemblyInput, 'payload'>): string {
  return sha256(JSON.stringify({
    runId: input.runId, epoch: input.epoch, route: input.route, model: input.model,
    policyHash: input.policyHash, estimator: input.estimator, sources: input.sources,
    intent: input.intent, payloadHash: input.payloadHash, byteLength: input.byteLength,
    estimatedTokens: input.estimatedTokens, budget: input.budget, zones: input.zones,
    selection: input.selection, degradation: input.degradation,
  }));
}

// An unresolved attempt takes priority over earlier received attempts. Only
// when every attempt is settled may a received result finish the assembly.
// A cancelled-before-send attempt proves no bytes left for that attempt, so it
// never upgrades the assembly past the remaining attempts' evidence.
export function deriveAssemblyState(attempts: { outcome: RequestAttemptOutcome }[]): RequestAssemblyState {
  if (attempts.some(attempt => attempt.outcome === 'unknown-sent')) return 'unknown-sent';
  if (attempts.some(attempt => attempt.outcome === 'received')) return 'finished';
  return 'not-dispatched';
}
