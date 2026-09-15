import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import test from 'node:test';
import { API_VERSION, DEFAULT_BUDGET, ProbeSession, sha256 } from '@euler/core';
import { bindingOf, createSandbox, createSandboxSession } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';
import { startCli } from '../src/process-driver.ts';

test('unknown recovery requires a linked owner decision while the sender is still live', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  const host = { version: API_VERSION, binding: bindingOf(sandbox), source: probe.archive, transport: probe.transport } as const;
  const old = new ProbeSession(probe.store, probe.activity, { ...host,
    transport: { kind: 'local-counting@1', send: () => { throw new Error('unknown-transport'); } } });
  try {
    assert.throws(() => old.dispatch(old.prepare(sandbox.fixture.eventId, sandbox.fixture.text)), /unknown-transport/);
    assert.throws(() => new ProbeSession(probe.store, probe.activity, host), /request-recovery-required/);
    assert.throws(() => new ProbeSession(probe.store, probe.activity, host, DEFAULT_BUDGET,
      { relatedRunId: old.runId, acceptDuplicateRisk: true }), /recovery-run-not-sealed/);
    probe.store.sealRequestRun(probe.activity, old.runId);
    assert.throws(() => new ProbeSession(probe.store, probe.activity, host), /request-recovery-required/);
    assert.throws(() => new ProbeSession(probe.store, probe.activity, host, DEFAULT_BUDGET,
      { relatedRunId: old.runId, acceptDuplicateRisk: false }), /duplicate-risk-approval-required/);
    const before = probe.store.requestStatus(probe.activity, old.runId);
    assert.throws(() => probe.store.reconcileRequestAttempt(probe.activity, before.attempts[0]!.attemptId), /attempt-owner-still-live/);
    const resumed = new ProbeSession(probe.store, probe.activity, host, DEFAULT_BUDGET,
      { relatedRunId: old.runId, acceptDuplicateRisk: true });
    assert.equal(resumed.dispatch(resumed.prepare(sandbox.fixture.eventId, sandbox.fixture.text)).outcome, 'received');
    assert.equal(probe.store.requestStatus(probe.activity, resumed.runId).run.relatedRunId, old.runId);
    const after = probe.store.requestStatus(probe.activity, old.runId);
    assert.deepEqual(after.attempts, before.attempts);
    assert.equal(after.attempts[0]!.outcome, 'unknown-sent');
    assert.equal(after.events.filter(e => e.kind === 'model/request-attempt-reconciled@v1').length, 0);
    resumed.close();
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('a different session cannot bypass an unknown run in the same project', () => {
  const sandbox = createSandbox();
  const second = { ...bindingOf(sandbox), sessionId: randomUUID() };
  createSandboxSession(sandbox, second);
  const probe = openProbe(sandbox);
  const foreign = openProbe(sandbox, undefined, undefined, second);
  try {
    const turn = probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
    probe.store.startRequestAttempt(probe.activity, { runId: probe.session.runId, assemblyId: turn.assemblyId,
      payloadHash: turn.payloadHash, byteLength: Buffer.byteLength(turn.payload), adapterVersion: API_VERSION });
    const pending = foreign.session.prepare(randomUUID(), 'same work in another session');
    assert.throws(() => foreign.session.dispatch(pending), /request-recovery-required/);
    assert.throws(() => foreign.store.requestStatus(foreign.activity, probe.session.runId), /request-scope-mismatch/);
    assert.equal(foreign.transport.count, 0);
  } finally { foreign.close(); probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('a restored pre-started snapshot blocks the old run once its gap is declared', async () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  const turn = probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
  const runId = probe.session.runId;
  const databasePath = join(sandbox.root, 'probe.sqlite');
  const snapshotPath = join(sandbox.root, 'pre-started.sqlite');
  const source = new DatabaseSync(databasePath, { readOnly: true });
  try { await backup(source, snapshotPath); } finally { source.close(); }
  probe.store.startRequestAttempt(probe.activity, { runId, assemblyId: turn.assemblyId,
    payloadHash: turn.payloadHash, byteLength: Buffer.byteLength(turn.payload), adapterVersion: API_VERSION });
  probe.store.close();
  writeFileSync(databasePath, readFileSync(snapshotPath));
  const restored = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    // The snapshot really lacks the attempt that happened after its backup.
    assert.equal(restored.store.requestStatus(restored.activity, runId).attempts.length, 0);
    restored.store.markRequestRecoveryGap(restored.activity, runId);
    assert.throws(() => restored.store.startRequestAttempt(restored.activity, { runId, assemblyId: turn.assemblyId,
      payloadHash: turn.payloadHash, byteLength: Buffer.byteLength(turn.payload), adapterVersion: API_VERSION }), /run-not-admissible/);
    assert.throws(() => restored.session, /request-recovery-required/);
    restored.store.sealRequestRun(restored.activity, runId);
    const host = { version: API_VERSION, binding: bindingOf(sandbox), source: restored.archive, transport: restored.transport } as const;
    assert.throws(() => new ProbeSession(restored.store, restored.activity, host, DEFAULT_BUDGET,
      { relatedRunId: runId, acceptDuplicateRisk: false }), /duplicate-risk-approval-required/);
    const next = new ProbeSession(restored.store, restored.activity, host, DEFAULT_BUDGET,
      { relatedRunId: runId, acceptDuplicateRisk: true });
    assert.equal(next.dispatch(next.prepare(sandbox.fixture.eventId, sandbox.fixture.text)).count, 1);
    assert.equal(restored.store.requestStatus(restored.activity, next.runId).run.relatedRunId, runId);
  } finally { restored.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('source loss during transport keeps the late result unknown and does not send again', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  const path = join(sandbox.root, 'session.jsonl');
  let original = '';
  const session = new ProbeSession(probe.store, probe.activity, { version: API_VERSION, binding: bindingOf(sandbox), source: probe.archive,
    transport: { kind: 'local-counting@1', send: payload => {
      original = readFileSync(path, 'utf8');
      const result = probe.transport.send(payload);
      writeFileSync(path, original.split('\n')[0] + '\n');
      return result;
    } } });
  try {
    assert.throws(() => session.dispatch(session.prepare(sandbox.fixture.eventId, sandbox.fixture.text)), /source|archive/);
    assert.equal(probe.transport.count, 1);
    assert.equal(probe.store.requestStatus(probe.activity, session.runId).attempts[0]!.outcome, 'unknown-sent');
    probe.store.sealRequestRun(probe.activity, session.runId);
    assert.throws(() => new ProbeSession(probe.store, probe.activity,
      { version: API_VERSION, binding: bindingOf(sandbox), source: probe.archive, transport: probe.transport }, DEFAULT_BUDGET,
      { relatedRunId: session.runId, acceptDuplicateRisk: true }), /source|archive/);
  } finally { if (original) writeFileSync(path, original); probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('CLI diagnostics and explicit recovery preserve unknown and link the new run', async () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  const turn = probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
  const runId = probe.session.runId;
  probe.store.startRequestAttempt(probe.activity, { runId, assemblyId: turn.assemblyId, payloadHash: turn.payloadHash,
    byteLength: Buffer.byteLength(turn.payload), adapterVersion: API_VERSION });
  probe.close();
  try {
    const status = startCli(['request-status', '--sandbox', sandbox.root, '--request', runId]);
    const observed = await status.waitFor('request-status');
    assert.match(String(observed.warning), /duplicate/);
    assert.equal((await status.exit).code, 0);
    const blocked = startCli(['request-resume', '--sandbox', sandbox.root, '--request', runId]);
    assert.equal((await blocked.waitFor('error')).reason, 'duplicate-risk-approval-required');
    assert.equal((await blocked.exit).code, 1);
    const resumed = startCli(['request-resume', '--sandbox', sandbox.root, '--request', runId, '--accept-duplicate-risk']);
    assert.equal((await resumed.waitFor('request-resumed')).relatedRunId, runId);
    assert.equal((await resumed.exit).code, 0);
  } finally { rmSync(sandbox.root, { recursive: true, force: true }); }
});
