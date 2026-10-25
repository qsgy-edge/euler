import fixture from '../../../fixtures/t13-capture-cases.json' with { type: 'json' };
import { CaptureRun, check, DEFAULT_BUDGET, sha256 } from '@euler/core';
import type { CaptureConfig, CaptureJob, ProbeBudget, SourceAck } from '@euler/core';
import type { AgentPump } from './agent-pump.ts';
import { pumpCapture } from './agent-pump.ts';
import { configuredTransport, verifyTransportPrerequisites } from './model-transport.ts';
import { openProbe } from './probe.ts';
import type { Sandbox } from './sandbox.ts';

type Probe = ReturnType<typeof openProbe>;

/** One explicitly configured test route, with independent role contexts and no ambient credential discovery. */
export function createCaptureWorker(path?: string, onFailure?: (error: unknown) => void, recoverInfo?: () => boolean,
  consumer: CaptureJob['consumer'] = 'memory') {
  let configured: ReturnType<typeof configuredTransport> | null = null, setupError: unknown;
  if (path) {
    try { configured = configuredTransport(path); check(configured.captureCapability, 'capture-capability-required'); }
    catch (error) { setupError = error; }
  }
  let prerequisites = false;
  const run = async (probe: Probe, foregroundActive = false, signal?: AbortSignal): Promise<CaptureJob[]> => {
    const report = (jobs: CaptureJob[]) => {
      console.log(JSON.stringify({ event: 'capture-queue', consumer, jobs: jobs.map(job => ({ jobId: job.jobId, stage: job.stage,
        reason: job.reason, recordId: job.record?.recordId ?? null, verification: job.record?.verification ?? null,
        lifecycle: job.record?.lifecycle ?? null, level: job.stage === 'unknown' ? 'error'
          : job.stage === 'blocked' || job.stage === 'pending' && job.reason ? 'warning' : 'info' })) }));
      return jobs;
    };
    const defer = (reason: Parameters<Probe['store']['deferCaptureJobs']>[1]) => report(probe.store.deferCaptureJobs(probe.activity, reason, consumer));
    if (!probe.store.listCaptureJobs(probe.activity, 1, true, consumer).length) return [];
    if (!path) return defer('capture-route-unavailable');
    if (setupError) { defer('capture-configuration-unavailable'); throw setupError; }
    if (consumer === 'memory' && foregroundActive) return defer('foreground-run-active');
    if (consumer === 'memory' && probe.store.captureDrainBlocked(probe.activity)) return defer('request-recovery-required');
    if (recoverInfo?.() === false) return defer('host-info-recovery-required');
    if (!prerequisites) {
      try { await verifyTransportPrerequisites(['capture','capture-run','capture-failure','capture-pump','capture-http-protocol','analysis-proposal','proposal-approval',
        ...(consumer === 'historian' ? ['historian'] : [])], `${consumer === 'historian' ? 'historian' : 'capture'}-prerequisites`, signal); }
      catch (error) { defer(signal?.aborted ? 'capture-stopped' : 'prerequisite-evidence-gap'); throw error; }
      prerequisites = true;
    }
    signal?.throwIfAborted();
    if (consumer === 'memory' && probe.store.captureDrainBlocked(probe.activity)) return defer('foreground-run-active');
    const selected = configured!, capability = selected.captureCapability!;
    const route = { provider: selected.model.provider, model: selected.model.id, route: selected.model.baseUrl,
      authNamespace: selected.authNamespace, capability };
    return report(await drainCaptures(probe, { batch: 16, deadlineMs: Math.min(30000, selected.budget.wallClockMs), budget: selected.budget,
      config: consumer === 'historian' ? { historian: [route] } : { proposer: [route], verifier: [route] }, encode: selected.transport.encode.bind(selected.transport), adapterVersion: 'capture-http@1',
      ...(signal ? { signal } : {}),
      host: { stream: selected.transport.stream.bind(selected.transport), ...(recoverInfo ? { recoverInfo } : {}) } }));
  };
  let halted = false;
  return async (probe: Probe, foregroundActive = false, signal?: AbortSignal): Promise<CaptureJob[]> => {
    if (halted) return [];
    try { return await run(probe, foregroundActive, signal); }
    catch (error) {
      if (signal?.aborted && error === signal.reason) return [];
      if (!onFailure) throw error;
      halted = true; onFailure(error); return [];
    }
  };
}

export function scheduleCaptures(probe: Probe, path: string | undefined, recoverInfo: () => boolean, consumer: CaptureJob['consumer'] = 'memory') {
  const worker = createCaptureWorker(path, reportCaptureFailure, recoverInfo, consumer), abort = new AbortController();
  let pending = false, foreground = false, running: Promise<void> | undefined;
  const kick = (foregroundActive = false) => {
    if (abort.signal.aborted) return;
    pending = true; foreground = foregroundActive;
    if (running) return;
    running = (async () => {
      do {
        if (path) await new Promise<void>(resolve => setImmediate(resolve));
        if (abort.signal.aborted) return;
        pending = false;
        const jobs = await worker(probe, foreground, abort.signal);
        if (jobs.length && !abort.signal.aborted) recoverInfo();
      } while (pending);
    })().finally(() => { running = undefined; });
  };
  return { kick, async flush() { kick(); await running; },
    async close() { abort.abort(new Error('capture-stopped')); await running; } };
}

export function reportCaptureFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ event: 'capture-error', reason: /^[a-z][a-z0-9-]{1,80}$/.test(message) ? message : 'capture-unavailable',
    diagnosticHash: sha256(message), halted: true }));
}

export async function runCaptureDrain(sandbox: Sandbox, path: string | undefined, recoverInfo: (probe: Probe) => boolean): Promise<void> {
  const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try { console.log(JSON.stringify({ event: 'capture-drained', jobs: (await createCaptureWorker(path, undefined, () => recoverInfo(probe))(probe)).length })); }
  finally { probe.close(); }
}
export async function drainCaptures(probe: Probe, options: { batch: number; deadlineMs: number; budget: ProbeBudget;
  config: CaptureConfig; host: Pick<AgentPump, 'stream' | 'recoverInfo'>; jobId?: string;
  encode?: ConstructorParameters<typeof CaptureRun>[4]; adapterVersion?: string; signal?: AbortSignal }): Promise<CaptureJob[]> {
  check(Number.isSafeInteger(options.batch) && options.batch > 0 && options.batch <= 16
    && Number.isSafeInteger(options.deadlineMs) && options.deadlineMs > 0 && options.deadlineMs <= 30000, 'invalid-capture-drain');
  const deadline = Date.now() + options.deadlineMs;
  const results: CaptureJob[] = [];
  const consumer = options.config.historian ? 'historian' : 'memory';
  const jobs = options.jobId ? [probe.store.readCaptureJob(probe.activity, options.jobId)] : probe.store.listCaptureJobs(probe.activity, options.batch, true, consumer);
  for (const job of jobs) {
    check(job.consumer === consumer, 'capture-consumer-config-mismatch');
    if (options.signal?.aborted || consumer === 'memory' && probe.store.captureDrainBlocked(probe.activity)) break;
    if (Date.now() >= deadline) break;
    let result = job;
    // Each role or fixed comparison gets an isolated lease; all requests consume the same job budget.
    for (let phase = 0; phase <= options.budget.maxModelAttempts && Date.now() < deadline; phase++) {
      if (options.host.recoverInfo?.() === false) {
        const deferred = probe.store.deferCaptureJobs(probe.activity, 'host-info-recovery-required', consumer);
        return [...results, ...deferred.filter(item => !results.some(previous => previous.jobId === item.jobId))];
      }
      const lease = probe.store.claimCaptureJob(probe.activity, job.jobId, options.budget, Math.max(1, deadline - Date.now()));
      if (!lease) { result = probe.store.readCaptureJob(probe.activity, job.jobId); break; }
      if (probe.store.captureDrainBlocked(lease.activity, probe.store.captureRuntime(lease).runId ?? undefined)) {
        probe.store.pauseCapture(lease, 'request-recovery-required');
        result = probe.store.readCaptureJob(probe.activity, job.jobId); break;
      }
      const run = new CaptureRun(probe.store, lease, probe.archive, options.config, options.encode, options.adapterVersion);
      result = await pumpCapture(run, options.host, options.signal);
      if (result.reason === 'host-info-recovery-required' && ['proposing','verifying','comparing'].includes(result.stage)) return [...results, result];
      if (!['verifying','comparing'].includes(result.stage)) break;
    }
    results.push(result);
  }
  return results;
}

export async function runCaptureDemo(sandbox: Sandbox, scenario: string, recoverInfo: (probe: Probe) => boolean): Promise<void> {
  check(['synthetic','block','evidence-gap','protocol','unknown'].includes(scenario), 'capture-synthetic-scenario-required');
  const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const input = probe.archive.append('ca710000-0000-4000-8000-000000000001', fixture.input);
    const job = probe.store.queueOwnerCapture(probe.activity, input);
    const route = { provider: 'synthetic', model: 'capture-fixture', route: 'synthetic-capture', authNamespace: 'synthetic', capability: 'standard' as const };
    const config: CaptureConfig = { proposer: [route, { ...route, model: 'fallback-fixture' }], verifier: [route] };
    const budget = { ...DEFAULT_BUDGET, contextLimit: 20000, maxTotalTokens: 100000, maxModelAttempts: 8 };
    await drainCaptures(probe, { adapterVersion: 'capture-counting@1', jobId: job.jobId, batch: 8, deadlineMs: 30000, budget, config, host: {
      recoverInfo: () => recoverInfo(probe),
      async *stream(request, signal, send) {
        signal.throwIfAborted();
        const attempt = send(request.payload);
        probe.transport.send(request.payload, attempt);
        console.log(JSON.stringify({ event: 'capture-request', request, attemptId: attempt.attemptId, runId: attempt.runId }));
        if (scenario === 'unknown') throw new Error('synthetic-receiver-ack-lost');
        const payload = JSON.parse(request.payload);
        let text = '';
        let calls: { id: string; name: string; arguments: Record<string, unknown> }[] = [];
        if (payload.p3.intent.step === 'proposer') text = scenario === 'protocol' && payload.model === 'capture-fixture'
          ? 'malformed fixture' : JSON.stringify(fixture.claim);
        else if (scenario === 'block' || scenario === 'evidence-gap') text = JSON.stringify({ result: scenario, evidence: [], reason: 'synthetic-negative' });
        else if (payload.p2.length === 0) calls = [{ id: 'find-source', name: 'source.search', arguments: { query: fixture.sourceQuery } }];
        else if (payload.p2.length === 1) {
          const hits = (JSON.parse(payload.p2[0].results[0].modelResult) as { results: { ref: SourceAck }[] }).results;
          check(hits.length > 0, 'synthetic-source-missing');
          calls = [{ id: 'read-source', name: 'source.expand', arguments: { eventId: hits[0]!.ref.eventId, offset: 0, limit: 4096 } }];
        } else {
          const excerpt = JSON.parse(payload.p2[1].results[0].modelResult) as { ref: SourceAck };
          text = JSON.stringify({ result: 'pass', evidence: [excerpt.ref] });
        }
        yield { kind: 'complete' as const, reply: { text, calls, stop: calls.length ? 'tools' as const : 'end' as const } };
      },
    } }).catch(error => {
      if (scenario !== 'unknown' || !(error instanceof Error) || error.message !== 'synthetic-receiver-ack-lost') throw error;
      console.log(JSON.stringify({ event: 'capture-unknown', reason: error.message }));
    });
    console.log(JSON.stringify({ event: 'capture-result', mode: 'synthetic-only', realModelEvidence: 'evidence-gap',
      sends: probe.transport.count, status: probe.store.readCaptureJob(probe.activity, job.jobId) }));
  } finally { probe.close(); }
}
