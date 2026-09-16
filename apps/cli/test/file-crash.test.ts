import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, release } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AgentRun } from '@euler/core';
import { AGENT_BUDGET } from '../src/agent-cli.ts';
import { bindingOf, createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

test('a native create that leaves a file but returns denied keeps unknown and cleanup responsibility', { skip: process.platform !== 'win32' }, () => {
  const sandbox = createSandbox();
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'euler-file-filter-')));
  try {
    const worker = fileURLToPath(new URL('./file-crash-worker.ts', import.meta.url));
    const processResult = spawnSync(process.execPath, [worker, sandbox.root, root, 'filter-denial'], { encoding: 'utf8', timeout: 20000 });
    assert.equal(processResult.status, 0, processResult.stderr + processResult.stdout);
    const result = JSON.parse(processResult.stdout.trim());
    assert.equal(existsSync(join(root, 'crash.txt')), true);
    assert.equal(readFileSync(join(root, 'crash.txt')).length, 0);
    assert.equal(result.status.terminal, 'blocked-unknown');
    assert.equal(result.status.tools[0].result.executionState, 'started');
    assert.equal(result.status.tools[0].result.outcome, 'unknown');
    assert.equal(result.status.tools[1].result.executionState, 'not_started');
    const probe = openProbe(sandbox, AGENT_BUDGET, undefined, undefined, undefined, true);
    try {
      const copy = probe.store.maintenanceStatus().controlledFiles[0]!;
      assert.equal(copy.state, 'unknown');
      assert.equal(copy.path, join(root, 'crash.txt'));
      assert.equal(copy.responsibility, 'host-project-resource');
    } finally { probe.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(sandbox.root, { recursive: true, force: true }); }
});

for (const phase of ['before-io', 'after-flush']) test(`file process death at ${phase} retains unknown cleanup evidence without retrying`,
  { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
    const sandbox = createSandbox();
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'euler-file-crash-')));
    const worker = fileURLToPath(new URL('./file-crash-worker.ts', import.meta.url));
    const child = spawn(process.execPath, [worker, sandbox.root, root, phase], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { errors += chunk; });
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const timeout = setTimeout(() => child.kill(), 20000);
    const ready = new Promise<{ runId: string }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', () => reject(new Error('worker exited before barrier: ' + errors)));
      child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => {
        output += chunk;
        const line = output.split('\n').find(line => line.includes('file-crash-barrier'));
        if (line && output.includes('\n')) resolve(JSON.parse(line));
      });
    });
    try {
      const barrier = await ready;
      assert.equal(existsSync(join(root, 'crash.txt')), phase === 'after-flush');
      if (phase === 'after-flush') assert.equal(readFileSync(join(root, 'crash.txt'), 'utf8'), 'DURABLE SYNTHETIC COPY');
      child.kill();
      const terminal = await exited;
      assert.ok(terminal.signal || terminal.code !== 0);
      const probe = openProbe(sandbox, AGENT_BUDGET, undefined, undefined, undefined, true);
      try {
        const status = probe.store.agentStatus(probe.activity, barrier.runId);
        assert.equal(status.tools[0]!.started, true);
        assert.equal(status.tools[0]!.result, null);
        const copies = probe.store.maintenanceStatus().controlledFiles;
        assert.equal(copies[0]!.state, 'unknown');
        assert.equal(copies[0]!.path, join(root, 'crash.txt'));
        assert.equal(copies[0]!.responsibility, 'host-project-resource');
        assert.throws(() => new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive },
          { provider: 'fake', model: 'test', route: 'fixture', authNamespace: 'synthetic' }, AGENT_BUDGET), /request-recovery-required/);
        const ledger = probe.store.requestStatus(probe.activity, barrier.runId);
        assert.equal(ledger.attempts.length, 1);
        mkdirSync('artifacts', { recursive: true });
        const artifact = join('artifacts', `t08-crash-${process.platform}-${phase}-${Date.now()}.json`);
        writeFileSync(artifact, JSON.stringify({ phase, platform: process.platform, os: release(), node: process.version,
          barrier, terminal, status, copies, ledger, targetExists: existsSync(join(root, 'crash.txt')) }, null, 2));
        t.diagnostic(`T08 process-death evidence: ${artifact}`);
      } finally { probe.close(); }
    } finally { clearTimeout(timeout); child.kill(); await exited; rmSync(root, { recursive: true, force: true }); rmSync(sandbox.root, { recursive: true, force: true }); }
  });
