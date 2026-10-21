import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { startCli, sendCommand as send } from '../src/process-driver.ts';
import { openProbe } from '../src/probe.ts';
import { rollbackFixture } from './support/memory-rollback.ts';

for (const point of ['before-record', 'after-record', 'after-output', 'after-commit', 'after-owner', 'after-model'])
test('batch rollback recovers without repeating a mutation at ' + point, async () => {
  const { sandbox, probe, batch } = rollbackFixture(); probe.close();
  const clients: ReturnType<typeof startCli>[] = [];
  const launch = (scenario?: string) => {
    const cli = startCli(['remember', '--sandbox', sandbox.root, ...(scenario ? ['--scenario', scenario] : [])]);
    clients.push(cli); return cli;
  };
  try {
    const command = `rollback ${batch.batchId} ${batch.events.map(event => event.eventId).join(' ')}`;
    const cli = launch('correction-' + point); await cli.waitFor('remember-ready');
    if (point.startsWith('after-') && ['after-commit', 'after-owner', 'after-model'].includes(point)) {
      const preview = await send(cli, command, 'memory-preview'); cli.command(String(preview.command));
    } else cli.command(command);
    await cli.waitFor('correction-checkpoint'); cli.child.kill('SIGKILL'); await cli.exit;
    const resumed = launch(); await resumed.waitFor('remember-ready');
    if (['before-record', 'after-record', 'after-output'].includes(point)) {
      const preview = point === 'before-record' ? await send(resumed, command, 'memory-preview')
        : resumed.observations.find(row => row.event === 'memory-preview')!;
      assert.ok(preview); assert.equal(preview.batchPayload, batch.payload);
      assert.deepEqual(preview.eventIds, batch.events.map(event => event.eventId));
      assert.equal((await send(resumed, String(preview.command), 'memory-result')).status, 'committed');
    }
    const answer = await send(resumed, 'ask 合成批次偏好', 'ask-result');
    assert.deepEqual(answer.selected, []);
    const summary = JSON.parse(String(answer.payload)).operationSummaries;
    assert.equal(summary.length, 1); assert.equal(summary[0].kind, 'rollback'); assert.equal(summary[0].recordCount, 2);
    resumed.command('stop'); assert.equal((await resumed.exit).code, 0, resumed.stderr());
    const reopened = openProbe(sandbox);
    try {
      const operation = reopened.store.recoverMemoryOperations(reopened.activity)[0]!;
      assert.equal(operation.result.status, 'committed'); assert.equal(operation.result.receiptIds.length, 2);
      assert.equal(reopened.store.rollbackReceipt(reopened.activity, operation.presentation.token).members.length, 2);
      const delivery = reopened.store.correctionDelivery(reopened.activity, operation.presentation.token);
      assert.equal(delivery.ownerDelivered, true); assert.ok(delivery.model);
      assert.equal(reopened.archive.events().filter(row => row.ack.eventId === delivery.summaryEventId).length, 1);
      for (const event of batch.events) {
        assert.equal(reopened.store.readMemory(reopened.activity, event.recordId).lifecycle, 'candidate');
        assert.equal(reopened.store.inspectMemory(reopened.activity, event.recordId).history.filter(row => row.kind === 'rollback').length, 1);
      }
    } finally { reopened.close(); }
  } finally {
    for (const cli of clients) if (!cli.observations.some(row => row.event === 'process-exit')) { cli.child.kill('SIGKILL'); await cli.exit; }
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});
