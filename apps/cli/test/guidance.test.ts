import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { GuidanceSession, fileIdentity, sha256 } from '@euler/core';
import { bindingOf, createSandbox, createSandboxSession } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

function fixture() {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  const intent = probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text).intent;
  const root = join(sandbox.root, 'project');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(sandbox.root, 'agent'), { recursive: true });
  const workspaceId = randomUUID();
  probe.store.bindWorkspace(probe.activity, workspaceId, [sandbox.fixture.projectId]);
  mkdirSync(join(sandbox.root, 'agent', 'workspaces', workspaceId), { recursive: true });
  const config = {
    dataRoot: { path: sandbox.root, identity: fileIdentity(sandbox.root) },
    projects: [{ projectId: sandbox.fixture.projectId, root: { path: root, identity: fileIdentity(root) } }],
    sharedSkills: null, sources: [],
  };
  const core = new GuidanceSession(probe.store, probe.activity, probe.archive, config);
  const target = { projectId: sandbox.fixture.projectId, path: join(root, 'src', 'example.ts') };
  return { sandbox, probe, root, workspaceId, config, core, target, intent,
    close() { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); } };
}

function skill(root: string, name: string, text = 'Follow the complete instructions.\n') {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  const body = `---\nname: ${name}\ndescription: >-\n  A standard multiline\n  skill description\nallowed-tools: shell\nmetadata:\n  author: example\n---\n${text}`;
  writeFileSync(join(directory, 'SKILL.md'), body);
  return { directory, body };
}

test('Skill discovery is bounded, resolves default scopes and preserves explicit full-byte selections', () => {
  const f = fixture();
  try {
    const global = skill(join(f.sandbox.root, 'agent', 'skills'), 'review');
    const local = skill(join(f.root, '.agents', 'skills'), 'review', 'Project exact body.\r\n');
    skill(join(f.root, '.agents', 'skills'), 'other');
    const catalog = f.core.search(f.target.projectId, '', 1);
    assert.equal(catalog.status, 'available');
    assert.equal(catalog.complete, false);
    assert.ok(catalog.nextCursor);
    const next = f.core.search(f.target.projectId, '', 10, catalog.nextCursor!);
    assert.equal(next.entries.length, 2);
    const chosen = f.core.select('review', f.target.projectId);
    assert.equal(chosen.selected.entryLocator, join(local.directory, 'SKILL.md'));
    assert.equal(chosen.shadowed.length, 1);
    const all = f.core.search(f.target.projectId);
    const explicit = all.entries.find(e => e.ref.entryLocator === join(global.directory, 'SKILL.md'))!.ref;
    f.core.activate(explicit, f.target.projectId, 'owner-explicit');
    const prepared = f.core.prepare([f.target]);
    assert.equal(prepared.snapshot.guidance.find(g => g.kind === 'skill')!.text, global.body);
    assert.equal(prepared.snapshot.activations[0]!.ref.hash, sha256(global.body));
    assert.equal(f.core.prepare([f.target]).assemblyId, prepared.assemblyId);
    f.core.newWindow();
    assert.equal(f.core.prepare([f.target]).assemblyId, prepared.assemblyId);
    f.core.deactivate(explicit, f.target.projectId);
    const disabled = f.core.prepare([f.target]);
    assert.equal(disabled.snapshot.guidance.filter(g => g.kind === 'skill').length, 0);
    assert.equal(disabled.snapshot.cacheEpoch, prepared.snapshot.cacheEpoch + 1);
    assert.equal(f.core.inspect(prepared.assemblyId).snapshot.guidance.find(g => g.kind === 'skill')!.text, global.body);
  } finally { f.close(); }
});
test('source gates and exact Skill identity do not depend on object property order', () => {
  const f = fixture();
  try {
    const root = join(f.sandbox.root, 'shared');
    const selected = skill(root, 'review');
    writeFileSync(join(selected.directory, 'details.md'), 'Reference.');
    const bound = { path: root, identity: fileIdentity(root) };
    const scope = { id: f.sandbox.fixture.ownerId, kind: 'global' as const };
    const config = { ...f.config, sharedSkills: bound, sources: [{ scope, root: bound, enabled: true, trusted: true }] };
    f.core.configure(config);
    assert.equal(f.core.search(f.target.projectId).entries.length, 1);
    const ref = f.core.select('review', f.target.projectId).selected;
    const reordered = { hash: ref.hash, entryLocator: ref.entryLocator, sourceLocator: ref.sourceLocator,
      scope: { id: ref.scope.id, kind: ref.scope.kind }, ownerId: ref.ownerId };
    f.core.activate(ref, f.target.projectId, 'owner-explicit');
    f.core.activate(reordered, f.target.projectId, 'owner-explicit');
    assert.equal(f.core.prepare([f.target]).snapshot.activations.length, 1);
    f.core.loadReference(reordered, f.target.projectId, 'details.md', sha256('Reference.'));
    f.core.deactivate(reordered, f.target.projectId);
    const removed = f.core.prepare([f.target]);
    assert.equal(removed.snapshot.activations.length, 0);
    assert.equal(removed.snapshot.references.length, 0);
    for (const gates of [{ enabled: false, trusted: true }, { enabled: true, trusted: false }]) {
      f.core.configure(config);
      f.core.activate(ref, f.target.projectId, 'owner-explicit');
      f.core.prepare([f.target]);
      f.core.configure({ ...config, sources: [{ ...config.sources[0]!, ...gates }] });
      assert.equal(f.core.search(f.target.projectId).entries.length, 0);
      assert.equal(f.core.prepare([f.target]).status, 'unavailable');
      assert.throws(() => f.core.activate(reordered, f.target.projectId, 'owner-explicit'), /skill-source-ineligible/);
      f.core.deactivate(reordered, f.target.projectId);
    }
  } finally { f.close(); }
});

test('stale Skill, partial budgets and references fail closed and never silently switch implementations', () => {
  const f = fixture();
  try {
    skill(join(f.sandbox.root, 'agent', 'skills'), 'review', 'Fallback must not be used.');
    const selected = skill(join(f.root, '.agents', 'skills'), 'review');
    mkdirSync(join(selected.directory, 'references'));
    mkdirSync(join(selected.directory, 'scripts'));
    const reference = join(selected.directory, 'references', 'details.md');
    writeFileSync(reference, 'Exact reference.\n');
    writeFileSync(join(selected.directory, 'scripts', 'run.js'), 'throw new Error("MUST NOT EXECUTE");');
    const ref = f.core.select('review', f.target.projectId).selected;
    f.core.activate(ref, f.target.projectId, 'owner-explicit');
    const before = f.core.prepare([f.target]);
    assert.equal(before.snapshot.guidance.filter(g => g.kind === 'reference').length, 0);
    f.core.loadReference(ref, f.target.projectId, 'references/details.md', sha256('Exact reference.\n'));
    const loaded = f.core.prepare([f.target]);
    assert.equal(loaded.snapshot.guidance.find(g => g.kind === 'reference')!.text, 'Exact reference.\n');
    assert.throws(() => f.core.loadReference(ref, f.target.projectId, '../review2/SKILL.md', sha256('')), /reference-outside-skill/);
    writeFileSync(reference, 'Changed reference.\n');
    const staleReference = f.core.prepare([f.target]);
    assert.equal(staleReference.status, 'unavailable');
    assert.match(staleReference.snapshot.problems.join(), /reference-stale/);
    assert.notEqual(staleReference.assemblyId, loaded.assemblyId);
    writeFileSync(join(selected.directory, 'SKILL.md'), selected.body + 'Changed body.');
    const stale = f.core.prepare([f.target]);
    assert.equal(stale.status, 'unavailable');
    assert.match(stale.snapshot.problems.join(), /skill-ref-stale/);
    assert.equal(stale.snapshot.guidance.some(g => g.kind === 'skill'), false);
    assert.equal(f.core.inspect(before.assemblyId).snapshot.guidance.find(g => g.kind === 'skill')!.text, selected.body);
    f.core.deactivate(ref, f.target.projectId);
    const huge = skill(join(f.root, '.agents', 'skills'), 'huge', 'Z'.repeat(18000));
    const hugeRef = f.core.select('huge', f.target.projectId).selected;
    f.core.activate(hugeRef, f.target.projectId, 'owner-explicit');
    const overBudget = f.core.prepare([f.target]);
    assert.equal(overBudget.status, 'unavailable');
    assert.match(overBudget.snapshot.problems.join(), /skill-unavailable:budget/);
    assert.equal(overBudget.snapshot.guidance.some(g => g.text.includes('ZZZZ')), false);
    assert.equal(sha256(readFileSync(join(huge.directory, 'SKILL.md'))), hugeRef.hash);
  } finally { f.close(); }
});

test('Core stops actual synthetic effects for direct Skill conflicts, preserves controls and accepts version-bound owner resolution', () => {
  const f = fixture();
  try {
    const first = skill(join(f.root, '.agents', 'skills'), 'first', 'Use npm for this operation.\n');
    const second = skill(join(f.root, '.agents', 'skills'), 'second', 'Use pnpm for this operation.\n');
    for (const name of ['first', 'second']) f.core.activate(f.core.select(name, f.target.projectId).selected, f.target.projectId, 'owner-explicit');
    const operation = { name: 'synthetic.write' as const, targets: [f.target.path] };
    f.core.recognize([
      { locator: join(first.directory, 'SKILL.md'), hash: sha256(first.body), quote: 'Use npm for this operation.', operation: operation.name, target: f.target.path, key: 'package-manager', value: 'npm' },
      { locator: join(second.directory, 'SKILL.md'), hash: sha256(second.body), quote: 'Use pnpm for this operation.', operation: operation.name, target: f.target.path, key: 'package-manager', value: 'pnpm' },
    ]);
    const assembly = f.core.prepare([f.target]);
    const allowed = { policy: true, capability: true, credential: true, approval: true };
    const output = join(f.root, 'result.txt');
    let effects = 0;
    const effect = () => { writeFileSync(output, 'synthetic effect'); effects++; };
    const blocked = f.core.execute(assembly.assemblyId, operation, allowed, effect);
    assert.equal(blocked.status, 'skill-conflict');
    assert.equal(effects, 0);
    assert.equal(blocked.conflicts[0]!.evidence.length, 2);
    assert.equal(f.core.execute(assembly.assemblyId, { ...operation, name: 'synthetic.read' }, allowed, effect).status, 'completed');
    assert.equal(effects, 1);
    const resolution = f.probe.archive.append(randomUUID(), `Resolve ${blocked.conflicts[0]!.id}: npm`);
    f.core.resolve(blocked.conflicts[0]!.id, 'npm', resolution, operation);
    const resolved = f.core.prepare([f.target]);
    assert.notEqual(resolved.assemblyId, assembly.assemblyId);
    assert.equal(f.core.execute(assembly.assemblyId, operation, allowed, effect).status, 'unavailable');
    assert.equal(f.core.execute(resolved.assemblyId, operation, { ...allowed, capability: false }, effect).status, 'unavailable');
    assert.equal(effects, 1);
    assert.equal(f.core.execute(resolved.assemblyId, operation, allowed, effect).status, 'completed');
    assert.equal(readFileSync(output, 'utf8'), 'synthetic effect');
    assert.equal(effects, 2);
    writeFileSync(join(first.directory, 'SKILL.md'), first.body + 'new version');
    assert.equal(f.core.execute(resolved.assemblyId, operation, allowed, effect).status, 'unavailable');
    assert.equal(effects, 2);
  } finally { f.close(); }
});

test('AGENTS scope precedence, compatible Skills and different operations avoid false conflicts', () => {
  const f = fixture();
  try {
    const globalPath = join(f.sandbox.root, 'agent', 'AGENTS.md');
    const projectPath = join(f.root, 'AGENTS.md');
    writeFileSync(globalPath, 'Use npm. Keep evidence.');
    writeFileSync(projectPath, 'Use pnpm.');
    const operation = { name: 'synthetic.write' as const, targets: [f.target.path] };
    const rule = (locator: string, quote: string, key: string, value: string) => ({ locator, hash: sha256(readFileSync(locator)), quote,
      operation: operation.name, target: f.target.path, key, value });
    f.core.recognize([rule(globalPath, 'Use npm.', 'manager', 'npm'), rule(globalPath, 'Keep evidence.', 'evidence', 'keep'), rule(projectPath, 'Use pnpm.', 'manager', 'pnpm')]);
    let effects = 0;
    const allowed = { policy: true, capability: true, credential: true, approval: true };
    let prepared = f.core.prepare([f.target]);
    assert.equal(f.core.execute(prepared.assemblyId, operation, allowed, () => effects++).status, 'completed');
    const compatible = skill(join(f.root, '.agents', 'skills'), 'compatible', 'Use pnpm.');
    const ref = f.core.select('compatible', f.target.projectId).selected;
    f.core.activate(ref, f.target.projectId, 'catalog-selection');
    f.core.recognize([rule(join(compatible.directory, 'SKILL.md'), 'Use pnpm.', 'manager', 'pnpm')]);
    prepared = f.core.prepare([f.target]);
    assert.equal(f.core.execute(prepared.assemblyId, operation, allowed, () => effects++).status, 'completed');
    const conflicting = skill(join(f.root, '.agents', 'skills'), 'conflicting', 'Use yarn.');
    f.core.activate(f.core.select('conflicting', f.target.projectId).selected, f.target.projectId, 'owner-explicit');
    f.core.recognize([rule(join(conflicting.directory, 'SKILL.md'), 'Use yarn.', 'manager', 'yarn')]);
    prepared = f.core.prepare([f.target]);
    assert.equal(f.core.execute(prepared.assemblyId, operation, allowed, () => effects++).status, 'instruction-conflict');
    f.core.recognize([]); // A recognizer cannot retract a conflict to grant permission.
    prepared = f.core.prepare([f.target]);
    assert.equal(f.core.execute(prepared.assemblyId, operation, allowed, () => effects++).status, 'instruction-conflict');
    const input = f.probe.archive.append(randomUUID(), 'For this operation use bun.');
    f.core.direct([{ source: input, quote: 'use bun', operation: operation.name, target: f.target.path, key: 'manager', value: 'bun' }]);
    prepared = f.core.prepare([f.target]);
    assert.equal(f.core.execute(prepared.assemblyId, operation, allowed, () => effects++).status, 'completed');
    for (const gate of ['policy', 'capability', 'credential', 'approval']) {
      assert.equal(f.core.execute(prepared.assemblyId, operation, { ...allowed, [gate]: false }, () => effects++).status, 'unavailable');
    }
    assert.equal(effects, 3);
  } finally { f.close(); }
});

test('a multi-target operation obeys each target independently and still blocks a real local conflict', () => {
  const f = fixture();
  try {
    const other = { ...f.target, path: join(f.root, 'src', 'other.ts') };
    const first = skill(join(f.root, '.agents', 'skills'), 'first', 'Use npm.');
    const second = skill(join(f.root, '.agents', 'skills'), 'second', 'Use pnpm.');
    for (const name of ['first', 'second']) f.core.activate(f.core.select(name, f.target.projectId).selected, f.target.projectId, 'owner-explicit');
    const operation = { name: 'synthetic.write' as const, targets: [f.target.path, other.path] };
    const rule = (source: typeof first, target: string, value: string) => ({ locator: join(source.directory, 'SKILL.md'), hash: sha256(source.body),
      quote: `Use ${value}.`, operation: operation.name, target, key: 'manager', value });
    f.core.recognize([rule(first, f.target.path, 'npm'), rule(second, other.path, 'pnpm')]);
    const allowed = { policy: true, capability: true, credential: true, approval: true };
    const prepared = f.core.prepare([f.target, other]);
    let effects = 0;
    assert.equal(f.core.execute(prepared.assemblyId, operation, allowed, () => effects++).status, 'completed');
    f.core.recognize([rule(second, f.target.path, 'pnpm')]);
    const conflicting = f.core.prepare([f.target, other]);
    const blocked = f.core.execute(conflicting.assemblyId, operation, allowed, () => effects++);
    assert.equal(blocked.status, 'skill-conflict');
    assert.equal(blocked.conflicts.length, 1);
    assert.ok(blocked.conflicts[0]!.evidence.every(e => e.target === f.target.path));
    assert.equal(effects, 1);
    assert.equal(f.core.execute(conflicting.assemblyId, { ...operation, targets: [other.path] }, allowed, () => effects++).status, 'completed');
    const input = f.probe.archive.append(randomUUID(), 'Use npm here and pnpm there.');
    f.core.direct([
      { source: input, quote: 'npm here', operation: operation.name, target: f.target.path, key: 'manager', value: 'npm' },
      { source: input, quote: 'pnpm there', operation: operation.name, target: other.path, key: 'manager', value: 'pnpm' },
    ]);
    const resolved = f.core.prepare([f.target, other]);
    assert.equal(f.core.execute(resolved.assemblyId, operation, allowed, () => effects++).status, 'completed');
    assert.equal(effects, 3);
  } finally { f.close(); }
});

test('changed guidance replaces stale constraints only after current-source recognition or an owner directive', () => {
  const f = fixture();
  try {
    const agents = join(f.root, 'AGENTS.md');
    writeFileSync(agents, 'Use npm.');
    const selected = skill(join(f.root, '.agents', 'skills'), 'review', 'Use pnpm.');
    f.core.activate(f.core.select('review', f.target.projectId).selected, f.target.projectId, 'owner-explicit');
    const operation = { name: 'synthetic.write' as const, targets: [f.target.path] };
    const rule = (locator: string, body: string, value: string) => ({ locator, hash: sha256(body), quote: `Use ${value}.`,
      operation: operation.name, target: f.target.path, key: 'manager', value });
    const oldRule = rule(agents, 'Use npm.', 'npm');
    f.core.recognize([oldRule, rule(join(selected.directory, 'SKILL.md'), selected.body, 'pnpm')]);
    const original = f.core.prepare([f.target]);
    const allowed = { policy: true, capability: true, credential: true, approval: true };
    let effects = 0;
    assert.equal(f.core.execute(original.assemblyId, operation, allowed, () => effects++).status, 'instruction-conflict');
    writeFileSync(agents, 'Use pnpm.');
    const changed = f.core.prepare([f.target]);
    assert.equal(f.core.execute(changed.assemblyId, operation, allowed, () => effects++).reason, 'guidance-constraint-stale');
    f.core.recognize([{ ...oldRule, hash: sha256('Use pnpm.') }]); // Actual new hash, but quote is no longer present.
    const forged = f.core.prepare([f.target]);
    assert.equal(f.core.execute(forged.assemblyId, operation, allowed, () => effects++).reason, 'guidance-constraint-stale');
    f.core.recognize([rule(agents, 'Use pnpm.', 'pnpm')]);
    const refreshed = f.core.prepare([f.target]);
    assert.equal(f.core.execute(refreshed.assemblyId, operation, allowed, () => effects++).status, 'completed');
    assert.equal(f.core.inspect(original.assemblyId).snapshotHash, original.snapshotHash);
    assert.deepEqual(f.core.inspect(original.assemblyId).snapshot.constraints[0], oldRule);
    writeFileSync(agents, 'Use yarn.');
    const input = f.probe.archive.append(randomUUID(), 'Use bun for this operation.');
    f.core.direct([{ source: input, quote: 'Use bun', operation: operation.name, target: f.target.path, key: 'manager', value: 'bun' }]);
    const directed = f.core.prepare([f.target]);
    assert.equal(f.core.execute(directed.assemblyId, operation, allowed, () => effects++).status, 'completed');
    assert.equal(effects, 2);
    f.core.direct([]);
    const stillStale = f.core.prepare([f.target]);
    assert.equal(f.core.execute(stillStale.assemblyId, operation, allowed, () => effects++).reason, 'guidance-constraint-stale');
    const resumed = new GuidanceSession(f.probe.store, f.probe.activity, f.probe.archive, f.config, f.core.runId);
    resumed.recognize([rule(agents, 'Use yarn.', 'yarn')]);
    const again = resumed.prepare([f.target]);
    assert.equal(resumed.execute(again.assemblyId, operation, allowed, () => effects++).status, 'instruction-conflict');
    assert.equal(effects, 2);
  } finally { f.close(); }
});

test('project sources remain independent and ambiguous or unregistered resources stop', () => {
  const f = fixture();
  try {
    const projectId = randomUUID();
    createSandboxSession(f.sandbox, { ...bindingOf(f.sandbox), projectId, sessionId: randomUUID(), branchId: randomUUID() });
    const other = join(f.sandbox.root, 'other'); mkdirSync(other);
    writeFileSync(join(f.root, 'AGENTS.md'), 'A uses npm.');
    writeFileSync(join(other, 'AGENTS.md'), 'B uses pnpm.');
    f.core.configure({ ...f.config, projects: [...f.config.projects, { projectId, root: { path: other, identity: fileIdentity(other) } }] });
    const second = { projectId, path: join(other, 'file.txt') };
    const prepared = f.core.prepare([f.target, second]);
    const guidance = prepared.snapshot.guidance;
    assert.deepEqual(guidance.find(g => g.text === 'A uses npm.')!.targets, [f.target.path]);
    assert.deepEqual(guidance.find(g => g.text === 'B uses pnpm.')!.targets, [second.path]);
    assert.throws(() => f.core.prepare([{ projectId: randomUUID(), path: second.path }]), /scope-unresolved/);
    assert.throws(() => f.core.prepare([{ projectId: f.target.projectId, path: second.path }]), /outside-project/);
  } finally { f.close(); }
});

test('invalid catalogs report unavailable, aliases deduplicate, disabled sources and stale cursor do not fall back', () => {
  const f = fixture();
  try {
    const root = join(f.root, '.agents', 'skills');
    skill(root, 'review');
    f.core.configure({ ...f.config, sources: [{ scope: { kind: 'project', id: f.target.projectId }, root: { path: root, identity: fileIdentity(root) }, enabled: true, trusted: true }] });
    assert.equal(f.core.search(f.target.projectId).entries.length, 1);
    skill(root, 'other');
    const page = f.core.search(f.target.projectId, '', 1);
    skill(root, 'third');
    assert.equal(f.core.search(f.target.projectId, '', 1, page.nextCursor!).reason, 'skill-cursor-stale');
    const chosen = f.core.select('review', f.target.projectId).selected;
    f.core.activate(chosen, f.target.projectId, 'owner-explicit');
    const before = f.core.prepare([f.target]);
    f.core.configure({ ...f.config, sources: [{ scope: { kind: 'project', id: f.target.projectId }, root: { path: root, identity: fileIdentity(root) }, enabled: true, trusted: false }] });
    assert.equal(f.core.search(f.target.projectId).entries.length, 0);
    const revoked = f.core.prepare([f.target]);
    assert.equal(revoked.status, 'unavailable');
    assert.notEqual(revoked.assemblyId, before.assemblyId);
    assert.equal(revoked.snapshot.guidance.filter(g => g.kind === 'skill').length, 0);
    f.core.configure(f.config);
    writeFileSync(join(root, 'review', 'SKILL.md'), '---\nname: review\n---\nMissing description.');
    const invalid = f.core.search(f.target.projectId);
    assert.equal(invalid.status, 'unavailable');
    assert.equal(invalid.complete, false);
    rmSync(root, { recursive: true }); writeFileSync(root, 'not a directory');
    assert.equal(f.core.search(f.target.projectId).status, 'unavailable');
  } finally { f.close(); }
});

test('same-task moves retain Skill bytes, restart revalidates full sources, and task end releases the binding', () => {
  const f = fixture();
  try {
    const selected = skill(join(f.root, '.agents', 'skills'), 'review');
    const ref = f.core.select('review', f.target.projectId).selected;
    f.core.activate(ref, f.target.projectId, 'owner-explicit');
    const first = f.core.prepare([f.target]);
    const moved = f.core.prepare([{ ...f.target, path: join(f.root, 'src', 'other.ts') }]);
    assert.equal(moved.snapshot.guidance.find(g => g.kind === 'skill')!.text, selected.body);
    f.probe.close();
    const reopened = openProbe(f.sandbox);
    try {
      const recovered = new GuidanceSession(reopened.store, reopened.activity, reopened.archive, f.config, f.core.runId);
      assert.equal(recovered.inspect(first.assemblyId).snapshotHash, first.snapshotHash);
      assert.equal(recovered.prepare(moved.snapshot.targets).snapshot.guidance.find(g => g.kind === 'skill')!.text, selected.body);
      const input = reopened.archive.append(randomUUID(), 'Task completed.');
      reopened.session.transitionIntent(f.intent.eventId, input, { step: 'done', status: 'completed' });
      const completed = recovered.prepare(moved.snapshot.targets);
      assert.equal(completed.snapshot.activations.length, 0);
      assert.equal(completed.snapshot.guidance.some(g => g.kind === 'skill'), false);
      assert.ok(completed.snapshot.cacheEpoch > moved.snapshot.cacheEpoch);
    } finally { reopened.close(); }
  } finally { rmSync(f.sandbox.root, { recursive: true, force: true }); }
});

test('optional empty AGENTS is exact, unreadable guidance is unavailable, and revoked runs cannot execute', () => {
  const f = fixture();
  try {
    const path = join(f.root, 'AGENTS.md');
    writeFileSync(path, '');
    const empty = f.core.prepare([f.target]);
    assert.equal(empty.status, 'ready');
    assert.equal(empty.snapshot.guidance[0]!.text, '');
    rmSync(path); mkdirSync(path);
    const unavailable = f.core.prepare([f.target]);
    assert.equal(unavailable.status, 'unavailable');
    assert.notEqual(unavailable.assemblyId, empty.assemblyId);
    rmSync(path, { recursive: true });
    const ready = f.core.prepare([f.target]);
    let effects = 0;
    const operation = { name: 'synthetic.write' as const, targets: [f.target.path] };
    const allowed = { policy: true, capability: true, credential: true, approval: true };
    const unknown = f.core.execute(ready.assemblyId, operation, allowed, () => { effects++; throw new Error('effect failed after start'); });
    assert.equal(unknown.executionState, 'started');
    assert.equal(unknown.outcome, 'unknown');
    f.probe.store.revokeRequestRun(f.probe.activity, f.core.runId);
    const stopped = f.core.execute(ready.assemblyId, operation, allowed, () => effects++);
    assert.equal(stopped.executionState, 'not_started');
    assert.equal(stopped.reason, 'run-not-admissible');
    assert.equal(effects, 1);
  } finally { f.close(); }
});

test('stale sessions cannot resurrect withdrawn bindings and a step change preserves the cache epoch', () => {
  const f = fixture();
  try {
    skill(join(f.root, '.agents', 'skills'), 'review');
    const ref = f.core.select('review', f.target.projectId).selected;
    f.core.activate(ref, f.target.projectId, 'owner-explicit');
    const first = f.core.prepare([f.target]);
    const stale = new GuidanceSession(f.probe.store, f.probe.activity, f.probe.archive, f.config, f.core.runId);
    const input = f.probe.archive.append(randomUUID(), 'Continue the same task.');
    f.probe.session.transitionIntent(f.intent.eventId, input, { step: 'next', status: 'active' });
    const next = f.core.prepare([f.target]);
    assert.notEqual(next.assemblyId, first.assemblyId);
    assert.equal(next.snapshot.cacheEpoch, first.snapshot.cacheEpoch);
    f.core.deactivate(ref, f.target.projectId);
    f.core.prepare([f.target]);
    assert.throws(() => stale.prepare([f.target]), /guidance-session-stale/);
    assert.equal(f.core.latest()!.snapshot.activations.length, 0);
  } finally { f.close(); }
});

test('Core loads complete AGENTS from actual membership and target ancestry into durable immutable assemblies', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.sandbox.root, 'agent', 'AGENTS.md'), 'Global: preserve evidence.\n');
    writeFileSync(join(f.sandbox.root, 'agent', 'workspaces', f.workspaceId, 'AGENTS.md'), 'Workspace: use UTF-8.\n');
    writeFileSync(join(f.root, 'AGENTS.md'), 'Project: use npm.\n');
    writeFileSync(join(f.root, 'src', 'AGENTS.md'), 'Resource: retain comments.\n');
    writeFileSync(join(f.sandbox.root, 'AGENTS.md'), 'Unregistered parent: MUST NOT LOAD.');
    writeFileSync(join(f.root, 'CLAUDE.md'), 'Unsupported file: MUST NOT LOAD.');
    const prepared = f.core.prepare([f.target]);
    assert.equal(prepared.status, 'ready');
    assert.deepEqual(prepared.snapshot.guidance.map(item => item.text), [
      'Global: preserve evidence.\n', 'Workspace: use UTF-8.\n', 'Project: use npm.\n', 'Resource: retain comments.\n',
    ]);
    for (const item of prepared.snapshot.guidance) {
      assert.equal(item.hash, sha256(readFileSync(item.locator)));
      assert.equal(item.byteLength, Buffer.byteLength(item.text));
    }
    assert.equal(prepared.snapshot.policy.channel, 'protected-policy');
    assert.equal(f.core.inspect(prepared.assemblyId).snapshotHash, prepared.snapshotHash);
    assert.equal(f.core.prepare([f.target]).assemblyId, prepared.assemblyId);
    writeFileSync(join(f.root, 'src', 'AGENTS.md'), 'Resource: updated.\n');
    const changed = f.core.prepare([f.target]);
    assert.notEqual(changed.assemblyId, prepared.assemblyId);
    assert.equal(changed.snapshot.cacheEpoch, prepared.snapshot.cacheEpoch + 1);
    assert.equal(f.core.inspect(prepared.assemblyId).snapshot.guidance[3]!.text, 'Resource: retain comments.\n');
  } finally { f.close(); }
});
