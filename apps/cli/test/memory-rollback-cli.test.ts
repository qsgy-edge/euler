import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { startCli, sendCommand as send } from '../src/process-driver.ts';
import { rollbackFixture } from './support/memory-rollback.ts';
import { openProbe } from '../src/probe.ts';

// Real stdin, full stdout presentation, durable owner/model planes, and a fresh process.
test('CLI selects fixed Info events, approves once, and keeps read history and receipts across restart', async () => {
  const { sandbox, probe, batch } = rollbackFixture(); probe.close();
  let cli = startCli(['remember', '--sandbox', sandbox.root]);
  try {
    await cli.waitFor('remember-ready');
    await send(cli, `info ${batch.batchId}`, 'info-read');
    const preview = await send(cli, `rollback ${batch.batchId} ${batch.events.map(event => event.eventId).join(' ')}`, 'memory-preview');
    assert.equal(preview.kind, 'rollback');
    assert.equal(preview.batchPayload, batch.payload);
    assert.deepEqual(preview.eventIds, batch.events.map(event => event.eventId));
    assert.equal(preview.command, `commit ${preview.token} rollback`);
    assert.match(String(preview.note), /重新选择|无 active|新撤销事件/);
    const committed = await send(cli, String(preview.command), 'memory-result');
    assert.equal(committed.status, 'committed');
    assert.equal((committed.receiptIds as string[]).length, 2);
    const answer = await send(cli, 'ask 合成批次偏好', 'ask-result');
    assert.deepEqual(answer.selected, []);
    assert.equal(JSON.parse(String(answer.payload)).operationSummaries.at(-1).kind, 'rollback');
    cli.command('stop'); assert.equal((await cli.exit).code, 0, cli.stderr());
    cli = startCli(['remember', '--sandbox', sandbox.root]);
    await cli.waitFor('remember-ready');
    const replay = await send(cli, `replay ${preview.token}`, 'memory-result');
    assert.deepEqual(replay.receiptIds, committed.receiptIds);
    const info = await send(cli, `info ${batch.batchId}`, 'info-view');
    const members = info.members as { eventId: string; before: { lifecycle: string }; after: { lifecycle: string }; current: { lifecycle: string } }[];
    assert.deepEqual(members.map(member => member.eventId), batch.events.map(event => event.eventId));
    assert.ok(members.every(member => member.after.lifecycle === 'active' && member.current.lifecycle === 'candidate'));
    const list = await send(cli, 'info', 'info-list');
    assert.equal((list.rows as { batchId: string; read: string }[]).find(row => row.batchId === batch.batchId)!.read, 'read');
    assert.equal((await send(cli, String(preview.command), 'memory-result')).status, 'settled');
    cli.command('stop'); assert.equal((await cli.exit).code, 0, cli.stderr());
  } finally {
    if (!cli.observations.some(row => row.event === 'process-exit')) { cli.child.kill('SIGKILL'); await cli.exit; }
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test('CLI preserves conflict/inquiry handling and exact rollback identity terminals without pending work', async () => {
  const { sandbox, probe, batch } = rollbackFixture();
  const extra = probe.store.rememberMemory(probe.activity, {
    input: probe.archive.append(randomUUID(), '记住偏好：另一个批次'), hostInfo: 'durable',
  });
  probe.close();
  const cli = startCli(['remember', '--sandbox', sandbox.root]);
  try {
    await cli.waitFor('remember-ready');
    const first = batch.events[0]!;
    for (const command of [
      `rollback ${batch.batchId}`, `rollback ${batch.batchId} ${randomUUID()}`,
      `rollback ${randomUUID()} ${first.eventId}`, `rollback ${batch.batchId} ${first.eventId} ${first.eventId}`,
      `rollback ${batch.batchId} ${first.eventId} ${extra.record.headEventId}`,
    ]) {
      const reply = await send(cli, command, 'memory-result');
      assert.equal(reply.status, 'invalid_identity', command); assert.equal(reply.canonical, 'unchanged');
    }
    for (const [command, status] of [
      [`rollback and purge ${first.recordId}`, 'conflict'],
      [`rollback 永久删除 ${first.recordId}`, 'conflict'],
      [`rollback and purge ${first.recordId}?`, 'not_actionable'],
    ]) {
      const reply = await send(cli, command!, 'memory-result');
      assert.equal(reply.status, status, command); assert.equal(reply.canonical, 'unchanged');
    }
    const other = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    try { other.store.forgetMemory(other.activity, first.recordId, first.after); } finally { other.close(); }
    const stale = await send(cli, `rollback ${batch.batchId} ${first.eventId}`, 'memory-result');
    assert.equal(stale.status, 'stale'); assert.equal(stale.canonical, 'unchanged');
    assert.equal(cli.observations.filter(row => row.event === 'memory-preview').length, 0);
    cli.command('stop'); assert.equal((await cli.exit).code, 0, cli.stderr());
    const reopened = openProbe(sandbox);
    try { assert.deepEqual(reopened.store.recoverMemoryOperations(reopened.activity), []); }
    finally { reopened.close(); }
  } finally {
    if (!cli.observations.some(row => row.event === 'process-exit')) { cli.child.kill('SIGKILL'); await cli.exit; }
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test('all 32 affected identities and restored states reach the actual next request', async () => {
  const { sandbox, probe, batch } = rollbackFixture(32); probe.close();
  const cli = startCli(['remember', '--sandbox', sandbox.root]);
  try {
    await cli.waitFor('remember-ready');
    const preview = await send(cli, `rollback ${batch.batchId} ${batch.events.map(event => event.eventId).join(' ')}`, 'memory-preview');
    assert.equal((await send(cli, String(preview.command), 'memory-result')).status, 'committed');
    const answer = await send(cli, 'ask 合成批次偏好', 'ask-result');
    const summary = JSON.parse(String(answer.payload)).operationSummaries[0];
    assert.deepEqual(summary.records.map((record: { recordId: string }) => record.recordId), batch.events.map(event => event.recordId));
    assert.ok(summary.records.every((record: { revision: number; lifecycle: string }) => record.revision === 1 && record.lifecycle === 'candidate'));
    assert.ok(Buffer.byteLength(JSON.stringify(summary)) <= 8192);
    assert.deepEqual(answer.selected, []);
    cli.command('stop'); assert.equal((await cli.exit).code, 0, cli.stderr());
  } finally {
    if (!cli.observations.some(row => row.event === 'process-exit')) { cli.child.kill('SIGKILL'); await cli.exit; }
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});
