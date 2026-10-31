import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bindingOf, createSandboxSession, openSandbox } from '../../src/sandbox.ts';
import { openProbe } from '../../src/probe.ts';
import { deliverMemoryInfo } from '../../src/owner-memory.ts';
import type { MemoryRecord, SourceAck } from '@euler/core';

const [root, input] = process.argv.slice(2);
const expected = JSON.parse(input!) as { target: MemoryRecord; otherId: string; removeOther?: boolean; tokens: string[]; jobs: string[]; sources: SourceAck[]; survivor?: SourceAck };
const sandbox = openSandbox(root!);
const binding = { ...bindingOf(sandbox), sessionId: randomUUID(), branchId: randomUUID() };
createSandboxSession(sandbox, binding);
const probe = openProbe(sandbox, undefined, undefined, binding, undefined, true);
try {
  const { store, activity } = probe;
  store.auditStore(activity);
  assert.throws(() => store.readMemory(activity, expected.target.recordId));
  if (!expected.removeOther) assert.equal(store.readMemory(activity, expected.otherId).recordId, expected.otherId);
  const errors: string[] = [];
  const unavailable = (action: () => unknown) => {
    assert.throws(action, (error: unknown) => { assert.ok(error instanceof Error); errors.push(error.message); return true; });
  };
  for (const source of expected.sources) {
    const original = openProbe(sandbox, undefined, undefined, source.binding, undefined, true);
    try {
      assert.throws(() => original.store.expandSource(original.activity, { ref: source, offset: 0, limit: 4096 }),
        (error: unknown) => { assert.ok(error instanceof Error); assert.match(error.message, /source-evidence-gap|archive-integrity/); errors.push(error.message); return true; });
    } finally { original.close(); }
  }
  if (expected.survivor) {
    const original = openProbe(sandbox, undefined, undefined, expected.survivor.binding, undefined, true);
    try { assert.ok(original.store.expandSource(original.activity, { ref: expected.survivor, offset: 0, limit: 4096 }).text.length > 0); }
    finally { original.close(); }
  }
  const original = openProbe(sandbox, undefined, undefined, expected.target.source.binding, undefined, true);
  try { for (const token of expected.tokens) unavailable(() => original.store.readMemoryPresentation(original.activity, token)); }
  finally { original.close(); }
  for (const job of expected.jobs) unavailable(() => store.readCaptureJob(activity, job));
  store.rebuildSearchProjection(activity); store.rebuildSourceProjection(activity);
  store.drainSearchProjection(activity); store.drainSearchProjection(activity);
  store.drainSourceProjection(activity); store.drainSourceProjection(activity);
  const memory = store.searchMemories(activity, { query: expected.target.content });
  assert.equal(memory.status, 'ready');
  assert.equal(memory.results.some(row => row.kind === 'memory' && row.record.recordId === expected.target.recordId), false);
  const sources = store.searchSources(activity, { query: expected.target.content });
  assert.equal(JSON.stringify(sources).includes(expected.target.content), false);
  deliverMemoryInfo(sandbox, probe);
  const turn = probe.session.prepare(randomUUID(), 'A new synthetic task after controlled purge.');
  probe.session.dispatch(turn);
  assert.equal(probe.transport.count, 1);
  assert.equal(probe.transport.payloads.some(payload => payload.includes(expected.target.content)), false);
  console.log(JSON.stringify({ event: 'purge-non-resurrection', sends: probe.transport.count, errors, memory: memory.status, canaryHits: 0 }));
} finally { probe.close(); }
