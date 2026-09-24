import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSandbox, createSandboxSession, bindingOf } from '../apps/cli/src/sandbox.ts';
import { openProbe } from '../apps/cli/src/probe.ts';

const fixturePath = new URL('../fixtures/t11-source-cases.json', import.meta.url);
const expectedDigest = '9b8f153152d41fe4aec51703cb5166b8edb39fc07553a46aca9ac15d4bd25c7c';
const bytes = readFileSync(fixturePath);
const digest = createHash('sha256').update(bytes).digest('hex');
assert.equal(digest, expectedDigest, 'T11 fixture changed');
const fixture = JSON.parse(bytes.toString('utf8')) as {
  schema: string; report: { text: string; approved: string; hidden: string };
  proposal: { target: string; first: string; second: string };
};
assert.equal(fixture.schema, 't11-source-cases@1');
const sandbox = createSandbox();
const targetBinding = { ...bindingOf(sandbox), projectId: randomUUID(), sessionId: randomUUID() };
createSandboxSession(sandbox, targetBinding);
const origin = openProbe(sandbox);
const target = openProbe(sandbox, undefined, undefined, targetBinding);
const observations: Record<string, unknown> = {};
let scenarioError: string | null = null;
let environment: unknown;
try {
  environment = { node: process.version, platform: process.platform, sqlite: origin.store.diagnostics().sqlite };
  const report = origin.archive.append(randomUUID(), fixture.report.text, 'assistant');
  const recoveredAck = origin.archive.lookup(report.eventId);
  const goal = origin.archive.append(randomUUID(), 'Synthetic approved analysis handoff');
  const intent = origin.store.transitionIntent(origin.activity, null, goal, { status: 'active', step: 'analysis' },
    'Synthetic approved analysis handoff');
  const offset = Array.from(fixture.report.text).join('').indexOf(fixture.report.approved);
  const approval = origin.archive.append(randomUUID(), JSON.stringify({ schema: 'source-publication-approval@1',
    intentId: intent.intentId, goalEventId: intent.goalInput.eventId, ref: report,
    projectId: targetBinding.projectId, kind: 'report-section', offset, length: Array.from(fixture.report.approved).length }));
  const unit = origin.store.publishSourceUnit(origin.activity, { ref: report, projectId: targetBinding.projectId,
    kind: 'report-section', offset, length: Array.from(fixture.report.approved).length, approval });
  const replay = origin.store.publishSourceUnit(origin.activity, { ref: report, projectId: targetBinding.projectId,
    kind: 'report-section', offset, length: Array.from(fixture.report.approved).length, approval });
  const source = origin.archive.append(randomUUID(), 'Synthetic Atlas evidence');
  const scope = { kind: 'project' as const, id: sandbox.fixture.projectId, resolved: true };
  const base = { target: fixture.proposal.target, owner: sandbox.fixture.ownerId, scope, evidenceRefs: [source],
    evaluation: { schema: 'evaluation-contract@1' as const, level: 'L0' as const, assertions: ['Check source digest'] } };
  const first = origin.store.saveEvolutionProposal(origin.activity, source, { ...base, expectedChange: fixture.proposal.first });
  const second = origin.store.saveEvolutionProposal(origin.activity, source, {
    ...base, expectedChange: fixture.proposal.second, supersedes: first.proposalId });
  origin.store.drainSourceProjection(origin.activity);
  const local = target.store.searchSources(target.activity, { query: 'Atlas' });
  const hidden = target.store.searchSources(target.activity, { query: 'private' });
  const excerpt = target.store.expandSource(target.activity, { unitId: unit.unitId, offset: 0, limit: 4096 });
  let rawDenied = false;
  try { target.store.expandSource(target.activity, { ref: report, offset: 0, limit: 4096 }); }
  catch (error) { rawDenied = error instanceof Error && error.message === 'source-scope-mismatch'; }

  const candidate = origin.store.captureMemory(origin.activity, source, 'Atlas memory before correction',
    { type: 'fact', scope, appliesTo: [] }).record;
  const verified = origin.store.verifyMemory(origin.activity, candidate.recordId, candidate, 'pass', [source]).record;
  const active = origin.store.activateMemory(origin.activity, verified.recordId, verified).record;
  const turn = origin.session.prepare(randomUUID(), 'Inspect Atlas source', [active]);
  const sent = origin.session.dispatch(turn);
  const correction = origin.archive.append(randomUUID(), 'Atlas correction');
  origin.store.correctMemory(origin.activity, active.recordId, active, correction, 'Atlas memory after correction');
  const inspected = origin.store.inspectAssembly(origin.activity, turn.assemblyId);

  const task = target.archive.append(randomUUID(), 'Read approved Atlas project material');
  const targetIntent = target.store.transitionIntent(target.activity, null, task, { status: 'active', step: 'analysis' },
    'Read approved Atlas project material');
  const consent = target.archive.append(randomUUID(), JSON.stringify({ schema: 'memory-discovery-approval@1',
    intentId: targetIntent.intentId, goalEventId: targetIntent.goalInput.eventId,
    projectIds: [sandbox.fixture.projectId], targets: {}, maxResults: 4, maxBytes: 131072 }));
  const { grantId } = target.store.authorizeMemoryDiscovery(target.activity, consent, [sandbox.fixture.projectId], 4);
  const cross = target.store.searchSources(target.activity, { query: 'Atlas', grantId, queryId: randomUUID() });
  const historical = target.store.expandSource(target.activity, { unitId: first.proposalId, offset: 0, limit: 4096,
    grantId, queryId: randomUUID() });
  target.store.revokeMemoryDiscovery(target.activity, grantId);
  let revoked = false;
  try { target.store.expandSource(target.activity, { unitId: first.proposalId, offset: 0, limit: 40,
    grantId, queryId: randomUUID() }); }
  catch (error) { revoked = error instanceof Error && error.message === 'discovery-not-authorized'; }
  observations.source = { acknowledgement: report, recoveredAck, replayedUnitId: replay.unitId,
    unitId: unit.unitId, localStatus: local.status, localIds: local.results.map(hit => hit.unitId),
    hiddenIds: hidden.results.map(hit => hit.unitId), rawDenied, excerpt, fixtureDigest: digest };
  observations.proposal = { first: { id: first.proposalId, version: first.version, hash: first.hash },
    second: { id: second.proposalId, version: second.version, hash: second.hash },
    crossStatus: cross.status, crossIds: cross.results.map(hit => hit.unitId),
    historical: { contentHash: historical.contentHash, excerptHash: historical.excerptHash, text: historical.text }, revoked };
  observations.assembly = { id: turn.assemblyId, state: inspected.state, sent: sent.outcome,
    usedSourceIds: inspected.sources.map(item => item.ref.eventId),
    usedMemory: inspected.memories.map(item => ({ id: item.snapshot.recordId, revision: item.snapshot.revisionId,
      contentHash: item.snapshot.contentHash, content: item.snapshot.content })),
    currentMemory: origin.store.readMemory(origin.activity, active.recordId).content };
  assert.deepEqual(recoveredAck, report);
  assert.equal(replay.unitId, unit.unitId);
  assert.deepEqual(local.results.map(hit => hit.unitId), [unit.unitId]);
  assert.deepEqual(hidden.results, []);
  assert.equal(excerpt.text, fixture.report.approved);
  assert(rawDenied && revoked);
  assert.equal(cross.status, 'ready');
  assert.deepEqual(cross.results.map(hit => hit.unitId), [first.proposalId, second.proposalId]);
  assert.equal(historical.contentHash, first.hash);
  assert(historical.text.includes(fixture.proposal.first) && !historical.text.includes(fixture.proposal.second));
  assert.equal(inspected.state, 'finished');
  assert.deepEqual(inspected.sources.map(item => item.ref.eventId), [turn.input.eventId]);
  assert.equal(inspected.memories[0]?.snapshot.hash, active.hash);
  assert.notEqual(origin.store.readMemory(origin.activity, active.recordId).content, inspected.memories[0]?.snapshot.content);
} catch (error) { scenarioError = error instanceof Error ? error.stack ?? error.message : String(error); }
finally { target.close(); origin.close(); rmSync(sandbox.root, { recursive: true, force: true }); }

let focusedRaw = '', focusedPass = true;
try { focusedRaw = execFileSync(process.execPath,
  ['--test', 'apps/cli/test/source-discovery.test.ts', 'apps/cli/test/source-recovery.test.ts'],
  { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }); }
catch (error) { focusedPass = false; focusedRaw = String((error as { stdout?: string }).stdout ?? error); }
const passed = !scenarioError && focusedPass;
const output = { schema: 't11-source-evidence@1', at: new Date().toISOString(),
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  worktreeStatus: execFileSync('git', ['status', '--short'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean),
  environment, fixture: { schema: fixture.schema, digest }, observations, scenarioError, focusedPass, passed };
const directory = join('artifacts', `t11-${Date.now()}`);
mkdirSync(directory, { recursive: true });
const path = join(directory, 'summary.json');
writeFileSync(path, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' });
writeFileSync(join(directory, 'focused-test.txt'), focusedRaw, { flag: 'wx' });
console.log(JSON.stringify({ path, passed, fixtureDigest: digest, scenarioError }));
if (!passed) process.exitCode = 1;
