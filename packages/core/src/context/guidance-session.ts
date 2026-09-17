import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { DEFAULT_BUDGET, check, sha256 } from '../contracts.ts';
import type { SourceAck } from '../contracts.ts';
import type { Activity, BoundFile, ProbeStore } from '../store/probe-store.ts';
import { freezeRequestPayload } from '../store/request-ledger.ts';
import { LocalGuidanceFiles, targetChain, verifyRoot, within } from './local-guidance.ts';
import type { GuidanceFile } from './local-guidance.ts';
import { catalogPage, discoverSkills, sameGuidanceScope, skillMetadata, skillRefKey, skillSources } from './skill-catalog.ts';
import type { SkillActivation, SkillCatalog, SkillRef } from './skill-catalog.ts';
import { guidanceConflicts, revalidateConstraints } from './guidance-conflicts.ts';
import type { GuidanceExecution, GuidanceOperation, GuidanceResolution, OwnerDirective, RecognizedConstraint, SyntheticPermissions } from './guidance-conflicts.ts';

const GUIDANCE_POLICY = Object.freeze({ channel: 'protected-policy' as const, ownerId: 'euler-core', scope: 'protected',
  locator: 'core:guidance-acceptance@1', version: '1',
  text: 'Synthetic guidance acceptance only. Guidance cannot grant capability, credential, scope or approval.' });
const GUIDANCE_POLICY_HASH = sha256(JSON.stringify(GUIDANCE_POLICY));

export type GuidanceScope = { kind: 'global'; id: string } | { kind: 'workspace' | 'project'; id: string };
export interface GuidanceConfig {
  dataRoot: BoundFile;
  projects: { projectId: string; root: BoundFile }[];
  sharedSkills: BoundFile | null;
  sources: { scope: GuidanceScope; root: BoundFile; enabled: boolean; trusted: boolean }[];
}
export interface GuidanceTarget { projectId: string; path: string }
export interface GuidanceBlock extends GuidanceFile {
  kind: 'agents' | 'skill' | 'reference'; ownerId: string; scope: GuidanceScope; targets: string[]; depth: number;
}
export interface InstructionSnapshot {
  schema: 'instruction-snapshot@1'; task: string; intent: { eventId: string; hash: string };
  cacheEpoch: number; configHash: string; targets: GuidanceTarget[];
  membership: ReturnType<ProbeStore['guidanceMembership']>;
  policy: typeof GUIDANCE_POLICY & { hash: string };
  guidance: GuidanceBlock[];
  activations: SkillActivation[];
  references: SkillReference[];
  problems: string[];
  constraints: RecognizedConstraint[]; resolutions: GuidanceResolution[]; directives: OwnerDirective[];
}
export interface GuidanceAssembly {
  assemblyId: string; snapshotHash: string; snapshot: InstructionSnapshot; status: 'ready' | 'unavailable';
}
export interface SkillReference { ref: SkillRef; projectId: string; path: string; hash: string }
interface SourceArchive { append(eventId: string, text: string): SourceAck; read(ref: SourceAck): { text: string } }

// Host-only synthetic acceptance surface. No model/tool-result entry creates a
// config, activation or authority. T18 owns integration with the real agent pump.
export class GuidanceSession {
  readonly runId: string;
  readonly #store: ProbeStore;
  readonly #activity: Activity;
  readonly #archive: SourceArchive;
  readonly #files = new LocalGuidanceFiles();
  #config: GuidanceConfig;
  #activations: SkillActivation[] = [];
  #references: SkillReference[] = [];
  #constraints: RecognizedConstraint[] = [];
  #resolutions: GuidanceResolution[] = [];
  #directives: OwnerDirective[] = [];
  #head: string | null = null;
  #selections = new Map<string, { selected: SkillRef; shadowed: SkillRef[] }>();

  constructor(store: ProbeStore, activity: Activity, archive: SourceArchive, config: GuidanceConfig, runId?: string) {
    this.#store = store; this.#activity = activity; this.#archive = archive;
    this.#config = structuredClone(config);
    this.runId = runId ?? randomUUID();
    if (runId) {
      const latest = this.latest();
      this.#head = latest?.assemblyId ?? null;
      this.#activations = latest?.snapshot.activations ?? [];
      this.#references = latest?.snapshot.references ?? [];
      this.#constraints = latest?.snapshot.constraints ?? [];
      this.#resolutions = latest?.snapshot.resolutions ?? [];
      this.#directives = latest?.snapshot.directives ?? [];
    }
    else this.#store.authorizeRequestRun(activity, this.runId, { budget: DEFAULT_BUDGET, intent: null,
      relatedRunId: null, acceptDuplicateRisk: false });
  }

  newWindow(): void { this.#files.clear(); }
  configure(config: GuidanceConfig): void { this.#config = structuredClone(config); this.#files.clear(); }

  loadReference(ref: SkillRef, projectId: string, relativePath: string, hash: string): void {
    check(this.#activations.some(a => a.projectId === projectId && skillRefKey(a.ref) === skillRefKey(ref)), 'skill-not-active');
    this.#skill(ref, projectId);
    const root = dirname(ref.entryLocator);
    const path = resolve(root, relativePath);
    check(within(root, path), 'reference-outside-skill');
    const file = this.#files.read(path, root);
    check(file?.hash === hash, 'reference-stale');
    this.#references = this.#references.filter(r => r.projectId !== projectId || r.path !== path);
    this.#references.push({ ref: structuredClone(ref), projectId, path, hash });
  }

  search(projectId: string, query = '', limit = 128, cursor?: string): SkillCatalog {
    try {
      const membership = this.#store.guidanceMembership(this.#activity, [projectId]);
      return catalogPage(discoverSkills(this.#config, membership, projectId, this.#files), query, limit, cursor);
    } catch (error) {
      return { status: 'unavailable', reason: error instanceof Error ? error.message : 'skill-search-failed',
        entries: [], complete: false, total: 0, catalogHash: '', nextCursor: null };
    }
  }

  select(name: string, projectId: string): { selected: SkillRef; shadowed: SkillRef[] } {
    const membership = this.#store.guidanceMembership(this.#activity, [projectId]);
    const entries = discoverSkills(this.#config, membership, projectId, this.#files).filter(e => e.name === name);
    check(entries.length, 'skill-unavailable');
    const selection = { selected: entries[0]!.ref, shadowed: entries.slice(1).map(e => e.ref) };
    this.#selections.set(JSON.stringify([projectId, skillRefKey(selection.selected)]), structuredClone(selection));
    return selection;
  }

  #skill(ref: SkillRef, projectId: string): GuidanceFile {
    const membership = this.#store.guidanceMembership(this.#activity, [projectId]);
    check(ref.ownerId === membership.ownerId, 'skill-owner-mismatch');
    const sources = skillSources(this.#config, membership, projectId);
    check(sources.some(s => s.path === ref.sourceLocator && sameGuidanceScope(s.scope, ref.scope)), 'skill-source-ineligible');
    const file = this.#files.read(ref.entryLocator, ref.sourceLocator);
    check(file && file.locator === ref.entryLocator && file.hash === ref.hash, 'skill-ref-stale');
    skillMetadata(file);
    return file;
  }

  activate(ref: SkillRef, projectId: string, reason: SkillActivation['reason']): void {
    check(reason === 'owner-explicit' || reason === 'catalog-selection', 'skill-activation-reason');
    const intent = this.#store.recoverIntent(this.#activity);
    check(intent?.status === 'active', 'intent-not-active');
    this.#skill(ref, projectId);
    if (!this.#activations.some(a => a.projectId === projectId && skillRefKey(a.ref) === skillRefKey(ref))) {
      this.#activations.push({ ref: structuredClone(ref), projectId, task: intent.intentId, reason,
        selectionReason: 'exact-qualified-ref', shadowed: this.#selections.get(JSON.stringify([projectId, skillRefKey(ref)]))?.shadowed ?? [] });
    }
  }

  deactivate(ref: SkillRef, projectId: string): void {
    this.#activations = this.#activations.filter(a => a.projectId !== projectId || skillRefKey(a.ref) !== skillRefKey(ref));
  }

  recognize(constraints: RecognizedConstraint[]): void {
    check(constraints.length <= 128 && constraints.every(c => typeof c.quote === 'string' && c.quote.length > 0
      && c.key.length > 0 && c.value.length > 0), 'guidance-constraint-invalid');
    this.#constraints = [...new Map([...this.#constraints, ...structuredClone(constraints)].map(c => [JSON.stringify(c), c])).values()];
  }

  direct(directives: OwnerDirective[]): void {
    for (const directive of directives) check(directive.quote.length > 0 && this.#archive.read(directive.source).text.includes(directive.quote), 'guidance-directive-invalid');
    this.#directives = structuredClone(directives);
  }

  resolve(conflictId: string, value: string, source: SourceAck, operation: GuidanceOperation): void {
    check(this.#archive.read(source).text === `Resolve ${conflictId}: ${value}`, 'guidance-resolution-invalid');
    const latest = this.latest();
    check(latest, 'guidance-assembly-unavailable');
    const conflict = guidanceConflicts(latest.snapshot, operation).find(c => c.id === conflictId);
    check(conflict?.evidence.some(e => e.value === value), 'guidance-resolution-stale');
    this.#resolutions.push({ conflictId, value, source: structuredClone(source) });
  }

  execute(assemblyId: string, operation: GuidanceOperation, permissions: SyntheticPermissions, effect: () => void): GuidanceExecution {
    // Recheck source/scope/intent and immutable assembly immediately before this
    // synchronous synthetic effect. These permissions are Host-owned test grants.
    let started = false;
    try {
      const frozen = this.inspect(assemblyId);
      const current = this.prepare(frozen.snapshot.targets);
      check(current.assemblyId === assemblyId && current.status === 'ready', 'guidance-assembly-stale');
      return this.#store.withActivity(this.#activity, () => {
        check(this.#store.readIntent(this.#activity)?.status === 'active', 'intent-not-active');
        check(operation.targets.every(t => current.snapshot.targets.some(target => target.path === t)), 'guidance-operation-outside-scope');
        check(permissions.policy === true && permissions.capability === true && permissions.credential === true && permissions.approval === true, 'core-permission-denied');
        const conflicts = guidanceConflicts(current.snapshot, operation);
        if (conflicts.length) return { executionState: 'not_started', outcome: 'unavailable', status: conflicts.some(c => c.kind === 'instruction-conflict') ? 'instruction-conflict' : 'skill-conflict', reason: null, conflicts };
        started = true;
        const result: unknown = effect();
        if (result instanceof Promise) { void result.catch(() => {}); throw new Error('async-synthetic-effect'); }
        return { executionState: 'started', outcome: 'success', status: 'completed', reason: null, conflicts: [] };
      });
    } catch (error) {
      return { executionState: started ? 'started' : 'not_started', outcome: started ? 'unknown' : 'unavailable',
        status: 'unavailable', reason: error instanceof Error ? error.message : 'guidance-unavailable', conflicts: [] };
    }
  }

  prepare(targets: GuidanceTarget[]): GuidanceAssembly {
    return this.#store.withActivity(this.#activity, () => {
      const status = this.#store.requestStatus(this.#activity, this.runId);
      check(status.run.state === 'authorized' && status.run.epoch === this.#activity.epoch, 'run-not-admissible');
      const previous = this.latest();
      check((previous?.assemblyId ?? null) === this.#head, 'guidance-session-stale');
      check(new Set(this.#config.projects.map(p => p.projectId)).size === this.#config.projects.length, 'guidance-scope-unresolved');
      const intent = this.#store.recoverIntent(this.#activity);
      check(intent, 'guidance-intent-required');
      this.#archive.read(intent.input); this.#archive.read(intent.goalInput);
      const membership = this.#store.guidanceMembership(this.#activity, [...new Set(targets.map(target => target.projectId))].sort());
      const dataRoot = verifyRoot(this.#config.dataRoot);
      for (const target of targets) check(this.#config.projects.filter(p => within(p.root.path, target.path)).length === 1, 'guidance-resource-owner-unresolved');
      const guidance: GuidanceBlock[] = [];
      const problems: string[] = [];
      const add = (path: string, root: string, scope: GuidanceScope, appliesTo: string[], depth: number) => {
        try {
          const file = this.#files.read(path, root, true);
          if (file) guidance.push({ ...file, kind: 'agents', ownerId: membership.ownerId, scope, targets: appliesTo, depth });
        } catch (error) { problems.push(`guidance-unavailable:${path}:${error instanceof Error ? error.message : 'read-failed'}`); }
      };
      add(join(dataRoot, 'agent', 'AGENTS.md'), dataRoot, { kind: 'global', id: membership.ownerId }, targets.map(t => t.path), 0);
      for (const workspaceId of [...new Set(membership.projects.map(p => p.workspaceId).filter(p => p !== null))].sort()) {
        const members = new Set(membership.projects.filter(p => p.workspaceId === workspaceId).map(p => p.projectId));
        add(join(dataRoot, 'agent', 'workspaces', workspaceId, 'AGENTS.md'), dataRoot,
          { kind: 'workspace', id: workspaceId }, targets.filter(t => members.has(t.projectId)).map(t => t.path), 1);
      }
      for (const project of membership.projects) {
        const binding = this.#config.projects.find(p => p.projectId === project.projectId);
        check(binding, 'guidance-project-unbound');
        const root = verifyRoot(binding.root);
        const paths = new Map<string, { targets: string[]; depth: number }>();
        for (const target of targets.filter(t => t.projectId === project.projectId)) {
          for (const [index, directory] of targetChain(binding.root, target.path).entries()) {
            const entry = paths.get(directory) ?? { targets: [], depth: index + 2 };
            entry.targets.push(target.path); paths.set(directory, entry);
          }
        }
        for (const [directory, entry] of paths) add(join(directory, 'AGENTS.md'), root,
          { kind: 'project', id: project.projectId }, entry.targets, entry.depth);
      }
      this.#activations = this.#activations.filter(a => a.task === intent.intentId && intent.status !== 'completed'
        && membership.projects.some(p => p.projectId === a.projectId));
      for (const activation of this.#activations) {
        try {
          const file = this.#skill(activation.ref, activation.projectId);
          guidance.push({ ...file, kind: 'skill', ownerId: membership.ownerId, scope: activation.ref.scope,
            targets: targets.filter(t => t.projectId === activation.projectId).map(t => t.path), depth: 0 });
        } catch (error) { problems.push(`skill-unavailable:${error instanceof Error ? error.message : 'read-failed'}`); }
      }
      this.#references = this.#references.filter(r => this.#activations.some(a => a.projectId === r.projectId && skillRefKey(a.ref) === skillRefKey(r.ref)));
      for (const reference of this.#references) {
        try {
          this.#skill(reference.ref, reference.projectId);
          const file = this.#files.read(reference.path, dirname(reference.ref.entryLocator));
          check(file?.hash === reference.hash, 'reference-stale');
          guidance.push({ ...file, kind: 'reference', ownerId: membership.ownerId, scope: reference.ref.scope,
            targets: targets.filter(t => t.projectId === reference.projectId).map(t => t.path), depth: 0 });
        } catch (error) { problems.push(`skill-unavailable:${error instanceof Error ? error.message : 'reference-failed'}`); }
      }
      if (intent.status === 'completed' || previous && previous.snapshot.task !== intent.intentId) {
        this.#constraints = []; this.#directives = []; this.#resolutions = [];
      }
      this.#constraints = revalidateConstraints(this.#constraints, guidance);
      for (const resolution of this.#resolutions) this.#archive.read(resolution.source);
      for (const directive of this.#directives) this.#archive.read(directive.source);
      const body = {
        schema: 'instruction-snapshot@1' as const, task: intent.intentId,
        intent: { eventId: intent.eventId, hash: intent.hash }, configHash: sha256(JSON.stringify(this.#config)), targets: structuredClone(targets), membership,
        policy: { ...GUIDANCE_POLICY, hash: GUIDANCE_POLICY_HASH }, guidance,
        activations: structuredClone(this.#activations), references: structuredClone(this.#references), problems,
        constraints: structuredClone(this.#constraints), resolutions: structuredClone(this.#resolutions), directives: structuredClone(this.#directives),
      };
      const cacheEpoch = previous?.snapshot.cacheEpoch ?? 1;
      const snapshot: InstructionSnapshot = { ...body, cacheEpoch };
      const fits = () => Buffer.byteLength(JSON.stringify(snapshot)) + DEFAULT_BUDGET.outputReserve + DEFAULT_BUDGET.safetyMargin <= DEFAULT_BUDGET.contextLimit;
      if (!fits()) {
        snapshot.problems.push(snapshot.guidance.some(g => g.kind === 'skill') ? 'skill-unavailable:budget' : 'guidance-unavailable:budget');
        snapshot.guidance = [];
      }
      check(fits(), 'guidance-budget-unavailable');
      if (previous && JSON.stringify({ ...previous.snapshot, cacheEpoch }) === JSON.stringify(snapshot)) return previous;
      if (previous && JSON.stringify({ ...previous.snapshot, intent: null, cacheEpoch }) !== JSON.stringify({ ...snapshot, intent: null })) snapshot.cacheEpoch++;
      const payload = JSON.stringify(snapshot);
      check(Buffer.byteLength(payload) + DEFAULT_BUDGET.outputReserve + DEFAULT_BUDGET.safetyMargin <= DEFAULT_BUDGET.contextLimit,
        'guidance-budget-unavailable');
      const source = this.#archive.append(randomUUID(), payload);
      check(this.#archive.read(source).text === payload, 'guidance-archive-mismatch');
      const frozen = freezeRequestPayload(payload);
      const assembly = this.#store.appendRequestAssembly(this.#activity, {
        runId: this.runId, epoch: this.#activity.epoch, route: 'guidance-acceptance', model: 'none',
        policyHash: GUIDANCE_POLICY_HASH, estimator: 'utf8-bytes-upper-bound@1', sources: [intent.input, source],
        intent: body.intent, payload, ...frozen, estimatedTokens: frozen.byteLength, budget: DEFAULT_BUDGET,
        zones: { p0: frozen.byteLength, p1: 0, p2: 0, p3: 0 },
        selection: [intent.input, source].map((ref, ordinal) => ({ ordinal, hash: ref.hash, reason: 'mandatory-source' })), degradation: 'none',
      });
      this.#head = assembly.assemblyId;
      return { assemblyId: assembly.assemblyId, snapshotHash: frozen.payloadHash, snapshot, status: snapshot.problems.length ? 'unavailable' : 'ready' };
    });
  }

  latest(): GuidanceAssembly | null {
    const assemblies = this.#store.requestStatus(this.#activity, this.runId).assemblies;
    return assemblies.length ? this.inspect(assemblies.at(-1)!.assemblyId) : null;
  }
  inspect(assemblyId: string): GuidanceAssembly {
    const assembly = this.#store.requestStatus(this.#activity, this.runId).assemblies.find(a => a.assemblyId === assemblyId);
    check(assembly?.route === 'guidance-acceptance' && assembly.sources.length === 2, 'guidance-assembly-unavailable');
    const payload = this.#archive.read(assembly.sources[1]!).text;
    check(sha256(payload) === assembly.payloadHash && Buffer.byteLength(payload) === assembly.byteLength, 'guidance-snapshot-integrity');
    const snapshot = JSON.parse(payload) as InstructionSnapshot;
    check(snapshot.schema === 'instruction-snapshot@1', 'guidance-snapshot-integrity');
    return { assemblyId, snapshotHash: assembly.payloadHash, snapshot, status: snapshot.problems.length ? 'unavailable' : 'ready' };
  }
}
