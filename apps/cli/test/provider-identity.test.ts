import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
