import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { openMaintenanceStore } from '../../src/backup.ts';
import { readPurgeCarriers } from '../../src/purge.ts';
import { openSandbox } from '../../src/sandbox.ts';

const [root, recordId, fault] = process.argv.slice(2), sandbox = openSandbox(root!);
const store = openMaintenanceStore(sandbox), coordinator = randomUUID();
try {
  store.beginMaintenance(coordinator);
  const acquired = store.acquireMaintenance(coordinator);
  if (fault === 'acquire') console.log(JSON.stringify(acquired));
  else {
    assert.equal(acquired.acquired, true);
    const carriers = readPurgeCarriers(sandbox, store, coordinator);
    const preview = store.previewPurge(coordinator, recordId!, carriers);
    store.acknowledgePurgePresentation(coordinator, preview.token, preview.digest);
    store.commitPurge(coordinator, store.receivePurgeInput(coordinator, preview.phrase), preview.token, carriers);
    assert.throws(() => store.cleanupPurgeOutputs(coordinator, selection => {
      if (fault === 'before') throw new Error('injected-rule-write-interruption');
      const range = selection.ruleCleanup!.ranges[0]!, fd = openSync(selection.file.path, 'r+');
      try {
        const short = fault === 'complete' ? range.bytes : Math.floor(range.bytes / 2);
        assert.equal(writeSync(fd, Buffer.alloc(short, 32), 0, short, range.offset), short); fsyncSync(fd);
      } finally { closeSync(fd); }
      throw new Error('injected-rule-write-interruption');
    }), /injected-rule-write-interruption/);
    assert.equal(store.purgeStatus(coordinator)!.cleanup, 'incomplete');
  }
} finally { store.close(); }
