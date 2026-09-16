import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { createSandbox, resourcesOf, bindingOf } from '../src/sandbox.ts';
import { randomUUID } from 'node:crypto';
import { ProbeStore } from '@euler/core';
import { startCli } from '../src/process-driver.ts';

test('stop evidence and maintenance stream survive coordinator restart and release', { timeout: 15000 }, async () => {
  const sandbox = createSandbox();
  const runtime = startCli(['task', '--sandbox', sandbox.root]);
  let store = new ProbeStore(resourcesOf(sandbox), sandbox.storeId, bindingOf(sandbox));
  try {
    const ready = await runtime.waitFor('task-ready');
    const coordinator = randomUUID();
    store.beginMaintenance(coordinator);
    const blocked = store.acquireMaintenance(coordinator);
    assert.equal(blocked.acquired, false);
    assert.equal(store.maintenanceStatus().activities[0]?.stop?.state, 'alive');
    runtime.command('stop');
    assert.equal((await runtime.exit).code, 0);
    assert.equal(store.acquireMaintenance(coordinator).acquired, true);
    const status = store.maintenanceStatus();
    assert.equal(status.activities[0]?.stop?.state, 'absent');
    assert.equal(status.activities[0]?.incarnation, ready.incarnation);
    assert.equal(status.coordinatorStream?.ownerKind, 'maintenance');
    store.close();
    store = new ProbeStore(resourcesOf(sandbox), sandbox.storeId, bindingOf(sandbox));
    assert.deepEqual(store.maintenanceStatus(), status);
    store.releaseMaintenance(coordinator);
    assert.deepEqual(store.maintenanceStatus().activities, status.activities);
  } finally {
    if (runtime.child.exitCode === null && runtime.child.signalCode === null) runtime.child.kill();
    await runtime.exit;
    store.close();
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test('maintenance enumerates residuals and rechecks exclusive release without deleting unknown files', () => {
  const sandbox = createSandbox();
  let store = new ProbeStore(resourcesOf(sandbox), sandbox.storeId, bindingOf(sandbox));
  const residual = join(sandbox.root, 'unregistered-worker.lock');
  try {
    const coordinator = randomUUID();
    store.beginMaintenance(coordinator);
    assert.equal(store.acquireMaintenance(coordinator).acquired, true);
    writeFileSync(residual, 'synthetic unexplained residual');
    assert.throws(() => store.releaseMaintenance(coordinator), /maintenance-residuals-or-participants/);
    const status = store.maintenanceStatus();
    assert.equal(status.fence.state, 'closing');
    assert.ok(status.residuals.some(item => item.path === 'unregistered-worker.lock' && item.state === 'unexpected'));
    store.close();
    store = new ProbeStore(resourcesOf(sandbox), sandbox.storeId, bindingOf(sandbox));
    assert.deepEqual(store.maintenanceStatus().residuals, status.residuals);
    assert.equal(store.acquireMaintenance(coordinator).acquired, false);
    rmSync(residual);
    assert.equal(store.acquireMaintenance(coordinator).acquired, true);
    assert.equal(store.releaseMaintenance(coordinator).state, 'open');
  } finally { store.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

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

test('CLI cancellation opens a fresh epoch while the old runtime stays fenced', { timeout: 15000 }, async () => {
  const sandbox = createSandbox();
  const runtime = startCli(['hold', '--sandbox', sandbox.root]);
  const children = [runtime];
  try {
    const ready = await runtime.waitFor('runtime-ready');
    const maintenance = startCli(['maintain', '--sandbox', sandbox.root]); children.push(maintenance);
    await maintenance.waitFor('maintenance-blocked');
    maintenance.command('inspect');
    const status = await maintenance.waitFor('maintenance-status');
    assert.equal((status.activities as { parentId: string | null }[]).filter(row => row.parentId !== null).length, 1);
    maintenance.command('cancel');
    const cancelled = await maintenance.waitFor('maintenance-cancelled');
    assert.ok(Number(cancelled.epoch) > Number(ready.epoch));
    assert.equal((await maintenance.exit).code, 0);
    runtime.command('append');
    assert.equal((await runtime.waitFor('late-append-blocked')).reason, 'admission-closed');
    const fresh = startCli(['run', '--sandbox', sandbox.root]); children.push(fresh);
    assert.equal((await fresh.exit).code, 0);
    assert.equal(fresh.observations.find(item => item.event === 'run-result')?.sends, 1);
    runtime.command('stop');
    assert.equal((await runtime.exit).code, 0);
  } finally {
    for (const child of children) {
      if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill();
      await child.exit;
    }
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test('racing startup and closing never leave an admitted unregistered process', { timeout: 20000 }, async () => {
  for (let round = 0; round < 3; round++) {
    const sandbox = createSandbox();
    const worker = startCli(['task', '--sandbox', sandbox.root]);
    const maintenance = startCli(['maintain', '--sandbox', sandbox.root]);
    try {
      await maintenance.waitFor('maintenance-closing');
      maintenance.command('inspect');
      const status = await maintenance.waitFor('maintenance-status');
      const rows = (status.activities as { pid: number | null; incarnation: string | null; epoch: number; owner: { ownerKind: string } }[])
        .filter(row => row.owner.ownerKind !== 'maintenance');
      if (rows.length) {
        assert.equal(rows[0]?.pid, worker.child.pid);
        assert.equal(typeof rows[0]?.incarnation, 'string');
        assert.ok(rows[0]!.epoch < Number((status.fence as { epoch: number }).epoch));
      }
      let stopDelivery: Promise<Error | null> = Promise.resolve(null);
      if (worker.child.exitCode === null && worker.child.signalCode === null) {
        // Admission refusal can close stdin before the exit notification.
        // Observe the stream error and verify that same write's callback below.
        worker.child.stdin.once('error', () => {});
        stopDelivery = new Promise(resolve => worker.child.stdin.write('stop\n', error => resolve(error ?? null)));
      }
      const result = await worker.exit;
      const stopError = await stopDelivery;
      if (stopError) {
        assert.equal((stopError as NodeJS.ErrnoException).code, 'EPIPE');
        assert.equal(result.code, 1);
        assert.match(JSON.stringify(worker.observations), /admission-closed/);
      }
      assert.ok(result.code === 0 || result.code === 1);
      if (result.code === 0) assert.equal(rows.length, 1);
      else assert.match(JSON.stringify(worker.observations), /admission-closed/);
      maintenance.command('acquire');
      await maintenance.waitFor('maintenance-exclusive');
      maintenance.command('release');
      assert.equal((await maintenance.exit).code, 0);
    } finally {
      for (const child of [worker, maintenance]) {
        if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill();
        await child.exit;
      }
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  }
});

test('a child refused after reservation exits with its parent and maintenance can resume', { timeout: 15000 }, async () => {
  const sandbox = createSandbox();
  const store = new ProbeStore(resourcesOf(sandbox), sandbox.storeId, bindingOf(sandbox));
  const runtime = startCli(['hold', '--sandbox', sandbox.root, '--wait-child-launch'], 4000);
  let resumed: ReturnType<typeof startCli> | undefined;
  try {
    const reserved = await runtime.waitFor('child-reserved');
    const reservation = store.maintenanceStatus().activities.find(row => row.id === reserved.reservationId)!;
    assert.ok(reservation, 'controlled launch reservation is durable before acknowledgement');
    assert.equal(reservation.pid, null);
    assert.equal(reservation.launchPid, null);
    assert.equal(reservation.incarnation, null);
    const coordinator = randomUUID();
    store.beginMaintenance(coordinator);
    runtime.command('launch');
    const childExit = await runtime.waitFor('controlled-task-exit');
    assert.equal(childExit.code, 1);
    const parentExit = await runtime.waitFor('process-exit');
    assert.equal(parentExit.code, 1);
    const acquired = store.acquireMaintenance(coordinator);
    assert.equal(acquired.acquired, true);
    assert.ok(acquired.observations.some(row => row.id === reservation.id && row.absent));
    assert.equal(store.releaseMaintenance(coordinator).state, 'open');
    resumed = startCli(['run', '--sandbox', sandbox.root]);
    assert.equal((await resumed.exit).code, 0);
    assert.equal(resumed.observations.find(row => row.event === 'run-result')?.sends, 1);
  } finally {
    for (const child of [runtime, resumed]) {
      if (!child) continue;
      if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill();
      await child.exit;
    }
    store.close(); rmSync(sandbox.root, { recursive: true, force: true });
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
    owner.command('inspect');
    const beforeTakeover = await owner.waitFor('maintenance-status');
    owner.child.kill();
    const ownerExit = await owner.exit;
    assert.notEqual(ownerExit.code, 0);
    const takeover = start(['maintain']);
    await takeover.waitFor('maintenance-exclusive');
    takeover.command('inspect');
    const afterTakeover = await takeover.waitFor('maintenance-status');
    assert.deepEqual(afterTakeover.coordinatorStream, beforeTakeover.coordinatorStream);
    const oldCoordinator = (afterTakeover.activities as { pid: number; owner: { ownerKind: string }; stop: { state: string } | null }[])
      .find(item => item.pid === owner.child.pid && item.owner.ownerKind === 'maintenance');
    assert.equal(oldCoordinator?.stop?.state, 'absent');
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
