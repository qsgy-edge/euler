import { check } from '../contracts.ts';
import type { SourceAck } from '../contracts.ts';

export interface HistorianBounds { minBytes: number; maxBytes: number }
export type HistorianReply = { result: 'pass'; summary: string } | { result: 'block' | 'evidence-gap'; reason: string };
export interface HistorianSource { ref: SourceAck; role?: 'user' | 'assistant' | 'tool'; text: string }
export interface CompartmentBody {
  schema: 'compartment@1'; summary: string;
  decisions: { eventId: string; text: string; precedingResponse: string | null }[];
  results: { eventId: string; text: string }[];
  citations: SourceAck[];
  applicability: { ownerId: string; projectId: string; sessionId: string; runId: string };
}
export interface Compartment {
  jobId: string; runId: string; firstResponse: number; endResponse: number;
  rawHash: string; attemptId: string; source: SourceAck; body: CompartmentBody;
}

export function isCompartmentEvidenceGap(error: unknown): boolean {
  return error instanceof Error && /^(source-|archive-|compartment-|historian-|capture-evidence-gap)/.test(error.message);
}

export function assertHistorianReply(value: unknown): asserts value is HistorianReply {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'invalid-historian-output');
  const reply = value as HistorianReply;
  if (reply.result === 'pass') {
    check(Object.keys(reply).sort().join(',') === 'result,summary' && typeof reply.summary === 'string'
      && reply.summary.trim().length > 0 && Buffer.byteLength(reply.summary) <= 8192, 'invalid-historian-output');
  } else {
    check(['block','evidence-gap'].includes(reply.result) && Object.keys(reply).sort().join(',') === 'reason,result'
      && typeof reply.reason === 'string' && /^[a-z0-9-]{1,128}$/.test(reply.reason), 'invalid-historian-output');
  }
}

/** Exact mandatory material is copied from raw events; a model cannot rewrite these anchors. */
export function compartmentBody(raw: HistorianSource[], runId: string, summary: string): CompartmentBody {
  check(raw.length > 0, 'historian-source-gap');
  const decisions: CompartmentBody['decisions'] = [], results: CompartmentBody['results'] = [];
  let precedingResponse: string | null = null;
  for (const item of raw) {
    if (item.role === 'user') decisions.push({ eventId: item.ref.eventId, text: item.text, precedingResponse });
    else if (item.role === 'tool') results.push({ eventId: item.ref.eventId, text: item.text });
    else if (item.role === 'assistant') {
      precedingResponse = item.text;
      const response = JSON.parse(item.text) as { stop: string };
      if (response.stop !== 'tools') results.push({ eventId: item.ref.eventId, text: item.text });
    }
  }
  const { ownerId, projectId, sessionId } = raw[0]!.ref.binding;
  return { schema: 'compartment@1', summary, decisions, results, citations: raw.map(item => item.ref),
    applicability: { ownerId, projectId, sessionId, runId } };
}
