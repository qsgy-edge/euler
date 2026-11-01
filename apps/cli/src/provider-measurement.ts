import { randomUUID } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { AgentRun, assemblyIdentityHash, check, sha256 } from '@euler/core';
import type { ModelReply, NeutralRequest, RequestAssembly, RequestAttempt } from '@euler/core';
import { pumpAgent } from './agent-pump.ts';
import { bindingOf, createSandbox } from './sandbox.ts';
import { openProbe } from './probe.ts';
import type { configuredTransport, TransportObservation } from './model-transport.ts';
import workload from '../../../fixtures/t23-provider-workload.json' with { type: 'json' };

type Configuration = ReturnType<typeof configuredTransport>;
export interface ProviderPricing {
  schema: 'provider-pricing@1'; provider: string; model: string; currency: string;
  inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion: number;
  inputAccounting: 'includes-cache-read-no-separate-write'; source: string; asOf: string;
}
export function readProviderPricing(path: string): ProviderPricing {
  const raw = readFileSync(path, 'utf8'); check(Buffer.byteLength(raw) <= 8192, 'pricing-too-large');
  const value = JSON.parse(raw) as ProviderPricing;
  check(value && Object.keys(value).sort().join(',') === 'asOf,cacheReadPerMillion,currency,inputAccounting,inputPerMillion,model,outputPerMillion,provider,schema,source'
    && value.schema === 'provider-pricing@1' && value.inputAccounting === 'includes-cache-read-no-separate-write', 'invalid-pricing');
  check([value.inputPerMillion, value.outputPerMillion, value.cacheReadPerMillion].every(rate => typeof rate === 'number' && Number.isFinite(rate) && rate >= 0), 'invalid-pricing-rate');
  check(/^[A-Z]{3}$/.test(value.currency) && /^\d{4}-\d{2}-\d{2}$/.test(value.asOf)
    && [value.provider, value.model].every(name => typeof name === 'string' && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(name)), 'invalid-pricing-identity');
  check(typeof value.source === 'string' && value.source.length <= 1024, 'invalid-pricing-source');
  const source = new URL(value.source);
  check(source.protocol === 'https:' && !source.username && !source.password && !source.search && !source.hash, 'invalid-pricing-source');
  return value;
}
function measuredCost(observation: TransportObservation, pricing?: ProviderPricing): MeasuredAttempt['cost'] {
  if (!pricing) return { amount: 'unknown', currency: 'unknown', basis: 'pricing-not-supplied' };
  const { input, output, cacheRead } = observation.tokens;
  return { amount: typeof input === 'number' && typeof output === 'number' && typeof cacheRead === 'number'
    ? ((input - cacheRead) * pricing.inputPerMillion + cacheRead * pricing.cacheReadPerMillion + output * pricing.outputPerMillion) / 1_000_000 : 'unknown',
    currency: pricing.currency, basis: 'operator-price-schedule; not-provider-bill' };
}
const bytes = (text: string) => ({ text, bytes: Buffer.byteLength(text), hash: sha256(text) });
export interface MeasuredAttempt {
  assembly: RequestAssembly; payloadPath: string; neutralPath: string; payloadHash: string;
  p0: ReturnType<typeof bytes>; p1: ReturnType<typeof bytes>; wirePrefix: ReturnType<typeof bytes>;
  observation: TransportObservation | null; ledgerAttempt: RequestAttempt | null;
  cost: { amount: number | 'unknown'; currency: string | 'unknown'; basis: string };
}
export interface ProviderSample {
  id: string; condition: string; repetition: number; cacheCondition: string;
  cacheControl: 'unsupported'; coldState: 'unknown'; runId: string;
  startedAt: string; finishedAt: string; elapsedMs: number;
  terminal: string | null; correct: boolean; attempts: MeasuredAttempt[];
  firstDecisiveOutput: { replyHash: string; elapsedMs: number; correct: boolean } | null;
  tools: { name: string; outcome: string | null }[]; ledgerPath: string; sandboxPath: string;
}

/** Literal prefix of the HTTP JSON, separate from Core's semantic namespace hash. */
function wirePrefix(payload: string, neutral: NeutralRequest): string {
  const encoded = JSON.parse(payload) as { messages: unknown[] };
  const count = 1 + (neutral.p0.guidance?.length || neutral.p0.guidanceRules ? 1 : 0) + (Object.keys(neutral.p1).length ? 1 : 0);
  const key = ',"messages":';
  const start = payload.indexOf(key);
  check(start >= 0, 'measurement-encoding-unavailable');
  const prefix = payload.slice(0, start + key.length) + JSON.stringify(encoded.messages.slice(0, count)).slice(0, -1);
  check(payload.startsWith(prefix), 'measurement-prefix-mismatch');
  return prefix;
}

/** One fixed synthetic workload; the supplied budget caps the entire measurement, not each repetition. */
export async function measureProvider(config: Configuration, options: {
  directory: string; repetitions: number; cacheCondition: string; pricing?: ProviderPricing;
}): Promise<{ samples: ProviderSample[]; networkCount: number; chargedTokens: number; stopReason: string | null }> {
  check(Number.isSafeInteger(options.repetitions) && options.repetitions > 0 && options.repetitions <= 20, 'invalid-repetitions');
  mkdirSync(options.directory, { recursive: true });
  const { model, budget, transport } = config;
  check(!options.pricing || options.pricing.provider === model.provider && options.pricing.model === model.id, 'pricing-route-mismatch');
  const route = { provider: model.provider, model: model.id, route: model.baseUrl, authNamespace: config.authNamespace };
  const samples: ProviderSample[] = [];
  const startingCount = transport.count, suiteStart = performance.now();
  let chargedTokens = 0, admitted = 0, tools = 0, stopReason: string | null = null;
  let active: AgentRun | undefined;
  const cancel = () => { stopReason = 'cancelled'; active?.cancel(); };
  process.on('SIGINT', cancel);
  const deadline = setTimeout(() => { stopReason = 'deadline'; active?.stop('deadline'); }, budget.wallClockMs);
  try {
    outer: for (let repetition = 0; repetition < options.repetitions; repetition++) for (const condition of workload.conditions) {
      if (stopReason) break;
      const remaining = { ...budget, maxModelAttempts: budget.maxModelAttempts - admitted,
        maxToolCalls: budget.maxToolCalls - tools, maxTotalTokens: budget.maxTotalTokens - chargedTokens,
        wallClockMs: Math.ceil(budget.wallClockMs - (performance.now() - suiteStart)) };
      if (remaining.wallClockMs <= 0) { stopReason = 'deadline'; break; }
      if (remaining.maxModelAttempts <= 0 || remaining.maxToolCalls <= 0 || remaining.maxTotalTokens <= 0) { stopReason = 'budget-exhausted'; break; }
      const id = `${options.cacheCondition}-${repetition + 1}-${condition}`;
      const directory = join(options.directory, id); mkdirSync(directory);
      const sandbox = createSandbox(), probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
      const neutrals = new Map<string, NeutralRequest>();
      const run = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive,
        encode: neutral => { const payload = transport.encode(neutral); neutrals.set(sha256(payload), neutral); return payload; } }, route, remaining);
      active = run;
      const started = performance.now();
      const sample: ProviderSample = { id, condition, repetition: repetition + 1, cacheCondition: options.cacheCondition,
        cacheControl: 'unsupported', coldState: 'unknown', runId: run.runId, startedAt: new Date().toISOString(), finishedAt: '', elapsedMs: 0,
        terminal: null, correct: false, attempts: [], firstDecisiveOutput: null, tools: [],
        ledgerPath: `${id}/ledger.json`, sandboxPath: `${id}/sandbox` };
      samples.push(sample);
      let echoes = 0;
      try {
        run.receive(randomUUID(), workload.goal + (condition === 'p3-change' ? workload.changedTail : ''));
        const status = await pumpAgent(run, {
          async *stream(request, signal, send) {
            const neutral = neutrals.get(request.payloadHash)!;
            const assembly = probe.store.requestStatus(probe.activity, run.runId).assemblies.find(item => item.assemblyId === request.assemblyId)!;
            const number = sample.attempts.length + 1;
            const measured: MeasuredAttempt = { assembly, payloadHash: request.payloadHash,
              payloadPath: `${id}/payload-${number}.json`, neutralPath: `${id}/neutral-${number}.json`,
              p0: bytes(JSON.stringify(neutral.p0)), p1: bytes(JSON.stringify(neutral.p1)), wirePrefix: bytes(wirePrefix(request.payload, neutral)),
              observation: null, ledgerAttempt: null, cost: { amount: 'unknown', currency: 'unknown', basis: 'pricing-not-supplied' } };
            sample.attempts.push(measured);
            writeFileSync(join(options.directory, measured.payloadPath), request.payload, { flag: 'wx' });
            writeFileSync(join(options.directory, measured.neutralPath), JSON.stringify(neutral), { flag: 'wx' });
            for await (const event of transport.stream(request, signal, send, observation => {
              measured.observation = observation;
              measured.cost = measuredCost(observation, options.pricing);
              appendFileSync(join(options.directory, 'observations.jsonl'), JSON.stringify({ sampleId: id, ...observation }) + '\n', { flush: true });
            })) {
              if (!sample.firstDecisiveOutput && event.reply.stop !== 'tools') sample.firstDecisiveOutput = {
                replyHash: sha256(JSON.stringify({ text: event.reply.text, calls: event.reply.calls, stop: event.reply.stop })), elapsedMs: performance.now() - started,
                correct: event.reply.stop === 'end' && event.reply.text === workload.answer && echoes === workload.echoes.length };
              yield event;
            }
          },
          async execute(call) {
            check(call.name === 'controlled.echo' && call.arguments.text === workload.echoes[echoes], 'measurement-tool-mismatch');
            echoes++; return String(call.arguments.text);
          },
          async cooperate() { if (condition === 'fresh-window' && echoes === workload.echoes.length) run.newWindow(); },
        });
        sample.terminal = status.terminal;
        sample.tools = status.tools.map(tool => ({ name: tool.name, outcome: tool.result?.outcome ?? null }));
        const reply = status.responses.length ? JSON.parse(probe.archive.read(status.responses.at(-1)!.source).text) as ModelReply : null;
        sample.correct = status.terminal === 'completed' && reply?.text === workload.answer && echoes === workload.echoes.length
          && sample.tools.length === workload.echoes.length && sample.tools.every(tool => tool.name === 'controlled.echo' && tool.outcome === 'success');
        const ledger = probe.store.requestStatus(probe.activity, run.runId);
        admitted += ledger.attempts.length;
        tools += status.tools.filter(tool => tool.started || tool.result).length;
        chargedTokens += run.chargedTokens();
        for (const measured of sample.attempts) measured.ledgerAttempt = ledger.attempts.find(attempt => attempt.attemptId === measured.observation?.attemptId) ?? null;
        writeFileSync(join(options.directory, sample.ledgerPath), JSON.stringify({ ledger, agent: status }, null, 2));
        if (!sample.correct) { stopReason ??= status.terminal === 'completed' ? 'incorrect-output' : status.terminal ?? 'incorrect-output'; break outer; }
      } finally {
        sample.finishedAt = new Date().toISOString(); sample.elapsedMs = performance.now() - started;
        writeFileSync(join(directory, 'sample.json'), JSON.stringify(sample, null, 2));
        probe.close(); active = undefined;
        cpSync(sandbox.root, join(options.directory, sample.sandboxPath), { recursive: true });
        rmSync(sandbox.root, { recursive: true, force: true });
      }
    }
  } finally { clearTimeout(deadline); process.off('SIGINT', cancel); }
  return { samples, networkCount: transport.count - startingCount, chargedTokens, stopReason };
}

function distribution(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  const percentile = (p: number) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]! : 'unknown';
  return { n: sorted.length, p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), method: 'nearest-rank' };
}
export function summarizeProviderSamples(samples: ProviderSample[]) {
  const groups = new Map<string, { sample: ProviderSample; attempt: MeasuredAttempt }[]>();
  const identity = (sample: ProviderSample, attempt: MeasuredAttempt) => JSON.stringify({
    condition: `${sample.cacheCondition}/${sample.condition}`, route: attempt.assembly.route,
    reportedModelHash: attempt.observation?.actualModelHash ?? 'unknown' });
  for (const sample of samples) for (const attempt of sample.attempts) {
    const key = identity(sample, attempt);
    groups.set(key, [...(groups.get(key) ?? []), { sample, attempt }]);
  }
  return [...groups].map(([key, entries]) => {
    const { condition, route, reportedModelHash } = JSON.parse(key) as { condition: string; route: string; reportedModelHash: string };
    const group = [...new Set(entries.map(entry => entry.sample))];
    const wholeSamples = group.filter(sample => sample.attempts.every(attempt => identity(sample, attempt) === key));
    const measured = entries.map(entry => entry.attempt);
    const attempts = measured.flatMap(attempt => attempt.observation ? [attempt.observation] : []);
    const knownCosts = measured.flatMap(attempt => typeof attempt.cost.amount === 'number' ? [attempt.cost.amount] : []);
    const tokens = (key: 'input' | 'output' | 'cacheRead') => {
      const reported = attempts.map(attempt => attempt.tokens[key]).filter((value): value is number => typeof value === 'number');
      return { reported: reported.length, missing: attempts.length - reported.length, sum: reported.reduce((sum, value) => sum + value, 0) };
    };
    return { condition, route: JSON.parse(route) as Record<string, string>, reportedModelHash,
      samples: group.length, mixedIdentitySamples: group.length - wholeSamples.length, failures: group.filter(sample => !sample.correct).length,
      totalMs: distribution(attempts.map(attempt => attempt.totalMs)),
      firstByteMs: distribution(attempts.flatMap(attempt => typeof attempt.firstByteMs === 'number' ? [attempt.firstByteMs] : [])),
      firstDecisiveOutputMs: distribution(wholeSamples.flatMap(sample => sample.firstDecisiveOutput ? [sample.firstDecisiveOutput.elapsedMs] : [])),
      ttftMs: 'unsupported', inputTokens: tokens('input'), outputTokens: tokens('output'), cacheReadTokens: tokens('cacheRead'),
      cacheWriteTokens: 'unsupported',
      cost: { knownSubtotal: knownCosts.reduce((sum, cost) => sum + cost, 0), unknown: measured.length - knownCosts.length,
        currency: measured[0]?.cost.currency ?? 'unknown' },
      sampleCaveat: group.length < 20 ? 'insufficient-for-tail-generalization' : 'observed-workload-only' };
  });
}

export function checkProviderSamples(samples: ProviderSample[], networkCount: number, directory: string) {
  const prefixes = new Map<string, string>();
  let stablePrefixDifferences = 0, artifactMismatch = 0;
  const attempts = samples.flatMap(sample => sample.attempts);
  for (const attempt of attempts) {
    const epoch = attempt.assembly.context!.cacheEpoch;
    const old = prefixes.get(epoch);
    if (old !== undefined && old !== attempt.wirePrefix.text) stablePrefixDifferences++;
    prefixes.set(epoch, attempt.wirePrefix.text);
  }
  const observed = attempts.filter(attempt => attempt.observation);
  const seen = new Set<string>();
  const ledgerMismatch = observed.filter(attempt => {
    const observation = attempt.observation!, ledger = attempt.ledgerAttempt, assembly = attempt.assembly;
    const duplicate = seen.has(observation.attemptId); seen.add(observation.attemptId);
    return duplicate || ledger?.attemptId !== observation.attemptId || ledger?.assemblyId !== assembly.assemblyId
      || ledger?.runId !== assembly.runId || ledger?.payloadHash !== observation.payloadHash || ledger?.byteLength !== observation.byteLength
      || assembly.payloadHash !== observation.payloadHash || assembly.byteLength !== observation.byteLength
      || assembly.identityHash !== assemblyIdentityHash(assembly) || attempt.payloadHash !== observation.payloadHash;
  }).length;
  for (const sample of samples) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(join(directory, sample.sandboxPath, 'probe.sqlite'), { readOnly: true });
      for (const attempt of sample.attempts) {
        const payload = readFileSync(join(directory, attempt.payloadPath), 'utf8');
        const neutral = JSON.parse(readFileSync(join(directory, attempt.neutralPath), 'utf8')) as NeutralRequest;
        check(sha256(payload) === attempt.payloadHash && attempt.assembly.runId === sample.runId
          && attempt.wirePrefix.text === wirePrefix(payload, neutral)
          && JSON.stringify(neutral.p0) === attempt.p0.text && JSON.stringify(neutral.p1) === attempt.p1.text
          && [attempt.p0, attempt.p1, attempt.wirePrefix].every(part => part.bytes === Buffer.byteLength(part.text) && part.hash === sha256(part.text)), 'measurement-artifact-mismatch');
        const assembly = db.prepare('SELECT * FROM request_assemblies WHERE assembly_id=?').get(attempt.assembly.assemblyId);
        check(assembly?.run_id === sample.runId && assembly.identity_hash === attempt.assembly.identityHash
          && assembly.payload_hash === sha256(payload) && assembly.byte_length === Buffer.byteLength(payload)
          && assembly.context === JSON.stringify(attempt.assembly.context), 'measurement-assembly-mismatch');
        if (attempt.observation) {
          const row = db.prepare('SELECT * FROM request_attempts WHERE attempt_id=?').get(attempt.observation.attemptId);
          check(row?.assembly_id === attempt.assembly.assemblyId && row.run_id === sample.runId
            && row.payload_hash === sha256(payload) && row.byte_length === Buffer.byteLength(payload)
            && row.ordinal === attempt.ledgerAttempt?.ordinal && row.outcome === attempt.ledgerAttempt?.outcome, 'measurement-attempt-mismatch');
        }
      }
    } catch { artifactMismatch++; }
    finally { db?.close(); }
  }
  let receiverMismatch = 0;
  try {
    const observations = existsSync(join(directory, 'observations.jsonl'))
      ? readFileSync(join(directory, 'observations.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    check(observations.length === observed.length && observations.every((row, index) =>
      samples.some(sample => sample.id === row.sampleId && sample.attempts.some(attempt => attempt.observation?.attemptId === row.attemptId))
      && JSON.stringify(row) === JSON.stringify({ sampleId: row.sampleId, ...observed[index]!.observation })), 'measurement-observation-mismatch');
    if (existsSync(join(directory, 'receiver.jsonl'))) {
      const receiver = readFileSync(join(directory, 'receiver.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      check(receiver.length === observed.length && receiver.every((row, index) => row.ordinal === index + 1
        && row.payloadHash === sha256(row.payload) && row.byteLength === Buffer.byteLength(row.payload)
        && row.payloadHash === observed[index]!.observation!.payloadHash
        && row.byteLength === observed[index]!.observation!.byteLength
        && row.payload === readFileSync(join(directory, observed[index]!.payloadPath), 'utf8')), 'measurement-receiver-mismatch');
    }
  } catch { receiverMismatch++; }
  const off = samples.filter(sample => sample.cacheCondition === 'fixture-off');
  const on = samples.filter(sample => sample.cacheCondition === 'fixture-on');
  return { hiddenSends: networkCount - observed.length, ledgerMismatch, artifactMismatch, receiverMismatch, stablePrefixDifferences,
    cachePairCorrectnessEqual: off.length && off.length === on.length
      ? off.every((sample, index) => sample.correct === on[index]!.correct && JSON.stringify(sample.tools) === JSON.stringify(on[index]!.tools)) : 'unverified' };
}
