import { readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { check, sha256 } from '../contracts.ts';
import type { GuidanceConfig, GuidanceScope } from './guidance-session.ts';
import type { ProbeStore } from '../store/probe-store.ts';
import { LocalGuidanceFiles, targetChain, verifyRoot } from './local-guidance.ts';
import type { GuidanceFile } from './local-guidance.ts';

export interface SkillRef { ownerId: string; scope: GuidanceScope; sourceLocator: string; entryLocator: string; hash: string }
export interface SkillEntry { name: string; description: string; ref: SkillRef }
export interface SkillCatalog { status: 'available' | 'unavailable'; reason: string | null; entries: SkillEntry[];
  complete: boolean; total: number; catalogHash: string; nextCursor: string | null }
export interface SkillActivation { ref: SkillRef; projectId: string; task: string; reason: 'owner-explicit' | 'catalog-selection';
  selectionReason: 'exact-qualified-ref'; shadowed: SkillRef[] }
type Membership = ReturnType<ProbeStore['guidanceMembership']>;

export function sameGuidanceScope(a: GuidanceScope, b: GuidanceScope): boolean {
  return a.kind === b.kind && a.id === b.id;
}
export function skillRefKey(ref: SkillRef): string {
  return JSON.stringify([ref.ownerId, ref.scope.kind, ref.scope.id, ref.sourceLocator, ref.entryLocator, ref.hash]);
}

export function skillSources(config: GuidanceConfig, membership: Membership, projectId: string): { scope: GuidanceScope; path: string; required: boolean }[] {
  const project = membership.projects.find(p => p.projectId === projectId);
  check(project, 'skill-scope-unresolved');
  const binding = config.projects.find(p => p.projectId === projectId);
  check(binding, 'guidance-project-unbound');
  const root = verifyRoot(config.dataRoot);
  const defaults = [
    { scope: { kind: 'project', id: projectId } as GuidanceScope, path: join(verifyRoot(binding.root), '.agents', 'skills'), required: false },
    ...(project.workspaceId ? [{ scope: { kind: 'workspace', id: project.workspaceId } as GuidanceScope,
      path: join(root, 'agent', 'workspaces', project.workspaceId, 'skills'), required: false }] : []),
    { scope: { kind: 'global', id: membership.ownerId } as GuidanceScope, path: join(root, 'agent', 'skills'), required: false },
    ...(config.sharedSkills ? [{ scope: { kind: 'global', id: membership.ownerId } as GuidanceScope,
      path: verifyRoot(config.sharedSkills), required: true }] : []),
  ];
  const applicable = config.sources.filter(s => s.scope.kind === 'global' && s.scope.id === membership.ownerId
    || s.scope.kind === 'project' && s.scope.id === projectId
    || s.scope.kind === 'workspace' && s.scope.id === project.workspaceId);
  const identity = (path: string) => { try { return realpathSync.native(path); } catch { return resolve(path); } };
  const overrides = applicable.map(s => ({ ...s, canonical: identity(s.root.path) }));
  const result: typeof defaults = [];
  const seen = new Set<string>();
  // Scope priority first; native/shared/registered source order within a scope.
  for (const kind of ['project', 'workspace', 'global']) {
    for (const source of [...defaults.filter(s => s.scope.kind === kind), ...applicable.filter(s => s.scope.kind === kind)
      .map(s => ({ scope: s.scope, path: s.root.path, required: true }))]) {
      const matching = overrides.filter(s => s.canonical === identity(source.path) && sameGuidanceScope(s.scope, source.scope));
      if (matching.some(s => !s.enabled || !s.trusted)) continue;
      for (const override of matching) verifyRoot(override.root);
      let path: string;
      try { path = realpathSync.native(source.path); check(statSync(path).isDirectory(), 'skill-directory-unavailable'); }
      catch (error) { if (!source.required && (error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (!source.required) targetChain(source.scope.kind === 'project' ? binding.root : config.dataRoot, source.path);
      const key = JSON.stringify([membership.ownerId, source.scope.kind, source.scope.id, path]);
      if (seen.has(key)) continue;
      seen.add(key); result.push({ ...source, path });
    }
  }
  return result;
}

export function skillMetadata(file: GuidanceFile): Pick<SkillEntry, 'name' | 'description'> {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(file.text);
  check(match, 'skill-metadata-invalid');
  const document = parseDocument(match[1]!, { uniqueKeys: true });
  check(document.errors.length === 0, 'skill-metadata-invalid');
  const data = document.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
  check(data && typeof data === 'object' && !Array.isArray(data), 'skill-metadata-invalid');
  check(typeof data.name === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.name)
    && data.name.length <= 64 && basename(file.locator.replace(/[\\/]SKILL\.md$/, '')) === data.name, 'skill-metadata-invalid');
  check(typeof data.description === 'string' && data.description.trim().length > 0 && data.description.length <= 1024, 'skill-metadata-invalid');
  return { name: data.name, description: data.description };
}

export function discoverSkills(config: GuidanceConfig, membership: Membership, projectId: string, files: LocalGuidanceFiles): SkillEntry[] {
  const entries: SkillEntry[] = [];
  for (const source of skillSources(config, membership, projectId)) {
    const directories = readdirSync(source.path, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const directory of directories) {
      check(!directory.isSymbolicLink(), 'skill-directory-alias');
      if (!directory.isDirectory()) continue;
      const file = files.read(join(source.path, directory.name, 'SKILL.md'), source.path, true);
      if (!file) continue;
      const metadata = skillMetadata(file);
      entries.push({ ...metadata, ref: { ownerId: membership.ownerId, scope: source.scope,
        sourceLocator: source.path, entryLocator: file.locator, hash: file.hash } });
    }
  }
  return entries;
}
export function catalogPage(entries: SkillEntry[], query: string, limit: number, cursor?: string): SkillCatalog {
  check(typeof query === 'string' && query.length <= 1024 && Number.isSafeInteger(limit) && limit > 0 && limit <= 128, 'skill-query-invalid');
  const catalogHash = sha256(JSON.stringify({ entries, query }));
  const matches = entries.filter(e => `${e.name} ${e.description}`.toLowerCase().includes(query.toLowerCase()));
  let offset = 0;
  if (cursor) {
    const [hash, index] = cursor.split(':'); offset = Number(index);
    check(hash === catalogHash && Number.isSafeInteger(offset) && offset >= 0 && offset <= matches.length, 'skill-cursor-stale');
  }
  const page = matches.slice(offset, offset + limit);
  return { status: 'available', reason: null, entries: page, complete: offset === 0 && page.length === entries.length,
    total: entries.length, catalogHash, nextCursor: offset + page.length < matches.length ? `${catalogHash}:${offset + page.length}` : null };
}
