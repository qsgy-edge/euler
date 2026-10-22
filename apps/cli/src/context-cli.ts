import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRun, AnalysisArtifacts, GuidanceSession, check, fileIdentity, sha256 } from '@euler/core';
import type { Binding, ModelReply, SourceAck, SourceUnitInput } from '@euler/core';
import { bindingOf, createSandboxSession } from './sandbox.ts';
import type { Sandbox } from './sandbox.ts';
import { openProbe } from './probe.ts';
import { AGENT_BUDGET } from './agent-cli.ts';
import { pumpAgent } from './agent-pump.ts';
import type { AgentPump } from './agent-pump.ts';
import { configuredTransport, verifyTransportPrerequisites } from './model-transport.ts';
import { deliverMemoryInfo } from './owner-memory.ts';
import fixture from '../../../fixtures/t18-context.json' with { type: 'json' };

type Probe = ReturnType<typeof openProbe>;
const emit = (event: string, fields: Record<string, unknown>) => process.stdout.write(JSON.stringify({ event, ...fields }) + '\n');
const localBudget = { ...AGENT_BUDGET, contextLimit: 20000, outputReserve: 1024, maxModelAttempts: 10, maxToolCalls: 10, maxTotalTokens: 600000 };

function begin(probe: Probe, text: string) {
  const source = probe.archive.append(randomUUID(), text);
  const prior = probe.store.readIntent(probe.activity);
  return probe.store.transitionIntent(probe.activity, prior?.eventId ?? null, source, { status: 'active', step: 'context-acceptance' }, text);
}
function publish(probe: Probe, ref: SourceAck, projectId: string, kind: SourceUnitInput['kind'], text: string, supersedes?: string) {
  const raw = probe.archive.read(ref).text;
  const start = raw.indexOf(text);
  check(start >= 0, 'fixture-publication-range-missing');
  const value = { ref, projectId, kind, offset: Array.from(raw.slice(0, start)).length, length: Array.from(text).length,
    ...(supersedes ? { supersedes } : {}) };
  const intent = probe.store.readIntent(probe.activity)!;
  const approval = probe.archive.append(randomUUID(), JSON.stringify({ schema: 'source-publication-approval@1',
    intentId: intent.intentId, goalEventId: intent.goalInput.eventId, ref, projectId, kind, offset: value.offset, length: value.length }));
  return probe.store.publishSourceUnit(probe.activity, { ...value, approval });
}
function finalText(probe: Probe, run: AgentRun): string {
  const status = run.status();
  if (status.terminal !== 'completed') emit('context-run-stopped', { runId: run.runId, terminal: status.terminal,
    attempts: status.attempts, tools: status.tools.map(tool => ({ name: tool.name, outcome: tool.result?.outcome ?? null, error: tool.result?.errorClass ?? null })) });
  check(status.terminal === 'completed' && status.responses.length > 0, 'context-run-incomplete');
  return (JSON.parse(probe.archive.read(status.responses.at(-1)!.source).text) as ModelReply).text;
}

/** Only fixed synthetic owner decisions are generated here; arbitrary model output is never published. */
export async function runContextDemo(sandbox: Sandbox, scenario: string, configPath?: string): Promise<void> {
  check(['synthetic', 'real'].includes(scenario), 'invalid-context-scenario');
  if (scenario === 'real' && !configPath) {
    emit('context-evidence-gap', { reason: 'explicit-route-model-auth-budget-required', sends: 0 }); process.exitCode = 1; return;
  }
  check(scenario === 'real' || !configPath, 'context-route-requires-real-scenario');
  const configured = configPath ? configuredTransport(configPath) : null;
  if (configured) await verifyTransportPrerequisites(['context-window', 'context-boundaries', 'context-authority', 'context-operations', 'guidance', 'source-discovery', 'analysis-handoff'], 'context-prerequisites');
  const budget = configured?.budget ?? localBudget;
  const transport = configured?.transport;
  const route = configured ? { provider: configured.model.provider, model: configured.model.id,
    route: configured.model.baseUrl, authNamespace: configured.authNamespace }
    : { provider: 'fake', model: 'controlled-context', route: 'fixture', authNamespace: 'synthetic' };
  const resources = mkdtempSync(join(tmpdir(), 'euler-context-fixture-'));
  const origin = openProbe(sandbox, budget, undefined, undefined, undefined, true);
  const sourceBinding: Binding = { ...bindingOf(sandbox), projectId: randomUUID(), sessionId: randomUUID() };
  createSandboxSession(sandbox, sourceBinding);
  const source = openProbe(sandbox, budget, undefined, sourceBinding, undefined, true);
  let target: Probe | undefined;
  let activeRun: AgentRun | undefined;
  const abort = () => activeRun?.cancel();
  process.on('SIGINT', abort);
  try {
    begin(source, 'Publish the fixed synthetic Atlas capability description for controlled analysis.');
    const rawEvidence = source.archive.append(randomUUID(), fixture.evidence);
    const evidenceUnit = publish(source, rawEvidence, sourceBinding.projectId, 'source', fixture.evidence);
    source.store.rememberMemory(source.activity, { input: source.archive.append(randomUUID(), '记住偏好：' + fixture.preference), hostInfo: 'durable' });
    deliverMemoryInfo(sandbox, source);
    source.store.drainSearchProjection(source.activity); source.store.drainSourceProjection(source.activity);

    const goal = `Controlled synthetic acceptance. Complete these ordered steps using the available tools: `
      + `controlled.echo with text first; controlled.echo with text second; recover ${fixture.marker} using source.search scope=session and source.expand; `
      + `memory.search for Atlas; source.search scope=project for EVIDENCE-T18, then source.expand the matching unit. `
      + `Finally call source.expand eventId=${fixture.unavailableEventId}, offset=0, limit=32; this synthetic reference is unavailable. Observe its failure and continue to the final report. `
      + `Return only JSON with facts, inferences, recommendations, unresolved. facts must contain the exact expanded evidence sentence. `
      + `recommendations must equal this preapproved synthetic section exactly: ${fixture.approvedSection} `
      + `Keep inferences separate and state that current source conditions require review. No network verification or implementation is authorized.`;
    const intent = begin(origin, goal);
    const projects = [sourceBinding.projectId], targets = {};
    const approval = origin.archive.append(randomUUID(), JSON.stringify({ schema: 'memory-discovery-approval@1',
      intentId: intent.intentId, goalEventId: intent.goalInput.eventId, projectIds: projects, targets, maxResults: 64, maxBytes: 131072 }));
    const { grantId } = origin.store.authorizeMemoryDiscovery(origin.activity, approval, projects, 64, targets, 131072);
    const projectRoot = join(resources, 'origin');
    const skillRoot = join(projectRoot, '.agents', 'skills', 'context-check');
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(join(projectRoot, 'AGENTS.md'), fixture.initialGuidance);
    writeFileSync(join(skillRoot, 'SKILL.md'), fixture.skillBody);
    const guidance = new GuidanceSession(origin.store, origin.activity, origin.archive, {
      dataRoot: { path: resources, identity: fileIdentity(resources) },
      projects: [{ projectId: sandbox.fixture.projectId, root: { path: projectRoot, identity: fileIdentity(projectRoot) } }],
      sharedSkills: null, sources: [],
    });
    guidance.activate(guidance.select('context-check', sandbox.fixture.projectId).selected, sandbox.fixture.projectId, 'owner-explicit');
    const run = new AgentRun(origin.store, origin.activity, { binding: bindingOf(sandbox), source: origin.archive, discoveryGrantId: grantId,
      guidance: { session: guidance, targets: [{ projectId: sandbox.fixture.projectId, path: join(projectRoot, 'fixture.ts') }],
        operation: { name: 'synthetic.read', targets: [join(projectRoot, 'fixture.ts')] } },
      ...(transport ? { encode: transport.encode.bind(transport) } : {}) }, route, budget);
    activeRun = run; run.receive(intent.goalInput.eventId, goal);
    let turn = 0, echoes = 0, switched = false;
    const scripted: AgentPump['stream'] = async function* (request, _signal, send) {
      const attempt = send(request.payload); origin.transport.send(request.payload, attempt); turn++;
      const call = turn <= 2 ? { id: `echo-${turn}`, name: 'controlled.echo', arguments: { text: turn === 1 ? 'first' : 'second' } }
        : turn === 3 ? { id: 'raw-search', name: 'source.search', arguments: { query: fixture.marker, scope: 'session' } }
        : turn === 4 ? { id: 'raw-expand', name: 'source.expand', arguments: { eventId: run.status().tools[0]!.result!.source.eventId, offset: 0, limit: 160 } }
        : turn === 5 ? { id: 'memories', name: 'memory.search', arguments: { query: 'Atlas' } }
        : turn === 6 ? { id: 'project-search', name: 'source.search', arguments: { query: 'EVIDENCE-T18', scope: 'project' } }
        : turn === 7 ? { id: 'project-expand', name: 'source.expand', arguments: { unitId: evidenceUnit.unitId, offset: 0, limit: 512 } }
        : turn === 8 ? { id: 'unreachable', name: 'source.expand', arguments: { eventId: fixture.unavailableEventId, offset: 0, limit: 32 } } : null;
      yield { kind: 'complete', reply: call ? { text: '', stop: 'tools', calls: [call] }
        : { text: JSON.stringify({ facts: fixture.evidence, inferences: fixture.inference,
          recommendations: fixture.approvedSection, unresolved: fixture.unresolved }), stop: 'end', calls: [] } };
    };
    await pumpAgent(run, { stream: transport ? transport.stream.bind(transport) : scripted,
      recoverInfo: () => deliverMemoryInfo(sandbox, origin),
      async execute(call) { check(call.name === 'controlled.echo', 'unexpected-host-tool'); echoes++;
        return `${echoes === 1 ? fixture.marker : 'SECOND-T18'}: ` + 'synthetic detail '.repeat(340); },
      async cooperate() {
        if (echoes >= 2 && !switched && !run.status().terminal) {
          writeFileSync(join(projectRoot, 'AGENTS.md'), fixture.updatedGuidance);
          run.newWindow(); switched = true;
        }
      },
    });
    const reportValue = JSON.parse(finalText(origin, run)) as Record<string, unknown>;
    check(Object.keys(reportValue).sort().join(',') === 'facts,inferences,recommendations,unresolved'
      && Object.values(reportValue).every(value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 8192)
      && String(reportValue.facts).includes(fixture.evidence) && reportValue.recommendations === fixture.approvedSection, 'context-report-contract');
    const status = run.status();
    const missingCall = status.responses.flatMap(response => (JSON.parse(origin.archive.read(response.source).text) as ModelReply).calls)
      .find(call => call.name === 'source.expand' && call.arguments.eventId === fixture.unavailableEventId);
    const unavailableContinued = Boolean(missingCall && status.tools.find(tool => tool.callId === missingCall.id)?.result?.outcome === 'failure');
    check(switched && unavailableContinued && status.tools.every(tool => tool.result?.outcome === (tool.callId === missingCall!.id ? 'failure' : 'success'))
      && ['memory.search', 'source.search', 'source.expand'].every(name => status.tools.some(tool => tool.name === name)), 'context-tool-evidence-gap');
    check(status.tools.some(tool => tool.name === 'source.expand'
      && origin.archive.read(tool.result!.source).text.includes(fixture.marker)), 'context-recovery-evidence-gap');
    check(status.tools.some(tool => {
      if (tool.name !== 'source.expand' || tool.result?.outcome !== 'success') return false;
      const excerpt = JSON.parse(JSON.parse(origin.archive.read(tool.result.source).text).modelResult) as { unitId?: string; text?: string };
      return excerpt.unitId === evidenceUnit.unitId && excerpt.text === fixture.evidence;
    }), 'context-project-evidence-gap');
    const evidenceRequest = { unitId: evidenceUnit.unitId, offset: 0, limit: 512, grantId, queryId: randomUUID() };
    const evidence = origin.store.expandSource(origin.activity, evidenceRequest);
    const artifacts = new AnalysisArtifacts(origin.store, origin.activity, origin.archive);
    const report = artifacts.saveReport({ eventId: randomUUID(), title: 'Atlas synthetic analysis',
      facts: reportValue.facts as string, inferences: reportValue.inferences as string, recommendations: reportValue.recommendations as string,
      unresolved: reportValue.unresolved as string, evidence: [{ request: evidenceRequest, hash: evidence.excerptHash }] });
    const firstUnit = publish(origin, report.ref, sourceBinding.projectId, 'report-section', fixture.approvedSection);
    const updated = artifacts.saveReport({ eventId: randomUUID(), title: 'Atlas synthetic analysis', facts: reportValue.facts as string,
      inferences: reportValue.inferences as string, recommendations: fixture.approvedNextSection, unresolved: fixture.unresolved,
      evidence: [{ request: evidenceRequest, hash: evidence.excerptHash }], supersedes: report.ref });
    const currentUnit = publish(origin, updated.ref, sourceBinding.projectId, 'report-section', fixture.approvedNextSection, firstUnit.unitId);
    const temporary = join(resources, 'handoff.md');
    writeFileSync(temporary, '# Ordinary Markdown handoff\n\n' + fixture.approvedNextSection);
    const handoff = artifacts.saveHandoff({ eventId: randomUUID(), title: 'Ordinary handoff', markdown: readFileSync(temporary, 'utf8'), evidence: [] });
    const handoffUnit = publish(origin, handoff.ref, sourceBinding.projectId, 'handoff', handoff.body);
    rmSync(temporary);
    origin.store.drainSourceProjection(origin.activity);
    const completed = origin.archive.append(randomUUID(), 'Finish the synthetic analysis; restore local access.');
    const currentIntent = origin.store.readIntent(origin.activity)!;
    origin.store.transitionIntent(origin.activity, currentIntent.eventId, completed, { status: 'completed', step: 'complete' });

    const targetBinding = { ...sourceBinding, sessionId: randomUUID() };
    createSandboxSession(sandbox, targetBinding);
    target = openProbe(sandbox, budget, undefined, targetBinding, undefined, true);
    const targetGoal = 'Discover HANDOFF-T18 with source.search scope=project. Expand the newest report section, the ordinary Markdown handoff, and the older report section, in that order. Evaluate them under current local authority. '
      + 'The temporary handoff file has been deleted; use its archived published unit. No Skill is required. Return exactly {"assessment":"requires-current-source-review","authority":"local-only"}. '
      + 'Do not implement, publish or inherit the previous analysis grant.';
    const targetIntent = begin(target, targetGoal);
    const denied = new AgentRun(target.store, target.activity, { binding: targetBinding, source: target.archive, discoveryGrantId: grantId }, route, budget);
    denied.receive(randomUUID(), 'Try the old analysis grant in this new session.');
    let oldGrantDenied = false;
    try { denied.nextModel(); } catch (error) { oldGrantDenied = error instanceof Error && error.message === 'discovery-not-authorized'; }
    denied.cancel(); check(oldGrantDenied, 'old-grant-transferred');
    const continuation = new AgentRun(target.store, target.activity, { binding: targetBinding, source: target.archive,
      ...(transport ? { encode: transport.encode.bind(transport) } : {}) }, route, budget);
    activeRun = continuation; continuation.receive(targetIntent.goalInput.eventId, targetGoal);
    let targetTurn = 0;
    const targetScript: AgentPump['stream'] = async function* (request, _signal, send) {
      const attempt = send(request.payload); target!.transport.send(request.payload, attempt); targetTurn++;
      const call = targetTurn === 1 ? { id: 'handoff-search', name: 'source.search', arguments: { query: 'HANDOFF-T18', scope: 'project' } }
        : targetTurn === 2 ? { id: 'handoff-expand', name: 'source.expand', arguments: { unitId: currentUnit.unitId, offset: 0, limit: 1024 } }
        : targetTurn === 3 ? { id: 'markdown-expand', name: 'source.expand', arguments: { unitId: handoffUnit.unitId, offset: 0, limit: 1024 } }
        : targetTurn === 4 ? { id: 'old-report-expand', name: 'source.expand', arguments: { unitId: firstUnit.unitId, offset: 0, limit: 1024 } } : null;
      yield { kind: 'complete', reply: call ? { text: '', calls: [call], stop: 'tools' }
        : { text: '{"assessment":"requires-current-source-review","authority":"local-only"}', calls: [], stop: 'end' } };
    };
    await pumpAgent(continuation, { stream: transport ? transport.stream.bind(transport) : targetScript,
      recoverInfo: () => deliverMemoryInfo(sandbox, target!),
      async execute() { throw new Error('target-host-tool-unavailable'); } });
    const assessment = JSON.parse(finalText(target, continuation)) as { assessment: string; authority: string };
    const expansions = continuation.status().tools.filter(tool => tool.name === 'source.expand' && tool.result?.outcome === 'success')
      .map(tool => JSON.parse(JSON.parse(target!.archive.read(tool.result!.source).text).modelResult) as { unitId: string; text: string });
    const deletedHandoffRecovered = expansions.some(excerpt => excerpt.unitId === handoffUnit.unitId && excerpt.text === handoff.body);
    const reportVersionsRecovered = expansions.some(excerpt => excerpt.unitId === firstUnit.unitId && excerpt.text === fixture.approvedSection)
      && expansions.some(excerpt => excerpt.unitId === currentUnit.unitId && excerpt.text === fixture.approvedNextSection);
    check(assessment.assessment === 'requires-current-source-review' && assessment.authority === 'local-only'
      && deletedHandoffRecovered && reportVersionsRecovered, 'handoff-evidence-gap');
    const proposalValue = { target: 'src/logging.ts', targetType: 'code' as const, owner: targetBinding.ownerId,
      scope: { kind: 'project' as const, id: targetBinding.projectId, resolved: true },
      expectedChange: fixture.approvedNextSection, evidenceRefs: [], sourceUnits: [currentUnit.unitId],
      evaluation: { schema: 'evaluation-contract@1' as const, level: 'L1' as const, assertions: ['PROPOSAL-T18: Review current synthetic source conditions before any implementation.'] } };
    const proposalApproval = target.archive.append(randomUUID(), JSON.stringify({ schema: 'analysis-proposal-approval@1', proposal: proposalValue }));
    const proposal = target.store.saveEvolutionProposal(target.activity, proposalApproval, proposalValue);
    target.store.drainSourceProjection(target.activity);
    const proposalRun = new AgentRun(target.store, target.activity, { binding: targetBinding, source: target.archive,
      ...(transport ? { encode: transport.encode.bind(transport) } : {}) }, route, budget);
    activeRun = proposalRun;
    proposalRun.receive(randomUUID(), 'Continue with PROPOSAL-T18: use source.search scope=project and source.expand to read the saved inert proposal. '
      + 'Evaluate the required current-source review without implementing anything. Return exactly {"assessment":"requires-current-source-review","authority":"local-only","proposal":"inert"}.');
    let proposalTurn = 0;
    const proposalScript: AgentPump['stream'] = async function* (request, _signal, send) {
      const attempt = send(request.payload); target!.transport.send(request.payload, attempt); proposalTurn++;
      const call = proposalTurn === 1 ? { id: 'proposal-search', name: 'source.search', arguments: { query: 'PROPOSAL-T18', scope: 'project' } }
        : proposalTurn === 2 ? { id: 'proposal-expand', name: 'source.expand', arguments: { unitId: proposal.proposalId, offset: 0, limit: 4096 } } : null;
      yield { kind: 'complete', reply: call ? { text: '', calls: [call], stop: 'tools' }
        : { text: '{"assessment":"requires-current-source-review","authority":"local-only","proposal":"inert"}', calls: [], stop: 'end' } };
    };
    await pumpAgent(proposalRun, { stream: transport ? transport.stream.bind(transport) : proposalScript,
      recoverInfo: () => deliverMemoryInfo(sandbox, target!), async execute() { throw new Error('target-host-tool-unavailable'); } });
    const proposedAssessment = JSON.parse(finalText(target, proposalRun)) as { assessment: string; authority: string; proposal: string };
    const proposalContinued = proposedAssessment.assessment === 'requires-current-source-review' && proposedAssessment.authority === 'local-only'
      && proposedAssessment.proposal === 'inert' && proposalRun.status().tools.some(tool => {
        if (tool.name !== 'source.expand' || tool.result?.outcome !== 'success') return false;
        const excerpt = JSON.parse(JSON.parse(target!.archive.read(tool.result.source).text).modelResult) as { unitId: string; text: string };
        return excerpt.unitId === proposal.proposalId && excerpt.text.includes('PROPOSAL-T18');
      });
    check(proposalContinued, 'proposal-continuation-evidence-gap');
    const targetArtifacts = new AnalysisArtifacts(target.store, target.activity, target.archive);
    const selection = [{ unitId: proposal.proposalId, hash: proposal.hash }];
    const exportApproval = target.archive.append(randomUUID(), JSON.stringify({ schema: 'analysis-export-approval@1', selection }));
    const exported = targetArtifacts.exportMarkdown({ eventId: randomUUID(), selection, approval: exportApproval });
    emit('context-result', { syntheticPassed: true, realProvider: Boolean(transport), networkCount: transport?.count ?? 0,
      fixtureProviderCount: origin.transport.count + target.transport.count,
      verdict: transport ? 'controlled-real-loop-passed' : 'evidence-gap', fixtureDigest: sha256(JSON.stringify(fixture)), route, budget,
      originRunId: run.runId, targetRunId: continuation.runId, proposalRunId: proposalRun.runId, targetBinding, originWindows: status.windows.map(window => window.windowId),
      report: report.ref, reportVersion: updated.version, approvedUnits: [firstUnit.unitId, currentUnit.unitId],
      proposalId: proposal.proposalId, exportHash: exported.hash, deletedHandoffRecovered, reportVersionsRecovered, unavailableContinued, proposalContinued, oldGrantDenied,
      gaps: transport ? [] : ['real-provider-long-session-and-new-session-behavior'] });
  } finally {
    process.off('SIGINT', abort); target?.close(); source.close(); origin.close();
    rmSync(resources, { recursive: true, force: true });
  }
}
