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
  const passed = local.status === 'ready' && local.results.length === 1
    && local.results[0]?.projectId === sandbox.fixture.projectId && crossFirst.status === 'ready'
    && crossSecond?.status === 'ready' && crossFirst.truncated && crossSecond.nextCursor === null
    && crossHits.length === 2 && new Set(crossHits.map(hit => hit.projectId)).size === 2
    && crossHits.some(hit => hit.projectId === other.projectId) && revoked;
  observations.push({ caseId: 'X01/X02/X05', local: local.results.map(hit => ({ id: hit.unitId, projectId: hit.projectId })),
    cross: crossHits.map(hit => ({ id: hit.unitId, projectId: hit.projectId, exposureMode: hit.exposureMode })),
    allowed: crossFirst.coverage.allowedProjects, inspected: crossFirst.coverage.inspectedProjects,
    candidateCount: crossFirst.coverage.candidateCount, pages: 2, truncated: crossFirst.truncated, revoked, passed });
} finally { second.close(); first.close(); rmSync(sandbox.root, { recursive: true, force: true }); }

const discovery = JSON.parse(discoveryBytes.toString('utf8')) as { schema: string; cases: { id: string; gold: string }[] };
assert.equal(discovery.schema, 't10-discovery-cases@1');
let focusedRaw = '', focusedPass = true;
try {
  focusedRaw = execFileSync(process.execPath,
    ['--test', 'apps/cli/test/memory-retrieval.test.ts', 'apps/cli/test/search-projection.test.ts'],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
} catch (error) {
  focusedPass = false;
  focusedRaw = String((error as { stdout?: string }).stdout ?? error);
}
const testLines = focusedRaw.split('\n');
for (const entry of discovery.cases) {
  const line = testLines.find(value => value.startsWith('✔ ') && value.includes(entry.id));
  observations.push({ caseId: entry.id, gold: entry.gold, testLine: line ?? null, passed: focusedPass && Boolean(line) });
}

const passed = observations.every(item => (item as { passed: boolean }).passed);
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
