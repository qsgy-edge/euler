import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { Binding } from '@euler/core';
import { bindingOf, createSandbox, createSandboxSession } from '../src/sandbox.ts';
import type { Sandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';
import { cliEntry } from '../src/process-driver.ts';

function interruptSource(sandbox: Sandbox, binding: Binding) {
  const eventId = randomUUID(), text = '原始 secondary session bytes survive a process restart.';
  const probe = openProbe(sandbox, undefined, undefined, binding, undefined, true);
  let source;
  try { source = probe.store.sessionSource(binding); } finally { probe.close(); }
  const header = readFileSync(source.path);
  const line = Buffer.from(JSON.stringify({ schema: 'cli-input@1', eventId, role: 'user', text }) + '\n');
  const cut = line.indexOf(Buffer.from('原')) + 1;
  // Exit inside the real carrier write, without returning an acknowledgement or closing the probe.
  const interrupted = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { openSandbox } from ${JSON.stringify(new URL('../src/sandbox.ts', import.meta.url).href)};
    import { openProbe } from ${JSON.stringify(new URL('../src/probe.ts', import.meta.url).href)};
    const sandbox = openSandbox(${JSON.stringify(sandbox.root)});
    const probe = openProbe(sandbox, undefined, undefined, ${JSON.stringify(binding)}, undefined, true);
    const identity = probe.store.sessionSource(${JSON.stringify(binding)}).identity;
    const write = fs.writeSync;
    fs.writeSync = (fd, buffer, ...args) => {
      const stat = fs.fstatSync(fd, { bigint: true });
      if (String(stat.dev) === identity.dev && String(stat.ino) === identity.ino) {
        const count = write(fd, buffer, 0, ${cut});
        fs.fsyncSync(fd);
        write(1, JSON.stringify({ event: 'partial-write', count }) + '\\n');
        process.exit(86);
      }
      return Reflect.apply(write, fs, [fd, buffer, ...args]);
    };
    syncBuiltinESMExports();
    probe.archive.append(${JSON.stringify(eventId)}, ${JSON.stringify(text)});
    process.exit(87);
  `], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.ifError(interrupted.error);
  assert.equal(interrupted.status, 86, interrupted.stderr);
  assert.deepEqual(JSON.parse(interrupted.stdout), { event: 'partial-write', count: cut });
  const partial = readFileSync(source.path);
  assert.deepEqual(partial, Buffer.concat([header, line.subarray(0, cut)]));
  return { eventId, text, path: source.path, partial, complete: Buffer.concat([header, line]) };
}

function pending(sandbox: Sandbox, binding: Binding) {
  const probe = openProbe(sandbox, undefined, undefined, binding, undefined, true);
  try { return probe.store.sourceAppends(probe.activity); } finally { probe.close(); }
}

function reconcile(sandbox: Sandbox, sessionId?: string) {
  const result = spawnSync(process.execPath, [cliEntry, 'archive-reconcile', '--sandbox', sandbox.root,
    ...(sessionId === undefined ? [] : ['--session', sessionId])], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.ifError(result.error);
  return { ...result, observations: result.stdout.trim().split('\n').map(line => JSON.parse(line)) };
}

test('archive-reconcile --session completes a registered secondary source after real process exit with original identity and bytes', t => {
  const sandbox = createSandbox();
  t.after(() => rmSync(sandbox.root, { recursive: true, force: true }));
  const binding = { ...bindingOf(sandbox), sessionId: randomUUID(), branchId: randomUUID() };
  createSandboxSession(sandbox, binding);
  const original = interruptSource(sandbox, binding);
  assert.equal(pending(sandbox, binding)[0]!.eventId, original.eventId);
  const defaultBytes = readFileSync(join(sandbox.root, 'session.jsonl'));

  const restarted = reconcile(sandbox, binding.sessionId);
  assert.equal(restarted.status, 0, restarted.stdout + restarted.stderr);
  const result = restarted.observations.find(item => item.event === 'archive-reconciled');
  assert.equal(result.sends, 0);
  assert.equal(result.sources.length, 1);
  const [ack] = result.sources;
  assert.equal(ack.eventId, original.eventId);
  assert.deepEqual(ack.binding, binding);
  assert.deepEqual(readFileSync(original.path), original.complete);
  assert.deepEqual(readFileSync(join(sandbox.root, 'session.jsonl')), defaultBytes);
  assert.deepEqual(pending(sandbox, binding), []);
  const probe = openProbe(sandbox, undefined, undefined, binding, undefined, true);
  try {
    assert.deepEqual(probe.archive.lookup(original.eventId), ack);
    assert.equal(probe.archive.read(ack).text, original.text);
    assert.equal(probe.archive.inspect().eventCount, 1);
  } finally { probe.close(); }
  const repeated = reconcile(sandbox, binding.sessionId);
  assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr);
  assert.deepEqual(repeated.observations.find(item => item.event === 'archive-reconciled').sources, []);
  assert.deepEqual(readFileSync(original.path), original.complete);
});

test('archive-reconcile without --session recovers only the default pending source', t => {
  const sandbox = createSandbox();
  t.after(() => rmSync(sandbox.root, { recursive: true, force: true }));
  const binding = { ...bindingOf(sandbox), sessionId: randomUUID(), branchId: randomUUID() };
  createSandboxSession(sandbox, binding);
  const secondary = interruptSource(sandbox, binding);
  const secondaryPending = pending(sandbox, binding);
  const original = interruptSource(sandbox, bindingOf(sandbox));

  const restarted = reconcile(sandbox);
  assert.equal(restarted.status, 0, restarted.stdout + restarted.stderr);
  const result = restarted.observations.find(item => item.event === 'archive-reconciled');
  assert.equal(result.sends, 0);
  assert.deepEqual(result.sources.map((source: { eventId: string }) => source.eventId), [original.eventId]);
  assert.deepEqual(readFileSync(original.path), original.complete);
  assert.deepEqual(pending(sandbox, bindingOf(sandbox)), []);
  assert.deepEqual(readFileSync(secondary.path), secondary.partial);
  assert.deepEqual(pending(sandbox, binding), secondaryPending);
});

test('archive-reconcile rejects an unregistered session without changing either carrier or pending append', t => {
  const sandbox = createSandbox();
  t.after(() => rmSync(sandbox.root, { recursive: true, force: true }));
  const binding = { ...bindingOf(sandbox), sessionId: randomUUID(), branchId: randomUUID() };
  createSandboxSession(sandbox, binding);
  const secondary = interruptSource(sandbox, binding);
  const original = interruptSource(sandbox, bindingOf(sandbox));
  const secondaryPending = pending(sandbox, binding), defaultPending = pending(sandbox, bindingOf(sandbox));

  const rejected = reconcile(sandbox, randomUUID());
  assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
  assert.deepEqual(rejected.observations.find(item => item.event === 'error'), { event: 'error', reason: 'archive-session-not-registered' });
  assert.equal(rejected.observations.some(item => item.event === 'archive-reconciled'), false);
  assert.deepEqual(readFileSync(original.path), original.partial);
  assert.deepEqual(readFileSync(secondary.path), secondary.partial);
  assert.deepEqual(pending(sandbox, bindingOf(sandbox)), defaultPending);
  assert.deepEqual(pending(sandbox, binding), secondaryPending);
});
