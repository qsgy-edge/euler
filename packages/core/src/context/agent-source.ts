import { check, sha256 } from '../contracts.ts';
import type { SourceAck } from '../contracts.ts';

/** Literal, bounded recovery over the Host's already bound session archive. */
export function searchSessionSources(refs: SourceAck[], read: (ref: SourceAck) => { text: string; role?: string },
  query: string, byteBudget: number, cursor?: string, validate?: (ref: SourceAck) => void) {
  check(typeof query === 'string' && query.trim().length > 0 && Buffer.byteLength(query) <= 512, 'invalid-source-query');
  let offset = 0;
  let end = refs.length;
  if (cursor !== undefined) {
    check(typeof cursor === 'string' && cursor.length <= 2048, 'invalid-source-cursor');
    let parsed: { queryHash: string; through: string; offset: number; hash: string };
    try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as typeof parsed; }
    catch { throw new Error('invalid-source-cursor'); }
    end = refs.findIndex(ref => ref.eventId === parsed.through) + 1;
    check(end > 0 && parsed.queryHash === sha256(query) && Number.isSafeInteger(parsed.offset)
      && parsed.offset >= 0 && parsed.offset <= end
      && parsed.hash === sha256(JSON.stringify(refs.slice(0, end))), 'source-cursor-stale');
    offset = parsed.offset;
  }
  const range = refs.slice(0, end);
  const terms = query.normalize('NFC').toLocaleLowerCase().trim().split(/\s+/u);
  const results: { eventId: string; ref: SourceAck; role: string | null; preview: string; offset: number; end: number }[] = [];
  let next = offset, unauthorized = 0;
  for (; next < range.length; next++) {
    const ref = range[next]!;
    try { validate?.(ref); }
    catch (error) {
      if (!(error instanceof Error) || !['discovery-not-authorized', 'analysis-task-not-active'].includes(error.message)) throw error;
      unauthorized++; continue;
    }
    const source = read(ref);
    if (!terms.some(term => source.text.normalize('NFC').toLocaleLowerCase().includes(term))) continue;
    const points = Array.from(source.text);
    const hit = { eventId: ref.eventId, ref, role: source.role ?? null, preview: points.slice(0, 160).join(''), offset: 0, end: points.length };
    if (results.length === 8 || Buffer.byteLength(JSON.stringify([...results, hit])) > byteBudget) break;
    results.push(hit);
  }
  return { status: 'ready' as const, results, coverage: { sessionId: range[0]?.binding.sessionId ?? null, rawEvents: end, inspected: next, unauthorized },
    truncated: next < end, nextCursor: next < end ? Buffer.from(JSON.stringify({ queryHash: sha256(query),
      through: range.at(-1)!.eventId, offset: next, hash: sha256(JSON.stringify(range)) })).toString('base64url') : null };
}
