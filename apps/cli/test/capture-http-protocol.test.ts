import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import test from 'node:test';
import type { Model } from '@earendil-works/pi-ai';
import { AgentRun, CaptureRun, DEFAULT_BUDGET, sha256 } from '@euler/core';
import { HttpModelTransport } from '../src/model-transport.ts';
import { pumpCapture } from '../src/agent-pump.ts';
import { createSandbox, bindingOf } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

const budget = { ...DEFAULT_BUDGET, contextLimit: 20000, maxTotalTokens: 60000, maxModelAttempts: 3, outputReserve: 1024 };
const cases: { body: string | Buffer; interrupted?: boolean; credentialEcho?: boolean; result?: 'block' | 'evidence-gap' }[] = [
  { body: 'not-json' },
  { body: Buffer.from([0xc3, 0x28]) },
  { body: JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 5 }, choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
    tool_calls: [{ id: 'broken', type: 'function', function: { name: 'source_search', arguments: '{' } }] } }] }) },
  { body: '{}', interrupted: true },
  { body: JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
    tool_calls: Array.from({ length: 17 }, (_, index) => ({ id: `call-${index}`, type: 'function', function: { name: 'source_search', arguments: '{}' } })) } }] }) },
  { result: 'block', credentialEcho: true, body: JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant',
    content: JSON.stringify({ result: 'block', reason: 'synthetic-header' }),
    tool_calls: [{ id: 'broken', type: 'function', function: { name: 'source_search', arguments: '{' } }] } }] })
    .replace('synthetic-header', String.raw`\u0073ynthetic-header`) },
  ...(['block', 'evidence-gap'] as const).flatMap(result => [
    { count: 1, args: '{' }, { count: 1, args: 'null' }, { count: 1, args: '[]' },
    { count: 1, args: '{}' }, { count: 17, args: '{}' }, { count: 129, args: '{}' },
  ].map(({ count, args }) => ({ result,
    body: JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant',
      content: JSON.stringify({ result, reason: 'synthetic-negative' }),
      tool_calls: Array.from({ length: count }, (_, index) => ({ id: `call-${index}`, type: 'function',
        function: { name: 'source_search', arguments: args } })) } }] }) }))),
];
for (const { body, interrupted = false, credentialEcho = false, result } of cases) {
  test(credentialEcho ? 'a decoded credential in a malformed HTTP reply is neither archived nor retried'
    : result ? `a fully received HTTP Historian ${result} survives invalid tool metadata (${sha256(body).slice(0, 8)})`
    : interrupted ? 'an interrupted HTTP response stays unknown and cannot use protocol fallback'
    : `a fully received malformed HTTP reply settles received before protocol fallback (${sha256(body).slice(0, 8)})`, async () => {
    const sandbox = createSandbox(), probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
    const models: string[] = [];
    const server = createServer(async (request, response) => {
      let text = ''; for await (const chunk of request) text += chunk;
      models.push(JSON.parse(text).model);
      response.writeHead(200, { 'content-type': 'application/json', ...(interrupted ? { 'content-length': Buffer.byteLength(body) + 100 } : {}) });
      response.end(models.length === 1 ? body : JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant',
        content: result ? JSON.stringify({ result: 'pass', summary: 'A synthetic fallback summary.' }) : 'null' } }] }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
      const model: Model<'openai-completions'> = { api: 'openai-completions', provider: 'fixture', id: 'primary', name: 'Fixture', baseUrl,
        reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 20000, maxTokens: 1024 };
      const transports = { primary: new HttpModelTransport(model, budget, () => 'synthetic-header'),
        fallback: new HttpModelTransport({ ...model, id: 'fallback' }, budget, () => 'synthetic-header') };
      const primary = { provider: model.provider, model: model.id, route: baseUrl, authNamespace: 'fixture', capability: 'standard' as const };
      const routes = [primary, { ...primary, model: 'fallback' }];
      const job = result ? (() => {
        const { capability: _capability, ...agentRoute } = primary;
        const agent = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive }, agentRoute, budget);
        agent.receive(randomUUID(), 'Synthetic task: record exact value 47.');
        const request = agent.nextModel()!, attempt = agent.startModel(request, request.payload);
        assert.equal(agent.maySend(attempt.attemptId, request.payload), true);
        agent.finishModel(attempt.attemptId, { text: 'Confirmed synthetic result: 47.', calls: [], stop: 'end' });
        return probe.store.queueHistorianBoundary(probe.activity, agent.runId, { minBytes: 1, maxBytes: 16000 })!;
      })() : probe.store.queueOwnerCapture(probe.activity, probe.archive.append(randomUUID(), '记住：合成检查'));
      const lease = probe.store.claimCaptureJob(probe.activity, job.jobId, budget, 30000)!;
      const transportFor = (name: string) => transports[name as keyof typeof transports];
      const run = new CaptureRun(probe.store, lease, probe.archive, result ? { historian: routes } : { proposer: routes, verifier: routes },
        request => transportFor(request.model).encode(request), 'capture-http@1');
      const pump = pumpCapture(run, { stream: (request, signal, authorizeSend) => transportFor(JSON.parse(request.payload).model).stream(request, signal, authorizeSend) });
      if (interrupted || credentialEcho) {
        await assert.rejects(pump, credentialEcho ? /response-contained-credential/ : /response-interrupted|transport-unknown/);
        assert.equal(JSON.stringify(probe.archive.events()).includes('synthetic-header'), false);
        assert.equal(run.status().stage, 'unknown');
        assert.deepEqual(models, ['primary']);
        assert.equal(probe.store.requestStatus(lease.activity, run.runId).attempts[0]!.outcome, 'unknown-sent');
        assert.equal(probe.store.captureDrainBlocked(probe.activity), true);
      } else if (result) {
        assert.equal((await pump).stage, 'blocked');
        assert.equal(run.status().reason, 'historian-' + result);
        assert.deepEqual(models, ['primary']);
        const ledger = probe.store.requestStatus(lease.activity, run.runId);
        assert.deepEqual(ledger.attempts.map(attempt => attempt.outcome), ['received']);
        assert.equal(probe.store.captureDrainBlocked(probe.activity), false);
        assert(JSON.stringify(ledger.events).includes(sha256(body)));
        assert.equal(probe.archive.events().filter(event => event.role === 'tool').length, 0);
        const output = probe.archive.lookup(ledger.attempts[0]!.attemptId)!;
        assert.equal(JSON.parse(probe.archive.read(output).text).text, JSON.stringify({ result, reason: 'synthetic-negative' }));
        assert.throws(() => probe.store.readCompartment(probe.activity, job.jobId), /compartment-unavailable/);
      } else {
        assert.equal((await pump).stage, 'complete');
        assert.deepEqual(models, ['primary', 'fallback']);
        const ledger = probe.store.requestStatus(lease.activity, run.runId);
        assert.deepEqual(ledger.attempts.map(attempt => attempt.outcome), ['received', 'received']);
        assert.equal(probe.store.captureDrainBlocked(probe.activity), false);
        assert(JSON.stringify(ledger.events).includes(sha256(body)));
        assert.equal(probe.archive.events().filter(event => event.role === 'tool').length, 0);
        if (body.includes('prompt_tokens')) assert(ledger.events.some(event => JSON.parse(event.payload).usage?.inputTokens === 100));
      }
    } finally {
      server.closeAllConnections(); server.close(); await once(server, 'close');
      probe.close(); rmSync(sandbox.root, { recursive: true, force: true });
    }
  });
}
