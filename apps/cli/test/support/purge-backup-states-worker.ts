import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mock } from 'node:test';
import { backupSandbox } from '../../src/backup.ts';
import { openProbe } from '../../src/probe.ts';
import { openSandbox } from '../../src/sandbox.ts';

const sandbox = openSandbox(process.argv[2]!);
const now = Date.now(), remove = fs.unlinkSync;
mock.timers.enable({ apis: ['Date'], now });
try {
  for (let day = 0; day < 3; day++) {
    mock.timers.setTime(now + day * 86400000);
    const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    try { probe.archive.append(randomUUID(), 'Independent backup data version ' + day); } finally { probe.close(); }
    if (day === 2) {
      fs.unlinkSync = () => { throw new Error('injected-retention-unlink-failure'); };
      syncBuiltinESMExports();
    }
    try { await backupSandbox(sandbox); }
    catch (error) { if (day !== 2 || (error as Error).message !== 'injected-retention-unlink-failure') throw error; }
  }
} finally { fs.unlinkSync = remove; syncBuiltinESMExports(); mock.timers.reset(); }
const db = new DatabaseSync(join(sandbox.root, 'probe.sqlite'), { readOnly: true });
try { console.log(JSON.stringify({ snapshots: db.prepare('SELECT kind,state FROM store_snapshots').all() })); }
finally { db.close(); }
