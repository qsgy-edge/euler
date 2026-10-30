import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { PurgePresentation } from '@euler/core';
import { CliArchive } from '../src/archive.ts';
import { createSandbox } from '../src/sandbox.ts';
import { startCli, sendCommand } from '../src/process-driver.ts';

// Seams: the maintenance CLI, archive owner, actual controlled bytes and runtime admission.
for (const scenario of ['separate', 'handoff'])
test(`source cleanup erases only the approved archive entries and durably reports that participant, not global completion (${scenario})`, async () => {
  const sandbox = createSandbox(), children: ReturnType<typeof startCli>[] = [];
  try {
    const seed = spawnSync(process.execPath, ['apps/cli/test/support/purge-worker.ts', sandbox.root, scenario], { encoding: 'utf8' });
    assert.equal(seed.status, 0, seed.stderr);
    const fixture = JSON.parse(seed.stdout.trim().split('\n').at(-1)!);
    const archive = new CliArchive(sandbox, action => action()), before = archive.events();
    const child = startCli(['purge', '--sandbox', sandbox.root, '--record', fixture.recordId]); children.push(child);
    const preview = await child.waitFor('purge-preview') as unknown as PurgePresentation;
    const selected = preview.manifest.carriers.filter(carrier => carrier.role === 'source').flatMap(carrier => carrier.entries.map(entry => entry.id));
    if (scenario === 'handoff') {
      assert.equal(fixture.documents.length, 5);
      for (const document of fixture.documents) assert.ok(selected.includes(document.eventId));
    }
    const committed = await sendCommand(child, preview.phrase, 'purge-result');
    const cleaned = await sendCommand(child, 'cleanup-source', 'purge-source-result');
    assert.equal(cleaned.error, undefined);
    assert.equal(cleaned.operationId, committed.operationId);
    assert.equal(cleaned.cleanup, 'incomplete');
    assert.equal((cleaned.source as { status: string }).status, 'complete');
    for (const carrier of preview.manifest.carriers.filter(carrier => carrier.role === 'source')) {
      const bytes = readFileSync(carrier.file.path, 'utf8');
      for (const entry of carrier.entries) assert.equal(bytes.includes(entry.id), false, entry.id);
    }
    assert.deepEqual(archive.events(), before.filter(entry => !selected.includes(entry.ack.eventId)));
    child.child.stdin.end(); assert.equal((await child.exit).code, 0, child.stderr());
    const resumed = startCli(['purge', '--sandbox', sandbox.root]); children.push(resumed);
    const status = await resumed.waitFor('purge-result');
    assert.deepEqual(status.receipt, committed.receipt);
    assert.equal((status.source as { status: string }).status, 'complete');
    assert.deepEqual(await sendCommand(resumed, 'cleanup-source', 'purge-source-result'), cleaned);
    resumed.child.stdin.end(); await resumed.exit;
    const runtime = startCli(['run', '--sandbox', sandbox.root]); children.push(runtime);
    assert.equal((await runtime.exit).code, 1);
    assert.ok(runtime.observations.some(event => event.reason === 'admission-closed'));
  } finally {
    for (const child of children) {
      if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill();
      await child.exit;
    }
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

for (const point of ['before-delete', 'after-delete', 'after-ack', 'takeover'])
test(`source cleanup resumes the same approved operation after a real process dies at ${point}`, async () => {
  const sandbox = createSandbox(), children: ReturnType<typeof startCli>[] = [];
  const start = (args: string[] = []) => {
    const child = startCli(['purge', '--sandbox', sandbox.root, ...args]); children.push(child); return child;
  };
  try {
    const seed = spawnSync(process.execPath, ['apps/cli/test/support/purge-worker.ts', sandbox.root, 'identity'], { encoding: 'utf8' });
    assert.equal(seed.status, 0, seed.stderr);
    const fixture = JSON.parse(seed.stdout.trim().split('\n').at(-1)!);
    const original = readFileSync(join(sandbox.root, 'session.jsonl'));
    const otherPath = join(sandbox.root, `session-${fixture.unrelatedBinding.sessionId}.jsonl`), other = readFileSync(otherPath);
    let child = start(['--record', fixture.recordId, '--scenario', point === 'takeover' ? 'success' : `source-${point}`]);
    const preview = await child.waitFor('purge-preview') as unknown as PurgePresentation;
    const committed = await sendCommand(child, preview.phrase, 'purge-result');
    if (point === 'takeover') {
      child.child.stdin.end(); await child.exit;
      child = start(['--scenario', 'source-takeover']);
    } else child.command('cleanup-source');
    const checkpoint = await child.waitFor('purge-source-checkpoint');
    assert.equal(checkpoint.stage, point);
    const concurrent = start();
    assert.equal((await concurrent.exit).code, 1);
    assert.ok(concurrent.observations.some(event => event.reason === 'maintenance-owned'));
    child.child.kill('SIGKILL'); await child.exit;
    if (point === 'before-delete' || point === 'takeover') assert.deepEqual(readFileSync(join(sandbox.root, 'session.jsonl')), original);
    else assert.equal(readFileSync(join(sandbox.root, 'session.jsonl'), 'utf8').includes(fixture.target.source.eventId), false);
    const resumed = start();
    const recovered = await resumed.waitFor('purge-result');
    assert.deepEqual(recovered.receipt, committed.receipt);
    const cleaned = await sendCommand(resumed, 'cleanup-source', 'purge-source-result');
    assert.equal(cleaned.error, undefined);
    assert.equal((cleaned.source as { status: string }).status, 'complete');
    assert.equal(cleaned.cleanup, 'incomplete');
    assert.equal(cleaned.operationId, committed.operationId);
    assert.deepEqual(readFileSync(otherPath), other);
    resumed.child.stdin.end(); assert.equal((await resumed.exit).code, 0);
  } finally {
    for (const child of children) {
      if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill();
      await child.exit;
    }
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});
