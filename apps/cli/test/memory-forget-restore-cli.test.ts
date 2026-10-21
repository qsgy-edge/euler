import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { createSandbox } from '../src/sandbox.ts';
import { startCli, sendCommand as send } from '../src/process-driver.ts';

test('CLI forget removes normal retrieval and injection across restart; history and separately approved restore survive', async () => {
  const sandbox = createSandbox();
  let cli = startCli(['remember', '--sandbox', sandbox.root]);
  try {
    await cli.waitFor('remember-ready');
    const remembered = await send(cli, '记住偏好：使用 npm', 'remember-result');
    const id = String(remembered.recordId);
    const before = await send(cli, 'ask 使用 npm', 'ask-result');
    assert.ok((before.selected as string[]).includes(id));
    const inspected = await send(cli, `inspect ${id}`, 'memory-inspect');
    const preview = await send(cli, `forget ${id}`, 'memory-preview');
    assert.deepEqual(preview.targets, inspected.targets);
    assert.equal(preview.kind, 'forget');
    assert.match(String(preview.note), /历史/);
    assert.equal(preview.command, `commit ${preview.token} forget`);
    const forgotten = await send(cli, String(preview.command), 'memory-result');
    assert.equal(forgotten.status, 'committed');
    assert.equal(forgotten.canonical, 'committed');
    const after = await send(cli, 'ask 使用 npm', 'ask-result');
    assert.deepEqual(after.selected, []);
    assert.deepEqual(JSON.parse(String(after.payload)).memories ?? [], []);
    assert.equal(JSON.parse(String(after.payload)).operationSummaries.at(-1).kind, 'forget');
    assert.equal((await send(cli, '记住偏好：使用 npm', 'remember-result')).reason, 'memory-suppressed');
    const used = await send(cli, `used ${(before.receipt as { assemblyId: string }).assemblyId} ${id}`, 'memory-used');
    assert.equal((used.memories as { snapshot: { content: string } }[])[0]!.snapshot.content, '使用 npm');
    cli.command('stop'); assert.equal((await cli.exit).code, 0, cli.stderr());
    cli = startCli(['remember', '--sandbox', sandbox.root]);
    await cli.waitFor('remember-ready');
    assert.deepEqual((await send(cli, 'ask 使用 npm', 'ask-result')).selected, []);
    const replay = await send(cli, `replay ${preview.token}`, 'memory-result');
    assert.deepEqual(replay.receiptIds, forgotten.receiptIds);
    const restore = await send(cli, `restore ${id}`, 'memory-preview');
    assert.equal(restore.kind, 'restore');
    assert.notEqual(restore.token, preview.token);
    const restored = await send(cli, String(restore.command), 'memory-result');
    assert.equal(restored.status, 'committed');
    const answer = await send(cli, 'ask 使用 npm', 'ask-result');
    assert.ok((answer.selected as string[]).includes(id));
    const current = await send(cli, `inspect ${id}`, 'memory-inspect');
    const original = (inspected.targets as { headEventId: string; revisionId: string }[])[0]!;
    const final = (current.targets as { headEventId: string; revisionId: string }[])[0]!;
    assert.equal(final.revisionId, original.revisionId);
    assert.notEqual(final.headEventId, original.headEventId);
    cli.command('stop'); assert.equal((await cli.exit).code, 0, cli.stderr());
  } finally {
    if (!cli.observations.some(row => row.event === 'process-exit')) { cli.child.kill('SIGKILL'); await cli.exit; }
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});
