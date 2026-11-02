import { createHash } from 'node:crypto';

export const API_VERSION = 'euler-p0@1';
export const CORE_TOOLS = [
  'skill.search', 'memory.search', 'source.search', 'source.expand',
  'memory.inspect', 'memory.preview', 'memory.commit', 'memory.cancel',
] as const;

export interface Binding {
  ownerId: string;
  hostId: string;
  projectId: string | null;
  sessionId: string;
  branchId: string;
}

export function localProjects(binding: Binding): string[] {
  return binding.projectId === null ? [] : [binding.projectId];
}

export function localScope(binding: Binding): { kind: 'session' | 'project'; id: string; resolved: boolean } {
  return binding.projectId === null ? { kind: 'session', id: binding.sessionId, resolved: false }
    : { kind: 'project', id: binding.projectId, resolved: true };
}

export function requireProject(binding: Binding): string {
  check(binding.projectId !== null, 'project-unbound');
  return binding.projectId;
}

export interface SourceAck {
  schema: 'cli-source-ack@1';
  status: 'durable';
  binding: Binding;
  eventId: string;
  locator: string;
  hash: string;
  byteLength: number;
  contentHash: string;
}

export interface SourceExcerpt {
  ref: SourceAck;
  text: string;
  offset: number;
  end: number;
  total: number;
  truncated: boolean;
  excerptHash: string;
}

export interface HostAdapter {
  version: typeof API_VERSION;
  binding: Binding;
  source: {
    append(eventId: string, text: string): SourceAck;
    lookup(eventId: string): SourceAck | null;
    read(ref: SourceAck): { text: string; role?: 'user' | 'assistant' | 'tool' };
    expand(ref: SourceAck, offset: number, limit: number): SourceExcerpt;
  };
  transport: {
    kind: 'local-counting@1';
    send(payload: string, attempt?: { attemptId: string; runId: string; payloadHash: string; byteLength: number }): { hash: string; byteLength: number; count: number };
  };
}

export interface ProbeBudget {
  version: 'probe-budget@1';
  contextLimit: number;
  outputReserve: number;
  safetyMargin: number;
  maxModelAttempts: number;
  maxToolCalls: number;
  maxTotalTokens: number;
  wallClockMs: number;
  toolTimeoutMs: number;
}

// Synthetic test values, not provider estimates or production tuning.
export const DEFAULT_BUDGET: Readonly<ProbeBudget> = Object.freeze({
  version: 'probe-budget@1', contextLimit: 8192, outputReserve: 256,
  safetyMargin: 128, maxModelAttempts: 1, maxToolCalls: 4,
  maxTotalTokens: 16384, wallClockMs: 30000, toolTimeoutMs: 2000,
});

export function validateBudget(budget: ProbeBudget): void {
  check(budget?.version === 'probe-budget@1', 'invalid-budget');
  for (const key of Object.keys(DEFAULT_BUDGET) as (keyof ProbeBudget)[]) {
    if (key === 'version') continue;
    const value = budget[key];
    check(Number.isSafeInteger(value) && value > 0 && value <= 1_000_000, 'invalid-budget');
  }
  check(budget.outputReserve + budget.safetyMargin < budget.contextLimit, 'invalid-budget');
}

export function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A source identity derived from durable operation identities, not transient process state. */
export function sourceEventId(...identity: string[]): string {
  const hash = sha256(JSON.stringify(identity));
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-8${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;
}

export function check(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}

export function uuid(value: string): void {
  check(typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value), 'invalid-identity');
}

export function sameBinding(a: Binding, b: Binding): boolean {
  return ['ownerId', 'hostId', 'projectId', 'sessionId', 'branchId']
    .every(key => a[key as keyof Binding] === b[key as keyof Binding]);
}
