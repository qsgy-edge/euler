import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import koffi from 'koffi';
import { ProbeStore } from '@euler/core';
import type { AgentStatus } from '@euler/core';
import { bindingOf, createSandbox, resourcesOf } from '../src/sandbox.ts';

const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));
test('CLI accepts a separately presented owner decision and maintenance observes the resulting controlled copy after process exit',
  { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
    const sandbox = createSandbox();
    let root: string | undefined;
    const events: Record<string, any>[] = [];
    const child = spawn(process.execPath, [main, 'agent', '--scenario', 'files', '--interactive', '--sandbox', sandbox.root], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', errors = '';
    child.stderr.setEncoding('utf8'); child.stderr.on('data', data => { errors += data; });
    child.stdout.setEncoding('utf8'); child.stdout.on('data', data => {
      buffer += data;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const event = JSON.parse(buffer.slice(0, newline)) as Record<string, any>;
        buffer = buffer.slice(newline + 1); events.push(event);
        if (event.event === 'file-project-bound') root = event.root.path;
        if (event.event === 'file-approval') child.stdin.write(event.command + '\n');
      }
    });
    const timeout = setTimeout(() => child.kill(), 20000);
    try {
      const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      assert.equal(code, 0, errors + JSON.stringify(events.filter(event => event.event === 'error')));
      assert.ok(root);
      assert.equal(events.filter(event => event.event === 'file-approval').length, 1);
      const result = events.find(event => event.event === 'agent-result')!;
      const status = result.status as AgentStatus;
      assert.equal(status.terminal, 'completed');
      assert.ok(status.tools.every(tool => tool.result?.outcome === 'success'));
      assert.equal(readFileSync(join(root, 'result.txt'), 'utf8'), 'EULER-T08');
      assert.equal(result.networkCount, 0);
      assert.equal(result.controlledFiles.length, 1);
      const store = new ProbeStore(resourcesOf(sandbox), sandbox.storeId, bindingOf(sandbox), false, undefined, sandbox.appId);
      const coordinator = randomUUID();
      const maintenance: Record<string, unknown> = {};
      try {
        const registered = store.maintenanceStatus().controlledFiles;
        maintenance.registered = registered;
        assert.equal(registered[0]!.path, join(root, 'result.txt'));
        assert.equal(registered[0]!.state, 'recorded');
        store.beginMaintenance(coordinator);
        const acquired = store.acquireMaintenance(coordinator);
        maintenance.acquired = acquired;
        assert.equal(acquired.acquired, true, JSON.stringify(acquired));
        assert.ok(acquired.residuals.some(item => item.path === join(root!, 'result.txt') && item.state === 'expected'));
        renameSync(join(root, 'result.txt'), join(root, 'original.txt'));
        writeFileSync(join(root, 'result.txt'), 'REPLACEMENT');
        const afterReplacement = store.acquireMaintenance(coordinator);
        maintenance.afterReplacement = afterReplacement;
        assert.equal(afterReplacement.acquired, false);
        assert.ok(store.maintenanceStatus().residuals.some(item => item.reason === 'project-copy-reconciliation-required'));
        assert.equal(readFileSync(join(root, 'result.txt'), 'utf8'), 'REPLACEMENT');
        store.cancelMaintenance(coordinator);
      } finally { store.close(); }
      mkdirSync('artifacts', { recursive: true });
      const artifact = join('artifacts', `t08-files-${process.platform}-${Date.now()}.json`);
      const revision = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
      const worktree = spawnSync('git', ['status', '--short'], { encoding: 'utf8' });
      writeFileSync(artifact, JSON.stringify({ schema: 't08-files-evidence@1', platform: process.platform, arch: process.arch,
        os: release(), node: process.version, implementationCommit: revision.status === 0 ? revision.stdout.trim() : null,
        worktree: worktree.status === 0 ? worktree.stdout.trim() : null, fixtureDigest: result.fixtureDigest,
        ownerInput: events.filter(event => event.event === 'file-approval'), result,
        maintenance,
        realProvider: 'evidence-gap: synthetic transport only' }, null, 2));
      t.diagnostic(`T08 Windows receipts: ${artifact}`);
    } finally { clearTimeout(timeout); child.kill(); if (root) rmSync(root, { recursive: true, force: true }); rmSync(sandbox.root, { recursive: true, force: true }); }
  });

test('CLI binds a canonical resource root when TEMP uses an 8.3 spelling', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const parent = mkdtempSync(join(tmpdir(), 'euler-short-cli-'));
  let child: ReturnType<typeof spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let root: string | undefined;
  try {
    const shortPath = koffi.load('kernel32.dll').func('uint32 __stdcall GetShortPathNameW(str16 path, void *buffer, uint32 size)');
    const buffer = Buffer.alloc(8192);
    const length = shortPath(parent, buffer, 4096) as number;
    assert.ok(length > 0 && length < 4096);
    const short = buffer.toString('utf16le', 0, length * 2);
    if (short.toLowerCase() === realpathSync.native(parent).toLowerCase()) { t.skip('8.3 names unavailable on this volume'); return; }
    child = spawn(process.execPath, [main, 'agent', '--scenario', 'files', '--interactive'],
      { env: { ...process.env, TEMP: short, TMP: short }, stdio: ['pipe', 'pipe', 'pipe'] });
    let pending = '', errors = '';
    const events: Record<string, any>[] = [];
    child.stderr!.setEncoding('utf8'); child.stderr!.on('data', data => { errors += data; });
    child.stdout!.setEncoding('utf8'); child.stdout!.on('data', data => {
      pending += data;
      for (;;) {
        const end = pending.indexOf('\n');
        if (end < 0) break;
        const event = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1); events.push(event);
        if (event.event === 'file-project-bound') root = event.root.path;
        if (event.event === 'file-approval') child!.stdin!.write(event.command + '\n');
      }
    });
    timer = setTimeout(() => child!.kill(), 20000);
    const code = await new Promise<number | null>((resolve, reject) => { child!.once('error', reject); child!.once('close', resolve); });
    assert.equal(code, 0, errors);
    assert.equal(events.filter(event => event.event === 'file-approval').length, 1,
      JSON.stringify(events.filter(event => event.event === 'agent-result').map(event => event.status.tools.map((tool: AgentStatus['tools'][number]) => tool.result?.outcome))));
    assert.ok(root);
    assert.equal(root.toLowerCase(), realpathSync.native(root).toLowerCase());
    assert.equal(readFileSync(join(root, 'result.txt'), 'utf8'), 'EULER-T08');
    const result = events.find(event => event.event === 'agent-result');
    assert.equal(result?.status.terminal, 'completed');
    assert.ok(result?.status.tools.every((tool: AgentStatus['tools'][number]) => tool.result?.outcome === 'success'));
  } finally { clearTimeout(timer); child?.kill(); if (root) rmSync(root, { recursive: true, force: true }); rmSync(parent, { recursive: true, force: true }); }
});

test('CLI reports file capability unavailable on unsupported operating systems', { skip: process.platform === 'win32' }, () => {
  const sandbox = createSandbox();
  try {
    const child = spawnSync(process.execPath, [main, 'agent', '--scenario', 'files', '--sandbox', sandbox.root], { encoding: 'utf8', timeout: 20000 });
    assert.equal(child.status, 0, child.stderr);
    const result = child.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(event => event.event === 'agent-result');
    assert.equal(result.fileCapability, 'unavailable');
    assert.ok((result.status as AgentStatus).tools.every(tool => tool.result?.executionState === 'not_started' && tool.result.outcome === 'unavailable'));
  } finally { rmSync(sandbox.root, { recursive: true, force: true }); }
});
