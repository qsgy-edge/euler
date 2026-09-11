import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { createSandbox, openSandbox } from '../src/sandbox.ts';
import { CliArchive } from '../src/archive.ts';

test('first input has a durable ack without an assistant, reopens unchanged and deduplicates', () => {
  const sandbox = createSandbox();
  try {
    const archive = new CliArchive(sandbox, action => action());
    const ack = archive.append(sandbox.fixture.eventId, sandbox.fixture.text);
    assert.equal(ack.status, 'durable');
    const reopened = new CliArchive(openSandbox(sandbox.root), action => action());
    assert.deepEqual(reopened.lookup(sandbox.fixture.eventId), ack);
    assert.deepEqual(reopened.append(sandbox.fixture.eventId, sandbox.fixture.text), ack);
    assert.equal(reopened.read(ack).text, sandbox.fixture.text);
    assert.equal(reopened.inspect().eventCount, 1);
    assert.throws(() => reopened.append(sandbox.fixture.eventId, 'different'), /identity-conflict/);
    assert.equal(reopened.inspect().eventCount, 1);
  } finally { rmSync(sandbox.root, { recursive: true, force: true }); }
});
