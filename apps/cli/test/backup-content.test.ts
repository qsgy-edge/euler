import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_BUDGET } from '@euler/core';
import { createSandbox, createSandboxSession, bindingOf } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';
import { runBackupCli } from './support/backup-cli.ts';

function cli(root: string, command: string, ...args: string[]) {
  const result = runBackupCli(root, command, args);
  const events = result.events;
  assert.equal(result.status, 0, JSON.stringify(events.filter(event => event.event === 'error')) + result.stderr);
  return events;
}

test('recovery preserves report versions and project-scoped handoff without exposing the mixed report', () => {
  const sandbox = createSandbox();
  try {
    const seeded = spawnSync(process.execPath, ['apps/cli/test/support/backup-handoff-worker.ts', sandbox.root, 'seed'], { encoding: 'utf8' });
    assert.equal(seeded.status, 0, seeded.stderr);
    const history = JSON.parse(seeded.stdout);
    const saved = cli(sandbox.root, 'backup').find(event => event.event === 'backup-result').snapshot;
    cli(sandbox.root, 'restore-snapshot', '--snapshot', saved.id);
    const verified = spawnSync(process.execPath, ['apps/cli/test/support/backup-handoff-worker.ts', sandbox.root, 'verify', JSON.stringify(history)], { encoding: 'utf8' });
    assert.equal(verified.status, 0, verified.stderr);
    const result = JSON.parse(verified.stdout);
    assert.deepEqual(result.versions, [1, 2]);
    assert.equal(result.privateReadsRejected, 4); assert.equal(result.sends, 0);
  } finally { rmSync(sandbox.root, { recursive: true, force: true }); }
});

for (const consumer of ['memory','historian']) test(`recovery blocks a snapshot-only unclaimed ${consumer} job in a fresh session`, () => {
  const sandbox = createSandbox();
  try {
    if (consumer === 'historian') cli(sandbox.root, 'historian', '--scenario', 'synthetic');
    else {
      const seeded = spawnSync(process.execPath, ['apps/cli/test/support/backup-worker.ts', sandbox.root, 'queue-capture'], { encoding: 'utf8' });
      assert.equal(seeded.status, 0, seeded.stderr);
    }
    const before = new DatabaseSync(join(sandbox.root, 'probe.sqlite'));
    let jobId: string;
    try {
      jobId = String(before.prepare(`SELECT j.job_id FROM capture_jobs j WHERE j.consumer=? AND j.status='pending'
        AND NOT EXISTS (SELECT 1 FROM capture_work w WHERE w.job_id=j.job_id)
        AND NOT EXISTS (SELECT 1 FROM execution_streams s WHERE s.owner_kind='job' AND s.owner_id=j.job_id) LIMIT 1`).get(consumer)!.job_id);
    } finally { before.close(); }
    const saved = cli(sandbox.root, 'backup').find(event => event.event === 'backup-result').snapshot;
    const damaged = new DatabaseSync(join(sandbox.root, 'probe.sqlite'));
    try {
      damaged.exec('DROP TRIGGER immutable_capture_jobs_delete');
      assert.equal(damaged.prepare('DELETE FROM capture_jobs WHERE job_id=?').run(jobId).changes, 1);
    } finally { damaged.close(); }
    cli(sandbox.root, 'restore-snapshot', '--snapshot', saved.id);
    const binding = { ...bindingOf(sandbox), sessionId: randomUUID(), branchId: randomUUID() };
    createSandboxSession(sandbox, binding);
    const fresh = openProbe(sandbox, undefined, undefined, binding, undefined, true);
    try {
      const job = fresh.store.readCaptureJob(fresh.activity, jobId);
      const lease = fresh.store.claimCaptureJob(fresh.activity, jobId, DEFAULT_BUDGET, 1000);
      assert.deepEqual({ stage: job.stage, reason: job.reason, claimed: lease !== null },
        { stage: 'blocked', reason: 'recovered_with_gap', claimed: false });
      assert.equal(fresh.transport.count, 0);
    } finally { fresh.close(); }
  } finally { rmSync(sandbox.root, { recursive: true, force: true }); }
});

for (const scenario of ['memory', 'handoff', 'historian']) test(`snapshot recovery preserves ${scenario} bodies, references and published identities`, () => {
  const sandbox = createSandbox();
  try {
    const original = cli(sandbox.root, scenario, '--scenario', 'synthetic');
    const saved = cli(sandbox.root, 'backup').find(event => event.event === 'backup-result').snapshot;
    cli(sandbox.root, 'restore-snapshot', '--snapshot', saved.id);
    for (const file of saved.files) assert.deepEqual(readFileSync(file.source.path), readFileSync(join(saved.directory.path, file.name)));
    const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    try {
      if (scenario === 'memory') {
        const result = original.find(event => event.event === 'memory-result');
        assert.deepEqual(probe.store.readMemory(probe.activity, result.activated.record.recordId), result.activated.record);
        for (const proposal of result.proposals) assert.deepEqual(probe.store.readEvolutionProposal(probe.activity, proposal.proposalId), proposal);
      } else if (scenario === 'handoff') {
        const result = original.find(event => event.event === 'handoff-result');
        const restored = probe.archive.read(result.export);
        assert.ok(restored.text.includes(result.markdown));
        assert.ok(probe.archive.read(result.report).text.includes('合成分析报告'));
      } else {
        const result = original.find(event => event.event === 'historian-result');
        const compartment = probe.store.readCompartment(probe.activity, result.jobId);
        assert.deepEqual(compartment.source, result.compartment.source);
        assert.equal(compartment.attemptId, result.compartment.attemptId);
        const pending = probe.store.listCaptureJobs(probe.activity, 32, true, 'historian');
        assert.deepEqual(pending, []);
        const jobs = probe.store.listCaptureJobs(probe.activity, 32, false, 'historian');
        for (const job of jobs.filter(job => job.stage !== 'complete')) {
          assert.equal(job.stage, 'blocked');
          assert.equal(job.reason, 'recovered_with_gap');
          assert.equal(probe.store.claimCaptureJob(probe.activity, job.jobId, DEFAULT_BUDGET, 1000), null);
        }
      }
      assert.equal(probe.transport.count, 0);
    } finally { probe.close(); }
  } finally { rmSync(sandbox.root, { recursive: true, force: true }); }
});
