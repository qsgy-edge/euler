import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import test from 'node:test';
import type { PurgePresentation } from '@euler/core';
import { createSandbox } from '../src/sandbox.ts';
import { startCli, sendCommand } from '../src/process-driver.ts';

for (const { crash, related, discard } of [
  { crash: false, related: true, discard: false }, { crash: true, related: true, discard: false },
  { crash: false, related: true, discard: true }, { crash: false, related: false, discard: false },
])
test(`source cleanup retains post-snapshot archive ownership after restore, crash=${crash}, related=${related}, discard=${discard}`, async () => {
  const sandbox = createSandbox(), children: ReturnType<typeof startCli>[] = [];
  const run = (args: string[]) => {
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout.trim().split('\n').map(line => JSON.parse(line));
  };
  try {
    const fixture = run(['apps/cli/test/support/purge-worker.ts', sandbox.root]).at(-1)!;
    const snapshot = run(['apps/cli/src/main.ts', 'backup', '--sandbox', sandbox.root]).find(item => item.event === 'backup-result').snapshot;
    const later = run(['apps/cli/test/support/purge-recovered-source-worker.ts', sandbox.root, JSON.stringify(related ? fixture.target.source : fixture.unrelated)]).at(-1)!;
    const original = readFileSync(later.source.path);
    const restored = run(['apps/cli/src/main.ts', 'restore-snapshot', '--sandbox', sandbox.root, '--snapshot', snapshot.id])
      .find(item => item.event === 'snapshot-restored');
    if (discard) run(['apps/cli/test/support/backup-worker.ts', sandbox.root, 'discard-recovery', restored.receipt.operationId]);
    assert.deepEqual(readFileSync(later.source.path), original);
    let purge = startCli(['purge', '--sandbox', sandbox.root, '--record', fixture.recordId,
      '--scenario', crash ? 'source-after-delete' : 'success']); children.push(purge);
    const preview = await purge.waitFor('purge-preview') as unknown as PurgePresentation;
    assert.ok(preview.manifest.inventory.carriers.some(carrier => carrier.file.path === later.source.path), 'later original archive must be in approved inventory');
    assert.equal(preview.manifest.carriers.some(carrier => carrier.file.path === later.source.path
      && carrier.entries.some(entry => entry.id === later.related.eventId)), related, 'only related later copies are selected before logical commit');
    const committed = await sendCommand(purge, preview.phrase, 'purge-result');
    if (crash) {
      purge.command('cleanup-source'); await purge.waitFor('purge-source-checkpoint');
      purge.child.kill('SIGKILL'); await purge.exit;
      purge = startCli(['purge', '--sandbox', sandbox.root]); children.push(purge);
      assert.deepEqual((await purge.waitFor('purge-result')).receipt, committed.receipt);
    }
    const cleaned = await sendCommand(purge, 'cleanup-source', 'purge-source-result');
    assert.equal(cleaned.error, undefined);
    assert.equal((cleaned.source as { status: string }).status, 'complete');
    assert.equal(cleaned.cleanup, 'incomplete');
    const actual = readFileSync(later.source.path, 'utf8');
    assert.equal(actual.includes(later.related.eventId), !related);
    assert.equal(actual.includes(later.unrelated.eventId), true);
    assert.deepEqual(actual.split('\n').filter(line => line.includes(later.unrelated.eventId)),
      original.toString('utf8').split('\n').filter(line => line.includes(later.unrelated.eventId)));
    purge.child.stdin.end(); assert.equal((await purge.exit).code, 0);
    const reopened = startCli(['purge', '--sandbox', sandbox.root]); children.push(reopened);
    assert.equal(((await reopened.waitFor('purge-result')).source as { status: string }).status, 'complete');
    reopened.child.stdin.end(); await reopened.exit;
  } finally {
    for (const child of children) {
      if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill();
      await child.exit;
    }
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});
