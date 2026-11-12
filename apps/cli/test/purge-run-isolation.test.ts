import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AgentRun, DEFAULT_BUDGET, requireProject } from '@euler/core';
import type { MemoryRecord, PurgeManifest, SourceAck } from '@euler/core';
import { openMaintenanceStore } from '../src/backup.ts';
import { openProbe } from '../src/probe.ts';
import { readPurgeCarriers } from '../src/purge.ts';
import { sendCommand, startCli } from '../src/process-driver.ts';
import { bindingOf, createSandbox, openSandbox } from '../src/sandbox.ts';
import { runBackupCli } from './support/backup-cli.ts';

const budget = { ...DEFAULT_BUDGET, contextLimit: 24000, maxTotalTokens: 96000, maxModelAttempts: 3, maxToolCalls: 2 };
const route = { provider: 'fake', model: 'shared-grant-purge', route: 'fixture', authNamespace: 'synthetic' };

type Scenario = 'independent' | 'derived' | 'identical-input';

function seed(root: string, scenario: Scenario) {
  const sandbox = openSandbox(root), binding = bindingOf(sandbox);
  const probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
  try {
    const goalText = 'Read the approved local archive evidence for this synthetic task.';
    const goal = probe.archive.append(randomUUID(), goalText);
    const intent = probe.store.transitionIntent(probe.activity, null, goal, { status: 'active', step: 'analysis' }, goalText);
    const projectIds = [requireProject(binding)];
    const consent = probe.archive.append(randomUUID(), JSON.stringify({ schema: 'memory-discovery-approval@1',
      intentId: intent.intentId, goalEventId: goal.eventId, projectIds, targets: {}, maxResults: 8, maxBytes: 131072 }));
    const { grantId } = probe.store.authorizeMemoryDiscovery(probe.activity, consent, projectIds, 8);
    const markers = { A: `AMBER_${randomUUID()}`, B: `PINE_${randomUUID()}` };
    const outputs = {} as Record<'A' | 'B', { runId: string; source: SourceAck; original: string; payloadHash: string }>;
    const makeRun = () => new AgentRun(probe.store, probe.activity,
      { binding, source: probe.archive, discoveryGrantId: grantId }, route, budget);
    for (const label of ['A', 'B'] as const) {
      const run = makeRun();
      const input = scenario === 'identical-input' ? 'Give one synthetic archive example.' : `Read independent synthetic archive entry ${label}.`;
      run.receive(randomUUID(), input);
      const request = run.nextModel()!;
      for (const marker of Object.values(markers)) assert.equal(request.payload.includes(marker), false);
      const attempt = run.startModel(request, request.payload);
      assert.equal(run.maySend(attempt.attemptId, request.payload), true);
      if (scenario === 'derived' && label === 'B') probe.transport.send(request.payload);
      run.finishModel(attempt.attemptId, { text: `${markers[label]}: independent archive entry ${label}.`, calls: [], stop: 'end' });
      assert.equal(run.status().terminal, 'completed');
      const source = run.status().responses[0]!.source;
      assert.ok(probe.store.requestStatus(probe.activity, run.runId).events.some(event => {
        if (event.kind !== 'agent/event@v1') return false;
        const item = JSON.parse(event.payload).event;
        return item.kind === 'source-access' && item.sourceEventId === source.eventId && item.discoveryGrantId === grantId;
      }));
      outputs[label] = { runId: run.runId, source, original: probe.archive.read(source).text, payloadHash: request.payloadHash };
    }
    if (scenario === 'identical-input') assert.equal(outputs.A.payloadHash, outputs.B.payloadHash);
    // Both independent outputs exist before either canonical memory is created.
    const records = {} as Record<'A' | 'B', MemoryRecord>;
    for (const label of ['A', 'B'] as const) {
      const source = outputs[label].source;
      const captured = probe.store.captureMemory(probe.activity, source, `Independent synthetic decision ${label}: ${markers[label]}.`,
        { type: 'fact', scope: { kind: 'project', id: requireProject(binding), resolved: true }, appliesTo: [] }).record;
      const verified = probe.store.verifyMemory(probe.activity, captured.recordId, captured, 'pass', [source]).record;
      const active = probe.store.activateMemory(probe.activity, verified.recordId, verified).record;
      records[label] = probe.store.readMemory(probe.activity, active.recordId);
      assert.equal(records[label].headEventId, active.headEventId);
      assert.equal(records[label].lifecycle, 'active'); assert.equal(records[label].verification, 'verified');
    }
    let derived: { runId: string; source: SourceAck; toolSource: SourceAck } | null = null;
    if (scenario === 'derived') {
      const run = makeRun();
      run.receive(randomUUID(), 'Recover the original decision for archive entry A.');
      const request = run.nextModel()!, attempt = run.startModel(request, request.payload);
      assert.equal(run.maySend(attempt.attemptId, request.payload), true);
      run.finishModel(attempt.attemptId, { text: '', stop: 'tools', calls: [
        { id: 'recover-a', name: 'source.expand', arguments: { recordId: records.A.recordId, offset: 0, limit: 4096 } },
      ] });
      assert.ok(run.startTool('recover-a'));
      const result = run.coreToolResult('recover-a')!;
      assert.equal(result.outcome, 'success');
      assert.equal(JSON.parse(result.modelResult).text, outputs.A.original);
      run.finishTool('recover-a', result.modelResult, result.outcome);
      const next = run.nextModel()!;
      assert.ok(next.payload.includes(markers.A));
      assert.equal(next.payload.includes(markers.B), false);
      assert.deepEqual(probe.store.requestStatus(probe.activity, run.runId).assemblies.at(-1)!.usedMemories
        .map(use => use.recordId), [records.A.recordId]);
      const sent = run.startModel(next, next.payload);
      assert.equal(run.maySend(sent.attemptId, next.payload), true);
      probe.transport.send(next.payload);
      run.finishModel(sent.attemptId, { text: `Derived answer: ${records.A.content}`, calls: [], stop: 'end' });
      assert.equal(run.status().terminal, 'completed');
      derived = { runId: run.runId, source: run.status().responses.at(-1)!.source, toolSource: run.status().tools[0]!.result!.source };
    }
    probe.store.assertMemoryDiscovery(probe.activity, grantId);
    return { records, outputs, derived, grantId, intent, markers,
      independentLedger: probe.store.requestStatus(probe.activity, outputs.B.runId) };
  } finally { probe.close(); }
}

function seedInProcess(root: string, scenario: Scenario): ReturnType<typeof seed> {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'seed-purge-run-isolation', root, scenario],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout.trim());
}

function filesContaining(root: string, marker: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesContaining(path, marker)
      : readFileSync(path).includes(Buffer.from(marker)) ? [path] : [];
  });
}

if (process.argv[2] === 'seed-purge-run-isolation') {
  const scenario = process.argv[4];
  assert.ok(scenario === 'independent' || scenario === 'derived' || scenario === 'identical-input');
  console.log(JSON.stringify(seed(process.argv[3]!, scenario)));
} else {
  const cases = {
    independent: 'purge preview preserves independent canonical B and its source under the same task grant',
    derived: 'purge preview selects an output that actually used A while preserving independent B',
    'identical-input': 'purge preview preserves an independent answer to an identical request payload',
  } as const;
  for (const scenario of Object.keys(cases) as Scenario[])
  test(cases[scenario], () => {
    const sandbox = createSandbox();
    try {
      const before = seedInProcess(sandbox.root, scenario);
      const store = openMaintenanceStore(sandbox), coordinator = randomUUID();
      let acquired = false;
      try {
        store.beginMaintenance(coordinator);
        const maintenance = store.acquireMaintenance(coordinator);
        assert.equal(maintenance.acquired, true, JSON.stringify(maintenance));
        acquired = true;
        const preview = store.previewPurge(coordinator, before.records.A.recordId, readPurgeCarriers(sandbox, store, coordinator));
        const manifest = preview.manifest;
        const sources = manifest.carriers.filter(item => item.role === 'source').flatMap(item => item.entries.map(entry => entry.id));
        assert.deepEqual(manifest.records.map(record => record.recordId), [before.records.A.recordId]);
        assert.ok(sources.includes(before.outputs.A.source.eventId));
        assert.equal(sources.includes(before.outputs.B.source.eventId), false);
        assert.equal(manifest.database.some(item => item.table === 'memory_discovery_grants'), false);
        if (scenario === 'derived') {
          assert.ok(before.derived);
          assert.ok(sources.includes(before.derived.toolSource.eventId));
          assert.ok(sources.includes(before.derived.source.eventId));
          assert.deepEqual(manifest.carriers.find(item => item.role === 'receiver')?.entries.map(entry => entry.id), ['1']);
        }
      } finally {
        try { if (acquired) assert.equal(store.cancelPurge(coordinator).status, 'cancelled'); }
        finally { store.close(); }
      }
    } finally { rmSync(sandbox.root, { recursive: true, force: true }); }
  });

  test('approved cleanup removes A and its derived output while B and the shared task grant survive reopening', async () => {
    const sandbox = createSandbox();
    let purge: ReturnType<typeof startCli> | undefined;
    try {
      const before = seedInProcess(sandbox.root, 'derived');
      assert.ok(before.derived);
      const backup = runBackupCli(sandbox.root, 'backup');
      assert.equal(backup.status, 0, JSON.stringify(backup.events) + backup.stderr);
      const saved = backup.events.find(event => event.event === 'backup-result').snapshot;
      assert.ok(filesContaining(saved.directory.path, before.markers.A).length > 0);
      assert.ok(filesContaining(saved.directory.path, before.markers.B).length > 0);

      purge = startCli(['purge', '--sandbox', sandbox.root, '--record', before.records.A.recordId]);
      const preview = await purge.waitFor('purge-preview');
      const manifest = preview.manifest as PurgeManifest;
      assert.deepEqual(manifest.records.map(record => record.recordId), [before.records.A.recordId]);
      assert.equal(manifest.database.some(item => item.table === 'memory_discovery_grants'), false);
      assert.ok(manifest.backups.some(item => item.directory.path === saved.directory.path));
      const sources = manifest.carriers.filter(item => item.role === 'source').flatMap(item => item.entries.map(entry => entry.id));
      for (const source of [before.outputs.A.source, before.derived.toolSource, before.derived.source])
        assert.ok(sources.includes(source.eventId));
      assert.equal(sources.includes(before.outputs.B.source.eventId), false);
      const logical = await sendCommand(purge, String(preview.phrase), 'purge-result');
      assert.equal(logical.status, 'logical-commit');
      const complete = await sendCommand(purge, 'cleanup', 'purge-result');
      assert.equal(complete.status, 'controlled-complete', JSON.stringify(complete));
      assert.equal(complete.operationId, logical.operationId);
      assert.equal((await purge.exit).code, 0, purge.stderr());
      for (const snapshot of manifest.backups) assert.equal(existsSync(snapshot.directory.path), false);
      assert.deepEqual(filesContaining(sandbox.root, before.markers.A), []);

      const reopened = openProbe(sandbox, budget, undefined, undefined, undefined, true);
      try {
        reopened.store.auditStore(reopened.activity);
        assert.throws(() => reopened.store.readMemory(reopened.activity, before.records.A.recordId));
        for (const source of [before.outputs.A.source, before.derived.toolSource, before.derived.source])
          assert.throws(() => reopened.store.expandSource(reopened.activity, { ref: source, offset: 0, limit: 4096 }),
            /source-evidence-gap|archive-integrity/);
        assert.deepEqual(reopened.store.readMemory(reopened.activity, before.records.B.recordId), before.records.B);
        assert.equal(reopened.archive.read(before.outputs.B.source).text, before.outputs.B.original);
        assert.deepEqual(reopened.store.requestStatus(reopened.activity, before.outputs.B.runId), before.independentLedger);
        assert.equal(reopened.transport.inspect().count, 1);
        reopened.store.assertMemoryDiscovery(reopened.activity, before.grantId);
        const recovered = reopened.store.retrieveMemorySource(reopened.activity,
          { recordId: before.records.B.recordId, offset: 0, limit: 4096, grantId: before.grantId });
        assert.equal(recovered.text, before.outputs.B.original);
        assert.deepEqual(recovered.record, before.records.B);
        reopened.store.rebuildSearchProjection(reopened.activity);
        const page = reopened.store.searchMemories(reopened.activity, { query: before.markers.B, grantId: before.grantId });
        assert.equal(page.status, 'ready');
        assert.deepEqual(page.results.map(hit => hit.unitId), [before.records.B.recordId]);
        assert.equal(JSON.stringify(page).includes(before.markers.A), false);
        reopened.store.assertMemoryDiscovery(reopened.activity, before.grantId);
      } finally { reopened.close(); }
      assert.deepEqual(filesContaining(sandbox.root, before.markers.A), []);
      assert.ok(filesContaining(sandbox.root, before.markers.B).length > 0);
    } finally {
      if (purge && purge.child.exitCode === null && purge.child.signalCode === null) purge.child.kill();
      if (purge) await purge.exit;
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  });
}
