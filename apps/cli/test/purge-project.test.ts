import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openMaintenanceStore } from '../src/backup.ts';
import { readPurgeCarriers } from '../src/purge.ts';
import { createSandbox } from '../src/sandbox.ts';
import { WindowsFileRoot } from '../src/windows-files.ts';

function setup(writers = 1, decision = 'approved') {
  const sandbox = createSandbox(), root = realpathSync.native(mkdtempSync(join(tmpdir(), 'euler-purge-output-')));
  const worker = (file: string, args: string[]) => {
    const child = spawnSync(process.execPath, [file, sandbox.root, ...args], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout.trim().split('\n').at(-1)!);
  };
  for (let i = 0; i < writers; i++) worker('apps/cli/test/support/backup-file-worker.ts', [root, decision]);
  const fixture = worker('apps/cli/test/support/purge-worker.ts', ['project-output']);
  const store = openMaintenanceStore(sandbox), coordinator = randomUUID();
  store.beginMaintenance(coordinator); assert.equal(store.acquireMaintenance(coordinator).acquired, true);
  const carriers = readPurgeCarriers(sandbox, store, coordinator);
  const preview = store.previewPurge(coordinator, fixture.recordId, carriers);
  store.acknowledgePurgePresentation(coordinator, preview.token, preview.digest);
  const commit = () => store.commitPurge(coordinator, store.receivePurgeInput(coordinator, preview.phrase), preview.token, carriers);
  return { sandbox, root, store, coordinator, carriers, preview, commit,
    close: () => { store.close(); rmSync(sandbox.root, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); } };
}

test('the approved project file retains every writer dependency, then its resource owner removes the actual file', {
  skip: process.platform !== 'win32',
}, () => {
  const f = setup(2);
  try {
    const selected = f.preview.manifest.carriers.find(carrier => carrier.role === 'project-output')!;
    assert.ok(selected);
    assert.equal(selected.entries.length, 2);
    assert.equal(readFileSync(selected.file.path, 'utf8'), 'EULER-T20 controlled project output');
    f.commit();
    const owner = (selection: typeof selected) => {
      const root = new WindowsFileRoot(selection.output!.root);
      try { return root.purge(selection); } finally { root.close(); }
    };
    assert.equal(f.store.cleanupPurgeOutputs(f.coordinator, owner).output.status, 'complete');
    assert.equal(existsSync(selected.file.path), false);
    assert.equal(f.store.cleanupPurgeOutputs(f.coordinator, owner).output.status, 'complete');
    assert.equal(f.store.fence().state, 'cleaning');
  } finally { f.close(); }
});

for (const fault of ['identity', 'readonly']) test(`project deletion rejects ${fault} changes and resumes on the approved identity`, {
  skip: process.platform !== 'win32',
}, () => {
  const f = setup(), saved = f.root + '-saved';
  const selected = f.preview.manifest.carriers.find(carrier => carrier.role === 'project-output')!;
  const path = selected.file.path, before = readFileSync(path);
  const owner = (selection: typeof selected) => {
    const root = new WindowsFileRoot(selection.output!.root);
    try { return root.purge(selection); } finally { root.close(); }
  };
  try {
    f.commit();
    if (fault === 'identity') { renameSync(path, saved); writeFileSync(path, before); }
    else chmodSync(path, 0o444);
    assert.throws(() => f.store.cleanupPurgeOutputs(f.coordinator, owner), /maintenance-residuals-or-participants|file-open-denied|purge-project-delete-denied/);
    assert.deepEqual(readFileSync(path), before);
    assert.equal(f.store.purgeStatus(f.coordinator)!.cleanup, 'incomplete');
    if (fault === 'identity') { rmSync(path); renameSync(saved, path); }
    else chmodSync(path, 0o600);
    assert.equal(f.store.cleanupPurgeOutputs(f.coordinator, owner).output.status, 'complete');
    assert.equal(existsSync(path), false);
  } finally {
    if (existsSync(path)) chmodSync(path, 0o600);
    f.close(); rmSync(saved, { force: true });
  }
});

test('a rejected file write still contributes its archived presentation to the approved source closure', {
  skip: process.platform !== 'win32',
}, () => {
  const f = setup(1, 'rejected');
  try {
    assert.equal(existsSync(join(f.root, 'result.md')), false);
    const presentations = f.carriers.filter(carrier => carrier.role === 'source').flatMap(carrier => carrier.entries)
      .filter(entry => entry.content?.startsWith('{"kind":"file-presentation"'));
    assert.equal(presentations.length, 1);
    const selected = f.preview.manifest.carriers.filter(carrier => carrier.role === 'source').flatMap(carrier => carrier.entries);
    for (const presentation of presentations) assert.ok(selected.some(entry => entry.id === presentation.id));
  } finally { f.close(); }
});
