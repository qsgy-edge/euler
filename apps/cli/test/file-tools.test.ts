import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync, mkdirSync, renameSync, symlinkSync, linkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentRun, DEFAULT_BUDGET, fileIdentity } from '@euler/core';
import type { FileCapability, FileDecision, FilePresentation, ToolCall } from '@euler/core';
import { createFileToolHost } from '../src/file-tools.ts';
import { bindingOf, createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';
import { pumpAgent } from '../src/agent-pump.ts';
import type { AgentPump } from '../src/agent-pump.ts';

function fixture() {
  const sandbox = createSandbox();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'euler-file-project-')));
  const budget = { ...DEFAULT_BUDGET, contextLimit: 32000, maxTotalTokens: 128000, maxToolCalls: 8, maxModelAttempts: 3, toolTimeoutMs: 2000, wallClockMs: 30000 };
  const probe = openProbe(sandbox, budget);
  const binding = bindingOf(sandbox);
  const source = probe.archive.append(randomUUID(), 'Owner binds this disposable synthetic project resource root for controlled file operations; writes require separate per-call approval.', 'user');
  const capability: FileCapability = { schema: 'file-capability@1', grantId: randomUUID(), binding, root: { path: root, identity: fileIdentity(root) }, source };
  const run = new AgentRun(probe.store, probe.activity, { binding, source: probe.archive, files: capability },
    { provider: 'fake', model: 'test', route: 'fixture', authNamespace: 'none' }, budget);
  run.receive(sandbox.fixture.eventId, sandbox.fixture.text);
  return { sandbox, root, probe, run, capability, budget,
    close() { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); } };
}
function model(calls: ToolCall[]): Pick<AgentPump, 'stream' | 'execute'> {
  let count = 0;
  return { async *stream(request, _signal, send) {
    send(request.payload);
    yield { kind: 'complete', reply: ++count === 1 ? { text: '', stop: 'tools', calls } : { text: 'Done', stop: 'end', calls: [] } };
  }, async execute(call) { return String(call.arguments.text); } };
}
const windows = { skip: process.platform !== 'win32' };
test('permission revoked during approval is a known no-effect failure and sibling calls continue', windows, async () => {
  const f = fixture();
  let sid = '', denied = false;
  const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  try {
    sid = execFileSync(join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).match(/S-1-[\d-]+/)![0];
    writeFileSync(join(f.root, 'untouched.txt'), 'UNCHANGED');
    const status = await pumpAgent(f.run, { ...model([
      { id: 'write', name: 'file.write', arguments: { path: 'denied.txt', content: 'DENIED' } },
      { id: 'echo', name: 'controlled.echo', arguments: { text: 'CONTINUE' } },
    ]), ...createFileToolHost(async () => {
      execFileSync(join(system32, 'icacls.exe'), [f.root, '/deny', `*${sid}:(WD)`], { stdio: 'pipe' }); denied = true;
      return 'approved';
    }) });
    assert.equal(existsSync(join(f.root, 'denied.txt')), false);
    assert.equal(readFileSync(join(f.root, 'untouched.txt'), 'utf8'), 'UNCHANGED');
    assert.deepEqual(status.tools.map(tool => tool.result?.outcome), ['failure', 'success']);
    assert.equal(status.tools[0]!.result!.errorClass, 'file-create-denied');
    assert.equal(status.terminal, 'completed');
    assert.equal(f.probe.store.maintenanceStatus().controlledFiles[0]!.state, 'no_effect');
  } finally {
    if (denied) execFileSync(join(system32, 'icacls.exe'), [f.root, '/remove:d', `*${sid}`], { stdio: 'pipe' });
    f.close();
  }
});

test('model file calls read and write actual approved identities and archive results through Core', windows, async () => {
  const f = fixture();
  const presentations: FilePresentation[] = [];
  writeFileSync(join(f.root, 'existing.txt'), 'BEFORE');
  const originalIdentity = fileIdentity(join(f.root, 'existing.txt'));
  try {
    const status = await pumpAgent(f.run, { ...model([
      { id: 'read', name: 'file.read', arguments: { path: 'existing.txt' } },
      { id: 'write', name: 'file.write', arguments: { path: 'existing.txt', content: 'AFTER' } },
      { id: 'create', name: 'file.write', arguments: { path: 'new.txt', content: 'NEW' } },
      { id: 'echo', name: 'controlled.echo', arguments: { text: 'STILL WORKS' } },
    ]), ...createFileToolHost(async presentation => { presentations.push(presentation); return 'approved'; }) });
    assert.equal(status.terminal, 'completed');
    assert.equal(status.tools.length, 4);
    assert.deepEqual(status.tools.map(tool => [tool.callId, tool.result?.outcome]), [['read', 'success'], ['write', 'success'], ['create', 'success'], ['echo', 'success']], status.tools.map(tool => f.probe.archive.read(tool.result!.source).text).join('\n'));
    assert.equal(readFileSync(join(f.root, 'existing.txt'), 'utf8'), 'AFTER');
    assert.deepEqual(fileIdentity(join(f.root, 'existing.txt')), originalIdentity);
    assert.equal(readFileSync(join(f.root, 'new.txt'), 'utf8'), 'NEW');
    assert.equal(presentations.length, 2);
    assert.equal(presentations[0]!.content, 'AFTER');
    assert.equal(presentations[1]!.existingIdentity, null);
    assert.match(f.probe.archive.read(status.tools[0]!.result!.source).text, /BEFORE/);
    assert.deepEqual(status.tools[2]!.result!.file!.identity, fileIdentity(join(f.root, 'new.txt')));
    assert.equal(status.files[2]!.admission.cleanup, 'host-project-resource');
  } finally { f.close(); }
});

test('file tools have no authority without a bound capability even when supplied by a Host', async () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox, { ...DEFAULT_BUDGET, contextLimit: 20000, maxTotalTokens: 60000 });
  try {
    const run = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive },
      { provider: 'fake', model: 'test', route: 'fixture', authNamespace: 'none' }, { ...DEFAULT_BUDGET, contextLimit: 20000, maxTotalTokens: 60000 });
    run.receive(sandbox.fixture.eventId, sandbox.fixture.text);
    let opened = 0;
    const status = await pumpAgent(run, { ...model([{ id: 'file', name: 'file.read', arguments: { path: 'anything' } }]),
      async prepareFile() { opened++; throw new Error('must not open'); } });
    assert.equal(opened, 0);
    assert.equal(status.tools[0]!.result!.executionState, 'not_started');
    assert.equal(status.tools[0]!.result!.outcome, 'unavailable');
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('single decoding, Unicode, case and separators resolve to the same approved real file', windows, async () => {
  const f = fixture();
  mkdirSync(join(f.root, '目录'));
  const path = join(f.root, '目录', 'Café.txt');
  writeFileSync(path, 'UNICODE');
  try {
    const status = await pumpAgent(f.run, { ...model(['目录/Café.txt', '%E7%9B%AE%E5%BD%95/caf%C3%A9.TXT', './目录\\Café.txt']
      .map((path, index) => ({ id: `read${index}`, name: 'file.read', arguments: { path } }))), ...createFileToolHost(async () => 'unavailable') });
    assert.equal(status.terminal, 'completed');
    for (const tool of status.tools) {
      assert.equal(tool.result!.outcome, 'success');
      assert.deepEqual(tool.result!.file!.identity, fileIdentity(path));
      assert.equal(tool.result!.file!.text, 'UNICODE');
    }
  } finally { f.close(); }
});

test('ambiguous, encoded escape, drive, UNC, URL and device paths cause zero file operations', async () => {
  for (const paths of [
    ['../secret', '%252e%252e%252fsecret', '%2e%2e/secret', 'C:\\secret', '\\\\server\\share\\secret', 'https://example.test/a', 'NUL', 'x:stream'],
    ['bad%', 'name.', 'name ', 'a//b', '%00', '\\absolute', 'a/../../b', 'COM¹.txt'],
  ]) {
    const f = fixture();
    let opens = 0;
    try {
      const status = await pumpAgent(f.run, { ...model(paths.map((path, index) => ({ id: `bad${index}`, name: 'file.write', arguments: { path, content: 'DENIED' } }))),
        async prepareFile() { opens++; throw new Error('must-not-open'); } });
      assert.equal(opens, 0);
      assert.equal(status.tools.length, paths.length);
      assert.ok(status.tools.every(tool => tool.result?.executionState === 'not_started' && tool.result.outcome === 'unavailable'));
    } finally { f.close(); }
  }
});

test('junctions, symlinks and hardlinks cannot expose the canonical store or its WAL', windows, async () => {
  const f = fixture();
  symlinkSync(f.sandbox.root, join(f.root, 'store-junction'), 'junction');
  symlinkSync(join(f.sandbox.root, 'session.jsonl'), join(f.root, 'source-link'));
  writeFileSync(join(f.sandbox.root, 'protected-fixture.txt'), 'PROTECTED');
  linkSync(join(f.sandbox.root, 'protected-fixture.txt'), join(f.root, 'store-hardlink'));
  const before = readFileSync(join(f.sandbox.root, 'session.jsonl'));
  try {
    const status = await pumpAgent(f.run, { ...model(['store-junction/probe.sqlite', 'store-junction/probe.sqlite-wal', 'source-link', 'store-hardlink']
      .map((path, index) => ({ id: `link${index}`, name: 'file.read', arguments: { path } }))), ...createFileToolHost(async () => 'unavailable') });
    assert.ok(status.tools.every(tool => tool.result?.executionState === 'not_started' && tool.result.outcome === 'unavailable'));
    // New archive rows are ordinary Core records, not file-tool content mutations.
    assert.ok(readFileSync(join(f.sandbox.root, 'session.jsonl')).subarray(0, before.length).equals(before));
  } finally { rmSync(join(f.root, 'store-hardlink')); f.close(); }
});

test('replacement of the bound root before admission never writes through its replacement', windows, async () => {
  const f = fixture();
  const old = f.root + '-original';
  renameSync(f.root, old); mkdirSync(f.root);
  try {
    const status = await pumpAgent(f.run, { ...model([{ id: 'write', name: 'file.write', arguments: { path: 'new.txt', content: 'DENIED' } }]),
      ...createFileToolHost(async () => 'approved') });
    assert.equal(status.tools[0]!.result!.executionState, 'not_started');
    assert.equal(existsSync(join(f.root, 'new.txt')), false);
    assert.equal(existsSync(join(old, 'new.txt')), false);
  } finally { f.close(); rmSync(old, { recursive: true, force: true }); }
});

test('missing or rejected independent owner approval leaves existing and new targets unchanged', windows, async () => {
  for (const decision of ['rejected', 'unavailable'] as FileDecision[]) {
    const f = fixture();
    writeFileSync(join(f.root, 'existing.txt'), 'ORIGINAL');
    try {
      const status = await pumpAgent(f.run, { ...model([
        { id: 'write', name: 'file.write', arguments: { path: 'existing.txt', content: 'DENIED' } },
        { id: 'create', name: 'file.write', arguments: { path: 'new.txt', content: 'DENIED' } },
      ]), ...createFileToolHost(async () => decision) });
      assert.equal(readFileSync(join(f.root, 'existing.txt'), 'utf8'), 'ORIGINAL');
      assert.equal(existsSync(join(f.root, 'new.txt')), false);
      assert.ok(status.tools.every(tool => tool.result?.executionState === 'not_started'));
    } finally { f.close(); }
  }
});

test('cancellation while the owner decides records not_started and creates no file', windows, async () => {
  const f = fixture();
  try {
    const status = await pumpAgent(f.run, { ...model([{ id: 'write', name: 'file.write', arguments: { path: 'new.txt', content: 'DENIED' } }]),
      ...createFileToolHost(async () => { f.run.cancel(); return 'approved'; }) });
    assert.equal(status.terminal, 'cancelled');
    assert.equal(status.tools[0]!.result!.executionState, 'not_started');
    assert.equal(existsSync(join(f.root, 'new.txt')), false);
  } finally { f.close(); }
});

test('late completed file I/O only reconciles its unknown record and never starts the next call', windows, async () => {
  const f = fixture();
  const native = createFileToolHost(async () => 'approved');
  try {
    const status = await pumpAgent(f.run, { ...model([
      { id: 'write', name: 'file.write', arguments: { path: 'new.txt', content: 'KNOWN LATE' } },
      { id: 'next', name: 'file.write', arguments: { path: 'forbidden.txt', content: 'DENIED' } },
    ]), ...native, async prepareFile(call, capability, signal) {
      const file = await native.prepareFile!(call, capability, signal);
      return { ...file, async execute() { const receipt = await file.execute(); f.run.cancel(); return receipt; } };
    } });
    assert.equal(status.terminal, 'cancelled');
    assert.equal(status.tools[0]!.result!.outcome, 'unknown');
    assert.equal(status.tools[0]!.result!.executionState, 'started');
    assert.equal(status.tools[1]!.result!.executionState, 'not_started');
    assert.equal(readFileSync(join(f.root, 'new.txt'), 'utf8'), 'KNOWN LATE');
    assert.equal(existsSync(join(f.root, 'forbidden.txt')), false);
    assert.deepEqual(f.run.status().files[0]!.reconciled!.identity, fileIdentity(join(f.root, 'new.txt')));
    assert.equal(f.probe.store.maintenanceStatus().controlledFiles[0]!.state, 'recorded');
  } finally { f.close(); }
});

test('post-start lost completion remains unknown, retains cleanup responsibility after reopen, and blocks automatic recovery', windows, async () => {
  const f = fixture();
  const native = createFileToolHost(async () => 'approved');
  try {
    const status = await pumpAgent(f.run, { ...model([{ id: 'write', name: 'file.write', arguments: { path: 'new.txt', content: 'POSSIBLE EFFECT' } }]),
      ...native, async prepareFile(call, capability, signal) {
        const file = await native.prepareFile!(call, capability, signal);
        return { ...file, async execute() { await file.execute(); throw new Error('lost-completion'); } };
      } });
    assert.equal(status.terminal, 'blocked-unknown');
    assert.equal(status.tools[0]!.result!.outcome, 'unknown');
    assert.equal(readFileSync(join(f.root, 'new.txt'), 'utf8'), 'POSSIBLE EFFECT');
    const reopened = openProbe(f.sandbox, f.budget, undefined, undefined, undefined, true);
    try {
      const copy = reopened.store.maintenanceStatus().controlledFiles[0]!;
      assert.equal(copy.path, join(f.root, 'new.txt'));
      assert.equal(copy.state, 'unknown');
      assert.equal(copy.ownerId, f.capability.binding.ownerId);
      assert.throws(() => new AgentRun(reopened.store, reopened.activity, { binding: f.capability.binding, source: reopened.archive },
        { provider: 'fake', model: 'test', route: 'fixture', authNamespace: 'none' }, f.budget), /request-recovery-required/);
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test('forged presentation and stale intent cannot authorize a pending file mutation', windows, async () => {
  for (const scenario of ['forged', 'stale']) {
    const f = fixture();
    try {
      const status = await pumpAgent(f.run, { ...model([{ id: 'write', name: 'file.write', arguments: { path: 'new.txt', content: 'DENIED' } }]),
        ...createFileToolHost(async presentation => {
          if (scenario === 'forged') presentation.token = randomUUID();
          else {
            const intent = f.probe.store.readIntent(f.probe.activity)!;
            const input = f.probe.archive.append(randomUUID(), 'Owner pauses file work', 'user');
            f.probe.store.transitionIntent(f.probe.activity, intent.eventId, input, { status: 'paused', step: 'paused by owner' });
          }
          return 'approved';
        }) });
      assert.equal(status.tools[0]!.result!.executionState, 'not_started');
      assert.equal(existsSync(join(f.root, 'new.txt')), false);
    } finally { f.close(); }
  }
});

test('wrong owner and roots overlapping the product data boundary are rejected before admission', () => {
  const f = fixture();
  try {
    for (const capability of [
      { ...f.capability, binding: { ...f.capability.binding, ownerId: randomUUID() } },
      { ...f.capability, root: { path: f.sandbox.root, identity: fileIdentity(f.sandbox.root) } },
      { ...f.capability, root: { path: join(f.sandbox.root, '..inner'), identity: f.capability.root.identity } },
      { ...f.capability, root: { path: join(f.sandbox.root, 'inner'), identity: f.capability.root.identity } },
    ]) assert.throws(() => new AgentRun(f.probe.store, f.probe.activity, { binding: bindingOf(f.sandbox), source: f.probe.archive, files: capability },
      { provider: 'fake', model: 'test', route: 'fixture', authNamespace: 'none' }, f.budget), /file-owner-mismatch|file-product-root-overlap/);
  } finally { f.close(); }
});

test('a parent path alias cannot smuggle the product root through a capability', windows, async () => {
  const f = fixture();
  const alias = f.root + '-alias';
  symlinkSync(join(f.sandbox.root, '..'), alias, 'junction');
  const { basename } = await import('node:path');
  const disguised = join(alias, basename(f.sandbox.root));
  f.run.cancel();
  try {
    const run = new AgentRun(f.probe.store, f.probe.activity, { binding: bindingOf(f.sandbox), source: f.probe.archive,
      files: { ...f.capability, root: { path: disguised, identity: fileIdentity(f.sandbox.root) } } },
      { provider: 'fake', model: 'test', route: 'fixture', authNamespace: 'none' }, f.budget);
    run.receive(randomUUID(), 'Synthetic alias rejection');
    const status = await pumpAgent(run, { ...model([{ id: 'read', name: 'file.read', arguments: { path: 'probe.sqlite' } }]),
      ...createFileToolHost(async () => 'unavailable') });
    assert.equal(status.tools[0]!.result!.executionState, 'not_started');
  } finally { rmSync(alias); f.close(); }
});

test('a fence change during the owner prompt prevents admission and records no started copy', windows, async () => {
  const f = fixture();
  const coordinator = randomUUID();
  try {
    await assert.rejects(pumpAgent(f.run, { ...model([{ id: 'write', name: 'file.write', arguments: { path: 'new.txt', content: 'DENIED' } }]),
      ...createFileToolHost(async () => { f.probe.store.beginMaintenance(coordinator); return 'approved'; }) }), /admission-closed/);
    assert.equal(existsSync(join(f.root, 'new.txt')), false);
    assert.equal(f.probe.store.maintenanceStatus().controlledFiles[0]!.started, false);
    f.probe.store.cancelMaintenance(coordinator);
  } finally { f.close(); }
});

test('a file created by another writer during approval is never overwritten by the approved create', windows, async () => {
  const f = fixture();
  try {
    const status = await pumpAgent(f.run, { ...model([{ id: 'write', name: 'file.write', arguments: { path: 'new.txt', content: 'DENIED' } }]),
      ...createFileToolHost(async () => { writeFileSync(join(f.root, 'new.txt'), 'OTHER WRITER'); return 'approved'; }) });
    assert.equal(readFileSync(join(f.root, 'new.txt'), 'utf8'), 'OTHER WRITER');
    assert.equal(status.tools[0]!.result!.outcome, 'failure');
    assert.equal(status.terminal, 'completed');
    assert.equal(f.probe.store.maintenanceStatus().controlledFiles[0]!.state, 'no_effect');
  } finally { f.close(); }
});

test('oversized and invalid UTF-8 reads are ordinary failures and the next admitted call still executes', windows, async () => {
  const f = fixture();
  writeFileSync(join(f.root, 'large.txt'), Buffer.alloc(4097, 65));
  writeFileSync(join(f.root, 'invalid.txt'), Buffer.from([0xff, 0xfe]));
  try {
    const status = await pumpAgent(f.run, { ...model([
      { id: 'large', name: 'file.read', arguments: { path: 'large.txt' } },
      { id: 'invalid', name: 'file.read', arguments: { path: 'invalid.txt' } },
      { id: 'echo', name: 'controlled.echo', arguments: { text: 'CONTINUE' } },
    ]), ...createFileToolHost(async () => 'unavailable') });
    assert.equal(status.terminal, 'completed');
    assert.deepEqual(status.tools.map(tool => tool.result?.outcome), ['failure', 'failure', 'success']);
    assert.deepEqual(status.tools.slice(0, 2).map(tool => tool.result?.errorClass), ['file-output-too-large', 'file-invalid-utf8']);
  } finally { f.close(); }
});

test('negative path calls through the real Windows Host leave protected resources untouched', windows, async () => {
  const f = fixture();
  const protectedPath = join(f.sandbox.root, 'protected-fixture.txt');
  writeFileSync(protectedPath, 'PROTECTED');
  writeFileSync(join(f.root, 'inside.txt'), 'INSIDE');
  let approvals = 0;
  const { basename } = await import('node:path');
  const traversal = `../${basename(f.sandbox.root)}/protected-fixture.txt`;
  try {
    const status = await pumpAgent(f.run, { ...model([
      traversal, encodeURIComponent(traversal), encodeURIComponent(encodeURIComponent(traversal)), protectedPath,
      '\\\\localhost\\C$\\protected-fixture.txt', 'file:///C:/protected-fixture.txt', 'inside.txt:stream', 'inside.txt.',
    ].map((path, index) => ({ id: `denied${index}`, name: 'file.write', arguments: { path, content: 'DENIED' } }))),
    ...createFileToolHost(async () => { approvals++; return 'approved'; }) });
    assert.ok(status.tools.every(tool => tool.result?.executionState === 'not_started'));
    assert.equal(approvals, 0);
    assert.equal(readFileSync(protectedPath, 'utf8'), 'PROTECTED');
    assert.equal(readFileSync(join(f.root, 'inside.txt'), 'utf8'), 'INSIDE');
  } finally { f.close(); }
});

test('composed and decomposed Unicode paths retain distinct actual NTFS identities', windows, async () => {
  const f = fixture();
  const composed = 'Caf\u00e9.txt', decomposed = 'Cafe\u0301.txt';
  writeFileSync(join(f.root, composed), 'COMPOSED');
  writeFileSync(join(f.root, decomposed), 'DECOMPOSED');
  try {
    const status = await pumpAgent(f.run, { ...model([composed, encodeURIComponent(decomposed)].map((path, index) =>
      ({ id: `read${index}`, name: 'file.read', arguments: { path } }))), ...createFileToolHost(async () => 'unavailable') });
    assert.deepEqual(status.tools.map(tool => tool.result?.file?.text), ['COMPOSED', 'DECOMPOSED']);
    assert.notDeepEqual(status.tools[0]!.result!.file!.identity, status.tools[1]!.result!.file!.identity);
  } finally { f.close(); }
});

test('a receipt arriving after pump return and Host store teardown preserves unknown without a follow-on call', windows, async () => {
  const f = fixture();
  const native = createFileToolHost(async () => 'approved');
  let allowReceipt!: () => void, ioReady!: () => void, handlesClosed!: () => void;
  const delay = new Promise<void>(resolve => { allowReceipt = resolve; });
  const ready = new Promise<void>(resolve => { ioReady = resolve; });
  const closed = new Promise<void>(resolve => { handlesClosed = resolve; });
  let storeClosed = false;
  const pumping = pumpAgent(f.run, { ...model([
    { id: 'write', name: 'file.write', arguments: { path: 'late.txt', content: 'ACTUAL EFFECT' } },
    { id: 'next', name: 'file.write', arguments: { path: 'next.txt', content: 'DENIED' } },
  ]), ...native, async prepareFile(call, capability, signal) {
    const file = await native.prepareFile!(call, capability, signal);
    return { ...file,
      async execute() { const receipt = await file.execute(); ioReady(); await delay; return receipt; },
      close() { file.close(); handlesClosed(); },
    };
  } });
  try {
    await Promise.race([ready, pumping.then(() => { throw new Error('pump-ended-before-io'); })]);
    f.run.cancel();
    const status = await pumping;
    assert.equal(status.tools[0]!.result!.outcome, 'unknown');
    assert.equal(status.tools[1]!.result!.executionState, 'not_started');
    const before = f.probe.store.requestStatus(f.probe.activity, f.run.runId).events.length;
    f.probe.close(); storeClosed = true;
    allowReceipt(); await closed;
    const reopened = openProbe(f.sandbox, f.budget, undefined, undefined, undefined, true);
    try {
      const after = reopened.store.requestStatus(reopened.activity, f.run.runId);
      assert.equal(after.events.length, before);
      assert.equal(reopened.store.maintenanceStatus().controlledFiles[0]!.state, 'unknown');
      assert.equal(readFileSync(join(f.root, 'late.txt'), 'utf8'), 'ACTUAL EFFECT');
      assert.equal(existsSync(join(f.root, 'next.txt')), false);
    } finally { reopened.close(); }
  } finally {
    allowReceipt(); await pumping;
    if (!storeClosed) f.probe.close();
    rmSync(f.root, { recursive: true, force: true }); rmSync(f.sandbox.root, { recursive: true, force: true });
  }
});
