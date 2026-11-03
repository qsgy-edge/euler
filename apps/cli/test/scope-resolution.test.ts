import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { AgentRun, CaptureRun, DEFAULT_BUDGET } from '@euler/core';
import { pumpAgent } from '../src/agent-pump.ts';
import type { ModelReply } from '@euler/core';
import { startCli, sendCommand } from '../src/process-driver.ts';
import { createSessionSandbox, createSandboxSession } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

test('an ordinary first task resumes its complete capture range including the input preceding intent creation', async () => {
  const sandbox = createSessionSandbox(randomUUID(), randomUUID());
  let probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const run = new AgentRun(probe.store, probe.activity, { binding: probe.binding, source: probe.archive },
      { provider: 'synthetic', model: 'ordinary', route: 'synthetic', authNamespace: 'synthetic' },
      { ...DEFAULT_BUDGET, contextLimit: 32000, maxTotalTokens: 128000 });
    run.receive(randomUUID(), 'The synthetic task keeps original raw evidence.');
    const status = await pumpAgent(run, { recoverInfo: () => true,
      async *stream(request, _signal, send) {
        probe.transport.send(request.payload, send(request.payload));
        yield { kind: 'complete', reply: { text: 'The complete synthetic answer keeps original evidence.', calls: [], stop: 'end' } };
      }, async execute() { throw new Error('unexpected-tool'); } });
    assert.equal(status.terminal, 'completed');
    const job = probe.store.queueCaptureBoundary(probe.activity, run.runId)!;
    assert.equal(job.range[0]!.eventId, status.inputs[0]!.source.eventId);
    const projectId = randomUUID();
    probe.store.confirmSessionProject(probe.activity, probe.archive.append(randomUUID(), '/bind ' + JSON.stringify({ projectId, root: null })), projectId, null);
    probe.close(); probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    const resumed = probe.store.resumeProjectCaptures(probe.activity, 'durable');
    assert.equal(resumed.jobs.length, 1);
    assert.equal(resumed.jobs[0]!.jobId, job.jobId);
    assert.deepEqual(resumed.jobs[0]!.range, job.range);
    assert.equal(resumed.jobs[0]!.scope.id, projectId);
    assert.ok(probe.store.claimCaptureJob(probe.activity, job.jobId, DEFAULT_BUDGET, 30000));
    probe.store.auditStore(probe.activity);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('two real workers converge on one resolution and activation of the same original candidate', async () => {
  const sandbox = createSessionSandbox(randomUUID(), randomUUID());
  let probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const record = probe.store.rememberMemory(probe.activity,
      { input: probe.archive.append(randomUUID(), '记住偏好：parallel scope continuation'), hostInfo: 'durable' }).record;
    const projectId = randomUUID();
    probe.store.confirmSessionProject(probe.activity, probe.archive.append(randomUUID(), '/bind ' + JSON.stringify({ projectId, root: null })), projectId, null);
    probe.close();
    const command = `import { openSandbox } from './apps/cli/src/sandbox.ts';
      import { openProbe } from './apps/cli/src/probe.ts';
      const p = openProbe(openSandbox(process.argv[1]), undefined, undefined, undefined, undefined, true);
      try { console.log(JSON.stringify(p.store.resumeProjectCaptures(p.activity, 'durable'))); } finally { p.close(); }`;
    const workers = await Promise.all([0, 1].map(() => promisify(execFile)(process.execPath,
      ['--input-type=module', '-e', command, sandbox.root], { encoding: 'utf8' })));
    assert.equal(workers.reduce((count, result) => count + JSON.parse(result.stdout).jobs.length, 0), 1);
    probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    assert.deepEqual(probe.store.inspectMemory(probe.activity, record.recordId).history.map(event => event.kind),
      ['capture', 'resolve-scope', 'verify', 'activate']);
    assert.equal(probe.store.inspectMemory(probe.activity, record.recordId).record.revision, 2);
    assert.deepEqual(probe.store.resumeProjectCaptures(probe.activity, 'durable'), { jobs: [], more: false });
    probe.store.auditStore(probe.activity);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('waiting for project confirmation does not spend an unstarted capture execution budget', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const sandbox = createSessionSandbox(randomUUID(), randomUUID());
  let probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const job = probe.store.queueOwnerCapture(probe.activity, probe.archive.append(randomUUID(), '记住：scope waiting budget'));
    assert.equal(probe.store.claimCaptureJob(probe.activity, job.jobId, DEFAULT_BUDGET, 30000), null);
    assert.equal(probe.store.readCaptureJob(probe.activity, job.jobId).reason, 'scope-unresolved');
    t.mock.timers.tick(DEFAULT_BUDGET.wallClockMs + 1);
    const projectId = randomUUID();
    probe.store.confirmSessionProject(probe.activity, probe.archive.append(randomUUID(), '/bind ' + JSON.stringify({ projectId, root: null })), projectId, null);
    probe.close(); probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    probe.store.resumeProjectCaptures(probe.activity, 'durable');
    assert.ok(probe.store.claimCaptureJob(probe.activity, job.jobId, DEFAULT_BUDGET, 30000),
      JSON.stringify(probe.store.readCaptureJob(probe.activity, job.jobId)));
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

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

for (const fault of ['digest', 'project-field']) test(`a bounded continuation validates only its selected batch, damage=${fault}`, () => {
  const sandbox = createSessionSandbox(randomUUID(), randomUUID());
  let probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const records = ['first bounded candidate', 'next bounded candidate'].map(content => probe.store.rememberMemory(probe.activity,
      { input: probe.archive.append(randomUUID(), '记住偏好：' + content), hostInfo: 'durable' }).record);
    const projectId = randomUUID();
    probe.store.confirmSessionProject(probe.activity, probe.archive.append(randomUUID(), '/bind ' + JSON.stringify({ projectId, root: null })), projectId, null);
    probe.close(); probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    const db = new DatabaseSync(`${sandbox.root}/probe.sqlite`);
    const original = db.prepare('SELECT job_id,payload,payload_hash FROM capture_jobs WHERE record_id=?').get(records[1]!.recordId)!;
    try {
      db.exec('DROP TRIGGER immutable_capture_jobs_update');
      db.function('euler_store_writer', () => 1);
      if (fault === 'digest') db.prepare("UPDATE capture_jobs SET payload_hash='damaged' WHERE job_id=?").run(original.job_id!);
      else db.prepare("UPDATE capture_jobs SET payload=json_set(payload,'$.source.binding.projectId',?) WHERE job_id=?").run(randomUUID(), original.job_id!);
      const first = probe.store.resumeProjectCaptures(probe.activity, 'durable', 1);
      assert.equal(first.jobs.length, 1); assert.equal(first.more, true);
      assert.equal(first.jobs[0]!.record!.recordId, records[0]!.recordId);
      assert.equal(first.jobs[0]!.record!.lifecycle, 'active');
      assert.throws(() => probe.store.resumeProjectCaptures(probe.activity, 'durable', 1), /capture-evidence-gap/);
      db.prepare('UPDATE capture_jobs SET payload=?,payload_hash=? WHERE job_id=?').run(original.payload!, original.payload_hash!, original.job_id!);
    } finally { db.close(); }
    assert.equal(probe.store.resumeProjectCaptures(probe.activity, 'durable', 1).jobs[0]!.record!.recordId, records[1]!.recordId);
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
      assert.equal(probe.store.isCaptureOutput(probe.activity, { ...raw, hash: '0'.repeat(64), contentHash: '0'.repeat(64) }), true);
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

for (const variant of ['owner', 'normal', 'later-normal'] as const) test(`purge of one resolved memory retains the shared binding and independent sibling, variant=${variant}`, async () => {
  const normalGoal = variant !== 'owner';
  const sandbox = createSessionSandbox(randomUUID(), randomUUID());
  let cli: ReturnType<typeof startCli> | undefined;
  try {
    const seed = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { randomUUID } from 'node:crypto';
      import { openSandbox } from './apps/cli/src/sandbox.ts';
      import { openProbe } from './apps/cli/src/probe.ts';
      import { AgentRun, CaptureRun, DEFAULT_BUDGET } from '@euler/core';
      import { pumpAgent } from './apps/cli/src/agent-pump.ts';
      const sandbox = openSandbox(process.argv[1]);
      let probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
      const budget = { ...DEFAULT_BUDGET, contextLimit: 32000, maxTotalTokens: 256000, maxModelAttempts: 8 };
      const route = { provider: 'synthetic', model: 'purge-scope', route: 'synthetic', authNamespace: 'synthetic', capability: 'standard' };
      let goal, normal, firstInput;
      if (${variant === 'later-normal'}) {
        const first = probe.archive.append(randomUUID(), 'first unrelated task');
        let intent = probe.store.transitionIntent(probe.activity, null, first, { step: 'start', status: 'active' }, 'first unrelated task');
        intent = probe.store.transitionIntent(probe.activity, intent.eventId, probe.archive.append(randomUUID(), 'first task done'), { step: 'done', status: 'completed' });
        firstInput = probe.archive.append(randomUUID(), 'shared task authority');
        probe.store.transitionIntent(probe.activity, intent.eventId, firstInput, { step: 'start', status: 'active' }, 'shared task authority');
      }
      if (${normalGoal}) {
        const { capability, ...agentRoute } = route;
        const agent = new AgentRun(probe.store, probe.activity, { binding: probe.binding, source: probe.archive }, agentRoute, budget);
        goal = agent.receive(firstInput?.eventId ?? randomUUID(), 'shared task authority');
        await pumpAgent(agent, { recoverInfo: () => true, async *stream(request, signal, send) {
          probe.transport.send(request.payload, send(request.payload));
          yield { kind: 'complete', reply: { text: 'Completed synthetic task.', calls: [], stop: 'end' } };
        }, async execute() { throw new Error('unexpected'); } });
        normal = probe.store.queueCaptureBoundary(probe.activity, agent.runId);
      } else {
        goal = probe.archive.append(randomUUID(), 'shared task authority');
        probe.store.transitionIntent(probe.activity, null, goal, { step: 'start', status: 'active' }, 'shared task authority');
        probe.store.rememberMemory(probe.activity, { input: probe.archive.append(randomUUID(), '记住偏好：purge selected'), hostInfo: 'durable' });
      }
      probe.store.rememberMemory(probe.activity, { input: probe.archive.append(randomUUID(), '记住偏好：independent sibling'), hostInfo: 'durable' });
      const projectId = randomUUID();
      probe.store.confirmSessionProject(probe.activity, probe.archive.append(randomUUID(), '/bind ' + JSON.stringify({ projectId, root: null })), projectId, null);
      probe.close(); probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
      const jobs = probe.store.resumeProjectCaptures(probe.activity, 'durable').jobs;
      if (normal) {
        const create = () => new CaptureRun(probe.store, probe.store.claimCaptureJob(probe.activity, normal.jobId, budget, 30000),
          probe.archive, { proposer: [route], verifier: [route] });
        let run = create();
        const deliver = reply => {
          let request = run.nextModel();
          if (!request && run.status().stage === 'verifying') { run = create(); request = run.nextModel(); }
          const attempt = run.startModel(request, request.payload);
          if (!run.maySend(attempt.attemptId, request.payload)) throw new Error('not-authorized');
          probe.transport.send(request.payload, attempt); run.finishModel(attempt.attemptId, reply);
        };
        deliver({ text: JSON.stringify({ type: 'insight', content: 'purge selected' }), calls: [], stop: 'end' });
        deliver({ text: '', calls: [{ id: 's', name: 'source.search', arguments: { query: 'shared task authority' } }], stop: 'tools' });
        deliver({ text: '', calls: [{ id: 'e', name: 'source.expand', arguments: { eventId: goal.eventId, offset: 0, limit: 4096 } }], stop: 'tools' });
        deliver({ text: JSON.stringify({ result: 'pass', evidence: [goal] }), calls: [], stop: 'end' });
        jobs[0] = probe.store.readCaptureJob(probe.activity, normal.jobId);
        if (jobs[0].record.verification !== 'verified') throw new Error(JSON.stringify(jobs[0]));
      }
      probe.store.auditStore(probe.activity); probe.close(); console.log(JSON.stringify(jobs));
    `, sandbox.root], { encoding: 'utf8' });
    assert.equal(seed.status, 0, seed.stderr);
    const jobs = JSON.parse(seed.stdout.trim());
    const beforeDb = new DatabaseSync(`${sandbox.root}/probe.sqlite`, { readOnly: true });
    const originalOrdinals = beforeDb.prepare('SELECT source_event_id,ordinal FROM source_appends').all();
    const frozenCut = beforeDb.prepare('SELECT source_cut FROM session_project_bindings').get()!.source_cut;
    beforeDb.close();
    cli = startCli(['purge', '--sandbox', sandbox.root, '--record', jobs[0].record.recordId]);
    const preview = await cli.waitFor('purge-preview');
    const manifest = preview.manifest as { records: { recordId: string }[]; database: { table: string; count: number }[] };
    assert.deepEqual(manifest.records.map(record => record.recordId), [jobs[0].record.recordId]);
    assert.equal(manifest.database.some(row => row.table === 'session_project_bindings'), false);
    assert.equal(manifest.database.find(row => row.table === 'capture_scope_resolutions')!.count, 1);
    assert.equal((await sendCommand(cli, String(preview.phrase), 'purge-result')).status, 'logical-commit');
    assert.equal((await sendCommand(cli, 'cleanup', 'purge-result')).status, 'controlled-complete');
    assert.equal((await cli.exit).code, 0);
    const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    try {
      probe.store.auditStore(probe.activity);
      assert.equal(probe.store.inspectMemory(probe.activity, jobs[1].record.recordId).record.lifecycle, 'active');
      assert.throws(() => probe.store.inspectMemory(probe.activity, jobs[0].record.recordId), /memory-evidence-gap/);
      probe.store.rebuildSearchProjection(probe.activity);
      assert.equal(probe.store.searchMemories(probe.activity, { query: 'independent sibling' }).results.length, 1);
      const projectId = probe.binding.projectId!;
      probe.store.confirmSessionProject(probe.activity, probe.archive.append(randomUUID(), '/bind ' + JSON.stringify({ projectId, root: null })), projectId, null);
      assert.deepEqual(probe.store.resumeProjectCaptures(probe.activity, 'durable'), { jobs: [], more: false });
      probe.store.auditStore(probe.activity);
      if (variant === 'later-normal') {
        assert.equal(probe.store.readIntent(probe.activity), null);
        assert.equal(probe.store.recoverIntent(probe.activity), null);
        const input = probe.archive.append(randomUUID(), 'new task after controlled purge');
        const intent = probe.store.transitionIntent(probe.activity, null, input, { step: 'start', status: 'active' }, 'new task after controlled purge');
        assert.equal(probe.store.readIntent(probe.activity)!.intentId, intent.intentId);
        probe.store.auditStore(probe.activity);
      }
      const db = new DatabaseSync(`${sandbox.root}/probe.sqlite`, { readOnly: true });
      try {
        assert.equal(db.prepare('SELECT source_cut FROM session_project_bindings').get()!.source_cut, frozenCut);
        const greatest = Math.max(...originalOrdinals.map(row => Number(row.ordinal)));
        for (const row of db.prepare('SELECT source_event_id,ordinal FROM source_appends').all()) {
          const original = originalOrdinals.find(original => original.source_event_id === row.source_event_id);
          if (original) assert.equal(row.ordinal, original.ordinal);
          else assert.ok(Number(row.ordinal) > greatest);
        }
      } finally { db.close(); }
      if (normalGoal) assert.equal(readFileSync(`${sandbox.root}/session.jsonl`, 'utf8').includes('shared task authority'), false);
    } finally { probe.close(); }
  } finally {
    if (cli && cli.child.exitCode === null && cli.child.signalCode === null) { cli.child.kill(); await cli.exit; }
    rmSync(sandbox.root, { recursive: true, force: true });
  }
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

test('original fast-lane input replay cannot activate a candidate across snapshot ownership fences', async () => {
  const sandbox = createSessionSandbox(randomUUID(), randomUUID());
  try {
    const seeded = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { randomUUID } from 'node:crypto';
      import { openSandbox } from './apps/cli/src/sandbox.ts';
      import { openProbe } from './apps/cli/src/probe.ts';
      const sandbox = openSandbox(process.argv[1]);
      let p = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
      const input = p.archive.append(randomUUID(), '记住偏好：snapshot replay waits for durable Info');
      p.store.rememberMemory(p.activity, { input, hostInfo: 'durable' });
      const projectId = randomUUID();
      p.store.confirmSessionProject(p.activity, p.archive.append(randomUUID(), '/bind ' + JSON.stringify({ projectId, root: null })), projectId, null);
      p.close(); p = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
      const record = p.store.resumeProjectCaptures(p.activity, 'unavailable').jobs[0].record;
      p.close(); console.log(JSON.stringify({ input, record }));
    `, sandbox.root], { encoding: 'utf8' });
    assert.equal(seeded.status, 0, seeded.stderr);
    const { input, record } = JSON.parse(seeded.stdout.trim());
    assert.equal(record.verification, 'verified'); assert.equal(record.lifecycle, 'candidate');
    const backup = startCli(['backup', '--sandbox', sandbox.root]);
    assert.equal((await backup.exit).code, 0, JSON.stringify(backup.observations));
    const snapshotId = (backup.observations.find(event => event.event === 'backup-result')!.snapshot as { id: string }).id;
    const restore = startCli(['restore-snapshot', '--sandbox', sandbox.root, '--snapshot', snapshotId]);
    assert.equal((await restore.exit).code, 0, JSON.stringify(restore.observations));
    const p = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    try {
      assert.throws(() => p.store.resumeProjectCaptures(p.activity, 'durable'), /recovered-stream-blocked/);
      assert.throws(() => p.store.rememberMemory(p.activity, { input, hostInfo: 'durable' }), /recovered-stream-blocked/);
      assert.deepEqual(p.store.inspectMemory(p.activity, record.recordId).record, record);
    } finally { p.close(); }
  } finally { rmSync(sandbox.root, { recursive: true, force: true }); }
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

test('typed task ownership rejects nonexistent task references at the database boundary', () => {
  const sandbox = createSessionSandbox(randomUUID(), randomUUID());
  const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const source = probe.archive.append(randomUUID(), 'typed source task');
    const db = new DatabaseSync(`${sandbox.root}/probe.sqlite`);
    try {
      db.function('euler_store_writer', () => 1);
      db.exec('PRAGMA foreign_keys=ON');
      assert.throws(() => db.prepare('UPDATE source_appends SET task_id=? WHERE source_event_id=?').run(randomUUID(), source.eventId), /append-only/);
      db.exec('DROP TRIGGER immutable_source_appends_update');
      assert.throws(() => db.prepare('UPDATE source_appends SET task_id=? WHERE source_event_id=?').run(randomUUID(), source.eventId), /FOREIGN KEY constraint failed/);
    } finally { db.close(); }
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
    const reverification = probe.store.queueMemoryVerification(probe.activity, changed.recordId, changed);
    const projectId = randomUUID();
    probe.store.confirmSessionProject(probe.activity, probe.archive.append(randomUUID(), '/bind ' + JSON.stringify({ projectId, root: null })), projectId, null);
    probe.close(); probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    assert.deepEqual(probe.store.resumeProjectCaptures(probe.activity, 'durable'), { jobs: [], more: false });
    assert.deepEqual(probe.store.inspectMemory(probe.activity, before.recordId).record, changed);
    assert.equal(probe.store.listCaptureJobs(probe.activity)[0]!.reason, 'later-memory-change');
    const queued = probe.store.readCaptureJob(probe.activity, reverification.jobId);
    assert.equal(queued.stage, 'blocked');
    assert.equal(queued.reason, 'later-memory-change');
    assert.equal(probe.store.claimCaptureJob(probe.activity, reverification.jobId, DEFAULT_BUDGET, 30000), null);
    assert.deepEqual(probe.store.resumeProjectCaptures(probe.activity, 'durable'), { jobs: [], more: false });
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
