import assert from 'node:assert/strict';
import { readFileSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import test from 'node:test';
import { createSandbox, openSandbox, bindingOf, resourcesOf } from '../src/sandbox.ts';
import { ProbeStore } from '../../../packages/core/src/store/probe-store.ts';
import { openProbe } from '../src/probe.ts';
import { startCli } from '../src/process-driver.ts';

// Public carrier bytes and subprocess output are the source/restart seam.
test('separate processes recover the same source ack and intent without a model request', { timeout: 15000 }, async () => {
  const sandbox = createSandbox();
  try {
    const first = startCli(['run', '--scenario', 'archive-only', '--sandbox', sandbox.root]);
    assert.equal((await first.exit).code, 0);
    const original = first.observations.find(item => item.event === 'source-ack')!;
    assert.equal(original.sends, 0);
    const restarted = startCli(['recover', '--sandbox', sandbox.root]);
    assert.equal((await restarted.exit).code, 0);
    const recovered = restarted.observations.find(item => item.event === 'recovered')!;
    assert.deepEqual(recovered.source, original.ack);
    assert.deepEqual(recovered.intent, original.intent);
    assert.equal(recovered.eventCount, 1);
    assert.equal(recovered.sends, 0);
    const repeated = startCli(['run', '--scenario', 'archive-only', '--sandbox', sandbox.root]);
    assert.equal((await repeated.exit).code, 0);
    assert.deepEqual(repeated.observations.find(item => item.event === 'source-ack')!.ack, original.ack);
    const rawEvent = readFileSync(join(sandbox.root, 'session.jsonl'), 'utf8').split('\n')[1]!;
    assert.equal((original.ack as { hash: string }).hash, createHash('sha256').update(rawEvent).digest('hex'));
  } finally { rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('torn or changed source blocks dependent intent and transport; missing bound files are not recreated', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const path = join(sandbox.root, 'session.jsonl');
    const header = readFileSync(path);
    truncateSync(path, 3);
    assert.throws(() => probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text), /archive-integrity/);
    assert.equal(probe.session.readIntent(), null);
    assert.equal(probe.transport.count, 0);
    writeFileSync(path, header);
    const turn = probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
    writeFileSync(path, readFileSync(path, 'utf8').replace('preserve this input', 'tampered this input'));
    assert.throws(() => probe.session.dispatch(turn), /source-evidence-gap/);
    assert.equal(probe.transport.count, 0);
    rmSync(path);
    assert.throws(() => openSandbox(sandbox.root), /ENOENT/);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('stored inputs with invalid size or rewritten event bytes cannot receive a new ack', () => {
  for (const corruption of ['empty', 'oversize', 'reordered'] as const) {
    const sandbox = createSandbox();
    const probe = openProbe(sandbox);
    try {
      const turn = probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
      const path = join(sandbox.root, 'session.jsonl');
      const header = readFileSync(path, 'utf8').split('\n')[0]!;
      const event = { schema: 'cli-input@1', eventId: sandbox.fixture.eventId, role: 'user', text: sandbox.fixture.text };
      const changed = corruption === 'reordered'
        ? { text: event.text, role: event.role, eventId: event.eventId, schema: event.schema }
        : { ...event, text: corruption === 'empty' ? '' : 'x'.repeat(65537) };
      writeFileSync(path, header + '\n' + JSON.stringify(changed) + '\n');
      assert.throws(() => probe.archive.lookup(event.eventId), /archive-integrity/);
      assert.throws(() => probe.archive.append(event.eventId, event.text), /archive-integrity/);
      assert.throws(() => probe.session.dispatch(turn), /archive-integrity/);
      assert.equal(probe.transport.count, 0);
    } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
  }
});

test('replacing a bound source after opening blocks maintenance before its fence changes', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  const source = join(sandbox.root, 'session.jsonl');
  const original = source + '.original';
  try {
    const bytes = readFileSync(source);
    renameSync(source, original);
    writeFileSync(source, bytes);
    assert.throws(() => probe.store.beginMaintenance(randomUUID()), /file-identity-changed/);
    rmSync(source);
    renameSync(original, source);
    assert.equal(probe.store.fence().state, 'open');
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('a store cannot be rebound to another existing root', () => {
  const sandbox = createSandbox();
  const other = createSandbox();
  try {
    const resources = { ...resourcesOf(sandbox), root: resourcesOf(other).root };
    assert.throws(() => new ProbeStore(resources, sandbox.storeId, bindingOf(sandbox)), /store-resource-mismatch/);
    const probe = openProbe(sandbox);
    try { assert.equal(probe.store.fence().state, 'open'); } finally { probe.close(); }
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
    rmSync(other.root, { recursive: true, force: true });
  }
});

test('source expansion checks owner, digest and bounded Unicode ranges', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox);
  try {
    const ref = probe.archive.append(randomUUID(), '甲🙂乙丙');
    const excerpt = probe.session.tool('source.expand', ref, 1, 2);
    assert.equal(excerpt.text, '🙂乙');
    assert.equal(excerpt.total, 4);
    assert.equal(excerpt.truncated, true);
    assert.throws(() => probe.archive.expand(ref, 0, 4097), /invalid-range/);
    assert.throws(() => probe.archive.read({ ...ref, hash: '0'.repeat(64) }), /source-evidence-gap/);
    assert.throws(() => probe.archive.read({ ...ref, binding: { ...ref.binding, projectId: randomUUID() } }), /source-scope-mismatch/);
    assert.throws(() => probe.session.tool('mcp.call', ref), /unknown-tool/);
    assert.throws(() => probe.session.tool('memory.commit', ref), /tool-unavailable/);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
