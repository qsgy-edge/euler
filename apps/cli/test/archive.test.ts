import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { createSandbox, resourcesOf } from '../src/sandbox.ts';
import { CliArchive } from '../src/archive.ts';
import { openProbe } from '../src/probe.ts';

test('first input has a durable ack without an assistant, reopens unchanged and deduplicates', () => {
  const sandbox = createSandbox();
  let probe = openProbe(sandbox);
  try {
    const archive = probe.archive;
    const ack = archive.append(sandbox.fixture.eventId, sandbox.fixture.text);
    assert.equal(ack.status, 'durable');
    probe.close(); probe = openProbe(sandbox);
    const reopened = probe.archive;
    assert.deepEqual(reopened.lookup(sandbox.fixture.eventId), ack);
    assert.deepEqual(reopened.append(sandbox.fixture.eventId, sandbox.fixture.text), ack);
    assert.equal(reopened.read(ack).text, sandbox.fixture.text);
    assert.equal(reopened.inspect().eventCount, 1);
    assert.throws(() => reopened.append(sandbox.fixture.eventId, 'different'), /identity-conflict/);
    assert.equal(reopened.inspect().eventCount, 1);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('returned acknowledgements cannot change later reads or archive identities', () => {
  const sandbox = createSandbox(), probe = openProbe(sandbox);
  try {
    const id = randomUUID(), ack = probe.archive.append(id, 'Original');
    const expected = structuredClone(ack);
    const reader = new CliArchive(sandbox, action => action());
    for (const returned of [ack, probe.archive.append(id, 'Original'), probe.archive.lookup(id)!, reader.events()[0]!.ack]) {
      returned.hash = '0'.repeat(64);
      returned.binding.projectId = randomUUID();
      assert.deepEqual(probe.archive.read(expected), { text: 'Original', role: 'user' });
      assert.deepEqual(reader.read(expected), { text: 'Original', role: 'user' });
      assert.deepEqual(probe.archive.lookup(id), expected);
    }
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

for (const mutation of ['same-size-content', 'same-size-role', 'unrelated-duplicate'] as const)
  test('a repeated archive read revalidates fresh bytes after ' + mutation, () => {
    const sandbox = createSandbox(), probe = openProbe(sandbox);
    try {
      const ack = probe.archive.append(randomUUID(), 'Original');
      if (mutation === 'unrelated-duplicate') probe.archive.append(randomUUID(), 'Other event');
      const reader = new CliArchive(sandbox, action => action());
      assert.deepEqual(reader.read(ack), { text: 'Original', role: 'user' });
      const path = resourcesOf(sandbox).source.path, before = readFileSync(path, 'utf8'), stat = statSync(path);
      const changed = mutation === 'same-size-content' ? before.replace('Original', 'Modified')
        : mutation === 'same-size-role' ? before.replace('"role":"user"', '"role":"tool"')
        : before + before.split('\n')[2]! + '\n';
      if (mutation !== 'unrelated-duplicate') assert.equal(Buffer.byteLength(changed), Buffer.byteLength(before));
      writeFileSync(path, changed); utimesSync(path, stat.atime, stat.mtime);
      assert.throws(() => reader.read(ack), mutation === 'unrelated-duplicate' ? /archive-integrity: duplicate identity/ : /source-evidence-gap/);
      writeFileSync(path, before);
      assert.deepEqual(reader.read(ack), { text: 'Original', role: 'user' });
    } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
  });

test('identical archive bytes in a replacement file do not reuse the old identity', () => {
  const sandbox = createSandbox(), probe = openProbe(sandbox);
  try {
    const ack = probe.archive.append(randomUUID(), 'Original');
    const reader = new CliArchive(sandbox, action => action());
    assert.equal(reader.read(ack).text, 'Original');
    const path = resourcesOf(sandbox).source.path, bytes = readFileSync(path);
    renameSync(path, path + '.original');
    try {
      writeFileSync(path, bytes);
      assert.throws(() => reader.read(ack), /file-identity-changed/);
    } finally { rmSync(path, { force: true }); renameSync(path + '.original', path); }
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
