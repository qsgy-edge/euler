#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { openSync, closeSync, ftruncateSync, fsyncSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { DEFAULT_BUDGET, ProbeStore, check } from '@euler/core';
import type { ProbeBudget } from '@euler/core';
import { createSandbox, openSandbox, bindingOf, resourcesOf } from './sandbox.ts';
import type { Sandbox } from './sandbox.ts';
import { openProbe } from './probe.ts';
import { startCli } from './process-driver.ts';
import memoryFixture from '../../../fixtures/scoped-memory.json' with { type: 'json' };

function emit(event: string, fields: Record<string, unknown> = {}) {
  process.stdout.write(JSON.stringify({ ...fields, event }) + '\n');
}

async function hold(sandbox: Sandbox, task: boolean, reservationId?: string) {
  const jobId = randomUUID();
  let probe: ReturnType<typeof openProbe> | undefined = openProbe(sandbox, DEFAULT_BUDGET,
    task ? reservationId ?? { kind: 'job', id: jobId, authorizationId: jobId } : undefined);
  let child: ReturnType<typeof startCli> | undefined;
  const lines = createInterface({ input: process.stdin });
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const input = probe.archive.append(sandbox.fixture.eventId, sandbox.fixture.text);
    probe.archive.read(input);
    if (!task) {
      const reservation = probe.store.reserveChild(probe.activity);
      child = startCli(['task', '--sandbox', sandbox.root, '--reservation', reservation]);
      if (child.child.pid !== undefined) probe.store.recordChildLaunch(probe.activity, reservation, child.child.pid);
      await child.waitFor('task-ready');
    }
    emit(task ? 'task-ready' : 'runtime-ready', { pid: process.pid, activityId: probe.activity.id, streamId: probe.activity.streamId, incarnation: probe.activity.incarnation, epoch: probe.activity.epoch, childPid: child?.child.pid ?? null, source: input });
    for await (const line of lines) {
      if (line === 'stop') break;
      if (line === 'close') {
        probe?.close();
        probe = undefined;
        emit('probe-closed');
        continue;
      }
      if (line === 'append') {
        try {
          probe!.archive.append(sandbox.fixture.eventId, sandbox.fixture.text);
          emit('late-append-accepted');
        } catch (error) { emit('late-append-blocked', { reason: (error as Error).message }); }
      }
    }
  } finally {
    try {
      probe?.session.cancel();
      if (child) {
        if (child.child.exitCode === null && child.child.signalCode === null) child.command('stop');
        const result = await child.exit;
        emit('controlled-task-exit', { pid: child.child.pid, ...result });
        check(result.code === 0, 'controlled-task-failed');
      }
    } finally {
      lines.close();
      clearInterval(keepAlive);
      probe?.close();
    }
  }
}

async function maintain(sandbox: Sandbox) {
  const store = new ProbeStore(resourcesOf(sandbox), sandbox.storeId, bindingOf(sandbox));
  const coordinator = randomUUID();
  const lines = createInterface({ input: process.stdin });
  try {
    const fence = store.beginMaintenance(coordinator);
    emit('maintenance-closing', { coordinator, epoch: fence.epoch, pid: process.pid });
    const acquire = () => {
      const result = store.acquireMaintenance(coordinator);
      emit(result.acquired ? 'maintenance-exclusive' : 'maintenance-blocked', { coordinator, ...result, fence: store.fence() });
    };
    acquire();
    for await (const line of lines) {
      if (line === 'acquire') acquire();
      if (line === 'inspect') emit('maintenance-status', store.maintenanceStatus());
      if (line === 'cancel') {
        const cancelled = store.cancelMaintenance(coordinator);
        emit('maintenance-cancelled', { epoch: cancelled.epoch, fence: cancelled });
        break;
      }
      if (line === 'release') {
        const released = store.releaseMaintenance(coordinator);
        emit('maintenance-released', { epoch: released.epoch, fence: released });
        break;
      }
    }
    // EOF closes the process, not the durable fence. A later coordinator must
    // establish this process's actual absence before taking over.
  } finally { lines.close(); store.close(); }
}

function run(sandbox: Sandbox, scenario: string, budget: ProbeBudget) {
  check(['success', 'blocked', 'archive-only', 'archive-failure', 'cancelled'].includes(scenario), 'invalid-scenario');
  const probe = openProbe(sandbox, budget);
  try {
    if (scenario === 'archive-failure') {
      // Deliberate torn carrier in a newly generated disposable fixture only.
      const fd = openSync(join(sandbox.root, 'session.jsonl'), 'r+');
      try { ftruncateSync(fd, 3); fsyncSync(fd); } finally { closeSync(fd); }
    }
    try {
      const turn = probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
      emit('source-ack', { ack: turn.input, intent: turn.intent, sends: probe.transport.count });
      if (scenario === 'archive-only') {
        emit('run-result', { scenario, source: turn.input, sends: probe.transport.count, eventCount: probe.archive.inspect().eventCount });
        return;
      }
      if (scenario === 'cancelled') probe.session.cancel();
      const receipt = probe.session.dispatch(turn, () => { if (scenario === 'blocked') throw new Error('final-gate-denied'); });
      emit('run-result', { scenario, receipt, sends: probe.transport.count, payloads: probe.transport.payloads,
        eventCount: probe.archive.inspect().eventCount, usage: probe.session.usage() });
    } catch (error) {
      emit('run-result', { scenario, reason: (error as Error).message, sends: probe.transport.count,
        payloads: probe.transport.payloads, usage: probe.session.usage() });
      process.exitCode = 1;
    }
  } finally { probe.close(); }
}

async function maintenanceDemo(sandbox: Sandbox) {
  const runtime = startCli(['hold', '--sandbox', sandbox.root]);
  let maintenance: ReturnType<typeof startCli> | undefined;
  try {
    const ready = await runtime.waitFor('runtime-ready');
    emit('runtime-ready', ready);
    maintenance = startCli(['maintain', '--sandbox', sandbox.root]);
    emit('maintenance-blocked', await maintenance.waitFor('maintenance-blocked'));
    runtime.command('append');
    emit('late-append-blocked', await runtime.waitFor('late-append-blocked'));
    runtime.command('stop');
    emit('controlled-task-exit', await runtime.waitFor('controlled-task-exit'));
    emit('runtime-exit', { pid: runtime.child.pid, ...await runtime.exit });
    maintenance.command('acquire');
    emit('maintenance-exclusive', await maintenance.waitFor('maintenance-exclusive'));
    maintenance.command('release');
    emit('maintenance-released', await maintenance.waitFor('maintenance-released'));
    emit('maintenance-exit', { pid: maintenance.child.pid, ...await maintenance.exit });
    const restored = startCli(['run', '--sandbox', sandbox.root]);
    const result = await restored.waitFor('run-result');
    emit('resumed-run', result);
    check((await restored.exit).code === 0 && result.sends === 1, 'recovery-failed');
  } finally {
    for (const proc of [runtime, maintenance]) {
      if (!proc) continue;
      if (proc.child.exitCode === null && proc.child.signalCode === null) {
        proc.child.stdin.end('stop\n');
        await proc.exit;
      }
    }
  }
}

async function memoryDemo(sandbox: Sandbox) {
  const probe = openProbe(sandbox);
  try {
    const { intent } = probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
    const input = probe.archive.append(memoryFixture.sourceEventId, memoryFixture.sourceText);
    const options = { type: 'decision' as const, claimKey: memoryFixture.claimKey,
      scope: { kind: 'project' as const, id: sandbox.fixture.projectId, resolved: true }, appliesTo: memoryFixture.appliesTo };
    const captured = probe.store.captureMemory(probe.activity, input, memoryFixture.memoryText, options);
    const verified = probe.store.verifyMemory(probe.activity, captured.record.recordId, captured.record, 'pass', [input]);
    const activated = probe.store.activateMemory(probe.activity, verified.record.recordId, verified.record);
    const proposalInput = { target: 'synthetic/AGENTS.md', expectedChange: 'Explain the synthetic receipt rule', owner: sandbox.fixture.ownerId,
      scope: options.scope, evidenceRefs: [input], evaluation: { schema: 'evaluation-contract@1' as const, level: 'L0' as const, assertions: ['Check synthetic source bytes'] } };
    const proposal = probe.store.saveEvolutionProposal(probe.activity, input, proposalInput);
    const revision = probe.store.saveEvolutionProposal(probe.activity, input, { ...proposalInput,
      expectedChange: 'Explain the synthetic receipt rule and scope', supersedes: proposal.proposalId });
    emit('memory-result', { synthetic: true, intent, captured, verified, activated, proposals: [proposal, revision],
      eligible: probe.store.listEligibleMemories(probe.activity), inspection: probe.store.inspectMemory(probe.activity, activated.record.recordId),
      outbox: probe.store.pendingMemoryProjections(probe.activity) });
  } finally { probe.close(); }
}

async function memoryWorker(sandbox: Sandbox, scenario: string) {
  check(['compete', 'crash-in-transaction', 'crash-after-commit'].includes(scenario), 'invalid-memory-scenario');
  const probe = openProbe(sandbox);
  const lines = createInterface({ input: process.stdin });
  try {
    const expected = probe.store.recoverMemories(probe.activity)[0];
    check(expected, 'memory-required');
    const source = probe.archive.append(randomUUID(), 'Synthetic correction evidence');
    const request = { schema: 'memory-request@1', kind: 'correct', expected,
      args: { recordId: expected.recordId, input: source, content: memoryFixture.correctionText } };
    const requestHash = probe.store.memoryCorrectionRequestHash(expected.recordId, expected, source, request.args.content);
    emit('memory-ready', { pid: process.pid, expected, scenario, request, requestHash });
    for await (const line of lines) {
      if (line !== 'commit') break;
      const change = () => probe.store.correctMemory(probe.activity, expected.recordId, expected, source, request.args.content);
      const checkpoint = (stage: string) => {
        writeSync(1, JSON.stringify({ event: 'memory-checkpoint', stage, pid: process.pid }) + '\n');
        // Deliberately leave the transaction/process open for the parent kill probe.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
        throw new Error('checkpoint-was-not-killed');
      };
      if (scenario === 'crash-in-transaction') {
        probe.store.withActivity(probe.activity, () => { change(); checkpoint('uncommitted'); });
      } else {
        const result = change();
        if (scenario === 'crash-after-commit') checkpoint('committed-before-ack');
        emit('memory-written', { result });
      }
      break;
    }
  } finally { lines.close(); probe.close(); }
}

async function main() {
  const args = parseArgs({ allowPositionals: true, options: {
    sandbox: { type: 'string' }, scenario: { type: 'string', default: 'success' }, budget: { type: 'string' },
    request: { type: 'string' }, record: { type: 'string' }, reservation: { type: 'string' },
  } });
  check(args.positionals.length <= 1, 'invalid-command');
  const command = args.positionals[0] ?? 'success';
  check(['create', 'run', 'recover', 'memory', 'memory-worker', 'memory-reconcile', 'hold', 'task', 'maintain', 'maintenance-status', 'success', 'blocked', 'archive-failure', 'archive-only', 'cancelled', 'maintenance'].includes(command), 'invalid-command');
  const options = args.values.budget ? JSON.parse(args.values.budget) as Partial<ProbeBudget> : {};
  check(Object.keys(options).every(key => key in DEFAULT_BUDGET), 'invalid-budget');
  const budget = { ...DEFAULT_BUDGET, ...options };
  if (['run', 'recover', 'memory', 'memory-worker', 'memory-reconcile', 'hold', 'task', 'maintain', 'maintenance-status'].includes(command)) check(args.values.sandbox, 'sandbox-required');
  // Fault injection never modifies a caller-selected existing sandbox.
  if (command === 'archive-failure' || args.values.scenario === 'archive-failure') check(!args.values.sandbox, 'fault-requires-fresh-sandbox');
  const sandbox = args.values.sandbox ? openSandbox(args.values.sandbox) : createSandbox();
  emit('sandbox', { root: sandbox.root, storeId: sandbox.storeId, fixtureDigest: sandbox.fixtureDigest, mode: 'synthetic-only' });
  if (command === 'create') return;
  if (command === 'hold' || command === 'task') return hold(sandbox, command === 'task', args.values.reservation);
  if (command === 'maintain') return maintain(sandbox);
  if (command === 'maintenance-status') {
    const store = new ProbeStore(resourcesOf(sandbox), sandbox.storeId, bindingOf(sandbox));
    try { emit('maintenance-status', store.maintenanceStatus()); }
    finally { store.close(); }
    return;
  }
  if (command === 'maintenance') return maintenanceDemo(sandbox);
  if (command === 'recover') {
    const probe = openProbe(sandbox);
    try { emit('recovered', { source: probe.archive.lookup(sandbox.fixture.eventId), intent: probe.session.recoverIntent(), memories: probe.store.recoverMemories(probe.activity), eventCount: probe.archive.inspect().eventCount, sends: 0 }); }
    finally { probe.close(); }
    return;
  }
  if (command === 'memory-worker') return memoryWorker(sandbox, args.values.scenario);
  if (command === 'memory-reconcile') {
    check(args.values.record && args.values.request, 'memory-identity-required');
    const probe = openProbe(sandbox);
    try {
      emit('memory-reconciled', { operation: probe.store.lookupMemoryOperation(probe.activity, args.values.record, args.values.request),
        recovered: probe.store.recoverMemory(probe.activity, args.values.record), outbox: probe.store.pendingMemoryProjections(probe.activity) });
    } finally { probe.close(); }
    return;
  }
  if (command === 'memory') return memoryDemo(sandbox);
  run(sandbox, command === 'run' ? args.values.scenario : command, budget);
}

main().catch(error => { emit('error', { reason: (error as Error).message }); process.exitCode = 1; });
