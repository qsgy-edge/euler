import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AgentRun, DEFAULT_BUDGET, requireProject } from '@euler/core';
import type { Binding, PurgeManifest } from '@euler/core';
import { pumpAgent } from '../src/agent-pump.ts';
import { openProbe } from '../src/probe.ts';
import { sendCommand, startCli } from '../src/process-driver.ts';
import { bindingOf, createSandbox, createSandboxSession, openSandbox } from '../src/sandbox.ts';
import { runBackupCli } from './support/backup-cli.ts';

const budget = { ...DEFAULT_BUDGET, contextLimit: 24000, maxTotalTokens: 96000, maxModelAttempts: 3, maxToolCalls: 4 };
const route = { provider: 'fake', model: 'source-lifecycle', route: 'fixture', authNamespace: 'synthetic' };

async function toolRound(probe: ReturnType<typeof openProbe>, binding: Binding, name: string, args: Record<string, unknown>) {
  const run = new AgentRun(probe.store, probe.activity, { binding, source: probe.archive }, route, budget);
  run.receive(randomUUID(), 'Read the earlier amber decision through the approved tool.');
  const payloads: string[] = [];
  await pumpAgent(run, {
    async *stream(request, _signal, send) {
      send(request.payload); payloads.push(request.payload);
      yield { kind: 'complete', reply: payloads.length === 1 ? { text: '', stop: 'tools', calls: [
        { id: 'recover', name, arguments: args },
      ] } : { text: 'The source check is complete.', calls: [], stop: 'end' } };
    },
    async execute() { throw new Error('unexpected-host-tool'); },
  });
  assert.equal(run.status().terminal, 'completed');
  assert.equal(payloads.length, 2);
  return { run, payloads };
}

async function seed(root: string, mode: 'expand' | 'search') {
  const sandbox = openSandbox(root), binding = bindingOf(sandbox);
  const history = { ...binding, sessionId: randomUUID(), branchId: randomUUID() };
  createSandboxSession(sandbox, history);
  const writer = openProbe(sandbox, budget, undefined, history, undefined, true);
  const canary = `SOURCE_LIFECYCLE_${randomUUID()}`;
  const text = `${canary}: the original amber archive window opens at 07:45.`;
  const siblingText = 'The independent pine archive window opens at 09:30.';
  function remember(original: string, summary: string) {
    const source = writer.archive.append(randomUUID(), original);
    const captured = writer.store.captureMemory(writer.activity, source, summary, {
      type: 'fact', scope: { kind: 'project', id: requireProject(binding), resolved: true }, appliesTo: [],
    }).record;
    const verified = writer.store.verifyMemory(writer.activity, captured.recordId, captured, 'pass', [source]).record;
    return writer.store.activateMemory(writer.activity, verified.recordId, verified).record;
  }
  let record, sibling;
  try {
    record = remember(text, 'Amber archive window decision');
    sibling = remember(siblingText, 'Pine archive window decision');
    writer.store.drainSearchProjection(writer.activity);
  } finally { writer.close(); }
  const probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
  try {
    assert.equal(probe.store.retrieveMemorySource(probe.activity,
      { recordId: record.recordId, offset: 0, limit: 4096 }).text, text);
    const { run, payloads } = await toolRound(probe, binding, mode === 'expand' ? 'source.expand' : 'memory.search',
      mode === 'expand' ? { recordId: record.recordId, offset: 0, limit: 4096 } : { query: 'amber' });
    const toolSource = run.status().tools[0]!.result!.source;
    const toolText = probe.archive.read(toolSource).text;
    assert.ok(toolText.includes(canary));
    assert.ok(payloads[1]!.includes(canary));
    if (mode === 'search') {
      const envelope = JSON.parse(toolText);
      assert.equal(envelope.sourceRecovery[0].excerpt.text, text);
      assert.equal(envelope.modelResult.includes(canary), false);
      assert.deepEqual(JSON.parse(payloads[1]!).p3.sourceRecovery, envelope.sourceRecovery);
    }
    const ledger = probe.store.requestStatus(probe.activity, run.runId);
    const usedMemories = ledger.assemblies.at(-1)!.usedMemories;
    assert.deepEqual(usedMemories.map(use => use.recordId), [record.recordId]);
    return { record, sibling, text, siblingText, canary, toolSource, toolText, runId: run.runId, usedMemories };
  } finally { probe.close(); }
}

function seedInProcess(root: string, mode: 'expand' | 'search'): Awaited<ReturnType<typeof seed>> {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'seed-memory-source', root, mode],
    { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout.trim());
}

function backupCommand(root: string, command: string, args: string[] = []) {
  const result = runBackupCli(root, command, args);
  assert.equal(result.status, 0, JSON.stringify(result.events) + result.stderr);
  return result.events;
}

function canaryFiles(root: string, canary: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? canaryFiles(path, canary) : readFileSync(path).includes(Buffer.from(canary)) ? [path] : [];
  });
}

if (process.argv[2] === 'seed-memory-source') {
  assert.ok(process.argv[4] === 'expand' || process.argv[4] === 'search');
  console.log(JSON.stringify(await seed(process.argv[3]!, process.argv[4])));
} else {
  test('snapshot recovery preserves a recovered memory source, its archived tool result and frozen record', () => {
    const sandbox = createSandbox();
    try {
      const before = seedInProcess(sandbox.root, 'expand');
      const saved = backupCommand(sandbox.root, 'backup').find(event => event.event === 'backup-result').snapshot;
      assert.ok(canaryFiles(saved.directory.path, before.canary).length > 0);
      backupCommand(sandbox.root, 'restore-snapshot', ['--snapshot', saved.id]);
      const old = openProbe(sandbox, budget, undefined, undefined, undefined, true);
      try {
        assert.equal(old.archive.read(before.toolSource).text, before.toolText);
        assert.deepEqual(old.store.requestStatus(old.activity, before.runId).assemblies.at(-1)!.usedMemories, before.usedMemories);
      } finally { old.close(); }
      const fresh = { ...bindingOf(sandbox), sessionId: randomUUID(), branchId: randomUUID() };
      createSandboxSession(sandbox, fresh);
      const reopened = openProbe(sandbox, budget, undefined, fresh, undefined, true);
      try {
        const restored = reopened.store.retrieveMemorySource(reopened.activity,
          { recordId: before.record.recordId, offset: 0, limit: 4096 });
        assert.equal(restored.text, before.text);
        assert.deepEqual(restored.record, before.record);
        assert.deepEqual(restored.ref, before.record.source);
        assert.equal(reopened.store.retrieveMemorySource(reopened.activity,
          { recordId: before.sibling.recordId, offset: 0, limit: 4096 }).text, before.siblingText);
      } finally { reopened.close(); }
    } finally { rmSync(sandbox.root, { recursive: true, force: true }); }
  });

  test('controlled purge removes prefetched provenance and its backup while preserving an independent memory', async () => {
    const sandbox = createSandbox();
    let purge: ReturnType<typeof startCli> | undefined;
    try {
      const before = seedInProcess(sandbox.root, 'search');
      backupCommand(sandbox.root, 'backup');
      assert.ok(canaryFiles(sandbox.root, before.canary).length > 0);
      purge = startCli(['purge', '--sandbox', sandbox.root, '--record', before.record.recordId]);
      const preview = await purge.waitFor('purge-preview');
      const manifest = preview.manifest as PurgeManifest;
      assert.deepEqual(manifest.records.map(record => record.recordId), [before.record.recordId]);
      assert.ok(manifest.backups.length > 0);
      const sourceIds = manifest.carriers.filter(carrier => carrier.role === 'source').flatMap(carrier => carrier.entries.map(entry => entry.id));
      assert.ok(sourceIds.includes(before.toolSource.eventId));
      assert.equal(sourceIds.includes(before.sibling.source.eventId), false);
      assert.equal((await sendCommand(purge, String(preview.phrase), 'purge-result')).status, 'logical-commit');
      const completed = await sendCommand(purge, 'cleanup', 'purge-result');
      assert.equal(completed.status, 'controlled-complete', JSON.stringify(completed));
      assert.equal((await purge.exit).code, 0, purge.stderr());
      assert.deepEqual(canaryFiles(sandbox.root, before.canary), []);

      for (const source of [before.record.source, before.toolSource]) {
        const original = openProbe(sandbox, budget, undefined, source.binding, undefined, true);
        try {
          assert.throws(() => original.store.expandSource(original.activity, { ref: source, offset: 0, limit: 4096 }),
            /source-evidence-gap|archive-integrity/);
        } finally { original.close(); }
      }
      const fresh = { ...bindingOf(sandbox), sessionId: randomUUID(), branchId: randomUUID() };
      createSandboxSession(sandbox, fresh);
      const reopened = openProbe(sandbox, budget, undefined, fresh, undefined, true);
      try {
        assert.throws(() => reopened.store.retrieveMemorySource(reopened.activity,
          { recordId: before.record.recordId, offset: 0, limit: 4096 }), /memory-evidence-gap/);
        assert.equal(reopened.store.retrieveMemorySource(reopened.activity,
          { recordId: before.sibling.recordId, offset: 0, limit: 4096 }).text, before.siblingText);
        reopened.store.rebuildSearchProjection(reopened.activity);
        const { payloads } = await toolRound(reopened, fresh, 'memory.search', { query: 'amber' });
        assert.ok(payloads.every(payload => !payload.includes(before.canary)));
        const last = JSON.parse(payloads.at(-1)!);
        assert.deepEqual(JSON.parse(last.p2.at(-1).results[0].modelResult).results, []);
        assert.equal(last.p3.sourceRecovery, undefined);
      } finally { reopened.close(); }
      assert.deepEqual(canaryFiles(sandbox.root, before.canary), []);
    } finally {
      if (purge && purge.child.exitCode === null && purge.child.signalCode === null) purge.child.kill();
      if (purge) await purge.exit;
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  });
}
