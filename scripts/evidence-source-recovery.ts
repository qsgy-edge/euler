import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, copyFileSync, readdirSync } from 'node:fs';
import { arch, release } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
const mainStderr: string[] = [];
const originalStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: string | Uint8Array, ...args: any[]) => {
  mainStderr.push(Buffer.from(chunk).toString('utf8'));
  return originalStderrWrite(chunk, ...args);
}) as typeof process.stderr.write;

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
let crossGrantId: string | null = null;
let crossQueryId: string | null = null;
let crossExpandQueryId: string | null = null;
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
  crossGrantId = grantId;
  crossQueryId = randomUUID();
  const crossRequest = { query: 'Atlas', grantId, queryId: crossQueryId };
  const cross = target.store.searchSources(target.activity, crossRequest);
  const crossReplay = target.store.searchSources(target.activity, crossRequest);
  const crossExpandRequest = { unitId: first.proposalId, offset: 0, limit: 4096, grantId, queryId: randomUUID() };
  crossExpandQueryId = crossExpandRequest.queryId;
  const historical = target.store.expandSource(target.activity, crossExpandRequest);
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
    crossStatus: cross.status, crossReplayStatus: crossReplay.status, crossIds: cross.results.map(hit => hit.unitId),
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
  assert.equal(crossReplay.status, 'ready');
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

const rawValidation = (() => {
  try {
    const approvedOffset = Array.from(fixture.report.text.slice(0, fixture.report.text.indexOf(fixture.report.approved))).length;
    const archiveText = readFileSync(join(directory, 'raw', 'session.jsonl'), 'utf8');
    assert(archiveText.endsWith('\n'), 'raw archive incomplete');
    const archiveLines = archiveText.slice(0, -1).split('\n');
    const header = JSON.parse(archiveLines.shift()!);
    assert.equal(header.schema, 'cli-session@1');
    const rawEvents = archiveLines.map(rawLine => {
      const event = JSON.parse(rawLine) as { schema: string; eventId: string; role: string; text: string };
      assert.equal(rawLine, JSON.stringify(event), 'raw archive line is not canonical JSON');
      assert.equal(event.schema, 'cli-input@1');
      assert(['user', 'assistant', 'tool'].includes(event.role));
      assert(typeof event.text === 'string' && event.text.length > 0);
      return { ...event, rawLine };
    });
    const reportEvent = rawEvents.find(event => event.text === fixture.report.text);
    assert(reportEvent, 'raw archive report missing');
    const reportLine = reportEvent.rawLine;
    const db = new DatabaseSync(join(directory, 'raw', 'probe.sqlite'), { readOnly: true });
    try {
      const source = db.prepare(`SELECT unit_id, source_event_id, source_host_id, source_project_id, source_branch_id, source_hash, source_byte_length, source_content_hash,
        source_locator, kind, version, supersedes, offset, length, content_hash, approval_event_id, approval_locator,
        approval_hash, approval_byte_length, approval_content_hash, payload, payload_hash, project_id
        FROM source_units WHERE project_id=? AND kind='report-section' AND offset=? AND length=?`).get(
        targetBinding.projectId, approvedOffset, Array.from(fixture.report.approved).length) as Record<string, unknown> | undefined;
      assert(source, 'raw source unit missing');
      assert.equal(source.source_event_id, reportEvent.eventId);
      assert.equal(source.source_locator, `cli-jsonl@1/${sandbox.fixture.sessionId}/${reportEvent.eventId}`);
      assert.equal(source.source_hash, sha256(reportLine));
      assert.equal(source.source_byte_length, Buffer.byteLength(reportLine));
      assert.equal(source.source_content_hash, sha256(fixture.report.text));
      assert.equal(source.content_hash, sha256(fixture.report.approved));
      const sourcePayload = JSON.parse(String(source.payload)) as { schema: string; unitId: string; projectId: string;
        kind: string; offset: number; length: number; contentHash: string; version: number; supersedes: string | null;
        ref: { binding: { sessionId: string; hostId: string; projectId: string; branchId: string }; eventId: string; locator: string; hash: string; byteLength: number; contentHash: string };
        approval: { eventId: string; locator: string; hash: string; byteLength: number; contentHash: string } };
      assert.equal(source.payload_hash, sha256(String(source.payload)));
      assert.equal(sourcePayload.schema, 'source-unit@1');
      assert.equal(sourcePayload.unitId, source.unit_id);
      assert.equal(sourcePayload.projectId, source.project_id);
      assert.equal(sourcePayload.kind, source.kind);
      assert.equal(sourcePayload.offset, source.offset);
      assert.equal(sourcePayload.length, source.length);
      assert.equal(sourcePayload.contentHash, source.content_hash);
      assert.equal(sourcePayload.version, source.version);
      assert.equal(sourcePayload.supersedes, source.supersedes);
      assert.equal(sourcePayload.ref.eventId, source.source_event_id);
      assert.equal(sourcePayload.ref.locator, source.source_locator);
      assert.equal(sourcePayload.ref.hash, source.source_hash);
      assert.equal(sourcePayload.ref.byteLength, source.source_byte_length);
      assert.equal(sourcePayload.ref.contentHash, source.source_content_hash);
      assert.equal(sourcePayload.ref.binding.hostId, source.source_host_id);
      assert.equal(sourcePayload.ref.binding.projectId, source.source_project_id);
      assert.equal(sourcePayload.ref.binding.branchId, source.source_branch_id);
      const approvalEvent = rawEvents.find(event => event.eventId === source.approval_event_id);
      assert(approvalEvent, 'raw approval event missing');
      assert.equal(approvalEvent.role, 'user');
      const approvalDecision = JSON.parse(approvalEvent.text) as { schema: string; intentId: string; goalEventId: string;
        ref: typeof sourcePayload.ref; projectId: string; kind: string; offset: number; length: number };
      assert.equal(approvalDecision.schema, 'source-publication-approval@1');
      assert.equal(Object.keys(approvalDecision).sort().join(','),
        'goalEventId,intentId,kind,length,offset,projectId,ref,schema');
      assert.deepEqual(approvalDecision.ref, sourcePayload.ref);
      assert.equal(approvalDecision.projectId, source.project_id);
      assert.equal(approvalDecision.kind, source.kind);
      assert.equal(approvalDecision.offset, source.offset);
      assert.equal(approvalDecision.length, source.length);
      assert(db.prepare(`SELECT 1 FROM intent_events WHERE intent_id=? AND goal_input_event_id=?
        AND session_id=? AND branch_id=? LIMIT 1`).get(approvalDecision.intentId, approvalDecision.goalEventId,
        sourcePayload.ref.binding.sessionId, sourcePayload.ref.binding.branchId));
      assert.equal(source.approval_locator, `cli-jsonl@1/${sandbox.fixture.sessionId}/${approvalEvent.eventId}`);
      assert.equal(source.approval_hash, sha256(approvalEvent.rawLine));
      assert.equal(source.approval_byte_length, Buffer.byteLength(approvalEvent.rawLine));
      assert.equal(source.approval_content_hash, sha256(approvalEvent.text));
      assert.equal(sourcePayload.approval.eventId, source.approval_event_id);
      assert.equal(sourcePayload.approval.locator, source.approval_locator);
      assert.equal(sourcePayload.approval.hash, source.approval_hash);
      assert.equal(sourcePayload.approval.byteLength, source.approval_byte_length);
      assert.equal(sourcePayload.approval.contentHash, source.approval_content_hash);
      const projection = db.prepare(`SELECT rowid, content, content_hash, owner_kind, record_id, revision_id, scope_kind, scope_id,
        source_seq, tokenizer_version, projection_generation FROM search_documents WHERE unit_id=?`)
        .get(String(source.unit_id)) as Record<string, unknown> | undefined;
      assert(projection, 'raw source projection missing');
      assert.equal(projection.content, fixture.report.approved.toLocaleLowerCase());
      assert.equal(projection.content_hash, sha256(fixture.report.approved));
      assert.equal(projection.owner_kind, 'session');
      assert.equal(projection.record_id, source.unit_id);
      assert.equal(projection.revision_id, source.unit_id);
      assert.equal(projection.scope_kind, 'project');
      assert.equal(projection.scope_id, source.project_id);
      assert.equal(projection.source_seq, source.version);
      assert.equal(projection.tokenizer_version, 'latin-cjk@3');
      assert.equal(projection.projection_generation, source.version);
      assert(db.prepare(`SELECT d.unit_id FROM search_fts JOIN search_documents d ON d.rowid=search_fts.rowid
        WHERE search_fts MATCH ? AND d.unit_id=?`).get('"Atlas"', String(source.unit_id)));
      const job = db.prepare(`SELECT status, generation, content_hash FROM source_projection_jobs WHERE owner_kind='session' AND unit_id=?
        ORDER BY generation DESC LIMIT 1`).get(String(source.unit_id)) as Record<string, unknown> | undefined;
      assert.equal(job?.status, 'done');
      assert.equal(job?.generation, source.version);
      assert.equal(job?.content_hash, sha256(fixture.report.approved));
      const proposals = db.prepare(`SELECT proposal_id, version, expected_change, payload, payload_hash
        FROM evolution_proposals WHERE scope_kind='project' AND scope_id=? AND expected_change IN (?,?) ORDER BY version`)
        .all(sandbox.fixture.projectId, fixture.proposal.first, fixture.proposal.second) as Record<string, unknown>[];
      assert.equal(proposals.length, 2);
      assert.equal(proposals[0]?.version, 1);
      assert.equal(proposals[1]?.version, 2);
      assert.notEqual(proposals[0]?.payload_hash, proposals[1]?.payload_hash);
      for (const proposal of proposals) {
        assert.equal(proposal.payload_hash, sha256(String(proposal.payload)));
        const payload = JSON.parse(String(proposal.payload)) as { proposalId: string; version: number; target: string;
          expectedChange: string; owner: string; scope: { kind: string; id: string }; hash?: string };
        const proposalId = String(proposal.proposal_id), version = Number(proposal.version);
        assert.equal(payload.proposalId, proposalId);
        assert.equal(payload.version, version);
        const proposalProjection = db.prepare(`SELECT rowid, content, content_hash, owner_kind, owner_id, record_id,
          revision_id, project_id, scope_kind, scope_id, source_seq, tokenizer_version, projection_generation
          FROM search_documents WHERE unit_id=?`).get(proposalId) as Record<string, unknown> | undefined;
        assert(proposalProjection, `raw proposal projection missing: ${proposalId}`);
        const indexedProposal = `${payload.target} ${payload.expectedChange}`.toLowerCase();
        assert.equal(proposalProjection.content, indexedProposal);
        assert.equal(proposalProjection.content_hash, proposal.payload_hash);
        assert.equal(proposalProjection.owner_kind, 'proposal');
        assert.equal(proposalProjection.owner_id, proposalId);
        assert.equal(proposalProjection.record_id, proposalId);
        assert.equal(proposalProjection.revision_id, proposalId);
        assert.equal(proposalProjection.project_id, sandbox.fixture.projectId);
        assert.equal(proposalProjection.scope_kind, 'project');
        assert.equal(proposalProjection.scope_id, sandbox.fixture.projectId);
        assert.equal(proposalProjection.source_seq, version);
        assert.equal(proposalProjection.tokenizer_version, 'latin-cjk@3');
        assert.equal(proposalProjection.projection_generation, version);
        assert(db.prepare(`SELECT d.unit_id FROM search_fts JOIN search_documents d ON d.rowid=search_fts.rowid
          WHERE search_fts MATCH ? AND d.unit_id=?`).get('"Atlas"', proposalId));
        const proposalJob = db.prepare(`SELECT status, generation, content_hash FROM source_projection_jobs
          WHERE owner_kind='proposal' AND unit_id=? ORDER BY generation DESC LIMIT 1`).get(proposalId) as Record<string, unknown> | undefined;
        assert.equal(proposalJob?.status, 'done');
        assert.equal(proposalJob?.generation, version);
        assert.equal(proposalJob?.content_hash, proposal.payload_hash);
      }
      assert(crossGrantId && crossQueryId && crossExpandQueryId, 'cross query identity missing');
      const receipts = db.prepare('SELECT query_id FROM source_query_receipts WHERE grant_id=?').all(crossGrantId) as Record<string, unknown>[];
      assert.equal(receipts.length, 2, 'search and expand must create exactly two receipts');
      const queryReceipt = db.prepare('SELECT request_hash, page_hash, result_count, byte_length FROM source_query_receipts WHERE grant_id=? AND query_id=?')
        .get(crossGrantId, crossQueryId) as Record<string, unknown> | undefined;
      const expandReceipt = db.prepare('SELECT request_hash, page_hash, result_count, byte_length FROM source_query_receipts WHERE grant_id=? AND query_id=?')
        .get(crossGrantId, crossExpandQueryId) as Record<string, unknown> | undefined;
      assert(queryReceipt, 'source query receipt missing');
      assert(expandReceipt, 'source expand receipt missing');
      const queryResults = proposals.map(proposal => {
        const payload = JSON.parse(String(proposal.payload)) as { input: { binding: { projectId: string } }; scope: { id: string } };
        const proposalId = String(proposal.proposal_id), version = Number(proposal.version), expectedChange = String(proposal.expected_change);
        const total = Array.from(String(proposal.payload)).length;
        return { unitId: proposalId, locator: `proposal@1/${proposalId}/${version}`, kind: 'proposal', projectId: payload.scope.id,
          sourceProjectId: payload.input.binding.projectId, version, contentHash: String(proposal.payload_hash),
          range: { offset: 0, end: total, total }, status: 'inert', preview: Array.from(expectedChange).slice(0, 128).join('') };
      });
      const queryPage = { status: 'ready', results: queryResults,
        coverage: { allowedProjects: [sandbox.fixture.projectId], inspectedProjects: [sandbox.fixture.projectId], unavailableProjects: [],
          candidateCount: queryResults.length, complete: false, reason: null }, truncated: false, nextCursor: null };
      assert.equal(queryReceipt.request_hash, sha256(JSON.stringify({ sessionId: targetBinding.sessionId, grantId: crossGrantId,
        query: 'Atlas', limit: 10, byteBudget: 8192, cursor: null })));
      assert.equal(queryReceipt.page_hash, sha256(JSON.stringify(queryPage)));
      assert.equal(queryReceipt.result_count, queryResults.length);
      assert.equal(queryReceipt.byte_length, queryResults.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0));
      const firstProposal = proposals[0]!;
      const expansionText = String(firstProposal.payload);
      const expansionResult = { unitId: String(firstProposal.proposal_id), locator: `proposal@1/${firstProposal.proposal_id}/${firstProposal.version}`,
        kind: 'proposal', version: Number(firstProposal.version), contentHash: String(firstProposal.payload_hash), text: expansionText,
        offset: 0, end: Array.from(expansionText).length, total: Array.from(expansionText).length, truncated: false,
        excerptHash: sha256(expansionText) };
      assert.equal(expandReceipt.request_hash, sha256(JSON.stringify({ operation: 'expand', sessionId: targetBinding.sessionId,
        grantId: crossGrantId, unitId: String(firstProposal.proposal_id), offset: 0, limit: 4096 })));
      assert.equal(expandReceipt.page_hash, sha256(JSON.stringify(expansionResult)));
      assert.equal(expandReceipt.result_count, 1);
      assert.equal(expandReceipt.byte_length, Buffer.byteLength(JSON.stringify(expansionResult)));
      const grantUsage = db.prepare(`SELECT used_queries, used_results, used_bytes, max_queries, max_results, max_bytes
        FROM memory_discovery_grants WHERE grant_id=?`).get(crossGrantId) as Record<string, unknown> | undefined;
      assert(grantUsage, 'cross grant missing');
      assert.equal(grantUsage.used_queries, 2);
      assert.equal(grantUsage.used_results, Number(queryReceipt.result_count) + Number(expandReceipt.result_count));
      assert.equal(grantUsage.used_bytes, Number(queryReceipt.byte_length) + Number(expandReceipt.byte_length));
      assert(Number(grantUsage.used_queries) <= Number(grantUsage.max_queries));
      assert(Number(grantUsage.used_results) <= Number(grantUsage.max_results));
      assert(Number(grantUsage.used_bytes) <= Number(grantUsage.max_bytes));
      const assembly = db.prepare(`SELECT state, sources, used_memories FROM request_assemblies WHERE state='finished' LIMIT 1`)
        .get() as Record<string, unknown> | undefined;
      assert(assembly, 'raw finished assembly missing');
      assert.notEqual(String(assembly.sources), '[]');
      assert.notEqual(String(assembly.used_memories), '[]');
      return { status: 'pass', reportEventId: reportEvent.eventId, reportHash: sha256(reportLine),
        sourceUnitId: String(source.unit_id), sourceContentHash: String(source.content_hash),
        sourceApprovalHash: String(source.approval_hash), sourceProjectionGeneration: Number(projection.projection_generation),
        proposalIds: proposals.map(proposal => String(proposal.proposal_id)),
        queryReceipt: { requestHash: String(queryReceipt.request_hash), pageHash: String(queryReceipt.page_hash),
          resultCount: Number(queryReceipt.result_count), byteLength: Number(queryReceipt.byte_length), usedResults: Number(grantUsage?.used_results) },
        expandReceipt: { requestHash: String(expandReceipt.request_hash), pageHash: String(expandReceipt.page_hash),
          resultCount: Number(expandReceipt.result_count), byteLength: Number(expandReceipt.byte_length) },
        grantUsage: { usedQueries: Number(grantUsage.used_queries), usedResults: Number(grantUsage.used_results),
          usedBytes: Number(grantUsage.used_bytes) },
        projections: { sourceFtsHit: true, proposalIds: proposals.map(proposal => String(proposal.proposal_id)) },
        assemblyState: String(assembly.state) };
    } finally { db.close(); }
  } catch (error) {
    return { status: 'fail', error: error instanceof Error ? error.message : String(error) };
  }
})();

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

const runtimeStatus: 'pass' | 'fail' = !scenarioError && focusedPass && rawValidation.status === 'pass'
  && assertions.every(assertion => assertion.passed) ? 'pass' : 'fail';
const evidenceGaps = [
  'Unknown append outcomes and archive-flushed/pending-job restart fault injection remain unverified',
  'Real provider/Host consumers and authenticated owner UI remain unverified',
  'Report/proposal generation and export remain T13/T18 work',
  'Production schema migration and backup/purge remain outside T11',
  'Other OS host results require their matching CI/host artifacts',
];
type EvidenceStatus = 'pass' | 'fail' | 'evidence-gap';
const status: EvidenceStatus = runtimeStatus === 'fail' ? 'fail' : evidenceGaps.length > 0 ? 'evidence-gap' : 'pass';
const exitCode = status === 'fail' ? 1 : 0;
const receiptObservations = JSON.parse(JSON.stringify(observations, (key, value) =>
  ['text', 'content', 'expectedChange'].includes(key) ? undefined : value));
const writeReceiptConsole = (receiptStatus: EvidenceStatus, receiptError: string | null): string => JSON.stringify({
  path: join(directory, 'summary.json'), status: receiptStatus, passed: receiptStatus === 'pass',
  evidenceGap: receiptStatus === 'evidence-gap', fixtureDigest, scenarioError, receiptError,
}) + '\n';
writeFileSync(join(directory, 'fixture.json'), bytes, { flag: 'wx' });
writeFileSync(join(directory, 'owner-observations.json'), JSON.stringify(observations, null, 2) + '\n', { flag: 'wx' });
writeFileSync(join(directory, 'focused-test.txt'), focusedRaw, { flag: 'wx' });
writeFileSync(join(directory, 'focused-stderr.txt'), focusedStderr, { flag: 'wx' });
let consoleOutput = writeReceiptConsole(status, null);
writeFileSync(join(directory, 'console-output.txt'), consoleOutput, { flag: 'wx' });
writeFileSync(join(directory, 'main-stderr.txt'), mainStderr.join(''), { flag: 'wx' });
const finishedAt = new Date().toISOString();
const implementationCommit = execFileSync('git', ['--no-optional-locks', 'rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const implementationTree = execFileSync('git', ['--no-optional-locks', 'rev-parse', 'HEAD^{tree}'], { cwd: repo, encoding: 'utf8' }).trim();
const workingTree = execFileSync('git', ['--no-optional-locks', 'status', '--short'], { cwd: repo, encoding: 'utf8' }).trim();
const artifactFiles = listFiles(directory).filter(path => path !== 'summary.json');
const files = artifactFiles.map(path => ({ path, sha256: sha256(readFileSync(join(directory, path))) }));
const focusedProcess: ProcessReceipt = { command: process.execPath, args: focusedArgs, cwd: repo, startedAt: focusedStartedAt,
  finishedAt: focusedFinishedAt, code: focusedCode, signal: focusedSignal,
  stdout: { path: 'focused-test.txt', sha256: files.find(file => file.path === 'focused-test.txt')!.sha256 },
  stderr: { path: 'focused-stderr.txt', sha256: files.find(file => file.path === 'focused-stderr.txt')!.sha256 } };
const mainProcess: ProcessReceipt = { command: process.execPath, args: [...process.execArgv, ...process.argv.slice(1)], cwd: repo,
  startedAt, finishedAt, code: exitCode, signal: null,
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
    'docs/architecture/issues/15-euler-v1-spec.md:177-179 (I08 Context admission 与有界恢复)'],
  command: { executable: process.execPath, args: [...process.execArgv, ...process.argv.slice(1)], cwd: repo },
  startedAt, finishedAt, implementationCommit, implementationTree, workingTree,
  environment: { platform: process.platform, release: release(), architecture: arch(), node: process.version,
    sqlite: environment && typeof environment === 'object' && 'sqlite' in environment ? (environment as { sqlite: unknown }).sqlite : 'unknown',
    provider: 'none: no provider requests', model: 'none', adapter: 'euler-cli-carrier@1', runner: process.env.CI ? 'CI' : 'local' },
  fixture: { path: 'fixtures/t11-source-cases.json', rawDigest: fixtureDigest, digest: fixtureDigest, synthetic: true, heldOut: false },
  heldOut: { digest: null, owner: null, sealedCommit: null, releasedCommit: null, contaminationCaseIds: [], replacementCaseIds: [],
    applicability: 'not-applicable: deterministic synthetic fixture; no held-out quality claim' },
  processes, assertions: [...assertions, { name: 'independent raw archive/SQLite/receipt validation passes', passed: rawValidation.status === 'pass',
    error: rawValidation.status === 'fail' ? rawValidation.error : undefined }], files, controlledSideEffects,
  artifactDigests: { stdout: mainProcess.stdout, stderr: mainProcess.stderr,
    database: databaseArtifacts, sidecars: sidecarArtifacts },
  independentValidation: { method: 'raw fixture/archive/SQLite recomputation and node:crypto; no Core replay or reported verdict',
    verifier: { path: 'scripts/evidence-source-recovery.ts', sha256: sha256(readFileSync(new URL('./evidence-source-recovery.ts', import.meta.url))) }, status: rawValidation.status },
  rawValidation, observations: receiptObservations, scenarioError, focusedPass, status,
  exit: { code: exitCode, signal: null as string | null }, evidenceGaps, receiptError: null as string | null,
};
function validateReceipt(receipt: typeof output) {
  for (const key of ['schema','schemaVersion','experimentId','specCommit','authorityRefs','command','startedAt','finishedAt',
    'implementationCommit','implementationTree','workingTree','environment','fixture','heldOut','processes','assertions','files',
    'controlledSideEffects','artifactDigests','independentValidation','status','exit','evidenceGaps'] as const) assert.ok(Object.hasOwn(receipt, key), `missing ${key}`);
  assert.ok(receipt.authorityRefs.length > 0);
  assert.ok(['pass', 'fail', 'evidence-gap'].includes(receipt.status));
  if (receipt.status === 'pass') assert.equal(receipt.evidenceGaps.length, 0);
  if (receipt.status === 'evidence-gap') assert(receipt.evidenceGaps.length > 0);
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
  assert.equal(receipt.exit.code, receipt.status === 'fail' ? 1 : 0);
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
if (receiptError) {
  output.receiptError = receiptError;
  output.status = 'fail';
  output.exit.code = 1;
  output.independentValidation.status = 'fail';
  mainProcess.code = 1;
  consoleOutput = writeReceiptConsole('fail', receiptError);
  writeFileSync(join(directory, 'console-output.txt'), consoleOutput);
  const stdoutFile = output.files.find(file => file.path === 'console-output.txt');
  assert(stdoutFile);
  stdoutFile.sha256 = sha256(consoleOutput);
  mainProcess.stdout.sha256 = stdoutFile.sha256;
}
writeFileSync(join(directory, 'summary.json'), JSON.stringify(output, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(consoleOutput);
if (output.status === 'fail') process.exitCode = 1;
