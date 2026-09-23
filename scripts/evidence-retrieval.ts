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
  first.store.transitionIntent(first.activity, null, input, { status: 'active', step: 'analysis' }, text);
  const { grantId } = first.store.authorizeMemoryDiscovery(first.activity, input, [sandbox.fixture.projectId, other.projectId], 2);
  const cross = first.store.searchMemories(first.activity, { query: 'Atlas', grantId, limit: 1 });
  first.store.revokeMemoryDiscovery(first.activity, grantId);
  let revoked = false;
  try { first.store.searchMemories(first.activity, { query: 'Atlas', grantId, cursor: cross.nextCursor! }); }
  catch (error) { revoked = error instanceof Error && error.message === 'discovery-not-authorized'; }
  const passed = local.status === 'ready' && local.results.length === 1
    && local.results[0]?.projectId === sandbox.fixture.projectId && cross.status === 'ready'
    && cross.results.length === 1 && cross.truncated && cross.nextCursor !== null && revoked;
  observations.push({ caseId: 'X01/X02/X05', local: local.results.map(hit => ({ id: hit.unitId, projectId: hit.projectId })),
    cross: cross.results.map(hit => ({ id: hit.unitId, projectId: hit.projectId })),
    allowed: cross.coverage.allowedProjects, truncated: cross.truncated, revoked, passed });
} finally { second.close(); first.close(); rmSync(sandbox.root, { recursive: true, force: true }); }

const passed = observations.every(item => (item as { passed: boolean }).passed);
const output = {
  schema: 't10-retrieval-evidence@1', at: new Date().toISOString(),
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  worktreeStatus: execFileSync('git', ['status', '--short'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean),
  environment, fixtureDigest, corpusDigests: digests, observations, passed,
};
const directory = join('artifacts', `t10-${Date.now()}`);
mkdirSync(directory, { recursive: true });
const path = join(directory, 'summary.json');
writeFileSync(path, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ path, passed, cases: observations.length, corpusDigests: digests }));
if (!passed) process.exitCode = 1;
