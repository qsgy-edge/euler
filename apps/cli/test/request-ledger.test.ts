import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { API_VERSION, DEFAULT_BUDGET, ProbeSession, REQUEST_POLICY_HASH, assemblyIdentityHash } from '@euler/core';
import { bindingOf, createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

// AC1/AC4/AC7: normal first send — every barrier fact is durable and the reopened
// store recomputes the full ledger; receipts stay log-only.
test('a received request has durable assembly, started and finished facts after reopening', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  const runId = probe.session.runId;
  try {
    const turn = probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
    const receipt = probe.session.dispatch(turn);
    assert.equal(probe.transport.count, 1);
    assert.equal(receipt.formalLedger, true);
    // Receipts and ledger markers never enter the model payload.
    assert.ok(!turn.payload.includes('receipt') && !turn.payload.includes('attempt') && !turn.payload.includes('ledger'));
    probe.close();
    const reopened = openProbe(sandbox);
    try {
      const ledger = reopened.store.requestStatus(reopened.activity, runId);
      assert.deepEqual(ledger.events.map(event => event.kind), ['run-authorized', 'context/assembly@v1',
        'model/request-attempt-started@v1', 'model/request-attempt-finished@v1']);
      assert.equal(ledger.revoked, false);
      assert.equal(ledger.sealed, false);
      assert.equal(ledger.run.ownerKind, 'session');
      assert.equal(ledger.run.epoch, probe.activity.epoch);
      assert.equal(ledger.assemblies.length, 1);
      assert.equal(ledger.assemblies[0]!.state, 'finished');
      assert.equal(ledger.assemblies[0]!.route, 'local-counting');
      assert.equal(ledger.assemblies[0]!.payloadHash, turn.payloadHash);
      assert.equal(ledger.assemblies[0]!.intent!.eventId, turn.intent.eventId);
      assert.equal(ledger.attempts.length, 1);
      assert.equal(ledger.attempts[0]!.attemptId, receipt.attemptId);
      assert.equal(ledger.attempts[0]!.assemblyId, turn.assemblyId);
      assert.equal(ledger.attempts[0]!.payloadHash, turn.payloadHash);
      assert.equal(ledger.attempts[0]!.ordinal, 1);
      assert.equal(ledger.attempts[0]!.outcome, 'received');
      assert.ok(ledger.attempts[0]!.finishedAt);
      // The ledger holds only references, hashes, budgets and states — never the
      // request content itself.
      assert.ok(!JSON.stringify(ledger).includes(sandbox.fixture.text));
    } finally { reopened.close(); }
  } finally {
    try { probe.close(); } catch {}
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

// AC4: crash between the assembly barrier and dispatch — assembly/no-started is
// not-dispatched and the abandoned run is not silently re-dispatched.
test('a host crash after the assembly barrier leaves a not-dispatched assembly without attempts', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  const runId = probe.session.runId;
  let reopened: ReturnType<typeof openProbe> | undefined;
  try {
    probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
    assert.equal(probe.transport.count, 0);
    probe.store.close(); // host death without an explicit cancel
    reopened = openProbe(sandbox);
    const ledger = reopened.store.requestStatus(reopened.activity, runId);
    assert.deepEqual(ledger.events.map(event => event.kind), ['run-authorized', 'context/assembly@v1']);
    assert.equal(ledger.assemblies[0]!.state, 'not-dispatched');
    assert.deepEqual(ledger.attempts, []);
    assert.equal(ledger.revoked, false);
    assert.equal(reopened.transport.count, 0);
  } finally {
    try { probe.close(); } catch {}
    try { reopened?.close(); } catch {}
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

// AC1/AC4/AC7: started/no-finished stays durable unknown-sent; status never retries
// it, and a second admission on the same unresolved assembly is rejected.
test('a failed send stays unknown-sent and rejects same-run retry', () => {
  const sandbox = createSandbox();
  const budget = { ...DEFAULT_BUDGET, maxModelAttempts: 2 };
  const probe = openProbe(sandbox, budget);
  let down = true;
  const flaky = { kind: 'local-counting@1' as const,
    send: (payload: string) => { if (down) throw new Error('synthetic-network-down'); return probe.transport.send(payload); } };
  const session = new ProbeSession(probe.store, probe.activity,
    { version: API_VERSION, binding: bindingOf(sandbox), source: probe.archive, transport: flaky }, budget);
  try {
    const first = session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
    assert.throws(() => session.dispatch(first), /synthetic-network-down/);
    assert.equal(probe.transport.count, 0);
    let ledger = probe.store.requestStatus(probe.activity, session.runId);
    assert.deepEqual(ledger.events.map(event => event.kind), ['run-authorized', 'context/assembly@v1',
      'model/request-attempt-started@v1']);
    assert.equal(ledger.assemblies[0]!.state, 'unknown-sent');
    assert.equal(ledger.attempts.length, 1);
    assert.equal(ledger.attempts[0]!.outcome, 'unknown-sent');
    assert.equal(ledger.attempts[0]!.finishedAt, null);
    assert.equal(ledger.attempts[0]!.ordinal, 1);
    // Reading status never triggers a hidden retry.
    assert.deepEqual(probe.store.requestStatus(probe.activity, session.runId).attempts, ledger.attempts);
    down = false;
    const retry = session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
    assert.equal(retry.assemblyId, first.assemblyId);
    assert.throws(() => session.dispatch(retry), /unknown-attempt-requires-reconciliation/);
    ledger = probe.store.requestStatus(probe.activity, session.runId);
    assert.deepEqual(ledger.attempts.map(attempt => [attempt.ordinal, attempt.outcome, attempt.assemblyId]),
      [[1, 'unknown-sent', first.assemblyId]]);
    assert.equal(ledger.assemblies[0]!.state, 'unknown-sent');
    assert.equal(probe.transport.count, 0);
    assert.deepEqual(ledger.events.map(event => event.kind), ['run-authorized', 'context/assembly@v1',
      'model/request-attempt-started@v1']);
  } finally {
    probe.close();
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

// AC2: a revocation committed after admission treats the attempt as in-flight —
// the unknown-sent fact is kept, sent bytes are not claimed back, and no further
// admission happens on the revoked run.
test('a cancellation committed during an in-flight send keeps unknown-sent and blocks further admission', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  const cancelling = { kind: 'local-counting@1' as const,
    send: () => { session.cancel(); throw new Error('stopped-in-flight'); } };
  const session = new ProbeSession(probe.store, probe.activity,
    { version: API_VERSION, binding: bindingOf(sandbox), source: probe.archive, transport: cancelling });
  try {
    const turn = session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
    assert.throws(() => session.dispatch(turn), /stopped-in-flight/);
    assert.equal(probe.transport.count, 0);
    const ledger = probe.store.requestStatus(probe.activity, session.runId);
    assert.equal(ledger.attempts[0]!.outcome, 'unknown-sent');
    assert.equal(ledger.assemblies[0]!.state, 'unknown-sent');
    assert.equal(ledger.revoked, true);
    assert.throws(() => session.prepare(randomUUID(), 'late input'), /run-cancelled/);
    assert.equal(probe.transport.count, 0);
  } finally {
    probe.close();
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

// AC2: a revocation committed before dispatch blocks admission entirely.
test('an explicit cancel before dispatch revokes the run and admits no attempt', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const turn = probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
    probe.session.cancel();
    assert.throws(() => probe.session.dispatch(turn), /run-cancelled/);
    assert.equal(probe.transport.count, 0);
    const ledger = probe.store.requestStatus(probe.activity, probe.session.runId);
    assert.deepEqual(ledger.attempts, []);
    assert.equal(ledger.assemblies[0]!.state, 'not-dispatched');
    assert.equal(ledger.revoked, true);
    // The durable revocation also blocks admission at the store seam.
    assert.throws(() => probe.store.startRequestAttempt(probe.activity, { runId: probe.session.runId,
      assemblyId: turn.assemblyId, payloadHash: turn.payloadHash,
      byteLength: Buffer.byteLength(turn.payload), adapterVersion: API_VERSION }), /run-not-admissible/);
  } finally {
    probe.close();
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

// AC1: a barrier failure inside the started transaction rolls the admission back
// and sends zero bytes.
test('a failed final gate leaves the assembly not-dispatched with zero sends and zero attempts', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const turn = probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
    assert.throws(() => probe.session.dispatch(turn, () => { throw new Error('gate-denied'); }), /gate-denied/);
    assert.equal(probe.transport.count, 0);
    const ledger = probe.store.requestStatus(probe.activity, probe.session.runId);
    assert.deepEqual(ledger.attempts, []);
    assert.equal(ledger.assemblies[0]!.state, 'not-dispatched');
    assert.equal(ledger.assemblies.length, 1);
    const receipt = probe.session.dispatch(turn);
    assert.equal(receipt.count, 1);
    assert.equal(probe.store.requestStatus(probe.activity, probe.session.runId).attempts.length, 1);
  } finally {
    probe.close();
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

// AC4: changed content creates a new assembly; the run keeps both assemblies
// with one attempt each.
test('changed request content creates a new assembly on the same run', () => {
  const sandbox = createSandbox();
  const budget = { ...DEFAULT_BUDGET, maxModelAttempts: 2 };
  const probe = openProbe(sandbox, budget);
  try {
    const first = probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
    probe.session.dispatch(first);
    const nextInput = probe.archive.append(randomUUID(), 'A different synthetic request.');
    const second = probe.session.prepare(nextInput.eventId, 'A different synthetic request.');
    assert.notEqual(second.assemblyId, first.assemblyId);
    assert.notEqual(second.payloadHash, first.payloadHash);
    const receipt = probe.session.dispatch(second);
    assert.equal(receipt.count, 2);
    const ledger = probe.store.requestStatus(probe.activity, probe.session.runId);
    assert.equal(ledger.assemblies.length, 2);
    assert.ok(ledger.assemblies.every(assembly => assembly.state === 'finished'));
    assert.deepEqual(ledger.attempts.map(attempt => attempt.assemblyId === first.assemblyId ? 1 : 2), [1, 2]);
    assert.ok(new Set(ledger.attempts.map(attempt => attempt.attemptId)).size === 2);
  } finally {
    probe.close();
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

// AC5: job and migration runs carry the same durable ledger facts under their
// own owner, and a foreign stream activity cannot read another owner's run.
test('job and migration runs keep ledger facts in scope and foreign activities cannot read them', () => {
  for (const kind of ['job', 'migration'] as const) {
    const sandbox = createSandbox();
    const id = randomUUID();
    const probe = openProbe(sandbox, undefined, { kind, id, authorizationId: id });
    try {
      const receipt = probe.session.dispatch(probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text));
      const ledger = probe.store.requestStatus(probe.activity, probe.session.runId);
      assert.equal(ledger.run.ownerKind, kind);
      assert.equal(ledger.run.ownerId, id);
      assert.equal(ledger.assemblies[0]!.state, 'finished');
      assert.equal(ledger.attempts[0]!.attemptId, receipt.attemptId);
      assert.equal(ledger.attempts[0]!.ownerKind, kind);
      const reservation = probe.store.reserveChild(probe.activity);
      const child = probe.store.claimChild(reservation);
      assert.throws(() => probe.store.requestStatus(child, probe.session.runId), /request-scope-mismatch/);
      assert.throws(() => probe.store.sealRequestRun(child, probe.session.runId), /request-scope-mismatch/);
    } finally {
      probe.close();
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  }
});

// AC6: sealing an unknown run preserves the unknown facts, blocks admission on
// the old run, and fresh work re-authorizes through a new run with its own
// assembly — no automatic continuation of the sealed run.
test('sealing preserves unknown facts and fresh work requires a newly authorized run', () => {
  const sandbox = createSandbox();
  const budget = { ...DEFAULT_BUDGET, maxModelAttempts: 2 };
  const probe = openProbe(sandbox, budget);
  const flaky = { kind: 'local-counting@1' as const, send: () => { throw new Error('synthetic-network-down'); } };
  const session = new ProbeSession(probe.store, probe.activity,
    { version: API_VERSION, binding: bindingOf(sandbox), source: probe.archive, transport: flaky }, budget);
  try {
    const turn = session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
    assert.throws(() => session.dispatch(turn), /synthetic-network-down/);
    const sealed = probe.store.sealRequestRun(probe.activity, session.runId);
    assert.equal(sealed.state, 'sealed');
    assert.equal(probe.store.sealRequestRun(probe.activity, session.runId).state, 'sealed');
    const ledger = probe.store.requestStatus(probe.activity, session.runId);
    assert.equal(ledger.sealed, true);
    assert.equal(ledger.attempts[0]!.outcome, 'unknown-sent');
    assert.equal(ledger.assemblies[0]!.state, 'unknown-sent');
    assert.throws(() => session.prepare(randomUUID(), 'input after seal'), /run-not-admissible/);
    // A new run re-obtains authorization, re-checks budget/resources and builds
    // its own assembly for the same content.
    const resumed = new ProbeSession(probe.store, probe.activity,
      { version: API_VERSION, binding: bindingOf(sandbox), source: probe.archive, transport: probe.transport }, budget);
    assert.notEqual(resumed.runId, session.runId);
    const next = resumed.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
    assert.notEqual(next.assemblyId, turn.assemblyId);
    assert.equal(resumed.dispatch(next).outcome, 'received');
    const preserved = probe.store.requestStatus(probe.activity, session.runId);
    assert.equal(preserved.sealed, true);
    assert.equal(preserved.attempts[0]!.outcome, 'unknown-sent');
    assert.equal(probe.store.requestStatus(probe.activity, resumed.runId).attempts[0]!.outcome, 'received');
  } finally {
    probe.close();
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

// AC4 (Ticket 09 §15): assembly identity is deterministic and separates content,
// route, model, policy, epoch and budget changes from legal same-payload retries.
test('assembly identity hashes distinguish every non-attempt input dimension', () => {
  const base = { runId: 'run-identity-probe', epoch: 1, route: 'local-counting', model: 'none',
    policyHash: REQUEST_POLICY_HASH, estimator: 'utf8-bytes-upper-bound@1' as const, sources: [], intent: null,
    payloadHash: 'a'.repeat(64), byteLength: 10, estimatedTokens: 10, budget: { ...DEFAULT_BUDGET },
    zones: { p0: 10, p1: 0, p2: 0, p3: 0 }, selection: [], degradation: 'none' as const };
  const identity = assemblyIdentityHash(base);
  assert.equal(assemblyIdentityHash(base), identity);
  for (const changed of [
    { ...base, payloadHash: 'b'.repeat(64) }, { ...base, route: 'https-provider' },
    { ...base, model: 'synthetic-large' }, { ...base, policyHash: 'c'.repeat(64) },
    { ...base, epoch: 2 }, { ...base, budget: { ...DEFAULT_BUDGET, contextLimit: DEFAULT_BUDGET.contextLimit + 1 } },
  ]) assert.notEqual(assemblyIdentityHash(changed), identity);
});
