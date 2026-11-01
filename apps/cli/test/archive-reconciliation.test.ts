import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { AgentRun, DEFAULT_BUDGET } from '@euler/core';
import { bindingOf, createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

test('lookup preserves the original hash after settlement commits but before its ack reaches the caller', () => {
  const sandbox = createSandbox(), path = join(sandbox.root, 'session.jsonl');
  let probe = openProbe(sandbox);
  const eventId = randomUUID(), gate = probe.store.withActivity.bind(probe.store);
  let original: ReturnType<typeof probe.archive.append> | undefined;
  try {
    probe.store.withActivity = (activity, action) => {
      const result = gate(activity, action);
      if (result && typeof result === 'object' && 'schema' in result && result.schema === 'cli-source-ack@1' && !original) {
        original = result as unknown as ReturnType<typeof probe.archive.append>;
        throw new Error('ack-handoff-lost');
      }
      return result;
    };
    assert.throws(() => probe.archive.append(eventId, 'Original canonical content'), /ack-handoff-lost/);
    probe.store.withActivity = gate;
    assert.ok(original);
    probe.close(); probe = openProbe(sandbox);
    assert.deepEqual(probe.archive.lookup(eventId), original);
    const bytes = fs.readFileSync(path, 'utf8');
    fs.writeFileSync(path, bytes.replace('Original canonical content', 'Replaced canonical content'));
    assert.throws(() => probe.archive.lookup(eventId), /archive-integrity/);
    assert.throws(() => probe.archive.append(eventId, 'Replaced canonical content'), /archive-integrity/);
  } finally { probe.close(); fs.rmSync(sandbox.root, { recursive: true, force: true }); }
});

for (const damage of ['unrecorded-tail', 'changed-prefix', 'changed-tail', 'identity-conflict'] as const) {
  test(`archive reconciliation refuses ${damage} and preserves the damaged carrier`, () => {
    const sandbox = createSandbox(), path = join(sandbox.root, 'session.jsonl'), probe = openProbe(sandbox);
    const eventId = randomUUID(), write = fs.writeSync;
    try {
      if (damage === 'unrecorded-tail') fs.appendFileSync(path, '{broken');
      else {
        let injected = false;
        fs.writeSync = ((fd: number, buffer: Uint8Array, ...args: unknown[]) => {
          if (!injected && Buffer.from(buffer).includes(Buffer.from(eventId))) {
            injected = true; write(fd, buffer, 0, Math.floor(buffer.length / 2)); throw new Error('append-unknown');
          }
          return Reflect.apply(write, fs, [fd, buffer, ...args]);
        }) as typeof fs.writeSync;
        syncBuiltinESMExports();
        assert.throws(() => probe.archive.append(eventId, 'Expected immutable source'), /append-unknown/);
        fs.writeSync = write; syncBuiltinESMExports();
        assert.throws(() => probe.store.auditStore(probe.activity), /archive-append-pending/);
        assert.equal(probe.store.fence().health, 'healthy');
        if (damage === 'changed-prefix' || damage === 'changed-tail') {
          const bytes = fs.readFileSync(path); bytes[damage === 'changed-prefix' ? 12 : bytes.length - 1] = 33;
          fs.writeFileSync(path, bytes);
        }
      }
      const bytes = fs.readFileSync(path);
      if (damage === 'identity-conflict') assert.throws(() => probe.archive.append(eventId, 'Different bytes'), /identity-conflict/);
      else if (damage === 'unrecorded-tail') {
        assert.throws(() => probe.archive.reconcile(), /archive-integrity/);
        assert.throws(() => probe.archive.append(eventId, 'Expected'), /archive-integrity/);
      }
      else assert.throws(() => probe.archive.reconcile(), /archive-integrity/);
      assert.deepEqual(fs.readFileSync(path), bytes);
      assert.equal(probe.transport.count, 0);
      assert.equal(probe.store.listCaptureJobs(probe.activity).length, 0);
    } finally { fs.writeSync = write; syncBuiltinESMExports(); probe.close(); fs.rmSync(sandbox.root, { recursive: true, force: true }); }
  });
}


test('retrying the same complete model response after a lost archive ack keeps one identity and admits no tools early', () => {
  const sandbox = createSandbox(), probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  const sync = fs.fsyncSync;
  try {
    const run = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive },
      { provider: 'fake', model: 'controlled', route: 'fixture', authNamespace: 'none' },
      { ...DEFAULT_BUDGET, contextLimit: 20000, maxTotalTokens: 60000, maxModelAttempts: 3 });
    run.receive(sandbox.fixture.eventId, sandbox.fixture.text);
    const request = run.nextModel()!, attempt = run.startModel(request, request.payload);
    assert.equal(run.maySend(attempt.attemptId, request.payload), true);
    const reply = { text: 'Run one echo.', calls: [{ id: 'echo', name: 'controlled.echo', arguments: { text: 'original' } }], stop: 'tools' as const };
    let interrupted = false;
    fs.fsyncSync = fd => {
      sync(fd);
      if (!interrupted && String(fs.fstatSync(fd, { bigint: true }).ino) === sandbox.archiveIdentity.ino) {
        interrupted = true; throw new Error('synthetic-ack-lost');
      }
    };
    syncBuiltinESMExports();
    assert.throws(() => run.finishModel(attempt.attemptId, reply), /synthetic-ack-lost/);
    fs.fsyncSync = sync; syncBuiltinESMExports();
    assert.throws(() => probe.archive.events(), /archive-append-pending/);
    assert.equal(run.status().responses.length, 0);
    assert.equal(run.pendingTools().length, 0);
    assert.equal(probe.store.listCaptureJobs(probe.activity).length, 0);
    assert.equal(probe.transport.count, 0);
    run.finishModel(attempt.attemptId, reply);
    assert.equal(run.status().responses.length, 1);
    assert.equal(probe.archive.events().filter(event => event.role === 'assistant').length, 1);
    assert.equal(probe.store.requestStatus(probe.activity, run.runId).attempts.length, 1);
  } finally {
    fs.fsyncSync = sync; syncBuiltinESMExports();
    probe.close(); fs.rmSync(sandbox.root, { recursive: true, force: true });
  }
});

// Inject a real short OS write, then lose the acknowledgement at the Host boundary.
test('a reopened archive reconciles a proven partial tail under its original identity without replacing any bytes', () => {
  const sandbox = createSandbox(), path = join(sandbox.root, 'session.jsonl');
  const eventId = randomUUID(), text = '原文必须完整保留；恢复只补齐未写入的 bytes。';
  let probe = openProbe(sandbox);
  const write = fs.writeSync;
  let interrupted = false;
  try {
    fs.writeSync = ((fd: number, buffer: Uint8Array, ...args: unknown[]) => {
      if (!interrupted && Buffer.from(buffer).includes(Buffer.from(eventId))) {
        interrupted = true;
        write(fd, buffer, 0, Buffer.from(buffer).indexOf(Buffer.from('原')) + 1);
        throw new Error('synthetic-append-unknown');
      }
      return Reflect.apply(write, fs, [fd, buffer, ...args]);
    }) as typeof fs.writeSync;
    syncBuiltinESMExports();
    assert.throws(() => probe.archive.append(eventId, text), /synthetic-append-unknown/);
    fs.writeSync = write; syncBuiltinESMExports();
    const partial = fs.readFileSync(path);
    assert.notEqual(partial.at(-1), 10);
    probe.close();
    probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    assert.throws(() => probe.archive.append(randomUUID(), 'unrelated input'), /archive-append-pending/);
    const [ack] = probe.archive.reconcile();
    assert.equal(ack!.eventId, eventId);
    assert.equal(probe.archive.read(ack!).text, text);
    assert.deepEqual(probe.archive.lookup(eventId), ack);
    assert.deepEqual(probe.archive.append(eventId, text), ack);
    assert.deepEqual(probe.archive.reconcile(), []);
    assert.equal(probe.archive.inspect().eventCount, 1);
    assert.ok(fs.readFileSync(path).subarray(0, partial.length).equals(partial));
  } finally {
    fs.writeSync = write; syncBuiltinESMExports();
    probe.close(); fs.rmSync(sandbox.root, { recursive: true, force: true });
  }
});
