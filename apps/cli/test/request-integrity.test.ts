import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { API_VERSION, assemblyIdentityHash } from '@euler/core';
import { createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

for (const resign of [false, true]) test(`canonical assembly damage blocks status and admission (resign=${resign})`, () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const turn = probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
    const assembly = probe.store.requestStatus(probe.activity, probe.session.runId).assemblies[0]!;
    const db = new DatabaseSync(join(sandbox.root, 'probe.sqlite'));
    // Forensic corruption fixture: impersonate the writer solely to damage a
    // disposable row; normal external connections cannot execute this update.
    db.function('euler_store_writer', () => 1);
    try {
      db.prepare('UPDATE request_assemblies SET model=?,identity_hash=? WHERE assembly_id=?')
        .run('tampered-model', resign ? assemblyIdentityHash({ ...assembly, model: 'tampered-model' }) : assembly.identityHash, assembly.assemblyId);
      assert.throws(() => probe.store.requestStatus(probe.activity, probe.session.runId), /ledger-evidence-gap/);
      assert.throws(() => probe.session.dispatch(turn), /ledger-evidence-gap/);
      assert.equal(probe.transport.count, 0);
    } finally {
      db.prepare('UPDATE request_assemblies SET model=?,identity_hash=? WHERE assembly_id=?')
        .run(assembly.model, assembly.identityHash, assembly.assemblyId);
      db.close();
    }
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

for (const admitted of [false, true]) test(`maintenance fences request activity before/after admission (admitted=${admitted})`, () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const turn = probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
    const input = { runId: probe.session.runId, assemblyId: turn.assemblyId, payloadHash: turn.payloadHash,
      byteLength: Buffer.byteLength(turn.payload), adapterVersion: API_VERSION };
    const attempt = admitted ? probe.store.startRequestAttempt(probe.activity, input) : null;
    const coordinator = randomUUID();
    probe.store.beginMaintenance(coordinator);
    if (attempt) assert.throws(() => probe.store.finishRequestAttempt(probe.activity,
      { attemptId: attempt.attemptId, outcome: 'received' }), /admission-closed/);
    else assert.throws(() => probe.store.startRequestAttempt(probe.activity, input), /admission-closed/);
    assert.equal(probe.transport.count, 0);
    probe.store.cancelMaintenance(coordinator);
    assert.throws(() => probe.store.register(), /stale-runtime-incarnation/);
    const db = new DatabaseSync(join(sandbox.root, 'probe.sqlite'), { readOnly: true });
    try {
      const attempts = db.prepare('SELECT outcome FROM request_attempts WHERE run_id=?').all(input.runId);
      assert.equal(attempts.length, admitted ? 1 : 0);
      if (attempt) assert.equal(attempts[0]!.outcome, 'unknown-sent');
    } finally { db.close(); }
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
