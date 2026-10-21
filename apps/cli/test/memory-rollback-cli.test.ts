import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { startCli, sendCommand as send } from '../src/process-driver.ts';
import { rollbackFixture } from './support/memory-rollback.ts';

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
