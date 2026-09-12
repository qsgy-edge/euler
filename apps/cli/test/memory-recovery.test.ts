import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createSandbox } from '../src/sandbox.ts';
import { startCli } from '../src/process-driver.ts';
import type { MemoryOperation, MemoryRecord } from '@euler/core';

for (const scenario of ['crash-in-transaction', 'crash-after-commit']) {
  test(`a killed writer at ${scenario} is reconciled before any retry`, { timeout: 15000 }, async () => {
    const sandbox = createSandbox();
    let writer: ReturnType<typeof startCli> | undefined;
    try {
      const setup = startCli(['memory', '--sandbox', sandbox.root]);
      assert.equal((await setup.exit).code, 0);
      const original = (setup.observations.find(row => row.event === 'memory-result')!.activated as MemoryOperation).record;
      writer = startCli(['memory-worker', '--scenario', scenario, '--sandbox', sandbox.root]);
      const ready = await writer.waitFor('memory-ready');
      writer.command('commit');
      const checkpoint = await writer.waitFor('memory-checkpoint');
      assert.equal(checkpoint.stage, scenario === 'crash-in-transaction' ? 'uncommitted' : 'committed-before-ack');
      writer.child.kill('SIGKILL');
      const terminated = await writer.exit;
      assert.notEqual(terminated.code, 0);
      assert.equal(writer.observations.some(row => row.event === 'memory-written'), false);
      const recovery = startCli(['memory-reconcile', '--sandbox', sandbox.root, '--record', original.recordId, '--request', String(ready.requestHash)]);
      assert.equal((await recovery.exit).code, 0);
      const observation = recovery.observations.find(row => row.event === 'memory-reconciled')!;
      const recovered = observation.recovered as MemoryRecord;
      if (scenario === 'crash-in-transaction') {
        assert.equal(observation.operation, null);
        assert.deepEqual(recovered, original);
      } else {
        const operation = observation.operation as MemoryOperation;
        assert.deepEqual(recovered, operation.record);
        assert.equal(operation.record.content, 'Synthetic corrected memory');
        assert.notEqual(operation.eventId, original.headEventId);
      }
      const db = new DatabaseSync(`${sandbox.root}/probe.sqlite`, { readOnly: true });
      try {
        const committed = scenario === 'crash-after-commit' ? 1 : 0;
        assert.equal(db.prepare('SELECT count(*) AS n FROM memory_revisions').get()!.n, 1 + committed);
        assert.equal(db.prepare('SELECT count(*) AS n FROM memory_events').get()!.n, 3 + committed);
        assert.equal(db.prepare('SELECT count(*) AS n FROM projection_jobs').get()!.n, 4 + committed);
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      } finally { db.close(); }
    } finally {
      if (writer && writer.child.exitCode === null && writer.child.signalCode === null) { writer.child.kill('SIGKILL'); await writer.exit; }
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  });
}

for (const scenario of ['compete', 'crash-after-commit']) {
test(`two real writers compete (${scenario}); each request reconciles only its own outcome`, { timeout: 15000 }, async () => {
  const sandbox = createSandbox();
  const writers: ReturnType<typeof startCli>[] = [];
  try {
    const setup = startCli(['memory', '--sandbox', sandbox.root]);
    assert.equal((await setup.exit).code, 0);
    writers.push(startCli(['memory-worker', '--scenario', scenario, '--sandbox', sandbox.root]),
      startCli(['memory-worker', '--scenario', scenario, '--sandbox', sandbox.root]));
    const ready = await Promise.all(writers.map(writer => writer.waitFor('memory-ready')));
    assert.deepEqual(ready[0]!.expected, ready[1]!.expected);
    assert.notEqual(ready[0]!.requestHash, ready[1]!.requestHash);
    for (const writer of writers) writer.command('commit');
    if (scenario === 'crash-after-commit') {
      const checkpoints = await Promise.allSettled(writers.map(writer => writer.waitFor('memory-checkpoint')));
      assert.equal(checkpoints.filter(result => result.status === 'fulfilled').length, 1);
      for (const [index, result] of checkpoints.entries()) if (result.status === 'fulfilled') writers[index]!.child.kill('SIGKILL');
    }
    const exits = await Promise.all(writers.map(writer => writer.exit));
    if (scenario === 'compete') assert.deepEqual(exits.map(exit => exit.code).sort(), [0, 1]);
    else assert.equal(exits.every(exit => exit.code !== 0), true);
    const outputs = writers.flatMap(writer => writer.observations);
    assert.equal(outputs.filter(row => row.event === 'memory-written').length, scenario === 'compete' ? 1 : 0);
    assert.equal(outputs.filter(row => row.event === 'error' && row.reason === 'memory-stale').length, 1);
    const db = new DatabaseSync(`${sandbox.root}/probe.sqlite`, { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT count(*) AS n FROM memory_records').get()!.n, 1);
      assert.equal(db.prepare('SELECT count(*) AS n FROM memory_revisions').get()!.n, 2);
      assert.equal(db.prepare('SELECT count(*) AS n FROM memory_events').get()!.n, 4);
      assert.equal(db.prepare('SELECT count(*) AS n FROM projection_jobs').get()!.n, 5);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { db.close(); }
    const original = ready[0]!.expected as MemoryRecord;
    for (const [index, writer] of writers.entries()) {
      const lookup = startCli(['memory-reconcile', '--sandbox', sandbox.root, '--record', original.recordId, '--request', String(ready[index]!.requestHash)]);
      assert.equal((await lookup.exit).code, 0);
      const observation = lookup.observations.find(row => row.event === 'memory-reconciled')!;
      const lost = writer.observations.some(row => row.event === 'error' && row.reason === 'memory-stale');
      if (lost) assert.equal(observation.operation, null);
      else assert.deepEqual((observation.operation as MemoryOperation).record, observation.recovered);
    }
    const recovered = startCli(['recover', '--sandbox', sandbox.root]);
    assert.equal((await recovered.exit).code, 0);
    assert.equal((recovered.observations.find(row => row.event === 'recovered')!.memories as MemoryRecord[])[0]!.content, 'Synthetic corrected memory');
  } finally {
    for (const writer of writers) {
      if (writer.child.exitCode === null && writer.child.signalCode === null) writer.child.kill('SIGKILL');
      await writer.exit;
    }
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});
}
