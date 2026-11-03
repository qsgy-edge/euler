import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { CaptureRun, DEFAULT_BUDGET } from '@euler/core';
import type { ModelReply } from '@euler/core';
import { openMaintenanceStore } from '../src/backup.ts';
import { readPurgeCarriers } from '../src/purge.ts';
import { createSessionSandbox, createSandboxSession } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

test('resumeProjectCaptures resolves the original candidate without rewriting source or historical revision', () => {
  const sandbox = createSessionSandbox(randomUUID(), randomUUID());
  let probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const input = probe.archive.append(randomUUID(), '记住偏好：scope resolution prefers concise answers');
    const before = probe.store.rememberMemory(probe.activity, { input, hostInfo: 'durable' }).record;
    const projectId = randomUUID();
    const confirmation = probe.archive.append(randomUUID(), '/bind ' + JSON.stringify({ projectId, root: null }));
    const bytes = readFileSync(`${sandbox.root}/session.jsonl`);
    probe.store.confirmSessionProject(probe.activity, confirmation, projectId, null);
    probe.close(); probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    const resumed = probe.store.resumeProjectCaptures(probe.activity, 'durable');
    assert.equal(resumed.more, false);
    assert.equal(resumed.jobs.length, 1);
    const after = resumed.jobs[0]!.record!;
    assert.equal(after.recordId, before.recordId);
    assert.equal(after.revision, 2);
    assert.deepEqual(after.source, input);
    assert.deepEqual(after.scope, { kind: 'project', id: projectId, resolved: true });
    assert.equal(after.lifecycle, 'active');
    assert.deepEqual(readFileSync(`${sandbox.root}/session.jsonl`), bytes);
    const history = probe.store.inspectMemory(probe.activity, before.recordId).history;
    assert.deepEqual(history.map(row => row.kind), ['capture', 'resolve-scope', 'verify', 'activate']);
    const { hash: _hash, ...originalSnapshot } = before;
    assert.deepEqual(JSON.parse(String(history[0]!.payload)).after, originalSnapshot);
    assert.deepEqual(probe.store.resumeProjectCaptures(probe.activity, 'durable'), { jobs: [], more: false });
    probe.store.drainSearchProjection(probe.activity);
    assert.equal(probe.store.searchMemories(probe.activity, { query: 'concise' }).results.length, 1);
    const db = new DatabaseSync(`${sandbox.root}/probe.sqlite`, { readOnly: true });
    try {
      assert.deepEqual(db.prepare('SELECT source_project_id FROM memory_revisions ORDER BY revision').all().map(row => row.source_project_id), [null, null]);
    } finally { db.close(); }
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('binding freezes only the current task, excluding initial inputs, earlier tasks and later raw backfill', () => {
  const sandbox = createSessionSandbox(randomUUID(), randomUUID());
  let probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const remember = (text: string) => probe.store.rememberMemory(probe.activity,
      { input: probe.archive.append(randomUUID(), '记住偏好：' + text), hostInfo: 'durable' }).record;
    const initial = remember('initial segment');
    const first = probe.archive.append(randomUUID(), 'first task');
    let intent = probe.store.transitionIntent(probe.activity, null, first, { step: 'start', status: 'active' }, 'first task');
    const previous = remember('previous task');
    intent = probe.store.transitionIntent(probe.activity, intent.eventId, probe.archive.append(randomUUID(), 'done'), { step: 'done', status: 'completed' });
    const next = probe.archive.append(randomUUID(), 'second task');
    probe.store.transitionIntent(probe.activity, intent.eventId, next, { step: 'start', status: 'active' }, 'second task');
    const current = remember('current task');
    const projectId = randomUUID();
    const confirmation = probe.archive.append(randomUUID(), '/bind ' + JSON.stringify({ projectId, root: null }));
    probe.store.confirmSessionProject(probe.activity, confirmation, projectId, null);
    probe.close(); probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    const late = probe.store.rememberMemory(probe.activity, { input: probe.archive.append(randomUUID(), '记住偏好：after frozen cut'),
      hostInfo: 'durable', noActiveProject: true }).record;
    const result = probe.store.resumeProjectCaptures(probe.activity, 'durable');
    assert.deepEqual(result.jobs.map(job => job.record!.recordId), [current.recordId]);
    for (const record of [initial, previous, late]) assert.equal(probe.store.inspectMemory(probe.activity, record.recordId).record.scope.resolved, false);
    const repeated = probe.archive.append(randomUUID(), '/bind ' + JSON.stringify({ projectId, root: null }));
    probe.store.confirmSessionProject(probe.activity, repeated, projectId, null);
    assert.deepEqual(probe.store.resumeProjectCaptures(probe.activity, 'durable'), { jobs: [], more: false });
    assert.throws(() => probe.store.confirmSessionProject(probe.activity, repeated, randomUUID(), null), /already-bound/);
    probe.store.auditStore(probe.activity);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('bounded continuation and unavailable Info are restart-safe and do not spin on blocked jobs', () => {
  const sandbox = createSessionSandbox(randomUUID(), randomUUID());
  let probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    for (let i = 0; i < 3; i++) probe.store.rememberMemory(probe.activity,
      { input: probe.archive.append(randomUUID(), '记住偏好：bounded ' + i), hostInfo: 'durable' });
    const projectId = randomUUID();
    probe.store.confirmSessionProject(probe.activity, probe.archive.append(randomUUID(), '/bind ' + JSON.stringify({ projectId, root: null })), projectId, null);
    probe.close(); probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    assert.throws(() => probe.store.resumeProjectCaptures(probe.activity, 'durable', 17), /invalid-capture-limit/);
    const first = probe.store.resumeProjectCaptures(probe.activity, 'unavailable', 1);
    assert.equal(first.more, true);
    assert.equal(first.jobs[0]!.reason, 'host-info-unavailable');
    assert.equal(first.jobs[0]!.record!.lifecycle, 'candidate');
    const rest = probe.store.resumeProjectCaptures(probe.activity, 'unavailable');
    assert.equal(rest.jobs.length, 2); assert.equal(rest.more, false);
    assert.deepEqual(probe.store.resumeProjectCaptures(probe.activity, 'unavailable'), { jobs: [], more: false });
    probe.close(); probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    const active = probe.store.resumeProjectCaptures(probe.activity, 'durable');
    assert.equal(active.jobs.length, 3);
    assert(active.jobs.every(job => job.record!.lifecycle === 'active' && job.record!.revision === 2));
    probe.store.auditStore(probe.activity);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

for (const typed of [false, true]) test(`resolved ${typed ? 'objective fact' : 'untyped job'} uses independent capture verification with original null-project evidence`, () => {
  const sandbox = createSessionSandbox(randomUUID(), randomUUID());
  let probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const source = probe.archive.append(randomUUID(), typed ? '记住事实：scope capture evidence' : '记住：scope capture evidence');
    if (typed) probe.store.rememberMemory(probe.activity, { input: source, hostInfo: 'durable' });
    else probe.store.queueOwnerCapture(probe.activity, source);
    const projectId = randomUUID();
    probe.store.confirmSessionProject(probe.activity, probe.archive.append(randomUUID(), '/bind ' + JSON.stringify({ projectId, root: null })), projectId, null);
    probe.close(); probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    const job = probe.store.resumeProjectCaptures(probe.activity, 'durable').jobs[0]!;
    assert.equal(job.stage, typed ? 'verifying' : 'pending');
    assert.equal(probe.store.listCaptureJobs(probe.activity, 16, true).length, 1);
    const budget = { ...DEFAULT_BUDGET, maxModelAttempts: 8, maxTotalTokens: 100000, contextLimit: 20000 };
    const route = { provider: 'synthetic', model: 'capture-fixture', route: 'synthetic-capture', authNamespace: 'synthetic', capability: 'standard' as const };
    let lease = probe.store.claimCaptureJob(probe.activity, job.jobId, budget, 30000)!;
    assert(lease);
    let run = new CaptureRun(probe.store, lease, probe.archive, { proposer: [route], verifier: [route] });
    const deliver = (reply: ModelReply) => {
      let request = run.nextModel();
      if (!request && run.status().stage === 'verifying') {
        lease = probe.store.claimCaptureJob(probe.activity, job.jobId, budget, 30000)!;
        run = new CaptureRun(probe.store, lease, probe.archive, { proposer: [route], verifier: [route] });
        request = run.nextModel();
      }
      assert(request);
      const attempt = run.startModel(request, request.payload);
      assert.equal(run.maySend(attempt.attemptId, request.payload), true);
      probe.transport.send(request.payload, attempt);
      const raw = probe.archive.append(attempt.attemptId, JSON.stringify(reply), 'assistant');
      assert.equal(probe.store.isCaptureOutput(probe.activity, raw), true);
      run.finishModel(attempt.attemptId, reply);
      assert.equal(probe.store.isCaptureOutput(probe.activity, raw), true);
    };
    if (!typed) deliver({ text: JSON.stringify({ type: 'insight', content: 'scope capture evidence' }), calls: [], stop: 'end' });
    deliver({ text: '', calls: [{ id: 'find', name: 'source.search', arguments: { query: 'capture evidence' } }], stop: 'tools' });
    deliver({ text: '', calls: [{ id: 'read', name: 'source.expand', arguments: { eventId: source.eventId, offset: 0, limit: 4096 } }], stop: 'tools' });
    deliver({ text: JSON.stringify({ result: 'pass', evidence: [source] }), calls: [], stop: 'end' });
    assert.equal(run.nextModel(), null);
    const result = probe.store.readCaptureJob(probe.activity, job.jobId);
    assert.equal(result.record!.lifecycle, typed ? 'candidate' : 'active');
    assert.equal(result.record!.verification, typed ? 'unverified' : 'verified');
    if (typed) assert.equal(result.reason, 'objective-fact-authority-required');
    assert.deepEqual(result.record!.source, source);
    probe.store.auditStore(probe.activity);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('purge of one resolved memory retains the shared binding and independent resolved sibling', () => {
  const sandbox = createSessionSandbox(randomUUID(), randomUUID());
  let store: ReturnType<typeof openMaintenanceStore> | undefined;
  try {
    const seed = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { randomUUID } from 'node:crypto';
      import { openSandbox } from './apps/cli/src/sandbox.ts';
      import { openProbe } from './apps/cli/src/probe.ts';
      const sandbox = openSandbox(process.argv[1]);
      let probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
      const goal = probe.archive.append(randomUUID(), 'shared task authority');
      probe.store.transitionIntent(probe.activity, null, goal, { step: 'start', status: 'active' }, 'shared task authority');
      for (const text of ['purge selected', 'independent sibling']) probe.store.rememberMemory(probe.activity,
        { input: probe.archive.append(randomUUID(), '记住偏好：' + text), hostInfo: 'durable' });
      const projectId = randomUUID();
      probe.store.confirmSessionProject(probe.activity, probe.archive.append(randomUUID(), '/bind ' + JSON.stringify({ projectId, root: null })), projectId, null);
      probe.close(); probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
      const jobs = probe.store.resumeProjectCaptures(probe.activity, 'durable').jobs;
      probe.store.auditStore(probe.activity); probe.close(); console.log(JSON.stringify(jobs));
    `, sandbox.root], { encoding: 'utf8' });
    assert.equal(seed.status, 0, seed.stderr);
    const jobs = JSON.parse(seed.stdout.trim());
    store = openMaintenanceStore(sandbox);
    const coordinator = randomUUID(); store.beginMaintenance(coordinator);
    assert.equal(store.acquireMaintenance(coordinator).acquired, true);
    const preview = store.previewPurge(coordinator, jobs[0].record.recordId, readPurgeCarriers(sandbox, store, coordinator));
    assert.deepEqual(preview.manifest.records.map(record => record.recordId), [jobs[0].record.recordId]);
    assert.equal(preview.manifest.database.some(row => row.table === 'session_project_bindings'), false);
    assert.equal(preview.manifest.database.find(row => row.table === 'capture_scope_resolutions')!.count, 1);
    store.acknowledgePurgePresentation(coordinator, preview.token, preview.digest);
    assert.equal(store.commitPurge(coordinator, store.receivePurgeInput(coordinator, preview.phrase), preview.token,
      readPurgeCarriers(sandbox, store, coordinator)).status, 'logical-commit');
  } finally { store?.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('same-project record expansion is exact-source authorized, without cross-session raw access', () => {
  const sandbox = createSessionSandbox(randomUUID(), randomUUID());
  let probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const source = probe.archive.append(randomUUID(), '记住偏好：authorized source');
    probe.store.rememberMemory(probe.activity, { input: source, hostInfo: 'durable' });
    const unrelated = probe.archive.append(randomUUID(), 'unrelated private raw');
    const projectId = randomUUID();
    probe.store.confirmSessionProject(probe.activity, probe.archive.append(randomUUID(), '/bind ' + JSON.stringify({ projectId, root: null })), projectId, null);
    probe.close(); probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    const record = probe.store.resumeProjectCaptures(probe.activity, 'durable').jobs[0]!.record!;
    const binding = { ...probe.binding, sessionId: randomUUID(), branchId: randomUUID() };
    createSandboxSession(sandbox, binding);
    probe.close(); probe = openProbe(sandbox, undefined, undefined, binding, undefined, true);
    assert.equal(probe.store.inspectMemory(probe.activity, record.recordId).record.recordId, record.recordId);
    assert.equal(probe.store.expandSource(probe.activity, { recordId: record.recordId, offset: 0, limit: 4096 }).text, '记住偏好：authorized source');
    for (const ref of [source, unrelated]) assert.throws(() => probe.store.expandSource(probe.activity, { ref, offset: 0, limit: 4096 }), /source-scope-mismatch/);
    assert.throws(() => probe.store.rememberMemory(probe.activity, { input: { ...source, hash: '0'.repeat(64) }, hostInfo: 'durable' }), /source-scope-mismatch/);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('owner backfill uses the original reservation task instead of the current replay task', () => {
  const sandbox = createSessionSandbox(randomUUID(), randomUUID());
  let probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const old = probe.archive.append(randomUUID(), '记住偏好：initial raw backfill');
    const goal = probe.archive.append(randomUUID(), 'current task');
    probe.store.transitionIntent(probe.activity, null, goal, { step: 'start', status: 'active' }, 'current task');
    const current = probe.archive.append(randomUUID(), '记住偏好：current raw backfill');
    const projectId = randomUUID();
    probe.store.confirmSessionProject(probe.activity, probe.archive.append(randomUUID(), '/bind ' + JSON.stringify({ projectId, root: null })), projectId, null);
    probe.close(); probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    const oldRecord = probe.store.rememberMemory(probe.activity, { input: old, hostInfo: 'durable' }).record;
    const currentRecord = probe.store.rememberMemory(probe.activity, { input: current, hostInfo: 'durable' }).record;
    assert.equal(oldRecord.scope.resolved, false); assert.equal(currentRecord.scope.resolved, false);
    const result = probe.store.resumeProjectCaptures(probe.activity, 'durable');
    assert.deepEqual(result.jobs.map(job => job.record!.recordId), [currentRecord.recordId]);
    assert.equal(probe.store.inspectMemory(probe.activity, oldRecord.recordId).record.scope.resolved, false);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

for (const fault of ['source-task', 'binding-cut', 'resolution']) test(`scope resolution audit rejects tampered ${fault}`, () => {
  const sandbox = createSessionSandbox(randomUUID(), randomUUID());
  let probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    probe.store.rememberMemory(probe.activity, { input: probe.archive.append(randomUUID(), '记住偏好：audit scope'), hostInfo: 'durable' });
    const projectId = randomUUID();
    probe.store.confirmSessionProject(probe.activity, probe.archive.append(randomUUID(), '/bind ' + JSON.stringify({ projectId, root: null })), projectId, null);
    probe.close(); probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    probe.store.resumeProjectCaptures(probe.activity, 'durable');
    const db = new DatabaseSync(`${sandbox.root}/probe.sqlite`);
    try {
      db.function('euler_store_writer', () => 1);
      if (fault === 'source-task') db.exec("DROP TRIGGER immutable_source_appends_update; UPDATE source_appends SET task_hash='broken'");
      else if (fault === 'binding-cut') db.exec('DROP TRIGGER immutable_session_project_bindings_update; UPDATE session_project_bindings SET source_cut=source_cut+1');
      else db.exec("DROP TRIGGER immutable_capture_scope_resolutions_update; UPDATE capture_scope_resolutions SET payload_hash='broken'");
    } finally { db.close(); }
    assert.throws(() => probe.store.auditStore(probe.activity), /scope-(resolution|task)-evidence-gap/);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('resolution, new head and fast-lane verification roll back together on failure', () => {
  const sandbox = createSessionSandbox(randomUUID(), randomUUID());
  let probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const before = probe.store.rememberMemory(probe.activity, { input: probe.archive.append(randomUUID(), '记住偏好：atomic scope'), hostInfo: 'durable' }).record;
    const projectId = randomUUID();
    probe.store.confirmSessionProject(probe.activity, probe.archive.append(randomUUID(), '/bind ' + JSON.stringify({ projectId, root: null })), projectId, null);
    probe.close(); probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    const db = new DatabaseSync(`${sandbox.root}/probe.sqlite`);
    try { db.exec("CREATE TRIGGER fail_scope_verify BEFORE INSERT ON memory_events WHEN NEW.kind='verify' BEGIN SELECT RAISE(ABORT,'injected'); END"); }
    finally { db.close(); }
    assert.throws(() => probe.store.resumeProjectCaptures(probe.activity, 'durable'), /injected/);
    assert.deepEqual(probe.store.inspectMemory(probe.activity, before.recordId).record, before);
    const checkDb = new DatabaseSync(`${sandbox.root}/probe.sqlite`);
    try {
      assert.equal(checkDb.prepare('SELECT count(*) AS n FROM capture_scope_resolutions').get()!.n, 0);
      assert.equal(checkDb.prepare('SELECT count(*) AS n FROM memory_revisions').get()!.n, 1);
      checkDb.exec('DROP TRIGGER fail_scope_verify');
    } finally { checkDb.close(); }
    assert.equal(probe.store.resumeProjectCaptures(probe.activity, 'durable').jobs[0]!.record!.lifecycle, 'active');
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('a modified original head is visibly blocked rather than resolved or reactivated', () => {
  const sandbox = createSessionSandbox(randomUUID(), randomUUID());
  let probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const before = probe.store.rememberMemory(probe.activity, { input: probe.archive.append(randomUUID(), '记住偏好：original candidate'), hostInfo: 'durable' }).record;
    const changed = probe.store.correctMemory(probe.activity, before.recordId, before, probe.archive.append(randomUUID(), 'corrected candidate'), 'corrected candidate').record;
    const projectId = randomUUID();
    probe.store.confirmSessionProject(probe.activity, probe.archive.append(randomUUID(), '/bind ' + JSON.stringify({ projectId, root: null })), projectId, null);
    probe.close(); probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    assert.deepEqual(probe.store.resumeProjectCaptures(probe.activity, 'durable'), { jobs: [], more: false });
    assert.deepEqual(probe.store.inspectMemory(probe.activity, before.recordId).record, changed);
    assert.equal(probe.store.listCaptureJobs(probe.activity)[0]!.reason, 'later-memory-change');
    assert.deepEqual(probe.store.resumeProjectCaptures(probe.activity, 'durable'), { jobs: [], more: false });
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
