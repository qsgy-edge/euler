import { randomUUID } from 'node:crypto';
import { check } from '../contracts.ts';
import type { HostAdapter, SourceAck } from '../contracts.ts';
import type { Activity, MemoryOperationResult, MemoryPresentation, ProbeStore } from '../store/probe-store.ts';
import type { ToolCall } from './agent-state.ts';

export interface CorrectionInput { readonly eventId: string }
export type CorrectionCommand = { kind: 'inspect'; recordId: string }
  | { kind: 'forget'; recordId: string } | { kind: 'restore'; recordId: string }
  | { kind: 'rollback'; batchId: string; eventIds: string[] }
  | { kind: 'correct'; recordId: string; content: string }
  | { kind: 'commit'; token: string; content: string }
  | { kind: 'commit'; token: string; operation: 'forget' | 'restore' | 'rollback' }
  | { kind: 'cancel'; token: string } | { kind: 'replay'; token: string };
export type CorrectionReply = { kind: 'inspect' | 'preview'; presentation: MemoryPresentation }
  | { kind: 'result'; result: MemoryOperationResult; canonical: 'committed' | 'unchanged' | 'unknown';
    verification?: 'queued'; reason?: string }
  | { kind: 'result'; result: { status: 'not_actionable' | 'conflict' | 'no_op' | 'invalid_identity' | 'unavailable' | 'error';
    operationId: null; receiptIds: []; reason: string }; canonical: 'unchanged' | 'unknown' };

const identity = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** A small, explicit input grammar. Open language is a request to restate, never mutation authority. */
export function parseCorrectionCommand(text: string): CorrectionCommand | null {
  if (text.startsWith('model ')) text = text.slice(6);
  const simple = new RegExp(`^(inspect|forget|restore|cancel|replay) (${identity})$`).exec(text.trim());
  if (simple) return simple[1] === 'cancel' || simple[1] === 'replay' ? { kind: simple[1], token: simple[2]! }
    : { kind: simple[1] as 'inspect' | 'forget' | 'restore', recordId: simple[2]! };
  const rollback = new RegExp(`^rollback (${identity})((?: ${identity})+)$`).exec(text.trim());
  if (rollback) return { kind: 'rollback', batchId: rollback[1]!, eventIds: rollback[2]!.trim().split(' ') };
  const approval = new RegExp(`^commit (${identity}) (forget|restore|rollback)$`).exec(text.trim());
  if (approval) return { kind: 'commit', token: approval[1]!, operation: approval[2] as 'forget' | 'restore' | 'rollback' };
  const change = new RegExp(`^(correct|commit) (${identity}) ([\\s\\S]+)$`).exec(text.trim());
  if (change) {
    let content: unknown;
    try { content = JSON.parse(change[3]!); } catch { return null; }
    if (typeof content !== 'string') return null;
    return change[1] === 'correct' ? { kind: 'correct', recordId: change[2]!, content }
      : { kind: 'commit', token: change[2]!, content };
  }
  // The body is isolated before any direction/negation checks.
  const chinese = new RegExp(`^把 (${identity}) 改为「([\\s\\S]*)」$`).exec(text.trim());
  return chinese ? { kind: 'correct', recordId: chinese[1]!, content: chinese[2]! } : null;
}

export function isLiveMemoryOperation(kind: MemoryPresentation['kind']): boolean {
  return kind === 'correct' || kind === 'forget' || kind === 'restore' || kind === 'rollback';
}

export function matchesMemoryApproval(command: CorrectionCommand | null, presentation: MemoryPresentation): boolean {
  return command?.kind === 'commit' && command.token === presentation.token
    && ('operation' in command ? command.operation === presentation.kind && presentation.content === null
      : presentation.kind === 'correct' && command.content === presentation.content);
}

export const MEMORY_SUMMARY_MAX_BYTES = 2048;
/** Versioned model plane: identifiers and terminal state only; never canonical body, source or owner receipt. */
export function memoryOperationSummary(presentation: MemoryPresentation, result: MemoryOperationResult) {
  check(isLiveMemoryOperation(presentation.kind) && result.operationId === presentation.operationId
    && result.status !== 'pending' && result.status !== 'invalid_identity', 'operation-not-settled');
  const records = (result.current.length ? result.current : result.expected).map(record => ({ recordId: record.recordId,
    revisionId: record.revisionId, revision: record.revision, lifecycle: record.lifecycle, verification: record.verification }));
  const summary = { schema: 'memory-operation-summary@1', operationId: result.operationId, kind: presentation.kind,
    status: result.status, records, reason: result.reason && /^[a-z][a-z0-9-]{0,80}$/.test(result.reason) ? result.reason
      : result.reason ? 'operation-failed' : null,
    ...(presentation.kind === 'rollback' ? { recordCount: presentation.targets.length, truncated: false } : {}) };
  if (presentation.kind === 'rollback') {
    summary.truncated = records.length !== presentation.targets.length;
    while (records.length && Buffer.byteLength(JSON.stringify(summary)) > MEMORY_SUMMARY_MAX_BYTES) {
      records.pop(); summary.truncated = true;
    }
  }
  check(Buffer.byteLength(JSON.stringify(summary)) <= MEMORY_SUMMARY_MAX_BYTES, 'operation-summary-limit');
  return summary;
}

export class MemoryCorrections {
  readonly #store: ProbeStore;
  readonly #activity: Activity;
  readonly #source: HostAdapter['source'];
  readonly #live = new WeakMap<CorrectionInput, { text: string; source: SourceAck; tokens: Set<string> }>();
  readonly #presented = new Set<string>();
  constructor(store: ProbeStore, activity: Activity, source: HostAdapter['source']) {
    this.#store = store; this.#activity = activity; this.#source = source;
  }

  /** Called only by the Host's live input callback, before asynchronous processing or buffering. */
  receive(text: string): CorrectionInput {
    const eventId = randomUUID();
    const source = this.#source.append(eventId, text);
    const input = Object.freeze({ eventId });
    this.#live.set(input, { text, source, tokens: new Set(this.#presented) });
    return input;
  }

  /** The adapter calls this only after the entire durable presentation has actually been output. */
  presented(presentation: MemoryPresentation): void {
    this.#store.acknowledgeMemoryPresentation(this.#activity, presentation.token, presentation.hash);
    this.#presented.add(presentation.token);
  }

  pending(): MemoryPresentation[] {
    return this.#store.recoverMemoryOperations(this.#activity)
      .filter(item => isLiveMemoryOperation(item.presentation.kind) && item.result.status === 'pending').map(item => item.presentation);
  }

  result(token: string, settled = false): CorrectionReply {
    const result = this.#store.memoryOperationStatus(this.#activity, token);
    if (result.status !== 'invalid_identity' && !isLiveMemoryOperation(this.#store.readMemoryPresentation(this.#activity, token).kind)) {
      return this.#reject('invalid_identity', 'correction-token-required');
    }
    return { kind: 'result', result: settled && result.status !== 'pending' && result.status !== 'invalid_identity'
      ? { ...result, status: 'settled' } : result,
      canonical: result.status === 'committed' ? 'committed' : 'unchanged',
      ...(result.status === 'committed' && this.#store.correctionVerificationQueued(this.#activity, token)
        ? { verification: 'queued' as const } : {}) };
  }

  handle(input: CorrectionInput, intent?: ToolCall): CorrectionReply {
    const live = this.#live.get(input);
    if (!live) return this.#reject('invalid_identity', 'live-input-required');
    const source = this.#source.read(live.source);
    check(source.role === 'user' && source.text === live.text, 'live-input-evidence-gap');
    const command = parseCorrectionCommand(live.text);
    if (!command) {
      const request = live.text.startsWith('model ') ? live.text.slice(6) : live.text;
      if (/^(commit|cancel|replay)(?: |$)/.test(request)) return this.#reject('invalid_identity', 'token-and-actual-text-required');
      if (/^(不要|别|do not |don't )/i.test(request.trim())) return this.#reject('no_op', 'owner-declined');
      const outside = request.replaceAll('不可恢复', '').replaceAll('不可撤销', '');
      if (!/[?？]/.test(live.text) && /(删除|清除|delete|purge)/i.test(outside)
        && /(彻底|永久|不可恢复|不可撤销|purge)/i.test(live.text) && /(恢复|撤销|回滚|restore|rollback)/i.test(outside)) {
        return this.#reject('conflict', 'opposing-directions');
      }
      return this.#reject('not_actionable', 'explicit-correction-command-required');
    }
    if (intent && !this.#matches(command, intent)) return this.#reject('invalid_identity', 'intent-input-mismatch');
    const { kind } = command;
    if (kind === 'replay') return this.result(command.token);
    if (kind === 'inspect') {
      return { kind: 'inspect', presentation: this.#store.inspectMemoryPresentation(this.#activity, [command.recordId]) };
    }
    if (kind === 'correct') {
      const inspected = this.#store.inspectMemoryPresentation(this.#activity, [command.recordId]);
      const before = inspected.targets[0]!;
      if (before.lifecycle === 'tombstoned') return this.#reject('not_actionable', 'tombstoned-not-actionable');
      const normalized = command.content.trim().normalize('NFC');
      if (!normalized || normalized === before.content.trim().normalize('NFC')) return this.#reject('no_op', 'unchanged-content');
      // Leave room for the token and command inside the Host's 64 KiB input limit, including JSON escapes.
      if (Buffer.byteLength(JSON.stringify(command.content)) > 60000) return this.#reject('unavailable', 'correction-content-too-large');
      const presentation = this.#store.withActivity(this.#activity, () => {
        const preview = this.#store.previewMemoryOperation(this.#activity, inspected.token,
          { kind: 'correct', input: live.source, content: command.content });
        this.#store.registerCorrectionDelivery(this.#activity, preview.token);
        return preview;
      });
      return { kind: 'preview', presentation };
    }
    if (kind === 'forget' || kind === 'restore') {
      const inspected = this.#store.inspectMemoryPresentation(this.#activity, [command.recordId]);
      if (inspected.targets[0]!.lifecycle !== (kind === 'forget' ? 'active' : 'tombstoned')) {
        return this.#reject('not_actionable', 'memory-not-actionable');
      }
      const presentation = this.#store.withActivity(this.#activity, () => {
        const preview = this.#store.previewMemoryOperation(this.#activity, inspected.token, { kind });
        this.#store.registerCorrectionDelivery(this.#activity, preview.token);
        return preview;
      });
      return { kind: 'preview', presentation };
    }
    if (kind === 'rollback') {
      const presentation = this.#store.withActivity(this.#activity, () => {
        const { batch } = this.#store.readHostInfo(this.#activity, command.batchId);
        check(command.eventIds.length > 0 && command.eventIds.length <= batch.events.length
          && new Set(command.eventIds).size === command.eventIds.length, 'invalid-batch-selection');
        const selected = command.eventIds.map(id => {
          const event = batch.events.find(event => event.eventId === id);
          check(event, 'invalid-batch-selection');
          return event;
        });
        const inspected = this.#store.inspectMemoryPresentation(this.#activity, selected.map(event => event.recordId));
        const preview = this.#store.previewMemoryOperation(this.#activity, inspected.token,
          { kind, batchId: batch.batchId, eventIds: command.eventIds });
        this.#store.registerCorrectionDelivery(this.#activity, preview.token);
        return preview;
      });
      return { kind: 'preview', presentation };
    }
    const status = this.#store.memoryOperationStatus(this.#activity, command.token);
    if (status.status !== 'pending') return this.result(command.token, true);
    const presentation = this.#store.readMemoryPresentation(this.#activity, command.token);
    if (!isLiveMemoryOperation(presentation.kind)) return this.#reject('invalid_identity', 'correction-token-required');
    if (kind === 'cancel') {
      const result = this.#store.cancelMemoryOperation(this.#activity, command.token);
      return { kind: 'result', result, canonical: 'unchanged' };
    }
    if (!matchesMemoryApproval(command, presentation)) return this.#reject('invalid_identity', 'submitted-content-mismatch');
    if (!live.tokens.has(command.token)) return this.#reject('unavailable', 'presentation-before-live-input-required');
    // No source scan can create this live capability. A fresh event carries the actual text and opaque token.
    this.#live.delete(input);
    this.#store.withActivity(this.#activity, () => {
      this.#store.recordCorrectionApproval(this.#activity, command.token, live.source);
      this.#store.commitMemoryOperation(this.#activity, command.token, { reverify: true });
    });
    return this.result(command.token);
  }

  #matches(command: CorrectionCommand, intent: ToolCall): boolean {
    const expected = command.kind === 'inspect' ? { name: 'memory.inspect', arguments: { recordId: command.recordId } }
      : command.kind === 'correct' ? { name: 'memory.preview', arguments: { recordId: command.recordId, content: command.content } }
      : command.kind === 'forget' || command.kind === 'restore'
        ? { name: 'memory.preview', arguments: { recordId: command.recordId, operation: command.kind } }
      : command.kind === 'rollback' ? { name: 'memory.preview', arguments: { operation: 'rollback', batchId: command.batchId, eventIds: command.eventIds } }
      : command.kind === 'commit' ? { name: 'memory.commit', arguments: 'operation' in command
        ? { token: command.token, operation: command.operation } : { token: command.token, content: command.content } }
      : { name: command.kind === 'cancel' ? 'memory.cancel' : 'memory.status', arguments: { token: command.token } };
    return intent.name === expected.name && Object.keys(intent.arguments).sort().join(',') === Object.keys(expected.arguments).sort().join(',')
      && Object.entries(expected.arguments).every(([key, value]) => JSON.stringify(intent.arguments[key]) === JSON.stringify(value));
  }

  #reject(status: 'not_actionable' | 'conflict' | 'no_op' | 'invalid_identity' | 'unavailable', reason: string): CorrectionReply {
    return { kind: 'result', result: { status, operationId: null, receiptIds: [], reason }, canonical: 'unchanged' };
  }
}
