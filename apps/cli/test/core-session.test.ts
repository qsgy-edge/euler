import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';
import { startCli } from '../src/process-driver.ts';

test('inherited goal source loss blocks recovery and dispatch after a step transition', { timeout: 15000 }, async () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const first = probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
    const next = probe.archive.append(randomUUID(), 'Continue to the next synthetic step.');
    probe.session.transitionIntent(first.intent.eventId, next, { step: 'next', status: 'active' });
    const turn = probe.session.prepare(next.eventId, 'Continue to the next synthetic step.');
    const source = join(sandbox.root, 'session.jsonl');
    const lines = readFileSync(source, 'utf8').trimEnd().split('\n');
    writeFileSync(source, lines.filter((line, index) => index === 0 || JSON.parse(line).eventId !== first.input.eventId).join('\n') + '\n');
    assert.throws(() => probe.session.recoverIntent(), /source-evidence-gap/);
    assert.throws(() => probe.session.dispatch(turn), /source-evidence-gap/);
    assert.equal(probe.transport.count, 0);
    const restarted = startCli(['recover', '--sandbox', sandbox.root]);
    assert.equal((await restarted.exit).code, 1);
    assert.match(JSON.stringify(restarted.observations), /source-evidence-gap/);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('step transitions reject extra goal or constraint fields without changing the intent', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const turn = probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
    const input = probe.archive.append(randomUUID(), 'Only advance the current step.');
    const transition = { step: 'next', status: 'active' as const, goal: 'A different task', constraints: [] };
    assert.throws(() => probe.session.transitionIntent(turn.intent.eventId, input, transition), /invalid-transition/);
    assert.deepEqual(probe.session.recoverIntent(), turn.intent);
    assert.equal(probe.transport.count, 0);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('initial intent goals must match the source content hash', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const input = probe.archive.append(sandbox.fixture.eventId, sandbox.fixture.text);
    assert.throws(() => probe.store.transitionIntent(probe.activity, null, input,
      { step: 'first-turn', status: 'active' }, 'Unauthorized goal'), /intent-needs-input/);
    assert.equal(probe.session.readIntent(), null);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('source-backed intent survives reopening and a stale intent blocks final dispatch', () => {
  const sandbox = createSandbox();
  try {
    const first = openProbe(sandbox);
    const prepared = first.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
    assert.equal(prepared.intent.goal, sandbox.fixture.text);
    first.close();
    const second = openProbe(sandbox);
    try {
      assert.deepEqual(second.session.recoverIntent(), prepared.intent);
      const currentTurn = second.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
      const nextInput = second.archive.append('00000000-0000-4000-8000-000000000007', 'Pause the synthetic task.');
      second.session.transitionIntent(prepared.intent.eventId, nextInput, { step: 'paused', status: 'paused' });
      assert.throws(() => second.session.dispatch(currentTurn), /intent-stale/);
      assert.equal(second.transport.count, 0);
      assert.throws(() => second.session.transitionIntent(prepared.intent.eventId, nextInput, { step: 'other', status: 'active' }), /identity-conflict/);
    } finally { second.close(); }
  } finally { rmSync(sandbox.root, { recursive: true, force: true }); }
});
