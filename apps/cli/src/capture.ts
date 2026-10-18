import fixture from '../../../fixtures/t13-capture-cases.json' with { type: 'json' };
import { CaptureRun, check, DEFAULT_BUDGET } from '@euler/core';
import type { CaptureConfig, CaptureJob, ProbeBudget, SourceAck } from '@euler/core';
import type { AgentPump } from './agent-pump.ts';
import { pumpCapture } from './agent-pump.ts';
import { openProbe } from './probe.ts';
import type { Sandbox } from './sandbox.ts';

type Probe = ReturnType<typeof openProbe>;
export async function drainCaptures(probe: Probe, options: { batch: number; deadlineMs: number; budget: ProbeBudget;
  config: CaptureConfig; host: Pick<AgentPump, 'stream'>; jobId?: string;
  encode?: ConstructorParameters<typeof CaptureRun>[4] }): Promise<CaptureJob[]> {
  check(Number.isSafeInteger(options.batch) && options.batch > 0 && options.batch <= 16
    && Number.isSafeInteger(options.deadlineMs) && options.deadlineMs > 0 && options.deadlineMs <= 30000, 'invalid-capture-drain');
  const deadline = Date.now() + options.deadlineMs;
  const results: CaptureJob[] = [];
  const jobs = options.jobId ? [probe.store.readCaptureJob(probe.activity, options.jobId)] : probe.store.listCaptureJobs(probe.activity, options.batch, true);
  for (const job of jobs) {
    if (Date.now() >= deadline) break;
    let result = job;
    // Each role gets one lease/primary+fallback chain; job identity and cumulative budget remain fixed.
    for (let phase = 0; phase < 2 && Date.now() < deadline; phase++) {
      const lease = probe.store.claimCaptureJob(probe.activity, job.jobId, options.budget, Math.max(1, deadline - Date.now()));
      if (!lease) { result = probe.store.readCaptureJob(probe.activity, job.jobId); break; }
      const run = new CaptureRun(probe.store, lease, probe.archive, options.config, options.encode);
      result = await pumpCapture(run, options.host);
      if (result.stage !== 'verifying') break;
    }
    results.push(result);
  }
  return results;
}

export async function runCaptureDemo(sandbox: Sandbox, scenario: string): Promise<void> {
  check(['synthetic','block','evidence-gap','protocol','unknown'].includes(scenario), 'capture-synthetic-scenario-required');
  const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const input = probe.archive.append('ca710000-0000-4000-8000-000000000001', fixture.input);
    const job = probe.store.queueOwnerCapture(probe.activity, input);
    const route = { provider: 'synthetic', model: 'capture-fixture', route: 'synthetic-capture', authNamespace: 'synthetic', capability: 'standard' as const };
    const config: CaptureConfig = { proposer: [route, { ...route, model: 'fallback-fixture' }], verifier: [route] };
    const budget = { ...DEFAULT_BUDGET, contextLimit: 20000, maxTotalTokens: 100000, maxModelAttempts: 8 };
    await drainCaptures(probe, { jobId: job.jobId, batch: 8, deadlineMs: 30000, budget, config, host: {
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
    } });
    console.log(JSON.stringify({ event: 'capture-result', mode: 'synthetic-only', realModelEvidence: 'evidence-gap',
      sends: probe.transport.count, status: probe.store.readCaptureJob(probe.activity, job.jobId) }));
  } finally { probe.close(); }
}
