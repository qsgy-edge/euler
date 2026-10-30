import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { createSandbox } from '../src/sandbox.ts';
import { startCli, sendCommand } from '../src/process-driver.ts';

for (const consumer of ['memory', 'historian'])
test(`a closing fence blocks late ${consumer} writes and dispatch before source cleanup can take over`, async () => {
  const sandbox = createSandbox(), children: ReturnType<typeof startCli>[] = [];
  try {
    const seed = spawnSync(process.execPath, ['apps/cli/test/support/purge-worker.ts', sandbox.root], { encoding: 'utf8' });
    assert.equal(seed.status, 0, seed.stderr);
    const fixture = JSON.parse(seed.stdout.trim().split('\n').at(-1)!);
    const late = spawnSync(process.execPath, ['apps/cli/test/support/purge-source-late-worker.ts', sandbox.root, consumer], { encoding: 'utf8' });
    assert.equal(late.status, 0, late.stderr);
    const observation = JSON.parse(late.stdout.trim().split('\n').at(-1)!);
    assert.equal(observation.event, 'late-source-blocked');
    assert.deepEqual(observation.observations.map((item: { action: string }) => item.action), ['append', 'dispatch', 'finish']);
    const purge = startCli(['purge', '--sandbox', sandbox.root, '--record', fixture.recordId]); children.push(purge);
    const preview = await purge.waitFor('purge-preview');
    await sendCommand(purge, String(preview.phrase), 'purge-result');
    const result = await sendCommand(purge, 'cleanup-source', 'purge-source-result');
    assert.equal(result.error, undefined);
    assert.equal((result.source as { status: string }).status, 'complete');
    assert.doesNotMatch(readFileSync(join(sandbox.root, 'session.jsonl'), 'utf8'), /T22a forbidden late/);
    purge.child.stdin.end(); await purge.exit;
    for (const command of ['run', 'capture', 'historian']) {
      const blocked = startCli([command, '--sandbox', sandbox.root, ...(command === 'capture' ? ['--scenario', 'synthetic'] : [])]); children.push(blocked);
      assert.equal((await blocked.exit).code, 1);
      assert.ok(blocked.observations.some(event => event.reason === 'admission-closed'), JSON.stringify({ command, observations: blocked.observations }));
    }
  } finally {
    for (const child of children) {
      if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill();
      await child.exit;
    }
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});
