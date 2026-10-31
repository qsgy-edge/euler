import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { startCli, sendCommand } from '../src/process-driver.ts';
import { createSandbox } from '../src/sandbox.ts';
import type { PurgeManifest } from '@euler/core';

function run(args: string[]) {
  const child = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  return child.stdout.trim().split('\n').map(line => JSON.parse(line));
}

for (const scenario of ['shared', 'operations', 'rollback', 'discovery', 'handoff', 'historian', 'conflict', 'identity', 'bracket-text'])
test(`controlled completion closes the enabled ${scenario} path without resurrecting its source, token or job`, async () => {
  const sandbox = createSandbox();
  if (scenario === 'historian') run(['apps/cli/src/main.ts', 'historian', '--sandbox', sandbox.root]);
  const fixture = run(['apps/cli/test/support/purge-worker.ts', sandbox.root, scenario]).at(-1);
  const cli = startCli(['purge', '--sandbox', sandbox.root, '--record', fixture.recordId]);
  try {
    const preview = await cli.waitFor('purge-preview'), manifest = preview.manifest as PurgeManifest;
    const db = new DatabaseSync(join(sandbox.root, 'probe.sqlite'), { readOnly: true });
    const selected = (table: string, column: string) => (manifest.database.find(item => item.table === table)?.rows ?? [])
      .map(row => String(db.prepare(`SELECT ${column} FROM ${table} WHERE rowid=?`).get(row.rowid)![column]));
    const tokens = selected('host_presentations', 'token'), jobs = selected('capture_jobs', 'job_id');
    db.close();
    await sendCommand(cli, String(preview.phrase), 'purge-result');
    const result = await sendCommand(cli, 'cleanup', 'purge-result');
    assert.equal(result.status, 'controlled-complete', JSON.stringify(result));
    assert.equal((await cli.exit).code, 0, cli.stderr());
    for (const name of readdirSync(sandbox.root)) assert.equal(readFileSync(join(sandbox.root, name)).includes(Buffer.from(fixture.target.content)), false, name);
    const verification = run(['apps/cli/test/support/purge-complete-worker.ts', sandbox.root,
      JSON.stringify({ target: fixture.target, otherId: fixture.otherId, removeOther: scenario === 'conflict', tokens, jobs,
        sources: [fixture.target.source, ...fixture.documents] })]).at(-1);
    assert.equal(verification.event, 'purge-non-resurrection');
    assert.equal(verification.canaryHits, 0);
  } finally {
    if (cli.child.exitCode === null && cli.child.signalCode === null) cli.child.kill();
    await cli.exit; rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test('the real purge CLI completes once, survives restart and permits a clean normal run and backup', async () => {
  const sandbox = createSandbox();
  const fixture = run(['apps/cli/test/support/purge-worker.ts', sandbox.root]).at(-1);
  const cli = startCli(['purge', '--sandbox', sandbox.root, '--record', fixture.recordId]);
  try {
    const preview = await cli.waitFor('purge-preview');
    const logical = await sendCommand(cli, String(preview.phrase), 'purge-result');
    assert.equal(logical.status, 'logical-commit');
    const result = await sendCommand(cli, 'cleanup', 'purge-result');
    assert.equal(result.status, 'controlled-complete');
    assert.equal(result.operationId, logical.operationId);
    assert.equal((await cli.exit).code, 0, cli.stderr());
    for (const name of readdirSync(sandbox.root)) assert.equal(readFileSync(join(sandbox.root, name)).includes(Buffer.from(fixture.target.content)), false, name);
    const repeated = run(['apps/cli/src/main.ts', 'purge', '--sandbox', sandbox.root]).at(-1);
    assert.deepEqual(repeated.receipt, result.receipt);
    assert.ok(run(['apps/cli/src/main.ts', 'run', '--sandbox', sandbox.root]).some(row => row.event === 'run-result' && row.sends === 1));
    const backup = run(['apps/cli/src/main.ts', 'backup', '--sandbox', sandbox.root]).find(row => row.event === 'backup-result');
    assert.equal(backup.status, 'created');
    const db = new DatabaseSync(join(sandbox.root, 'probe.sqlite'), { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT count(*) n FROM memory_events WHERE kind='purge-controlled-complete'").get()!.n, 1);
      assert.equal(db.prepare('SELECT state FROM owner_fences').get()!.state, 'open');
      assert.equal(db.prepare('SELECT count(*) n FROM memory_records WHERE record_id=?').get(fixture.otherId)!.n, 1);
    } finally { db.close(); }
  } finally {
    if (cli.child.exitCode === null && cli.child.signalCode === null) cli.child.kill();
    await cli.exit;
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});
