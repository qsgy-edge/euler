import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { createSandbox } from '../src/sandbox.ts';
import { startCli } from '../src/process-driver.ts';

// Seams: the public maintenance CLI and the normal runtime admission boundary.
test('purge presents the actual deletion closure only after the old runtime exits', { timeout: 20000 }, async () => {
  const sandbox = createSandbox();
  const seed = startCli(['memory', '--sandbox', sandbox.root]);
  const children = [seed];
  try {
    assert.equal((await seed.exit).code, 0);
    const result = seed.observations.find(item => item.event === 'memory-result')!;
    const recordId = (result.activated as { record: { recordId: string } }).record.recordId;
    const runtime = startCli(['task', '--sandbox', sandbox.root]); children.push(runtime);
    await runtime.waitFor('task-ready');
    const purge = startCli(['purge', '--sandbox', sandbox.root, '--record', recordId]); children.push(purge);
    await purge.waitFor('maintenance-blocked');
    assert.equal(purge.observations.some(item => item.event === 'purge-preview'), false);
    runtime.command('stop');
    assert.equal((await runtime.exit).code, 0);
    purge.command('acquire');
    const preview = await purge.waitFor('purge-preview');
    const manifest = preview.manifest as { records: { recordId: string }[]; database: { table: string; count: number }[]; carriers: { role: string }[] };
    assert.ok(manifest.records.some(record => record.recordId === recordId));
    for (const table of ['memory_records', 'memory_revisions', 'memory_events', 'evolution_proposals', 'projection_jobs'])
      assert.ok(manifest.database.some(item => item.table === table && item.count > 0), table);
    assert.ok(manifest.carriers.some(item => item.role === 'source'));
    assert.equal(typeof preview.phrase, 'string');
    assert.equal(preview.cleanup, 'not-started');
    purge.command('cancel');
    await purge.waitFor('purge-cancelled');
    assert.equal((await purge.exit).code, 0);
    const fresh = startCli(['run', '--sandbox', sandbox.root]); children.push(fresh);
    assert.equal((await fresh.exit).code, 0);
  } finally {
    for (const child of children) {
      if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill();
      await child.exit;
    }
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test('live exact approval commits once and keeps runtime closed while physical cleanup is incomplete', { timeout: 20000 }, async () => {
  const sandbox = createSandbox();
  const seed = startCli(['memory', '--sandbox', sandbox.root]);
  const children = [seed];
  try {
    assert.equal((await seed.exit).code, 0);
    const result = seed.observations.find(item => item.event === 'memory-result')!;
    const recordId = (result.activated as { record: { recordId: string } }).record.recordId;
    const purge = startCli(['purge', '--sandbox', sandbox.root, '--record', recordId]); children.push(purge);
    const preview = await purge.waitFor('purge-preview');
    purge.command('同意');
    assert.equal((await purge.waitFor('purge-rejected')).reason, 'exact-live-purge-phrase-required');
    purge.command(String(preview.phrase));
    const committed = await purge.waitFor('purge-result');
    assert.equal(committed.status, 'logical-commit');
    assert.equal(committed.cleanup, 'incomplete');
    assert.equal((committed.receipt as { operationId: string }).operationId, committed.operationId);
    purge.command('cancel');
    const settled = await purge.waitFor('purge-settled');
    assert.equal(settled.operationId, committed.operationId);
    assert.equal(settled.cleanup, 'incomplete');
    purge.child.stdin.end(); await purge.exit;
    const blocked = startCli(['run', '--sandbox', sandbox.root]); children.push(blocked);
    assert.equal((await blocked.exit).code, 1);
    assert.ok(blocked.observations.some(item => item.reason === 'admission-closed'));
    const resumed = startCli(['purge', '--sandbox', sandbox.root]); children.push(resumed);
    const recovered = await resumed.waitFor('purge-result');
    assert.deepEqual(recovered.receipt, committed.receipt);
    assert.equal(recovered.operationId, committed.operationId);
    assert.equal(recovered.cleanup, 'incomplete');
    resumed.child.stdin.end(); await resumed.exit;
  } finally {
    for (const child of children) {
      if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill();
      await child.exit;
    }
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});
