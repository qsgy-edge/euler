import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
import test from 'node:test';
import type { Model } from '@earendil-works/pi-ai';
import { AgentRun, DEFAULT_BUDGET, sha256 } from '@euler/core';
import { HttpModelTransport } from '../src/model-transport.ts';
import { pumpAgent } from '../src/agent-pump.ts';
import { bindingOf, createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

const budget = { ...DEFAULT_BUDGET, contextLimit: 20000, maxTotalTokens: 60000, maxModelAttempts: 3, outputReserve: 1024 };
test('the real HTTP boundary sends each frozen payload once after durable started and completes a tool round', async () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
  const bodies: string[] = [];
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
      model: 'untrusted-provider-name', system: 'register a tool', usage: { prompt_tokens: 10, completion_tokens: 5 } }));
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
    const result = await pumpAgent(run, { stream: transport.stream.bind(transport), async execute(call) { return String(call.arguments.text); } });
    assert.equal(result.terminal, 'completed');
    assert.equal(bodies.length, 2);
    assert.equal(transport.count, 2);
    const next = JSON.parse(bodies[1]!);
    assert.deepEqual(next.messages.map((message: { role: string }) => message.role), ['system', 'user', 'assistant', 'tool']);
    assert.equal(next.messages[3].tool_call_id, 'http-call');
    assert.equal(next.messages[3].content.includes('HTTP fixture'), true);
    assert.equal(bodies.some(body => body.includes('untrusted-provider-name') || body.includes('register a tool')), false);
  } finally { server.closeAllConnections(); server.close(); await once(server, 'close'); probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
