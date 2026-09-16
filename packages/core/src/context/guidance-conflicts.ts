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
  id: string; kind: 'instruction-conflict' | 'skill-conflict'; operation: GuidanceOperation; key: string;
  evidence: (RecognizedConstraint & { ownerId: string; scope: GuidanceBlock['scope']; version: string; kind: GuidanceBlock['kind'] })[];
}
export interface GuidanceExecution {
  executionState: 'not_started' | 'started'; outcome: 'success' | 'unavailable' | 'unknown';
  status: 'completed' | 'unavailable' | GuidanceConflict['kind']; reason: string | null; conflicts: GuidanceConflict[];
}
export interface SyntheticPermissions { policy: boolean; capability: boolean; credential: boolean; approval: boolean }

// These are explicitly identified constraints, not a natural-language parser.
// A recognizer cannot grant permissions or manufacture an owner resolution.
export function guidanceConflicts(snapshot: InstructionSnapshot, operation: GuidanceOperation): GuidanceConflict[] {
  check(['synthetic.read', 'synthetic.write'].includes(operation.name) && operation.targets.length > 0
    && new Set(operation.targets).size === operation.targets.length, 'guidance-operation-invalid');
  const selected: { constraint: RecognizedConstraint; block: GuidanceBlock }[] = [];
  for (const constraint of snapshot.constraints) {
    if (constraint.operation !== operation.name || !operation.targets.includes(constraint.target)) continue;
    const block = snapshot.guidance.find(g => g.locator === constraint.locator && g.targets.includes(constraint.target));
    if (!block) continue;
    check(block.hash === constraint.hash && constraint.quote.length > 0 && block.text.includes(constraint.quote), 'guidance-constraint-stale');
    selected.push({ constraint, block });
  }
  // Resolve ordinary AGENTS rules per resource, retaining unrelated wide rules.
  const effective = selected.filter(item => {
    if (snapshot.directives.some(d => d.operation === operation.name && d.target === item.constraint.target && d.key === item.constraint.key)) return false;
    return item.block.kind !== 'agents' || !selected.some(other => other.block.kind === 'agents'
      && other.constraint.target === item.constraint.target && other.constraint.key === item.constraint.key && other.block.depth > item.block.depth);
  });
  const conflicts: GuidanceConflict[] = [];
  for (const key of [...new Set([...effective.map(e => e.constraint.key), ...snapshot.directives
    .filter(d => d.operation === operation.name && operation.targets.includes(d.target)).map(d => d.key)])].sort()) {
    const rules = effective.filter(e => e.constraint.key === key);
    const directives = snapshot.directives.filter(d => d.operation === operation.name && operation.targets.includes(d.target) && d.key === key);
    const values = new Set([...rules.map(e => e.constraint.value), ...directives.map(d => d.value)]);
    if (values.size <= 1) continue;
    const evidence = rules.map(({ constraint, block }) => ({ ...constraint, ownerId: block.ownerId, scope: block.scope, version: block.version, kind: block.kind }));
    const kind = rules.length > 1 && rules.every(e => e.block.kind !== 'agents') && directives.length === 0 ? 'skill-conflict' : 'instruction-conflict';
    const identity = { operation, key, evidence, directives };
    const id = sha256(JSON.stringify(identity));
    if (!snapshot.resolutions.some(r => r.conflictId === id && values.has(r.value))) conflicts.push({ id, kind, operation, key, evidence });
  }
  return conflicts;
}
