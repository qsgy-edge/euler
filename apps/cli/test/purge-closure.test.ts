import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ProbeStore } from '@euler/core';
import type { PurgePresentation } from '@euler/core';
import { bindingOf, createSandbox, resourcesOf } from '../src/sandbox.ts';
import { readPurgeCarriers } from '../src/purge.ts';
import { startCli } from '../src/process-driver.ts';

function setup(scenario: string) {
  const sandbox = createSandbox();
  if (scenario === 'historian') {
    const historian = spawnSync(process.execPath, ['apps/cli/src/main.ts', 'historian', '--sandbox', sandbox.root], { encoding: 'utf8' });
    assert.equal(historian.status, 0, historian.stderr);
  }
  const seed = spawnSync(process.execPath, ['apps/cli/test/support/purge-worker.ts', sandbox.root, scenario], { encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr);
  const fixture = JSON.parse(seed.stdout.trim().split('\n').at(-1)!);
  const store = new ProbeStore(resourcesOf(sandbox), sandbox.storeId, bindingOf(sandbox)), coordinator = randomUUID();
  store.beginMaintenance(coordinator); assert.equal(store.acquireMaintenance(coordinator).acquired, true);
  return { sandbox, fixture, store, coordinator };
}

for (const scenario of ['separate', 'shared', 'operations', 'rollback', 'discovery', 'historian', 'identity', 'bracket-text']) test(`purge closure follows keys, values and cyclic source references without deleting the independent memory (${scenario})`, () => {
  const { sandbox, fixture, store, coordinator } = setup(scenario);
  try {
    const preview = store.previewPurge(coordinator, fixture.recordId, readPurgeCarriers(sandbox, store, coordinator));
    assert.deepEqual(preview.manifest.records.map(record => record.recordId), [fixture.recordId]);
    const sourceIds = preview.manifest.carriers.filter(carrier => carrier.role === 'source').flatMap(carrier => carrier.entries.map(entry => entry.id));
    for (const source of fixture.related) assert.ok(sourceIds.includes(source.eventId));
    assert.equal(sourceIds.includes(fixture.unrelated.eventId), false);
    if (scenario === 'identity') assert.equal(preview.manifest.carriers.some(carrier =>
      carrier.file.path.endsWith(`session-${fixture.unrelatedBinding.sessionId}.jsonl`)), false);
    if (scenario === 'historian') assert.ok(preview.manifest.database.some(item => item.table === 'compartments' && item.count > 0));
    if (scenario === 'discovery') {
      for (const table of ['source_units', 'evolution_proposals', 'source_query_receipts'])
        assert.ok(preview.manifest.database.some(item => item.table === table && item.count > 0), table);
    }
    if (scenario === 'rollback') assert.ok(fixture.receipts.length > 0);
    if (scenario === 'shared') assert.ok(preview.manifest.database.find(item => item.table === 'memory_events')!.rows.some(row => row.action === 'detach-batch'));
    store.acknowledgePurgePresentation(coordinator, preview.token, preview.digest);
    const beforeSource = readFileSync(join(sandbox.root, 'session.jsonl'));
    const result = store.commitPurge(coordinator, store.receivePurgeInput(coordinator, preview.phrase), preview.token,
      readPurgeCarriers(sandbox, store, coordinator));
    assert.equal(result.status, 'logical-commit');
    assert.deepEqual(readFileSync(join(sandbox.root, 'session.jsonl')), beforeSource);
    assert.equal(store.purgeStatus(coordinator)?.cleanup, 'incomplete');
    assert.throws(() => store.releaseMaintenance(coordinator), /purge-cleanup-incomplete|maintenance-not-exclusive/);
  } finally { store.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('a conflict relation expands to both dependent records and presents both before approval', () => {
  const { sandbox, fixture, store, coordinator } = setup('conflict');
  try {
    const carriers = () => readPurgeCarriers(sandbox, store, coordinator);
    const preview = store.previewPurge(coordinator, fixture.recordId, carriers());
    assert.deepEqual(new Set(preview.manifest.records.map(record => record.recordId)), new Set([fixture.recordId, fixture.otherId]));
    for (const table of ['conflict_sets', 'conflict_members']) assert.ok(preview.manifest.database.some(item => item.table === table));
    store.acknowledgePurgePresentation(coordinator, preview.token, preview.digest);
    assert.equal(store.commitPurge(coordinator, store.receivePurgeInput(coordinator, preview.phrase), preview.token, carriers()).status, 'logical-commit');
  } finally { store.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('an approval received before full presentation and a copied input cannot commit', () => {
  const { sandbox, fixture, store, coordinator } = setup('separate');
  try {
    const carriers = () => readPurgeCarriers(sandbox, store, coordinator);
    const preview = store.previewPurge(coordinator, fixture.recordId, carriers());
    const early = store.receivePurgeInput(coordinator, preview.phrase);
    store.acknowledgePurgePresentation(coordinator, preview.token, preview.digest);
    assert.throws(() => store.commitPurge(coordinator, early, preview.token, carriers()), /exact-live/);
    const live = store.receivePurgeInput(coordinator, preview.phrase);
    assert.throws(() => store.commitPurge(coordinator, { ...live }, preview.token, carriers()), /exact-live/);
    assert.equal(store.purgeStatus(coordinator), null);
    assert.equal(store.cancelPurge(coordinator).status, 'cancelled');
  } finally { store.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

for (const kind of ['backup', 'recovery']) test(`a committed purge can be reconciled after restart with its untouched ${kind} retained for cleanup`, { timeout: 20000 }, async () => {
  const sandbox = createSandbox(), children: ReturnType<typeof startCli>[] = [];
  try {
    const seed = spawnSync(process.execPath, ['apps/cli/test/support/purge-worker.ts', sandbox.root], { encoding: 'utf8' });
    assert.equal(seed.status, 0, seed.stderr);
    const fixture = JSON.parse(seed.stdout.trim().split('\n').at(-1)!);
    const backup = startCli(['backup', '--sandbox', sandbox.root]); children.push(backup);
    assert.equal((await backup.exit).code, 0);
    if (kind === 'recovery') {
      const snapshot = backup.observations.find(item => item.event === 'backup-result')!.snapshot as { id: string };
      const recovery = startCli(['restore-snapshot', '--sandbox', sandbox.root, '--snapshot', snapshot.id]); children.push(recovery);
      assert.equal((await recovery.exit).code, 0, JSON.stringify(recovery.observations));
    }
    const purge = startCli(['purge', '--sandbox', sandbox.root, '--record', fixture.recordId]); children.push(purge);
    const preview = await purge.waitFor('purge-preview') as unknown as PurgePresentation;
    assert.equal(preview.manifest.backups.length, kind === 'recovery' ? 2 : 1);
    const files = preview.manifest.backups.flatMap(item => item.files.map(file => ({ path: file.file.path, bytes: readFileSync(file.file.path) })));
    purge.command(preview.phrase);
    const result = await purge.waitFor('purge-result');
    purge.child.stdin.end(); await purge.exit;
    const resumed = startCli(['purge', '--sandbox', sandbox.root]); children.push(resumed);
    assert.deepEqual((await resumed.waitFor('purge-result')).receipt, result.receipt);
    for (const file of files) assert.deepEqual(readFileSync(file.path), file.bytes);
    resumed.child.stdin.end(); await resumed.exit;
  } finally {
    for (const child of children) {
      if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill();
      await child.exit;
    }
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test('a database deletion postcondition failure rolls back the whole logical commit without external deletion', () => {
  const { sandbox, fixture, store, coordinator } = setup('operations');
  const db = new DatabaseSync(join(sandbox.root, 'probe.sqlite'));
  try {
    db.exec("CREATE TRIGGER purge_test_ignore BEFORE DELETE ON memory_records BEGIN SELECT RAISE(IGNORE); END");
    const carriers = () => readPurgeCarriers(sandbox, store, coordinator);
    const preview = store.previewPurge(coordinator, fixture.recordId, carriers());
    store.acknowledgePurgePresentation(coordinator, preview.token, preview.digest);
    const before = carriers().map(carrier => ({ path: carrier.file.path, bytes: readFileSync(carrier.file.path) }));
    assert.throws(() => store.commitPurge(coordinator, store.receivePurgeInput(coordinator, preview.phrase), preview.token, carriers()),
      /purge-database-postcondition-failed/);
    assert.equal(store.purgeStatus(coordinator), null);
    for (const file of before) assert.deepEqual(readFileSync(file.path), file.bytes);
    assert.throws(() => store.commitPurge(coordinator, store.receivePurgeInput(coordinator, preview.phrase), preview.token, carriers()), /exact-live/);
    const again = store.previewPurge(coordinator, fixture.recordId, carriers());
    assert.equal(again.digest, preview.digest);
    assert.notEqual(again.token, preview.token);
    store.cancelPurge(coordinator);
  } finally { db.close(); store.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

for (const schema of ['table', 'column']) test(`an unregistered controlled ${schema} stops logical purge before mutation`, () => {
  const { sandbox, fixture, store, coordinator } = setup('separate');
  const db = new DatabaseSync(join(sandbox.root, 'probe.sqlite'));
  try {
    const carriers = () => readPurgeCarriers(sandbox, store, coordinator);
    const preview = store.previewPurge(coordinator, fixture.recordId, carriers());
    store.acknowledgePurgePresentation(coordinator, preview.token, preview.digest);
    db.exec(schema === 'table' ? 'CREATE TABLE extra_copy(ref TEXT)' : 'ALTER TABLE search_documents ADD COLUMN extra_ref TEXT');
    assert.throws(() => store.commitPurge(coordinator, store.receivePurgeInput(coordinator, preview.phrase), preview.token, carriers()), /purge-unregistered-database/);
    assert.equal(store.purgeStatus(coordinator), null);
    store.cancelPurge(coordinator);
  } finally { db.close(); store.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('a normal runtime explains the independent maintenance entry without opening a purge preview', { timeout: 10000 }, async () => {
  const sandbox = createSandbox(), cli = startCli(['remember', '--sandbox', sandbox.root]);
  try {
    await cli.waitFor('remember-ready');
    cli.command(`purge ${randomUUID()}`);
    const result = await cli.waitFor('purge-maintenance-required');
    assert.ok(Array.isArray(result.command));
    assert.equal(cli.observations.some(item => item.event === 'purge-preview'), false);
    cli.command('stop'); assert.equal((await cli.exit).code, 0);
  } finally {
    if (cli.child.exitCode === null && cli.child.signalCode === null) cli.child.kill();
    await cli.exit;
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});
