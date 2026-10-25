import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import { CaptureRun, DEFAULT_BUDGET } from '@euler/core';
import { createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

const budget = { ...DEFAULT_BUDGET, contextLimit: 20000, maxTotalTokens: 100000, maxModelAttempts: 8 };
const route = { provider: 'synthetic', model: 'historian-crash-fixture', route: 'fixture', authNamespace: 'synthetic', capability: 'standard' as const };
for (const point of ['after-raw','before-send','after-send','after-reply','after-body','after-publication'])
  test('a killed Historian process preserves exact recovery semantics at ' + point, async () => {
    const sandbox = createSandbox();
    try {
      const child = spawnSync(process.execPath, ['apps/cli/test/support/historian-crash-worker.ts', sandbox.root, point], { encoding: 'utf8', timeout: 20000 });
      assert.equal(child.error, undefined); assert.ok(child.signal === 'SIGKILL' || child.status !== 0); assert.doesNotMatch(child.stderr, /Error:|ERR_/);
      const receipt = JSON.parse(child.stdout.trim()); assert.equal(receipt.point, point);
      await setTimeout(1050);
      const probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
      try {
        if (point === 'after-raw') {
          assert.deepEqual(probe.store.listCaptureJobs(probe.activity, 32, false, 'historian'), []);
          const job = probe.store.queueHistorianBoundary(probe.activity, receipt.runId, { minBytes: 4096, maxBytes: 60000 })!;
          assert.ok(job); assert.equal(job.range.length, 2); assert.equal(probe.transport.count, 0); return;
        }
        const job = probe.store.readCaptureJob(probe.activity, receipt.jobId);
        if (point === 'after-publication') {
          assert.equal(job.stage, 'complete');
          assert.equal(probe.store.claimCaptureJob(probe.activity, job.jobId, budget, 10000), null);
          assert.equal(probe.store.readCompartment(probe.activity, job.jobId).body.summary, 'Synthetic result retained.'); return;
        }
        if (point === 'after-body') {
          const orphan = probe.archive.lookup(job.jobId)!; assert.ok(orphan);
          assert.equal(probe.store.isCaptureOutput(probe.activity, orphan), true, 'unpublished derived body must not become raw evidence');
          assert.throws(() => probe.store.readCompartment(probe.activity, job.jobId), /compartment-unavailable/);
        }
        const lease = probe.store.claimCaptureJob(probe.activity, job.jobId, budget, 10000)!; assert.ok(lease);
        const run = new CaptureRun(probe.store, lease, probe.archive, { historian: [route] }, undefined, 'capture-counting@1');
        assert.equal(run.nextModel(), null);
        const ledger = probe.store.requestStatus(lease.activity, run.runId); assert.equal(ledger.attempts.length, 1);
        if (['before-send','after-send'].includes(point)) {
          assert.equal(run.status().stage, 'unknown'); assert.equal(ledger.attempts[0]!.outcome, 'unknown-sent');
          const reconciled = ledger.events.find(event => event.kind === 'model/request-attempt-reconciled@v1')!; assert.ok(reconciled);
          assert.equal(JSON.parse(reconciled.payload).evidence.outcome, point === 'before-send' ? 'not-received' : 'received');
        } else {
          assert.equal(run.status().stage, 'complete'); assert.equal(ledger.attempts[0]!.outcome, 'received');
          assert.equal(probe.store.readCompartment(probe.activity, job.jobId).body.summary, 'Synthetic result retained.');
        }
        assert.equal(probe.transport.count, 0);
      } finally { probe.close(); }
    } finally { rmSync(sandbox.root, { recursive: true, force: true }); }
  });
