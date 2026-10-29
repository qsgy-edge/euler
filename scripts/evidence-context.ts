import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { arch, release } from 'node:os';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const args = parseArgs({ options: { 'transport-config': { type: 'string' } } });
const directory = join('artifacts', `t18-${Date.now()}`);
mkdirSync(directory, { recursive: true });
const startedAt = new Date().toISOString();
const command = ['apps/cli/src/main.ts', 'context', '--scenario', args.values['transport-config'] ? 'real' : 'synthetic',
  ...(args.values['transport-config'] ? ['--transport-config', args.values['transport-config']] : [])];
const child = spawnSync(process.execPath, command, { encoding: 'utf8', maxBuffer: 4_194_304 });
writeFileSync(join(directory, 'stdout.jsonl'), child.stdout ?? '');
writeFileSync(join(directory, 'stderr.txt'), child.stderr ?? '');
const fixture = JSON.parse(readFileSync('fixtures/t18-context.json', 'utf8'));
const checks: Record<string, boolean> = {};
let failure: string | null = null;
let result: Record<string, unknown> | undefined;
let sqlite: string | null = null;
let root: string | undefined;
let copied = false;
try {
  const events = (child.stdout ?? '').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
  root = events.find(event => event.event === 'sandbox')?.root as string | undefined;
  assert.ok(root && basename(root).startsWith('euler-t01-'));
  cpSync(root, join(directory, 'sandbox'), { recursive: true }); copied = true;
  assert.equal(child.status, 0);
  result = events.find(event => event.event === 'context-result');
  assert.ok(result && result.syntheticPassed === true);
  const db = new DatabaseSync(join(directory, 'sandbox', 'probe.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 25);
    sqlite = String(db.prepare('SELECT sqlite_version() AS version').get()!.version);
    checks.schema = true;
    const archive = new Map<string, { line: string; text: string }>();
    for (const file of readdirSync(join(directory, 'sandbox')).filter(name => name.endsWith('.jsonl') && name !== 'counting-receiver.jsonl' && name !== 'owner-info.jsonl')) {
      const lines = readFileSync(join(directory, 'sandbox', file), 'utf8').trimEnd().split('\n');
      const header = JSON.parse(lines.shift()!);
      if (header.schema !== 'cli-session@1') continue;
      for (const line of lines) {
        const entry = JSON.parse(line);
        archive.set(`${header.binding.sessionId}/${entry.eventId}`, { line, text: entry.text });
      }
    }
    for (const runId of [result.originRunId, result.targetRunId, result.proposalRunId]) {
      const rows = db.prepare('SELECT * FROM request_events WHERE run_id=? ORDER BY seq').all(String(runId));
      for (const [index, row] of rows.entries()) { assert.equal(row.seq, index + 1); assert.equal(row.hash, hash(String(row.payload))); }
      const runtime = rows.filter(row => row.kind === 'agent/event@v1').map(row => JSON.parse(String(row.payload)).event);
      assert.equal(runtime.at(-1).kind, 'terminal'); assert.equal(runtime.at(-1).terminal, 'completed');
      const bodies = new Map<string, string>();
      for (const [index, event] of runtime.entries()) {
        const ref = event.kind === 'response' ? event.source : event.kind === 'tool-result' ? event.result.source : null;
        if (!ref) continue;
        const raw = archive.get(`${ref.binding.sessionId}/${ref.eventId}`);
        assert.ok(raw); assert.equal(hash(raw.line), ref.hash); assert.equal(hash(raw.text), ref.contentHash);
        assert.equal(Buffer.byteLength(raw.line), ref.byteLength); bodies.set(ref.eventId, raw.text);
        if (runtime[0].discoveryGrantId) {
          const access = runtime.slice(0, index).find(item => item.kind === 'source-access' && item.sourceEventId === ref.eventId);
          assert.ok(access); assert.deepEqual(access.binding, ref.binding);
          assert.equal(access.discoveryGrantId, runtime[0].discoveryGrantId);
        }
      }
      const tools = runtime.filter(event => event.kind === 'tool-result').map(event => ({ event, raw: JSON.parse(bodies.get(event.result.source.eventId)!) }));
      if (runId === result.originRunId) {
        const missing = runtime.filter(event => event.kind === 'response').flatMap(event => JSON.parse(bodies.get(event.source.eventId)!).calls)
          .find(call => call.name === 'source.expand' && call.arguments.eventId === fixture.unavailableEventId);
        assert.ok(missing);
        const expandIds = new Set(runtime.filter(event => event.kind === 'response').flatMap(event => event.calls)
          .filter(call => call.name === 'source.expand').map(call => call.callId));
        const expectedUnits = db.prepare("SELECT unit_id FROM source_units WHERE kind='source' AND content_hash=?").all(hash(fixture.evidence));
        assert.equal(expectedUnits.length, 1);
        assert.ok(tools.some(tool => {
          if (!expandIds.has(tool.event.result.callId) || tool.raw.outcome !== 'success') return false;
          const excerpt = JSON.parse(tool.raw.modelResult);
          return excerpt.unitId === expectedUnits[0]!.unit_id && excerpt.text === fixture.evidence;
        }));
        checks.projectEvidenceInLoop = true;
        const failed = tools.find(tool => tool.event.result.callId === missing.id);
        assert.ok(failed); assert.equal(failed.raw.outcome, 'failure');
        assert.equal(JSON.parse(failed.raw.modelResult).status, 'unavailable');
        assert.ok(runtime.slice(runtime.indexOf(failed.event) + 1).some(event => event.kind === 'response'));
        assert.equal(db.prepare('SELECT state FROM memory_discovery_grants WHERE grant_id=?').get(runtime[0].discoveryGrantId)!.state, 'revoked');
        checks.unavailableThenContinue = true; checks.durableSourceAccess = true;
      } else {
        assert.equal(runtime[0].discoveryGrantId, undefined);
        const expanded = tools.map(tool => JSON.parse(tool.raw.modelResult)).filter(value => value.unitId);
        if (runId === result.targetRunId) {
          assert.ok((result.approvedUnits as string[]).every(id => expanded.some(value => value.unitId === id)));
          assert.ok(expanded.some(value => value.kind === 'report-section' && value.version === 1 && value.text === fixture.approvedSection));
          assert.ok(expanded.some(value => value.kind === 'report-section' && value.version === 2 && value.text === fixture.approvedNextSection));
          assert.ok(expanded.some(value => value.kind === 'handoff' && value.text === '# Ordinary Markdown handoff\n\n' + fixture.approvedNextSection));
          checks.handoffAndVersionsInLoop = true;
        } else {
          const proposalId = result.proposalId;
          assert.ok(expanded.some(value => value.kind === 'proposal' && value.unitId === proposalId && value.text.includes('PROPOSAL-T18')));
          checks.proposalInLoop = true;
        }
      }
      const windows = runtime.filter(event => event.kind === 'window-opened');
      assert.equal(new Set(windows.map(window => window.windowId)).size, windows.length);
      if (runId === result.originRunId) assert.ok(windows.length >= 2);
      for (const assembly of db.prepare('SELECT * FROM request_assemblies WHERE run_id=?').all(String(runId))) {
        const context = JSON.parse(String(assembly.context));
        assert.ok(windows.some(window => window.windowId === context.windowId));
        const epoch = runtime.find(event => event.kind === 'cache-epoch-opened' && event.cacheEpoch === context.cacheEpoch && event.prefixHash === context.prefixHash);
        assert.ok(epoch); assert.match(context.operationHash, /^[a-f0-9]{64}$/);
        assert.equal(epoch.operationHash, context.operationHash);
        assert.equal(epoch.guidanceRunId, context.guidanceRunId);
        assert.equal(runtime[0].guidanceRunId, context.guidanceRunId);
        if (context.guidanceRunId) {
          const selected = db.prepare('SELECT run_id,route,payload_hash,sources FROM request_assemblies WHERE assembly_id=?').get(context.guidanceAssemblyId);
          assert.ok(selected); assert.equal(selected.run_id, context.guidanceRunId); assert.equal(selected.route, 'guidance-acceptance');
          const refs = JSON.parse(String(selected.sources)).filter((ref: { contentHash: string }) => ref.contentHash === selected.payload_hash);
          assert.equal(refs.length, 1);
          assert.ok(JSON.parse(String(assembly.sources)).some((ref: unknown) => JSON.stringify(ref) === JSON.stringify(refs[0])));
          const raw = archive.get(`${refs[0].binding.sessionId}/${refs[0].eventId}`);
          assert.ok(raw); assert.equal(hash(raw.text), selected.payload_hash);
          assert.equal(JSON.parse(raw.text).schema, 'instruction-snapshot@1');
        } else assert.equal(context.guidanceAssemblyId, undefined);
        const budget = JSON.parse(String(assembly.budget));
        assert.ok(Number(assembly.byte_length) + budget.outputReserve + budget.safetyMargin <= budget.contextLimit);
        for (const ref of JSON.parse(String(assembly.sources))) {
          const raw = archive.get(`${ref.binding.sessionId}/${ref.eventId}`);
          assert.ok(raw); assert.equal(hash(raw.line), ref.hash); assert.equal(hash(raw.text), ref.contentHash);
          assert.equal(Buffer.byteLength(raw.line), ref.byteLength);
        }
      }
      const attempts = db.prepare('SELECT * FROM request_attempts WHERE run_id=?').all(String(runId));
      assert.ok(attempts.length > 0 && attempts.every(attempt => attempt.outcome === 'received'));
    }
    checks.archiveHashes = true; checks.windowsAndEpochs = true; checks.budgetsAndTerminals = true;
    if (!result.realProvider) {
      const lines = readFileSync(join(directory, 'sandbox', 'counting-receiver.jsonl'), 'utf8').trimEnd().split('\n').slice(1);
      assert.equal(lines.length, result.fixtureProviderCount);
      for (const line of lines) {
        const receipt = JSON.parse(line); assert.equal(hash(JSON.stringify(receipt.record)), receipt.hash);
        const attempt = db.prepare('SELECT payload_hash,byte_length,outcome FROM request_attempts WHERE attempt_id=?').get(receipt.record.attemptId);
        assert.ok(attempt); assert.equal(attempt.payload_hash, receipt.record.payloadHash);
        assert.equal(attempt.byte_length, receipt.record.byteLength); assert.equal(attempt.outcome, 'received');
      }
      checks.countingReceiver = true;
    }
    const proposal = db.prepare('SELECT payload,payload_hash FROM evolution_proposals WHERE proposal_id=?').get(String(result.proposalId));
    assert.ok(proposal); assert.equal(JSON.parse(String(proposal.payload)).inert, true); assert.equal(hash(String(proposal.payload)), proposal.payload_hash);
    assert.equal(result.deletedHandoffRecovered, true); assert.equal(result.oldGrantDenied, true);
    assert.equal(result.reportVersion, 2); checks.handoff = true;
  } finally { db.close(); }
} catch (error) {
  failure = error instanceof Error ? `${error.name}:${hash(error.message)}` : 'unknown-verification-failure';
  writeFileSync(join(directory, 'verification-error.txt'), error instanceof Error ? error.stack ?? error.message : String(error));
}
finally { if (copied && root && basename(root).startsWith('euler-t01-')) rmSync(root, { recursive: true, force: true }); }
const files = (path: string, prefix = ''): string[] => readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
  ? files(join(path, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]);
const receipt = { schema: 't18-context-evidence@1', verdict: failure ? 'failed' : result?.realProvider ? 'controlled-real-loop-passed' : 'evidence-gap',
  syntheticPassed: failure === null, startedAt, finishedAt: new Date().toISOString(),
  implementation: { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0 },
  environment: { platform: process.platform, arch: arch(), release: release(), node: process.version, sqlite },
  fixtureDigest: hash(readFileSync('fixtures/t18-context.json')), command: [process.execPath, ...command],
  process: { exitCode: child.status, signal: child.signal, stdoutHash: hash(child.stdout ?? ''), stderrHash: hash(child.stderr ?? '') },
  realProvider: result?.realProvider ?? false, networkCount: result?.networkCount ?? 0, fixtureProviderCount: result?.fixtureProviderCount ?? 0,
  checks, failure, gaps: result?.realProvider ? [] : ['real-provider-long-session-and-new-session-behavior'],
  artifacts: files(directory).map(path => ({ path, sha256: hash(readFileSync(join(directory, path))) })) };
writeFileSync(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ directory, verdict: receipt.verdict, syntheticPassed: receipt.syntheticPassed, failure }));
if (failure) process.exitCode = 1;
