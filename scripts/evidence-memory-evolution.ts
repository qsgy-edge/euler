import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform, release, arch } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { MemoryRecord, SourceAck } from '@euler/core';
import fixture from '../fixtures/t14-memory-evolution-cases.json' with { type: 'json' };
import { createSandbox } from '../apps/cli/src/sandbox.ts';

const repo = fileURLToPath(new URL('../', import.meta.url));
const startedAt = new Date().toISOString(), destination = join(repo, 'artifacts', `t14-${startedAt.replace(/[:.]/g, '-')}`);
mkdirSync(destination, { recursive: true });
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const pathOf = (path: string) => relative(destination, path).replaceAll('\\', '/');
const checks: { id: string; passed: boolean; diagnostic?: string }[] = [];
const commands: { id: string; command: string[]; startedAt: string; endedAt: string; exitCode: number | null; signal: string | null; stdout: string; stderr: string }[] = [];
const roots: { id: string; original: string; snapshot: string }[] = [];
const actualOutput: string[] = [];
function save(path: string, bytes: string | Buffer) { const target = join(destination, path); mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, bytes); return path; }
function verify(id: string, action: () => void) {
  try { action(); checks.push({ id, passed: true }); }
  catch (error) { checks.push({ id, passed: false, diagnostic: save(`${id}/diagnostic.txt`, error instanceof Error ? error.stack ?? error.message : String(error)) }); }
}
function archive(path: string) {
  const bytes = readFileSync(path, 'utf8'); assert.ok(bytes.endsWith('\n'));
  const lines = bytes.slice(0, -1).split('\n'), header = JSON.parse(lines.shift()!);
  assert.equal(header.schema, 'cli-session@1');
  const events = lines.map(line => {
    const event = JSON.parse(line); assert.equal(line, JSON.stringify(event)); assert.equal(event.schema, 'cli-input@1');
    const ref: SourceAck = { schema: 'cli-source-ack@1', status: 'durable', binding: header.binding, eventId: event.eventId,
      locator: `cli-jsonl@1/${header.binding.sessionId}/${event.eventId}`, hash: digest(line), byteLength: Buffer.byteLength(line), contentHash: digest(event.text) };
    return { ref, role: event.role as string, text: event.text as string };
  });
  assert.equal(new Set(events.map(event => event.ref.eventId)).size, events.length);
  return { header, events };
}
function validate(root: string, entry: typeof fixture.cases[number], output: string) {
  const db = new DatabaseSync(join(root, 'probe.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA quick_check').get()!.quick_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 17);
    const archives = readdirSync(root).filter(name => name.endsWith('.jsonl') && JSON.parse(readFileSync(join(root, name), 'utf8').split('\n')[0]!).schema === 'cli-session@1')
      .map(name => archive(join(root, name)));
    const before = existsSync(join(output, 'source-before.jsonl')) ? archive(join(output, 'source-before.jsonl')) : null;
    const currentEvents = archives.flatMap(item => item.events), historical = before?.events ?? [];
    const source = (ref: SourceAck, allowHistorical = true) => {
      const event = [...currentEvents, ...(allowHistorical ? historical : [])].find(item => JSON.stringify(item.ref) === JSON.stringify(ref));
      assert.ok(event, 'source-ref-does-not-match-archived-bytes'); return event;
    };
    const revisions = db.prepare('SELECT * FROM memory_revisions').all();
    for (const revision of revisions) { assert.equal(digest(String(revision.content)), revision.content_hash); source(JSON.parse(String(revision.source_json))); }
    const events = db.prepare('SELECT * FROM memory_events ORDER BY record_id,seq').all();
    const previous = new Map<string, string>();
    for (const event of events) {
      assert.equal(digest(String(event.payload)), event.payload_hash);
      const value = JSON.parse(String(event.payload));
      assert.equal(value.schema, 'memory-event@1'); assert.equal(value.eventId, event.event_id); assert.equal(value.kind, event.kind);
      assert.equal(event.before_snapshot, previous.get(String(event.record_id)) ?? null);
      assert.equal(value.before === null ? null : JSON.stringify(value.before), event.before_snapshot);
      assert.equal(JSON.stringify(value.after), event.after_snapshot); assert.equal(value.after.headEventId, event.event_id);
      const revision = revisions.find(row => row.revision_id === value.after.revisionId)!;
      assert.ok(revision); assert.equal(value.after.contentHash, revision.content_hash); assert.equal(value.after.content, revision.content);
      if (value.source?.schema === 'cli-source-ack@1') source(value.source);
      if (value.input?.schema === 'memory-comparison@1') {
        const { key, ...input } = value.input; assert.equal(key, digest(JSON.stringify(input)));
        for (const record of [input.candidate, input.peer]) {
          const original = db.prepare('SELECT after_snapshot FROM memory_events WHERE event_id=? AND record_id=?').get(record.headEventId, record.recordId)!;
          const { hash, ...snapshot } = record; assert.equal(original.after_snapshot, JSON.stringify(snapshot)); assert.equal(hash, digest(String(original.after_snapshot)));
        }
      }
      previous.set(String(event.record_id), String(event.after_snapshot));
    }
    const heads = db.prepare('SELECT * FROM memory_heads').all().map(row => {
      assert.equal(row.snapshot, previous.get(String(row.record_id))); assert.equal(digest(String(row.snapshot)), row.snapshot_hash);
      const record = JSON.parse(String(row.snapshot)) as MemoryRecord;
      assert.equal(record.lifecycle, row.lifecycle); assert.equal(record.verification, row.verification); assert.equal(record.headEventId, row.head_event_id);
      if (record.lifecycle === 'active' && record.verification === 'verified') source(record.source, false);
      return record;
    });
    for (const verification of db.prepare('SELECT * FROM verification_runs').all()) {
      assert.equal(digest(String(verification.evidence_json)), verification.evidence_hash);
      for (const ref of JSON.parse(String(verification.evidence_json))) source(ref);
    }
    for (const [key, count] of Object.entries({
      active: heads.filter(record => record.lifecycle === 'active' && record.verification === 'verified').length,
      rejected: heads.filter(record => record.lifecycle === 'rejected').length, stale: heads.filter(record => record.verification === 'stale').length,
      conflicted: heads.filter(record => record.verification === 'conflicted').length, superseded: heads.filter(record => record.lifecycle === 'superseded').length,
    })) assert.equal(count, entry[key as keyof typeof entry], key);
    const batches = db.prepare('SELECT * FROM activation_batches').all(); assert.equal(batches.length, entry.batches);
    const infoText = readFileSync(join(root, 'owner-info.jsonl'), 'utf8'); assert.ok(infoText.endsWith('\n'));
    const infoLines = infoText.slice(0, -1).split('\n'); assert.equal(JSON.parse(infoLines.shift()!).schema, 'owner-info@1');
    assert.equal(infoLines.length, batches.length);
    for (const batch of batches) {
      assert.equal(digest(String(batch.payload)), batch.payload_hash);
      const manifest = JSON.parse(String(batch.payload)), members = events.filter(event => event.batch_id === batch.batch_id).sort((a,b) => Number(a.batch_ordinal) - Number(b.batch_ordinal));
      assert.deepEqual(manifest.events, members.map(event => JSON.parse(String(event.payload)))); assert.equal(members.length, batch.member_count);
      assert.equal(new Set(members.map(event => event.record_id)).size, members.length);
      const job = db.prepare("SELECT * FROM projection_jobs WHERE kind='host-info' AND batch_id=?").get(String(batch.batch_id))!;
      assert.equal(digest(String(job.payload)), job.payload_hash); assert.deepEqual(JSON.parse(String(job.payload)).events, manifest.events);
      const info = db.prepare('SELECT * FROM host_info_batches WHERE batch_id=?').get(String(batch.batch_id))!;
      assert.equal(info.delivery, 'delivered'); assert.equal(info.read_state, 'unread');
      const line = infoLines.find(line => JSON.parse(line).batchId === batch.batch_id)!;
      assert.equal(info.entry_hash, digest(line)); assert.equal(info.entry_id, JSON.parse(line).entryId);
      assert.equal(JSON.parse(line).payload, batch.payload); assert.equal(JSON.parse(line).digest, batch.payload_hash);
    }
    const assemblies = db.prepare('SELECT * FROM request_assemblies').all(), attempts = db.prepare('SELECT * FROM request_attempts').all();
    const requestEvents = db.prepare('SELECT * FROM request_events').all();
    for (const event of requestEvents) assert.equal(digest(String(event.payload)), event.hash);
    for (const assembly of assemblies) {
      const event = requestEvents.find(event => event.kind === 'context/assembly@v1' && JSON.parse(String(event.payload)).assemblyId === assembly.assembly_id)!;
      assert.ok(event); const manifest = JSON.parse(String(event.payload));
      assert.equal(manifest.payloadHash, assembly.payload_hash); assert.equal(manifest.runId, assembly.run_id);
      assert.deepEqual(manifest.usedMemories, JSON.parse(String(assembly.used_memories)));
      const refs = JSON.parse(String(assembly.sources)) as SourceAck[];
      refs.forEach(ref => source(ref));
      assert.deepEqual(manifest.sources, refs.map(ref => ({ eventId: ref.eventId, hash: ref.hash })));
    }
    const receiver = readFileSync(join(root, 'counting-receiver.jsonl'), 'utf8').trimEnd().split('\n');
    assert.equal(JSON.parse(receiver.shift()!).schema, 'counting-receiver@1');
    assert.equal(new Set(receiver.map(line => JSON.parse(line).record.attemptId)).size, receiver.length);
    for (const line of receiver) {
      const received = JSON.parse(line); assert.equal(received.hash, digest(JSON.stringify(received.record)));
      const attempt = attempts.find(row => row.attempt_id === received.record.attemptId)!; assert.ok(attempt);
      assert.equal(attempt.outcome, 'received'); assert.equal(attempt.run_id, received.record.runId); assert.equal(attempt.payload_hash, received.record.payloadHash);
      const assembly = assemblies.find(row => row.assembly_id === attempt.assembly_id)!;
      const payload = currentEvents.find(event => digest(event.text) === assembly.payload_hash)?.text; assert.ok(payload);
      assert.equal(Buffer.byteLength(payload), assembly.byte_length); assert.equal(received.record.byteLength, assembly.byte_length);
    }
    assert.equal(receiver.length, attempts.filter(attempt => attempt.outcome === 'received').length);
    for (const assembly of assemblies) for (const use of JSON.parse(String(assembly.used_memories))) {
      const row = events.find(event => event.event_id === use.headEventId && event.record_id === use.recordId)!; assert.ok(row);
      assert.equal(digest(String(row.after_snapshot)), use.hash);
      const record = JSON.parse(String(row.after_snapshot)); assert.equal(record.lifecycle, 'active'); assert.equal(record.verification, 'verified');
      assert.equal(record.revisionId, use.revisionId); assert.equal(record.contentHash, use.contentHash);
      const payload = currentEvents.find(event => digest(event.text) === assembly.payload_hash)?.text;
      if (payload) assert.ok(JSON.parse(payload).memories.some((memory: { recordId: string; revisionId: string; content: string }) =>
        memory.recordId === use.recordId && memory.revisionId === use.revisionId && memory.content === record.content));
    }
    for (const feedback of db.prepare('SELECT * FROM feedback_events').all()) {
      assert.equal(digest(String(feedback.payload)), feedback.payload_hash);
      const value = JSON.parse(String(feedback.payload)); assert.equal(value.feedbackId, feedback.feedback_id);
      if (value.evidence.source) source(value.evidence.source);
      if (feedback.kind === 'task_outcome') {
        const event = db.prepare('SELECT payload,hash FROM request_events WHERE event_id=?').get(value.evidence.eventId)!;
        assert.equal(event.hash, digest(String(event.payload))); assert.equal(event.hash, value.evidence.eventHash);
        assert.equal(JSON.parse(String(event.payload)).event.terminal, value.evidence.terminal);
      }
      if (feedback.kind === 'negative_transfer') {
        const owner = source(value.evidence.source); assert.equal(owner.role, 'user');
        const approval = JSON.parse(owner.text); assert.equal(approval.kind, 'negative_transfer'); assert.equal(approval.pairs.length, 2);
        assert.equal(approval.recordId, feedback.record_id); assert.equal(approval.revisionId, feedback.revision_id); assert.equal(approval.headEventId, feedback.head_event_id);
        const caseHashes = new Set<string>();
        for (const pair of value.evidence.pairs) {
          const beforeBytes = source(pair.baselinePayload).text, afterBytes = source(pair.treatmentPayload).text;
          const beforeAssembly = assemblies.find(row => row.assembly_id === pair.baselineAssemblyId)!;
          const afterAssembly = assemblies.find(row => row.assembly_id === pair.treatmentAssemblyId)!;
          assert.equal(digest(beforeBytes), beforeAssembly.payload_hash); assert.equal(digest(afterBytes), afterAssembly.payload_hash);
          assert.equal(beforeAssembly.run_id, pair.baselineRunId); assert.equal(afterAssembly.run_id, pair.treatmentRunId);
          const declared = approval.pairs.find((item: { baselineRunId: string; treatmentRunId: string }) => item.baselineRunId === pair.baselineRunId && item.treatmentRunId === pair.treatmentRunId);
          assert.ok(declared); assert.equal(declared.expectedResponseHash, pair.expectedResponseHash);
          const input = source(JSON.parse(String(beforeAssembly.sources))[0]); assert.equal(input.role, 'user');
          const canary = JSON.parse(input.text); assert.equal(canary.schema, 'memory-canary-case@1');
          assert.equal(digest(canary.expectedText), pair.expectedResponseHash);
          const beforeBody = JSON.parse(beforeBytes), afterBody = JSON.parse(afterBytes);
          assert.equal(beforeBody.memories, undefined); assert.equal(afterBody.memories.length, 1);
          assert.equal(afterBody.memories[0].recordId, feedback.record_id); assert.equal(afterBody.memories[0].revisionId, feedback.revision_id);
          delete beforeBody.memories; delete afterBody.memories; assert.deepEqual(beforeBody, afterBody);
          assert.equal(digest(JSON.stringify(beforeBody)), pair.caseHash); caseHashes.add(pair.caseHash);
          for (const id of [pair.baselineRunId, pair.treatmentRunId]) {
            const event = db.prepare("SELECT payload,hash FROM request_events WHERE run_id=? AND kind='agent/event@v1' AND json_extract(payload,'$.event.kind')='terminal'").get(id)!;
            assert.equal(digest(String(event.payload)), event.hash); assert.equal(JSON.parse(String(event.payload)).event.terminal, 'completed');
            const response = db.prepare("SELECT payload,hash FROM request_events WHERE run_id=? AND kind='agent/event@v1' AND json_extract(payload,'$.event.kind')='response'").get(id)!;
            assert.equal(digest(String(response.payload)), response.hash);
            const ref = JSON.parse(String(response.payload)).event.source;
            assert.deepEqual(ref, id === pair.baselineRunId ? pair.baselineResponse : pair.treatmentResponse);
            const rawReply = source(ref); assert.equal(rawReply.role, 'assistant');
            const reply = JSON.parse(rawReply.text); assert.equal(reply.stop, 'end'); assert.deepEqual(reply.calls, []);
            const hash = digest(reply.text);
            assert.equal(hash, id === pair.baselineRunId ? pair.baselineResponseHash : pair.treatmentResponseHash);
            if (id === pair.baselineRunId) assert.equal(hash, pair.expectedResponseHash); else assert.notEqual(hash, pair.expectedResponseHash);
          }
          assert.equal(pair.baselineResult, 'pass'); assert.equal(pair.treatmentResult, 'fail');
        }
        assert.equal(caseHashes.size, 2);
        assert.ok(events.some(event => event.kind === 'reject' && JSON.parse(String(event.payload)).reason === 'negative_transfer'
          && JSON.parse(String(event.after_snapshot)).verification === 'verified'));
      }
    }
    if (entry.id === 'expiry') {
      const stale = events.find(event => event.kind === 'stale')!; assert.equal(JSON.parse(String(stale.payload)).reason, 'expired');
      assert.ok(Date.parse(String(stale.created_at)) >= Date.parse(heads[0]!.validUntil!));
    }
    if (entry.id === 'negative-restore') { assert.equal(heads[0]!.revision, 1); assert.ok(events.some(event => event.kind === 'rollback' && event.batch_id)); }
    if (entry.id === 'negative-previous-lost') { assert.ok(before); assert.equal(existsSync(join(root, 'session.jsonl')), false); assert.ok(!events.some(event => event.kind === 'rollback')); }
    if (entry.id === 'source-invalidated') { assert.ok(before); assert.notDeepEqual(archives.find(item => item.header.binding.sessionId === before.header.binding.sessionId)!.events, before.events); }
    if (entry.id === 'transport-comparison') { assert.equal(attempts.length, 14); assert.equal(receiver.length, 14); }
    if (entry.id === 'transport-budget') {
      assert.equal(heads.filter(record => record.lifecycle === 'candidate').length, 1);
      assert.equal(db.prepare("SELECT count(*) AS n FROM capture_work WHERE stage='blocked' AND reason='capture-budget-exhausted'").get()!.n, 1);
      assert.equal(db.prepare("SELECT count(*) AS n FROM request_runs WHERE state!='sealed'").get()!.n, 0);
      assert.ok(attempts.length > 4 && attempts.length < 14);
    }
    if (entry.id === 'coexist' || entry.id === 'transport-comparison') assert.deepEqual(heads.map(record => record.appliesTo).sort(), [['platform:linux'], ['platform:win32']]);
  } finally { db.close(); }
}

save('fixture.json', readFileSync(join(repo, 'fixtures/t14-memory-evolution-cases.json')));
for (const entry of fixture.cases) {
  const sandbox = createSandbox(), output = join(destination, entry.id); mkdirSync(output, { recursive: true });
  try {
    const args = ['scripts/memory-evolution-worker.ts', sandbox.root, entry.id, output], start = new Date().toISOString();
    const child = spawnSync(process.execPath, args, { cwd: repo, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    const stdout = child.stdout ?? '', stderr = child.stderr ?? ''; actualOutput.push(stdout);
    commands.push({ id: entry.id, command: [process.execPath, ...args], startedAt: start, endedAt: new Date().toISOString(), exitCode: child.status, signal: child.signal,
      stdout: save(`${entry.id}/stdout.txt`, stdout), stderr: save(`${entry.id}/stderr.txt`, stderr) });
    verify(entry.id, () => { assert.equal(child.error, undefined); assert.equal(child.status, 0, stderr); validate(sandbox.root, entry, output); });
  } finally {
    const snapshot = join(output, 'sandbox'); cpSync(sandbox.root, snapshot, { recursive: true, force: false, errorOnExist: true });
    roots.push({ id: entry.id, original: sandbox.root, snapshot: pathOf(snapshot) });
  }
}
save('console-output.txt', actualOutput.join(''));
const artifacts: { path: string; bytes: number; sha256: string }[] = [];
function inventory(path: string) { for (const entry of readdirSync(path, { withFileTypes: true })) { const target = join(path, entry.name);
  if (entry.isDirectory()) inventory(target); else { const bytes = readFileSync(target); artifacts.push({ path: pathOf(target), bytes: bytes.length, sha256: digest(bytes) }); } } }
inventory(destination);
const implementationFiles = ['packages/core/src/store/probe-store.ts','packages/core/src/context/capture-run.ts','apps/cli/src/capture.ts',
  'apps/cli/src/agent-pump.ts','apps/cli/src/owner-memory.ts','scripts/memory-evolution-worker.ts','scripts/evidence-memory-evolution.ts',
  'apps/cli/test/support/memory-evolution.ts','fixtures/t14-memory-evolution-cases.json'];
const passed = checks.length === fixture.cases.length && checks.every(check => check.passed);
const receipt = { schema: 'memory-evolution-evidence@1', startedAt, endedAt: new Date().toISOString(), result: passed ? 'evidence-gap' : 'failed',
  syntheticPassed: passed, environment: { platform: platform(), release: release(), arch: arch(), node: process.version },
  commit: execFileSync('git', ['rev-parse','HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  dirty: execFileSync('git', ['status','--porcelain'], { cwd: repo, encoding: 'utf8' }).trim().length > 0,
  implementationFiles: implementationFiles.map(path => ({ path, sha256: digest(readFileSync(join(repo, path))) })),
  fixtureDigest: digest(readFileSync(join(repo, 'fixtures/t14-memory-evolution-cases.json'))), commands, roots, checks, artifacts,
  gaps: ['actual-provider-semantic-quality','other-platforms-require-their-own-receipts','non-cli-host-integration','production-backup-purge-and-torn-archive-fault-closure'] };
save('receipt.json', JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ evidence: destination, result: receipt.result, syntheticPassed: passed, checks: checks.length }));
if (!passed) process.exitCode = 1;
