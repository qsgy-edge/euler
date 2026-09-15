import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { AgentRun, DEFAULT_BUDGET, coreToolSchemas } from '@euler/core';
import type { ProbeBudget, ModelReply } from '@euler/core';
import { bindingOf, createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';
import { pumpAgent } from '../src/agent-pump.ts';

const route = { provider: 'fake', model: 'test', route: 'fixture', authNamespace: 'none' };
const budget = { ...DEFAULT_BUDGET, contextLimit: 20000, maxModelAttempts: 3, maxTotalTokens: 60000 };
function fixture(limits: ProbeBudget = budget) {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox, limits, undefined, undefined, undefined, true);
  const run = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive }, route, limits);
  run.receive(sandbox.fixture.eventId, 'Synthetic boundary input');
  return { store: probe.store, activity: probe.activity, archive: probe.archive, run,
    dispose() { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); } };
}

test('final byte mutation and a repeated send are denied by the actual admission callback', async () => {
  for (const mode of ['mutation', 'retry'] as const) {
    const f = fixture(); let sends = 0;
    try {
      const status = await pumpAgent(f.run, { async *stream(request, _signal, send) {
        send(mode === 'mutation' ? request.payload + ' ' : request.payload); sends++;
        send(request.payload); sends++;
        yield { kind: 'complete' as const, reply: { text: 'bad', calls: [], stop: 'end' as const } };
      }, async execute() { throw new Error('unexpected'); } });
      assert.equal(sends, mode === 'mutation' ? 0 : 1);
      assert.equal(status.terminal, mode === 'mutation' ? 'failed' : 'blocked-unknown');
      assert.equal(f.store.requestStatus(f.activity, f.run.runId).attempts.length, sends);
    } finally { f.dispose(); }
  }
});

test('Core exposes exactly eight schemas and denies remote tool registration or self approval', async () => {
  assert.deepEqual(coreToolSchemas().map(tool => tool.name), ['skill.search', 'memory.search', 'source.search', 'source.expand', 'memory.inspect', 'memory.preview', 'memory.commit', 'memory.cancel']);
  const f = fixture(); let executions = 0, requests = 0;
  try {
    const status = await pumpAgent(f.run, { async *stream(request, _signal, send) {
      send(request.payload);
      if (++requests === 1) yield { kind: 'complete' as const, reply: { text: '', stop: 'tools' as const, calls: [
        { id: 'unknown', name: 'remote.admin', arguments: { approved: true, schema: 'register me' } },
        { id: 'commit', name: 'memory.commit', arguments: { approved: true } },
        { id: 'good', name: 'controlled.echo', arguments: { text: 'safe' } },
      ] } };
      else yield { kind: 'complete' as const, reply: { text: 'Done', calls: [], stop: 'end' as const } };
    }, async execute() { executions++; return 'safe'; } });
    assert.equal(status.terminal, 'completed');
    assert.equal(executions, 1);
    assert.deepEqual(status.tools.map(tool => [tool.result!.executionState, tool.result!.outcome]), [['not_started', 'unavailable'], ['not_started', 'unavailable'], ['started', 'success']]);
  } finally { f.dispose(); }
});

test('mandatory overflow and cumulative token exhaustion both send zero requests', async () => {
  for (const limits of [{ ...budget, contextLimit: 512, outputReserve: 64, safetyMargin: 64 }, { ...budget, maxTotalTokens: 512 }]) {
    const f = fixture(limits); let sends = 0;
    try {
      const status = await pumpAgent(f.run, { async *stream(request, _signal, send) {
        send(request.payload); sends++; yield { kind: 'complete' as const, reply: { text: 'bad', calls: [], stop: 'end' as const } };
      }, async execute() { return ''; } });
      assert.equal(sends, 0);
      assert.equal(status.terminal, limits.contextLimit === 512 ? 'needs-input' : 'budget-exhausted');
    } finally { f.dispose(); }
  }
});

test('the tool-call cap settles remaining pairs without admitting another tool', async () => {
  const f = fixture({ ...budget, maxToolCalls: 1 }); let executions = 0;
  try {
    const status = await pumpAgent(f.run, { async *stream(request, _signal, send) {
      send(request.payload); yield { kind: 'complete' as const, reply: { text: '', stop: 'tools' as const,
        calls: ['a', 'b'].map(id => ({ id, name: 'controlled.echo', arguments: { text: id } })) } };
    }, async execute() { executions++; return 'safe'; } });
    assert.equal(executions, 1);
    assert.equal(status.terminal, 'budget-exhausted');
    assert.deepEqual(status.tools.map(tool => tool.result!.executionState), ['started', 'not_started']);
  } finally { f.dispose(); }
});

test('a stream that fails after a complete-looking tool event leaves unknown and never runs the tool', async () => {
  const f = fixture(); let executions = 0;
  try {
    const status = await pumpAgent(f.run, { async *stream(request, _signal, send) {
      send(request.payload); yield { kind: 'complete' as const, reply: { text: '', stop: 'tools' as const,
        calls: [{ id: 'a', name: 'controlled.echo', arguments: { text: 'unsafe to start' } }] } };
      throw new Error('stream failed before EOF');
    }, async execute() { executions++; return ''; } });
    assert.equal(status.terminal, 'blocked-unknown');
    assert.equal(executions, 0);
    assert.equal(f.archive.inspect().eventCount, 1);
    assert.equal(f.store.requestStatus(f.activity, f.run.runId).attempts[0]!.outcome, 'unknown-sent');
    assert.throws(() => f.store.reconcileRequestAttempt(f.activity, f.store.requestStatus(f.activity, f.run.runId).attempts[0]!.attemptId), /attempt-owner-still-live/);
  } finally { f.dispose(); }
});

test('wall-clock expiry aborts a non-cooperative provider and never archives its late reply', async () => {
  const f = fixture({ ...budget, wallClockMs: 200 });
  let release!: (reply: ModelReply) => void;
  const held = new Promise<ModelReply>(resolve => { release = resolve; });
  try {
    const status = await pumpAgent(f.run, { async *stream(request, _signal, send) {
      send(request.payload); yield { kind: 'complete' as const, reply: await held };
    }, async execute() { return ''; } });
    assert.equal(status.terminal, 'deadline');
    release({ text: 'late', calls: [], stop: 'end' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.archive.inspect().eventCount, 1);
  } finally { f.dispose(); }
});

test('revocation between assembly and final send leaves no request and is durably terminal', async () => {
  const f = fixture(); let sends = 0;
  try {
    const status = await pumpAgent(f.run, { async *stream(request, _signal, send) {
      f.store.revokeRequestRun(f.activity, f.run.runId);
      send(request.payload); sends++;
      yield { kind: 'complete' as const, reply: { text: 'bad', calls: [], stop: 'end' as const } };
    }, async execute() { return ''; } });
    assert.equal(sends, 0);
    assert.notEqual(status.terminal, 'completed');
    assert.equal(f.store.requestStatus(f.activity, f.run.runId).attempts.length, 0);
  } finally { f.dispose(); }
});
