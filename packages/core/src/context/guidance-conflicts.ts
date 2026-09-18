import { check, sha256 } from '../contracts.ts';
import type { SourceAck } from '../contracts.ts';
import type { GuidanceBlock, InstructionSnapshot } from './guidance-session.ts';

export interface GuidanceOperation { name: 'synthetic.read' | 'synthetic.write'; targets: string[] }
export interface RecognizedConstraint {
  locator: string; hash: string; quote: string; operation: GuidanceOperation['name']; target: string; key: string; value: string;
}
export interface OwnerDirective { source: SourceAck; quote: string; operation: GuidanceOperation['name']; target: string; key: string; value: string }
export interface GuidanceResolution { conflictId: string; value: string; source: SourceAck }
export interface GuidanceConflict {
  id: string; kind: 'instruction-conflict' | 'skill-conflict'; operation: GuidanceOperation; target: string; key: string;
  evidence: (RecognizedConstraint & { ownerId: string; scope: GuidanceBlock['scope']; version: string; kind: GuidanceBlock['kind'] })[];
}
export interface GuidanceExecution {
  executionState: 'not_started' | 'started'; outcome: 'success' | 'unavailable' | 'unknown';
  status: 'completed' | 'unavailable' | GuidanceConflict['kind']; reason: string | null; conflicts: GuidanceConflict[];
}
export interface SyntheticPermissions { policy: boolean; capability: boolean; credential: boolean; approval: boolean }

// Retire obsolete evidence only when the same rule has a replacement verified
// against the currently loaded bytes. Valid same-version rules remain additive.
export function revalidateConstraints(constraints: RecognizedConstraint[], guidance: GuidanceBlock[]): RecognizedConstraint[] {
  const verified = new Set(constraints.filter(c => guidance.some(g => g.locator === c.locator && g.targets.includes(c.target)
    && g.hash === c.hash && c.quote.length > 0 && g.text.includes(c.quote))));
  return constraints.filter(c => verified.has(c) || ![...verified].some(next => next.locator === c.locator
    && next.target === c.target && next.operation === c.operation && next.key === c.key));
}

// These are explicitly identified constraints, not a natural-language parser.
// A recognizer cannot grant permissions or manufacture an owner resolution.
export function guidanceConflicts(snapshot: InstructionSnapshot, operation: GuidanceOperation): GuidanceConflict[] {
  check(['synthetic.read', 'synthetic.write'].includes(operation.name) && operation.targets.length > 0
    && new Set(operation.targets).size === operation.targets.length, 'guidance-operation-invalid');
  const selected: { constraint: RecognizedConstraint; block: GuidanceBlock }[] = [];
  for (const constraint of snapshot.constraints) {
    if (constraint.operation !== operation.name || !operation.targets.includes(constraint.target)) continue;
    if (snapshot.directives.some(d => d.operation === operation.name && d.target === constraint.target && d.key === constraint.key)) continue;
    const block = snapshot.guidance.find(g => g.locator === constraint.locator && g.targets.includes(constraint.target));
    if (!block) continue;
    check(block.hash === constraint.hash && constraint.quote.length > 0 && block.text.includes(constraint.quote), 'guidance-constraint-stale');
    selected.push({ constraint, block });
  }
  // Resolve ordinary AGENTS rules per resource, retaining unrelated wide rules.
  const effective = selected.filter(item => {
    return item.block.kind !== 'agents' || !selected.some(other => other.block.kind === 'agents'
      && other.constraint.target === item.constraint.target && other.constraint.key === item.constraint.key && other.block.depth > item.block.depth);
  });
  const conflicts: GuidanceConflict[] = [];
  for (const target of operation.targets) {
    const targetRules = effective.filter(e => e.constraint.target === target);
    const targetDirectives = snapshot.directives.filter(d => d.operation === operation.name && d.target === target);
    for (const key of [...new Set([...targetRules.map(e => e.constraint.key), ...targetDirectives.map(d => d.key)])].sort()) {
      const rules = targetRules.filter(e => e.constraint.key === key);
      const directives = targetDirectives.filter(d => d.key === key);
      const values = new Set([...rules.map(e => e.constraint.value), ...directives.map(d => d.value)]);
      if (values.size <= 1) continue;
      const evidence = rules.map(({ constraint, block }) => ({ ...constraint, ownerId: block.ownerId, scope: block.scope, version: block.version, kind: block.kind }));
      const kind = rules.length > 1 && rules.every(e => e.block.kind !== 'agents') && directives.length === 0 ? 'skill-conflict' : 'instruction-conflict';
      const id = sha256(JSON.stringify({ operation, target, key, evidence, directives }));
      if (!snapshot.resolutions.some(r => r.conflictId === id && values.has(r.value))) conflicts.push({ id, kind, operation, target, key, evidence });
    }
  }
  return conflicts;
}
