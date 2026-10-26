import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';
import { runBackupCli } from './support/backup-cli.ts';
import { seedBackupOperations, corruptBackupOperation } from './support/backup-operations.ts';

for (const fault of ['presentation-hash', 'presentation-target', 'operation-hash', 'operation-receipts', 'approval-hash', 'model-hash', 'model-summary']) {
  test(`backup rejects memory operation corruption: ${fault}`, () => {
    const sandbox = createSandbox();
    try {
      const seed = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
      let saved: ReturnType<typeof seedBackupOperations>;
      try { saved = seedBackupOperations(seed, sandbox.fixture.projectId); } finally { seed.close(); }
      assert.equal(saved.result.status, 'committed');
      corruptBackupOperation(sandbox.root, saved.committed.token, fault);
      const db = new DatabaseSync(join(sandbox.root, 'probe.sqlite'), { readOnly: true });
      try {
        assert.deepEqual(db.prepare('PRAGMA quick_check').all().map(row => row.quick_check), ['ok']);
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      } finally { db.close(); }
      const expected = fault === 'presentation-hash' ? /invalid-presentation-identity/ : fault === 'presentation-target' ? /presentation-evidence-gap/
        : fault.startsWith('operation-') ? /operation-evidence-gap/ : fault === 'model-summary' ? /operation-summary-mismatch/ : /operation-delivery-evidence-gap/;
      const reader = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
      try {
        assert.throws(() => fault === 'model-summary' ? reader.store.correctionModelSummaries(reader.activity)
          : ['approval-hash','model-hash'].includes(fault) ? reader.store.correctionDelivery(reader.activity, saved.committed.token)
          : reader.store.memoryOperationStatus(reader.activity, saved.committed.token), expected);
      } finally { reader.close(); }
      const backed = runBackupCli(sandbox.root, 'backup');
      assert.equal(backed.status, 1, backed.stdout + backed.stderr);
      assert.match(backed.events.find(event => event.event === 'error').reason, expected);
    } finally { rmSync(sandbox.root, { recursive: true, force: true }); }
  });
}

test('recovery preserves settled and pending operation readers across projects without sharing tokens', () => {
  const sandbox = createSandbox();
  const worker = (action: string, value?: string) => {
    const result = spawnSync(process.execPath, ['apps/cli/test/support/backup-worker.ts', sandbox.root, action, ...(value ? [value] : [])], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  try {
    const history = worker('seed-operations') as { binding: unknown; saved: ReturnType<typeof seedBackupOperations> }[];
    const request = JSON.stringify(history.map(({ binding, saved }) => ({ binding, committedToken: saved.committed.token,
      pendingToken: saved.pending.token, receiptId: saved.result.receiptIds[0] })));
    const backed = runBackupCli(sandbox.root, 'backup');
    assert.equal(backed.status, 0, backed.stdout + backed.stderr);
    const snapshotId = backed.events.find(event => event.event === 'backup-result').snapshot.id;
    assert.ok(worker('advance-operations', request).every((result: { status: string }) => result.status === 'committed'));
    const restored = runBackupCli(sandbox.root, 'restore-snapshot', ['--snapshot', snapshotId]);
    assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    const recovered = worker('read-operations', request);
    for (const [index, { saved: before }] of history.entries()) {
      const actual = recovered[index];
      assert.deepEqual(actual.presentation, before.committed);
      assert.deepEqual(actual.result, before.result);
      assert.equal(actual.pending.status, 'pending');
      assert.deepEqual(actual.delivery, before.delivery);
      assert.deepEqual(actual.summaries, [before.summary]);
      assert.equal(actual.foreign.presentation.error, 'invalid-presentation-identity');
      assert.equal(actual.foreign.operation.status, 'invalid_identity');
      assert.equal(actual.foreign.receipt.error, 'invalid-memory-scope');
      assert.equal(actual.sends, 0);
    }
  } finally { rmSync(sandbox.root, { recursive: true, force: true }); }
});
