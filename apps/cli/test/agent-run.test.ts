import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { AgentRun, DEFAULT_BUDGET } from '@euler/core';
import { pumpAgent } from '../src/agent-pump.ts';
import { bindingOf, createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

const route = { provider: 'fake', model: 'controlled', route: 'fixture', authNamespace: 'none' };
const budget = { ...DEFAULT_BUDGET, contextLimit: 20000, maxTotalTokens: 60000, maxModelAttempts: 3 };
test('a complete tool call in a provisional stream cannot execute before the full response is archived', async () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
  let executions = 0, requests = 0;
  try {
    const run = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive }, route, budget);
    run.receive(sandbox.fixture.eventId, sandbox.fixture.text);
    const reply = { text: '', calls: [{ id: 'call-1', name: 'controlled.echo', arguments: { text: 'fixture echo' } }], stop: 'tools' as const };
    const result = await pumpAgent(run, {
      async *stream(request, _signal, send) {
        send(request.payload);
        requests++;
        if (requests === 1) {
          yield { kind: 'partial' as const, reply };
          assert.equal(executions, 0);
          assert.equal(probe.archive.inspect().eventCount, 1);
          yield { kind: 'complete' as const, reply };
        } else {
          const payload = JSON.parse(request.payload);
          assert.equal(payload.p2[0].assistant.calls[0].id, 'call-1');
          assert.equal(payload.p2[0].results[0].callId, 'call-1');
          assert.equal(payload.p2[0].results[0].modelResult, 'fixture echo');
          yield { kind: 'complete' as const, reply: { text: 'Echo complete', calls: [], stop: 'end' as const } };
        }
      },
      async execute(call) {
        executions++;
        assert.equal(probe.archive.inspect().eventCount, 2);
        assert.equal(run.status().responses.length, 1);
        return String(call.arguments.text);
      },
    });
    assert.equal(result.terminal, 'completed');
    assert.equal(executions, 1);
    assert.equal(requests, 2);
    assert.equal(run.status().tools[0]!.result!.outcome, 'success');
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});


test('parallel-safe calls preserve model order and isolate an ordinary error while sequential batches remain ordered', async () => {
  for (const executionMode of ['parallel-safe', 'sequential', undefined] as const) {
    const sandbox = createSandbox();
    const probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
    try {
      const run = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive }, route, budget,
        executionMode ? { executionMode } : {});
      run.receive(sandbox.fixture.eventId, sandbox.fixture.text);
      const started: string[] = [], completed: string[] = [];
      let release!: () => void;
      const first = new Promise<void>(resolve => { release = resolve; });
      let requests = 0;
      const result = await pumpAgent(run, {
        async *stream(request, _signal, send) {
          send(request.payload);
          if (++requests === 1) yield { kind: 'complete' as const, reply: { text: '', stop: 'tools' as const,
            calls: ['a', 'b'].map(id => ({ id, name: 'controlled.echo', arguments: { text: id } })) } };
          else {
            const pair = JSON.parse(request.payload).p2[0];
            assert.deepEqual(pair.results.map((item: { callId: string; outcome: string }) => [item.callId, item.outcome]), [['a', 'failure'], ['b', 'success']]);
            yield { kind: 'complete' as const, reply: { text: 'Settled', calls: [], stop: 'end' as const } };
          }
        },
        async execute(call) {
          started.push(call.id);
          if (call.id === 'a') {
            if (executionMode === 'parallel-safe') await first;
            completed.push('a'); throw new Error('ordinary synthetic failure');
          }
          completed.push('b'); release(); return 'second survived';
        },
      });
      assert.equal(result.terminal, 'completed');
      assert.deepEqual(started, ['a', 'b']);
      assert.deepEqual(completed, executionMode === 'parallel-safe' ? ['b', 'a'] : ['a', 'b']);
    } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
  }
});

test('cancellation stops new admissions, durably distinguishes started unknown from unstarted calls, and ignores late results', async () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
  try {
    const run = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive }, route, budget);
    run.receive(sandbox.fixture.eventId, sandbox.fixture.text);
    let release!: (text: string) => void;
    const held = new Promise<string>(resolve => { release = resolve; });
    let executions = 0;
    const pumping = pumpAgent(run, {
      async *stream(request, _signal, send) { send(request.payload); yield { kind: 'complete' as const, reply: { text: '', stop: 'tools' as const,
        calls: ['a', 'b'].map(id => ({ id, name: 'controlled.echo', arguments: { text: id } })) } }; },
      async execute() { executions++; run.cancel(); return held; },
    });
    const result = await pumping;
    assert.equal(result.terminal, 'cancelled');
    assert.equal(executions, 1);
    assert.deepEqual(result.tools.map(tool => [tool.result!.executionState, tool.result!.outcome]), [['started', 'unknown'], ['not_started', 'cancelled']]);
    const before = probe.archive.inspect().eventCount;
    release('late result');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(probe.archive.inspect().eventCount, before);
    assert.equal(run.nextModel(), null);
    assert.equal(probe.store.agentStatus(probe.activity, run.runId).terminal, 'cancelled');
    assert.throws(() => new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive }, route, budget), /request-recovery-required/);
    assert.throws(() => new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive }, route, budget,
      { recovery: { relatedRunId: run.runId, acceptDuplicateRisk: false } }), /duplicate-risk-approval-required/);
    const continued = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive }, route, budget,
      { recovery: { relatedRunId: run.runId, acceptDuplicateRisk: true } });
    continued.receive('b31ff9d2-c26b-4d9f-b0c6-bc4d847e8b0a', 'Explicitly authorized new synthetic task');
    const continuedStatus = await pumpAgent(continued, { async *stream(request, _signal, send) {
      send(request.payload);
      yield { kind: 'complete' as const, reply: { text: 'Recovered', calls: [], stop: 'end' as const } };
    }, async execute() { throw new Error('unexpected tool'); } });
    assert.equal(continuedStatus.terminal, 'completed');
    assert.equal(run.status().tools[0]!.result!.outcome, 'unknown');
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('model budget exhaustion ends the loop visibly without an extra request', async () => {
  const sandbox = createSandbox();
  const limited = { ...budget, maxModelAttempts: 1 };
  const probe = openProbe(sandbox, limited, undefined, undefined, undefined, true);
  try {
    const run = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive }, route, limited);
    run.receive(sandbox.fixture.eventId, sandbox.fixture.text);
    let requests = 0;
    const status = await pumpAgent(run, {
      async *stream(request, _signal, send) { send(request.payload); requests++; yield { kind: 'complete' as const, reply: { text: '', stop: 'tools' as const,
        calls: [{ id: 'one', name: 'controlled.echo', arguments: { text: 'bounded' } }] } }; },
      async execute() { return 'bounded'; },
    });
    assert.equal(status.terminal, 'budget-exhausted');
    assert.equal(requests, 1);
    assert.equal(status.tools[0]!.result!.outcome, 'success');
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('an unresponsive tool times out without accepting a late completion', async () => {
  const sandbox = createSandbox();
  const limited = { ...budget, toolTimeoutMs: 30 };
  const probe = openProbe(sandbox, limited, undefined, undefined, undefined, true);
  try {
    const run = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive }, route, limited);
    run.receive(sandbox.fixture.eventId, sandbox.fixture.text);
    const status = await pumpAgent(run, { async *stream(request, _signal, send) {
      send(request.payload);
      yield { kind: 'complete' as const, reply: { text: '', stop: 'tools' as const, calls: [{ id: 'held', name: 'controlled.echo', arguments: { text: 'held' } }] } };
    }, execute() { return new Promise<string>(() => {}); } });
    assert.equal(status.terminal, 'blocked-unknown');
    assert.equal(status.tools[0]!.result!.errorClass, 'timeout');
    assert.equal(status.tools[0]!.result!.executionState, 'started');
    assert.equal(status.tools[0]!.result!.outcome, 'unknown');
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('steer is consumed only after the settled batch; follow-up creates a linked run only after completion and queue stays outside', async () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
  try {
    const run = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive }, route, budget);
    run.receive(sandbox.fixture.eventId, 'Original task');
    const steerId = 'd5d62a62-81da-41f8-ac4e-93c77a4f60b7';
    const followId = '42d1487f-30da-4e47-b1e0-4d6c82f05314';
    const queueId = '8385841b-f514-4a18-a778-3b787f102606';
    let requests = 0;
    await pumpAgent(run, { async *stream(request, _signal, send) {
      send(request.payload);
      if (++requests === 1) {
        run.receive(steerId, 'Steer data');
        run.receive(followId, 'Follow-up data', 'follow-up');
        run.receive(queueId, 'Queued data', 'queue');
        assert.equal(run.followUp(), null);
        yield { kind: 'complete' as const, reply: { text: '', calls: [{ id: 'one', name: 'controlled.echo', arguments: { text: 'safe' } }], stop: 'tools' as const } };
      } else {
        const payload = JSON.parse(request.payload);
        assert.deepEqual(payload.p3.messages.map((message: { content: string }) => message.content), ['Steer data']);
        assert.equal(request.payload.includes('Follow-up data') || request.payload.includes('Queued data'), false);
        yield { kind: 'complete' as const, reply: { text: 'Complete', calls: [], stop: 'end' as const } };
      }
    }, async execute() {
      assert.equal(run.status().inputs.find(input => input.source.eventId === steerId)!.state, 'received'); return 'safe';
    } });
    const follow = run.followUp();
    assert.ok(follow);
    assert.equal(probe.store.requestStatus(probe.activity, follow.runId).run.relatedRunId, run.runId);
    assert.equal(follow.status().inputs[0]!.source.eventId, followId);
    assert.equal(run.status().inputs.find(input => input.source.eventId === queueId)!.state, 'received');
    follow.cancel();
    assert.equal(follow.followUp(), null);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('escaped near-limit tool results are truncated to the archive byte limit', async () => {
  const sandbox = createSandbox();
  const limits = { ...budget, contextLimit: 100000, maxTotalTokens: 200000 };
  const probe = openProbe(sandbox, limits, undefined, undefined, undefined, true);
  try {
    const run = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive }, route, limits);
    run.receive(sandbox.fixture.eventId, 'Bounded result');
    const request = run.nextModel()!;
    const attempt = run.startModel(request, request.payload);
    assert.equal(run.maySend(attempt.attemptId, request.payload), true);
    run.finishModel(attempt.attemptId, { text: '', stop: 'tools', calls: [{ id: 'escaped', name: 'controlled.echo', arguments: { text: 'x' } }] });
    const tool = run.startTool('escaped')!;
    run.finishTool(tool.id, String.fromCharCode(34, 92).repeat(16384));
    const result = run.status().tools[0]!.result!;
    const archived = probe.archive.read(result.source).text;
    assert.equal(result.outcome, 'success');
    assert.ok(Buffer.byteLength(archived) <= 65536);
    assert.ok(JSON.parse(archived).modelResult.length < 32768);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('a plain reply is archived and durably completed after exactly one admitted request', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
  try {
    const run = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive }, route, budget);
    run.receive(sandbox.fixture.eventId, sandbox.fixture.text);
    const request = run.nextModel();
    assert.ok(request);
    const attempt = run.startModel(request, request.payload);
    assert.equal(run.maySend(attempt.attemptId, request.payload), true);
    run.finishModel(attempt.attemptId, { text: 'Synthetic answer', calls: [], stop: 'end' });
    const status = run.status();
    assert.equal(status.terminal, 'completed');
    assert.equal(status.attempts, 1);
    assert.equal(probe.archive.inspect().eventCount, 2);
    const runId = run.runId;
    probe.close();
    const reopened = openProbe(sandbox, budget, undefined, undefined, undefined, true);
    try {
      assert.equal(reopened.store.agentStatus(reopened.activity, runId).terminal, 'completed');
      assert.equal(reopened.store.requestStatus(reopened.activity, runId).attempts[0]!.outcome, 'received');
    } finally { reopened.close(); }
  } finally { try { probe.close(); } catch {} rmSync(sandbox.root, { recursive: true, force: true }); }
});
