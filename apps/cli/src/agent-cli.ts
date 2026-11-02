import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { AgentRun, GuidanceSession, check, fileIdentity, sha256 } from '@euler/core';
import type { Binding, FileCapability, FileDecision, MemoryDiscoveryApproval } from '@euler/core';
import { createFileToolHost } from './file-tools.ts';
import filesFixture from '../../../fixtures/controlled-files.json' with { type: 'json' };
import type { ModelReply, ProbeBudget, RequestRecovery } from '@euler/core';
import { bindingOf } from './sandbox.ts';
import type { Sandbox } from './sandbox.ts';
import { openProbe } from './probe.ts';
import { pumpAgent } from './agent-pump.ts';
import type { AgentPump } from './agent-pump.ts';
import { configuredTransport, verifyTransportPrerequisites } from './model-transport.ts';
import { scheduleCaptures, reportCaptureFailure } from './capture.ts';
import { deliverMemoryInfo, openOwnerInfo, OwnerMemoryHost } from './owner-memory.ts';
import { CorrectionHost } from './memory-correction.ts';
import fixture from '../../../fixtures/controlled-agent.json' with { type: 'json' };

export const AGENT_BUDGET: ProbeBudget = { version: 'probe-budget@1', contextLimit: 32000, outputReserve: 1024,
  safetyMargin: 256, maxModelAttempts: 4, maxToolCalls: 4, maxTotalTokens: 128000, wallClockMs: 30000, toolTimeoutMs: 2000 };
const emit = (event: string, data: object) => process.stdout.write(JSON.stringify({ event, ...data }) + '\n');

export async function runInteractiveSession(sandbox: Sandbox, options: { binding?: Binding; transportConfig?: string; captureConfig?: string; historianConfig?: string } = {}): Promise<void> {
  check(sandbox.sessionBinding, 'explicit-session-required');
  const configured = options.transportConfig ? configuredTransport(options.transportConfig) : null;
  const budget = configured?.budget ?? AGENT_BUDGET;
  const route = configured ? { provider: configured.model.provider, model: configured.model.id,
    route: configured.model.baseUrl, authNamespace: configured.authNamespace } : null;
  let probe = openProbe(sandbox, budget, undefined, options.binding, undefined, true);
  let run: AgentRun | undefined, pumping: Promise<void> | undefined, windowRequested = false;
  let owner = new OwnerMemoryHost(probe, openOwnerInfo(sandbox, probe), 'success', probe.binding.projectId === null);
  let corrections = new CorrectionHost(probe, { recoverInfo: () => owner.deliver() });
  let inputEpoch = 0;
  const liveInputs: ({ input: ReturnType<CorrectionHost['receive']>; epoch: number; fileToken?: string; error?: unknown })[] = [];
  let project = probe.store.sessionProject(probe.activity);
  let guidance: GuidanceSession | undefined, discoveryGrantId: string | undefined;
  const fileCapability = (): FileCapability | undefined => project?.root && project.confirmation && process.platform === 'win32'
    ? { schema: 'file-capability@1', grantId: project.confirmation.eventId, binding: probe.binding,
      root: project.root, source: project.confirmation } : undefined;
  const guidanceHost = () => {
    if (!project?.root) return {};
    guidance ??= new GuidanceSession(probe.store, probe.activity, probe.archive, { dataRoot: probe.activity.root,
      projects: [{ projectId: project.projectId, root: project.root }], sources: [], sharedSkills: null });
    return { guidance: { session: guidance, selectFiles: true, targets: [{ projectId: project.projectId, path: project.root.path }],
      operation: { name: 'synthetic.read' as const, targets: [project.root.path] } } };
  };
  const startWorkers = () => ({
    capture: scheduleCaptures(probe, options.captureConfig, () => owner.deliver()),
    historian: options.historianConfig ? scheduleCaptures(probe, options.historianConfig, () => owner.deliver(), 'historian') : undefined,
  });
  let { capture, historian } = startWorkers();
  let pendingApproval: { token: string; presented: boolean; decide(decision: FileDecision): void } | undefined;
  const setup = new AbortController();
  const stop = () => { inputEpoch++; setup.abort(); run?.cancel(); void capture.close(); void historian?.close(); };
  process.on('SIGINT', stop);
  let lines: ReturnType<typeof createInterface> | undefined, inputClosed = false;
  const state = () => ({ binding: options.binding ?? bindingOf(sandbox), project: probe.store.sessionProject(probe.activity), route,
    intent: probe.store.readIntent(probe.activity), discoveryGrantId: discoveryGrantId ?? null,
    files: fileCapability() ? 'windows-handles' : 'unavailable', runId: run?.runId ?? null, status: run?.status() ?? null, networkCount: configured?.transport.count ?? 0,
    runs: probe.store.sessionAgentRuns(probe.activity).map(ledger => ({ runId: ledger.run.runId, sealed: ledger.sealed,
      relatedRunId: ledger.run.relatedRunId, terminal: probe.store.agentStatus(probe.activity, ledger.run.runId).terminal, attempts: ledger.attempts })) });
  const rejected = (error: unknown): void => { emit('session-command-rejected', { reason: (error as Error).message, sends: configured?.transport.count ?? 0 }); };
  const host: AgentPump = {
    ...createFileToolHost(async (presentation, signal) => {
      if (signal.aborted || !lines || inputClosed) return 'unavailable';
      return new Promise<FileDecision>(resolve => {
        const decide = (decision: FileDecision) => {
          signal.removeEventListener('abort', cancelled); pendingApproval = undefined; resolve(decision);
        };
        const cancelled = () => decide('unavailable');
        const pending = { token: presentation.token, presented: false, decide };
        pendingApproval = pending;
        signal.addEventListener('abort', cancelled, { once: true });
        process.stdout.write(JSON.stringify({ event: 'file-approval', ...presentation, command: `approve ${presentation.token}`, rejectCommand: `reject ${presentation.token}`,
          cwd: project?.root?.path ?? null, privileges: 'current Windows user; fixed file API only; no elevation or shell' }) + '\n', error => {
          if (error) decide('unavailable'); else pending.presented = true;
        });
      });
    }),
    cooperate: async () => { capture.kick(true); historian?.kick(true); },
    stream: async function* (request, signal, send) { check(configured, 'explicit-route-model-auth-budget-required');
      yield* configured.transport.stream(request, signal, send); },
    recoverInfo: () => owner.deliver(),
    execute: async () => { throw new Error('tool-unavailable'); },
  };
  const drive = () => {
    pumping = (async () => {
      for (;;) {
        const active = run!;
        const status = await pumpAgent(active, host);
        const source = status.responses.at(-1)?.source;
        emit('session-result', { runId: active.runId, terminal: status.terminal,
          text: source ? (JSON.parse(probe.archive.read(source).text) as ModelReply).text : null,
          status, ledger: probe.store.requestStatus(probe.activity, active.runId), networkCount: configured?.transport.count ?? 0 });
        const next = active.followUp();
        if (!next) {
          if (status.terminal === 'completed') { capture.kick(); historian?.kick(); }
          else { await capture.close(); await historian?.close(); }
          break;
        }
        run = next;
      }
    })().catch(rejected).finally(() => { pumping = undefined; });
  };
  try {
    probe.archive.reconcile();
    owner.backfill(); owner.drain(); owner.deliver(); await corrections.recover();
    if (configured) {
      const reservation = probe.store.reserveChild(probe.activity);
      await verifyTransportPrerequisites([], 'session-prerequisites', setup.signal, undefined,
        pid => probe.store.recordChildLaunch(probe.activity, reservation, pid));
    }
    lines = createInterface({ input: process.stdin });
    lines.on('line', text => {
      try {
        if (text === '/cancel' || text === '/exit') stop();
        liveInputs.push({ input: corrections.receive(text, true), epoch: inputEpoch, ...(pendingApproval?.presented ? { fileToken: pendingApproval.token } : {}) });
      } catch (error) { liveInputs.push({ input: null, epoch: inputEpoch, error }); }
    });
    lines.on('close', () => { inputClosed = true; pendingApproval?.decide('unavailable'); });
    emit('session-ready', state());
    capture.kick(); historian?.kick();
    for await (const line of lines) {
      const live = liveInputs.shift();
      try {
        if (live?.error) throw live.error;
        if (line === '/exit') break;
        if (line === '/cancel') continue;
        if (line === '/status') { emit('session-status', state()); continue; }
        check(live?.epoch === inputEpoch, 'input-cancelled');
        if (/^(approve|reject) [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(line)) {
          check(pendingApproval && live?.fileToken === pendingApproval.token && line === `${line.split(' ')[0]} ${pendingApproval.token}`, 'file-approval-stale');
          pendingApproval.decide(line.startsWith('approve ') ? 'approved' : 'rejected'); continue;
        }
        if (line === '/drain') {
          check(!pumping, 'foreground-run-active'); await capture.flush(); await historian?.flush();
          emit('session-drained', { capture: probe.store.listCaptureJobs(probe.activity),
            historian: probe.store.listCaptureJobs(probe.activity, 16, false, 'historian') }); continue;
        }
        if (line === '/window') {
          check(!pumping, 'window-not-admissible'); windowRequested = true; guidance?.newWindow();
          emit('session-window', { status: 'scheduled' }); continue;
        }
        if (line.startsWith('/request ')) {
          const runId = line.slice(9);
          emit('session-request', { ledger: probe.store.requestStatus(probe.activity, runId), status: probe.store.agentStatus(probe.activity, runId) }); continue;
        }
        if (line.startsWith('/seal ')) {
          check(!pumping, 'run-not-admissible'); probe.store.sealRequestRun(probe.activity, line.slice(6));
          emit('session-sealed', { runId: line.slice(6) }); continue;
        }
        if (line.startsWith('/reconcile ')) {
          check(!pumping, 'run-not-admissible'); emit('session-reconciliation', probe.store.reconcileRequestAttempt(probe.activity, line.slice(11))); continue;
        }
        if (line.startsWith('/task ')) {
          check(!pumping, 'intent-run-active');
          const text = line.slice(6), current = probe.store.readIntent(probe.activity);
          check(text.length > 0, 'invalid-input');
          let expected = current?.eventId ?? null;
          if (current && current.status !== 'completed') {
            const source = probe.archive.append(randomUUID(), line);
            expected = probe.store.transitionIntent(probe.activity, expected, source, { status: 'completed', step: 'owner-task-complete' }).eventId;
          }
          const source = probe.archive.append(randomUUID(), text);
          const intent = probe.store.transitionIntent(probe.activity, expected, source, { status: 'active', step: 'owner-task' }, text);
          run = undefined; discoveryGrantId = undefined; windowRequested = true;
          emit('session-task', intent); continue;
        }
        if (line.startsWith('/grant ')) {
          check(!pumping, 'discovery-run-active');
          const intent = probe.store.readIntent(probe.activity); check(intent?.status === 'active', 'intent-not-active');
          const fields = JSON.parse(line.slice(7));
          check(fields && Object.keys(fields).sort().join(',') === 'maxBytes,maxResults,projectIds,targets', 'invalid-discovery-grant');
          const approval: MemoryDiscoveryApproval = { schema: 'memory-discovery-approval@1', intentId: intent.intentId,
            goalEventId: intent.goalInput.eventId, ...fields };
          probe.archive.append(randomUUID(), line);
          const source = probe.archive.append(randomUUID(), JSON.stringify(approval));
          discoveryGrantId = probe.store.authorizeMemoryDiscovery(probe.activity, source, approval.projectIds,
            approval.maxResults, approval.targets, approval.maxBytes).grantId;
          run = undefined; emit('session-grant', { grantId: discoveryGrantId }); continue;
        }
        if (line.startsWith('/revoke ')) {
          const grantId = line.slice(8); probe.store.revokeMemoryDiscovery(probe.activity, grantId);
          if (discoveryGrantId === grantId) { stop(); await pumping; run = undefined; discoveryGrantId = undefined; }
          emit('session-grant-revoked', { grantId }); continue;
        }
        if (live?.input) {
          await corrections.handle(live.input, line);
          capture.kick(Boolean(pumping)); historian?.kick(Boolean(pumping)); continue;
        }
        if (owner.handle(line.startsWith('/') ? line.slice(1) : line, true)) {
          capture.kick(Boolean(pumping)); historian?.kick(Boolean(pumping)); continue;
        }
        if (line.startsWith('/memory ')) {
          emit('session-memory', probe.store.searchMemories(probe.activity, { query: line.slice(8), ...(discoveryGrantId ? { grantId: discoveryGrantId } : {}) })); continue;
        }
        if (line.startsWith('/source-search ')) {
          emit('session-sources', probe.store.searchSources(probe.activity, { query: line.slice(15), ...(discoveryGrantId ? { grantId: discoveryGrantId, queryId: randomUUID() } : {}) })); continue;
        }
        if (line.startsWith('/expand ')) {
          const request = JSON.parse(line.slice(8));
          check(request && Object.keys(request).sort().join(',') === 'eventId,limit,offset', 'invalid-source-request');
          const ref = probe.archive.lookup(request.eventId); check(ref, 'source-evidence-gap');
          probe.store.assertSourceAccess(probe.activity, ref, discoveryGrantId);
          emit('session-source', probe.store.expandSource(probe.activity, { ref, offset: request.offset, limit: request.limit })); continue;
        }
        if (line === '/skills' || line.startsWith('/skills ') || line.startsWith('/skill ')) {
          check(project?.root, 'guidance-project-unbound'); guidanceHost();
          if (line.startsWith('/skill ')) {
            check(!pumping, 'guidance-run-active');
            const selection = guidance!.select(line.slice(7), project.projectId);
            guidance!.activate(selection.selected, project.projectId, 'owner-explicit');
            emit('session-skill', selection);
          } else emit('session-skills', guidance!.search(project.projectId, line === '/skills' ? '' : line.slice(8)));
          continue;
        }
        if (line.startsWith('/bind ')) {
          check(!pumping, 'project-binding-run-active');
          const command = JSON.parse(line.slice(6)) as { projectId: string; root: string | null };
          const root = command.root === null ? null : realpathSync.native(command.root);
          const confirmation = probe.archive.append(randomUUID(), line, 'user');
          const resource = root ? { path: root, identity: fileIdentity(root) } : null;
          await Promise.all([capture.idle(), historian?.idle()]);
          check(live?.epoch === inputEpoch, 'input-cancelled');
          probe.store.confirmSessionProject(probe.activity, confirmation, command.projectId, resource);
          await capture.close(); await historian?.close();
          probe.close(); probe = openProbe(sandbox, budget, undefined, options.binding, undefined, true); run = undefined;
          project = probe.store.sessionProject(probe.activity); guidance = undefined;
          owner = new OwnerMemoryHost(probe, openOwnerInfo(sandbox, probe), 'success', false);
          corrections = new CorrectionHost(probe, { recoverInfo: () => owner.deliver() });
          owner.drain(); owner.deliver(); await corrections.recover();
          if (live?.epoch === inputEpoch) ({ capture, historian } = startWorkers());
          emit('session-bound', state()); continue;
        }
        check(configured && route, 'explicit-route-model-auth-budget-required');
        check(await corrections.deliver() && owner.deliver(), 'operation-presentation-recovery-required');
        check(live?.epoch === inputEpoch, 'input-cancelled');
        const resume = line.startsWith('/resume ') ? JSON.parse(line.slice(8)) as { relatedRunId: string; acceptDuplicateRisk: boolean; input: string } : null;
        if (resume) {
          check(!pumping && Object.keys(resume).sort().join(',') === 'acceptDuplicateRisk,input,relatedRunId'
            && typeof resume.input === 'string' && typeof resume.acceptDuplicateRisk === 'boolean', 'invalid-session-resume');
          probe.archive.append(randomUUID(), line);
          probe.store.requestStatus(probe.activity, resume.relatedRunId);
          await capture.close(); await historian?.close();
          check(live?.epoch === inputEpoch, 'input-cancelled');
        }
        const control = /^\/(steer|follow-up|queue) ([\s\S]*)$/.exec(line);
        const mode = control ? control[1] as 'steer' | 'follow-up' | 'queue' : 'steer';
        const text = resume?.input ?? control?.[2] ?? line;
        check(resume || control || !line.startsWith('/'), 'unknown-session-command');
        check(text.length > 0, 'invalid-input');
        const eventId = randomUUID();
        if (!resume && run?.status().terminal === 'completed') run = run.continue(eventId, text, mode === 'queue' ? 'queue' : 'steer');
        else if (!resume && run) run.receive(eventId, text, mode);
        else {
          const files = fileCapability();
          run = new AgentRun(probe.store, probe.activity, { binding: probe.binding, source: probe.archive, conversation: true,
            ...guidanceHost(), ...(files ? { files } : {}), ...(discoveryGrantId ? { discoveryGrantId } : {}),
            ...(historian ? { historian: { bounds: { minBytes: 4096, maxBytes: 60000 }, onError: reportCaptureFailure } } : {}),
            encode: configured.transport.encode.bind(configured.transport) }, route, budget,
          resume ? { recovery: { relatedRunId: resume.relatedRunId, acceptDuplicateRisk: resume.acceptDuplicateRisk } } : {});
          run.receive(eventId, text, mode);
        }
        if (resume) ({ capture, historian } = startWorkers());
        if (windowRequested) { run.newWindow(); windowRequested = false; }
        emit('session-input', { runId: run.runId, source: probe.archive.lookup(eventId), mode });
        capture.kick(true); historian?.kick(true);
        if (!pumping && mode !== 'queue') drive();
      } catch (error) { rejected(error); }
    }
    await pumping;
  } finally {
    lines?.close(); process.off('SIGINT', stop); pendingApproval?.decide('unavailable');
    await historian?.close(); await capture.close();
    if (guidance) probe.store.sealRequestRun(probe.activity, guidance.runId);
    probe.close();
  }
}

export async function runAgentDemo(sandbox: Sandbox, scenario: string, budget: ProbeBudget, options: {
  transportConfig?: string; captureConfig?: string; historianConfig?: string; interactive?: boolean; recovery?: RequestRecovery;
} = {}): Promise<void> {
  check(['plain', 'tool', 'files', 'budget', 'cancel', 'failure', 'unknown', 'real'].includes(scenario), 'invalid-agent-scenario');
  if (scenario === 'real' && !options.transportConfig) {
    emit('agent-evidence-gap', { reason: 'explicit-route-model-auth-budget-required', sends: 0 }); process.exitCode = 1; return;
  }
  const configured = scenario === 'real' ? configuredTransport(options.transportConfig!) : null;
  if (configured) { budget = configured.budget; await verifyTransportPrerequisites(); }
  if (scenario === 'budget') budget = { ...budget, maxModelAttempts: 1 };
  const probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
  const capture = scheduleCaptures(probe, options.captureConfig, () => deliverMemoryInfo(sandbox, probe));
  const historian = options.historianConfig ? scheduleCaptures(probe, options.historianConfig, () => deliverMemoryInfo(sandbox, probe), 'historian') : undefined;
  deliverMemoryInfo(sandbox, probe);
  capture.kick(true); historian?.kick(true);
  const transport = configured?.transport;
  const route = configured ? { provider: configured.model.provider, model: configured.model.id, route: configured.model.baseUrl, authNamespace: configured.authNamespace }
    : { provider: 'fake', model: 'controlled', route: 'fixture', authNamespace: 'synthetic' };
  let files: FileCapability | undefined;
  if (scenario === 'files' && process.platform === 'win32') {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'euler-file-project-')));
    files = { schema: 'file-capability@1', grantId: randomUUID(), binding: bindingOf(sandbox), root: { path: root, identity: fileIdentity(root) },
      source: probe.archive.append(randomUUID(), JSON.stringify({ kind: 'synthetic-file-root-binding', root, command: 'agent --scenario files', input: filesFixture.input }), 'user') };
    emit('file-project-bound', { root: files.root, ownerId: files.binding.ownerId, projectId: files.binding.projectId, syntheticOnly: true, cleanupOwner: 'host-project-resource' });
  }
  let run = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive,
    ...(files ? { files } : {}),
    ...(historian ? { historian: { bounds: { minBytes: 4096, maxBytes: 60000 }, onError: reportCaptureFailure } } : {}),
    ...(transport ? { encode: transport.encode.bind(transport) } : {}) }, route, budget, options.recovery ? { recovery: options.recovery } : {});
  let pendingApproval: { token: string; decide: (decision: FileDecision) => void } | undefined;
  let lines: ReturnType<typeof createInterface> | undefined;
  let requests = 0;
  const host: AgentPump = {
    ...(scenario === 'files' ? createFileToolHost(async (presentation, signal) => {
      if (!options.interactive || signal.aborted) return 'unavailable';
      return new Promise<FileDecision>(resolve => {
        const decide = (decision: FileDecision) => { signal.removeEventListener('abort', cancelled); pendingApproval = undefined; resolve(decision); };
        const cancelled = () => decide('unavailable');
        pendingApproval = { token: presentation.token, decide };
        signal.addEventListener('abort', cancelled, { once: true });
        emit('file-approval', { ...presentation, command: `approve ${presentation.token}`, rejectCommand: `reject ${presentation.token}`,
          cwd: files?.root.path ?? null, privileges: 'current Windows user; fixed file API only; no elevation or shell' });
      });
    }) : {}),
    recoverInfo: () => deliverMemoryInfo(sandbox, probe),
    stream: transport ? transport.stream.bind(transport) : async function* (request, _signal, send) {
      if (scenario === 'failure') throw new Error('synthetic-before-send-failure');
      send(request.payload); requests++;
      if (scenario === 'unknown') throw new Error('synthetic-disconnection');
      const reply: ModelReply = scenario === 'files' && requests <= 2
        ? { text: '', stop: 'tools', calls: requests === 1
          ? [{ id: 'file-write', name: 'file.write', arguments: { path: filesFixture.path, content: filesFixture.content } }]
          : [{ id: 'file-read', name: 'file.read', arguments: { path: filesFixture.path } }] }
        : requests === 1 && ['tool', 'budget'].includes(scenario)
        ? { text: '', calls: [{ id: 'echo-1', name: 'controlled.echo', arguments: { text: 'EULER-T07' } }], stop: 'tools' }
        : { text: scenario === 'files' ? 'EULER-T08' : requests > 1 ? 'EULER-T07' : 'READY', calls: [], stop: 'end' };
      yield { kind: 'partial', reply };
      yield { kind: 'complete', reply };
    },
    async cooperate() { capture.kick(true); historian?.kick(true); },
    async execute(call) { return String(call.arguments.text); },
  };
  const cancel = () => { run.cancel(); void capture.close(); void historian?.close(); };
  process.on('SIGINT', cancel);
  try {
    run.receive(randomUUID(), scenario === 'files' ? filesFixture.input : scenario === 'plain' ? fixture.plain : fixture.tool);
    capture.kick(true);
    if (options.interactive) {
      emit('agent-controls', { commands: ['steer', 'follow-up', 'queue', 'cancel', 'status'], syntheticInputsOnly: true });
      lines = createInterface({ input: process.stdin });
      lines.on('line', line => {
        try {
          if (pendingApproval && line === `approve ${pendingApproval.token}`) pendingApproval.decide('approved');
          else if (pendingApproval && line === `reject ${pendingApproval.token}`) pendingApproval.decide('rejected');
          else if (line === 'cancel') cancel();
          else if (line === 'status') emit('agent-status', { runId: run.runId, ...run.status() });
          else if (['steer', 'follow-up', 'queue'].includes(line)) {
            const mode = line as 'steer' | 'follow-up' | 'queue';
            const source = run.receive(randomUUID(), mode === 'steer' ? fixture.steer : fixture.followUp, mode);
            emit('agent-input', { mode, source });
          } else emit('agent-command-rejected', { reason: 'synthetic-command-required' });
        } catch { emit('agent-command-rejected', { reason: 'run-not-admissible' }); }
      });
      lines.on('close', () => pendingApproval?.decide('unavailable'));
    }
    if (scenario === 'cancel') run.cancel();
    for (;;) {
      const status = await pumpAgent(run, host);
      const ledger = probe.store.requestStatus(probe.activity, run.runId);
      emit('agent-result', { runId: run.runId, scenario, route, fixtureDigest: sha256(JSON.stringify(scenario === 'files' ? filesFixture : fixture)), budget,
        status, ledger, ...(scenario === 'files' ? { controlledFiles: probe.store.maintenanceStatus().controlledFiles, filePlatform: process.platform,
          fileCapability: files ? 'windows-handles' : 'unavailable' } : {}), networkCount: transport?.count ?? 0, fixtureProviderCount: requests,
        sourceMechanism: 'CLI JSONL + SQLite WAL FULL', realProvider: Boolean(transport) });
      if (status.terminal !== 'completed') process.exitCode = 1;
      const next = run.followUp();
      if (!next) { await historian?.flush(); await capture.flush(); break; }
      run = next;
      capture.kick(true);
    }
  } finally { lines?.close(); process.off('SIGINT', cancel); await historian?.close(); await capture.close(); probe.close(); }
}
