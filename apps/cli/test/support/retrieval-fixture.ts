import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { AgentRun, DEFAULT_BUDGET } from '@euler/core';
import { bindingOf, createSandbox } from '../../src/sandbox.ts';
import type { Sandbox } from '../../src/sandbox.ts';
import { openProbe } from '../../src/probe.ts';

export const retrievalBudget = { ...DEFAULT_BUDGET, contextLimit: 24000, maxTotalTokens: 90000, maxModelAttempts: 3 };
const route = { provider: 'synthetic', model: 'retrieval-ledger', route: 'fixture', authNamespace: 'none' };
export function retrievalFixture(sandbox: Sandbox = createSandbox()) {
  const probe = openProbe(sandbox, retrievalBudget, undefined, undefined, undefined, true);
  const record = probe.store.rememberMemory(probe.activity, {
    input: probe.archive.append(randomUUID(), '记住偏好：Juniper uses the local compiler'), hostInfo: 'durable',
  }).record;
  probe.store.drainSearchProjection(probe.activity);
  const run = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive }, route, retrievalBudget);
  run.receive(randomUUID(), 'Find the Juniper compiler preference');
  let connected = true;
  const disconnect = () => { if (connected) { if (!run.status().terminal) run.cancel(); probe.close(); connected = false; } };
  return { sandbox, probe, record, run, search() {
    const first = run.nextModel()!, attempt = run.startModel(first, first.payload);
    assert.equal(run.maySend(attempt.attemptId, first.payload), true);
    run.finishModel(attempt.attemptId, { text: '', stop: 'tools', calls: [
      { id: 'find-memory', name: 'memory.search', arguments: { query: 'Juniper' } },
    ] });
    run.startTool('find-memory');
    return run.coreToolResult('find-memory')!;
  }, disconnect, close() { disconnect(); rmSync(sandbox.root, { recursive: true, force: true }); } };
}
