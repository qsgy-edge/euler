import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';
import { startCli, sendCommand as send } from '../src/process-driver.ts';
import type { Observation } from '../src/process-driver.ts';

type Cli = ReturnType<typeof startCli>;
async function kill(cli: Cli) { cli.child.kill('SIGKILL'); await cli.exit; }
async function stop(cli: Cli) { cli.command('stop'); assert.equal((await cli.exit).code, 0, cli.stderr()); }
function seed() {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const record = probe.store.rememberMemory(probe.activity, { input: probe.archive.append(randomUUID(), '记住偏好：Original'), hostInfo: 'durable' }).record;
    return { sandbox, record };
  } finally { probe.close(); }
}

for (const stage of ['before-record', 'after-record', 'after-output', 'after-commit', 'after-owner', 'after-model']) {
  test(`CLI crash ${stage} recovers the same operation and requires fresh input for an uncommitted preview`, async () => {
    const { sandbox, record } = seed();
    const clients: Cli[] = [];
    try {
      const cli = startCli(['remember', '--sandbox', sandbox.root, '--scenario', `correction-${stage}`]); clients.push(cli);
      await cli.waitFor('remember-ready');
      const previewStage = ['before-record', 'after-record', 'after-output'].includes(stage);
      let preview: Observation | undefined;
      if (previewStage) cli.command(`correct ${record.recordId} "Corrected"`);
      else {
        preview = await send(cli, `correct ${record.recordId} "Corrected"`, 'memory-preview');
        cli.command(`commit ${preview.token} "Corrected"`);
      }
      await cli.waitFor('correction-checkpoint'); await kill(cli);
      let probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
      let receiptBytes: string | null = null;
      try {
        const operations = probe.store.recoverMemoryOperations(probe.activity);
        assert.equal(operations.length, stage === 'before-record' ? 0 : 1);
        if (!previewStage) {
          assert.equal(operations[0]!.result.status, 'committed');
          receiptBytes = JSON.stringify(probe.store.readOwnerReceipt(probe.activity, operations[0]!.result.receiptIds[0]!));
        } else assert.equal(probe.store.readMemory(probe.activity, record.recordId).content, 'Original');
      } finally { probe.close(); }
      const resumed = startCli(['remember', '--sandbox', sandbox.root]); clients.push(resumed);
      await resumed.waitFor('remember-ready');
      if (previewStage) {
        const shown = stage === 'before-record'
          ? await send(resumed, `correct ${record.recordId} "Corrected"`, 'memory-preview')
          : resumed.observations.find(row => row.event === 'memory-preview')!;
        assert.equal(shown.content, 'Corrected');
        const committed = await send(resumed, `commit ${shown.token} "Corrected"`, 'memory-result');
        assert.equal(committed.status, 'committed');
      } else {
        assert.equal(resumed.observations.filter(row => row.event === 'memory-owner-entry').length, stage === 'after-commit' ? 1 : 0);
        assert.equal(resumed.observations.filter(row => row.event === 'memory-model-summary').length, stage === 'after-model' ? 0 : 1);
        const replay = await send(resumed, `replay ${preview!.token}`, 'memory-result');
        assert.equal(replay.status, 'committed');
        const owner = resumed.observations.filter(row => row.event === 'memory-owner-entry').at(-1)!;
        assert.equal(JSON.stringify((owner.receipts as unknown[])[0]), receiptBytes);
        assert.equal((await send(resumed, `commit ${preview!.token} "Corrected"`, 'memory-result')).status, 'settled');
      }
      const answer = await send(resumed, 'ask preferences', 'ask-result');
      assert.equal(JSON.parse(String(answer.payload)).operationSummaries[0].status, 'committed');
      await stop(resumed);
      probe = openProbe(sandbox);
      try {
        assert.equal(probe.store.readMemory(probe.activity, record.recordId).revision, 2);
        const operations = probe.store.recoverMemoryOperations(probe.activity);
        assert.equal(operations.length, 1);
        assert.equal(operations[0]!.result.receiptIds.length, 1);
        assert.equal(probe.store.correctionDeliveries(probe.activity).filter(row => row.delivery.ownerDelivered && row.delivery.model).length, 1);
      } finally { probe.close(); }
    } finally {
      for (const cli of clients) if (!cli.observations.some(row => row.event === 'process-exit')) await kill(cli);
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  });
}

test('a failed first presentation never grants approval and restart presents the full body', async () => {
  const { sandbox, record } = seed();
  const clients: Cli[] = [];
  try {
    const cli = startCli(['remember', '--sandbox', sandbox.root, '--scenario', 'correction-preview-unavailable']); clients.push(cli);
    await cli.waitFor('remember-ready');
    assert.equal((await send(cli, `correct ${record.recordId} "Corrected"`, 'memory-result')).status, 'unavailable');
    const probe = openProbe(sandbox);
    let token: string;
    try { token = probe.store.recoverMemoryOperations(probe.activity)[0]!.presentation.token; } finally { probe.close(); }
    assert.equal((await send(cli, `commit ${token} "Corrected"`, 'memory-result')).status, 'unavailable');
    await stop(cli);
    const resumed = startCli(['remember', '--sandbox', sandbox.root]); clients.push(resumed);
    await resumed.waitFor('remember-ready');
    const shown = resumed.observations.find(row => row.event === 'memory-preview')!;
    assert.deepEqual(shown.diff, { before: 'Original', after: 'Corrected' });
    assert.equal((await send(resumed, `commit ${shown.token} "Corrected"`, 'memory-result')).status, 'committed');
    await stop(resumed);
  } finally {
    for (const cli of clients) if (!cli.observations.some(row => row.event === 'process-exit')) await kill(cli);
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

for (const plane of ['owner', 'model']) test(`a failed ${plane} delivery preserves committed receipt and blocks dispatch until recovery`, async () => {
  const { sandbox, record } = seed();
  const cli = startCli(['remember', '--sandbox', sandbox.root]);
  const db = new DatabaseSync(join(sandbox.root, 'probe.sqlite'));
  db.exec('PRAGMA busy_timeout=2000');
  try {
    await cli.waitFor('remember-ready');
    const preview = await send(cli, `correct ${record.recordId} "Corrected"`, 'memory-preview');
    db.exec(`CREATE TRIGGER fail_delivery BEFORE UPDATE ON host_operation_delivery
      WHEN ${plane === 'owner' ? 'NEW.owner_ack=1' : 'NEW.model_source IS NOT NULL'}
      BEGIN SELECT RAISE(ABORT,'injected-delivery-failure'); END;`);
    const result = await send(cli, `commit ${preview.token} "Corrected"`, 'memory-result');
    assert.equal(result.status, 'error'); assert.equal(result.canonical, 'committed');
    assert.equal((await send(cli, 'ask state', 'ask-refused')).reason, 'operation-presentation-recovery-required');
    assert.equal(cli.observations.filter(row => row.event === 'ask-result').length, 0);
    const before = db.prepare('SELECT receipt_payload FROM memory_events WHERE operation_id=?').get(String(preview.operationId))!.receipt_payload;
    db.exec('DROP TRIGGER fail_delivery');
    const answer = await send(cli, 'ask state', 'ask-result');
    assert.equal(JSON.parse(String(answer.payload)).operationSummaries.length, 1);
    assert.equal(db.prepare('SELECT receipt_payload FROM memory_events WHERE operation_id=?').get(String(preview.operationId))!.receipt_payload, before);
    await stop(cli);
    const probe = openProbe(sandbox);
    try {
      const delivery = probe.store.correctionDelivery(probe.activity, String(preview.token));
      assert.equal(probe.archive.events().filter(row => row.ack.eventId === delivery.summaryEventId).length, 1);
      assert.equal(probe.store.readMemory(probe.activity, record.recordId).revision, 2);
    } finally { probe.close(); }
  } finally {
    db.close(); if (!cli.observations.some(row => row.event === 'process-exit')) await kill(cli);
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test('unknown commit acknowledgement is queried before returning the immutable result', async () => {
  const { sandbox, record } = seed();
  const cli = startCli(['remember', '--sandbox', sandbox.root, '--scenario', 'correction-unknown']);
  try {
    await cli.waitFor('remember-ready');
    const preview = await send(cli, `correct ${record.recordId} "Corrected"`, 'memory-preview');
    const result = await send(cli, `commit ${preview.token} "Corrected"`, 'memory-result');
    assert.equal(result.status, 'committed');
    assert.equal((await send(cli, `commit ${preview.token} "Corrected"`, 'memory-result')).receiptIds?.toString(), result.receiptIds?.toString());
    await stop(cli);
    const probe = openProbe(sandbox);
    try { assert.equal(probe.store.readMemory(probe.activity, record.recordId).revision, 2); } finally { probe.close(); }
  } finally {
    if (!cli.observations.some(row => row.event === 'process-exit')) await kill(cli);
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});
