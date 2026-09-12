import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { createSandbox, resourcesOf, bindingOf } from '../src/sandbox.ts';
import { ProbeStore } from '@euler/core';
import { openProbe } from '../src/probe.ts';
import { startCli } from '../src/process-driver.ts';

// Existing public Core/Store seam: durable ownership survives connection restart.
test('session stream and attempted local dispatch retain one durable owner after restart', () => {
  const sandbox = createSandbox();
  let probe = openProbe(sandbox);
  try {
    const stream = probe.store.readStream(probe.activity, probe.activity.streamId);
    assert.equal(stream.ownerKind, 'session');
    assert.equal(stream.ownerId, sandbox.fixture.sessionId);
    assert.equal(stream.projectId, sandbox.fixture.projectId);
    assert.equal(stream.authorization.kind, 'synthetic-host-command');
    const receipt = probe.session.dispatch(probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text));
    assert.equal(receipt.streamId, stream.streamId);
    assert.equal(probe.store.readAttempt(probe.activity, receipt.attemptId)?.streamId, stream.streamId);
    probe.close();
    probe = openProbe(sandbox);
    assert.deepEqual(probe.store.readStream(probe.activity, stream.streamId), stream);
    assert.equal(probe.store.readAttempt(probe.activity, receipt.attemptId)?.ownerId, sandbox.fixture.sessionId);
    assert.equal(probe.transport.count, 0);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('job and migration dispatch receipts name the same owner as their durable attempts', () => {
  for (const kind of ['job', 'migration'] as const) {
    const sandbox = createSandbox();
    const id = randomUUID();
    const probe = openProbe(sandbox, undefined, { kind, id, authorizationId: id });
    try {
      const receipt = probe.session.dispatch(probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text));
      const durable = probe.store.readAttempt(probe.activity, receipt.attemptId)!;
      assert.equal(probe.transport.count, 1);
      assert.equal(receipt.ownerKind, kind);
      assert.equal(receipt.ownerId, id);
      assert.equal(receipt.ownerKind, durable.ownerKind);
      assert.equal(receipt.ownerId, durable.ownerId);
      assert.equal(receipt.streamId, durable.streamId);
    } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
  }
});

test('job and migration owners keep authorization and attempt ownership across restart', () => {
  const sandbox = createSandbox();
  let store = new ProbeStore(resourcesOf(sandbox), sandbox.storeId, bindingOf(sandbox));
  try {
    const job = { kind: 'job' as const, id: randomUUID(), authorizationId: randomUUID() };
    const activity = store.register(job);
    const runId = randomUUID();
    const attempt = store.bindAttempt(activity, runId);
    const migration = store.register({ kind: 'migration', id: randomUUID(), authorizationId: randomUUID() });
    assert.throws(() => store.bindAttempt(migration, runId), /run-owner-conflict/);
    assert.throws(() => store.bindAttempt({ ...activity, streamId: migration.streamId }, randomUUID()), /admission-closed/);
    assert.throws(() => store.register({ ...job, authorizationId: randomUUID() }), /stream-authorization-conflict/);
    assert.throws(() => store.register({ kind: 'session', id: randomUUID(), authorizationId: randomUUID() }), /invalid-stream-owner/);
    assert.throws(() => store.register({ ...job, projectId: randomUUID() } as typeof job), /invalid-stream-owner/);
    const migrationAttempt = store.bindAttempt(migration, randomUUID());
    assert.equal(migrationAttempt.ownerKind, 'migration');
    store.close();
    store = new ProbeStore(resourcesOf(sandbox), sandbox.storeId, bindingOf(sandbox));
    const resumed = store.register(job);
    assert.equal(resumed.streamId, activity.streamId);
    assert.deepEqual(store.readAttempt(resumed, attempt.attemptId), attempt);
    assert.equal(store.readAttempt(resumed, migrationAttempt.attemptId)?.ownerKind, 'migration');
  } finally { store.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('a reserved child remains an unknown controlled participant when launch acknowledgement is missing', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const child = probe.store.reserveChild(probe.activity);
    const coordinator = randomUUID();
    probe.store.beginMaintenance(coordinator);
    const result = probe.store.acquireMaintenance(coordinator);
    assert.equal(result.acquired, false);
    const state = probe.store.maintenanceStatus().activities.find(item => item.id === child);
    assert.equal(state?.parentId, probe.activity.id);
    assert.equal(state?.owner.ownerKind, 'job');
    assert.equal(state?.stop?.state, 'unknown');
    assert.equal(state?.pid, null);
    assert.throws(() => probe.store.releaseMaintenance(coordinator), /maintenance-not-exclusive/);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('a real child acknowledges its pre-registered job stream before becoming ready', { timeout: 15000 }, async () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  const reservationId = probe.store.reserveChild(probe.activity);
  const child = startCli(['task', '--sandbox', sandbox.root, '--reservation', reservationId]);
  try {
    const ready = await child.waitFor('task-ready');
    const state = probe.store.maintenanceStatus().activities.find(item => item.id === reservationId)!;
    assert.equal(state.pid, ready.pid);
    assert.equal(state.incarnation, ready.incarnation);
    assert.equal(state.streamId, ready.streamId);
    assert.equal(state.parentId, probe.activity.id);
    assert.equal(state.owner.ownerKind, 'job');
    assert.equal(state.owner.authorization.id, probe.activity.id);
    child.command('stop');
    assert.equal((await child.exit).code, 0);
  } finally {
    if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill();
    await child.exit;
    probe.close(); rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test('cancelling maintenance fences old activities and permits only a fresh process epoch', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const turn = probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
    const coordinator = randomUUID();
    const closing = probe.store.beginMaintenance(coordinator);
    const cancelled = probe.store.cancelMaintenance(coordinator);
    assert.equal(cancelled.state, 'open');
    assert.ok(cancelled.epoch > closing.epoch);
    assert.throws(() => probe.archive.append(randomUUID(), 'Late synthetic input'), /admission-closed/);
    assert.throws(() => probe.session.dispatch(turn), /admission-closed/);
    assert.throws(() => probe.store.register(), /stale-runtime-incarnation/);
    assert.equal(probe.transport.count, 0);
    const status = probe.store.maintenanceStatus();
    assert.equal(status.activities[0]?.streamId, probe.activity.streamId);
    assert.equal(status.fence.state, 'open');
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
