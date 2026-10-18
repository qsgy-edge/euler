import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import { CaptureRun, DEFAULT_BUDGET } from '@euler/core';
import { createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

const budget = { ...DEFAULT_BUDGET, contextLimit: 20000, maxTotalTokens: 100000, maxModelAttempts: 8 };
const route = { provider: 'synthetic', model: 'crash-fixture', route: 'synthetic-capture', authNamespace: 'synthetic', capability: 'standard' as const };
for (const point of ['before-send', 'after-send', 'after-proposal']) test(`a real process crash at ${point} preserves job/attempt identity`, async () => {
  const sandbox = createSandbox();
  try {
    const child = spawnSync(process.execPath, ['apps/cli/test/support/capture-crash-worker.ts', sandbox.root, point], { encoding: 'utf8', timeout: 20000 });
    assert.equal(child.error, undefined);
    assert(child.signal === 'SIGKILL' || child.status !== 0);
    assert.doesNotMatch(child.stderr, /Error:|ERR_/);
    await setTimeout(1050);
    const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    try {
      const job = probe.store.listCaptureJobs(probe.activity)[0]!;
      const lease = probe.store.claimCaptureJob(probe.activity, job.jobId, budget, 10000)!;
      assert(lease);
      const run = new CaptureRun(probe.store, lease, probe.archive, { proposer: [route], verifier: [route] });
      const ledger = probe.store.requestStatus(lease.activity, run.runId);
      assert.equal(ledger.run.ownerId, job.jobId);
      assert.equal(ledger.attempts.length, 1);
      if (point === 'after-proposal') {
        assert.equal(run.status().stage, 'verifying');
        assert.equal(ledger.attempts[0]!.outcome, 'received');
        const request = run.nextModel()!;
        assert.equal(JSON.parse(request.payload).p3.intent.step, 'verifier');
        assert.equal(JSON.parse(request.payload).p2.length, 0);
      } else {
        assert.equal(run.status().stage, 'unknown');
        assert.equal(run.nextModel(), null);
        const reconciled = ledger.events.find(event => event.kind === 'model/request-attempt-reconciled@v1');
        assert(reconciled);
        assert.equal(JSON.parse(reconciled.payload).evidence.outcome, point === 'before-send' ? 'not-received' : 'received');
      }
      assert.equal(probe.transport.count, 0);
    } finally { probe.close(); }
  } finally { rmSync(sandbox.root, { recursive: true, force: true }); }
});
