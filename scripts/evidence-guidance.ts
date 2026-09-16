import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { GuidanceSession, fileIdentity } from '../packages/core/src/index.ts';
import { createSandbox } from '../apps/cli/src/sandbox.ts';
import { openProbe } from '../apps/cli/src/probe.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = join(repo, 'artifacts', `t09-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(destination, { recursive: true });
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const fixture = {
  'agent/AGENTS.md': 'Preserve evidence.\n',
  'project/AGENTS.md': 'Use UTF-8.\n',
  'project/.agents/skills/first/SKILL.md': '---\nname: first\ndescription: First synthetic instruction\n---\nUse npm.\n',
  'project/.agents/skills/second/SKILL.md': '---\nname: second\ndescription: Second synthetic instruction\n---\nUse pnpm.\n',
};
const sandbox = createSandbox();
const probe = openProbe(sandbox);
let closed = false;
try {
  for (const [path, text] of Object.entries(fixture)) {
    mkdirSync(dirname(join(sandbox.root, path)), { recursive: true });
    writeFileSync(join(sandbox.root, path), text);
  }
  probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
  const project = join(sandbox.root, 'project');
  const core = new GuidanceSession(probe.store, probe.activity, probe.archive, {
    dataRoot: { path: sandbox.root, identity: fileIdentity(sandbox.root) },
    projects: [{ projectId: sandbox.fixture.projectId, root: { path: project, identity: fileIdentity(project) } }], sharedSkills: null, sources: [],
  });
  const target = { projectId: sandbox.fixture.projectId, path: join(project, 'result.txt') };
  const operation = { name: 'synthetic.write' as const, targets: [target.path] };
  const permissions = { policy: true, capability: true, credential: true, approval: true };
  const selection = ['first', 'second'].map(name => core.select(name, target.projectId));
  for (const item of selection) core.activate(item.selected, target.projectId, 'owner-explicit');
  core.recognize(selection.map((item, i) => ({ locator: item.selected.entryLocator, hash: item.selected.hash,
    quote: i === 0 ? 'Use npm.' : 'Use pnpm.', operation: operation.name, target: target.path, key: 'package-manager', value: i === 0 ? 'npm' : 'pnpm' })));
  const snapshots = [core.prepare([target])];
  let effects = 0;
  const effect = () => { writeFileSync(target.path, 'synthetic effect'); effects++; };
  const conflict = core.execute(snapshots[0]!.assemblyId, operation, permissions, effect);
  assert.equal(conflict.status, 'skill-conflict'); assert.equal(effects, 0);
  const resolution = probe.archive.append(randomUUID(), `Resolve ${conflict.conflicts[0]!.id}: npm`);
  core.resolve(conflict.conflicts[0]!.id, 'npm', resolution, operation);
  snapshots.push(core.prepare([target]));
  const denied = core.execute(snapshots[1]!.assemblyId, operation, { ...permissions, capability: false }, effect);
  assert.equal(denied.executionState, 'not_started'); assert.equal(effects, 0);
  const completed = core.execute(snapshots[1]!.assemblyId, operation, permissions, effect);
  assert.equal(completed.outcome, 'success'); assert.equal(effects, 1);
  core.deactivate(selection[0]!.selected, target.projectId);
  snapshots.push(core.prepare([target]));
  assert.equal(snapshots[2]!.snapshot.guidance.filter(g => g.kind === 'skill').length, 1);
  assert.equal(core.inspect(snapshots[0]!.assemblyId).snapshotHash, snapshots[0]!.snapshotHash);
  probe.close(); closed = true;
  copyFileSync(join(sandbox.root, 'probe.sqlite'), join(destination, 'probe.sqlite'));
  copyFileSync(join(sandbox.root, 'session.jsonl'), join(destination, 'session.jsonl'));
  copyFileSync(target.path, join(destination, 'effect.txt'));
  writeFileSync(join(destination, 'fixture.json'), JSON.stringify(fixture, null, 2) + '\n');
  writeFileSync(join(destination, 'snapshots.json'), JSON.stringify(snapshots, null, 2) + '\n');
  // Independent byte/hash verification reads raw SQLite and archive rows, rather
  // than trusting Core.inspect or the implementation's digest helper.
  const db = new DatabaseSync(join(destination, 'probe.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA quick_check').get()!.quick_check, 'ok');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    const events = readFileSync(join(destination, 'session.jsonl'), 'utf8').trimEnd().split('\n').slice(1).map(line => ({ line, event: JSON.parse(line) }));
    for (const snapshot of snapshots) {
      const row = db.prepare('SELECT * FROM request_assemblies WHERE assembly_id=?').get(snapshot.assemblyId)!;
      const source = JSON.parse(String(row.sources))[1];
      const archived = events.find(e => e.event.eventId === source.eventId)!;
      assert.equal(digest(archived.line), source.hash);
      assert.equal(digest(archived.event.text), row.payload_hash);
      assert.equal(Buffer.byteLength(archived.event.text), row.byte_length);
      assert.equal(digest(JSON.stringify(snapshot.snapshot)), row.payload_hash);
      for (const block of snapshot.snapshot.guidance) {
        assert.equal(digest(readFileSync(block.locator)), block.hash);
        assert.equal(Buffer.byteLength(block.text), block.byteLength);
      }
    }
  } finally { db.close(); }
  const report = { schema: 't09-guidance-evidence@1', status: 'PASS', scope: 'synthetic Core guidance acceptance; no model or Host pump',
    implementationCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    worktreeStatus: execFileSync('git', ['status', '--short'], { cwd: repo, encoding: 'utf8' }).trim(),
    environment: { node: process.version, platform: process.platform, release: release(), arch: arch() },
    fixtureDigest: digest(JSON.stringify(fixture)), sourceRoot: sandbox.root, runId: core.runId,
    selection, observations: { conflict, denied, completed, effects },
    snapshots: snapshots.map(s => ({ assemblyId: s.assemblyId, snapshotHash: s.snapshotHash, cacheEpoch: s.snapshot.cacheEpoch })),
    rawEvidence: ['probe.sqlite', 'session.jsonl', 'fixture.json', 'snapshots.json', 'effect.txt'],
    evidenceGaps: ['T18 real-model payload and Host integration', 'production filesystem adversarial races and permissions on each target platform'],
  };
  writeFileSync(join(destination, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, destination, fixtureDigest: report.fixtureDigest, effects }));
} finally {
  if (!closed) probe.close();
  rmSync(sandbox.root, { recursive: true, force: true });
}
