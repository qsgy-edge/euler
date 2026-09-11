import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { createSandbox } from '../src/sandbox.ts';
import { startCli } from '../src/process-driver.ts';

test('a live process that closed its probe remains a maintenance blocker', { timeout: 15000 }, async () => {
  const sandbox = createSandbox();
  const runtime = startCli(['hold', '--sandbox', sandbox.root]);
  let maintenance: ReturnType<typeof startCli> | undefined;
  try {
    await runtime.waitFor('runtime-ready');
    maintenance = startCli(['maintain', '--sandbox', sandbox.root]);
    runtime.command('close');
    await runtime.waitFor('probe-closed');
    const blocked = await maintenance!.waitFor('maintenance-blocked');
    assert.equal(blocked.acquired, false);
    assert.ok((blocked.observations as { absent: boolean }[]).some(item => !item.absent));
    runtime.command('stop');
    await runtime.waitFor('controlled-task-exit');
    await runtime.exit;
    maintenance!.command('acquire');
    const acquired = await maintenance!.waitFor('maintenance-exclusive');
    assert.equal(acquired.acquired, true);
    maintenance!.command('release');
    await maintenance!.waitFor('maintenance-released');
  } finally {
    if (runtime.child.exitCode === null && runtime.child.signalCode === null) runtime.command('stop');
    if (maintenance && maintenance.child.exitCode === null && maintenance.child.signalCode === null) maintenance.child.stdin.end();
    await Promise.allSettled([runtime.exit, maintenance?.exit ?? Promise.resolve()]);
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test('maintenance excludes live runtime and controlled task, then reopens after observed exits', { timeout: 30000 }, async () => {
  const sandbox = createSandbox();
  const children: ReturnType<typeof startCli>[] = [];
  const start = (args: string[]) => { const child = startCli([...args, '--sandbox', sandbox.root]); children.push(child); return child; };
  try {
    const runtime = start(['hold']);
    const ready = await runtime.waitFor('runtime-ready');
    assert.equal(typeof ready.childPid, 'number');
    const maintenance = start(['maintain']);
    const blocked = await maintenance.waitFor('maintenance-blocked');
    assert.equal((blocked.observations as { absent: boolean }[]).some(item => !item.absent), true);
    const refused = start(['run']);
    assert.equal((await refused.exit).code, 1);
    assert.match(JSON.stringify(refused.observations), /admission-closed/);
    runtime.command('append');
    await runtime.waitFor('late-append-blocked');
    runtime.command('stop');
    const taskExit = await runtime.waitFor('controlled-task-exit');
    assert.equal(taskExit.code, 0);
    assert.equal((await runtime.exit).code, 0);
    maintenance.command('acquire');
    const exclusive = await maintenance.waitFor('maintenance-exclusive');
    assert.equal((exclusive.observations as { absent: boolean }[]).every(item => item.absent), true);
    const competitor = start(['maintain']);
    assert.equal((await competitor.exit).code, 1);
    assert.match(JSON.stringify(competitor.observations), /maintenance-owned/);
    maintenance.command('release');
    const reopened = await maintenance.waitFor('maintenance-released');
    assert.ok(Number(reopened.epoch) > Number(ready.epoch));
    assert.equal((await maintenance.exit).code, 0);
    const resumed = start(['run']);
    assert.equal((await resumed.exit).code, 0);
    const result = resumed.observations.find(item => item.event === 'run-result')!;
    assert.equal(result.sends, 1);
    assert.equal(result.eventCount, 1);
    const owner = start(['maintain']);
    await owner.waitFor('maintenance-exclusive');
    owner.child.kill();
    const ownerExit = await owner.exit;
    assert.notEqual(ownerExit.code, 0);
    const takeover = start(['maintain']);
    await takeover.waitFor('maintenance-exclusive');
    takeover.command('release');
    assert.equal((await takeover.exit).code, 0);
  } finally {
    for (const proc of children) {
      if (proc.child.exitCode === null && proc.child.signalCode === null) proc.child.kill();
      await proc.exit;
    }
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});
