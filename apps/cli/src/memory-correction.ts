import { AgentRun, MemoryCorrections, check, parseCorrectionCommand } from '@euler/core';
import type { CorrectionInput, CorrectionReply, MemoryPresentation, ToolCall } from '@euler/core';
import { configuredTransport, verifyTransportPrerequisites } from './model-transport.ts';
import { pumpAgent } from './agent-pump.ts';
import { killPoint } from './kill-point.ts';

export const CORRECTION_SCENARIOS = ['correction-before-record', 'correction-after-record', 'correction-after-output',
  'correction-after-commit', 'correction-after-owner', 'correction-after-model', 'correction-unknown', 'correction-preview-unavailable'] as const;
import type { openProbe } from './probe.ts';

const emit = (event: string, value: object): Promise<void> => new Promise((resolve, reject) => {
  process.stdout.write(JSON.stringify({ event, ...value }) + '\n', error => error ? reject(error) : resolve());
});

/** The existing CLI input loop owns this adapter; all operation identity, approval and CAS stay in Core. */
export class CorrectionHost {
  readonly core: MemoryCorrections;
  readonly #probe: ReturnType<typeof openProbe>;
  readonly #scenario: string;
  readonly #transportConfig: string | undefined;
  readonly #recoverInfo: () => boolean;
  #configured: ReturnType<typeof configuredTransport> | null = null;
  #run: AgentRun | null = null;
  readonly #setupAbort = new AbortController();
  constructor(probe: ReturnType<typeof openProbe>, options: { scenario?: string; transportConfig?: string; recoverInfo?: () => boolean } = {}) {
    this.#probe = probe; this.#scenario = options.scenario ?? 'success'; this.#transportConfig = options.transportConfig;
    this.#recoverInfo = options.recoverInfo ?? (() => true);
    this.core = new MemoryCorrections(probe.store, probe.activity, probe.archive);
  }
  #checkpoint(point: string): void {
    if (this.#scenario === point) killPoint('correction-checkpoint', point, 10000);
  }

  receive(text: string): CorrectionInput | null {
    if (text.trim() === 'stop') { this.#setupAbort.abort(); this.#run?.cancel(); return null; }
    return /^(inspect|correct|commit|cancel|replay|model)(?: |$)/.test(text.trim()) || /^(把 |不要|别|是否|帮我判断|恢复被|撤销彻底|do not |don't )/i.test(text)
      ? this.core.receive(text) : null;
  }

  async present(presentation: MemoryPresentation, kind: 'inspect' | 'preview'): Promise<void> {
    if (kind === 'preview' && this.#scenario === 'correction-preview-unavailable') throw new Error('injected-presentation-unavailable');
    await emit(`memory-${kind}`, { ...presentation,
      ...(kind === 'preview' ? { diff: { before: presentation.targets[0]!.content, after: presentation.content },
        status: 'pending', note: '预览时 canonical 内容；提交后保留 lifecycle，新正文先标 unverified 并排入复验。',
        command: `commit ${presentation.token} ${JSON.stringify(presentation.content)}`, cancel: `cancel ${presentation.token}` } : {}) });
    if (kind === 'preview') this.#checkpoint('correction-after-output');
    this.core.presented(presentation);
  }

  async recover(): Promise<void> {
    await this.deliver();
    for (const presentation of this.core.pending()) {
      this.#probe.store.registerCorrectionDelivery(this.#probe.activity, presentation.token);
      try { await this.present(presentation, 'preview'); }
      catch (error) { await emit('memory-result', { status: 'unavailable', canonical: 'unchanged', operationId: presentation.operationId, reason: (error as Error).message }); }
    }
  }

  async deliver(): Promise<boolean> {
    const { store, activity, archive } = this.#probe;
    try {
      for (const { token, result, delivery } of store.correctionDeliveries(activity)) {
        if (!delivery.ownerDelivered) {
          await emit('memory-owner-entry', { operationId: result.operationId, result,
            receipts: result.receiptIds.map(id => store.readOwnerReceipt(activity, id)) });
          store.acknowledgeCorrectionOwner(activity, token);
          this.#checkpoint('correction-after-owner');
        }
        if (!delivery.model) {
          const summary = store.correctionSummary(activity, token);
          const source = archive.append(delivery.summaryEventId, JSON.stringify(summary), 'tool');
          store.acknowledgeCorrectionModel(activity, token, source);
          this.#checkpoint('correction-after-model');
          await emit('memory-model-summary', { summary });
        }
      }
      return true;
    } catch (error) {
      await emit('memory-delivery-error', { status: 'error', reason: (error as Error).message });
      return false;
    }
  }

  async show(reply: CorrectionReply): Promise<void> {
    if (reply.kind !== 'result') {
      if (!await this.deliver()) { await emit('memory-result', { status: 'unavailable', canonical: 'unchanged', reason: 'operation-presentation-recovery-required' }); return; }
      await this.present(reply.presentation, reply.kind); return;
    }
    const delivered = await this.deliver();
    await emit('memory-result', { ...reply.result, ...(delivered ? {} : { status: 'error', reason: 'operation-presentation-recovery-required' }), canonical: reply.canonical,
      ...('verification' in reply ? { verification: reply.verification } : {}) });
  }

  async model(input: CorrectionInput, text: string): Promise<void> {
    if (!this.#transportConfig) {
      await emit('memory-model-evidence-gap', { reason: 'explicit-route-model-auth-budget-required', sends: 0 }); return;
    }
    if (!await this.deliver() || !this.#recoverInfo()) return;
    if (!this.#configured) {
      const configured = configuredTransport(this.#transportConfig);
      try { await verifyTransportPrerequisites(['memory-correction'], 'correction-prerequisites', this.#setupAbort.signal); }
      catch (error) {
        if (!this.#setupAbort.signal.aborted) throw error;
        await emit('memory-model-cancelled', { sends: 0, reason: 'owner-stopped-before-send' }); return;
      }
      this.#configured = configured;
    }
    const { transport, model, authNamespace, budget } = this.#configured;
    const { store, activity, archive } = this.#probe;
    const source = archive.lookup(input.eventId);
    check(source, 'live-input-evidence-gap');
    const run = new AgentRun(store, activity, { binding: source.binding,
      source: archive, memoryCorrections: true, encode: transport.encode.bind(transport) },
      { provider: model.provider, model: model.id, route: model.baseUrl, authNamespace }, budget);
    run.receive(input.eventId, text);
    this.#run = run;
    if (this.#setupAbort.signal.aborted) run.cancel();
    const status = await pumpAgent(run, { stream: transport.stream.bind(transport),
      recoverInfo: () => { store.correctionModelSummaries(activity); return this.#recoverInfo(); },
      execute: async call => {
        const reply = await this.handle(input, text, call);
        check(reply, 'operation-response-unavailable');
        if (reply.kind !== 'result') return JSON.stringify({ status: reply.kind === 'preview' ? 'pending' : 'inspected',
          token: reply.presentation.token, operationId: reply.presentation.operationId });
        return JSON.stringify({ status: reply.result.status, operationId: reply.result.operationId,
          canonical: reply.canonical, reason: reply.result.reason && /^[a-z][a-z0-9-]{0,80}$/.test(reply.result.reason)
            ? reply.result.reason : reply.result.reason ? 'operation-failed' : null });
      } }).finally(() => { this.#run = null; });
    await emit('memory-model-result', { runId: run.runId, terminal: status.terminal, attempts: status.attempts });
  }

  async handle(input: CorrectionInput, text: string, intent?: ToolCall): Promise<CorrectionReply | void> {
    const command = parseCorrectionCommand(text);
    try {
      if (text.startsWith('model ') && !intent) { await this.model(input, text); return; }
      if (command?.kind === 'correct') this.#checkpoint('correction-before-record');
      const reply = this.core.handle(input, intent);
      if (reply.kind === 'preview') this.#checkpoint('correction-after-record');
      if (reply.kind === 'result' && reply.canonical === 'committed' && command?.kind === 'commit') {
        this.#checkpoint('correction-after-commit');
        if (this.#scenario === 'correction-unknown') throw new Error('injected-unknown-commit');
      }
      if (command?.kind === 'replay' && reply.kind === 'result' && reply.result.operationId) {
        await emit('memory-owner-entry', { operationId: reply.result.operationId, result: reply.result,
          receipts: reply.result.receiptIds.map(id => this.#probe.store.readOwnerReceipt(this.#probe.activity, id)) });
      }
      await this.show(reply);
      return reply;
    }
    catch (error) {
      // Both input paths reconcile a lost commit acknowledgement against canonical state.
      if (command?.kind === 'commit' && (!text.startsWith('model ') || intent)) {
        try {
          const reply = this.core.result(command.token);
          await this.show(reply); return reply;
        } catch {
          const reply: CorrectionReply = { kind: 'result', result: { status: 'error', operationId: null, receiptIds: [],
            reason: 'operation-reconciliation-required' }, canonical: 'unknown' };
          await emit('memory-result', { ...reply.result, canonical: reply.canonical, token: command.token }); return reply;
        }
      }
      const reply: CorrectionReply = { kind: 'result', result: { status: command?.kind === 'correct' ? 'unavailable' : 'error',
        operationId: null, receiptIds: [], reason: (error as Error).message }, canonical: 'unchanged' };
      await emit('memory-result', { ...reply.result, canonical: reply.canonical }); return reply;
    }
  }
}
