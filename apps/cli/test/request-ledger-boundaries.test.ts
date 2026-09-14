import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { API_VERSION, DEFAULT_BUDGET } from '@euler/core';
import { createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

function admission(probe: ReturnType<typeof openProbe>, turn: ReturnType<typeof probe.session.prepare>) {
  return { runId: probe.session.runId, assemblyId: turn.assemblyId, payloadHash: turn.payloadHash,
    byteLength: Buffer.byteLength(turn.payload), adapterVersion: API_VERSION };
}

test('Store admission charges reserve and margin on every attempt', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox, { ...DEFAULT_BUDGET, maxModelAttempts: 3, maxTotalTokens: 1500 });
  try {
    const turn = probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
    const request = admission(probe, turn);
    const first = probe.store.startRequestAttempt(probe.activity, request);
    probe.store.finishRequestAttempt(probe.activity, { attemptId: first.attemptId, outcome: 'received' });
    const reservation = turn.estimatedTokens + DEFAULT_BUDGET.outputReserve + DEFAULT_BUDGET.safetyMargin;
    assert.ok(reservation <= 1500 && reservation * 2 > 1500, 'fixture must cross cumulative limit');
    assert.throws(() => probe.store.startRequestAttempt(probe.activity, request), /token-budget-exhausted/);
    assert.equal(probe.store.requestStatus(probe.activity, request.runId).attempts.length, 1);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('Store rejects assembly budgets different from authorization and enforces attempt count', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const turn = probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
    const assembly = probe.store.requestStatus(probe.activity, probe.session.runId).assemblies[0]!;
    assert.throws(() => probe.store.appendRequestAssembly(probe.activity, { ...assembly, payload: turn.payload,
      budget: { ...assembly.budget, maxModelAttempts: 99 } }), /assembly-budget-mismatch/);
    const request = admission(probe, turn);
    const attempt = probe.store.startRequestAttempt(probe.activity, request);
    probe.store.finishRequestAttempt(probe.activity, { attemptId: attempt.attemptId, outcome: 'received' });
    assert.throws(() => probe.store.startRequestAttempt(probe.activity, request), /attempt-budget-exhausted/);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('a new activity on the same stream cannot settle the original activity attempt', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const turn = probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
    const attempt = probe.store.startRequestAttempt(probe.activity, admission(probe, turn));
    const other = probe.store.register();
    assert.equal(other.streamId, probe.activity.streamId);
    assert.notEqual(other.id, probe.activity.id);
    for (const outcome of ['received', 'cancelled-before-send'] as const) {
      assert.throws(() => probe.store.finishRequestAttempt(other, { attemptId: attempt.attemptId, outcome }), /attempt-owner-mismatch/);
    }
    assert.equal(probe.store.requestStatus(probe.activity, probe.session.runId).attempts[0]!.outcome, 'unknown-sent');
    probe.store.finishRequestAttempt(probe.activity, { attemptId: attempt.attemptId, outcome: 'received' });
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('close after a successful turn blocks a pending turn and all later work', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox, { ...DEFAULT_BUDGET, maxModelAttempts: 3 });
  try {
    probe.session.dispatch(probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text));
    const pending = probe.session.prepare(randomUUID(), 'pending input');
    probe.session.close();
    assert.throws(() => probe.store.startRequestAttempt(probe.activity, admission(probe, pending)), /run-not-admissible/);
    assert.throws(() => probe.session.prepare(randomUUID(), 'after close'), /run-closed/);
    const ledger = probe.store.requestStatus(probe.activity, probe.session.runId);
    assert.equal(ledger.run.state, 'sealed');
    assert.deepEqual(ledger.assemblies.map(a => a.state), ['finished', 'not-dispatched']);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('cancel reports a rolled-back revocation failure and retries it durably', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  const revoke = probe.store.revokeRequestRun.bind(probe.store);
  try {
    probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
    probe.store.revokeRequestRun = (activity, runId) => probe.store.withActivity(activity, () => {
      revoke(activity, runId);
      throw new Error('injected-revocation-write-failure');
    });
    assert.throws(() => probe.session.cancel(), /injected-revocation-write-failure/);
    assert.notEqual(probe.session.usage().stopped, 'run-cancelled');
    assert.equal(probe.store.requestStatus(probe.activity, probe.session.runId).run.state, 'authorized');
    probe.store.revokeRequestRun = revoke;
    probe.session.cancel();
    assert.equal(probe.store.requestStatus(probe.activity, probe.session.runId).run.state, 'revoked');
  } finally {
    probe.store.revokeRequestRun = revoke;
    probe.close(); rmSync(sandbox.root, { recursive: true, force: true });
  }
});
