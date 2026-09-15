import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { API_VERSION, ProbeSession, sha256 } from '@euler/core';
import { bindingOf, createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

// A known completed predecessor must not silently repeat the same source.
test('received predecessor requires explicit duplicate-risk approval', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const old = probe.session;
    old.dispatch(old.prepare(sandbox.fixture.eventId, sandbox.fixture.text));
    old.close();
    const host = { version: API_VERSION, binding: bindingOf(sandbox), source: probe.archive, transport: probe.transport } as const;
    assert.throws(() => new ProbeSession(probe.store, probe.activity, host, undefined,
      { relatedRunId: old.runId, acceptDuplicateRisk: false }), /duplicate-risk-approval-required/);
    assert.equal(probe.transport.count, 1);
    const resumed = new ProbeSession(probe.store, probe.activity, host, undefined,
      { relatedRunId: old.runId, acceptDuplicateRisk: true });
    assert.equal(resumed.dispatch(resumed.prepare(sandbox.fixture.eventId, sandbox.fixture.text)).count, 2);
    resumed.close();
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

for (const corrupt of [false, true]) test(`reconciliation reads bound receiver evidence, not caller claims (corrupt=${corrupt})`, () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  const host = { version: API_VERSION, binding: bindingOf(sandbox), source: probe.archive, transport: probe.transport } as const;
  const session = new ProbeSession(probe.store, probe.activity, { ...host, transport: {
    kind: 'local-counting@1', send(payload, attempt) {
      probe.transport.send(payload, attempt);
      throw new Error('response-lost');
    },
  } });
  const receiver = join(sandbox.root, 'counting-receiver.jsonl');
  let saved: string | undefined;
  try {
    assert.throws(() => session.dispatch(session.prepare(sandbox.fixture.eventId, sandbox.fixture.text)), /response-lost/);
    const before = probe.store.requestStatus(probe.activity, session.runId);
    const attempt = before.attempts[0]!;
    if (corrupt) {
      saved = readFileSync(receiver, 'utf8');
      const lines = saved.trimEnd().split('\n');
      const { record } = JSON.parse(lines[1]!);
      record.payloadHash = sha256('wrong payload');
      lines[1] = JSON.stringify({ record, hash: sha256(JSON.stringify(record)) });
      writeFileSync(receiver, lines.join('\n') + '\n');
      assert.throws(() => probe.store.reconcileRequestAttempt(probe.activity, attempt.attemptId), /receiver-evidence-gap/);
      assert.equal(probe.store.requestStatus(probe.activity, session.runId).events.length, before.events.length);
    } else {
      // Extra JavaScript arguments must not become authoritative observations.
      const result = Reflect.apply(probe.store.reconcileRequestAttempt, probe.store,
        [probe.activity, attempt.attemptId, { outcome: 'not-received', receiptHash: sha256('fabricated') }]);
      assert.equal(JSON.parse(result.events.at(-1)!.payload).evidence.outcome, 'received');
      assert.equal(result.attempts[0]!.outcome, 'unknown-sent');
      probe.store.sealRequestRun(probe.activity, session.runId);
      assert.throws(() => new ProbeSession(probe.store, probe.activity, host, undefined,
        { relatedRunId: session.runId, acceptDuplicateRisk: false }), /duplicate-risk-approval-required/);
    }
  } finally {
    if (saved) writeFileSync(receiver, saved);
    probe.close(); rmSync(sandbox.root, { recursive: true, force: true });
  }
});
