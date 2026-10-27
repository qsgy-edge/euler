import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import sqlite from 'node:sqlite';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { ProbeStore, ProbeSession, API_VERSION, DEFAULT_BUDGET, type Binding } from '@euler/core';
import { openSandbox, bindingOf, resourcesOf, createSandboxSession } from '../../src/sandbox.ts';
import { openProbe } from '../../src/probe.ts';
import { backupSandbox, restoreSandboxSnapshot } from '../../src/backup.ts';
import { seedBackupOperations, corruptBackupOperation } from './backup-operations.ts';
import { compareCandidate, verifiedCandidate } from './memory-evolution.ts';
import { approvedSourceUnit, saveApprovedProposal } from './source-publication.ts';

const [root, action, value, point] = process.argv.slice(2);
const sandbox = openSandbox(root!);
function crash(point: string): never {
  fs.writeSync(1, JSON.stringify({ event: 'snapshot-crash', point }) + '\n');
  process.kill(process.pid, 'SIGKILL'); throw new Error('process-was-not-killed');
}
function interruptSnapshotRemoval(point: string, matches: (path: string) => boolean): void {
  const remove = fs.rmdirSync;
  fs.rmdirSync = (...args) => {
    const selected = matches(String(args[0]));
    if (selected && point === 'before') crash('snapshot-cleanup-before');
    remove(...args);
    if (selected && point === 'after') crash('snapshot-cleanup-after');
  };
  syncBuiltinESMExports();
}
function seedCanonicalState() {
  const binding = { ...bindingOf(sandbox), projectId: randomUUID(), sessionId: randomUUID(), branchId: randomUUID() };
  createSandboxSession(sandbox, binding);
  const probe = openProbe(sandbox, undefined, undefined, binding, undefined, true);
  try {
    const { store, activity, archive } = probe;
    const workspaceId = randomUUID(); store.bindWorkspace(activity, workspaceId, [binding.projectId]);
    const goal = archive.append(randomUUID(), 'Preserve canonical recovery relationships');
    const transition = { status: 'active' as const, step: 'inspect' };
    const intent = store.transitionIntent(activity, null, goal, transition, 'Preserve canonical recovery relationships');
    const first = verifiedCandidate(probe, '本项目在 Windows 使用 PowerShell', { appliesTo: ['platform:win32'] }).record!;
    store.promoteMemory(activity, first.recordId, first);
    const second = verifiedCandidate(probe, '本项目在 Linux 使用 Bash', { appliesTo: ['platform:linux'] });
    store.promoteMemory(activity, second.record!.recordId, second.record!); compareCandidate(probe, second.jobId, 'distinct');
    const records = [first.recordId, second.record!.recordId].map(id => store.readMemory(activity, id));
    const input = archive.append(randomUUID(), JSON.stringify({ schema: 'memory-feedback@1', kind: 'user_helpful',
      recordId: records[0]!.recordId, revisionId: records[0]!.revisionId, headEventId: records[0]!.headEventId }));
    const feedback = store.recordMemoryFeedback(activity, records[0]!.recordId, records[0]!, input);
    const text = 'Atlas bounded canonical source', ref = archive.append(randomUUID(), text);
    const publication = approvedSourceUnit(probe, { ref, projectId: binding.projectId, kind: 'source', offset: 0, length: text.length });
    const unit = store.publishSourceUnit(activity, publication);
    const proposalInput = { target: 'canonical.md', expectedChange: 'Keep local logs', owner: binding.ownerId,
      scope: { kind: 'project' as const, id: binding.projectId, resolved: true }, evidenceRefs: [ref],
      evaluation: { schema: 'evaluation-contract@1' as const, level: 'L0' as const, assertions: ['Keep the log'] } };
    const proposal = saveApprovedProposal(probe, proposalInput);
    store.drainSourceProjection(activity);
    const consent = archive.append(randomUUID(), JSON.stringify({ schema: 'memory-discovery-approval@1', intentId: intent.intentId,
      goalEventId: intent.goalInput.eventId, projectIds: [binding.projectId], targets: {}, maxResults: 8, maxBytes: 131072 }));
    const { grantId } = store.authorizeMemoryDiscovery(activity, consent, [binding.projectId], 8);
    const query = { query: 'Atlas', grantId, queryId: randomUUID() }, page = store.searchSources(activity, query);
    return { binding, workspaceId, intent, transition, records, feedbackId: feedback.feedbackId, publication, unit, proposalInput, proposal, query, page };
  } finally { probe.close(); }
}
if (action === 'seed-canonical-state') {
  console.log(JSON.stringify(seedCanonicalState()));
} else if (action === 'read-canonical-state') {
  const saved = JSON.parse(value!) as ReturnType<typeof seedCanonicalState>;
  const probe = openProbe(sandbox, undefined, undefined, saved.binding, undefined, true);
  try {
    const { store, activity } = probe;
    let grantError: string | null = null;
    try { store.assertMemoryDiscovery(activity, saved.query.grantId); } catch (error) { grantError = (error as Error).message; }
    console.log(JSON.stringify({ records: saved.records.map(record => store.readMemory(activity, record.recordId)),
      feedback: store.readMemoryFeedback(activity, saved.records[0]!.recordId), grantError,
      membership: store.guidanceMembership(activity, [saved.binding.projectId]),
      intent: store.transitionIntent(activity, null, saved.intent.input, saved.transition, saved.intent.goal),
      unit: store.publishSourceUnit(activity, saved.publication),
      proposal: store.saveEvolutionProposal(activity, saved.proposal.input, saved.proposalInput), sends: probe.transport.count }));
  } finally { probe.close(); }
} else if (action === 'seed-operations') {
  const bindings = [bindingOf(sandbox), { ...bindingOf(sandbox), projectId: randomUUID(), sessionId: randomUUID(), branchId: randomUUID() }];
  createSandboxSession(sandbox, bindings[1]!);
  console.log(JSON.stringify(bindings.map(binding => {
    const probe = openProbe(sandbox, undefined, undefined, binding, undefined, true);
    try { return { binding, saved: seedBackupOperations(probe, binding.projectId) }; } finally { probe.close(); }
  })));
} else if (action === 'corrupt-operations') {
  const { token, fault } = JSON.parse(value!) as { token: string; fault: string };
  corruptBackupOperation(sandbox.root, token, fault);
  console.log(JSON.stringify({ token, fault }));
} else if (action === 'advance-operations' || action === 'read-operations') {
  const requests = JSON.parse(value!) as { binding: Binding; committedToken: string; pendingToken: string; receiptId: string }[];
  console.log(JSON.stringify(requests.map((request, index) => {
    const probe = openProbe(sandbox, undefined, undefined, request.binding, undefined, true);
    try {
      const { store, activity } = probe;
      if (action === 'advance-operations') {
        const pending = store.readMemoryPresentation(activity, request.pendingToken);
        store.acknowledgeMemoryPresentation(activity, pending.token, pending.hash);
        return store.commitMemoryOperation(activity, pending.token);
      }
      const foreign = requests[1 - index]!;
      const rejected = (read: () => unknown) => { try { return { result: read() }; } catch (error) { return { error: (error as Error).message }; } };
      return { binding: request.binding, presentation: store.readMemoryPresentation(activity, request.committedToken),
        result: store.memoryOperationStatus(activity, request.committedToken), pending: store.memoryOperationStatus(activity, request.pendingToken),
        delivery: store.correctionDelivery(activity, request.committedToken), summaries: store.correctionModelSummaries(activity),
        foreign: { presentation: rejected(() => store.readMemoryPresentation(activity, foreign.committedToken)),
          operation: store.memoryOperationStatus(activity, foreign.committedToken), receipt: rejected(() => store.readOwnerReceipt(activity, foreign.receiptId)) },
        sends: probe.transport.count };
    } finally { probe.close(); }
  })));
} else if (action === 'seed-provenance') {
  const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const first = probe.archive.append(randomUUID(), '记住偏好：使用 pnpm');
    const initial = probe.store.rememberMemory(probe.activity, { input: first, hostInfo: 'durable' });
    const again = probe.archive.append(randomUUID(), '记住偏好：使用 pnpm');
    const repeated = probe.store.rememberMemory(probe.activity, { input: again, hostInfo: 'durable' });
    const content = '使用 pnpm 并保留原始构建日志';
    const updated = probe.archive.append(randomUUID(), content);
    const correction = probe.store.correctMemory(probe.activity, initial.record.recordId, initial.record, updated, content);
    console.log(JSON.stringify({ initial, repeated, correction, sources: [updated, first, again] }));
  } finally { probe.close(); }
} else if (action === 'forget-provenance') {
  const binding = { ...bindingOf(sandbox), sessionId: randomUUID(), branchId: randomUUID() };
  createSandboxSession(sandbox, binding);
  const probe = openProbe(sandbox, undefined, undefined, binding, undefined, true);
  try {
    const record = probe.store.readMemory(probe.activity, value!);
    const result = probe.store.forgetMemory(probe.activity, value!, record);
    const event = probe.store.inspectMemory(probe.activity, value!).history.find(event => event.eventId === result.eventId)!;
    console.log(JSON.stringify({ result, sources: JSON.parse(event.payload).suppression.sources, sends: probe.transport.count }));
  } finally { probe.close(); }
} else if (action === 'migration-checkpoint') {
  console.log(JSON.stringify(await backupSandbox(sandbox, 'migration')));
} else if (action === 'queue-capture') {
  const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const source = probe.archive.append(randomUUID(), '记住：备份前尚未领取的任务');
    console.log(JSON.stringify(probe.store.queueOwnerCapture(probe.activity, source)));
  } finally { probe.close(); }
} else if (action === 'unclaimed-historian') {
  const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const job = probe.store.listCaptureJobs(probe.activity, 32, true, 'historian').find(job => job.stage === 'pending');
    if (!job) throw new Error('pending-historian-required');
    console.log(JSON.stringify(job));
  } finally { probe.close(); }
} else if (action === 'claim-restored-job') {
  const binding = { ...bindingOf(sandbox), sessionId: randomUUID(), branchId: randomUUID() };
  createSandboxSession(sandbox, binding);
  const probe = openProbe(sandbox, undefined, undefined, binding, undefined, true);
  try {
    const job = probe.store.readCaptureJob(probe.activity, value!);
    const oldLease = probe.store.claimCaptureJob(probe.activity, value!, DEFAULT_BUDGET, 1000);
    const next = probe.store.queueOwnerCapture(probe.activity, probe.archive.append(randomUUID(), '记住：恢复后的新任务可以领取'));
    const newLease = probe.store.claimCaptureJob(probe.activity, next.jobId, DEFAULT_BUDGET, 1000);
    console.log(JSON.stringify({ binding, job, oldLease, newJobId: next.jobId, newLease, sends: probe.transport.count }));
  } finally { probe.close(); }
} else if (action === 'append-canonical') {
  const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const source = probe.archive.append(randomUUID(), 'Canonical append remains available while the projection is damaged.');
    console.log(JSON.stringify({ event: 'canonical-appended', source, health: probe.store.fence().health }));
  } finally { probe.close(); }
} else if (['seed-feedback','read-feedback','read-capture','read-intent'].includes(action!)) {
  const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    let result: unknown;
    if (action === 'seed-feedback') {
      const record = probe.store.readMemory(probe.activity, value!);
      const input = probe.archive.append(randomUUID(), JSON.stringify({ schema: 'memory-feedback@1', kind: 'user_helpful',
        recordId: record.recordId, revisionId: record.revisionId, headEventId: record.headEventId }));
      const feedback = probe.store.recordMemoryFeedback(probe.activity, record.recordId, record, input);
      result = { recordId: record.recordId, feedbackId: feedback.feedbackId, input };
    } else if (action === 'read-feedback') result = probe.store.readMemoryFeedback(probe.activity, value!);
    else if (action === 'read-capture') result = probe.store.readCaptureJob(probe.activity, value!);
    else result = probe.store.readIntent(probe.activity);
    console.log(JSON.stringify(result));
  } finally { probe.close(); }
} else if (action === 'repair-projection') {
  const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    if (value === 'memory') probe.store.rebuildSearchProjection(probe.activity);
    else if (value === 'source') probe.store.rebuildSourceProjection(probe.activity);
    else throw new Error('invalid-projection-lane');
    console.log(JSON.stringify({ event: 'projection-rebuilt', health: probe.store.fence().health }));
  } finally { probe.close(); }
} else if (action === 'overlapping-backups') {
  if (value) interruptSnapshotRemoval(value, path => path.startsWith(join(sandbox.root,'backup-')));
  const results = await Promise.all([backupSandbox(sandbox),backupSandbox(sandbox)]);
  console.log(JSON.stringify({ results }));
} else if (action === 'discard-recovery' || action === 'discard-snapshot' || action === 'discard-snapshot-crash') {
  const store = new ProbeStore(resourcesOf(sandbox), sandbox.storeId, bindingOf(sandbox)), coordinator = randomUUID();
  try {
    store.beginMaintenance(coordinator);
    if (!store.acquireMaintenance(coordinator).acquired) throw new Error('maintenance-residuals-or-participants');
    const snapshot = action !== 'discard-recovery';
    const manifest = snapshot ? store.snapshotCleanupManifest(coordinator, value!) : store.recoveryCleanupManifest(coordinator, value!);
    if (action === 'discard-snapshot-crash') interruptSnapshotRemoval(point!, path => path === manifest.directory.path);
    if (snapshot) store.discardSnapshot(coordinator, manifest); else store.discardRecoveryOriginal(coordinator, manifest);
    if (action === 'discard-snapshot-crash') throw new Error('expected-snapshot-cleanup-crash');
    store.releaseMaintenance(coordinator);
    console.log(JSON.stringify(manifest));
  } finally { store.close(); }
} else if (action === 'unknown') {
  const binding = { ...bindingOf(sandbox), sessionId: randomUUID(), branchId: randomUUID() };
  createSandboxSession(sandbox, binding);
  const jobId = randomUUID();
  const probe = openProbe(sandbox, undefined, { kind: 'job', id: jobId, authorizationId: jobId }, binding, undefined, true);
  try {
    const run = new ProbeSession(probe.store, probe.activity, { version: API_VERSION, binding, source: probe.archive, transport: probe.transport });
    const turn = run.prepare(randomUUID(), 'A post-snapshot synthetic request whose result is unknown.');
    const attempt = probe.store.startRequestAttempt(probe.activity, { runId: run.runId, assemblyId: turn.assemblyId,
      payloadHash: turn.payloadHash, byteLength: Buffer.byteLength(turn.payload), adapterVersion: API_VERSION });
    probe.transport.send(turn.payload, attempt);
    console.log(JSON.stringify({ jobId, sessionId: binding.sessionId, runId: run.runId, attemptId: attempt.attemptId }));
  } finally { probe.store.close(); }
} else if (action === 'backup-crash') {
  const mkdir = fs.mkdirSync;
  fs.mkdirSync = ((path: fs.PathLike, ...args: unknown[]) => {
    const result = Reflect.apply(mkdir, fs, [path, ...args]);
    if (/backup-[^/\\]+$/.test(String(path))) crash('backup-directory');
    return result;
  }) as typeof fs.mkdirSync;
  syncBuiltinESMExports();
  await backupSandbox(sandbox);
  throw new Error('expected-backup-crash');
} else if (action === 'backup-failure') {
  const write = fs.writeFileSync;
  fs.writeFileSync = ((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (String(path).includes('backup-')) throw Object.assign(new Error(value), { code: value });
    return Reflect.apply(write, fs, [path, ...args]);
  }) as typeof fs.writeFileSync;
  syncBuiltinESMExports();
  try { await backupSandbox(sandbox); throw new Error('expected-backup-failure'); }
  catch (error) { console.log(JSON.stringify({ event: 'backup-failed', reason: (error as NodeJS.ErrnoException).code })); }
} else if (action === 'restore-crash' || action === 'restore-failure') {
  const mkdir = fs.mkdirSync;
  fs.mkdirSync = ((path: fs.PathLike, ...args: unknown[]) => {
    const result = Reflect.apply(mkdir, fs, [path, ...args]);
    if (value === 'directory' && /recovery-[^/\\]+$/.test(String(path))) crash(value);
    return result;
  }) as typeof fs.mkdirSync;
  const write = fs.writeFileSync;
  fs.writeFileSync = ((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (action === 'restore-failure' && /recovery-[^/\\]+[/\\]store.sqlite$/.test(String(path))) {
      throw Object.assign(new Error(value), { code: value });
    }
    const result = Reflect.apply(write, fs, [path, ...args]);
    if (value === 'preparation' && /recovery-[^/\\]+[/\\]store.sqlite$/.test(String(path))) crash(value);
    return result;
  }) as typeof fs.writeFileSync;
  const open = fs.openSync, truncate = fs.ftruncateSync, files = new Map<number, string>();
  fs.openSync = ((path: fs.PathLike, ...args: unknown[]) => {
    const fd = Reflect.apply(open, fs, [path, ...args]) as number; files.set(fd, String(path)); return fd;
  }) as typeof fs.openSync;
  fs.ftruncateSync = (fd, length) => {
    truncate(fd, length);
    if (value === 'carrier' && files.get(fd) === join(sandbox.root, 'session.jsonl')) crash(value);
  };
  const exec = sqlite.DatabaseSync.prototype.exec;
  sqlite.DatabaseSync.prototype.exec = function(sql: string) {
    const result = exec.call(this, sql);
    if (value === 'database' && sql.includes('busy_timeout=2000') && sql.includes('journal_mode=WAL')) crash(value);
    return result;
  };
  syncBuiltinESMExports();
  const db = new sqlite.DatabaseSync(join(sandbox.root, 'probe.sqlite'), { readOnly: true });
  const id = String(db.prepare("SELECT snapshot_id FROM store_snapshots WHERE state='ready' ORDER BY created_at DESC LIMIT 1").get()!.snapshot_id);
  db.close();
  try { await restoreSandboxSnapshot(sandbox, id); throw new Error('expected-restore-failure'); }
  catch (error) {
    if (action !== 'restore-failure' || (error as NodeJS.ErrnoException).code !== value) throw error;
    console.log(JSON.stringify({ event: 'snapshot-failed', point: value }));
  }
}
