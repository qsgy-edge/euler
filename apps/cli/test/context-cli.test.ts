import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { openSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';
import type { Binding } from '@euler/core';

function cli(args: string[]) {
  const result = spawnSync(process.execPath, ['apps/cli/src/main.ts', 'context', ...args], { encoding: 'utf8', timeout: 30000 });
  const events = result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
  return { ...result, events };
}

test('the CLI connects window recovery, project discovery and an independently authorized new-session handoff', () => {
  const result = cli(['--scenario', 'synthetic']);
  const root = result.events.find(event => event.event === 'sandbox')?.root as string | undefined;
  try {
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const receipt = result.events.find(event => event.event === 'context-result')!;
    assert.ok(receipt);
    assert.equal(receipt.syntheticPassed, true);
    assert.equal(receipt.realProvider, false);
    assert.equal(receipt.verdict, 'evidence-gap');
    assert.equal(receipt.oldGrantDenied, true);
    assert.equal(receipt.deletedHandoffRecovered, true);
    const sandbox = openSandbox(root!);
    const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    try {
      const ledger = probe.store.requestStatus(probe.activity, receipt.originRunId as string);
      assert.equal(probe.store.agentStatus(probe.activity, receipt.originRunId as string).terminal, 'completed');
      assert.ok(ledger.assemblies.some(assembly => assembly.degradation === 'window'));
      assert.ok(ledger.attempts.length >= 5);
      assert.ok(ledger.assemblies.every(assembly => assembly.context));
      assert.equal(new Set(ledger.assemblies.map(assembly => assembly.context!.windowId)).size >= 2, true);
    } finally { probe.close(); }
    const target = openProbe(sandbox, undefined, undefined, receipt.targetBinding as Binding, undefined, true);
    try {
      assert.equal(target.store.agentStatus(target.activity, receipt.targetRunId as string).terminal, 'completed');
      assert.equal(target.store.readEvolutionProposal(target.activity, receipt.proposalId as string).inert, true);
    } finally { target.close(); }
  } finally { if (root) rmSync(root, { recursive: true, force: true }); }
});

test('real context acceptance without an explicit route reports an evidence gap and sends nothing', () => {
  const result = cli(['--scenario', 'real']);
  const root = result.events.find(event => event.event === 'sandbox')?.root as string | undefined;
  try {
    assert.equal(result.status, 1);
    assert.deepEqual(result.events.find(event => event.event === 'context-evidence-gap'), {
      event: 'context-evidence-gap', reason: 'explicit-route-model-auth-budget-required', sends: 0,
    });
  } finally { if (root) rmSync(root, { recursive: true, force: true }); }
});
