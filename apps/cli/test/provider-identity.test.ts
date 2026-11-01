import assert from 'node:assert/strict';
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import { measureProviderIdentities } from '../../../scripts/provider-identity-cases.ts';

test('local HTTP identity pairs retain lifecycle, namespace and invalidation evidence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'euler-provider-identities-'));
  try {
    const report = await measureProviderIdentities(directory);
    assert.equal(report.passed, true);
    assert.equal(report.hiddenSends, 0);
    for (const name of ['stable-p3', 'fresh-same-prefix', 'namespace-and-binding', 'guidance-release', 'historian-selection', 'emergency', 'emergency-write-failure', 'ledger-retry-schema-order'])
      assert.ok(report.cases.some(item => item.name === name && item.passed), name);
    for (const item of report.cases) {
      const evidence = JSON.parse(readFileSync(join(directory, item.name, 'evidence.json'), 'utf8'));
      assert.equal(evidence.sends.length, evidence.received.length);
      if (item.name === 'ledger-retry-schema-order') {
        assert.equal(evidence.sends[0].request.assemblyId, evidence.sends[1].request.assemblyId);
        assert.deepEqual(evidence.sends.slice(0, 2).map((send: { attempt: { ordinal: number } }) => send.attempt.ordinal), [1, 2]);
        assert.equal(evidence.sends.at(-1).observation.outcome, 'unknown');
      }
      for (const [index, sent] of evidence.sends.entries()) {
        assert.equal(sent.request.payload, evidence.received[index]);
        assert.equal(sent.observation.attemptId, sent.attempt.attemptId);
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a failed identity case retains its partial aggregate and every already-issued request', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'euler-provider-identity-failure-'));
  try {
    const injection = join(directory, 'fault.mjs'), output = join(directory, 'report');
    writeFileSync(injection, `import { ServerResponse } from 'node:http';
const original = ServerResponse.prototype.end;
ServerResponse.prototype.end = function(...args) {
  if (typeof args[0] === 'string' && args[0].includes('identity-fixture')) {
    const value = JSON.parse(args[0]), call = value.choices?.[0]?.message?.tool_calls?.[0];
    if (call) { call.id = 'unexpected-fixture-call'; args[0] = JSON.stringify(value); }
  }
  return Reflect.apply(original, this, args);
};`);
    const child = spawnSync(process.execPath, ['--import', pathToFileURL(injection).href, 'scripts/evidence-provider.ts',
      '--output', output, '--repetitions', '1'], { encoding: 'utf8', timeout: 120000 });
    assert.equal(child.status, 1, child.stdout + child.stderr);
    const report = JSON.parse(readFileSync(join(output, 'receipt.json'), 'utf8'));
    assert.equal(report.verdict, 'failed');
    assert.equal(report.syntheticPassed, false);
    assert.equal(report.workloadNetworkCount, 24);
    assert.equal(report.networkCount, 25);
    assert.equal(report.identityEvidence.networkCount, 1);
    assert.equal(report.identityEvidence.hiddenSends, 0);
    assert.match(report.identityEvidence.failureHash, /^[a-f0-9]{64}$/);
    const saved = JSON.parse(readFileSync(join(output, 'identity', 'receipt.json'), 'utf8'));
    assert.equal(saved.networkCount, 1);
    assert.deepEqual(saved.cases.map((item: { passed: boolean; sends: number }) => [item.passed, item.sends]), [[false, 1]]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('an identity receipt write failure returns a failed aggregate without losing completed sends', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'euler-provider-identity-write-'));
  const original = fs.writeFileSync;
  fs.writeFileSync = (path, data, options) => {
    if (path === join(directory, 'receipt.json')) throw new Error('injected-identity-receipt-write-failure');
    original(path, data, options);
  };
  syncBuiltinESMExports();
  try {
    const report = await measureProviderIdentities(directory);
    assert.equal(report.passed, false);
    assert.equal(report.networkCount, 26);
    assert.equal(report.hiddenSends, 0);
    assert.equal(report.cases.length, 8);
    assert.ok(report.cases.every(item => item.passed));
    assert.match(report.failureHash!, /^[a-f0-9]{64}$/);
  } finally { fs.writeFileSync = original; syncBuiltinESMExports(); rmSync(directory, { recursive: true, force: true }); }
});
