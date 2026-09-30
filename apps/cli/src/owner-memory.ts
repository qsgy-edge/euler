import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DEFAULT_BUDGET, check, encodeOwnerAgreement, isOwnerAgreement, isOwnerDecline, isUntypedRemember,
  parseMemoryProposal, parseOwnerAgreement, parseOwnerStatement, sameFile, sha256, uuid } from '@euler/core';
import type { HostInfo, MemoryRecord, MemoryScope, ProbeBudget, RememberResult, SourceAck } from '@euler/core';
import { openProbe } from './probe.ts';
import type { Sandbox } from './sandbox.ts';

const emit = (event: string, data: Record<string, unknown> = {}) => process.stdout.write(JSON.stringify({ event, ...data }) + '\n');
// A synthetic owner session asks several local questions; still far below validation limits.
export const OWNER_BUDGET: ProbeBudget = { ...DEFAULT_BUDGET, maxModelAttempts: 8, maxTotalTokens: 65536, wallClockMs: 600000 };

interface OwnerInfoRecord {
  schema: 'owner-info-entry@1'; entryId: string; kind: 'memory-activation'; batchId: string; digest: string;
  scope: MemoryScope; memberCount: number; payload: string; writtenAt: string;
}
export interface OwnerInfoEntry { record: OwnerInfoRecord; entryHash: string }

/**
 * The CLI owner-facing Info carrier: an append-only, fsynced JSONL entry per frozen
 * activation batch. It is a replayable Host presentation, never model context, and
 * the Store's host_info_batches row stays the authority for delivery/read state.
 */
export class OwnerInfoLog {
  readonly #sandbox: Sandbox;
  readonly #path: string;
  constructor(sandbox: Sandbox) {
    check(sandbox.ownerInfoIdentity, 'owner-info-unavailable');
    this.#sandbox = sandbox;
    this.#path = join(sandbox.root, 'owner-info.jsonl');
    this.entries();
  }
  get path(): string { return this.#path; }

  entries(): OwnerInfoEntry[] {
    sameFile(this.#path, this.#sandbox.ownerInfoIdentity!);
    const bytes = readFileSync(this.#path, 'utf8');
    check(bytes.endsWith('\n') && Buffer.byteLength(bytes) <= 4_194_304, 'owner-info-evidence-gap');
    const lines = bytes.slice(0, -1).split('\n');
    const header = JSON.parse(lines.shift()!);
    check(header?.schema === 'owner-info@1' && header.storeId === this.#sandbox.storeId, 'owner-info-evidence-gap');
    const batches = new Set<string>();
    return lines.map(line => {
      const record = JSON.parse(line) as OwnerInfoRecord;
      check(record.schema === 'owner-info-entry@1' && record.kind === 'memory-activation' && sha256(record.payload) === record.digest
        && line === JSON.stringify(record) && !batches.has(record.batchId), 'owner-info-evidence-gap');
      uuid(record.entryId); uuid(record.batchId);
      batches.add(record.batchId);
      return { record, entryHash: sha256(line) };
    });
  }

  /** Idempotent by batch: a surviving entry from an interrupted delivery is reused, never duplicated. */
  append(batch: { batchId: string; digest: string; scope: MemoryScope; memberCount: number; payload: string }): OwnerInfoEntry {
    const existing = this.entries().find(entry => entry.record.batchId === batch.batchId);
    if (existing) {
      check(existing.record.digest === batch.digest, 'owner-info-conflict');
      return existing;
    }
    check(sha256(batch.payload) === batch.digest, 'owner-info-evidence-gap');
    const record: OwnerInfoRecord = { schema: 'owner-info-entry@1', entryId: randomUUID(), kind: 'memory-activation',
      batchId: batch.batchId, digest: batch.digest, scope: batch.scope, memberCount: batch.memberCount,
      payload: batch.payload, writtenAt: new Date().toISOString() };
    const line = JSON.stringify(record) + '\n';
    const fd = openSync(this.#path, 'a');
    try {
      const bytes = Buffer.from(line);
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset);
        check(written > 0, 'owner-info-write-failed');
        offset += written;
      }
      fsyncSync(fd);
    } finally { closeSync(fd); }
    const durable = this.entries().find(entry => entry.record.entryId === record.entryId);
    check(durable, 'owner-info-ack-failed');
    return durable;
  }
}

export type OwnerScenario = 'success' | 'crash-before-activation-commit' | 'crash-after-activation-commit' | 'crash-before-info-append'
  | 'crash-after-info-append' | 'crash-after-info-delivery' | 'crash-before-info-read' | 'crash-after-info-read';
export const OWNER_SCENARIOS: OwnerScenario[] = ['success', 'crash-before-activation-commit', 'crash-after-activation-commit',
  'crash-before-info-append', 'crash-after-info-append', 'crash-after-info-delivery', 'crash-before-info-read', 'crash-after-info-read'];

// Test-only kill point: the parent kills this process while it waits.
function stall(stage: string): never {
  writeSync(1, JSON.stringify({ event: 'owner-checkpoint', stage, pid: process.pid }) + '\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
  throw new Error('checkpoint-was-not-killed');
}

function summarize(payload: string) {
  const manifest = JSON.parse(payload) as { events: { recordId: string; after: MemoryRecord }[] };
  return manifest.events.map(event => ({ recordId: event.recordId, type: event.after.type,
    content: Array.from(event.after.content).slice(0, 200).join(''), lifecycle: event.after.lifecycle }));
}

class OwnerMemoryHost {
  readonly probe: ReturnType<typeof openProbe>;
  readonly log: OwnerInfoLog | null;
  readonly #scenario: OwnerScenario;
  readonly #noActiveProject: boolean;
  constructor(probe: ReturnType<typeof openProbe>, log: OwnerInfoLog | null, scenario: OwnerScenario, noActiveProject: boolean) {
    this.probe = probe; this.log = log; this.#scenario = scenario; this.#noActiveProject = noActiveProject;
  }

  /** Registers and presents every pending Info batch; false leaves the rest pending for recovery. */
  deliver(): boolean {
    const { store, activity } = this.probe;
    const pending = store.registerHostInfo(activity);
    if (!this.log) return pending.length === 0;
    for (const info of pending) {
      if (this.#scenario === 'crash-before-info-append') stall('info-registered-before-owner-entry');
      let entry: OwnerInfoEntry;
      try {
        const batch = store.readActivationBatch(activity, info.batchId);
        entry = this.log.append({ batchId: batch.batchId, digest: batch.digest, scope: batch.scope,
          memberCount: batch.events.length, payload: batch.payload });
      } catch (error) {
        emit('info-error', { level: 'error', batchId: info.batchId, committed: true, delivery: 'pending-redelivery',
          reason: (error as Error).message });
        return false;
      }
      if (this.#scenario === 'crash-after-info-append') stall('info-appended-before-delivery-record');
      const delivered = store.recordHostInfoDelivery(activity, { batchId: info.batchId, digest: info.digest,
        entryId: entry.record.entryId, entryHash: entry.entryHash });
      if (this.#scenario === 'crash-after-info-delivery') stall('info-delivered-before-notice');
      emit('info-notice', { level: 'info', authoritative: false, batchId: info.batchId, memberCount: info.memberCount,
        delivery: delivered.delivery, read: delivered.read, entryId: delivered.entryId, members: summarize(entry.record.payload) });
    }
    return true;
  }

  drain(): void {
    try { this.probe.store.drainSearchProjection(this.probe.activity, 128); }
    catch (error) { emit('search-projection-lag', { level: 'warning', reason: (error as Error).message }); }
  }

  remember(input: SourceAck, via: 'live' | 'backfill'): RememberResult | null {
    const { store, activity } = this.probe;
    const request = { input, hostInfo: this.log ? 'durable' as const : 'unavailable' as const,
      ...(this.#noActiveProject ? { noActiveProject: true as const } : {}) };
    let result: RememberResult;
    try {
      result = via === 'live' && this.#scenario === 'crash-before-activation-commit'
        ? store.withActivity(activity, () => { store.rememberMemory(activity, request); return stall('activation-uncommitted'); })
        : store.rememberMemory(activity, request);
    } catch (error) {
      emit('remember-result', { via, status: 'error', level: 'error', committed: false, reason: (error as Error).message, input: input.eventId });
      return null;
    }
    if (via === 'live' && this.#scenario === 'crash-after-activation-commit' && result.status === 'activated') {
      stall('activation-committed-before-info');
    }
    this.drain();
    let presentation = 'not-applicable';
    if (result.status === 'activated' || (result.batchId && result.status === 'no_op')) {
      this.deliver();
      const info = store.listHostInfo(activity).find(item => item.batchId === result.batchId);
      presentation = info?.delivery === 'delivered' ? 'delivered' : this.log ? 'pending-redelivery' : 'unavailable';
    }
    if (via === 'live' || result.status === 'activated') {
      emit('remember-result', { via, status: result.status, stage: result.stage, reason: result.reason,
        level: presentation === 'pending-redelivery' ? 'error' : result.status === 'blocked' ? 'warning' : 'info',
        recordId: result.record.recordId, type: result.record.type, content: result.record.content, batchId: result.batchId,
        range: result.range.map(ref => ref.eventId), verifier: result.verification?.verifier ?? null, presentation });
    }
    return result;
  }

  /** Durable owner events whose capture was lost (for example a crash before commit) are backfilled by source identity. */
  backfill(): void {
    const events = this.probe.archive.events();
    let actionable = 0;
    for (const event of events) {
      if (event.role !== 'user') continue;
      let candidate = Boolean(parseOwnerStatement(event.text));
      if (!candidate) { try { candidate = Boolean(parseOwnerAgreement(event.text)); } catch { candidate = true; } }
      if (!candidate) continue;
      actionable++;
      this.remember(event.ack, 'backfill');
    }
    emit('owner-backfill', { scanned: events.length, actionable });
  }

  showInfo(batchId: string): void {
    const { store, activity } = this.probe;
    this.deliver();
    const info = store.listHostInfo(activity).find(item => item.batchId === batchId);
    if (!info) { emit('info-view-error', { batchId, reason: 'host-info-not-found' }); return; }
    if (info.delivery !== 'delivered') { emit('info-view-error', { batchId, reason: 'host-info-not-delivered' }); return; }
    const view = store.readHostInfo(activity, batchId);
    const entry = this.log?.entries().find(item => item.record.batchId === batchId) ?? null;
    check(entry && entry.record.entryId === info.entryId && entry.entryHash === info.entryHash, 'owner-info-evidence-gap');
    emit('info-view', { batchId, digest: view.info.digest, frozen: summarize(view.batch.payload),
      current: view.members.map(member => ({ recordId: member.recordId, lifecycle: member.current?.lifecycle ?? null,
        verification: member.current?.verification ?? null, content: member.current?.content ?? null,
        changed: member.changed, unavailable: member.unavailable })), entryId: entry.record.entryId });
    if (this.#scenario === 'crash-before-info-read') stall('info-shown-before-read-ack');
    const read = store.acknowledgeHostInfo(activity, batchId);
    if (this.#scenario === 'crash-after-info-read') stall('info-read-before-output');
    emit('info-read', { batchId, read: read.read, readAt: read.readAt });
  }

  listInfo(): void {
    const { store, activity } = this.probe;
    store.registerHostInfo(activity);
    const rows = store.listHostInfo(activity);
    emit('info-list', { pending: rows.filter(row => row.delivery === 'pending').length,
      unread: rows.filter(row => row.read === 'unread').length,
      rows: rows.map((row: HostInfo) => ({ batchId: row.batchId, memberCount: row.memberCount, delivery: row.delivery, read: row.read })) });
  }

  ask(question: string): void {
    const { store, activity, session } = this.probe;
    if (parseOwnerStatement(question) || isUntypedRemember(question) || isOwnerAgreement(question) || isOwnerDecline(question)) {
      emit('ask-refused', { reason: 'owner-statement-not-question' }); return;
    }
    if (!this.deliver()) { emit('ask-refused', { reason: 'host-info-recovery-required' }); return; }
    const page = store.searchMemories(activity, { query: question });
    const delta = store.pinnedMemoryDelta(activity);
    const selected = new Map<string, MemoryRecord>();
    if (page.status === 'ready') {
      for (const hit of page.results) {
        if (hit.exposureMode === 'normal' && hit.applicability === 'applicable') selected.set(hit.record.recordId, hit.record);
      }
    }
    for (const record of delta.records) selected.set(record.recordId, record);
    const records = [...selected.values()].slice(0, 16);
    const turn = session.prepare(randomUUID(), question, records);
    const receipt = session.dispatch(turn);
    emit('ask-result', { searchStatus: page.status, searchReason: page.coverage.reason, pinned: delta.records.map(record => record.recordId),
      selected: records.map(record => record.recordId), receipt, payload: turn.payload });
  }
}

export async function runRememberSession(sandbox: Sandbox, options: { presentation: 'durable' | 'none'; noActiveProject: boolean; scenario: string }): Promise<void> {
  check((OWNER_SCENARIOS as string[]).includes(options.scenario), 'invalid-owner-scenario');
  const probe = openProbe(sandbox, OWNER_BUDGET, undefined, undefined, undefined, true);
  const lines = createInterface({ input: process.stdin });
  try {
    let log: OwnerInfoLog | null = null;
    if (options.presentation === 'durable') {
      try { log = new OwnerInfoLog(sandbox); }
      catch (error) { emit('owner-info-unavailable', { level: 'warning', reason: (error as Error).message }); }
    }
    const host = new OwnerMemoryHost(probe, log, options.scenario as OwnerScenario, options.noActiveProject);
    host.backfill();
    host.drain();
    host.deliver();
    const rows = probe.store.listHostInfo(probe.activity);
    emit('remember-ready', { pid: process.pid, hostInfo: log ? 'durable' : 'unavailable', infoPath: log?.path ?? null,
      pending: rows.filter(row => row.delivery === 'pending').length, unread: rows.filter(row => row.read === 'unread').length,
      commands: ['记住偏好：…', '记住决定：…', '记住事实：…', 'propose <text>', '同意', '取消', 'info', 'info <batchId>', 'ask <question>', 'stop'] });
    const archive = (text: string): SourceAck | null => {
      try { return probe.archive.append(randomUUID(), text); }
      catch (error) {
        emit('remember-result', { via: 'live', status: 'error', level: 'error', committed: false, reason: (error as Error).message });
        return null;
      }
    };
    for await (const raw of lines) {
      const line = raw.trim();
      try {
        if (line === 'stop') break;
        if (line === 'info') { host.listInfo(); continue; }
        if (line.startsWith('info ')) { host.showInfo(line.slice(5).trim()); continue; }
        if (line.startsWith('ask ')) { host.ask(line.slice(4).trim()); continue; }
        if (line.startsWith('propose ')) {
          const text = line.slice(8).replaceAll('\\n', '\n');
          const ack = probe.archive.append(randomUUID(), text, 'assistant');
          emit('assistant-proposal', { synthetic: true, eventId: ack.eventId, actionable: Boolean(parseMemoryProposal(text)) });
          continue;
        }
        if (isOwnerAgreement(line) || isOwnerDecline(line)) {
          const previous = probe.archive.events().at(-1);
          const target = previous?.role === 'assistant' && parseMemoryProposal(previous.text) ? previous.ack : null;
          const ack = archive(target && isOwnerAgreement(line) ? encodeOwnerAgreement(line, target) : line);
          if (!ack) continue;
          if (!target) emit('remember-result', { via: 'live', status: 'not-actionable', level: 'warning', reason: 'agreement-target-missing', input: ack.eventId });
          else if (isOwnerDecline(line)) emit('remember-result', { via: 'live', status: 'cancelled', level: 'info', reason: 'owner-declined', input: ack.eventId, proposal: target.eventId });
          else host.remember(ack, 'live');
          continue;
        }
        if (parseOwnerStatement(line)) { const ack = archive(line); if (ack) host.remember(ack, 'live'); continue; }
        if (isUntypedRemember(line)) {
          const ack = archive(line);
          if (ack) emit('remember-result', { via: 'live', status: 'needs-input', level: 'warning', reason: 'memory-type-required', input: ack.eventId,
            accepted: ['记住偏好：…', '记住决定：…', '记住事实：…'] });
          continue;
        }
        emit('command-rejected', { reason: 'owner-memory-command-required' });
      } catch (error) { emit('command-error', { reason: (error as Error).message }); }
    }
  } finally { lines.close(); probe.close(); }
}

/** Queries Info without an agent session; listing never settles unread, opening a batch does. */
export function runInfoQuery(sandbox: Sandbox, batchId?: string): void {
  const probe = openProbe(sandbox, OWNER_BUDGET, undefined, undefined, undefined, true);
  try {
    let log: OwnerInfoLog | null = null;
    try { log = new OwnerInfoLog(sandbox); }
    catch (error) { emit('owner-info-unavailable', { level: 'warning', reason: (error as Error).message }); }
    const host = new OwnerMemoryHost(probe, log, 'success', false);
    if (batchId) host.showInfo(batchId); else host.listInfo();
  } finally { probe.close(); }
}
