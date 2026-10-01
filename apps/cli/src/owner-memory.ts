import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DEFAULT_BUDGET, OWNER_MEMORY_FORMS, check, encodeOwnerAgreement, isOwnerAgreement, isOwnerDecline, isUntypedRemember,
  parseMemoryProposal, parseOwnerAgreement, parseOwnerStatement, sameFile, sha256, uuid } from '@euler/core';
import type { ActivationBatch, HostInfo, MemoryRecord, MemoryScope, ProbeBudget, RememberResult, SourceAck } from '@euler/core';
import { appendDurably } from './archive.ts';
import { killPoint } from './kill-point.ts';
import { openProbe } from './probe.ts';
import { OWNER_INFO_FILE } from './sandbox.ts';
import type { Sandbox } from './sandbox.ts';

const emit = (event: string, data: Record<string, unknown> = {}) => process.stdout.write(JSON.stringify({ ...data, event }) + '\n');
// A synthetic owner session asks several local questions; still far below validation limits.
export const OWNER_BUDGET: ProbeBudget = { ...DEFAULT_BUDGET, maxModelAttempts: 8, maxTotalTokens: 65536, wallClockMs: 600000 };
const OWNER_INFO_MAX_BYTES = 4_194_304;
const NOTICE_CHARS = 200;

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
    this.#path = join(sandbox.root, OWNER_INFO_FILE);
    this.entries();
  }
  get path(): string { return this.#path; }

  entries(): OwnerInfoEntry[] {
    sameFile(this.#path, this.#sandbox.ownerInfoIdentity!);
    const bytes = readFileSync(this.#path, 'utf8');
    check(bytes.endsWith('\n') && Buffer.byteLength(bytes) <= OWNER_INFO_MAX_BYTES, 'owner-info-evidence-gap');
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
  append(batch: ActivationBatch): OwnerInfoEntry {
    const existing = this.entries().find(entry => entry.record.batchId === batch.batchId);
    if (existing) {
      check(existing.record.digest === batch.digest, 'owner-info-conflict');
      return existing;
    }
    check(sha256(batch.payload) === batch.digest, 'owner-info-evidence-gap');
    const record: OwnerInfoRecord = { schema: 'owner-info-entry@1', entryId: randomUUID(), kind: 'memory-activation',
      batchId: batch.batchId, digest: batch.digest, scope: batch.scope, memberCount: batch.events.length,
      payload: batch.payload, writtenAt: new Date().toISOString() };
    // The cap is checked before writing, so a rejected append never makes the carrier unreadable.
    appendDurably(this.#path, JSON.stringify(record) + '\n', OWNER_INFO_MAX_BYTES, 'owner-info');
    const durable = this.entries().find(entry => entry.record.entryId === record.entryId);
    check(durable, 'owner-info-ack-failed');
    return durable;
  }
}

function openOwnerInfo(sandbox: Sandbox): OwnerInfoLog | null {
  try { return new OwnerInfoLog(sandbox); }
  catch (error) { emit('owner-info-unavailable', { level: 'warning', reason: (error as Error).message }); return null; }
}

export const OWNER_SCENARIOS = ['success', 'crash-before-activation-commit', 'crash-after-activation-commit', 'crash-before-info-append',
  'crash-after-info-append', 'crash-after-info-delivery', 'crash-before-info-read', 'crash-after-info-read'] as const;
export type OwnerScenario = typeof OWNER_SCENARIOS[number];

// Every remember-result carries the same fields; store-backed ones fill the record fields.
function report(via: 'live' | 'backfill', status: string, level: 'info' | 'warning' | 'error', fields: Record<string, unknown>): void {
  emit('remember-result', { via, status, stage: null, reason: null, level, info: 'not-applicable', input: null, recordId: null,
    type: null, content: null, batchId: null, range: null, verifier: null, ...fields });
}
const snapshot = (record: MemoryRecord) => ({ revisionId: record.revisionId, type: record.type, content: record.content,
  lifecycle: record.lifecycle, verification: record.verification });
const counts = (rows: HostInfo[]) => ({ pending: rows.filter(row => row.delivery === 'pending').length,
  unread: rows.filter(row => row.read === 'unread').length });

// Short, non-authoritative notice; the durable owner entry and the expand view carry the full manifest.
function notice(batch: ActivationBatch) {
  return batch.events.map(event => {
    const chars = Array.from(event.after.content);
    return { eventId: event.eventId, recordId: event.recordId, type: event.after.type, lifecycle: event.after.lifecycle,
      content: chars.slice(0, NOTICE_CHARS).join(''), truncated: chars.length > NOTICE_CHARS };
  });
}

class OwnerMemoryHost {
  readonly probe: ReturnType<typeof openProbe>;
  readonly log: OwnerInfoLog | null;
  readonly #scenario: OwnerScenario;
  readonly #noActiveProject: boolean;
  constructor(probe: ReturnType<typeof openProbe>, log: OwnerInfoLog | null, scenario: OwnerScenario, noActiveProject: boolean) {
    this.probe = probe; this.log = log; this.#scenario = scenario; this.#noActiveProject = noActiveProject;
  }
  #kill(point: OwnerScenario): void {
    if (this.#scenario === point) killPoint('owner-checkpoint', point, 10000);
  }

  /**
   * Registers and presents every pending Info batch. It never throws: a failure after the
   * canonical commit is reported as a known outcome and the batch stays pending for recovery.
   */
  deliver(): boolean {
    const { store, activity } = this.probe;
    for (;;) {
      let pending: HostInfo[], more: boolean;
      try { ({ pending, more } = store.registerHostInfo(activity)); }
      catch (error) {
        emit('info-error', { level: 'error', batchId: null, delivery: 'pending-redelivery', reason: (error as Error).message });
        return false;
      }
      if (!this.log) return pending.length === 0 && !more;
      for (const info of pending) {
        this.#kill('crash-before-info-append');
        let batch: ActivationBatch, entry: OwnerInfoEntry;
        try {
          batch = store.readActivationBatch(activity, info.batchId);
          entry = this.log.append(batch);
          this.#kill('crash-after-info-append');
          store.recordHostInfoDelivery(activity, { batchId: info.batchId, digest: info.digest,
            entryId: entry.record.entryId, entryHash: entry.entryHash });
        } catch (error) {
          emit('info-error', { level: 'error', batchId: info.batchId, delivery: 'pending-redelivery', reason: (error as Error).message });
          return false;
        }
        this.#kill('crash-after-info-delivery');
        emit('info-notice', { level: 'info', authoritative: false, batchId: info.batchId, digest: info.digest, memberCount: info.memberCount,
          delivery: 'delivered', read: info.read, entryId: entry.record.entryId, members: notice(batch) });
      }
      if (!more) return true;
    }
  }

  #delivered(batchId: string): boolean {
    try { return this.probe.store.listHostInfo(this.probe.activity).some(item => item.batchId === batchId && item.delivery === 'delivered'); }
    catch { return false; }
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
        ? store.withActivity(activity, () => { store.rememberMemory(activity, request); return killPoint('owner-checkpoint', this.#scenario, 10000); })
        : store.rememberMemory(activity, request);
    } catch (error) {
      report(via, 'error', 'error', { committed: false, reason: (error as Error).message, input: input.eventId });
      return null;
    }
    if (via === 'live' && result.status === 'activated') this.#kill('crash-after-activation-commit');
    this.drain();
    let info = 'not-applicable';
    if (result.batchId) {
      const delivered = this.deliver() && this.#delivered(result.batchId);
      info = delivered ? 'delivered' : this.log ? 'pending-redelivery' : 'unavailable';
    }
    if (via === 'live' || result.status === 'activated') {
      report(via, result.status, info === 'pending-redelivery' ? 'error' : result.status === 'blocked' ? 'warning' : 'info', {
        stage: result.stage, reason: result.reason, info, input: input.eventId, recordId: result.record.recordId, type: result.record.type,
        content: result.record.content, batchId: result.batchId, range: result.range.map(ref => ref.eventId),
        verifier: result.verification?.verifier ?? null });
    }
    return result;
  }

  /** Durable owner events whose capture was lost (for example a crash before commit) are backfilled by source identity. */
  backfill(): void {
    const events = this.probe.archive.events();
    let actionable = 0;
    for (const event of events) {
      if (event.role !== 'user') continue;
      if (isUntypedRemember(event.text)) {
        const queued = this.probe.store.queueOwnerCapture(this.probe.activity, event.ack, this.#noActiveProject);
        report('backfill', 'needs-input', 'warning', { ...queued, input: event.ack.eventId });
        actionable++;
      } else if (fastLaneInput(event.text)) {
        actionable++;
        this.remember(event.ack, 'backfill');
      }
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
    // Ticket 14: stable batch/update event IDs, frozen before/after, and query-time canonical state.
    emit('info-view', { batchId, digest: view.info.digest, entryId: entry.record.entryId, members: view.batch.events.map((event, index) => {
      const member = view.members[index]!;
      return { eventId: event.eventId, recordId: event.recordId, outcome: event.kind, before: snapshot(event.before), after: snapshot(event.after),
        current: member.current ? snapshot(member.current) : null, changed: member.changed, unavailable: member.unavailable };
    }) });
    this.#kill('crash-before-info-read');
    const read = store.acknowledgeHostInfo(activity, batchId);
    this.#kill('crash-after-info-read');
    emit('info-read', { batchId, read: read.read, readAt: read.readAt });
  }

  /** Lists without presenting or settling read; registering first keeps committed batches queryable. */
  listInfo(): void {
    const { store, activity } = this.probe;
    while (store.registerHostInfo(activity).more);
    const rows = store.listHostInfo(activity);
    emit('info-list', { ...counts(rows), rows: rows.map(row => ({ batchId: row.batchId, memberCount: row.memberCount, delivery: row.delivery, read: row.read })) });
  }

  ask(question: string): void {
    const { store, activity, session } = this.probe;
    if (parseOwnerStatement(question) || isUntypedRemember(question) || isOwnerAgreement(question) || isOwnerDecline(question)) {
      emit('ask-refused', { reason: 'owner-statement-not-question' }); return;
    }
    // Ticket 14: a committed batch whose presentation is missing is recovered before the next dispatch.
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

/** Owner events the fast lane acts on: a typed statement or an agreement envelope (a malformed one is an evidence gap). */
function fastLaneInput(text: string): boolean {
  if (parseOwnerStatement(text)) return true;
  try { return Boolean(parseOwnerAgreement(text)); } catch { return true; }
}

export interface RememberOptions { hostInfo: 'durable' | 'unavailable'; noActiveProject: boolean; scenario: string; syntheticProposals: boolean }

export async function runRememberSession(sandbox: Sandbox, options: RememberOptions): Promise<void> {
  check((OWNER_SCENARIOS as readonly string[]).includes(options.scenario), 'invalid-owner-scenario');
  const probe = openProbe(sandbox, OWNER_BUDGET, undefined, undefined, undefined, true);
  const lines = createInterface({ input: process.stdin });
  try {
    const log = options.hostInfo === 'durable' ? openOwnerInfo(sandbox) : null;
    const host = new OwnerMemoryHost(probe, log, options.scenario as OwnerScenario, options.noActiveProject);
    host.backfill();
    host.drain();
    host.deliver();
    emit('remember-ready', { pid: process.pid, hostInfo: log ? 'durable' : 'unavailable', infoPath: log?.path ?? null,
      ...counts(probe.store.listHostInfo(probe.activity)), syntheticProposals: options.syntheticProposals,
      commands: [...OWNER_MEMORY_FORMS, ...(options.syntheticProposals ? ['propose <text>'] : []), '同意', '取消', 'info', 'info <batchId>', 'ask <question>', 'stop'] });
    const archive = (text: string): SourceAck | null => {
      try { return probe.archive.append(randomUUID(), text); }
      catch (error) { report('live', 'error', 'error', { committed: false, reason: (error as Error).message }); return null; }
    };
    for await (const raw of lines) {
      const line = raw.trim();
      try {
        if (line === 'stop') break;
        if (line === 'info') { host.listInfo(); continue; }
        if (line.startsWith('info ')) { host.showInfo(line.slice(5).trim()); continue; }
        if (line.startsWith('ask ')) { host.ask(line.slice(4).trim()); continue; }
        if (line.startsWith('propose ')) {
          // Synthetic stand-in for a model proposal (no real provider in this slice); off unless explicitly enabled.
          if (!options.syntheticProposals) { emit('command-rejected', { reason: 'synthetic-proposals-disabled' }); continue; }
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
          if (!target) report('live', 'not-actionable', 'warning', { reason: 'agreement-target-missing', input: ack.eventId });
          else if (isOwnerDecline(line)) report('live', 'cancelled', 'info', { reason: 'owner-declined', input: ack.eventId, range: [target.eventId] });
          else host.remember(ack, 'live');
          continue;
        }
        if (parseOwnerStatement(line)) { const ack = archive(line); if (ack) host.remember(ack, 'live'); continue; }
        if (isUntypedRemember(line)) {
          const ack = archive(line);
          if (ack) {
            const queued = probe.store.queueOwnerCapture(probe.activity, ack, options.noActiveProject);
            report('live', 'needs-input', 'warning', { ...queued, input: ack.eventId, accepted: OWNER_MEMORY_FORMS });
          }
          continue;
        }
        emit('command-rejected', { reason: 'owner-memory-command-required', accepted: OWNER_MEMORY_FORMS });
      } catch (error) { emit('command-error', { reason: (error as Error).message }); }
    }
  } finally { lines.close(); probe.close(); }
}

/** Queries Info without an agent session; listing never settles unread, opening a batch does. */
export function runInfoQuery(sandbox: Sandbox, batchId?: string): void {
  const probe = openProbe(sandbox, OWNER_BUDGET, undefined, undefined, undefined, true);
  try {
    const host = new OwnerMemoryHost(probe, openOwnerInfo(sandbox), 'success', false);
    if (batchId) host.showInfo(batchId); else host.listInfo();
  } finally { probe.close(); }
}
