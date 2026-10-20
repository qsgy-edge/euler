import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { AgentRun, MemoryCorrections } from '@euler/core';
import { pumpAgent } from '../src/agent-pump.ts';
import { AGENT_BUDGET } from '../src/agent-cli.ts';
import { bindingOf } from '../src/sandbox.ts';
import { createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

function fixture() {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  const record = probe.store.rememberMemory(probe.activity, {
    input: probe.archive.append(randomUUID(), '记住偏好：使用 npm'), hostInfo: 'durable',
  }).record;
  const core = new MemoryCorrections(probe.store, probe.activity, probe.archive);
  const preview = (content = '使用 pnpm') => {
    const result = core.handle(core.receive(`correct ${record.recordId} ${JSON.stringify(content)}`));
    assert.equal(result.kind, 'preview');
    if (result.kind !== 'preview') throw new Error('preview required');
    return result.presentation;
  };
  const status = (reply: ReturnType<MemoryCorrections['handle']>) => {
    assert.equal(reply.kind, 'result');
    return reply.kind === 'result' ? reply.result.status : null;
  };
  return { sandbox, probe, record, core, preview, status, close() { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); } };
}

test('Core requires a live post-presentation event with the exact submitted text and bound model intent', () => {
  const f = fixture();
  try {
    const preview = f.preview();
    const early = f.core.receive(`commit ${preview.token} "使用 pnpm"`);
    f.core.presented(preview);
    assert.equal(f.status(f.core.handle(early)), 'unavailable');
    assert.equal(f.status(f.core.handle({ eventId: early.eventId })), 'invalid_identity');
    assert.equal(f.status(f.core.handle(f.core.receive(`commit ${preview.token} "changed"`))), 'invalid_identity');
    const input = f.core.receive(`commit ${preview.token} "使用 pnpm"`);
    assert.equal(f.status(f.core.handle(input, { id: 'forged', name: 'memory.commit', arguments: {
      token: preview.token, content: '使用 pnpm', confirm: true,
    } })), 'invalid_identity');
    assert.equal(f.status(f.core.handle(input, { id: 'correct', name: 'memory.commit', arguments: {
      token: preview.token, content: '使用 pnpm',
    } })), 'committed');
    assert.equal(f.probe.store.correctionDelivery(f.probe.activity, preview.token).approval?.eventId, input.eventId);
    assert.equal(f.status(f.core.handle(input)), 'invalid_identity');
  } finally { f.close(); }
});

test('investigation, denial, opposing directions and no-op do not create pending operations', () => {
  const f = fixture();
  try {
    for (const [text, expected] of [
      [`是否应该把 ${f.record.recordId} 改为「错误」？`, 'not_actionable'],
      [`不要把 ${f.record.recordId} 改为「错误」`, 'no_op'],
      [`恢复被彻底删除的 ${f.record.recordId}`, 'conflict'],
      [`correct ${f.record.recordId} ""`, 'no_op'],
      [`correct ${f.record.recordId} "  使用 npm  "`, 'no_op'],
    ]) {
      assert.equal(f.status(f.core.handle(f.core.receive(text!), text!.startsWith('correct ') ? undefined : { id: 'bad-model', name: 'memory.preview', arguments: { recordId: f.record.recordId, content: '错误' } })), expected);
      assert.deepEqual(f.core.pending(), []);
    }
    const body = `删除 ${randomUUID()} 并恢复已经 purge 的内容`;
    const reply = f.core.handle(f.core.receive(`把 ${f.record.recordId} 改为「${body}」`));
    assert.equal(reply.kind, 'preview');
    if (reply.kind === 'preview') {
      assert.equal(reply.presentation.content, body);
      assert.equal(reply.presentation.targets[0]!.recordId, f.record.recordId);
    }
  } finally { f.close(); }
});

test('old tokens settle independently, new preview explicitly supersedes and cancellation prevents commit', () => {
  const f = fixture();
  try {
    const first = f.preview('first'); f.core.presented(first);
    const late = f.core.receive(`commit ${first.token} "first"`);
    const second = f.preview('second'); f.core.presented(second);
    assert.equal(second.supersedesOperationId, first.operationId);
    assert.equal(f.status(f.core.handle(late)), 'settled');
    assert.equal(f.status(f.core.handle(f.core.receive(`cancel ${second.token}`))), 'cancelled');
    assert.equal(f.status(f.core.handle(f.core.receive(`commit ${second.token} "second"`))), 'settled');
    assert.deepEqual(f.probe.store.readMemory(f.probe.activity, f.record.recordId), f.record);
  } finally { f.close(); }
});

test('forget after preview makes commit stale; tombstones reject different, empty and identical correction bodies', () => {
  const f = fixture();
  try {
    const preview = f.preview(); f.core.presented(preview);
    f.probe.store.forgetMemory(f.probe.activity, f.record.recordId, f.record);
    assert.equal(f.status(f.core.handle(f.core.receive(`commit ${preview.token} "使用 pnpm"`))), 'stale');
    for (const content of ['new', '', f.record.content]) {
      const reply = f.core.handle(f.core.receive(`correct ${f.record.recordId} ${JSON.stringify(content)}`));
      assert.equal(f.status(reply), 'not_actionable');
      if (reply.kind === 'result') assert.equal(reply.result.reason, 'tombstoned-not-actionable');
    }
    assert.equal(f.probe.store.recoverMemoryOperations(f.probe.activity).length, 1);
    assert.equal(f.probe.store.readMemory(f.probe.activity, f.record.recordId).lifecycle, 'tombstoned');
  } finally { f.close(); }
});

test('a failed reverification insertion rolls back the correction, receipt and revision together', () => {
  const f = fixture();
  const db = new DatabaseSync(join(f.sandbox.root, 'probe.sqlite'));
  try {
    const preview = f.preview(); f.core.presented(preview);
    db.exec(`CREATE TRIGGER fail_reverification BEFORE INSERT ON capture_jobs BEGIN SELECT RAISE(ABORT,'injected-queue-failure'); END;`);
    const reply = f.core.handle(f.core.receive(`commit ${preview.token} "使用 pnpm"`));
    assert.equal(f.status(reply), 'error');
    assert.deepEqual(f.probe.store.readMemory(f.probe.activity, f.record.recordId), f.record);
    const result = f.probe.store.memoryOperationStatus(f.probe.activity, preview.token);
    assert.deepEqual(result.receiptIds, []);
    assert.equal(result.reason, 'injected-queue-failure');
  } finally { db.close(); f.close(); }
});

test('a complete model response reaches the same correction gate through AgentRun', async () => {
  const f = fixture();
  try {
    const text = `correct ${f.record.recordId} "使用 pnpm"`;
    const input = f.core.receive(text);
    const run = new AgentRun(f.probe.store, f.probe.activity, { binding: bindingOf(f.sandbox), source: f.probe.archive,
      memoryCorrections: true }, { provider: 'fake', model: 'controlled', route: 'fixture', authNamespace: 'synthetic' }, AGENT_BUDGET);
    run.receive(input.eventId, text);
    let sends = 0;
    const status = await pumpAgent(run, {
      async *stream(request, _signal, send) {
        send(request.payload); sends++;
        if (sends === 1) {
          const reply = { text: '', stop: 'tools' as const, calls: [{ id: 'preview', name: 'memory.preview', arguments: { recordId: f.record.recordId, content: '使用 pnpm' } }] };
          yield { kind: 'partial' as const, reply };
          assert.equal(f.core.pending().length, 0);
          yield { kind: 'complete' as const, reply };
        } else yield { kind: 'complete' as const, reply: { text: '已展示预览，等待真实输入。', stop: 'end' as const, calls: [] } };
      },
      async execute(call) {
        const reply = f.core.handle(input, call);
        assert.equal(reply.kind, 'preview');
        return JSON.stringify({ status: 'pending' });
      },
    });
    assert.equal(status.terminal, 'completed');
    assert.equal(f.core.pending().length, 1);
    assert.deepEqual(f.probe.store.readMemory(f.probe.activity, f.record.recordId), f.record);
  } finally { f.close(); }
});

test('replay reports only a real correction verification job and rejects a different operation kind', () => {
  const f = fixture();
  try {
    const inspection = f.probe.store.inspectMemoryPresentation(f.probe.activity, [f.record.recordId]);
    const preview = f.probe.store.previewMemoryOperation(f.probe.activity, inspection.token, { kind: 'correct',
      input: f.probe.archive.append(randomUUID(), 'Legacy corrected body'), content: 'Legacy corrected body' });
    f.probe.store.acknowledgeMemoryPresentation(f.probe.activity, preview.token, preview.hash);
    f.probe.store.commitMemoryOperation(f.probe.activity, preview.token);
    let replay = f.core.handle(f.core.receive(`replay ${preview.token}`));
    assert.equal(f.status(replay), 'committed');
    assert.equal('verification' in replay, false);
    const current = f.probe.store.readMemory(f.probe.activity, f.record.recordId);
    f.probe.store.queueMemoryVerification(f.probe.activity, current.recordId, current);
    replay = f.core.handle(f.core.receive(`replay ${preview.token}`));
    assert.equal('verification' in replay && replay.verification, 'queued');
    const forget = f.probe.store.previewMemoryOperation(f.probe.activity,
      f.probe.store.inspectMemoryPresentation(f.probe.activity, [current.recordId]).token, { kind: 'forget' });
    f.probe.store.acknowledgeMemoryPresentation(f.probe.activity, forget.token, forget.hash);
    f.probe.store.commitMemoryOperation(f.probe.activity, forget.token);
    assert.equal(f.status(f.core.handle(f.core.receive(`replay ${forget.token}`))), 'invalid_identity');
  } finally { f.close(); }
});

test('a recreated Core cannot turn historic archived approval text into a fresh live capability', () => {
  const f = fixture();
  try {
    const preview = f.preview(); f.core.presented(preview);
    const input = f.core.receive(`commit ${preview.token} "使用 pnpm"`);
    const reopened = new MemoryCorrections(f.probe.store, f.probe.activity, f.probe.archive);
    assert.equal(f.status(reopened.handle(input)), 'invalid_identity');
    assert.equal(f.status(reopened.handle(reopened.receive(`commit ${preview.token} "使用 pnpm"`))), 'unavailable');
    reopened.presented(preview);
    assert.equal(f.status(reopened.handle(reopened.receive(`commit ${preview.token} "使用 pnpm"`))), 'committed');
  } finally { f.close(); }
});
