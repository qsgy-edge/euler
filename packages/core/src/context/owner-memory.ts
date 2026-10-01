import { check } from '../contracts.ts';
import type { SourceAck } from '../contracts.ts';

// Fast-lane grammar (Ticket 08 §12, I06). Only explicit, typed owner wording is
// actionable; semantic classification of free text belongs to the normal lane.
export type OwnerMemoryType = 'preference' | 'decision' | 'fact';
export interface OwnerMemoryStatement { type: OwnerMemoryType; content: string }
export interface OwnerAgreement { schema: 'owner-agreement@1'; text: string; proposal: SourceAck }

const TYPES: Record<string, OwnerMemoryType> = { 偏好: 'preference', 决定: 'decision', 事实: 'fact' };
/** The accepted explicit owner forms, for Host hints; the parsers below are the authority. */
export const OWNER_MEMORY_FORMS = ['记住偏好：…', '记住决定：…', '记住事实：…'] as const;
const STATEMENT = /^记住(偏好|决定|事实)[：:]\s*(\S[^\n]*)$/u;
const PROPOSAL = /^建议记住(偏好|决定|事实)[：:]\s*(\S[^\n]*)$/u;
const AGREE = new Set(['同意', 'agree']);
const DECLINE = new Set(['取消', 'cancel']);

function statement(match: RegExpExecArray | null): OwnerMemoryStatement | null {
  if (!match) return null;
  const content = match[2]!.trim();
  return content ? { type: TYPES[match[1]!]!, content } : null;
}

/** The whole owner event is one typed statement; the content is its verbatim remainder. */
export function parseOwnerStatement(text: string): OwnerMemoryStatement | null {
  return statement(STATEMENT.exec(text.trim()));
}

/** An assistant proposal is actionable only when exactly one line carries the marker. */
export function parseMemoryProposal(text: string): OwnerMemoryStatement | null {
  const matches = text.split(/\r?\n/u).map(line => statement(PROPOSAL.exec(line.trim()))).filter(item => item !== null);
  return matches.length === 1 ? matches[0]! : null;
}

export function isOwnerAgreement(text: string): boolean { return AGREE.has(text.trim()); }
export function isOwnerDecline(text: string): boolean { return DECLINE.has(text.trim()); }
/** Untyped `记住：…` is archived but needs an explicit type before the fast lane can act. */
export function isUntypedRemember(text: string): boolean { return /^记住[：:]/u.test(text.trim()); }

export function encodeOwnerAgreement(text: string, proposal: SourceAck): string {
  check(isOwnerAgreement(text), 'memory-agreement-not-explicit');
  return JSON.stringify({ schema: 'owner-agreement@1', text: text.trim(), proposal });
}

/** Returns null for ordinary text; a malformed agreement envelope is an evidence gap, not free text. */
export function parseOwnerAgreement(text: string): OwnerAgreement | null {
  if (!text.startsWith('{"schema":"owner-agreement@1"')) return null;
  let value: OwnerAgreement;
  try { value = JSON.parse(text) as OwnerAgreement; } catch { throw new Error('memory-agreement-evidence-gap'); }
  check(value && Object.keys(value).sort().join(',') === 'proposal,schema,text' && isOwnerAgreement(value.text)
    && value.proposal && typeof value.proposal === 'object'
    && text === JSON.stringify({ schema: value.schema, text: value.text, proposal: value.proposal }), 'memory-agreement-evidence-gap');
  return value;
}
