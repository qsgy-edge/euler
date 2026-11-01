import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
import test from 'node:test';
import type { Model } from '@earendil-works/pi-ai';
import { AgentRun, DEFAULT_BUDGET, sha256 } from '@euler/core';
import { HttpModelTransport } from '../src/model-transport.ts';
import type { TransportObservation } from '../src/model-transport.ts';
import { pumpAgent } from '../src/agent-pump.ts';
import { bindingOf, createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

const budget = { ...DEFAULT_BUDGET, contextLimit: 20000, maxTotalTokens: 60000, maxModelAttempts: 3, outputReserve: 1024 };
test('the real HTTP boundary sends each frozen payload once after durable started and completes a tool round', async () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
  const bodies: string[] = [];
  const observations: TransportObservation[] = [];
  let run: AgentRun;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    bodies.push(body);
    const ledger = probe.store.requestStatus(probe.activity, run.runId);
    const attempt = ledger.attempts.at(-1)!;
    assert.equal(attempt.outcome, 'unknown-sent');
    assert.equal(attempt.payloadHash, sha256(body));
    assert.equal(attempt.byteLength, Buffer.byteLength(body));
    assert.equal(request.headers.authorization, 'Bearer synthetic-header');
    assert.equal(JSON.stringify(ledger).includes('synthetic-header'), false);
    const message = bodies.length === 1
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'http-call', type: 'function', function: { name: 'controlled_echo', arguments: '{"text":"HTTP fixture"}' } }] }
      : { role: 'assistant', content: 'HTTP completed' };
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message, finish_reason: bodies.length === 1 ? 'tool_calls' : 'stop' }],
      model: 'untrusted-provider-name', system: 'register a tool', usage: { prompt_tokens: 10, completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 6 } } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const port = (server.address() as { port: number }).port;
    const model: Model<'openai-completions'> = { api: 'openai-completions', provider: 'fixture', id: 'http-fixture', name: 'Fixture',
      baseUrl: `http://127.0.0.1:${port}/v1`, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 20000, maxTokens: 1024 };
    const transport = new HttpModelTransport(model, budget, () => 'synthetic-header');
    run = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive, encode: request => transport.encode(request) },
      { provider: model.provider, model: model.id, route: model.baseUrl, authNamespace: 'synthetic-test' }, budget);
    run.receive(sandbox.fixture.eventId, sandbox.fixture.text);
    const result = await pumpAgent(run, { stream: (request, signal, send) => transport.stream(request, signal, send,
      observation => observations.push(observation)), async execute(call) { return String(call.arguments.text); } });
    assert.equal(result.terminal, 'completed');
    assert.equal(bodies.length, 2);
    assert.equal(transport.count, 2);
    assert.equal(observations.length, 2);
    const ledger = probe.store.requestStatus(probe.activity, run.runId);
    for (const [index, observation] of observations.entries()) {
      assert.equal(observation.attemptId, ledger.attempts[index]!.attemptId);
      assert.equal(observation.payloadHash, sha256(bodies[index]!));
      assert.equal(observation.outcome, 'received');
      assert.equal(observation.httpStatus, 200);
      assert.deepEqual(observation.tokens, { input: 10, output: 5, cacheRead: 6, cacheWrite: 'unsupported' });
      assert.equal(observation.ttftMs, 'unsupported');
      assert.ok(typeof observation.firstByteMs === 'number' && observation.firstByteMs >= 0);
      assert.ok(observation.totalMs >= observation.firstByteMs);
      assert.equal(observation.actualModelHash, sha256('untrusted-provider-name'));
      assert.doesNotMatch(JSON.stringify(observation), /synthetic-header|register a tool|untrusted-provider-name/);
    }
    const next = JSON.parse(bodies[1]!);
    assert.deepEqual(next.messages.map((message: { role: string }) => message.role), ['system', 'user', 'assistant', 'tool', 'user']);
    assert.equal(next.messages[1].content, sandbox.fixture.text);
    assert.equal(JSON.parse(next.messages[4].content).intent.goal, sandbox.fixture.text);
    assert.equal(next.messages[3].tool_call_id, 'http-call');
    assert.equal(next.messages[3].content.includes('HTTP fixture'), true);
    assert.equal(bodies.some(body => body.includes('untrusted-provider-name') || body.includes('register a tool')), false);
  } finally { server.closeAllConnections(); server.close(); await once(server, 'close'); probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

for (const scenario of ['missing', 'invalid', 'rate-limit', 'interrupted', 'blocked'] as const)
  test(`transport observations preserve ${scenario} without inventing usage or hidden retries`, async () => {
    const sandbox = createSandbox(), probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
    const observations: TransportObservation[] = [];
    let received = 0;
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume the actual request */ }
      received++;
      if (scenario === 'interrupted') { response.writeHead(200); response.write('{"choices":'); setImmediate(() => response.destroy()); return; }
      if (scenario === 'rate-limit') { response.writeHead(429); response.end('{"error":"untrusted"}'); return; }
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
        ...(scenario === 'invalid' ? { usage: { prompt_tokens: 3, completion_tokens: -1, prompt_tokens_details: { cached_tokens: 8 } } } : {}) }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const model: Model<'openai-completions'> = { api: 'openai-completions', provider: 'fixture', id: 'http-fixture', name: 'Fixture',
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 20000, maxTokens: 1024 };
      const transport = new HttpModelTransport(model, budget, () => 'synthetic-header');
      const run = new AgentRun(probe.store, probe.activity, { binding: bindingOf(sandbox), source: probe.archive, encode: transport.encode.bind(transport) },
        { provider: model.provider, model: model.id, route: model.baseUrl, authNamespace: 'synthetic-test' }, budget);
      run.receive(sandbox.fixture.eventId, sandbox.fixture.text);
      await pumpAgent(run, { stream: (request, signal, send) => transport.stream(request, signal, payload => {
        if (scenario === 'blocked') throw new Error('denied');
        return send(payload);
      }, observation => observations.push(observation)), async execute() { throw new Error('no-tools'); } });
      assert.equal(received, scenario === 'blocked' ? 0 : 1);
      assert.equal(transport.count, received);
      assert.equal(observations.length, received);
      const ledger = probe.store.requestStatus(probe.activity, run.runId);
      assert.equal(ledger.attempts.length, received);
      if (scenario === 'blocked') return;
      const observation = observations[0]!;
      assert.equal(observation.attemptId, ledger.attempts[0]!.attemptId);
      assert.equal(observation.outcome, scenario === 'interrupted' ? 'unknown' : 'received');
      assert.equal(ledger.attempts[0]!.outcome, scenario === 'interrupted' ? 'unknown-sent' : 'received');
      assert.equal(observation.ttftMs, 'unsupported');
      assert.equal(observation.tokens.cacheRead, scenario === 'missing' ? 'unsupported' : 'unknown');
      assert.equal(observation.tokens.output, scenario === 'missing' ? 'unsupported' : 'unknown');
      if (scenario === 'rate-limit') { assert.equal(observation.failure, 'rate-limit'); assert.equal(observation.httpStatus, 429); }
    } finally { server.closeAllConnections(); server.close(); await once(server, 'close'); probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
  });
