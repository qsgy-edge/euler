import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_BUDGET } from '@euler/core';
import { HttpModelTransport } from '../src/model-transport.ts';
import { measureProvider } from '../src/provider-measurement.ts';

test('provider measurement requires an explicit real route and preserves a zero-send evidence gap', () => {
  const root = mkdtempSync(join(tmpdir(), 'euler-provider-test-'));
  try {
    const directory = join(root, 'report');
    const result = spawnSync(process.execPath, ['scripts/evidence-provider.ts', '--scenario', 'real', '--output', directory], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(readFileSync(join(directory, 'receipt.json'), 'utf8'));
    assert.equal(receipt.schema, 'provider-cache@v1');
    assert.equal(receipt.verdict, 'evidence-gap');
    assert.equal(receipt.networkCount, 0);
    assert.deepEqual(receipt.samples, []);
    assert.ok(receipt.gaps.includes('explicit-route-model-auth-budget-required'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('synthetic measurement preserves ordered wire samples, stable prefixes and honest metric gaps', () => {
  const root = mkdtempSync(join(tmpdir(), 'euler-provider-test-'));
  try {
    const directory = join(root, 'report');
    const result = spawnSync(process.execPath, ['scripts/evidence-provider.ts', '--output', directory, '--repetitions', '1'], { encoding: 'utf8', timeout: 120000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const receipt = JSON.parse(readFileSync(join(directory, 'receipt.json'), 'utf8'));
    assert.equal(receipt.verdict, 'evidence-gap');
    assert.equal(receipt.syntheticPassed, true);
    assert.equal(receipt.networkCount, 24);
    assert.deepEqual(receipt.samples.map((sample: { condition: string }) => sample.condition),
      ['initial', 'repeat', 'p3-change', 'fresh-window', 'initial', 'repeat', 'p3-change', 'fresh-window']);
    assert.equal(receipt.checks.hiddenSends, 0);
    assert.equal(receipt.checks.stablePrefixDifferences, 0);
    assert.equal(receipt.checks.cachePairCorrectnessEqual, true);
    assert.ok(receipt.gaps.includes('real-provider-cache-latency-cost'));
    for (const artifact of receipt.artifacts) assert.equal(createHash('sha256').update(readFileSync(join(directory, artifact.path))).digest('hex'), artifact.sha256);
    assert.ok(receipt.implementation.files.some((file: { path: string }) => file.path === 'scripts/evidence-provider.ts'));
    for (const sample of receipt.samples) {
      assert.equal(sample.correct, true);
      assert.equal(sample.attempts.length, 3);
      assert.ok(sample.firstDecisiveOutput);
      for (const attempt of sample.attempts) {
        const payload = readFileSync(join(directory, attempt.payloadPath), 'utf8');
        assert.ok(payload.startsWith(attempt.wirePrefix.text));
        const hash = createHash('sha256').update(payload).digest('hex');
        assert.equal(attempt.payloadHash, hash);
        assert.equal(attempt.assembly.payloadHash, hash);
        assert.equal(attempt.ledgerAttempt.payloadHash, hash);
        assert.equal(attempt.observation.byteLength, Buffer.byteLength(payload));
        const neutral = JSON.parse(readFileSync(join(directory, attempt.neutralPath), 'utf8'));
        assert.equal(attempt.p0.text, JSON.stringify(neutral.p0));
        assert.equal(attempt.p1.text, JSON.stringify(neutral.p1));
        assert.equal(attempt.observation.ttftMs, 'unsupported');
        assert.equal(attempt.cost.amount, 'unknown');
        assert.equal(attempt.observation.outcome, 'received');
      }
    }
    assert.equal(receipt.samples[0].attempts[0].payloadHash, receipt.samples[1].attempts[0].payloadHash);
    assert.notEqual(receipt.samples[0].attempts[0].payloadHash, receipt.samples[2].attempts[0].payloadHash);
    const fresh = receipt.samples[3].attempts;
    assert.notEqual(fresh[1].assembly.context.windowId, fresh[2].assembly.context.windowId);
    assert.notEqual(fresh[1].assembly.context.cacheEpoch, fresh[2].assembly.context.cacheEpoch);
    assert.notEqual(fresh[1].p1.hash, fresh[2].p1.hash);
    assert.ok(receipt.statistics.every((row: { totalMs: { n: number }; ttftMs: string }) => row.totalMs.n === 3 && row.ttftMs === 'unsupported'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('measurement fees are recomputable from an explicit dated price schedule, not zero model defaults', () => {
  const root = mkdtempSync(join(tmpdir(), 'euler-provider-test-'));
  try {
    const directory = join(root, 'report'), pricing = join(root, 'pricing.json');
    writeFileSync(pricing, JSON.stringify({ schema: 'provider-pricing@1', provider: 'fixture', model: 'synthetic-measurement',
      currency: 'USD', inputPerMillion: 2, outputPerMillion: 6, cacheReadPerMillion: 0.5,
      inputAccounting: 'includes-cache-read-no-separate-write', source: 'https://example.test/fixture-pricing', asOf: '2026-01-01' }));
    const result = spawnSync(process.execPath, ['scripts/evidence-provider.ts', '--output', directory, '--repetitions', '1', '--pricing', pricing], { encoding: 'utf8', timeout: 120000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const receipt = JSON.parse(readFileSync(join(directory, 'receipt.json'), 'utf8'));
    assert.equal(receipt.pricing.inputPerMillion, 2);
    assert.equal(receipt.pricing.asOf, '2026-01-01');
    assert.equal(receipt.samples[0].attempts[0].cost.amount, 0.00026);
    assert.equal(receipt.samples[4].attempts[0].cost.amount, 0.00014);
    assert.equal(receipt.samples[0].attempts[0].cost.basis, 'operator-price-schedule; not-provider-bill');
    assert.equal(receipt.statistics[0].cost.unknown, 0);
    assert.ok(Math.abs(receipt.statistics[0].cost.knownSubtotal - 0.00078) < 1e-12);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const scenario of ['error', 'interrupt', 'scope', 'unauthorized-tool', 'budget'] as const)
  test(`measurement keeps the first ${scenario} and identical safety outcomes with fixture cache on/off`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'euler-provider-failure-'));
    const summaries: unknown[] = [];
    let calls = 0, cache = 0;
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume the actual request */ }
      calls++;
      if (scenario === 'error') { response.writeHead(503); response.end('{}'); return; }
      if (scenario === 'interrupt') { response.writeHead(200); response.write('{'); setImmediate(() => response.destroy()); return; }
      const tool = scenario === 'scope' ? { name: 'source_search', arguments: { scope: 'unapproved-project', query: 'private' } }
        : scenario === 'unauthorized-tool' ? { name: 'unapproved_network', arguments: {} }
          : { name: 'controlled_echo', arguments: { text: 'T23-ECHO-1' } };
      const message = calls === 1 ? { role: 'assistant', content: null, tool_calls: [{ id: 'fixture-call', type: 'function',
        function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } : { role: 'assistant', content: 'T23-OK' };
      response.end(JSON.stringify({ choices: [{ message, finish_reason: calls === 1 ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: cache } } }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      for (const cacheCondition of ['fixture-off', 'fixture-on']) {
        calls = 0; cache = cacheCondition === 'fixture-on' ? 80 : 0;
        const budget = { ...DEFAULT_BUDGET, contextLimit: 32000, outputReserve: 1024,
          maxModelAttempts: scenario === 'budget' ? 1 : 10, maxToolCalls: 10, maxTotalTokens: 200000 };
        const model = { api: 'openai-completions' as const, provider: 'fixture', id: 'fixture', name: 'fixture', reasoning: false,
          input: ['text'] as ['text'], contextWindow: 32000, maxTokens: 1024,
          baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
        const result = await measureProvider({ model, budget, authNamespace: 'fixture', captureCapability: null,
          transport: new HttpModelTransport(model, budget, () => 'synthetic-failure-key') },
        { directory: root, repetitions: 2, cacheCondition });
        assert.equal(result.samples.length, 1);
        const sample = result.samples[0]!;
        assert.equal(sample.correct, false);
        assert.equal(result.networkCount, calls);
        assert.equal(calls, scenario === 'scope' || scenario === 'unauthorized-tool' ? 2 : 1);
        assert.equal(sample.attempts.filter(attempt => attempt.observation).length, calls);
        assert.ok(sample.attempts.every(attempt => !attempt.observation || attempt.ledgerAttempt));
        if (scenario === 'scope' || scenario === 'unauthorized-tool') {
          assert.equal(result.stopReason, 'incorrect-output');
          assert.deepEqual(sample.tools.map(tool => tool.outcome), [scenario === 'scope' ? 'failure' : 'unavailable']);
        }
        if (scenario === 'interrupt') {
          assert.equal(sample.attempts[0]!.ledgerAttempt!.outcome, 'unknown-sent');
          assert.equal(sample.firstDecisiveOutput, null);
        }
        const disk = JSON.parse(readFileSync(join(root, sample.id, 'sample.json'), 'utf8'));
        assert.equal(disk.correct, false);
        summaries.push({ terminal: sample.terminal, tools: sample.tools, sends: result.networkCount,
          outcomes: sample.attempts.map(attempt => attempt.ledgerAttempt?.outcome) });
      }
      assert.deepEqual(summaries[0], summaries[1]);
    } finally { server.closeAllConnections(); server.close(); await once(server, 'close'); rmSync(root, { recursive: true, force: true }); }
  });

test('the measurement budget includes Core-owned tools across repeated runs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'euler-provider-budget-'));
  let calls = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume the actual request */ }
    calls++;
    const tool = calls < 3 ? { name: 'controlled_echo', arguments: { text: `T23-ECHO-${calls}` } }
      : { name: 'source_search', arguments: { scope: 'session', query: 'T23' } };
    response.end(JSON.stringify({ choices: [{ message: calls === 3 ? { role: 'assistant', content: 'T23-OK' }
      : { role: 'assistant', content: null, tool_calls: [{ id: `call-${calls}`, type: 'function',
        function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }, finish_reason: calls === 3 ? 'stop' : 'tool_calls' }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const budget = { ...DEFAULT_BUDGET, contextLimit: 32000, outputReserve: 1024, maxModelAttempts: 12, maxToolCalls: 3, maxTotalTokens: 300000 };
    const model = { api: 'openai-completions' as const, provider: 'fixture', id: 'fixture', name: 'fixture', reasoning: false,
      input: ['text'] as ['text'], contextWindow: 32000, maxTokens: 1024,
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const result = await measureProvider({ model, budget, authNamespace: 'fixture', captureCapability: null,
      transport: new HttpModelTransport(model, budget, () => 'synthetic-key') }, { directory: root, repetitions: 2, cacheCondition: 'fixture-off' });
    assert.equal(result.samples.length, 2);
    assert.equal(result.samples[0]!.correct, true);
    assert.equal(result.stopReason, 'budget-exhausted');
    assert.equal(calls, 5);
    const startedTools = result.samples.flatMap(sample => {
      const ledger = JSON.parse(readFileSync(join(root, sample.ledgerPath), 'utf8'));
      return ledger.agent.tools.filter((tool: { started: boolean }) => tool.started);
    });
    assert.equal(startedTools.length, 3);
  } finally { server.closeAllConnections(); server.close(); await once(server, 'close'); rmSync(root, { recursive: true, force: true }); }
});

test('real-mode prerequisite rejection is persisted and makes zero HTTP calls', async () => {
  const root = mkdtempSync(join(tmpdir(), 'euler-provider-preflight-'));
  let calls = 0;
  const server = createServer((_request, response) => { calls++; response.end('{}'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const directory = join(root, 'report'), config = join(root, 'route.json');
    writeFileSync(config, JSON.stringify({ provider: 'fixture', model: 'fixture',
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, authNamespace: 'fixture',
      credentialEnv: 'EULER_MEASUREMENT_TEST_KEY', authorization: 'synthetic-test-only', contextWindow: 32000, maxTokens: 1024,
      budget: { ...DEFAULT_BUDGET, contextLimit: 32000, outputReserve: 1024, maxModelAttempts: 12, maxToolCalls: 12, maxTotalTokens: 300000 } }));
    const injection = new URL('./support/capture-prerequisite-fixture.mjs', import.meta.url).href;
    await assert.rejects(promisify(execFile)(process.execPath, ['scripts/evidence-provider.ts', '--scenario', 'real', '--transport-config', config,
      '--output', directory, '--repetitions', '1'], { timeout: 120000, env: { ...process.env, EULER_MEASUREMENT_TEST_KEY: 'fixture-preflight-key',
        T13_PREREQUISITE_FIXTURE: 'reject', NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${injection}` } }));
    const receipt = JSON.parse(readFileSync(join(directory, 'receipt.json'), 'utf8'));
    assert.equal(receipt.verdict, 'failed');
    assert.equal(receipt.prerequisites.passed, false);
    assert.match(receipt.prerequisites.command.join(' '), /context-prerequisite-fixture/);
    assert.equal(calls, 0);
    assert.equal(receipt.networkCount, 0);
    assert.doesNotMatch(JSON.stringify(receipt), /fixture-preflight-key/);
  } finally { server.closeAllConnections(); server.close(); await once(server, 'close'); rmSync(root, { recursive: true, force: true }); }
});
