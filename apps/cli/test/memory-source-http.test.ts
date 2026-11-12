import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
import { createServer } from 'node:http';
import test from 'node:test';
import type { Model } from '@earendil-works/pi-ai';
import { AgentRun, DEFAULT_BUDGET, sha256 } from '@euler/core';
import { pumpAgent } from '../src/agent-pump.ts';
import { HttpModelTransport } from '../src/model-transport.ts';
import type { TransportObservation } from '../src/model-transport.ts';
import { openProbe } from '../src/probe.ts';
import { bindingOf, createSandbox, createSandboxSession } from '../src/sandbox.ts';

test('HTTP memory search delivers exact cross-session provenance only in the untrusted current tail', async () => {
  const budget = { ...DEFAULT_BUDGET, contextLimit: 24000, outputReserve: 1024,
    maxTotalTokens: 96000, maxModelAttempts: 2, maxToolCalls: 2 };
  const sandbox = createSandbox();
  const binding = bindingOf(sandbox);
  const history = { ...binding, sessionId: randomUUID(), branchId: randomUUID() };
  createSandboxSession(sandbox, history);
  const writer = openProbe(sandbox, budget, undefined, history, undefined, true);
  const sourceText = 'Archive-window original: open at 07:45. 原文独有标识：青杉-HTTP-78。';
  const summary = 'Archivewindow has a recorded opening convention.';
  let source: ReturnType<typeof writer.archive.append>;
  let record: ReturnType<typeof writer.store.readMemory>;
  try {
    source = writer.archive.append(randomUUID(), sourceText, 'user');
    const candidate = writer.store.captureMemory(writer.activity, source, summary,
      { type: 'fact', scope: { kind: 'project', id: binding.projectId!, resolved: true }, appliesTo: [] }).record;
    const verified = writer.store.verifyMemory(writer.activity, candidate.recordId, candidate, 'pass', [source]).record;
    record = writer.store.activateMemory(writer.activity, verified.recordId, verified).record;
    writer.store.drainSearchProjection(writer.activity);
  } finally { writer.close(); }

  const probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
  const bodies: string[] = [];
  const observations: TransportObservation[] = [];
  const receiverErrors: unknown[] = [];
  let run: AgentRun;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.socket.remoteAddress, '127.0.0.1');
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      let body = '';
      for await (const chunk of request) body += chunk;
      bodies.push(body);
      assert.ok(bodies.length <= 2);
      const ledger = probe.store.requestStatus(probe.activity, run.runId);
      const attempt = ledger.attempts.at(-1)!;
      assert.equal(attempt.outcome, 'unknown-sent');
      assert.equal(attempt.payloadHash, sha256(body));
      assert.equal(attempt.byteLength, Buffer.byteLength(body));
      const message = bodies.length === 1
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'find-source', type: 'function',
          function: { name: 'memory_search', arguments: JSON.stringify({ query: 'Archivewindow' }) } }] }
        : { role: 'assistant', content: 'The archived original says 07:45.' };
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ model: 'memory-source-http-fixture',
        choices: [{ message, finish_reason: bodies.length === 1 ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    } catch (error) {
      receiverErrors.push(error);
      response.writeHead(500); response.end('{}');
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const model: Model<'openai-completions'> = { api: 'openai-completions', provider: 'fixture',
      id: 'memory-source-http-fixture', name: 'Memory source HTTP fixture',
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, reasoning: false,
      input: ['text'], contextWindow: budget.contextLimit, maxTokens: budget.outputReserve,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const transport = new HttpModelTransport(model, budget, () => 'synthetic-loopback-only');
    run = new AgentRun(probe.store, probe.activity,
      { binding, source: probe.archive, encode: transport.encode.bind(transport) },
      { provider: model.provider, model: model.id, route: model.baseUrl, authNamespace: 'synthetic-test' }, budget);
    run.receive(randomUUID(), 'Find the prior archivewindow convention and its exact source.');
    const result = await pumpAgent(run, {
      stream: (request, signal, send) => transport.stream(request, signal, send,
        observation => observations.push(observation)),
      async execute() { throw new Error('unexpected-host-tool'); },
    });
    assert.deepEqual(receiverErrors, []);
    assert.equal(result.terminal, 'completed');
    assert.equal(transport.count, 2); assert.equal(bodies.length, 2); assert.equal(observations.length, 2);
    assert.equal(bodies[0]!.includes(sourceText), false);
    assert.equal(bodies[0]!.includes(summary), false);
    assert.equal(bodies[0]!.includes('青杉-HTTP-78'), false);

    const next = JSON.parse(bodies[1]!);
    const toolMessage = next.messages.find((message: { role: string }) => message.role === 'tool');
    assert.equal(toolMessage.tool_call_id, 'find-source');
    const wireResult = JSON.parse(toolMessage.content);
    assert.equal(wireResult.outcome, 'success');
    const page = JSON.parse(wireResult.result);
    assert.equal(page.results[0].record.recordId, record.recordId);
    assert.equal(page.results[0].record.content, summary);
    assert.equal(page.sourceRecovery, undefined);
    assert.equal(toolMessage.content.includes('青杉-HTTP-78'), false);
    const tail = JSON.parse(next.messages.at(-1).content);
    assert.equal(next.messages.at(-1).role, 'user');
    assert.equal(tail.sourceRecovery.kind, 'untrusted-source-recovery');
    assert.equal(tail.sourceRecovery.items.length, 1);
    const recovered = tail.sourceRecovery.items[0];
    assert.equal(recovered.status, 'ready'); assert.equal(recovered.recordId, record.recordId);
    assert.equal(recovered.excerpt.text, sourceText); assert.deepEqual(recovered.excerpt.ref, source);
    assert.equal(recovered.excerpt.excerptHash, sha256(sourceText));
    assert.equal(recovered.excerpt.offset, 0); assert.equal(recovered.excerpt.end, Array.from(sourceText).length);
    assert.equal(recovered.excerpt.truncated, false);
    assert.ok(next.messages.filter((message: { role: string }) => message.role === 'system')
      .every((message: { content: string }) => !message.content.includes('青杉-HTTP-78')));
    const archived = JSON.parse(probe.archive.read(run.status().tools[0]!.result!.source).text);
    assert.equal(wireResult.result, archived.modelResult);
    assert.deepEqual(tail.sourceRecovery.items, archived.sourceRecovery);

    const ledger = probe.store.requestStatus(probe.activity, run.runId);
    assert.equal(ledger.attempts.length, bodies.length);
    for (const [index, body] of bodies.entries()) {
      const attempt = ledger.attempts[index]!;
      const assembly = ledger.assemblies.find(item => item.assemblyId === attempt.assemblyId)!;
      assert.equal(attempt.outcome, 'received'); assert.equal(attempt.payloadHash, sha256(body));
      assert.equal(assembly.payloadHash, sha256(body));
      assert.equal(attempt.byteLength, Buffer.byteLength(body)); assert.equal(assembly.byteLength, Buffer.byteLength(body));
      assert.equal(observations[index]!.attemptId, attempt.attemptId);
      assert.equal(observations[index]!.httpStatus, 200);
    }
    assert.deepEqual(ledger.assemblies.at(-1)!.usedMemories.map(use => use.recordId), [record.recordId]);
  } finally {
    server.closeAllConnections(); server.close(); await once(server, 'close');
    probe.close(); rmSync(sandbox.root, { recursive: true, force: true });
  }
});
