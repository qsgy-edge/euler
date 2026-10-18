import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { AgentRun, check, fileIdentity, sha256 } from '@euler/core';
import type { FileCapability, FileDecision } from '@euler/core';
import { createFileToolHost } from './file-tools.ts';
import filesFixture from '../../../fixtures/controlled-files.json' with { type: 'json' };
import type { ModelReply, ProbeBudget, RequestRecovery } from '@euler/core';
import { bindingOf } from './sandbox.ts';
import type { Sandbox } from './sandbox.ts';
import { openProbe } from './probe.ts';
import { pumpAgent } from './agent-pump.ts';
import type { AgentPump } from './agent-pump.ts';
import { configuredTransport, verifyTransportPrerequisites } from './model-transport.ts';
import { createCaptureWorker, reportCaptureFailure } from './capture.ts';
import fixture from '../../../fixtures/controlled-agent.json' with { type: 'json' };

export const AGENT_BUDGET: ProbeBudget = { version: 'probe-budget@1', contextLimit: 32000, outputReserve: 1024,
  safetyMargin: 256, maxModelAttempts: 4, maxToolCalls: 4, maxTotalTokens: 128000, wallClockMs: 30000, toolTimeoutMs: 2000 };
const emit = (event: string, data: Record<string, unknown>) => process.stdout.write(JSON.stringify({ event, ...data }) + '\n');

export async function runAgentDemo(sandbox: Sandbox, scenario: string, budget: ProbeBudget, options: {
  transportConfig?: string; captureConfig?: string; interactive?: boolean; recovery?: RequestRecovery;
} = {}): Promise<void> {
  check(['plain', 'tool', 'files', 'budget', 'cancel', 'failure', 'unknown', 'real'].includes(scenario), 'invalid-agent-scenario');
  if (scenario === 'real' && !options.transportConfig) {
    emit('agent-evidence-gap', { reason: 'explicit-route-model-auth-budget-required', sends: 0 }); process.exitCode = 1; return;
  }
  const configured = scenario === 'real' ? configuredTransport(options.transportConfig!) : null;
  if (configured) { budget = configured.budget; verifyTransportPrerequisites(); }
  if (scenario === 'budget') budget = { ...budget, maxModelAttempts: 1 };
  const probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
  const capture = createCaptureWorker(options.captureConfig, reportCaptureFailure);
  try { await capture(probe); }
  catch (error) { probe.close(); throw error; }
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
    async cooperate() { await capture(probe, true); },
    async execute(call) { return String(call.arguments.text); },
  };
  const cancel = () => run.cancel();
  process.on('SIGINT', cancel);
  try {
    run.receive(randomUUID(), scenario === 'files' ? filesFixture.input : scenario === 'plain' ? fixture.plain : fixture.tool);
    await capture(probe, true);
    if (options.interactive) {
      emit('agent-controls', { commands: ['steer', 'follow-up', 'queue', 'cancel', 'status'], syntheticInputsOnly: true });
      lines = createInterface({ input: process.stdin });
      lines.on('line', line => {
        try {
          if (pendingApproval && line === `approve ${pendingApproval.token}`) pendingApproval.decide('approved');
          else if (pendingApproval && line === `reject ${pendingApproval.token}`) pendingApproval.decide('rejected');
          else if (line === 'cancel') run.cancel();
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
      await capture(probe);
      const next = run.followUp();
      if (!next) break;
      run = next;
    }
  } finally { lines?.close(); process.off('SIGINT', cancel); probe.close(); }
}
