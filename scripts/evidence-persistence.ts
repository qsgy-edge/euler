import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir, release, arch, userInfo } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const startedAt = new Date().toISOString();
const destination = join(repo, 'artifacts', `t04-${startedAt.replace(/[:.]/g, '-')}`);
mkdirSync(destination, { recursive: true });
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const fixtureBytes = readFileSync(join(repo, 'fixtures/persistence.json'));
const assertions: { name: string; passed: boolean; error?: string }[] = [];
const processes: Record<string, unknown>[] = [];
const checkpoints: Record<string, unknown>[] = [];
const sideEffects: { kind: string; path: string; disposition: 'remove' | 'retain' }[] = [
  { kind: 'raw-synthetic-artifacts', path: destination, disposition: 'retain' },
];
const active = new Set<ReturnType<typeof spawn>>();
let sqliteVersion = '';
function save(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2) + '\n');
}
function verify(name: string, action: () => void) {
  try { action(); assertions.push({ name, passed: true }); }
  catch (error) { assertions.push({ name, passed: false, error: (error as Error).stack ?? String(error) }); }
}
function launch(name: string, args: string[], cwd = repo) {
  const worker = join(repo, 'scripts/persistence-worker.ts');
  const processStartedAt = new Date().toISOString();
  const child = spawn(process.execPath, [worker, ...args], { cwd, stdio: 'pipe', windowsHide: true });
  active.add(child);
  const observations: { event: string; value: any }[] = [];
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const waiters = new Set<() => void>();
  let closed = false;
  let failure: Error | null = null;
  child.stdout.on('data', (data: Buffer) => stdout.push(data));
  child.stderr.on('data', (data: Buffer) => stderr.push(data));
  createInterface({ input: child.stdout }).on('line', line => {
    try { observations.push(JSON.parse(line)); } catch (error) { failure = error as Error; }
    for (const waiter of waiters) waiter();
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
    child.once('error', error => { failure = error; reject(error); for (const waiter of waiters) waiter(); });
    child.once('close', (code, signal) => {
      closed = true;
      active.delete(child);
      save(join(destination, name, 'stdout.jsonl'), Buffer.concat(stdout));
      save(join(destination, name, 'stderr.txt'), Buffer.concat(stderr));
      processes.push({ name, command: process.execPath, args: [worker, ...args], cwd, pid: child.pid ?? null,
        startedAt: processStartedAt, finishedAt: new Date().toISOString(), code, signal });
      done({ code, signal });
      for (const waiter of waiters) waiter();
    });
  });
  void exit.catch(() => {});
  function waitFor(event: string): Promise<any> {
    return new Promise((done, reject) => {
      const finish = () => {
        const found = observations.find(item => item.event === event);
        if (found || failure || closed) {
          clearTimeout(timer); waiters.delete(finish);
          if (found) done(found.value); else reject(failure ?? new Error(`missing ${event}: ${JSON.stringify(observations.slice(-1))}`));
        }
      };
      const timer = setTimeout(() => { waiters.delete(finish); child.kill('SIGKILL'); reject(new Error(`timeout: ${name}/${event}`)); }, 30000);
      waiters.add(finish); finish();
    });
  }
  return { child, exit, waitFor, observations, go: () => child.stdin.write('go\n') };
}
function snapshot(root: string, path: string) {
  mkdirSync(path, { recursive: true });
  for (const file of readdirSync(root)) copyFileSync(join(root, file), join(path, file));
}
const hashFields = [['payload','payload_hash'], ['receipt_payload','receipt_hash']] as const;
// Independent verifier: consumes raw SQL rows and raw JSONL, never Core replay,
// Store digest helpers, the implementation's assertions or its reported verdict.
function readRaw(path: string) {
  const temp = mkdtempSync(join(tmpdir(), 'euler-t04-verify-'));
  sideEffects.push({ kind: 'sqlite-verifier-copy', path: temp, disposition: 'remove' });
  snapshot(path, temp);
  const dbName = readdirSync(temp).find(file => file === 'probe.sqlite' || file === 'store.sqlite3')!;
  const db = new DatabaseSync(join(temp, dbName), { readOnly: true });
  try {
    sqliteVersion = String(db.prepare('SELECT sqlite_version() AS v').get()!.v);
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 7);
    assert.deepEqual(db.prepare('PRAGMA quick_check').all().map(row => row.quick_check), ['ok']);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    const tables: Record<string, Record<string, any>[]> = {};
    for (const table of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      tables[String(table.name)] = db.prepare(`SELECT * FROM ${table.name} ORDER BY rowid`).all();
    }
    const refs = new Map<string, Record<string, unknown>>();
    for (const session of tables.sessions!) {
      const lines = readFileSync(join(temp, basename(session.source_path)), 'utf8').trimEnd().split('\n');
      const header = JSON.parse(lines[0]!);
      const binding = { ownerId: session.owner_id, hostId: session.host_id, projectId: session.project_id, sessionId: session.session_id, branchId: session.branch_id };
      assert.deepEqual(header, { schema: 'cli-session@1', binding });
      for (const line of lines.slice(1)) {
        const event = JSON.parse(line);
        refs.set(`${session.session_id}/${event.eventId}`, { schema: 'cli-source-ack@1', status: 'durable', binding, eventId: event.eventId,
          locator: `cli-jsonl@1/${session.session_id}/${event.eventId}`, hash: digest(line), byteLength: Buffer.byteLength(line), contentHash: digest(event.text) });
      }
    }
    const checkSource = (source: any, scope?: { kind: string; id: string }) => {
      const binding: { sessionId: string; projectId: string; ownerId: string } = source.binding;
      assert.deepEqual(source, refs.get(`${binding.sessionId}/${source.eventId}`));
      if (!scope) return;
      if (scope.kind === 'session') assert.equal(binding.sessionId, scope.id);
      else if (scope.kind === 'project') assert.equal(binding.projectId, scope.id);
      else if (scope.kind === 'personal') assert.equal(binding.ownerId, scope.id);
      else {
        assert.equal(scope.kind, 'workspace');
        assert.ok(tables.workspace_projects!.some(row => row.workspace_id === scope.id && row.project_id === binding.projectId));
      }
    };
    for (const table of Object.values(tables)) for (const row of table) for (const [body, hash] of hashFields) {
      if (row[body] != null) assert.equal(row[hash], digest(row[body]));
    }
    for (const capture of tables.capture_jobs!) {
      const payload = JSON.parse(capture.payload);
      assert.equal(payload.schema, 'capture-job@1');
      assert.equal(payload.recordId, capture.record_id);
      assert.equal(payload.source.binding.sessionId, capture.source_owner);
      assert.equal(payload.source.eventId, capture.source_event_id);
      checkSource(payload.source);
    }
    const memoryEvents = tables.memory_events!;
    for (const record of tables.memory_records!) {
      const history = memoryEvents.filter(event => event.record_id === record.record_id).sort((a,b) => a.seq - b.seq);
      let previous: string | null = null;
      history.forEach((event, index) => {
        assert.equal(event.seq, index + 1);
        const payload = JSON.parse(event.payload);
        assert.equal(payload.schema, 'memory-event@1');
        assert.equal(payload.eventId, event.event_id);
        assert.equal(payload.recordId, event.record_id);
        assert.equal(payload.seq, event.seq);
        assert.equal(payload.kind, event.kind);
        assert.equal(payload.operationId, event.operation_id);
        assert.equal(payload.batchId, event.batch_id);
        assert.equal(payload.batchOrdinal, event.batch_ordinal);
        assert.equal(payload.request, event.request_hash);
        assert.equal(event.before_snapshot, previous);
        assert.equal(payload.before === null ? null : JSON.stringify(payload.before), previous);
        assert.equal(JSON.stringify(payload.after), event.after_snapshot);
        assert.equal(payload.after.headEventId, event.event_id);
        const revision = tables.memory_revisions!.find(row => row.revision_id === event.revision_id)!;
        assert.equal(revision.record_id, record.record_id);
        assert.equal(revision.content, payload.after.content);
        assert.equal(revision.content_hash, digest(revision.content));
        assert.equal(payload.after.contentHash, revision.content_hash);
        assert.equal(payload.after.revisionId, revision.revision_id);
        checkSource(JSON.parse(revision.source_json), { kind: revision.scope_kind, id: revision.scope_id });
        checkSource(payload.after.source, payload.after.scope);
        if (event.receipt_id) {
          const receipt = JSON.parse(event.receipt_payload);
          assert.deepEqual(receipt, payload.ownerReceipt);
          assert.equal(receipt.schema, 'owner-receipt@1');
          assert.equal(receipt.receiptId, event.receipt_id);
          assert.equal(receipt.operationId, event.operation_id ?? event.event_id);
          assert.equal(receipt.beforeRevision, payload.before.revision);
          assert.equal(receipt.afterRevision, payload.after.revision);
          assert.equal(receipt.outcome, 'committed');
          assert.deepEqual(Object.keys(receipt).sort(), ['schema','receiptId','operationId','kind','subjectRef','beforeRevision','afterRevision','outcome'].sort());
          assert.notEqual(receipt.subjectRef, record.record_id);
        } else assert.equal(payload.ownerReceipt, null);
        previous = event.after_snapshot;
      });
      const head = tables.memory_heads!.find(row => row.record_id === record.record_id)!;
      assert.equal(head.snapshot, previous);
      assert.equal(head.snapshot_hash, digest(previous!));
      assert.equal(head.head_event_id, history.at(-1)!.event_id);
    }
    const origins = [...new Set(memoryEvents.map(event => event.origin_host_id))];
    for (const origin of origins) assert.deepEqual(memoryEvents.filter(event => event.origin_host_id === origin).map(event => event.origin_seq).sort((a,b) => a-b),
      memoryEvents.filter(event => event.origin_host_id === origin).map((_, index) => index+1));
    for (const batch of tables.activation_batches!) {
      const payload = JSON.parse(batch.payload);
      const events = memoryEvents.filter(event => event.batch_id === batch.batch_id).sort((a,b) => a.batch_ordinal-b.batch_ordinal);
      assert.equal(events.length, batch.member_count);
      assert.equal(new Set(events.map(event => event.record_id)).size, events.length);
      assert.deepEqual(events.map(event => event.batch_ordinal), events.map((_,index) => index));
      assert.equal(payload.batchId, batch.batch_id);
      assert.equal(payload.ownerId, batch.owner_id);
      assert.equal(payload.scope.kind, batch.scope_kind);
      assert.equal(payload.scope.id, batch.scope_id);
      assert.deepEqual(payload.events, events.map(event => JSON.parse(event.payload)));
      assert.equal(tables.projection_jobs!.filter(job => job.kind === 'host-info' && job.batch_id === batch.batch_id).length, 1);
    }
    for (const job of tables.projection_jobs!) {
      const payload = JSON.parse(job.payload);
      assert.equal(payload.kind, job.kind);
      assert.equal(payload.batchId, job.batch_id);
      const expected = job.kind === 'search' ? [JSON.parse(memoryEvents.find(event => event.event_id === job.event_id)!.payload)]
        : JSON.parse(tables.activation_batches!.find(batch => batch.batch_id === job.batch_id)!.payload).events;
      assert.deepEqual(payload.events, expected);
      assert.equal(expected[0].eventId, job.event_id);
    }
    for (const session of tables.sessions!) {
      const events = tables.intent_events!.filter(row => row.session_id === session.session_id).sort((a,b) => a.version-b.version);
      let previous: string | null = null;
      events.forEach((event, index) => {
        assert.equal(event.version, index+1);
        assert.equal(event.expected_event_id, previous);
        assert.equal(event.hash, digest(event.snapshot));
        const intent = JSON.parse(event.snapshot);
        assert.equal(intent.eventId, event.event_id);
        assert.equal(intent.version, event.version);
        checkSource(intent.input); checkSource(intent.goalInput);
        previous = event.event_id;
      });
      assert.equal(tables.intent_heads!.find(row => row.session_id === session.session_id)?.event_id ?? null, previous);
    }
    verifyHostRows(tables);
    const pendingSessions = tables.pending_operations!.filter(row => row.state === 'pending').map(row => row.session_id);
    assert.equal(new Set(pendingSessions).size, pendingSessions.length);
    assert.equal(tables.execution_events!.every(event => event.kind === 'attempt-bound'), true);
    for (const run of tables.verification_runs!) {
      assert.equal(run.evidence_hash, digest(run.evidence_json));
      const revision = tables.memory_revisions!.find(row => row.revision_id === run.revision_id)!;
      for (const ref of JSON.parse(run.evidence_json)) checkSource(ref, { kind: revision.scope_kind, id: revision.scope_id });
    }
    return { tables, ddl: db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() };
  } finally { db.close(); rmSync(temp, { recursive: true, force: true }); }
}
function verifyHostRows(tables: Record<string, Record<string, any>[]>) {
  const uuid = (value: unknown) => assert.ok(typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value), 'invalid reserved/event identity');
  const allReserved: string[] = [];
  for (const presentation of tables.host_presentations!) {
    const payload = JSON.parse(presentation.payload);
    assert.equal(presentation.payload_hash, digest(presentation.payload));
    for (const [field, column] of [['presentationId','presentation_id'],['operationId','operation_id'],['token','token'],['sessionId','session_id'],
      ['branchId','branch_id'],['epoch','epoch'],['ordinal','ordinal'],['kind','kind'],['originatingPresentationId','originating_id'],
      ['supersedesOperationId','supersedes_operation_id'],['batchId','batch_id'],['batchDigest','batch_digest']] as const) assert.equal(payload[field], presentation[column]);
    uuid(payload.presentationId); uuid(payload.token);
    const targets = tables.presentation_targets!.filter(row => row.presentation_id === presentation.presentation_id).sort((a,b) => a.ordinal-b.ordinal);
    assert.ok(targets.length > 0);
    assert.deepEqual(targets.map(target => target.ordinal), targets.map((_, index) => index));
    assert.equal(new Set(targets.map(target => target.record_id)).size, targets.length);
    assert.deepEqual(payload.targets, targets.map(target => ({ ...JSON.parse(target.snapshot), hash: target.snapshot_hash })));
    assert.deepEqual(payload.updateEventIds, payload.kind === 'inspect' ? [] : targets.map(target => target.update_event_id));
    assert.deepEqual(payload.eventIds, payload.kind === 'rollback' ? targets.map(target => target.selected_event_id) : []);
    for (const target of targets) {
      if (payload.kind === 'inspect') assert.equal(target.update_event_id, null);
      else { uuid(target.update_event_id); allReserved.push(target.update_event_id); }
      if (payload.kind === 'rollback') uuid(target.selected_event_id); else assert.equal(target.selected_event_id, null);
      assert.equal(target.snapshot_hash, digest(target.snapshot));
      const head = tables.memory_events!.find(event => event.event_id === target.head_event_id && event.record_id === target.record_id)!;
      assert.equal(target.snapshot, head.after_snapshot);
      assert.equal(target.revision_id, head.revision_id);
    }
    if (payload.kind === 'correct') { assert.equal(targets.length, 1); assert.equal(typeof payload.content, 'string'); assert.ok(payload.input); }
    else { assert.equal(payload.content, null); assert.equal(payload.input, null); }
    if (payload.kind === 'rollback') {
      const batch = tables.activation_batches!.find(batch => batch.batch_id === payload.batchId)!;
      assert.equal(payload.batchPayload, batch.payload); assert.equal(payload.batchDigest, batch.payload_hash);
      for (const target of targets) assert.ok(tables.memory_events!.some(event => event.event_id === target.selected_event_id
        && event.record_id === target.record_id && event.batch_id === payload.batchId));
    } else { assert.equal(payload.batchId, null); assert.equal(payload.batchDigest, null); assert.equal(payload.batchPayload, null); }
  }
  assert.equal(new Set(allReserved).size, allReserved.length);
  for (const operation of tables.pending_operations!) {
    const presentation = tables.host_presentations!.find(p => p.operation_id === operation.operation_id && p.presentation_id === operation.presentation_id && p.session_id === operation.session_id)!;
    assert.ok(presentation);
    assert.equal(operation.presentation_hash, presentation.payload_hash, 'frozen presentation digest');
    const targets = tables.presentation_targets!.filter(row => row.presentation_id === presentation.presentation_id).sort((a,b) => a.ordinal-b.ordinal);
    const events = tables.memory_events!.filter(event => event.operation_id === operation.operation_id);
    assert.equal(events.length, operation.state === 'committed' ? targets.length : 0, 'complete operation member count');
    if (operation.state === 'pending') { assert.equal(operation.result, null); assert.equal(operation.result_hash, null); continue; }
    assert.equal(operation.result_hash, digest(operation.result));
    const result = JSON.parse(operation.result);
    assert.equal(result.operationId, operation.operation_id);
    assert.equal(result.status, operation.state);
    assert.deepEqual(result.expected, JSON.parse(presentation.payload).targets);
    assert.deepEqual(result.receiptIds, events.map(event => event.receipt_id));
    if (operation.state === 'committed') {
      assert.deepEqual(events.map(event => event.record_id), targets.map(target => target.record_id));
      assert.deepEqual(result.current, events.map(event => ({ ...JSON.parse(event.after_snapshot), hash: digest(event.after_snapshot) })));
      for (const [index, event] of events.entries()) {
        uuid(event.event_id); uuid(event.receipt_id);
        assert.equal(event.kind, presentation.kind);
        assert.equal(event.event_id, targets[index]!.update_event_id);
        assert.equal(event.target_event_id, targets[index]!.selected_event_id);
        assert.equal(event.before_snapshot, targets[index]!.snapshot);
      }
    }
  }
}

function comparable(raw: ReturnType<typeof readRaw>) {
  const { owner_activities: _activities, ...tables } = raw.tables;
  return tables;
}
async function runCase(phase: string, cut: number | null) {
  const name = `${phase}/${cut === null ? 'normal' : `cut-${cut}`}`;
  let root: string | undefined;
  let worker: ReturnType<typeof launch> | undefined;
  try {
    const setup = launch(`${name}/prepare`, ['prepare','--phase',phase]);
    const prepared = await setup.waitFor('prepared');
    root = prepared.root;
    sideEffects.push({ kind: `${name}-sandbox`, path: root!, disposition: 'remove' });
    assert.equal((await setup.exit).code, 0);
    worker = launch(`${name}/run`, ['run','--root',root!, '--phase',phase,
      ...(prepared.token ? ['--token',prepared.token] : []), ...(cut === null ? [] : ['--cut',String(cut)])]);
    await worker.waitFor('ready');
    const beforePath = join(destination, name, 'before');
    snapshot(root!, beforePath);
    const before = readRaw(beforePath);
    worker.go();
    let trace: { index: number; statement: string }[] = [];
    let committed = true;
    if (cut !== null) {
      const point = await worker.waitFor('checkpoint');
      assert.equal(point.index, cut);
      committed = point.statement === 'COMMIT';
      checkpoints.push({ phase, cut, statement: point.statement, committed });
      worker.child.kill('SIGKILL');
      assert.notEqual((await worker.exit).code, 0);
    } else {
      const completed = await worker.waitFor('result');
      trace = completed.trace;
      assert.equal((await worker.exit).code, 0);
      if (phase === 'commit' || phase === 'rollback') assert.equal(completed.result.status, 'committed');
      if (phase === 'cancel') assert.equal(completed.result.status, 'cancelled');
      assert.equal(trace.at(-1)?.statement, 'COMMIT');
      save(join(destination, name, 'statement-trace.json'), trace);
    }
    const crashPath = join(destination, name, 'before-restart');
    snapshot(root!, crashPath);
    const raw = readRaw(crashPath);
    verify(`${name}: actual SQLite has all or none of the transaction`, () => {
      assert.deepEqual(raw.ddl, before.ddl);
      if (!committed) assert.deepEqual(comparable(raw), comparable(before));
      else {
        assert.notDeepEqual(comparable(raw), comparable(before));
        if (phase === 'intent') assert.equal(raw.tables.intent_events!.length, before.tables.intent_events!.length + 1);
        if (phase === 'activate') assert.equal(raw.tables.activation_batches!.length, before.tables.activation_batches!.length + 1);
        if (phase === 'preview') assert.equal(raw.tables.pending_operations!.filter(row => row.state === 'pending').length, 1);
        if (phase === 'commit' || phase === 'rollback') {
          const changed = raw.tables.pending_operations!.filter(row => row.state === 'committed');
          assert.equal(changed.length, 1);
          assert.equal(raw.tables.memory_events!.filter(row => row.operation_id === changed[0]!.operation_id).length, phase === 'rollback' ? 2 : 1);
        }
        if (phase === 'cancel') {
          assert.equal(raw.tables.pending_operations!.filter(row => row.state === 'cancelled').length, 1);
          for (const table of ['memory_heads','memory_events','memory_revisions','projection_jobs','activation_batches','host_presentations','presentation_targets']) {
            assert.deepEqual(raw.tables[table], before.tables[table]);
          }
        }
      }
      for (const table of ['memory_events','memory_revisions','activation_batches','projection_jobs','intent_events','execution_events']) {
        assert.deepEqual(raw.tables[table]!.slice(0, before.tables[table]!.length), before.tables[table]);
      }
    });
    if (phase === 'rollback' && cut === null) {
      for (const negative of ['missing-member','invalid-reserved-id','changed-body','extra-selection']) {
        const tables = structuredClone(raw.tables);
        const operation = tables.pending_operations!.find(row => row.state === 'committed')!;
        const presentation = tables.host_presentations!.find(row => row.presentation_id === operation.presentation_id)!;
        if (negative === 'missing-member') {
          const index = tables.memory_events!.findIndex(row => row.operation_id === operation.operation_id);
          tables.memory_events!.splice(index, 1);
          const result = JSON.parse(operation.result);
          result.receiptIds.shift(); result.current.shift();
          operation.result = JSON.stringify(result); operation.result_hash = digest(operation.result);
        } else {
          const payload = JSON.parse(presentation.payload);
          if (negative === 'invalid-reserved-id') {
            tables.presentation_targets!.find(row => row.presentation_id === presentation.presentation_id)!.update_event_id = 'not-a-uuid';
            payload.updateEventIds[0] = 'not-a-uuid';
          }
          if (negative === 'changed-body') payload.content = 'Not the displayed mutation';
          if (negative === 'extra-selection') payload.eventIds.push(randomUUID());
          presentation.payload = JSON.stringify(payload); presentation.payload_hash = digest(presentation.payload);
        }
        save(join(destination, 'verifier-negatives', `${negative}.json`), tables);
        verify(`raw Host verifier rejects ${negative}`, () => assert.throws(() => verifyHostRows(tables)));
      }
    }
    const recovered = launch(`${name}/recover`, ['recover','--root',root!,'--phase',phase]);
    const observed = await recovered.waitFor('recovered');
    assert.equal((await recovered.exit).code, 0);
    const afterPath = join(destination, name, 'after-restart');
    snapshot(root!, afterPath);
    const after = readRaw(afterPath);
    verify(`${name}: restart recovers exact heads/pending/receipts without repeating mutations`, () => {
      assert.deepEqual(comparable(after), comparable(raw));
      assert.deepEqual(observed.memories, after.tables.memory_heads!.map(row => ({ ...JSON.parse(row.snapshot), hash: row.snapshot_hash })));
      assert.deepEqual(observed.intent, { ...JSON.parse(after.tables.intent_events!.at(-1)!.snapshot), hash: after.tables.intent_events!.at(-1)!.hash });
      assert.equal(observed.sends, 0);
      assert.equal(observed.operations.length, after.tables.pending_operations!.length);
      if (phase === 'cancel') {
        assert.equal(observed.operations[0].result.status, committed ? 'cancelled' : 'pending');
        assert.deepEqual(observed.operations[0].result.receiptIds, []);
      }
    });
    return trace;
  } finally {
    if (worker && active.has(worker.child)) { worker.child.kill('SIGKILL'); await worker.exit; }
    if (root) rmSync(root, { recursive: true, force: true });
  }
}
async function race(cut: number | null) {
  const name = cut === null ? 'concurrency' : 'concurrency-unknown';
  let root: string | undefined;
  const workers: ReturnType<typeof launch>[] = [];
  try {
    const setup = launch(`${name}/prepare`, ['prepare','--phase','commit']);
    const prepared = await setup.waitFor('prepared');
    root = prepared.root;
    sideEffects.push({ kind: `${name}-sandbox`, path: root!, disposition: 'remove' });
    assert.equal((await setup.exit).code, 0);
    for (const session of ['first','second']) workers.push(launch(`${name}/${session}`, ['run','--root',root!, '--phase','commit',
      '--token',prepared.token,'--session',session, ...(cut === null ? [] : ['--cut',String(cut)])]));
    const ready = await Promise.all(workers.map(worker => worker.waitFor('ready')));
    assert.deepEqual(ready[0].expected, ready[1].expected);
    assert.notEqual(ready[0].token, ready[1].token);
    snapshot(root!, join(destination,name,'before'));
    for (const worker of workers) worker.go();
    if (cut !== null) {
      const points = await Promise.allSettled(workers.map(worker => worker.waitFor('checkpoint')));
      assert.equal(points.filter(point => point.status === 'fulfilled').length, 1);
      for (const [index, point] of points.entries()) if (point.status === 'fulfilled') {
        assert.equal(point.value.statement, 'COMMIT'); workers[index]!.child.kill('SIGKILL');
      }
    }
    await Promise.all(workers.map(worker => worker.exit));
    const path = join(destination,name,'before-restart');
    snapshot(root!, path);
    const raw = readRaw(path);
    verify(`${name}: separate sessions race on the same head with exactly one committed receipt and one stale`, () => {
      assert.deepEqual(raw.tables.pending_operations!.map(row => row.state).sort(), ['committed','stale']);
      assert.equal(raw.tables.memory_events!.filter(event => event.operation_id !== null).length, 1);
      assert.equal(raw.tables.memory_revisions!.length, 3);
    });
    for (const session of ['first','second']) {
      const recovery = launch(`${name}/recover-${session}`, ['recover','--root',root!, '--session',session]);
      const result = await recovery.waitFor('recovered');
      assert.equal((await recovery.exit).code, 0);
      verify(`${name}: ${session} queries its durable operation before any retry`, () => {
        assert.equal(result.operations.length, 1);
        assert.equal(result.operations[0].result.status, raw.tables.pending_operations!.find(row => row.session_id === ready[session === 'first' ? 0 : 1].session)!.state);
        assert.equal(result.sends, 0);
      });
    }
    snapshot(root!, join(destination,name,'after-restart'));
    verify(`${name}: unknown reconciliation never repeats a mutation`, () => assert.deepEqual(comparable(readRaw(join(destination,name,'after-restart'))), comparable(raw)));
  } finally {
    for (const worker of workers) if (active.has(worker.child)) { worker.child.kill('SIGKILL'); await worker.exit; }
    if (root) rmSync(root, { recursive: true, force: true });
  }
}

async function identities() {
  const appIds = [`euler-t04-${randomUUID()}`, `euler-t04-${randomUUID()}`];
  const roots: string[] = [];
  const cwdRoot = mkdtempSync(join(tmpdir(), 'euler-t04-cwd-'));
  sideEffects.push({ kind: 'disposable-cwd-and-git-roots', path: cwdRoot, disposition: 'remove' });
  try {
    const cwdPaths = ['outside','git-a','git-b'].map(name => join(cwdRoot, name));
    for (const cwd of cwdPaths) mkdirSync(cwd);
    for (const cwd of cwdPaths.slice(1)) execFileSync('git',['init','--quiet',cwd]);
    const observed: any[] = [];
    for (const [index, appId] of appIds.entries()) {
      const setup = launch(`identity/create-${index}`, ['prepare','--phase','intent','--app-id',appId]);
      const prepared = await setup.waitFor('prepared');
      roots.push(prepared.root);
      sideEffects.push({ kind: 'disposable-app-data-root', path: prepared.root, disposition: 'remove' });
      assert.equal((await setup.exit).code, 0);
      for (const [cwdIndex, cwd] of cwdPaths.entries()) {
        const reader = launch(`identity/${index}-${cwdIndex}`, ['identity','--root',prepared.root], cwd);
        observed.push(await reader.waitFor('identity'));
        assert.equal((await reader.exit).code, 0);
      }
      snapshot(prepared.root, join(destination, `identity/app-${index}`));
    }
    verify('same OS user/app-id has one actual file across two Git roots and a non-Git cwd', () => {
      for (const group of [observed.slice(0,3),observed.slice(3)]) {
        assert.deepEqual(group.map(row => row.resources.store), [group[0].resources.store, group[0].resources.store, group[0].resources.store]);
        assert.equal(new Set(group.map(row => row.storeId)).size, 1);
        for (const row of group) {
          const base = process.platform === 'win32' ? process.env.LOCALAPPDATA!
            : process.platform === 'darwin' ? join(homedir(),'Library','Application Support')
              : process.env.XDG_DATA_HOME || join(homedir(),'.local','share');
          assert.equal(row.root, join(base,row.appId));
          assert.equal(row.diagnostics.journalMode, 'wal'); assert.equal(row.diagnostics.synchronous, 2);
          assert.equal(row.diagnostics.foreignKeys, 1); assert.equal(row.diagnostics.busyTimeout, 2000);
        }
      }
      assert.notDeepEqual(observed[0].resources.store.identity, observed[3].resources.store.identity);
      assert.notEqual(observed[0].resources.store.path, observed[3].resources.store.path);
      assert.equal(readRaw(join(destination,'identity/app-0')).tables.schema_meta![0]!.os_user, userInfo().username);
    });
  } finally { for (const root of roots) rmSync(root, { recursive: true, force: true }); rmSync(cwdRoot, { recursive: true, force: true }); }
}
let infrastructureError: string | null = null;
try {
  await identities();
  for (const phase of ['intent','activate','preview','commit','rollback','cancel']) {
    const trace = await runCase(phase, null);
    for (const point of trace) await runCase(phase, point.index);
    console.log(JSON.stringify({ phase, checkpoints: trace.length, failures: assertions.filter(row => !row.passed).length }));
    if (phase === 'commit') { await race(null); await race(trace.at(-1)!.index); }
  }
} catch (error) {
  infrastructureError = (error as Error).stack ?? String(error);
} finally {
  for (const child of active) child.kill('SIGKILL');
}
const git = (...args: string[]) => execFileSync('git', ['--no-optional-locks',...args], { cwd: repo, encoding: 'utf8' }).trim();
function files(path: string): { path: string; sha256: string }[] {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(path, entry.name))
    : [{ path: relative(destination, join(path, entry.name)).replaceAll('\\','/'), sha256: digest(readFileSync(join(path, entry.name))) }]);
}
const summary = {
  schema: 'euler-t04-evidence@1', experimentId: 'X-01/T04-synthetic', schemaVersion: 1,
  specCommit: 'a3f253f9bef0415364b3b224e5eb4ba150111325',
  authorityRefs: ['docs/architecture/issues/12-build-evidence-experiment-matrix.md#x-01',
    'docs/architecture/issues/12-build-evidence-experiment-matrix.md#统一-receipt-与复刻位置',
    'docs/architecture/issues/10-choose-storage-projections.md#decisions',
    'docs/architecture/issues/14-define-host-presentation.md#presentation-identity-and-ordering',
    'docs/architecture/issues/14-define-host-presentation.md#pending-lifecycle'],
  command: { executable: process.execPath, args: [...process.execArgv, ...process.argv.slice(1)], cwd: repo },
  startedAt, finishedAt: new Date().toISOString(),
  implementationCommit: git('rev-parse','HEAD'), implementationTree: git('rev-parse','HEAD^{tree}'), workingTree: git('status','--short'),
  environment: { platform: process.platform, release: release(), architecture: arch(), node: process.version, sqlite: sqliteVersion,
    provider: 'none: no provider requests', model: 'none', adapter: 'euler-p0@1', runner: process.env.CI ? 'CI' : 'local' },
  fixture: { path: 'fixtures/persistence.json', rawDigest: digest(fixtureBytes), digest: digest(JSON.stringify(JSON.parse(fixtureBytes.toString()))), synthetic: true, heldOut: false },
  heldOut: { digest: null, owner: null, sealedCommit: null, releasedCommit: null, contaminationCaseIds: [], replacementCaseIds: [],
    applicability: 'not-applicable: deterministic development fixture; no held-out quality claim' },
  controlledSideEffects: sideEffects.map(effect => ({ ...effect, existsAtFinish: existsSync(effect.path) })),
  independentValidation: { method: 'raw SQLite/JSONL and node:crypto recomputation; no Core replay/hash helpers',
    verifier: { path: 'scripts/evidence-persistence.ts', sha256: digest(readFileSync(fileURLToPath(import.meta.url))) },
    status: !infrastructureError && assertions.every(row => row.passed) ? 'pass' : 'fail' },
  processes, checkpoints, assertions, files: files(destination), infrastructureError,
  status: !infrastructureError && assertions.every(row => row.passed) ? 'pass' : 'fail',
  exit: { code: 0, signal: null },
  evidenceGaps: ['Real approval/UI and Info delivery are later Host tickets', 'Full search worker and execution ledger are T05/T06',
    'Power loss, production data, backup/physical purge and live owner switch are outside T04', 'Other OS results require their matching CI artifacts'],
};
// Validate the actual receipt against Ticket 12's required fields and raw bytes.
// Missing/non-applicable metadata stays explicit; a passing case count is insufficient.
function validateReceipt(receipt: typeof summary) {
  for (const key of ['schema','schemaVersion','experimentId','specCommit','authorityRefs','command','startedAt','finishedAt',
    'implementationCommit','implementationTree','workingTree','environment','fixture','heldOut','processes','assertions','files',
    'controlledSideEffects','independentValidation','status','exit'] as const) assert.ok(Object.hasOwn(receipt, key), `missing ${key}`);
  assert.ok(receipt.authorityRefs.length > 0);
  for (const key of ['platform','release','architecture','node','sqlite','provider','model','adapter'] as const) assert.ok(receipt.environment[key]);
  for (const key of ['digest','owner','sealedCommit','releasedCommit','contaminationCaseIds','replacementCaseIds','applicability'] as const) {
    assert.ok(Object.hasOwn(receipt.heldOut, key), `missing heldOut.${key}`);
  }
  assert.equal(receipt.fixture.rawDigest, digest(readFileSync(join(repo, receipt.fixture.path))));
  assert.ok(receipt.command.executable && receipt.command.args.length > 0 && receipt.command.cwd);
  assert.ok(Date.parse(receipt.finishedAt) >= Date.parse(receipt.startedAt));
  for (const process of receipt.processes) {
    assert.ok(process.command && process.args && process.cwd && process.startedAt && process.finishedAt);
    assert.ok(Date.parse(String(process.finishedAt)) >= Date.parse(String(process.startedAt)));
    assert.ok(Object.hasOwn(process, 'code') && Object.hasOwn(process, 'signal'));
  }
  assert.ok(receipt.assertions.length > 0 && receipt.files.length > 0);
  assert.equal(receipt.independentValidation.verifier.sha256, digest(readFileSync(join(repo, receipt.independentValidation.verifier.path))));
  for (const file of receipt.files) {
    assert.ok(!file.path.startsWith('/') && !file.path.split('/').includes('..'));
    assert.equal(file.sha256, digest(readFileSync(join(destination, file.path))), `raw digest: ${file.path}`);
  }
  for (const effect of receipt.controlledSideEffects) assert.equal(effect.existsAtFinish, effect.disposition === 'retain', effect.path);
}
verify('receipt includes the required contract fields and matches every raw artifact digest', () => validateReceipt(summary));
verify('receipt validation rejects absent authority refs and mismatched raw sidecars', () => {
  assert.throws(() => validateReceipt({ ...summary, authorityRefs: [] }));
  const files = summary.files.map((file, index) => index === 0 ? { ...file, sha256: '0'.repeat(64) } : file);
  assert.throws(() => validateReceipt({ ...summary, files }), /raw digest/);
});
summary.status = summary.independentValidation.status = !infrastructureError && assertions.every(row => row.passed) ? 'pass' : 'fail';
summary.exit.code = summary.status === 'pass' ? 0 : 1;
save(join(destination, 'summary.json'), summary);
console.log(JSON.stringify({ artifact: destination, status: summary.status, assertions: assertions.length, failures: assertions.filter(row => !row.passed).length, infrastructureError }));
if (summary.status !== 'pass') process.exitCode = 1;
