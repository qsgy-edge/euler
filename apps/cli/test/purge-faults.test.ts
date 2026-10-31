import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { startCli, sendCommand } from '../src/process-driver.ts';
import { CountingTransport } from '../src/probe.ts';
import { createSandbox } from '../src/sandbox.ts';
import fixture from '../../../fixtures/t22b-controlled-cleanup.json' with { type: 'json' };

for (const point of fixture.faults) test(`purge resumes the same approved operation at ${point}`, {
  skip: point.startsWith('output') && process.platform !== 'win32',
}, async () => {
  const sandbox = createSandbox(), children: ReturnType<typeof startCli>[] = [];
  let project: string | undefined;
  const run = (args: string[]) => {
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split('\n').map(line => JSON.parse(line));
  };
  try {
    if (point.startsWith('output')) {
      project = realpathSync.native(mkdtempSync(join(tmpdir(), 'euler-purge-fault-project-')));
      run(['apps/cli/test/support/backup-file-worker.ts', sandbox.root, project]);
    }
    const fixture = run(['apps/cli/test/support/purge-worker.ts', sandbox.root, project ? 'project-output' : 'separate']).at(-1);
    new CountingTransport(sandbox).send(fixture.target.content, { attemptId: randomUUID(), runId: randomUUID(),
      payloadHash: fixture.target.contentHash, byteLength: Buffer.byteLength(fixture.target.content) });
    const backup = run(['apps/cli/src/main.ts', 'backup', '--sandbox', sandbox.root]).find(row => row.event === 'backup-result').snapshot;
    const first = startCli(['purge', '--sandbox', sandbox.root, '--record', fixture.recordId]); children.push(first);
    const preview = await first.waitFor('purge-preview');
    const committed = await sendCommand(first, String(preview.phrase), 'purge-result');
    first.child.stdin.end(); assert.equal((await first.exit).code, 0);
    const fault = startCli(['purge', '--sandbox', sandbox.root], undefined, undefined, { ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${new URL('./support/purge-fault-hook.ts', import.meta.url).href}`,
      EULER_PURGE_TEST_POINT: point }); children.push(fault);
    assert.deepEqual((await fault.waitFor('purge-result')).receipt, committed.receipt);
    if (point === 'info-enospc' || point === 'sqlite-full') {
      const incomplete = await sendCommand(fault, 'cleanup', 'purge-result');
      assert.equal(incomplete.outcome, 'known-committed');
      assert.equal(incomplete.cleanup, 'incomplete');
      assert.match(String(incomplete.error), /injected-/);
      fault.child.stdin.end(); assert.equal((await fault.exit).code, 0);
    } else {
      fault.command('cleanup');
      assert.equal((await fault.waitFor('purge-fault')).point, point);
      const stopped = await fault.exit;
      assert.ok(stopped.signal === 'SIGKILL' || stopped.code !== 0);
    }
    const db = new DatabaseSync(join(sandbox.root, 'probe.sqlite'), { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT count(*) n FROM memory_events WHERE kind='purge-logical-commit'").get()!.n, 1);
      assert.equal(db.prepare("SELECT count(*) n FROM memory_events WHERE kind='purge-controlled-complete'").get()!.n, point === 'completion-after' ? 1 : 0);
      assert.equal(db.prepare('SELECT state FROM owner_fences').get()!.state, point === 'completion-after' ? 'open' : 'cleaning');
      if (['scrub-after', 'vacuum-before', 'vacuum-after', 'completion-before', 'sqlite-full'].includes(point)) {
        const progress = db.prepare("SELECT continuation,presentation_hash FROM pending_operations WHERE kind='purge'").get()!;
        assert.equal(progress.presentation_hash, null);
        assert.equal(String(progress.continuation).includes('sqlite-maintenance'), true);
        for (const sensitive of [fixture.target.contentHash, fixture.target.source.locator, backup.directory.path])
          assert.equal(String(progress.continuation).includes(sensitive), false);
      }
    } finally { db.close(); }
    const resumed = startCli(['purge', '--sandbox', sandbox.root]); children.push(resumed);
    let final = await resumed.waitFor('purge-result');
    if (point !== 'completion-after') {
      assert.deepEqual(final.receipt, committed.receipt);
      assert.equal(resumed.observations.some(row => row.event === 'purge-preview'), false);
      final = await sendCommand(resumed, 'cleanup', 'purge-result');
    }
    assert.equal(final.status, 'controlled-complete', JSON.stringify(final));
    assert.equal(final.operationId, committed.operationId);
    assert.equal((await resumed.exit).code, 0, resumed.stderr());
    assert.equal(existsSync(backup.directory.path), false);
    if (project) assert.equal(existsSync(join(project, 'result.md')), false);
    for (const name of readdirSync(sandbox.root)) assert.equal(readFileSync(join(sandbox.root, name)).includes(Buffer.from(fixture.target.content)), false, name);
  } finally {
    for (const child of children) {
      if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill();
      await child.exit;
    }
    rmSync(sandbox.root, { recursive: true, force: true });
    if (project) rmSync(project, { recursive: true, force: true });
  }
});
