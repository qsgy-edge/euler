import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { arch, release } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { check, DEFAULT_BUDGET, sha256 } from '@euler/core';
import { configuredTransport, HttpModelTransport, verifyTransportPrerequisites } from '../apps/cli/src/model-transport.ts';
import type { TransportPrerequisites } from '../apps/cli/src/model-transport.ts';
import { checkProviderSamples, measureProvider, readProviderPricing, summarizeProviderSamples } from '../apps/cli/src/provider-measurement.ts';
import type { ProviderSample } from '../apps/cli/src/provider-measurement.ts';
import { measureProviderIdentities } from './provider-identity-cases.ts';
import workload from '../fixtures/t23-provider-workload.json' with { type: 'json' };

const { values } = parseArgs({ options: { scenario: { type: 'string', default: 'synthetic' }, repetitions: { type: 'string', default: '3' },
  output: { type: 'string' }, 'transport-config': { type: 'string' }, pricing: { type: 'string' } } });
check(['synthetic', 'real'].includes(values.scenario!), 'invalid-provider-scenario');
check(values.scenario === 'real' || !values['transport-config'], 'real-scenario-required');
const repetitions = Number(values.repetitions);
check(Number.isSafeInteger(repetitions) && repetitions > 0 && repetitions <= 20, 'invalid-repetitions');
const directory = resolve(values.output ?? join('artifacts', `provider-${Date.now()}`));
mkdirSync(dirname(directory), { recursive: true }); mkdirSync(directory);
const startedAt = new Date().toISOString();
const pricing = values.pricing ? readProviderPricing(values.pricing) : null;
const samples: ProviderSample[] = [];
let networkCount = 0, receiverCount = 0, failure: string | null = null;
let prerequisites: TransportPrerequisites | null = null;
const configurations: Record<string, unknown>[] = [];
const gaps = ['ttft-unsupported-nonstreaming', 'provider-cache-on-off-control-unsupported',
  'cold-cache-reset-unavailable', 'agent-run-dynamic-schema-order-rebind-unavailable',
  'real-interruption-and-same-payload-retry-not-observed', 'real-provider-namespace-and-lifecycle-pairs-not-observed'];
if (!pricing) gaps.push('pricing-not-supplied');
if (values.scenario === 'synthetic') gaps.push('real-provider-cache-latency-cost');
if (values.scenario === 'real' && !values['transport-config']) gaps.push('explicit-route-model-auth-budget-required');
const server = values.scenario === 'synthetic' ? createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk;
  receiverCount++;
  appendFileSync(join(directory, 'receiver.jsonl'), JSON.stringify({ ordinal: receiverCount, payloadHash: sha256(body),
    byteLength: Buffer.byteLength(body), payload: body }) + '\n', { flush: true });
  const payload = JSON.parse(body) as { messages: { role: string; content: string }[] };
  const last = payload.messages.filter(message => message.role === 'tool').at(-1);
  const prior = last ? JSON.parse(last.content).result : null;
  const text = prior === workload.echoes[1] ? null : prior === workload.echoes[0] ? workload.echoes[1]! : workload.echoes[0]!;
  const message = text ? { role: 'assistant', content: null, tool_calls: [{ id: text, type: 'function',
    function: { name: 'controlled_echo', arguments: JSON.stringify({ text }) } }] } : { role: 'assistant', content: workload.answer };
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ model: 'synthetic-measurement', choices: [{ message, finish_reason: text ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: request.url?.startsWith('/fixture-on/') ? 80 : 0 } } }));
}) : null;
try {
  if (server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
  const conditions = server ? ['fixture-off', 'fixture-on'] : values['transport-config'] ? ['provider-managed'] : [];
  if (values['transport-config']) await verifyTransportPrerequisites(
    ['context-window', 'context-boundaries', 'context-authority', 'historian', 'provider-identity'], 'provider-prerequisites', undefined,
    receipt => { prerequisites = receipt; writeFileSync(join(directory, 'prerequisites.json'), JSON.stringify(receipt, null, 2)); });
  for (const cacheCondition of conditions) {
    const budget = { ...DEFAULT_BUDGET, contextLimit: 32000, outputReserve: 1024, maxModelAttempts: 100,
      maxToolCalls: 100, maxTotalTokens: 1_000_000, wallClockMs: 90000 };
    const model = { api: 'openai-completions' as const, provider: 'fixture', id: 'synthetic-measurement', name: 'Synthetic measurement',
      baseUrl: `http://127.0.0.1:${server ? (server.address() as { port: number }).port : 0}/${cacheCondition}/v1`,
      reasoning: false, input: ['text'] as ['text'], contextWindow: 32000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const config = values['transport-config'] ? configuredTransport(values['transport-config'])
      : { model, budget, authNamespace: 'synthetic-test', captureCapability: null,
        transport: new HttpModelTransport(model, budget, () => 'synthetic-measurement-key') };
    configurations.push({ cacheCondition, provider: config.model.provider, model: config.model.id, route: config.model.baseUrl,
      authNamespace: config.authNamespace, budget: config.budget,
      configHash: values['transport-config'] ? sha256(readFileSync(values['transport-config'])) : sha256(JSON.stringify({ model, budget })) });
    const before = config.transport.count;
    try {
      const result = await measureProvider(config, { directory, repetitions, cacheCondition, ...(pricing ? { pricing } : {}) });
      samples.push(...result.samples);
      configurations.at(-1)!.chargedTokens = result.chargedTokens;
      configurations.at(-1)!.stopReason = result.stopReason;
      if (result.stopReason) { failure = result.stopReason; break; }
    } finally { networkCount += config.transport.count - before; }
  }
} catch (error) { failure = error instanceof Error && /^[a-z][a-z0-9-]{0,80}$/.test(error.message) ? error.message
  : error instanceof Error ? sha256(error.message) : 'unknown'; }
finally { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } }
for (const entry of readdirSync(directory, { withFileTypes: true })) {
  if (!entry.isDirectory() || samples.some(sample => sample.id === entry.name)) continue;
  const saved = readdirSync(join(directory, entry.name));
  if (saved.includes('sample.json')) samples.push(JSON.parse(readFileSync(join(directory, entry.name, 'sample.json'), 'utf8')) as ProviderSample);
}
let identityEvidence: Awaited<ReturnType<typeof measureProviderIdentities>> | null = null;
if (server && !failure) {
  try {
    identityEvidence = await measureProviderIdentities(join(directory, 'identity'));
    if (!identityEvidence.passed) failure = 'identity-evidence-failed';
  }
  catch (error) { failure = error instanceof Error ? sha256(error.message) : 'identity-evidence-failed'; }
}
const checks = checkProviderSamples(samples, networkCount, directory);
if (checks.hiddenSends !== 0 || checks.ledgerMismatch !== 0 || checks.artifactMismatch !== 0 || checks.receiverMismatch !== 0 || checks.stablePrefixDifferences !== 0
  || server && receiverCount !== networkCount) failure ??= 'measurement-reconciliation-failed';
const expected = repetitions * workload.conditions.length * (server ? 2 : 1);
const complete = expected > 0 && samples.length === expected && samples.every(sample => sample.correct);
writeFileSync(join(directory, 'workload.json'), JSON.stringify(workload, null, 2) + '\n', { flag: 'wx' });
const implementationFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).trim().split(/\r?\n/)
  .filter(path => /^(apps\/cli\/src\/|packages\/core\/src\/|scripts\/(evidence-provider|provider-identity-cases)\.ts$|fixtures\/t23-provider-workload\.json$|package(-lock)?\.json$|tsconfig\.json$)/.test(path))
  .map(path => ({ path, sha256: sha256(readFileSync(path)) }));
const artifacts = readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
  const path = relative(directory, join(entry.parentPath, entry.name)).replaceAll('\\', '/');
  return { path, sha256: sha256(readFileSync(join(directory, path))) };
});
const receipt = { schema: 'provider-cache@v1', verdict: failure ? 'failed' : 'evidence-gap', startedAt, finishedAt: new Date().toISOString(),
  scenario: values.scenario, syntheticPassed: values.scenario === 'synthetic' && complete && failure === null,
  measuredCorrect: complete, networkCount: networkCount + (identityEvidence?.networkCount ?? 0), workloadNetworkCount: networkCount,
  independentReceiverCount: server ? receiverCount : 'unavailable', identityEvidence,
  samples, configurations, checks, statistics: summarizeProviderSamples(samples), failure, pricing, prerequisites,
  workload, fixtureDigest: sha256(JSON.stringify(workload)), repetitions,
  plannedSamples: expected, unexecutedSamples: expected - samples.length,
  scope: 'synthetic-workload-only; no MC baseline, live owner switch or cutover thresholds',
  implementation: { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0, files: implementationFiles },
  artifacts,
  environment: { platform: process.platform, arch: arch(), release: release(), node: process.version },
  gaps };
writeFileSync(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ directory, verdict: receipt.verdict, syntheticPassed: receipt.syntheticPassed, networkCount: receipt.networkCount, failure }));
if (failure) process.exitCode = 1;
