import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createSandbox, createSandboxSession, bindingOf } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';
import { startCli } from '../src/process-driver.ts';
import type { Observation } from '../src/process-driver.ts';

type Cli = ReturnType<typeof startCli>;
async function send(cli: Cli, line: string, event: string): Promise<Observation> {
  const previous = cli.observations.filter(row => row.event === event).length;
  cli.command(line);
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const rows = cli.observations.filter(row => row.event === event);
    if (rows.length > previous) return rows[previous]!;
    assert.equal(cli.observations.some(row => row.event === 'process-exit'), false, cli.stderr());
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`missing ${event}: ${JSON.stringify(cli.observations.slice(-4))}; ${cli.stderr()}`);
}
async function stop(cli: Cli): Promise<void> {
  cli.command('stop');
  assert.equal((await cli.exit).code, 0, cli.stderr());
}

test('the CLI presents the actual correction, accepts fresh text approval and replays one unverified commit', async () => {
  const sandbox = createSandbox();
  const cli = startCli(['remember', '--sandbox', sandbox.root]);
  try {
    await cli.waitFor('remember-ready');
    const remembered = await send(cli, '记住偏好：使用 npm', 'remember-result');
    const id = String(remembered.recordId);
    const originalAnswer = await send(cli, 'ask 使用 npm', 'ask-result');
    assert.ok((originalAnswer.selected as string[]).includes(id));
    const source = await send(cli, `source ${id}`, 'memory-source');
    assert.equal(source.text, '记住偏好：使用 npm');
    const assemblyId = (originalAnswer.receipt as { assemblyId: string }).assemblyId;
    const inspected = await send(cli, `inspect ${id}`, 'memory-inspect');
    assert.equal((inspected.targets as { content: string }[])[0]!.content, '使用 npm');
    const preview = await send(cli, `correct ${id} "使用 pnpm"`, 'memory-preview');
    assert.equal(preview.content, '使用 pnpm');
    assert.equal((preview.targets as { content: string }[])[0]!.content, '使用 npm');
    assert.deepEqual(preview.diff, { before: '使用 npm', after: '使用 pnpm' });
    const result = await send(cli, `commit ${preview.token} "使用 pnpm"`, 'memory-result');
    assert.equal(result.status, 'committed');
    assert.equal(result.canonical, 'committed');
    assert.equal(result.verification, 'queued');
    const repeated = await send(cli, `commit ${preview.token} "使用 pnpm"`, 'memory-result');
    assert.equal(repeated.status, 'settled');
    assert.deepEqual(repeated.receiptIds, result.receiptIds);
    const answer = await send(cli, 'ask 包管理器', 'ask-result');
    assert.deepEqual(answer.selected, []);
    const summaries = JSON.parse(String(answer.payload)).operationSummaries;
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].status, 'committed');
    assert.equal(summaries[0].records[0].recordId, id);
    assert.equal(summaries[0].records[0].verification, 'unverified');
    assert.equal(JSON.stringify(summaries).includes('使用 pnpm'), false);
    const used = await send(cli, `used ${assemblyId} ${id}`, 'memory-used');
    assert.equal((used.memories as { snapshot: { content: string } }[])[0]!.snapshot.content, '使用 npm');
    await stop(cli);
    const probe = openProbe(sandbox);
    try {
      const record = probe.store.readMemory(probe.activity, id);
      assert.equal(record.content, '使用 pnpm');
      assert.equal(record.verification, 'unverified');
      assert.equal(record.lifecycle, 'active');
      assert.equal(probe.store.listCaptureJobs(probe.activity).filter(job => job.stage === 'pending' && job.record?.recordId === id).length, 1);
    } finally { probe.close(); }
  } finally {
    if (!cli.observations.some(row => row.event === 'process-exit')) { cli.child.kill('SIGKILL'); await cli.exit; }
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test('the actual CLI rejects confirm-only and changed text, reports supersession, cancels and detects a concurrent stale head', async () => {
  const sandbox = createSandbox();
  const cli = startCli(['remember', '--sandbox', sandbox.root]);
  try {
    await cli.waitFor('remember-ready');
    const remembered = await send(cli, '记住偏好：Original', 'remember-result');
    const id = String(remembered.recordId);
    const preview = await send(cli, `correct ${id} "First"`, 'memory-preview');
    assert.equal((await send(cli, `commit ${preview.token}`, 'memory-result')).status, 'invalid_identity');
    assert.equal((await send(cli, `commit ${preview.token} "Other"`, 'memory-result')).status, 'invalid_identity');
    assert.equal((await send(cli, `是否应该纠正 ${id}？`, 'memory-result')).status, 'not_actionable');
    assert.equal((await send(cli, `不要把 ${id} 改为「Other」`, 'memory-result')).status, 'no_op');
    const second = await send(cli, `correct ${id} "Second"`, 'memory-preview');
    assert.equal(second.supersedesOperationId, preview.operationId);
    assert.equal((await send(cli, `commit ${preview.token} "First"`, 'memory-result')).status, 'settled');
    assert.equal((await send(cli, `cancel ${second.token}`, 'memory-result')).status, 'cancelled');
    assert.equal((await send(cli, `commit ${second.token} "Second"`, 'memory-result')).status, 'settled');
    const stale = await send(cli, `correct ${id} "Third"`, 'memory-preview');
    const binding = { ...bindingOf(sandbox), sessionId: randomUUID() };
    createSandboxSession(sandbox, binding);
    const other = openProbe(sandbox, undefined, undefined, binding, undefined, true);
    try {
      const current = other.store.readMemory(other.activity, id);
      other.store.correctMemory(other.activity, id, current, other.archive.append(randomUUID(), 'Concurrent'), 'Concurrent');
    } finally { other.close(); }
    const result = await send(cli, `commit ${stale.token} "Third"`, 'memory-result');
    assert.equal(result.status, 'stale');
    assert.equal(result.canonical, 'unchanged');
    assert.deepEqual(result.receiptIds, []);
    assert.equal((result.current as { content: string }[])[0]!.content, 'Concurrent');
    await stop(cli);
  } finally {
    if (!cli.observations.some(row => row.event === 'process-exit')) { cli.child.kill('SIGKILL'); await cli.exit; }
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});
