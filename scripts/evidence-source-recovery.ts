import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, copyFileSync, readdirSync } from 'node:fs';
import { arch, release } from 'node:os';
import { join } from 'node:path';
import { createSandbox, createSandboxSession, bindingOf } from '../apps/cli/src/sandbox.ts';
import { openProbe } from '../apps/cli/src/probe.ts';
import type { SourceUnitInput } from '@euler/core';

const repo = process.cwd();
const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const copyTree = (source: string, target: string): void => {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(target, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else copyFileSync(from, to);
  }
};
const listFiles = (root: string, prefix = ''): string[] => readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(entry => {
  const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
  return entry.isDirectory() ? listFiles(root, relative) : [relative];
});
const startedAt = new Date().toISOString();
type ProcessReceipt = { command: string; args: string[]; cwd: string; startedAt: string; finishedAt: string;
  code: number | null; signal: string | null; stdout: { path: string; sha256: string }; stderr: { path: string; sha256: string } };
const processes: ProcessReceipt[] = [];

const fixturePath = new URL('../fixtures/t11-source-cases.json', import.meta.url);
const expectedDigest = '13bfeb501644eb497d97914f3e508a7b7e21ef2b52b82ef5d5f34105dfb11e7e';
const bytes = readFileSync(fixturePath);
const fixtureDigest = sha256(bytes);
assert.equal(fixtureDigest, expectedDigest, 'T11 fixture changed');
const fixture = JSON.parse(bytes.toString('utf8')) as {
  schema: string; report: { text: string; approved: string; hidden: string };
  proposal: { target: string; first: string; second: string };
};
assert.equal(fixture.schema, 't11-source-cases@1');
const sandbox = createSandbox();
const directory = join('artifacts', `t11-${Date.now()}`);
mkdirSync(directory, { recursive: true });
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
  const index = fixture.report.text.indexOf(fixture.report.approved);
  assert(index >= 0);
  const offset = Array.from(fixture.report.text.slice(0, index)).length;
  let unapprovedDenied = false;
  try { origin.store.publishSourceUnit(origin.activity, { ref: report, projectId: sandbox.fixture.projectId,
    kind: 'report-section', offset: 0, length: Array.from(fixture.report.hidden).length } as SourceUnitInput); }
  catch (error) { unapprovedDenied = error instanceof Error && error.message === 'source-publication-approval-required'; }
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
    hiddenIds: hidden.results.map(hit => hit.unitId), unapprovedDenied, rawDenied, excerpt, fixtureDigest };
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
  assert(unapprovedDenied && rawDenied && revoked);
  assert.equal(cross.status, 'ready');
  assert.deepEqual(cross.results.map(hit => hit.unitId), [first.proposalId, second.proposalId]);
  assert.equal(historical.contentHash, first.hash);
  assert(historical.text.includes(fixture.proposal.first) && !historical.text.includes(fixture.proposal.second));
  assert.equal(inspected.state, 'finished');
  assert.deepEqual(inspected.sources.map(item => item.ref.eventId), [turn.input.eventId]);
  assert.equal(inspected.memories[0]?.snapshot.hash, active.hash);
  assert.notEqual(origin.store.readMemory(origin.activity, active.recordId).content, inspected.memories[0]?.snapshot.content);
} catch (error) { scenarioError = error instanceof Error ? error.stack ?? error.message : String(error); }
finally {
  target.close();
  origin.close();
  copyTree(sandbox.root, join(directory, 'raw'));
  rmSync(sandbox.root, { recursive: true, force: true });
}

let focusedRaw = '', focusedStderr = '', focusedPass = false;
let focusedCode: number | null = null;
let focusedSignal: string | null = null;
const focusedArgs = ['--test', 'apps/cli/test/source-discovery.test.ts', 'apps/cli/test/source-recovery.test.ts'];
const focusedStartedAt = new Date().toISOString();
const focusedResult = spawnSync(process.execPath, focusedArgs, {
  cwd: repo, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
});
focusedRaw = String(focusedResult.stdout ?? '');
focusedStderr = String(focusedResult.stderr ?? '');
focusedCode = focusedResult.status;
focusedSignal = focusedResult.signal;
focusedPass = focusedResult.status === 0 && focusedResult.signal === null && !focusedResult.error;
const focusedFinishedAt = new Date().toISOString();

const sourceObservation = observations.source as { acknowledgement?: unknown; recoveredAck?: unknown; localStatus?: string;
  unitId?: string; replayedUnitId?: string; excerpt?: { text?: string }; unapprovedDenied?: boolean; rawDenied?: boolean;
  revoked?: boolean } | undefined;
const proposalObservation = observations.proposal as { historical?: { contentHash?: string; text?: string };
  first?: { hash?: string }; second?: { hash?: string }; crossStatus?: string; revoked?: boolean } | undefined;
const assemblyObservation = observations.assembly as { state?: string; sent?: string; usedSourceIds?: string[];
  usedMemory?: unknown[] } | undefined;
const assertions = [
  { name: 'archive acknowledgement survives lookup', passed: !scenarioError && Boolean(sourceObservation?.acknowledgement && sourceObservation.recoveredAck) },
  { name: 'published source identity is stable', passed: !scenarioError && sourceObservation?.unitId === sourceObservation?.replayedUnitId },
  { name: 'search and bounded expansion return the approved range', passed: !scenarioError && sourceObservation?.localStatus === 'ready'
      && sourceObservation.excerpt?.text === fixture.report.approved },
  { name: 'publication, raw scope and revocation denials are explicit', passed: !scenarioError
      && sourceObservation?.unapprovedDenied === true && sourceObservation?.rawDenied === true && proposalObservation?.revoked === true },
  { name: 'historical proposal bytes remain independent', passed: !scenarioError && proposalObservation?.crossStatus === 'ready'
      && proposalObservation.historical?.text?.includes(fixture.proposal.first) === true
      && proposalObservation.historical?.text?.includes(fixture.proposal.second) === false },
  { name: 'assembly inspect reports the frozen used snapshots', passed: !scenarioError && assemblyObservation?.state === 'finished'
      && assemblyObservation.usedSourceIds?.length === 1 && (assemblyObservation.usedMemory?.length ?? 0) === 1 },
  { name: 'focused T11 tests pass', passed: focusedPass },
].map(assertion => assertion.passed ? assertion : { ...assertion, error: scenarioError ?? 'assertion failed' });

writeFileSync(join(directory, 'fixture.json'), bytes, { flag: 'wx' });
writeFileSync(join(directory, 'observations.json'), JSON.stringify(observations, null, 2) + '\n', { flag: 'wx' });
writeFileSync(join(directory, 'focused-test.txt'), focusedRaw, { flag: 'wx' });
writeFileSync(join(directory, 'focused-stderr.txt'), focusedStderr, { flag: 'wx' });
writeFileSync(join(directory, 'console-output.txt'), JSON.stringify({ scenarioError, focusedCode, focusedSignal }) + '\n', { flag: 'wx' });
writeFileSync(join(directory, 'main-stderr.txt'), '', { flag: 'wx' });
const finishedAt = new Date().toISOString();
const implementationCommit = execFileSync('git', ['--no-optional-locks', 'rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const implementationTree = execFileSync('git', ['--no-optional-locks', 'rev-parse', 'HEAD^{tree}'], { cwd: repo, encoding: 'utf8' }).trim();
const workingTree = execFileSync('git', ['--no-optional-locks', 'status', '--short'], { cwd: repo, encoding: 'utf8' }).trim();
const preliminaryStatus = !scenarioError && focusedPass && assertions.every(assertion => assertion.passed) ? 'pass' : 'fail';
const artifactFiles = listFiles(directory).filter(path => path !== 'summary.json');
const files = artifactFiles.map(path => ({ path, sha256: sha256(readFileSync(join(directory, path))) }));
const focusedProcess: ProcessReceipt = { command: process.execPath, args: focusedArgs, cwd: repo, startedAt: focusedStartedAt,
  finishedAt: focusedFinishedAt, code: focusedCode, signal: focusedSignal,
  stdout: { path: 'focused-test.txt', sha256: files.find(file => file.path === 'focused-test.txt')!.sha256 },
  stderr: { path: 'focused-stderr.txt', sha256: files.find(file => file.path === 'focused-stderr.txt')!.sha256 } };
const mainProcess: ProcessReceipt = { command: process.execPath, args: [...process.execArgv, ...process.argv.slice(1)], cwd: repo,
  startedAt, finishedAt, code: preliminaryStatus === 'pass' ? 0 : 1, signal: null,
  stdout: { path: 'console-output.txt', sha256: files.find(file => file.path === 'console-output.txt')!.sha256 },
  stderr: { path: 'main-stderr.txt', sha256: files.find(file => file.path === 'main-stderr.txt')!.sha256 } };
processes.push(mainProcess, focusedProcess);
const controlledSideEffects = [
  { path: sandbox.root, disposition: 'remove' as const, existsAtFinish: existsSync(sandbox.root) },
  { path: directory, disposition: 'retain' as const, existsAtFinish: existsSync(directory) },
];
const databaseArtifacts = files.filter(file => file.path.startsWith('raw/')
  && (file.path.endsWith('probe.sqlite') || file.path.includes('probe.sqlite-')));
const sidecarArtifacts = files.filter(file => file.path.startsWith('raw/') && !databaseArtifacts.some(database => database.path === file.path));
const output = {
  schema: 't11-source-evidence@2', schemaVersion: 2, experimentId: 'X-04/T11-source-recovery-synthetic',
  specCommit: '56217fc292a1a640805ee65096d60ff014430db3',
  authorityRefs: ['https://github.com/qsgy-edge/euler/issues/11', 'docs/implementation/t11-source-recovery.md',
    'docs/architecture/issues/12-build-evidence-experiment-matrix.md#统一-receipt-与复刻位置',
    'docs/architecture/issues/15-euler-v1-spec.md#source-recovery-and-actual-used'],
  command: { executable: process.execPath, args: [...process.execArgv, ...process.argv.slice(1)], cwd: repo },
  startedAt, finishedAt, implementationCommit, implementationTree, workingTree,
  environment: { platform: process.platform, release: release(), architecture: arch(), node: process.version,
    sqlite: environment && typeof environment === 'object' && 'sqlite' in environment ? (environment as { sqlite: unknown }).sqlite : 'unknown',
    provider: 'none: no provider requests', model: 'none', adapter: 'euler-cli-carrier@1', runner: process.env.CI ? 'CI' : 'local' },
  fixture: { path: 'fixtures/t11-source-cases.json', rawDigest: fixtureDigest, digest: fixtureDigest, synthetic: true, heldOut: false },
  heldOut: { digest: null, owner: null, sealedCommit: null, releasedCommit: null, contaminationCaseIds: [], replacementCaseIds: [],
    applicability: 'not-applicable: deterministic synthetic fixture; no held-out quality claim' },
  processes, assertions, files, controlledSideEffects,
  artifactDigests: { stdout: focusedProcess.stdout, stderr: focusedProcess.stderr,
    database: databaseArtifacts, sidecars: sidecarArtifacts },
  independentValidation: { method: 'raw fixture/observation/console sidecars and node:crypto; no Core replay or reported verdict',
    verifier: { path: 'scripts/evidence-source-recovery.ts', sha256: sha256(readFileSync(new URL('./evidence-source-recovery.ts', import.meta.url))) }, status: preliminaryStatus },
  observations, scenarioError, focusedPass, status: preliminaryStatus,
  exit: { code: preliminaryStatus === 'pass' ? 0 : 1, signal: null as string | null },
  evidenceGaps: ['Real provider/Host consumers and authenticated owner UI remain unverified',
    'Report/proposal generation and export remain T13/T18 work', 'Production schema migration and backup/purge remain outside T11',
    'Other OS host results require their matching CI/host artifacts'],
};
function validateReceipt(receipt: typeof output) {
  for (const key of ['schema','schemaVersion','experimentId','specCommit','authorityRefs','command','startedAt','finishedAt',
    'implementationCommit','implementationTree','workingTree','environment','fixture','heldOut','processes','assertions','files',
    'controlledSideEffects','artifactDigests','independentValidation','status','exit'] as const) assert.ok(Object.hasOwn(receipt, key), `missing ${key}`);
  assert.ok(receipt.authorityRefs.length > 0);
  for (const key of ['platform','release','architecture','node','sqlite','provider','model','adapter'] as const) assert.ok(receipt.environment[key]);
  for (const key of ['digest','owner','sealedCommit','releasedCommit','contaminationCaseIds','replacementCaseIds','applicability'] as const) {
    assert.ok(Object.hasOwn(receipt.heldOut, key), `missing heldOut.${key}`);
  }
  assert.equal(receipt.fixture.rawDigest, sha256(readFileSync(join(repo, receipt.fixture.path))));
  assert.ok(receipt.command.executable && receipt.command.args.length > 0 && receipt.command.cwd);
  assert.ok(Date.parse(receipt.finishedAt) >= Date.parse(receipt.startedAt));
  for (const process of receipt.processes) {
    assert.ok(process.command && process.args && process.cwd && process.startedAt && process.finishedAt);
    assert.ok(Date.parse(process.finishedAt) >= Date.parse(process.startedAt));
    assert.ok(Object.hasOwn(process, 'code') && Object.hasOwn(process, 'signal'));
    assert.ok(process.stdout.path && process.stderr.path && process.stdout.sha256 && process.stderr.sha256);
    assert.equal(process.stdout.sha256, receipt.files.find(file => file.path === process.stdout.path)?.sha256);
    assert.equal(process.stderr.sha256, receipt.files.find(file => file.path === process.stderr.path)?.sha256);
  }
  assert.ok(receipt.assertions.length > 0 && receipt.assertions.every(assertion => Object.hasOwn(assertion, 'name') && Object.hasOwn(assertion, 'passed'))
    && receipt.files.length > 0);
  assert.ok(receipt.artifactDigests.database.length > 0 && receipt.artifactDigests.sidecars.length > 0);
  assert.equal(receipt.independentValidation.verifier.sha256,
    sha256(readFileSync(join(repo, receipt.independentValidation.verifier.path))));
  for (const file of receipt.files) {
    assert.ok(!file.path.startsWith('/') && !file.path.split('/').includes('..'));
    assert.equal(file.sha256, sha256(readFileSync(join(directory, file.path))), `raw digest: ${file.path}`);
  }
  for (const effect of receipt.controlledSideEffects) assert.equal(effect.existsAtFinish, effect.disposition === 'retain', effect.path);
}
let receiptError: string | null = null;
try { validateReceipt(output); }
catch (error) { receiptError = error instanceof Error ? error.stack ?? error.message : String(error); }
output.independentValidation.status = receiptError ? 'fail' : 'pass';
output.status = preliminaryStatus === 'pass' && !receiptError ? 'pass' : 'fail';
output.exit.code = output.status === 'pass' ? 0 : 1;
mainProcess.code = output.exit.code;
(output as typeof output & { receiptError: string | null }).receiptError = receiptError;
writeFileSync(join(directory, 'summary.json'), JSON.stringify(output, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ path: join(directory, 'summary.json'), passed: output.status === 'pass', fixtureDigest, scenarioError, receiptError }));
if (output.status !== 'pass') process.exitCode = 1;
