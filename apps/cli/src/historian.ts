import { randomUUID } from 'node:crypto';
import { AgentRun, DEFAULT_BUDGET, check, sha256 } from '@euler/core';
import type { ModelReply } from '@euler/core';
import fixture from '../../../fixtures/t19-historian-cases.json' with { type: 'json' };
import { bindingOf } from './sandbox.ts';
import type { Sandbox } from './sandbox.ts';
import { openProbe } from './probe.ts';
import { createCaptureWorker, drainCaptures } from './capture.ts';
import { configuredTransport, verifyTransportPrerequisites } from './model-transport.ts';

export async function runHistorianDrain(sandbox: Sandbox, path?: string, runId?: string): Promise<void> {
  const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    if (runId) probe.store.queueHistorianBoundary(probe.activity, runId, { minBytes: 4096, maxBytes: 60000 });
    await createCaptureWorker(path, undefined, undefined, 'historian')(probe);
  }
  finally { probe.close(); }
}

/** Fixed synthetic raw events; only the Historian request may use an explicitly authorized external route. */
export async function runHistorianDemo(sandbox: Sandbox, scenario: string, configPath?: string): Promise<void> {
  check(['synthetic','real','protocol','block','evidence-gap','unknown','cancel'].includes(scenario), 'invalid-historian-scenario');
  if (scenario === 'real' && !configPath) {
    console.log(JSON.stringify({ event: 'historian-evidence-gap', reason: 'explicit-route-model-auth-budget-required', sends: 0 }));
    process.exitCode = 1; return;
  }
  check(scenario === 'real' || !configPath, 'historian-route-requires-real-scenario');
  const configured = configPath ? configuredTransport(configPath) : null;
  if (configured) {
    check(configured.captureCapability, 'capture-capability-required');
    await verifyTransportPrerequisites(['historian','context-window'], 'historian-prerequisites');
  }
  const budget = configured?.budget ?? { ...DEFAULT_BUDGET, contextLimit: 40000, maxTotalTokens: 500000, maxModelAttempts: 12, maxToolCalls: 12 };
  let probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
  let release: (() => void) | undefined;
  try {
    const agentRoute = { provider: 'synthetic', model: 'historian-context-fixture', route: 'fixture', authNamespace: 'synthetic' };
    const run = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive,
      historian: { bounds: { minBytes: 1000, maxBytes: 60000 }, onError(error) { throw error; } } }, agentRoute, budget);
    release = run.observeExecution();
    run.receive(randomUUID(), fixture.input);
    const deliver = (reply: ModelReply) => {
      const request = run.nextModel(); check(request, 'historian-fixture-request-missing');
      const attempt = run.startModel(request, request.payload);
      check(run.maySend(attempt.attemptId, request.payload), 'historian-fixture-send-denied');
      console.log(JSON.stringify({ event: 'historian-foreground-request', request, attemptId: attempt.attemptId }));
      probe.transport.send(request.payload, attempt);
      run.finishModel(attempt.attemptId, reply);
    };
    for (let turn = 0; turn < 2; turn++) {
      const id = 'observation-' + turn;
      deliver({ text: turn ? 'Keep the latest complete pair.' : fixture.narrative.repeat(fixture.repeat),
        calls: [{ id, name: 'controlled.echo', arguments: { text: 'synthetic-observation' } }], stop: 'tools' });
      run.startTool(id); run.finishTool(id, turn ? 'Latest exact result.' : fixture.result);
    }
    const job = probe.store.listCaptureJobs(probe.activity, 1, true, 'historian')[0]!;
    check(job, 'historian-job-missing');
    const initialEpoch = run.status().cacheEpoch!.cacheEpoch;
    const route = configured ? { provider: configured.model.provider, model: configured.model.id, route: configured.model.baseUrl,
      authNamespace: configured.authNamespace, capability: configured.captureCapability! }
      : { ...agentRoute, model: 'historian-fixture', capability: 'standard' as const };
    let sends = 0;
    const abort = new AbortController();
    try {
      await drainCaptures(probe, { jobId: job.jobId, batch: 1, deadlineMs: Math.min(30000, budget.wallClockMs), budget,
        config: { historian: scenario === 'protocol' ? [route, { ...route, model: 'fallback-fixture' }] : [route] },
        ...(configured ? { encode: configured.transport.encode.bind(configured.transport) } : {}),
        adapterVersion: configured ? 'capture-http@1' : 'capture-counting@1', signal: abort.signal,
        host: { stream: async function* (request, signal, send) {
          if (configured) {
            yield* configured.transport.stream(request, signal, payload => {
              const attempt = send(payload);
              console.log(JSON.stringify({ event: 'historian-request', request, attemptId: attempt.attemptId }));
              return attempt;
            });
            return;
          }
          const attempt = send(request.payload); probe.transport.send(request.payload, attempt); sends++;
          console.log(JSON.stringify({ event: 'historian-request', request, attemptId: attempt.attemptId }));
          if (scenario === 'unknown') throw new Error('synthetic-response-lost');
          if (scenario === 'cancel') { abort.abort(new Error('capture-stopped')); signal.throwIfAborted(); }
          const text = scenario === 'protocol' && sends === 1 ? 'invalid fixture output'
            : scenario === 'block' || scenario === 'evidence-gap' ? JSON.stringify({ result: scenario, reason: 'synthetic-negative' })
            : JSON.stringify({ result: 'pass', summary: fixture.summary });
          yield { kind: 'complete', reply: { text, calls: [], stop: 'end' } };
        } } });
    } catch (error) {
      if (!['unknown','cancel'].includes(scenario)) throw error;
    }
    const result = probe.store.readCaptureJob(probe.activity, job.jobId);
    check(run.status().cacheEpoch!.cacheEpoch === initialEpoch, 'historian-generated-prefix-changed');
    let selected = false;
    if (result.stage === 'unknown') run.cancel();
    else {
      run.newWindow();
      const preview = run.nextModel()!;
      selected = !!JSON.parse(preview.payload).p1.compartments?.length;
      deliver({ text: 'Synthetic foreground completed.', calls: [], stop: 'end' });
    }
    release(); release = undefined;
    const terminal = run.status().terminal, agentRunId = run.runId;
    const work = probe.store.listCaptureJobs(probe.activity, 32, false, 'historian').find(item => item.jobId === job.jobId)!;
    const compartment = result.stage === 'complete' ? probe.store.readCompartment(probe.activity, job.jobId) : null;
    probe.close(); probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
    const reopened = compartment ? probe.store.readCompartment(probe.activity, job.jobId).source.contentHash === compartment.source.contentHash
      : probe.store.readCaptureJob(probe.activity, job.jobId).stage === work.stage;
    console.log(JSON.stringify({ event: 'historian-result', scenario, jobId: job.jobId, agentRunId,
      stage: work.stage, reason: work.reason, selected, reopened, foregroundTerminal: terminal,
      backgroundAttempts: configured?.transport.count ?? sends, fixtureDigest: sha256(JSON.stringify(fixture)),
      compartment: compartment ? { source: compartment.source, attemptId: compartment.attemptId, rawHash: compartment.rawHash } : null,
      realProvider: Boolean(configured), evidenceGaps: configured ? [] : ['external-provider-quality'] }));
  } finally { release?.(); probe.close(); }
}
