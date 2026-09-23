import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSandbox, createSandboxSession, bindingOf } from '../apps/cli/src/sandbox.ts';
import { openProbe } from '../apps/cli/src/probe.ts';

const heldoutPath = new URL('../fixtures/t10-retrieval-heldout.json', import.meta.url);
const discoveryPath = new URL('../fixtures/t10-discovery-cases.json', import.meta.url);
const digests = {
  heldout: 'caf4e7ecd16061e9c96b92592d871501ea457b5bf5dd0c9334f9adbe031adb42',
  discovery: 'a0b0174ca827c07b4ef2df11972731a7103c9bff3c71fea5269e95cfe02b694f',
};
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const heldoutBytes = readFileSync(heldoutPath);
const discoveryBytes = readFileSync(discoveryPath);
assert.equal(digest(heldoutBytes), digests.heldout);
assert.equal(digest(discoveryBytes), digests.discovery);
const corpus = JSON.parse(heldoutBytes.toString('utf8')) as {
  schema: string; set: string; cases: { id: string; content: string; query: string; gold: 'hit' | 'empty' }[];
};
assert.equal(corpus.schema, 't10-retrieval-corpus@1');
assert.equal(corpus.set, 'held-out');
const observations: unknown[] = [];
const discovery = JSON.parse(discoveryBytes.toString('utf8')) as { schema: string; cases: { id: string; gold: string }[] };
assert.equal(discovery.schema, 't10-discovery-cases@1');
const discoveryObservations = new Set<string>();
function judgeDiscovery(caseId: string, observed: string, detail: unknown): void {
  const entry = discovery.cases.find(item => item.id === caseId);
  assert(entry && !discoveryObservations.has(caseId), `unknown or duplicate case: ${caseId}`);
  discoveryObservations.add(caseId);
  observations.push({ caseId, gold: entry.gold, observed, detail, passed: observed === entry.gold });
}
let environment: unknown;
let fixtureDigest = '';
for (const entry of corpus.cases) {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    environment ??= { platform: process.platform, node: process.version, sqlite: probe.store.diagnostics().sqlite };
    fixtureDigest = sandbox.fixtureDigest;
    const source = probe.archive.append(randomUUID(), `Synthetic evidence: ${entry.id}`);
    const captured = probe.store.captureMemory(probe.activity, source, entry.content, {
      type: 'fact', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: [],
    }).record;
    const verified = probe.store.verifyMemory(probe.activity, captured.recordId, captured, 'pass', [source]).record;
    probe.store.activateMemory(probe.activity, verified.recordId, verified);
    probe.store.drainSearchProjection(probe.activity);
    const page = probe.store.searchMemories(probe.activity, { query: entry.query });
    const observedIds = page.results.map(hit => hit.unitId);
    const passed = page.status === 'ready' && (entry.gold === 'hit'
      ? observedIds.length === 1 && observedIds[0] === captured.recordId && page.results[0]?.kind === 'memory'
      : observedIds.length === 0);
    observations.push({ caseId: entry.id, query: entry.query, gold: entry.gold, recordId: captured.recordId,
      observedIds, status: page.status, reason: page.coverage.reason, passed });
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
}

const sandbox = createSandbox();
const other = { ...bindingOf(sandbox), projectId: randomUUID(), sessionId: randomUUID() };
createSandboxSession(sandbox, other);
const first = openProbe(sandbox);
const second = openProbe(sandbox, undefined, undefined, other);
try {
  for (const [probe, projectId, content] of [
    [first, sandbox.fixture.projectId, 'Atlas primary'], [second, other.projectId, 'Atlas secondary'],
  ] as const) {
    const source = probe.archive.append(randomUUID(), `Synthetic evidence: ${content}`);
    const captured = probe.store.captureMemory(probe.activity, source, content, {
      type: 'fact', scope: { kind: 'project', id: projectId, resolved: true }, appliesTo: [],
    }).record;
    const verified = probe.store.verifyMemory(probe.activity, captured.recordId, captured, 'pass', [source]).record;
    probe.store.activateMemory(probe.activity, verified.recordId, verified);
    probe.store.drainSearchProjection(probe.activity);
  }
  const local = first.store.searchMemories(first.activity, { query: 'Atlas' });
  const text = 'Explicit synthetic owner grant for cross-project read-only analysis';
  const input = first.archive.append(randomUUID(), text);
  const intent = first.store.transitionIntent(first.activity, null, input, { status: 'active', step: 'analysis' }, text);
  const approved = first.archive.append(randomUUID(), JSON.stringify({ schema: 'memory-discovery-approval@1',
    intentId: intent.intentId, goalEventId: intent.goalInput.eventId,
    projectIds: [sandbox.fixture.projectId, other.projectId], targets: {}, maxResults: 4, maxBytes: 131072 }));
  const { grantId } = first.store.authorizeMemoryDiscovery(first.activity, approved, [sandbox.fixture.projectId, other.projectId], 4);
  const crossFirst = first.store.searchMemories(first.activity, { query: 'Atlas', grantId, limit: 1 });
  const crossSecond = crossFirst.nextCursor
    ? first.store.searchMemories(first.activity, { query: 'Atlas', grantId, limit: 1, cursor: crossFirst.nextCursor }) : null;
  const crossHits = [...crossFirst.results, ...(crossSecond?.results ?? [])];
  first.store.revokeMemoryDiscovery(first.activity, grantId);
  let revoked = false;
  try { first.store.searchMemories(first.activity, { query: 'Atlas', grantId, cursor: crossFirst.nextCursor! }); }
  catch (error) { revoked = error instanceof Error && error.message === 'discovery-not-authorized'; }
  judgeDiscovery('X01', local.status === 'ready' && local.results.length === 1
    && local.results[0]?.projectId === sandbox.fixture.projectId ? 'only-primary-project' : 'mismatch',
  { local: local.results.map(hit => ({ id: hit.unitId, projectId: hit.projectId })) });
  judgeDiscovery('X02', crossFirst.status === 'ready' && crossSecond?.status === 'ready' && crossFirst.truncated
    && crossSecond.nextCursor === null && crossHits.length === 2
    && new Set(crossHits.map(hit => hit.projectId)).size === 2
    && crossHits.some(hit => hit.projectId === other.projectId)
    && crossFirst.coverage.candidateCount === 2 ? 'both-projects-labelled' : 'mismatch',
  { cross: crossHits.map(hit => ({ id: hit.unitId, projectId: hit.projectId, exposureMode: hit.exposureMode })),
    allowed: crossFirst.coverage.allowedProjects, inspected: crossFirst.coverage.inspectedProjects,
    candidateCount: crossFirst.coverage.candidateCount, pages: 2 });
  let completedDenied = false, reactivatedDenied = false;
  const laterApproval = first.archive.append(randomUUID(), JSON.stringify({ schema: 'memory-discovery-approval@1',
    intentId: intent.intentId, goalEventId: intent.goalInput.eventId,
    projectIds: [other.projectId], targets: {}, maxResults: 1, maxBytes: 131072 }));
  const laterGrant = first.store.authorizeMemoryDiscovery(first.activity, laterApproval, [other.projectId], 1).grantId;
  const completeInput = first.archive.append(randomUUID(), 'Complete analysis');
  const completed = first.store.transitionIntent(first.activity, first.store.readIntent(first.activity)!.eventId,
    completeInput, { status: 'completed', step: 'done' });
  try { first.store.searchMemories(first.activity, { query: 'Atlas', grantId: laterGrant }); }
  catch (error) { completedDenied = error instanceof Error && error.message === 'discovery-not-authorized'; }
  const resumeInput = first.archive.append(randomUUID(), 'Resume after completion');
  first.store.transitionIntent(first.activity, completed.eventId, resumeInput, { status: 'active', step: 'new-analysis' });
  try { first.store.searchMemories(first.activity, { query: 'Atlas', grantId: laterGrant }); }
  catch (error) { reactivatedDenied = error instanceof Error && error.message === 'discovery-not-authorized'; }
  judgeDiscovery('X05', revoked && completedDenied && reactivatedDenied ? 'old-grant-and-cursor-denied' : 'mismatch',
    { revoked, completedDenied, reactivatedDenied, cursor: Boolean(crossFirst.nextCursor) });
  const unknown = randomUUID();
  const unknownApproval = first.archive.append(randomUUID(), JSON.stringify({ schema: 'memory-discovery-approval@1',
    intentId: intent.intentId, goalEventId: intent.goalInput.eventId,
    projectIds: [unknown], targets: {}, maxResults: 1, maxBytes: 131072 }));
  let denied: string | null = null;
  try { first.store.authorizeMemoryDiscovery(first.activity, unknownApproval, [unknown], 1); }
  catch (error) { denied = error instanceof Error ? error.message : String(error); }
  judgeDiscovery('X09', denied === 'discovery-project-unavailable' && !denied.includes(unknown)
    ? 'no-name-or-content-disclosed' : 'mismatch', { error: denied, undisclosed: !denied?.includes(unknown) });
} finally { second.close(); first.close(); rmSync(sandbox.root, { recursive: true, force: true }); }

const targetSandbox = createSandbox();
const targetBinding = { ...bindingOf(targetSandbox), projectId: randomUUID(), sessionId: randomUUID() };
createSandboxSession(targetSandbox, targetBinding);
const targetHost = openProbe(targetSandbox);
const targetSource = openProbe(targetSandbox, undefined, undefined, targetBinding);
try {
  const platform = process.platform === 'linux' ? 'win32' : 'linux';
  const source = targetSource.archive.append(randomUUID(), 'target evidence');
  const captured = targetSource.store.captureMemory(targetSource.activity, source, 'Linux socket mode', {
    type: 'fact', scope: { kind: 'project', id: targetBinding.projectId, resolved: true }, appliesTo: [`platform:${platform}`],
  }).record;
  const verified = targetSource.store.verifyMemory(targetSource.activity, captured.recordId, captured, 'pass', [source]).record;
  targetSource.store.activateMemory(targetSource.activity, verified.recordId, verified);
  targetSource.store.drainSearchProjection(targetSource.activity);
  const goal = 'Analyze target environment';
  const goalInput = targetHost.archive.append(randomUUID(), goal);
  const intent = targetHost.store.transitionIntent(targetHost.activity, null, goalInput, { status: 'active', step: 'analysis' }, goal);
  const knownTarget = { [targetBinding.projectId]: { agent: 'cli', platform } };
  const makeGrant = (targets: typeof knownTarget | Record<string, never>) => {
    const approval = targetHost.archive.append(randomUUID(), JSON.stringify({ schema: 'memory-discovery-approval@1',
      intentId: intent.intentId, goalEventId: intent.goalInput.eventId,
      projectIds: [targetBinding.projectId], targets, maxResults: 2, maxBytes: 131072 }));
    return targetHost.store.authorizeMemoryDiscovery(targetHost.activity, approval, [targetBinding.projectId], 2, targets).grantId;
  };
  const known = targetHost.store.searchMemories(targetHost.activity, { query: 'socket', grantId: makeGrant(knownTarget) });
  const unknown = targetHost.store.searchMemories(targetHost.activity, { query: 'socket', grantId: makeGrant({}) });
  const knownHit = known.results[0], unknownHit = unknown.results[0];
  judgeDiscovery('X03', known.status === 'ready' && knownHit?.kind === 'memory'
    && knownHit.projectId === targetBinding.projectId && knownHit.applicability === 'applicable'
    ? 'applicable-to-target' : 'mismatch', { status: known.status, kind: knownHit?.kind, applicability: knownHit?.kind === 'memory' ? knownHit.applicability : null });
  judgeDiscovery('X04', unknown.status === 'ready' && unknownHit?.kind === 'memory'
    && unknownHit.applicability === 'needs-verification' && unknownHit.exposureMode === 'reference_only'
    ? 'reference-needs-verification' : 'mismatch',
  { status: unknown.status, kind: unknownHit?.kind, exposureMode: unknownHit?.exposureMode });
} finally { targetSource.close(); targetHost.close(); rmSync(targetSandbox.root, { recursive: true, force: true }); }

const projectionSandbox = createSandbox();
const projection = openProbe(projectionSandbox);
try {
  const source = projection.archive.append(randomUUID(), 'projection evidence');
  const captured = projection.store.captureMemory(projection.activity, source, 'Atlas index', {
    type: 'fact', scope: { kind: 'project', id: projectionSandbox.fixture.projectId, resolved: true }, appliesTo: [],
  }).record;
  const verified = projection.store.verifyMemory(projection.activity, captured.recordId, captured, 'pass', [source]).record;
  projection.store.activateMemory(projection.activity, verified.recordId, verified);
  const pending = projection.store.searchMemories(projection.activity, { query: 'Atlas' });
  projection.store.rebuildSearchProjection(projection.activity);
  const rebuilt = projection.store.searchMemories(projection.activity, { query: 'Atlas' });
  judgeDiscovery('X06', pending.status === 'dirty' && pending.results.length === 0
    && pending.coverage.unavailableProjects.includes(projectionSandbox.fixture.projectId)
    ? 'dirty-not-empty-answer' : 'mismatch', { status: pending.status, reason: pending.coverage.reason, unavailable: pending.coverage.unavailableProjects });
  judgeDiscovery('X07', rebuilt.status === 'ready' && rebuilt.results.length === 1
    && rebuilt.results[0]?.kind === 'memory' && rebuilt.results[0].unitId === captured.recordId
    ? 'same-current-canonical' : 'mismatch', { status: rebuilt.status, unitIds: rebuilt.results.map(hit => hit.unitId) });
} finally { projection.close(); rmSync(projectionSandbox.root, { recursive: true, force: true }); }

const conflictSandbox = createSandbox();
const conflictProbe = openProbe(conflictSandbox);
try {
  const records = ['Atlas index enabled', 'Atlas index disabled'].map(content => {
    const source = conflictProbe.archive.append(randomUUID(), `Evidence: ${content}`);
    const captured = conflictProbe.store.captureMemory(conflictProbe.activity, source, content, {
      type: 'fact', scope: { kind: 'project', id: conflictSandbox.fixture.projectId, resolved: true }, appliesTo: [],
    }).record;
    const verified = conflictProbe.store.verifyMemory(conflictProbe.activity, captured.recordId, captured, 'pass', [source]).record;
    return conflictProbe.store.activateMemory(conflictProbe.activity, verified.recordId, verified).record;
  });
  const conflict = conflictProbe.store.conflictMemory(conflictProbe.activity,
    records[0]!.recordId, records[0]!, records[1]!.recordId, records[1]!);
  conflictProbe.store.rebuildSearchProjection(conflictProbe.activity);
  const page = conflictProbe.store.searchMemories(conflictProbe.activity, { query: 'Atlas' });
  const hit = page.results[0];
  judgeDiscovery('X08', page.status === 'ready' && page.results.length === 1 && hit?.kind === 'status'
    && hit.conflictSetId === conflict.conflictSetId && !JSON.stringify(hit).includes('Atlas index')
    ? 'status-only-without-content' : 'mismatch',
  { status: page.status, kind: hit?.kind, conflictSetId: hit?.kind === 'status' ? hit.conflictSetId : null });
} finally { conflictProbe.close(); rmSync(conflictSandbox.root, { recursive: true, force: true }); }

for (const entry of discovery.cases) assert(discoveryObservations.has(entry.id), `unobserved case: ${entry.id}`);
let focusedRaw = '', focusedPass = true;
try {
  focusedRaw = execFileSync(process.execPath,
    ['--test', 'apps/cli/test/memory-retrieval.test.ts', 'apps/cli/test/search-projection.test.ts'],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
} catch (error) {
  focusedPass = false;
  focusedRaw = String((error as { stdout?: string }).stdout ?? error);
}
const passed = focusedPass && observations.every(item => (item as { passed: boolean }).passed);
const output = {
  schema: 't10-retrieval-evidence@1', at: new Date().toISOString(),
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  worktreeStatus: execFileSync('git', ['status', '--short'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean),
  environment, fixtureDigest, corpusDigests: digests, observations, focusedPass, passed,
};
const directory = join('artifacts', `t10-${Date.now()}`);
mkdirSync(directory, { recursive: true });
const path = join(directory, 'summary.json');
writeFileSync(path, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' });
writeFileSync(join(directory, 'focused-test.txt'), focusedRaw, { flag: 'wx' });
console.log(JSON.stringify({ path, passed, cases: observations.length, corpusDigests: digests }));
if (!passed) process.exitCode = 1;
