import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { createSandbox } from '../src/sandbox.ts';
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
