import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { MemoryCorrections } from '@euler/core';
import { bindingOf, createSandbox, createSandboxSession } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

function fixture() {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  const record = probe.store.rememberMemory(probe.activity, {
    input: probe.archive.append(randomUUID(), '记住偏好：使用 npm'), hostInfo: 'durable',
  }).record;
  const core = new MemoryCorrections(probe.store, probe.activity, probe.archive);
  const preview = (kind: 'forget' | 'restore') => {
    const reply = core.handle(core.receive(`${kind} ${record.recordId}`));
    assert.equal(reply.kind, 'preview');
    if (reply.kind !== 'preview') throw new Error('preview required');
    return reply.presentation;
  };
  const result = (text: string) => {
    const reply = core.handle(core.receive(text));
    assert.equal(reply.kind, 'result');
    if (reply.kind !== 'result') throw new Error('result required');
    return reply;
  };
  return { sandbox, probe, record, core, preview, result,
    close() { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); } };
}

test('forget retains the revision and a separate live restore approval returns it with a new head', () => {
  const f = fixture();
  try {
    const forgotten = f.preview('forget');
    assert.deepEqual(forgotten.targets, [f.record]);
    f.core.presented(forgotten);
    const committed = f.result(`commit ${forgotten.token} forget`);
    assert.equal(committed.result.status, 'committed');
    assert.equal(committed.canonical, 'committed');
    const tombstone = f.probe.store.readMemory(f.probe.activity, f.record.recordId);
    assert.equal(tombstone.lifecycle, 'tombstoned');
    assert.equal(tombstone.revisionId, f.record.revisionId);
    assert.equal(tombstone.content, f.record.content);
    assert.notEqual(tombstone.headEventId, f.record.headEventId);
    assert.equal(f.probe.store.correctionSummary(f.probe.activity, forgotten.token).kind, 'forget');
    const restore = f.preview('restore');
    assert.notEqual(restore.token, forgotten.token);
    assert.equal(f.result(`commit ${restore.token} forget`).result.status, 'invalid_identity');
    assert.equal(f.result(`commit ${restore.token} restore`).result.status, 'unavailable');
    f.core.presented(restore);
    assert.equal(f.result(`commit ${restore.token} restore`).result.status, 'committed');
    const restored = f.probe.store.readMemory(f.probe.activity, f.record.recordId);
    assert.equal(restored.lifecycle, 'active');
    assert.equal(restored.revisionId, f.record.revisionId);
    assert.notEqual(restored.headEventId, tombstone.headEventId);
    assert.notEqual(restored.headEventId, f.record.headEventId);
    assert.equal(f.result(`commit ${forgotten.token} forget`).result.status, 'settled');
    assert.equal(f.probe.store.readMemory(f.probe.activity, f.record.recordId).headEventId, restored.headEventId);
  } finally { f.close(); }
});

for (const operation of ['forget', 'restore'] as const) {
  test(operation + ' rejects fabricated, buffered and mismatched intent approval, and preserves cancellation', () => {
    const f = fixture();
    try {
      if (operation === 'restore') f.probe.store.forgetMemory(f.probe.activity, f.record.recordId, f.record);
      const preview = f.preview(operation), command = 'commit ' + preview.token + ' ' + operation;
      const early = f.core.receive(command);
      f.core.presented(preview);
      assert.equal(f.core.handle({ eventId: early.eventId }).kind, 'result');
      const denied = f.core.handle(early);
      assert.equal(denied.kind === 'result' && denied.result.status, 'unavailable');
      const intent = { id: randomUUID(), name: 'memory.commit', arguments: { token: preview.token,
        operation: operation === 'forget' ? 'restore' : 'forget' } };
      const mismatched = f.core.handle(f.core.receive(command), intent);
      assert.equal(mismatched.kind === 'result' && mismatched.result.status, 'invalid_identity');
      assert.equal(f.result('cancel ' + preview.token).result.status, 'cancelled');
      assert.equal(f.result(command).result.status, 'settled');
      assert.equal(f.probe.store.readMemory(f.probe.activity, f.record.recordId).lifecycle,
        operation === 'forget' ? 'active' : 'tombstoned');
      assert.equal(f.result('不要恢复这条记忆').result.status, 'no_op');
      assert.equal(f.result('是否应该忘记这条记忆？').result.status, 'not_actionable');
      assert.equal(f.result('永久删除并恢复这条记忆').result.status, 'conflict');
    } finally { f.close(); }
  });

  test(operation + ' preview becomes stale after another session returns to the same lifecycle', () => {
    const f = fixture();
    try {
      if (operation === 'restore') f.probe.store.forgetMemory(f.probe.activity, f.record.recordId, f.record);
      const preview = f.preview(operation); f.core.presented(preview);
      const binding = { ...bindingOf(f.sandbox), sessionId: randomUUID() };
      createSandboxSession(f.sandbox, binding);
      const other = openProbe(f.sandbox, undefined, undefined, binding, undefined, true);
      try {
        let current = other.store.readMemory(other.activity, f.record.recordId);
        if (operation === 'forget') {
          current = other.store.forgetMemory(other.activity, current.recordId, current).record;
          other.store.restoreMemory(other.activity, current.recordId, current);
        } else {
          current = other.store.restoreMemory(other.activity, current.recordId, current).record;
          other.store.forgetMemory(other.activity, current.recordId, current);
        }
      } finally { other.close(); }
      const before = f.probe.store.readMemory(f.probe.activity, f.record.recordId);
      const result = f.result('commit ' + preview.token + ' ' + operation);
      assert.equal(result.result.status, 'stale');
      assert.equal(result.canonical, 'unchanged');
      assert.deepEqual(result.result.receiptIds, []);
      assert.equal(f.probe.store.readMemory(f.probe.activity, f.record.recordId).headEventId, before.headEventId);
    } finally { f.close(); }
  });

  test(operation + ' atomically rolls back the head, suppression, search outbox and receipt on failure', () => {
    const f = fixture(), db = new DatabaseSync(join(f.sandbox.root, 'probe.sqlite'));
    try {
      if (operation === 'restore') f.probe.store.forgetMemory(f.probe.activity, f.record.recordId, f.record);
      const preview = f.preview(operation); f.core.presented(preview);
      const before = f.probe.store.readMemory(f.probe.activity, f.record.recordId);
      const history = f.probe.store.inspectMemory(f.probe.activity, f.record.recordId).history;
      db.exec("CREATE TRIGGER fail_search BEFORE INSERT ON projection_jobs WHEN NEW.kind='search' BEGIN SELECT RAISE(ABORT,'injected-outbox-failure'); END;");
      const result = f.result('commit ' + preview.token + ' ' + operation);
      assert.equal(result.result.status, 'error'); assert.equal(result.canonical, 'unchanged');
      assert.deepEqual(result.result.receiptIds, []);
      assert.equal(f.probe.store.readMemory(f.probe.activity, f.record.recordId).headEventId, before.headEventId);
      assert.deepEqual(f.probe.store.inspectMemory(f.probe.activity, f.record.recordId).history, history);
    } finally { db.close(); f.close(); }
  });
}

for (const failure of ['verification', 'expiry', 'source'] as const)
test('restore rechecks current eligibility at commit: ' + failure, t => {
  const sandbox = createSandbox(), probe = openProbe(sandbox);
  try {
    const now = Date.now(); t.mock.timers.enable({ apis: ['Date'], now });
    const source = probe.archive.append(randomUUID(), '合成短期有效事实');
    const candidate = probe.store.captureMemory(probe.activity, source, '短期事实', { type: 'fact',
      scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: [],
      validUntil: new Date(now + 1000).toISOString() }).record;
    const verified = probe.store.verifyMemory(probe.activity, candidate.recordId, candidate, 'pass', [source]).record;
    const active = probe.store.activateMemory(probe.activity, verified.recordId, verified).record;
    const tombstone = probe.store.forgetMemory(probe.activity, active.recordId, active).record;
    const inspection = probe.store.inspectMemoryPresentation(probe.activity, [active.recordId]);
    const preview = probe.store.previewMemoryOperation(probe.activity, inspection.token, { kind: 'restore' });
    probe.store.acknowledgeMemoryPresentation(probe.activity, preview.token, preview.hash);
    if (failure === 'verification') probe.store.verifyMemory(probe.activity, tombstone.recordId, tombstone, 'evidence-gap', []);
    if (failure === 'expiry') t.mock.timers.tick(1001);
    if (failure === 'source') {
      const path = join(sandbox.root, 'session.jsonl');
      writeFileSync(path, readFileSync(path, 'utf8').replace('合成短期有效事实', '合成短期无效事实'));
    }
    const result = probe.store.commitMemoryOperation(probe.activity, preview.token);
    assert.equal(result.status, failure === 'verification' ? 'stale' : 'error');
    assert.deepEqual(result.receiptIds, []);
    assert.equal(result.expected[0]!.lifecycle, 'tombstoned');
    const db = new DatabaseSync(join(sandbox.root, 'probe.sqlite'), { readOnly: true });
    try { assert.equal(db.prepare('SELECT lifecycle FROM memory_heads WHERE record_id=?').get(tombstone.recordId)!.lifecycle, 'tombstoned'); }
    finally { db.close(); }
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
