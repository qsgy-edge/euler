import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

test('final gate rejects asynchronous gates and sends no payload', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const turn = probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
    assert.throws(() => probe.session.dispatch(turn, async () => {}), /async-final-gate/);
    assert.equal(probe.transport.count, 0);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('failed final gate sends zero; an unchanged successful payload is received exactly once', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const turn = probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
    assert.throws(() => probe.session.dispatch(turn, () => { throw new Error('gate-denied'); }), /gate-denied/);
    assert.equal(probe.transport.count, 0);
    const receipt = probe.session.dispatch(turn);
    assert.equal(receipt.count, 1);
    assert.deepEqual(probe.transport.payloads, [turn.payload]);
    assert.equal(receipt.formalLedger, true);
    assert.throws(() => probe.session.dispatch(turn), /attempt-settled-or-unknown/);
    assert.equal(probe.transport.count, 1);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
