import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

function fixture() {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  return { sandbox, probe, add(content: string, claimKey?: string) {
    const source = probe.archive.append(randomUUID(), content);
    const candidate = probe.store.captureMemory(probe.activity, source, content, {
      type: 'fact', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: [],
      ...(claimKey ? { claimKey } : {}),
    }).record;
    const verified = probe.store.verifyMemory(probe.activity, candidate.recordId, candidate, 'pass', [source]).record;
    return probe.store.activateMemory(probe.activity, verified.recordId, verified).record;
  }, close() { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); } };
}

test('memory search ranks eligible lexical candidates by actual BM25 frequency and length', () => {
  const f = fixture();
  try {
    const long = f.add('Alpha padding padding padding padding padding');
    const short = f.add('Alpha Alpha Alpha');
    f.probe.store.drainSearchProjection(f.probe.activity);
    const page = f.probe.store.searchMemories(f.probe.activity, { query: 'alpha' });
    assert.equal(page.status, 'ready');
    assert.deepEqual(page.results.map(hit => hit.unitId), [short.recordId, long.recordId]);
    // Two documents, lengths 3/6, avgdl 4.5, IDF floor 1e-6, k1=1.2, b=.75.
    assert.ok(Math.abs(page.results[0]!.rank! - -0.0000016923076923076922) < 1e-15);
    assert.ok(Math.abs(page.results[1]!.rank! - -0.00000088) < 1e-15);
  } finally { f.close(); }
});

test('claim deduplication keeps the best eligible ranked record rather than the first inserted one', () => {
  const f = fixture();
  try {
    const earlier = f.add('Alpha padding padding padding padding padding', 'alpha-route');
    const best = f.add('Alpha Alpha Alpha', 'alpha-route');
    f.probe.store.drainSearchProjection(f.probe.activity);
    const page = f.probe.store.searchMemories(f.probe.activity, { query: 'alpha' });
    assert.deepEqual(page.results.map(hit => hit.unitId), [best.recordId]);
    assert.equal(page.coverage.candidateCount, 1);
    assert.equal(page.retrieval!.candidates.find(candidate => candidate.recordId === earlier.recordId)!.decision, 'duplicate');
  } finally { f.close(); }
});

test('memory search fuses distinct lexical lanes with reciprocal ranks and deterministic ties', () => {
  const f = fixture();
  try {
    const beta = f.add('beta beta');
    const alpha = f.add('alpha alpha');
    const both = f.add('alpha beta');
    f.probe.store.drainSearchProjection(f.probe.activity);
    const page = f.probe.store.searchMemories(f.probe.activity, { query: 'alpha beta' });
    assert.deepEqual(page.results.map(hit => hit.unitId), [both.recordId, alpha.recordId, beta.recordId]);
    // Both is second in two lanes; alpha and beta each lead one lane, with query order breaking the tie.
    assert.ok(Math.abs(page.results[0]!.rank! - -0.03225806451612903) < 1e-15);
    assert.ok(Math.abs(page.results[1]!.rank! - -0.01639344262295082) < 1e-15);
    assert.equal(page.results[1]!.rank, page.results[2]!.rank);
    assert.ok(Math.abs(page.retrieval!.candidates.find(candidate => candidate.recordId === both.recordId)!.score!
      - 0.03225806451612903) < 1e-15);
    const repeated = f.probe.store.searchMemories(f.probe.activity, { query: 'alpha alpha beta' });
    assert.deepEqual(repeated.results.map(hit => [hit.unitId, hit.rank]), page.results.map(hit => [hit.unitId, hit.rank]));
  } finally { f.close(); }
});

test('conflict markers remain pageable without changing eligible fact scores', () => {
  const f = fixture();
  try {
    f.add('alpha padding padding');
    f.add('alpha alpha');
    f.probe.store.drainSearchProjection(f.probe.activity);
    const before = f.probe.store.searchMemories(f.probe.activity, { query: 'alpha' });
    const left = f.add('alpha closed ' + 'padding '.repeat(80));
    const right = f.add('alpha open ' + 'padding '.repeat(80));
    f.probe.store.conflictMemory(f.probe.activity, left.recordId, left, right.recordId, right);
    f.probe.store.drainSearchProjection(f.probe.activity);
    const after = f.probe.store.searchMemories(f.probe.activity, { query: 'alpha' });
    assert.deepEqual(after.results.filter(hit => hit.kind === 'memory').map(hit => [hit.unitId, hit.rank]),
      before.results.map(hit => [hit.unitId, hit.rank]));
    assert.equal(after.results.at(-1)!.kind, 'status');
    assert.equal(after.results.at(-1)!.rank, null);
    assert.equal(after.retrieval!.corpus.count, before.retrieval!.corpus.count);
    assert.equal(after.retrieval!.corpus.hash, before.retrieval!.corpus.hash);
    assert.equal(JSON.stringify(after.results.at(-1)).includes('padding'), false);
    const first = f.probe.store.searchMemories(f.probe.activity, { query: 'alpha', limit: 2 });
    assert.ok(first.nextCursor);
    const last = f.probe.store.searchMemories(f.probe.activity, { query: 'alpha', limit: 2, cursor: first.nextCursor });
    assert.equal(last.results.length, 1); assert.equal(last.results[0]!.kind, 'status');
  } finally { f.close(); }
});

test('a cursor cannot outlive a changed scoring corpus even when its deduplicated record list stays the same', () => {
  const f = fixture();
  try {
    f.add('Alpha padding padding padding padding padding', 'first-route');
    f.add('Alpha Alpha Alpha', 'second-route');
    f.probe.store.drainSearchProjection(f.probe.activity);
    const first = f.probe.store.searchMemories(f.probe.activity, { query: 'alpha', limit: 1 });
    assert.ok(first.nextCursor);
    const legacy = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString('utf8'));
    legacy.schema = 'memory-search-cursor@1';
    assert.throws(() => f.probe.store.searchMemories(f.probe.activity, { query: 'alpha', limit: 1,
      cursor: Buffer.from(JSON.stringify(legacy)).toString('base64url') }), /invalid-search-cursor/);
    f.add('Alpha ' + 'padding '.repeat(30), 'second-route');
    f.probe.store.drainSearchProjection(f.probe.activity);
    assert.throws(() => f.probe.store.searchMemories(f.probe.activity, { query: 'alpha', limit: 1, cursor: first.nextCursor! }), /invalid-search-cursor/);
  } finally { f.close(); }
});

test('an unsupported single-Han query can be reformulated or expanded from an already known authorized record', () => {
  const f = fixture();
  try {
    const record = f.add('松林步道周三开放');
    f.probe.store.drainSearchProjection(f.probe.activity);
    const unsupported = f.probe.store.searchMemories(f.probe.activity, { query: '松' });
    assert.equal(unsupported.coverage.reason, 'unsupported-query'); assert.equal(unsupported.results.length, 0);
    const supported = f.probe.store.searchMemories(f.probe.activity, { query: '松林' });
    assert.deepEqual(supported.results.map(hit => hit.unitId), [record.recordId]);
    const source = f.probe.store.expandSource(f.probe.activity, { recordId: record.recordId, offset: 0, limit: 32 });
    assert.equal(source.text, record.content); assert.equal(source.truncated, false);
  } finally { f.close(); }
});

test('deduplicating ranking lanes preserves repeated query groups at numeric adjacency boundaries', () => {
  const f = fixture();
  try {
    const exact = f.add('RFC implementation RFC 42');
    f.add('RFC implementation 42');
    f.probe.store.drainSearchProjection(f.probe.activity);
    const page = f.probe.store.searchMemories(f.probe.activity, { query: 'RFC implementation RFC 42' });
    assert.deepEqual(page.results.map(hit => hit.unitId), [exact.recordId]);
  } finally { f.close(); }
});

test('search traces identify actual candidate decisions and honest per-result measurement', () => {
  const f = fixture();
  try {
    const large = f.add('Alpha ' + 'padding '.repeat(500));
    const small = f.add('Alpha path');
    f.probe.store.drainSearchProjection(f.probe.activity);
    const page = f.probe.store.searchMemories(f.probe.activity, { query: 'alpha', byteBudget: 1800 });
    assert.equal(page.retrieval?.schema, 'memory-retrieval@1');
    const trace = page.retrieval!;
    assert.equal(trace.corpus.kind, 'eligible-lexical-candidates'); assert.equal(trace.corpus.count, 2);
    assert.equal(trace.queryTokenizer, 'latin-cjk-query@1'); assert.equal(trace.indexTokenizer, 'unicode61+latin-cjk@3');
    assert.match(trace.sqliteVersion, /^3\./);
    assert.equal(trace.candidates.find(item => item.recordId === large.recordId)!.decision, 'candidate-over-byte-budget');
    const returned = trace.candidates.find(item => item.recordId === small.recordId)!;
    assert.equal(returned.corpusOrdinal, 1);
    assert.equal(returned.decision, 'returned'); assert.equal(returned.returnedOrdinal, 0);
    assert.equal(returned.measurement.byteLength, Buffer.byteLength(JSON.stringify(page.results[0])));
    assert.equal(returned.measurement.budgetUnits, returned.measurement.byteLength);
    assert.equal(returned.measurement.basis, 'utf8-json-search-result@1');
    assert.equal(returned.measurement.tokens, 'unsupported'); assert.equal(returned.measurement.modelTokenizer, 'unavailable');
    assert.equal(returned.measurement.cost, 'unknown'); assert.equal(returned.measurement.currency, 'unknown');
    assert.equal(returned.lanes[0]!.rank, 1); assert.ok(returned.lanes[0]!.bm25 < 0);
  } finally { f.close(); }
});
