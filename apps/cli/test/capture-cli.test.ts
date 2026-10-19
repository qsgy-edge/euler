import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

test('the explicit synthetic capture CLI drains and reopens its durable result without another request', () => {
  const sandbox = createSandbox();
  try {
    const run = () => execFileSync(process.execPath, ['apps/cli/src/main.ts', 'capture', '--sandbox', sandbox.root, '--scenario', 'synthetic'],
      { encoding: 'utf8', timeout: 20000 }).trim().split('\n').map(line => JSON.parse(line));
    const first = run().find(item => item.event === 'capture-result');
    assert.equal(first.status.record.lifecycle, 'active');
    assert.equal(first.status.record.verification, 'verified');
    assert.equal(first.sends, 4);
    const replay = run().find(item => item.event === 'capture-result');
    assert.equal(replay.status.jobId, first.status.jobId);
    assert.equal(replay.status.record.headEventId, first.status.record.headEventId);
    assert.equal(replay.sends, 0);
    const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    try {
      const info = probe.store.listHostInfo(probe.activity);
      assert.equal(info.length, 1); assert.equal(info[0]!.delivery, 'delivered'); assert.equal(info[0]!.read, 'unread');
    }
    finally { probe.close(); }
  } finally { rmSync(sandbox.root, { recursive: true, force: true }); }
});
