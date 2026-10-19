import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createSandbox, resourcesOf } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';
import { verifiedCandidate } from './support/memory-evolution.ts';

test('capture waits for an older Info batch before any request and continues after recovery', () => {
  const sandbox = createSandbox();
  try {
    const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    try {
      const record = verifiedCandidate(probe, '本项目合成验证使用 TypeScript').record!;
      probe.store.promoteMemory(probe.activity, record.recordId, record);
    } finally { probe.close(); }
    const db = new DatabaseSync(resourcesOf(sandbox).store.path);
    try { db.exec("CREATE TRIGGER fail_info BEFORE INSERT ON host_info_batches BEGIN SELECT RAISE(ABORT,'injected-info-failure'); END"); }
    finally { db.close(); }
    const run = () => execFileSync(process.execPath, ['apps/cli/src/main.ts', 'capture', '--sandbox', sandbox.root, '--scenario', 'synthetic'],
      { encoding: 'utf8', timeout: 20000 }).trim().split('\n').map(line => JSON.parse(line));
    const blocked = run();
    assert.ok(blocked.some(event => event.event === 'info-error'));
    assert.equal(blocked.filter(event => event.event === 'capture-request').length, 0);
    const waiting = blocked.find(event => event.event === 'capture-result');
    assert.equal(waiting.sends, 0);
    assert.equal(waiting.status.stage, 'pending');
    assert.equal(waiting.status.reason, 'host-info-recovery-required');
    const restored = new DatabaseSync(resourcesOf(sandbox).store.path);
    try { restored.exec('DROP TRIGGER fail_info'); } finally { restored.close(); }
    const recovered = run(), result = recovered.find(event => event.event === 'capture-result');
    assert.equal(result.status.jobId, waiting.status.jobId);
    assert.ok(result.sends > 0);
    assert.ok(recovered.findIndex(event => event.event === 'info-notice') < recovered.findIndex(event => event.event === 'capture-request'));
    const reopened = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    try { assert.deepEqual(reopened.store.listHostInfo(reopened.activity).map(info => info.delivery), ['delivered']); }
    finally { reopened.close(); }
  } finally { rmSync(sandbox.root, { recursive: true, force: true }); }
});

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
