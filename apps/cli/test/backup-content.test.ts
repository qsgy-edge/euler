import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_BUDGET } from '@euler/core';
import { createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

function cli(root: string, command: string, ...args: string[]) {
  const result = spawnSync(process.execPath, ['apps/cli/src/main.ts', command, '--sandbox', root, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  const events = result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(result.status, 0, JSON.stringify(events.filter(event => event.event === 'error')) + result.stderr);
  return events;
}

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
