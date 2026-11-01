import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { runRememberSession } from '../../src/owner-memory.ts';
import { DatabaseSync } from 'node:sqlite';
import { AgentRun, AnalysisArtifacts, DEFAULT_BUDGET, GuidanceSession, fileIdentity, ProbeStore } from '@euler/core';
import { openSandbox, bindingOf } from '../../src/sandbox.ts';
import { openProbe } from '../../src/probe.ts';
import { killPoint } from '../../src/kill-point.ts';

const [root, action, scenario = 'input', point = 'normal'] = process.argv.slice(2);
const sandbox = openSandbox(root!);
const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
const budget = { ...DEFAULT_BUDGET, contextLimit: 20000, maxTotalTokens: 100000, maxModelAttempts: 4 };
const route = { provider: 'fake', model: 'controlled', route: 'fixture', authNamespace: 'none' };
const emit = (value: object) => fs.writeSync(1, JSON.stringify(value) + '\n');
let armed = false, wrote = false, flushed = false;
const checkpoint = (stage: string) => { if (armed && point === stage) killPoint('checkpoint', stage, 30000); };
const archiveFd = (fd: number) => {
  if (!armed || fd <= 2) return false;
  const value = fs.fstatSync(fd, { bigint: true });
  return String(value.dev) === sandbox.archiveIdentity.dev && String(value.ino) === sandbox.archiveIdentity.ino;
};
const write = fs.writeSync, sync = fs.fsyncSync, read = fs.readFileSync;
const exec = DatabaseSync.prototype.exec;
const withActivity = ProbeStore.prototype.withActivity;
const prepare = ProbeStore.prototype.prepareSourceAppend;
const settle = ProbeStore.prototype.settleSourceAppend;
try {
  if (action === 'retry') {
    emit({ event: 'retried', ack: probe.archive.append(point, 'Atlas 原始输入 survives a process crash.') });
  } else if (action === 'owner-recover') {
    await runRememberSession(sandbox, { hostInfo: 'durable', noActiveProject: false, scenario: 'success', syntheticProposals: true });
  } else if (action === 'recover') {
    let blindAppends = 0, writtenBytes = 0;
    fs.writeSync = ((fd: number, ...args: unknown[]) => {
      const count = Reflect.apply(write, fs, [fd, ...args]);
      if (fd > 2 && String(fs.fstatSync(fd, { bigint: true }).ino) === sandbox.archiveIdentity.ino) writtenBytes += count;
      return count;
    }) as typeof fs.writeSync;
    syncBuiltinESMExports();
    const append = probe.archive.append.bind(probe.archive);
    probe.archive.append = (...args) => { blindAppends++; return append(...args); };
    const pending = probe.store.sourceAppends(probe.activity);
    const acks = probe.archive.reconcile();
    for (const ack of acks) assert.deepEqual(probe.archive.lookup(ack.eventId), ack);
    assert.deepEqual(probe.archive.reconcile(), []);
    emit({ event: 'recovered', pendingIds: pending.map(item => item.eventId), acks,
      events: probe.archive.events().map(item => item.ack), sends: probe.transport.count, blindAppends, writtenBytes,
      captures: probe.store.listCaptureJobs(probe.activity).length });
  } else if (action === 'projection-recover') {
    const first = probe.store.drainSourceProjection(probe.activity), second = probe.store.drainSourceProjection(probe.activity);
    emit({ event: 'projection-recovered', first, second, result: probe.store.searchSources(probe.activity, { query: 'Atlas' }) });
  } else {
    const eventId = randomUUID();
    let perform: () => unknown;
    let runId: string | null = null;
    if (scenario === 'input') perform = () => probe.archive.append(eventId, 'Atlas 原始输入 survives a process crash.');
    else if (scenario === 'owner') perform = () => runRememberSession(sandbox, { hostInfo: 'durable', noActiveProject: false, scenario: 'success', syntheticProposals: true });
    else if (scenario === 'agreement') {
      probe.archive.append(randomUUID(), '建议记住事实：Atlas 需要保留原始输入。', 'assistant');
      perform = () => runRememberSession(sandbox, { hostInfo: 'durable', noActiveProject: false, scenario: 'success', syntheticProposals: true });
    } else if (['response', 'tool', 'file-presentation', 'file-approval'].includes(scenario)) {
      const fileScenario = scenario.startsWith('file-');
      const project = `${sandbox.root}-project`;
      if (fileScenario) fs.mkdirSync(project);
      const files = fileScenario ? { schema: 'file-capability@1' as const, grantId: randomUUID(), binding: bindingOf(sandbox),
        root: { path: fs.realpathSync.native(project), identity: fileIdentity(project) },
        source: probe.archive.append(randomUUID(), 'Authorize a synthetic project file presentation.') } : undefined;
      const run = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive, ...(files ? { files } : {}) }, route, budget);
      runId = run.runId;
      run.receive(randomUUID(), 'Execute one controlled echo.');
      const request = run.nextModel()!, attempt = run.startModel(request, request.payload);
      assert.equal(run.maySend(attempt.attemptId, request.payload), true);
      const reply = { text: 'Atlas response.', calls: [fileScenario
        ? { id: 'file', name: 'file.write', arguments: { path: 'atlas.txt', content: 'Atlas content.' } }
        : { id: 'echo', name: 'controlled.echo', arguments: { text: 'Atlas echo' } }], stop: 'tools' as const };
      if (scenario === 'response') perform = () => run.finishModel(attempt.attemptId, reply);
      else {
        run.finishModel(attempt.attemptId, reply);
        if (files) {
          const target = { path: join(files.root.path, 'atlas.txt'), parent: files.root, identity: null };
          if (scenario === 'file-presentation') perform = () => run.presentFile('file', target);
          else { const presentation = run.presentFile('file', target)!; perform = () => run.decideFile(presentation, 'approved'); }
        } else { run.startTool('echo'); perform = () => run.finishTool('echo', 'Atlas echo'); }
      }
    } else {
      const goal = probe.archive.append(randomUUID(), 'Save the Atlas recovery evidence.');
      const intent = probe.store.transitionIntent(probe.activity, null, goal, { status: 'active', step: 'evidence' }, 'Save the Atlas recovery evidence.');
      if (scenario === 'guidance') {
        const project = join(sandbox.root, 'project'); fs.mkdirSync(project);
        const guidance = new GuidanceSession(probe.store, probe.activity, probe.archive, {
          dataRoot: { path: sandbox.root, identity: fileIdentity(sandbox.root) },
          projects: [{ projectId: sandbox.fixture.projectId, root: { path: project, identity: fileIdentity(project) } }],
          sharedSkills: null, sources: [],
        });
        runId = guidance.runId;
        perform = () => guidance.prepare([{ projectId: sandbox.fixture.projectId, path: join(project, 'target.ts') }]);
      } else if (scenario === 'report') {
        const artifacts = new AnalysisArtifacts(probe.store, probe.activity, probe.archive);
        perform = () => artifacts.saveReport({ eventId, title: 'Atlas', facts: 'Original evidence.', inferences: 'None.',
          recommendations: 'Keep the source.', unresolved: 'None.', evidence: [] });
      } else if (scenario === 'projection') {
        const source = probe.archive.append(eventId, 'Atlas source publication before projection.');
        const input = { ref: source, projectId: sandbox.fixture.projectId, kind: 'source' as const, offset: 0, length: 5 };
        const approval = probe.archive.append(randomUUID(), JSON.stringify({ schema: 'source-publication-approval@1',
          intentId: intent.intentId, goalEventId: intent.goalInput.eventId, ...input }));
        perform = () => {
          const unit = probe.store.publishSourceUnit(probe.activity, { ...input, approval });
          emit({ event: 'published', unit }); checkpoint('publication-pending');
          return unit;
        };
      } else throw new Error('unknown-scenario');
    }
    fs.writeSync = ((fd: number, buffer: Uint8Array, ...args: unknown[]) => {
      if (archiveFd(fd)) {
        checkpoint('before-write');
        if (point === 'partial-write') {
          write(fd, buffer, 0, Math.max(1, Math.floor(buffer.length / 2)));
          checkpoint('partial-write');
        }
        const count = Reflect.apply(write, fs, [fd, buffer, ...args]);
        wrote = true; checkpoint('after-write'); return count;
      }
      return Reflect.apply(write, fs, [fd, buffer, ...args]);
    }) as typeof fs.writeSync;
    fs.fsyncSync = fd => { sync(fd); if (archiveFd(fd) && wrote) { flushed = true; checkpoint('after-fsync'); } };
    fs.readFileSync = ((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      const value = Reflect.apply(read, fs, [path, ...args]);
      if (typeof path === 'number' && archiveFd(path) && flushed) checkpoint('after-readback');
      return value;
    }) as typeof fs.readFileSync;
    DatabaseSync.prototype.exec = function(sql: string) {
      if (armed && sql === 'COMMIT' && this.prepare("SELECT 1 FROM source_appends WHERE status='pending' LIMIT 1").get()) checkpoint('reservation-uncommitted');
      return exec.call(this, sql);
    };
    ProbeStore.prototype.withActivity = function(activity, action) {
      const result = withActivity.call(this, activity, action);
      if (result && typeof result === 'object' && 'schema' in result && result.schema === 'cli-source-ack@1') checkpoint('ack-committed');
      return result as ReturnType<typeof action>;
    };
    ProbeStore.prototype.prepareSourceAppend = function(activity, input) {
      const result = prepare.call(this, activity, input); checkpoint('reservation-committed'); return result;
    };
    ProbeStore.prototype.settleSourceAppend = function(activity, source) { checkpoint('before-ack'); settle.call(this, activity, source); };
    syncBuiltinESMExports();
    emit({ event: 'ready', scenario, point, eventId, runId });
    armed = true;
    const result = await perform();
    checkpoint('ack-returned');
    emit({ event: 'completed', result });
  }
} finally {
  armed = false;
  fs.writeSync = write; fs.fsyncSync = sync; fs.readFileSync = read; DatabaseSync.prototype.exec = exec;
  ProbeStore.prototype.withActivity = withActivity;
  ProbeStore.prototype.prepareSourceAppend = prepare; ProbeStore.prototype.settleSourceAppend = settle;
  syncBuiltinESMExports(); probe.close();
}
