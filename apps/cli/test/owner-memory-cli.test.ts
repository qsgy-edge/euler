import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { sha256 } from '@euler/core';
import { OwnerInfoLog } from '../src/owner-memory.ts';
import { startCli } from '../src/process-driver.ts';
import type { Observation } from '../src/process-driver.ts';
import { createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

type Cli = ReturnType<typeof startCli>;
async function nth(cli: Cli, event: string, index: number, timeoutMs = 20000): Promise<Observation> {
  const started = Date.now();
  for (;;) {
    const hits = cli.observations.filter(item => item.event === event);
    if (hits.length > index) return hits[index]!;
    if (cli.observations.some(item => item.event === 'process-exit')) throw new Error(`exited before ${event}#${index}: ${cli.stderr()}`);
    if (Date.now() - started > timeoutMs) throw new Error(`timeout ${event}#${index}: ${cli.stderr()}; ${JSON.stringify(cli.observations.slice(-3))}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function send(cli: Cli, line: string, event: string): Promise<Observation> {
  const index = cli.observations.filter(item => item.event === event).length;
  cli.command(line);
  return nth(cli, event, index);
}
async function stop(cli: Cli): Promise<void> {
  cli.command('stop');
  assert.equal((await cli.exit).code, 0, cli.stderr());
}
const entries = (root: string) => readFileSync(join(root, 'owner-info.jsonl'), 'utf8').trimEnd().split('\n').slice(1).map(line => JSON.parse(line));
const only = (cli: Cli, event: string, where: (item: Observation) => boolean = () => true) => cli.observations.filter(item => item.event === event && where(item));

test('an oversized owner entry is rejected before writing and leaves prior Info readable', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const remembered = probe.store.rememberMemory(probe.activity, {
      input: probe.archive.append(randomUUID(), '记住偏好：使用 pnpm'), hostInfo: 'durable' });
    const batch = probe.store.readActivationBatch(probe.activity, remembered.batchId!);
    const log = new OwnerInfoLog(sandbox, action => probe.store.withActivity(probe.activity, action), () => assert.fail('unexpected torn tail'));
    const entry = log.append(batch);
    const before = readFileSync(log.path);
    const payload = 'x'.repeat(4_194_304);
    assert.throws(() => log.append({ ...batch, batchId: randomUUID(), payload, digest: sha256(payload) }), /owner-info-limit/);
    assert.deepEqual(readFileSync(log.path), before);
    assert.deepEqual(new OwnerInfoLog(sandbox, action => probe.store.withActivity(probe.activity, action), () => assert.fail('unexpected torn tail')).entries(), [entry]);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('an owner remembers, agrees and reads Info in the actual CLI without Info identities reaching the model', async () => {
  const sandbox = createSandbox();
  const clients: Cli[] = [];
  try {
    const cli = startCli(['remember', '--sandbox', sandbox.root, '--synthetic-proposals']); clients.push(cli);
    const ready = await cli.waitFor('remember-ready');
    assert.deepEqual([ready.hostInfo, ready.pending, ready.unread], ['durable', 0, 0]);
    const preference = await send(cli, '记住偏好：包管理器使用 pnpm', 'remember-result');
    assert.deepEqual([preference.status, preference.stage, preference.type, preference.content, preference.verifier, preference.info, preference.level],
      ['activated', 'active', 'preference', '包管理器使用 pnpm', 'owner-fast-lane@1', 'delivered', 'info']);
    const [notice] = only(cli, 'info-notice', item => item.batchId === preference.batchId);
    assert.deepEqual([notice?.authoritative, notice?.read, notice?.delivery], [false, 'unread', 'delivered']);
    const proposal = await send(cli, 'propose 我看了项目配置。\\n建议记住决定：本项目使用 SQLite WAL', 'assistant-proposal');
    assert.deepEqual([proposal.synthetic, proposal.actionable], [true, true]);
    const decision = await send(cli, '同意', 'remember-result');
    assert.deepEqual([decision.status, decision.type, decision.content, (decision.range as string[])[0], (decision.range as string[]).length],
      ['activated', 'decision', '本项目使用 SQLite WAL', proposal.eventId, 2]);
    const listed = await send(cli, 'info', 'info-list');
    assert.deepEqual([listed.pending, listed.unread], [0, 2]);
    const view = await send(cli, `info ${preference.batchId}`, 'info-view');
    type Snapshot = { content: string; lifecycle: string } | null;
    const [member] = view.members as { eventId: string; recordId: string; outcome: string; before: Snapshot; after: Snapshot; current: Snapshot; changed: boolean }[];
    assert.deepEqual([member!.recordId, member!.outcome, member!.before?.lifecycle, member!.after?.lifecycle, member!.after?.content,
      member!.current?.lifecycle, member!.changed], [preference.recordId, 'activate', 'candidate', 'active', '包管理器使用 pnpm', 'active', false]);
    assert.equal(member!.eventId, (notice?.members as { eventId: string }[])[0]!.eventId);
    const frozen = JSON.parse(entries(sandbox.root)[0].payload).events[0];
    const withHash = (value: object) => ({ ...value, hash: sha256(JSON.stringify(value)) });
    assert.deepEqual(member!.before, withHash(frozen.before));
    assert.deepEqual(member!.after, withHash(frozen.after));
    assert.deepEqual(member!.current, withHash(frozen.after));
    assert.equal((await nth(cli, 'info-read', 0)).read, 'read');
    assert.equal((await send(cli, 'ask 记住偏好：包管理器使用 npm', 'ask-refused')).reason, 'owner-statement-not-question');
    const answer = await send(cli, 'ask 包管理器', 'ask-result');
    assert.ok((answer.selected as string[]).includes(preference.recordId as string));
    const payload = String(answer.payload);
    assert.deepEqual(JSON.parse(payload).memories.map((item: { kind: string; content: string }) => [item.kind, item.content]),
      [['untrusted-memory', '包管理器使用 pnpm']]);
    const digests = entries(sandbox.root).map(entry => entry.digest as string);
    for (const identity of [preference.batchId, decision.batchId, notice?.entryId, ...digests, 'owner-info', 'info-notice']) {
      assert.equal(payload.includes(String(identity)), false, `model payload leaked ${identity}`);
    }
    await stop(cli);
    assert.deepEqual(entries(sandbox.root).map(entry => entry.batchId).sort(), [preference.batchId, decision.batchId].sort());

    const query = startCli(['info', '--sandbox', sandbox.root]);
    const pending = await query.waitFor('info-list');
    assert.deepEqual([pending.pending, pending.unread], [0, 1]);
    assert.equal((await query.exit).code, 0);
    const open = startCli(['info', '--sandbox', sandbox.root, '--batch', String(decision.batchId)]);
    assert.equal((await open.waitFor('info-read')).read, 'read');
    assert.equal((await open.exit).code, 0);

    const again = startCli(['remember', '--sandbox', sandbox.root]); clients.push(again);
    const reopened = await again.waitFor('remember-ready');
    assert.deepEqual([reopened.pending, reopened.unread], [0, 0]);
    assert.equal((await again.waitFor('owner-backfill')).actionable, 2);
    assert.deepEqual(only(again, 'remember-result'), []);
    assert.deepEqual(only(again, 'info-notice'), []);
    await stop(again);
    assert.equal(entries(sandbox.root).length, 2);
    const probe = openProbe(sandbox);
    try {
      const records = probe.store.recoverMemories(probe.activity);
      assert.deepEqual(records.map(record => record.lifecycle), ['active', 'active']);
      assert.deepEqual(probe.store.listHostInfo(probe.activity).map(info => [info.delivery, info.read]), [['delivered', 'read'], ['delivered', 'read']]);
    } finally { probe.close(); }
  } finally {
    for (const cli of clients) if (!cli.observations.some(row => row.event === 'process-exit')) { cli.child.kill('SIGKILL'); await cli.exit; }
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test('a complete line whose fsync failed stays pending until a retry really flushes', async () => {
  const sandbox = createSandbox();
  const temp = mkdtempSync(join(tmpdir(), 't12-flush-'));
  const enabled = join(temp, 'fail'), calls = join(temp, 'calls'), preload = join(temp, 'preload.mjs');
  const clients: Cli[] = [];
  try {
    writeFileSync(enabled, '1');
    writeFileSync(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
      const target = fs.statSync(${JSON.stringify(join(sandbox.root, 'owner-info.jsonl'))});
      const original = fs.fsyncSync;
      fs.fsyncSync = fd => {
        const stat = fs.fstatSync(fd);
        if (stat.dev === target.dev && stat.ino === target.ino && fs.existsSync(${JSON.stringify(enabled)})) {
          fs.appendFileSync(${JSON.stringify(calls)}, 'x'); throw new Error('injected-info-flush-failed');
        }
        return original(fd);
      }; syncBuiltinESMExports();`);
    const previous = process.env.NODE_OPTIONS;
    let cli: Cli;
    try {
      process.env.NODE_OPTIONS = `${previous ?? ''} --import=${pathToFileURL(preload).href}`;
      cli = startCli(['remember', '--sandbox', sandbox.root]); clients.push(cli);
    } finally { if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous; }
    await cli.waitFor('remember-ready');
    const first = await send(cli, '记住偏好：使用 pnpm', 'remember-result');
    assert.equal(first.info, 'pending-redelivery');
    assert.equal(entries(sandbox.root).length, 1);
    assert.equal((await send(cli, 'ask pnpm', 'ask-refused')).reason, 'host-info-recovery-required');
    assert.equal(readFileSync(calls, 'utf8').length, 2);
    rmSync(enabled);
    await send(cli, 'ask pnpm', 'ask-result');
    assert.equal(entries(sandbox.root).length, 1);
    await stop(cli);
  } finally {
    for (const cli of clients) if (!cli.observations.some(row => row.event === 'process-exit')) { cli.child.kill('SIGKILL'); await cli.exit; }
    rmSync(sandbox.root, { recursive: true, force: true }); rmSync(temp, { recursive: true, force: true });
  }
});

test('a lost delivered owner entry blocks restart dispatch without changing activation or read history', async () => {
  const sandbox = createSandbox();
  const clients: Cli[] = [];
  try {
    const first = startCli(['remember', '--sandbox', sandbox.root]); clients.push(first);
    await first.waitFor('remember-ready');
    const result = await send(first, '记住偏好：使用 pnpm', 'remember-result');
    await send(first, `info ${result.batchId}`, 'info-read');
    await stop(first);
    const path = join(sandbox.root, 'owner-info.jsonl');
    const original = readFileSync(path);
    writeFileSync(path, original.toString('utf8').split('\n')[0] + '\n');
    const again = startCli(['remember', '--sandbox', sandbox.root]); clients.push(again);
    await again.waitFor('remember-ready');
    await send(again, `info ${result.batchId}`, 'info-view-error');
    await send(again, 'ask pnpm', 'ask-refused');
    assert.equal(only(again, 'ask-result').length, 0);
    const damagedDelivered = original.subarray(0, original.length - 10);
    writeFileSync(path, damagedDelivered);
    await send(again, 'ask pnpm', 'ask-refused');
    assert.deepEqual(readFileSync(path), damagedDelivered, 'an acknowledged torn entry must not be silently truncated');
    writeFileSync(path, original);
    await send(again, 'ask pnpm', 'ask-result');
    assert.equal(only(again, 'info-notice').length, 0);
    await stop(again);
    const probe = openProbe(sandbox);
    try {
      assert.deepEqual(probe.store.listHostInfo(probe.activity).map(row => [row.batchId, row.delivery, row.read]),
        [[result.batchId, 'delivered', 'read']]);
      assert.equal(probe.store.inspectMemory(probe.activity, String(result.recordId)).history.filter(row => row.kind === 'activate').length, 1);
    } finally { probe.close(); }
  } finally {
    for (const cli of clients) if (!cli.observations.some(row => row.event === 'process-exit')) { cli.child.kill('SIGKILL'); await cli.exit; }
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test('two real CLI processes recovering the same batch append and announce it only once', async () => {
  const sandbox = createSandbox();
  const clients: Cli[] = [];
  try {
    const probe = openProbe(sandbox);
    let batchId: string;
    try {
      batchId = probe.store.rememberMemory(probe.activity, {
        input: probe.archive.append(randomUUID(), '记住偏好：使用 pnpm'), hostInfo: 'durable' }).batchId!;
    } finally { probe.close(); }
    clients.push(startCli(['remember', '--sandbox', sandbox.root]), startCli(['remember', '--sandbox', sandbox.root]));
    await Promise.all(clients.map(cli => cli.waitFor('remember-ready')));
    assert.equal(clients.flatMap(cli => only(cli, 'info-notice')).length, 1);
    assert.deepEqual(entries(sandbox.root).map(row => row.batchId), [batchId]);
    // Recovery above is concurrent; model turns sharing one session remain sequential.
    for (const cli of clients) await send(cli, 'ask pnpm', 'ask-result');
    await Promise.all(clients.map(stop));
  } finally {
    for (const cli of clients) if (!cli.observations.some(row => row.event === 'process-exit')) { cli.child.kill('SIGKILL'); await cli.exit; }
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

// Kill points of the automatic Info path (12 X-11): restart only fills a missing delivery,
// never re-activates, re-selects batch members or moves read back to unread.
const KILLS = [
  { scenario: 'crash-before-activation-commit', activated: 1, notices: 1, unread: 1 },
  { scenario: 'crash-after-activation-commit', activated: 0, notices: 1, unread: 1 },
  { scenario: 'crash-before-info-append', activated: 0, notices: 1, unread: 1 },
  { scenario: 'crash-after-info-append', activated: 0, notices: 1, unread: 1 },
  { scenario: 'crash-after-info-delivery', activated: 0, notices: 0, unread: 1 },
  { scenario: 'crash-before-info-read', activated: 0, notices: 0, unread: 1 },
  { scenario: 'crash-after-info-read', activated: 0, notices: 0, unread: 0 },
] as const;
for (const { scenario, activated, notices, unread } of KILLS) {
  test(`a kill at ${scenario} recovers to exactly one activation and one owner Info entry`, async () => {
    const sandbox = createSandbox();
    try {
      const crashing = startCli(['remember', '--sandbox', sandbox.root, '--scenario', scenario]);
      await crashing.waitFor('remember-ready');
      if (scenario === 'crash-before-info-read' || scenario === 'crash-after-info-read') {
        const remembered = await send(crashing, '记住偏好：包管理器使用 pnpm', 'remember-result');
        crashing.command(`info ${remembered.batchId}`);
      } else crashing.command('记住偏好：包管理器使用 pnpm');
      await crashing.waitFor('owner-checkpoint');
      crashing.child.kill('SIGKILL');
      await crashing.exit;
      if (scenario === 'crash-after-activation-commit') {
        // No agent session is running; the owner can still see the undelivered batch.
        const query = startCli(['info', '--sandbox', sandbox.root]);
        const listed = await query.waitFor('info-list');
        assert.deepEqual([listed.pending, listed.unread], [1, 1]);
        assert.equal((await query.exit).code, 0);
      }
      const restarted = startCli(['remember', '--sandbox', sandbox.root]);
      const ready = await restarted.waitFor('remember-ready');
      assert.deepEqual([ready.pending, ready.unread], [0, unread]);
      assert.equal((await restarted.waitFor('owner-backfill')).actionable, 1);
      assert.equal(only(restarted, 'remember-result', item => item.status === 'activated').length, activated);
      assert.equal(only(restarted, 'info-notice').length, notices);
      await stop(restarted);
      const written = entries(sandbox.root);
      assert.equal(written.length, 1);
      const probe = openProbe(sandbox);
      try {
        const records = probe.store.recoverMemories(probe.activity);
        assert.equal(records.length, 1);
        assert.deepEqual(probe.store.inspectMemory(probe.activity, records[0]!.recordId).history.map(event => event.kind),
          ['capture', 'verify', 'activate']);
        const info = probe.store.listHostInfo(probe.activity);
        assert.deepEqual(info.map(item => [item.delivery, item.read, item.entryId, item.memberCount]),
          [['delivered', unread ? 'unread' : 'read', written[0].entryId, 1]]);
      } finally { probe.close(); }
    } finally { rmSync(sandbox.root, { recursive: true, force: true }); }
  });
}

for (const mode of ['open', 'partial']) {
  test(`Info ${mode} write failure survives restart and redelivers once without losing a read prefix`, async () => {
    const sandbox = createSandbox();
    const temp = mkdtempSync(join(tmpdir(), 't12-write-'));
    const flag = join(temp, 'fail');
    const clients: Cli[] = [];
    const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${new URL('./support/owner-info-write-fault.mjs', import.meta.url).href}`,
      T12_WRITE_FAULT_FILE: join(sandbox.root, 'owner-info.jsonl'), T12_WRITE_FAULT_FLAG: flag, T12_WRITE_FAULT_MODE: mode };
    try {
      const cli = startCli(['remember', '--sandbox', sandbox.root], 15000, undefined, env); clients.push(cli);
      await cli.waitFor('remember-ready');
      const prior = await send(cli, '记住决定：使用 Node 24', 'remember-result');
      await send(cli, `info ${prior.batchId}`, 'info-read');
      const prefix = readFileSync(env.T12_WRITE_FAULT_FILE);
      writeFileSync(flag, '1');
      const failed = await send(cli, '记住偏好：包管理器使用 pnpm', 'remember-result');
      assert.deepEqual([failed.status, failed.stage, failed.info, failed.level], ['activated', 'active', 'pending-redelivery', 'error']);
      assert.match(String(only(cli, 'info-error')[0]?.reason), /injected-info-/);
      if (mode === 'partial') assert.equal(readFileSync(env.T12_WRITE_FAULT_FILE).length, prefix.length + 17);
      await stop(cli);
      const again = startCli(['remember', '--sandbox', sandbox.root], 15000, undefined, env); clients.push(again);
      await again.waitFor('remember-ready');
      await send(again, 'ask 包管理器', 'ask-refused');
      assert.equal(only(again, 'ask-result').length, 0);
      rmSync(flag);
      const answer = await send(again, 'ask 包管理器', 'ask-result');
      assert.ok((answer.selected as string[]).includes(failed.recordId as string));
      assert.equal(only(again, 'info-notice', item => item.batchId === failed.batchId).length, 1);
      await stop(again);
      assert.deepEqual(entries(sandbox.root).map(entry => entry.batchId), [prior.batchId, failed.batchId]);
      assert.ok(readFileSync(env.T12_WRITE_FAULT_FILE).subarray(0, prefix.length).equals(prefix));
      const probe = openProbe(sandbox);
      try { assert.equal(probe.store.listHostInfo(probe.activity).find(row => row.batchId === prior.batchId)?.read, 'read'); }
      finally { probe.close(); }
    } finally {
      for (const cli of clients) if (!cli.observations.some(row => row.event === 'process-exit')) { cli.child.kill('SIGKILL'); await cli.exit; }
      rmSync(sandbox.root, { recursive: true, force: true }); rmSync(temp, { recursive: true, force: true });
    }
  });
}

test('no-active-project questions exclude previously active project memories', async () => {
  const sandbox = createSandbox();
  const clients: Cli[] = [];
  try {
    const probe = openProbe(sandbox);
    try {
      probe.store.rememberMemory(probe.activity, { input: probe.archive.append(randomUUID(), '记住偏好：使用 pnpm'), hostInfo: 'durable' });
      assert.equal(probe.store.pinnedMemoryDelta(probe.activity).records.length, 1);
      assert.deepEqual(probe.store.pinnedMemoryDelta(probe.activity, { noActiveProject: true }), { records: [], truncated: false });
    } finally { probe.close(); }
    const cli = startCli(['remember', '--sandbox', sandbox.root, '--no-active-project']); clients.push(cli);
    await cli.waitFor('remember-ready');
    const answer = await send(cli, 'ask pnpm', 'ask-result');
    assert.deepEqual([answer.searchReason, answer.pinned, answer.selected, JSON.parse(String(answer.payload)).memories ?? []],
      ['no-active-project', [], [], []]);
    await stop(cli);
  } finally {
    for (const cli of clients) if (!cli.observations.some(row => row.event === 'process-exit')) { cli.child.kill('SIGKILL'); await cli.exit; }
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test('an Info registration failure after commit is a known outcome that blocks dispatch until recovered once', async () => {
  const sandbox = createSandbox();
  try {
    const cli = startCli(['remember', '--sandbox', sandbox.root]);
    await cli.waitFor('remember-ready');
    const db = new DatabaseSync(join(sandbox.root, 'probe.sqlite'));
    try {
      db.exec(`CREATE TRIGGER t12_register_failure BEFORE INSERT ON host_info_batches
        BEGIN SELECT RAISE(ABORT,'injected-register-failure'); END;`);
      const failed = await send(cli, '记住偏好：包管理器使用 pnpm', 'remember-result');
      assert.deepEqual([failed.status, failed.stage, failed.info, failed.level], ['activated', 'active', 'pending-redelivery', 'error']);
      const [error] = only(cli, 'info-error');
      assert.deepEqual([error?.batchId, error?.delivery], [null, 'pending-redelivery']);
      assert.match(String(error?.reason), /injected-register-failure/);
      assert.deepEqual(only(cli, 'command-error'), []);
      assert.equal((await send(cli, 'ask 包管理器', 'ask-refused')).reason, 'host-info-recovery-required');
      db.exec('DROP TRIGGER t12_register_failure');
    } finally { db.close(); }
    const answer = await send(cli, 'ask 包管理器', 'ask-result');
    assert.equal(only(cli, 'info-notice').length, 1);
    assert.equal(only(cli, 'ask-result').length, 1);
    assert.ok(answer.receipt);
    await stop(cli);
    assert.equal(entries(sandbox.root).length, 1);
  } finally { rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('a restart after a later rollback or correction neither re-activates nor reports a false error', async () => {
  const sandbox = createSandbox();
  try {
    const cli = startCli(['remember', '--sandbox', sandbox.root]);
    await cli.waitFor('remember-ready');
    const preference = await send(cli, '记住偏好：包管理器使用 pnpm', 'remember-result');
    const decision = await send(cli, '记住决定：运行时固定为 Node 24', 'remember-result');
    await stop(cli);
    const probe = openProbe(sandbox);
    try {
      const rolled = probe.store.readMemory(probe.activity, String(preference.recordId));
      const activation = probe.store.inspectMemory(probe.activity, rolled.recordId).history.find(event => event.kind === 'activate')!;
      probe.store.rollbackMemory(probe.activity, rolled.recordId, rolled, activation.eventId);
      const current = probe.store.readMemory(probe.activity, String(decision.recordId));
      probe.store.correctMemory(probe.activity, current.recordId, current, probe.archive.append(randomUUID(), '更正：运行时固定为 Node 22'),
        '运行时固定为 Node 22');
    } finally { probe.close(); }
    const restarted = startCli(['remember', '--sandbox', sandbox.root]);
    const ready = await restarted.waitFor('remember-ready');
    assert.equal((await restarted.waitFor('owner-backfill')).actionable, 2);
    assert.deepEqual(only(restarted, 'remember-result'), []);
    assert.deepEqual(only(restarted, 'info-notice'), []);
    assert.deepEqual([ready.pending, ready.unread], [0, 2]);
    const view = await send(restarted, `info ${preference.batchId}`, 'info-view');
    const [member] = view.members as { after: { lifecycle: string }; current: { lifecycle: string }; changed: boolean }[];
    assert.deepEqual([member!.after.lifecycle, member!.current.lifecycle, member!.changed], ['active', 'candidate', true]);
    await stop(restarted);
    const check = openProbe(sandbox);
    try {
      assert.deepEqual(check.store.inspectMemory(check.activity, String(preference.recordId)).history.map(event => event.kind),
        ['capture', 'verify', 'activate', 'rollback']);
      const corrected = check.store.readMemory(check.activity, String(decision.recordId));
      assert.deepEqual([corrected.lifecycle, corrected.content], ['active', '运行时固定为 Node 22']);
    } finally { check.close(); }
    assert.equal(entries(sandbox.root).length, 2);
  } finally { rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('a Host without a durable Info surface does not auto-activate; a durable Host resumes the verified candidate', async () => {
  const sandbox = createSandbox();
  try {
    const plain = startCli(['remember', '--sandbox', sandbox.root, '--host-info', 'unavailable']);
    assert.equal((await plain.waitFor('remember-ready')).hostInfo, 'unavailable');
    const blocked = await send(plain, '记住决定：运行时固定为 Node 24', 'remember-result');
    assert.deepEqual([blocked.status, blocked.stage, blocked.reason, blocked.level, blocked.batchId],
      ['blocked', 'verified', 'host-info-unavailable', 'warning', null]);
    // The owner input channel cannot author assistant events unless the synthetic harness is enabled.
    assert.equal((await send(plain, 'propose 建议记住决定：数据库使用 Postgres', 'command-rejected')).reason, 'synthetic-proposals-disabled');
    await stop(plain);
    assert.deepEqual(entries(sandbox.root), []);
    assert.equal(readFileSync(join(sandbox.root, 'session.jsonl'), 'utf8').includes('"role":"assistant"'), false);
    const durable = startCli(['remember', '--sandbox', sandbox.root]);
    const ready = await durable.waitFor('remember-ready');
    const [resumed] = only(durable, 'remember-result', item => item.via === 'backfill');
    assert.deepEqual([resumed?.status, resumed?.recordId, resumed?.info], ['activated', blocked.recordId, 'delivered']);
    assert.deepEqual([ready.pending, ready.unread], [0, 1]);
    await stop(durable);
  } finally { rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('source errors, declines, untyped statements and unresolved scope never activate', async () => {
  const sandbox = createSandbox();
  try {
    const cli = startCli(['remember', '--sandbox', sandbox.root, '--no-active-project', '--synthetic-proposals']);
    await cli.waitFor('remember-ready');
    const unscoped = await send(cli, '记住偏好：包管理器使用 bun', 'remember-result');
    assert.deepEqual([unscoped.status, unscoped.stage, unscoped.reason, unscoped.level], ['blocked', 'candidate', 'scope-unresolved', 'warning']);
    const untyped = await send(cli, '记住：以后都用 bun', 'remember-result');
    assert.deepEqual([untyped.status, untyped.reason, untyped.recordId], ['needs-input', 'memory-type-required', null]);
    const loose = await send(cli, '记住以后都用 bun', 'command-rejected');
    assert.deepEqual([loose.reason, (loose.accepted as string[]).length], ['owner-memory-command-required', 3]);
    await send(cli, 'propose 建议记住决定：数据库使用 Postgres', 'assistant-proposal');
    const declined = await send(cli, '取消', 'remember-result');
    assert.deepEqual([declined.status, declined.reason], ['cancelled', 'owner-declined']);
    const orphan = await send(cli, '同意', 'remember-result');
    assert.deepEqual([orphan.status, orphan.reason], ['not-actionable', 'agreement-target-missing']);
    // A same-content replacement has a new identity, so the owner input cannot be made durable.
    const archive = join(sandbox.root, 'session.jsonl');
    copyFileSync(archive, `${archive}.copy`);
    renameSync(`${archive}.copy`, archive);
    const broken = await send(cli, '记住偏好：包管理器使用 pnpm', 'remember-result');
    assert.deepEqual([broken.status, broken.committed, broken.level, broken.reason], ['error', false, 'error', 'file-identity-changed']);
    await stop(cli);
    assert.deepEqual(entries(sandbox.root), []);
    const db = new DatabaseSync(join(sandbox.root, 'probe.sqlite'));
    try {
      assert.equal(db.prepare('SELECT count(*) AS n FROM memory_records').get()!.n, 1);
      assert.equal(db.prepare("SELECT count(*) AS n FROM memory_heads WHERE lifecycle='active'").get()!.n, 0);
      assert.equal(db.prepare('SELECT count(*) AS n FROM activation_batches').get()!.n, 0);
    } finally { db.close(); }
  } finally { rmSync(sandbox.root, { recursive: true, force: true }); }
});
