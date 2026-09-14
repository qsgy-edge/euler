// X-06 fixture only: intercept real SQLite statements in this child, never Core.
import { writeSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { API_VERSION, ProbeSession, sha256 } from '@euler/core';
import { bindingOf, openSandbox } from '../apps/cli/src/sandbox.ts';
import { openProbe } from '../apps/cli/src/probe.ts';

const [root, kind, ownerId, cut] = process.argv.slice(2);
const sandbox = openSandbox(root!);
if (kind !== 'session' && kind !== 'job' && kind !== 'migration') throw new Error('invalid-owner');
const probe = openProbe(sandbox, undefined, kind === 'session' ? undefined : { kind, id: ownerId!, authorizationId: ownerId! });
const emit = (event: string, fields: object = {}) => writeSync(1, JSON.stringify({ event, ...fields }) + '\n');
function checkpoint(point: string) {
  if (point !== cut) return;
  emit('checkpoint', { point });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
const session = new ProbeSession(probe.store, probe.activity, { version: API_VERSION, binding: bindingOf(sandbox), source: probe.archive,
  transport: { kind: 'local-counting@1', send(payload) {
    // A durable independent receiver observation, outside SQLite's transaction.
    const record = { hash: sha256(payload), byteLength: Buffer.byteLength(payload), count: 1 };
    const fd = openSync(join(sandbox.root, 'receiver.jsonl'), 'a');
    try { writeSync(fd, JSON.stringify(record) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    checkpoint('received');
    return record;
  } } });
emit('ready', { runId: session.runId, activityId: probe.activity.id });
let phase: string | null = null;
const prepare = DatabaseSync.prototype.prepare;
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.prepare = function(sql) {
  const statement = prepare.call(this, sql);
  if (sql.startsWith('INSERT INTO request_events')) {
    const run = statement.run;
    statement.run = function(...parameters) {
      const eventKind = parameters[3];
      const next = eventKind === 'context/assembly@v1' ? 'assembly' : eventKind === 'model/request-attempt-started@v1' ? 'started'
        : eventKind === 'model/request-attempt-finished@v1' ? 'finished' : null;
      if (next) { phase = next; checkpoint(`${next}-before`); }
      return Reflect.apply(run, this, parameters);
    };
  }
  return statement;
};
DatabaseSync.prototype.exec = function(sql) {
  const result = exec.call(this, sql);
  if (sql === 'COMMIT' && phase) {
    const committed = phase; phase = null;
    checkpoint(`${committed}-after`);
  }
  return result;
};
try {
  const result = session.dispatch(session.prepare(sandbox.fixture.eventId, sandbox.fixture.text));
  emit('result', result);
} finally {
  DatabaseSync.prototype.prepare = prepare;
  DatabaseSync.prototype.exec = exec;
  session.close();
  probe.close();
}
