import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { DEFAULT_BUDGET } from '@euler/core';
import { createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

test('two explicitly requested identical-payload attempts remain readable and finish', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox, { ...DEFAULT_BUDGET, maxModelAttempts: 2 });
  try {
    const turn = probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
    probe.session.dispatch(turn);
    probe.session.dispatch(probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text));
    const status = probe.store.requestStatus(probe.activity, probe.session.runId);
    assert.equal(status.assemblies.length, 1);
    assert.deepEqual(status.attempts.map(a => a.ordinal), [1, 2]);
    assert.deepEqual(status.attempts.map(a => a.outcome), ['received', 'received']);
    assert.equal(status.assemblies[0]!.state, 'finished');
    assert.equal(probe.transport.count, 2);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('intent paused by another connection after started COMMIT stops transport', () => {
  const sandbox = createSandbox();
  const first = openProbe(sandbox), second = openProbe(sandbox);
  const exec = DatabaseSync.prototype.exec;
  try {
    const turn = first.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
    const pauseInput = second.archive.append(randomUUID(), 'Pause the task');
    const start = first.store.startRequestAttempt.bind(first.store);
    let admitted = false;
    first.store.startRequestAttempt = (activity, input) => {
      const attempt = start(activity, input); admitted = true; return attempt;
    };
    DatabaseSync.prototype.exec = function(sql) {
      const result = exec.call(this, sql);
      if (sql === 'COMMIT' && admitted) {
        admitted = false;
        second.store.transitionIntent(second.activity, turn.intent.eventId, pauseInput, { step: 'paused', status: 'paused' });
      }
      return result;
    };
    assert.throws(() => first.session.dispatch(turn), /run-cancelled/);
    assert.equal(first.transport.count, 0);
    assert.equal(first.store.requestStatus(first.activity, first.session.runId).attempts[0]!.outcome, 'cancelled-before-send');
  } finally { DatabaseSync.prototype.exec = exec; second.close(); first.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('nested dispatch is rejected before transport even if the enclosing transaction rolls back', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const turn = probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
    assert.throws(() => probe.store.withActivity(probe.activity, () => {
      probe.session.dispatch(turn);
      throw new Error('outer-rollback');
    }), /dispatch-inside-transaction/);
    assert.equal(probe.transport.count, 0);
    assert.equal(probe.store.requestStatus(probe.activity, probe.session.runId).attempts.length, 0);
    assert.equal(probe.session.dispatch(turn).outcome, 'received');
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
