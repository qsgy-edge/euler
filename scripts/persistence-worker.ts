// Controlled X-01 process fixture. Never imported by the production CLI or Core.
import { writeSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { check } from '@euler/core';
import { bindingOf, createSandbox, createSandboxSession, openSandbox, resourcesOf } from '../apps/cli/src/sandbox.ts';
import { openProbe } from '../apps/cli/src/probe.ts';
import fixture from '../fixtures/persistence.json' with { type: 'json' };

const args = parseArgs({ allowPositionals: true, options: {
  root: { type: 'string' }, phase: { type: 'string', default: 'commit' }, cut: { type: 'string' }, token: { type: 'string' },
  'app-id': { type: 'string' }, session: { type: 'string', default: 'first' },
} });
const command = args.positionals[0];
const phase = args.values.phase;
check(['prepare','run','recover','identity'].includes(command!), 'invalid-fixture-command');
check(['intent','activate','preview','commit','rollback'].includes(phase), 'invalid-fixture-phase');
const emit = (event: string, value: unknown) => writeSync(1, JSON.stringify({ event, value }) + '\n');

async function main() {
  if (command === 'identity') {
    const sandbox = openSandbox(args.values.root!);
    const probe = openProbe(sandbox);
    try { emit('identity', { appId: sandbox.appId, storeId: sandbox.storeId, root: sandbox.root,
      resources: resourcesOf(sandbox), diagnostics: probe.store.diagnostics(), cwd: process.cwd() }); }
    finally { probe.close(); }
    return;
  }
  const sandbox = command === 'prepare'
    ? args.values['app-id'] ? createSandbox(args.values['app-id']) : createSandbox()
    : openSandbox(args.values.root!);
  if (command === 'prepare') createSandboxSession(sandbox, { ...bindingOf(sandbox), sessionId: fixture.secondSessionId });
  const binding = args.values.session === 'second' ? { ...bindingOf(sandbox), sessionId: fixture.secondSessionId } : bindingOf(sandbox);
  const probe = openProbe(sandbox, undefined, undefined, binding);
  try {
    if (command === 'prepare') {
      probe.session.prepare(sandbox.fixture.eventId, sandbox.fixture.text);
      const candidates = fixture.facts.map((content, index) => {
        const source = probe.archive.append(fixture.sourceIds[index]!, content);
        const c = probe.store.captureMemory(probe.activity, source, content, {
          type: 'decision', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: [],
        });
        return probe.store.verifyMemory(probe.activity, c.record.recordId, c.record, 'pass', [source]).record;
      });
      const batch = phase === 'activate' ? null : probe.store.activateMemoryBatch(probe.activity, candidates);
      const targets = batch ? batch.events.map(event => event.after) : candidates;
      const source = probe.archive.append(fixture.correctionSourceId, fixture.correction);
      probe.archive.append(fixture.intentSourceId, fixture.nextStep);
      let token: string | null = null;
      if (['preview','commit','rollback'].includes(phase)) {
        const inspect = probe.store.inspectMemoryPresentation(probe.activity,
          phase === 'rollback' ? targets.map(target => target.recordId) : [targets[0]!.recordId]);
        const preview = probe.store.previewMemoryOperation(probe.activity, inspect.token, phase === 'rollback'
          ? { kind: 'rollback', batchId: batch!.batchId, eventIds: batch!.events.map(event => event.eventId) }
          : { kind: 'correct', input: source, content: fixture.correction });
        probe.store.acknowledgeMemoryPresentation(probe.activity, preview.token, preview.hash);
        token = phase === 'preview' ? inspect.token : preview.token;
      }
      emit('prepared', { root: sandbox.root, appId: sandbox.appId, storeId: sandbox.storeId, phase, token, candidates, targets, batch });
      return;
    }
    if (command === 'recover') {
      emit('recovered', { intent: probe.store.recoverIntent(probe.activity), memories: probe.store.recoverMemories(probe.activity),
        operations: probe.store.recoverMemoryOperations(probe.activity), outbox: probe.store.pendingMemoryProjections(probe.activity), sends: probe.transport.count });
      return;
    }
    const expected = probe.store.recoverMemories(probe.activity);
    const currentIntent = probe.store.recoverIntent(probe.activity);
    const source = probe.archive.lookup(fixture.correctionSourceId)!;
    const intentSource = probe.archive.lookup(fixture.intentSourceId)!;
    let token = args.values.token;
    if (args.values.session === 'second') {
      const inspected = probe.store.inspectMemoryPresentation(probe.activity, [expected[0]!.recordId]);
      const correction = probe.archive.append(fixture.correctionSourceId, fixture.correction);
      const preview = probe.store.previewMemoryOperation(probe.activity, inspected.token,
        { kind: 'correct', input: correction, content: fixture.correction });
      probe.store.acknowledgeMemoryPresentation(probe.activity, preview.token, preview.hash);
      token = preview.token;
    }
    // Instrument this child process only, after fixture preparation. Checkpoints
    // occur after real SQLite statements and the outer COMMIT; the parent kills
    // the OS process while its transaction is open. Core has no fault hook.
    const trace: { index: number; statement: string }[] = [];
    const cut = args.values.cut === undefined ? null : Number(args.values.cut);
    check(cut === null || (Number.isSafeInteger(cut) && cut > 0), 'invalid-cut');
    let armed = false;
    const checkpoint = (sql: string) => {
      if (!armed) return;
      const point = { index: trace.length + 1, statement: sql.replace(/\s+/g, ' ').trim() };
      trace.push(point);
      if (point.index !== cut) return;
      emit('checkpoint', point);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
      throw new Error('checkpoint-not-killed');
    };
    const prepare = DatabaseSync.prototype.prepare;
    const exec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.prepare = function(sql) {
      const statement = prepare.call(this, sql);
      if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)) {
        const run = statement.run;
        statement.run = function(...parameters) {
          const result = Reflect.apply(run, this, parameters);
          checkpoint(sql);
          return result;
        };
      }
      return statement;
    };
    DatabaseSync.prototype.exec = function(sql) {
      const result = exec.call(this, sql);
      if (sql === 'COMMIT') checkpoint(sql);
      return result;
    };
    const lines = createInterface({ input: process.stdin });
    try {
      emit('ready', { phase, token, expected, currentIntent, session: binding.sessionId });
      for await (const line of lines) {
        check(line === 'go', 'invalid-fixture-input');
        armed = true;
        let result: unknown;
        try {
          if (phase === 'intent') result = probe.store.transitionIntent(probe.activity, currentIntent!.eventId, intentSource,
            { status: 'active', step: fixture.nextStep });
          else if (phase === 'activate') result = probe.store.activateMemoryBatch(probe.activity, expected);
          else if (phase === 'preview') result = probe.store.previewMemoryOperation(probe.activity, token!,
            { kind: 'correct', input: source, content: fixture.correction });
          else result = probe.store.commitMemoryOperation(probe.activity, token!);
        } finally { armed = false; }
        emit('result', { result, trace });
        break;
      }
    } finally { lines.close(); DatabaseSync.prototype.prepare = prepare; DatabaseSync.prototype.exec = exec; }
  } finally { probe.close(); }
}
main().catch(error => { emit('error', { message: (error as Error).message }); process.exitCode = 1; });
