import { DatabaseSync } from 'node:sqlite';
import { check, sha256 } from '../contracts.ts';

export interface MemoryRank { score: number; ordinal: number; lanes: { ordinal: number; bm25: number; rank: number }[] }
export const MEMORY_QUERY_TOKENIZER = 'latin-cjk-query@1';
export const MEMORY_INDEX_TOKENIZER = 'unicode61+latin-cjk@3';
export const MEMORY_RANKING_VERSION = 'eligible-fts5-bm25-rrf@1';
export const SINGLE_HAN_QUERY_TOKENIZER = 'single-han-literal@1';
export const SINGLE_HAN_RANKING_VERSION = 'eligible-literal-order@1';
export interface RetrievalMeasurement {
  basis: 'utf8-json-search-result@1'; byteLength: number; budgetUnits: number;
  budgetEstimator: 'utf8-bytes-upper-bound@1'; modelTokenizer: 'unavailable';
  tokens: 'unsupported'; cost: 'unknown'; currency: 'unknown';
}
export interface MemorySearchTrace {
  schema: 'memory-retrieval@1'; queryHash: string; queryTokenizer: typeof MEMORY_QUERY_TOKENIZER | typeof SINGLE_HAN_QUERY_TOKENIZER;
  indexTokenizer: typeof MEMORY_INDEX_TOKENIZER; sqliteVersion: string;
  rankingVersion: typeof MEMORY_RANKING_VERSION | typeof SINGLE_HAN_RANKING_VERSION;
  bm25: { k1: 1.2; b: 0.75 } | null; fusion: { method: 'rrf'; k: 60 } | null;
  corpus: { kind: 'eligible-lexical-candidates'; count: number; hash: string };
  lanes: { ordinal: number; queryHash: string; termHashes: string[] }[];
  candidates: {
    recordId: string; revisionId: string; headEventId: string; hash: string; contentHash: string;
    targetProjectId: string; kind: 'memory' | 'status'; ordinal: number; corpusOrdinal: number | null; resultHash: string;
    scoreKind: 'bm25' | 'rrf' | 'literal-order' | 'not-applicable'; score: number | null; lanes: MemoryRank['lanes'];
    decision: 'returned' | 'duplicate' | 'previous-page' | 'candidate-over-byte-budget' | 'page-result-limit' | 'page-byte-budget';
    returnedOrdinal: number | null; measurement: RetrievalMeasurement;
  }[];
}
export interface MemoryRetrievalReceipt {
  schema: 'memory-retrieval-tool@1'; resultHash: string; trace: MemorySearchTrace; returned: number[];
}
export interface MemoryDelivery {
  schema: 'memory-delivery@1'; callId: string; queryHash: string; resultHash: string;
  returned: Pick<MemorySearchTrace['candidates'][number], 'recordId' | 'revisionId' | 'headEventId' | 'hash' | 'contentHash'
    | 'targetProjectId' | 'kind' | 'resultHash' | 'measurement' | 'returnedOrdinal'>[];
}

export function memoryDelivery(callId: string, receipt: MemoryRetrievalReceipt): MemoryDelivery {
  return { schema: 'memory-delivery@1', callId, queryHash: receipt.trace.queryHash, resultHash: receipt.resultHash,
    returned: receipt.returned.map(ordinal => {
      const { recordId, revisionId, headEventId, hash, contentHash, targetProjectId, kind, resultHash, measurement, returnedOrdinal } = receipt.trace.candidates[ordinal]!;
      return { recordId, revisionId, headEventId, hash, contentHash, targetProjectId, kind, resultHash, measurement, returnedOrdinal };
    }) };
}

export function assertMemoryRetrievalReceipt(receipt: MemoryRetrievalReceipt, modelResult: string, query: string, success: boolean): void {
  check(receipt.schema === 'memory-retrieval-tool@1' && receipt.resultHash === sha256(modelResult)
    && receipt.trace.schema === 'memory-retrieval@1' && receipt.trace.queryHash === sha256(query)
    && Array.isArray(receipt.trace.candidates) && receipt.trace.candidates.length <= 256
    && receipt.trace.candidates.every((candidate, ordinal) => candidate.ordinal === ordinal)
    && Array.isArray(receipt.returned) && receipt.returned.length <= 32, 'retrieval-receipt-mismatch');
  if (!success) { check(receipt.returned.length === 0, 'retrieval-receipt-mismatch'); return; }
  const page = JSON.parse(modelResult) as { results: unknown[] };
  check(Array.isArray(page.results) && page.results.length === receipt.returned.length, 'retrieval-receipt-mismatch');
  for (const [ordinal, result] of page.results.entries()) {
    const candidate = receipt.trace.candidates[receipt.returned[ordinal]!];
    check(candidate && candidate.decision === 'returned' && candidate.returnedOrdinal === ordinal
      && candidate.resultHash === retrievalResultHash(result)
      && JSON.stringify(candidate.measurement) === JSON.stringify(measureRetrievalResult(result)), 'retrieval-receipt-mismatch');
    const hit = result as { kind: string; unitId: string; targetProjectId: string; record?: {
      recordId: string; revisionId: string; headEventId: string; hash: string; contentHash: string } };
    check(hit.kind === candidate.kind && hit.unitId === candidate.recordId && hit.targetProjectId === candidate.targetProjectId,
      'retrieval-receipt-mismatch');
    if (hit.kind === 'memory') check(hit.record && ['recordId','revisionId','headEventId','hash','contentHash']
      .every(key => hit.record![key as keyof typeof hit.record] === candidate[key as keyof typeof candidate]), 'retrieval-receipt-mismatch');
  }
}

export function measureRetrievalResult(result: unknown): RetrievalMeasurement {
  const byteLength = Buffer.byteLength(JSON.stringify(result));
  return { basis: 'utf8-json-search-result@1', byteLength, budgetUnits: byteLength,
    budgetEstimator: 'utf8-bytes-upper-bound@1', modelTokenizer: 'unavailable', tokens: 'unsupported', cost: 'unknown', currency: 'unknown' };
}

export function retrievalResultHash(result: unknown): string { return sha256(JSON.stringify(result)); }

/** Query-local FTS statistics contain only the already qualified lexical candidates. */
export function rankMemoryCandidates(documents: { recordId: string; text: string }[],
  lanes: { match: string; recordIds: string[] }[]): { ranks: Map<string, MemoryRank>; sqliteVersion: string; fusion: boolean } {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE VIRTUAL TABLE eligible_memory USING fts5(content, tokenize='unicode61')");
    const insert = db.prepare('INSERT INTO eligible_memory(rowid,content) VALUES (?,?)');
    for (const [ordinal, document] of documents.entries()) insert.run(ordinal + 1, document.text);
    const query = db.prepare('SELECT rowid, bm25(eligible_memory) AS score FROM eligible_memory WHERE eligible_memory MATCH ?');
    const ranks = new Map<string, MemoryRank>();
    let activeLanes = 0;
    for (const [ordinal, lane] of lanes.entries()) {
      const allowed = new Set(lane.recordIds);
      const matches = query.all(lane.match).map(row => ({ recordId: documents[Number(row.rowid) - 1]!.recordId,
        score: Number(row.score), ordinal: Number(row.rowid) - 1 })).filter(row => allowed.has(row.recordId))
        .sort((a, b) => a.score - b.score || a.ordinal - b.ordinal);
      if (matches.length) activeLanes++;
      for (const [index, row] of matches.entries()) {
        const rank = ranks.get(row.recordId) ?? { score: 0, ordinal: row.ordinal, lanes: [] };
        rank.lanes.push({ ordinal, bm25: row.score, rank: index + 1 });
        ranks.set(row.recordId, rank);
      }
    }
    for (const rank of ranks.values()) rank.score = activeLanes > 1
      ? -rank.lanes.reduce((sum, lane) => sum + 1 / (60 + lane.rank), 0) : rank.lanes[0]!.bm25;
    const ordered = [...ranks].sort(([, a], [, b]) => a.score - b.score
      || Math.min(...a.lanes.map(lane => lane.rank)) - Math.min(...b.lanes.map(lane => lane.rank))
      || a.lanes[0]!.ordinal - b.lanes[0]!.ordinal || a.ordinal - b.ordinal);
    return { ranks: new Map(ordered.map(([recordId, rank], ordinal) => [recordId, { ...rank, ordinal }])),
      sqliteVersion: String(db.prepare('SELECT sqlite_version() AS version').get()!.version), fusion: activeLanes > 1 };
  } finally { db.close(); }
}
