import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { DEFAULT_BUDGET } from '@euler/core';
import { createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

test('attempt exhaustion stops tools too, cancellation blocks all new dispatch', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const turn = probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
    probe.session.dispatch(turn);
    assert.throws(() => probe.session.tool('source.expand', turn.input), /run-budget-exhausted/);
    probe.session.cancel();
    assert.throws(() => probe.session.prepare(randomUUID(), 'new input'), /run-cancelled/);
    assert.equal(probe.transport.count, 1);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('mandatory budget overflow blocks sending and invalid configuration cannot start', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox, { ...DEFAULT_BUDGET, contextLimit: 400 });
  try {
    const turn = probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
    assert.throws(() => probe.session.dispatch(turn), /context-budget-exhausted/);
    assert.equal(probe.transport.count, 0);
    assert.throws(() => openProbe(sandbox, { ...DEFAULT_BUDGET, maxModelAttempts: Number.NaN }), /invalid-budget/);
    assert.throws(() => openProbe(sandbox, { ...DEFAULT_BUDGET, wallClockMs: undefined as unknown as number }), /invalid-budget/);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('tool usage inside the final gate is included in the final dispatch budget', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox, { ...DEFAULT_BUDGET, maxTotalTokens: 1000 });
  try {
    const turn = probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
    assert.throws(() => probe.session.dispatch(turn, () => {
      probe.session.tool('source.expand', turn.input, 0, 1);
    }), /context-budget-exhausted/);
    assert.equal(probe.session.usage().tools, 1);
    assert.ok(probe.session.usage().tokens <= 1000);
    assert.equal(probe.transport.count, 0);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('payload tampering, including inside the final gate, cannot send', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const turn = probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
    assert.throws(() => probe.session.dispatch(turn, () => { turn.payload += 'altered'; }), /invalid-assembly/);
    assert.equal(probe.transport.count, 0);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
