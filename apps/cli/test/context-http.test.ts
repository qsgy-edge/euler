import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_BUDGET, sha256 } from '@euler/core';
import type { Binding } from '@euler/core';
import { startCli } from '../src/process-driver.ts';
import { createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';
import fixture from '../../../fixtures/t18-context.json' with { type: 'json' };

const prerequisiteFixture = new URL('./support/capture-prerequisite-fixture.mjs', import.meta.url).href;
for (const gate of ['full', 'skip-expand', 'reject'] as const) test(`context CLI uses the configured HTTP route, complete guidance and exact recovered evidence: ${gate}`, async () => {
  const sandbox = createSandbox();
  const temp = mkdtempSync(join(tmpdir(), 'euler-context-http-'));
  const bodies: string[] = [];
  const originBodies: string[] = [];
  const targetBodies: string[] = [];
  const proposalBodies: string[] = [];
  let serverError: unknown;
  const server = createServer(async (request, response) => {
    try {
      let body = ''; for await (const chunk of request) body += chunk;
      bodies.push(body);
      assert.equal(request.headers.authorization, 'Bearer synthetic-context-key');
      const payload = JSON.parse(body) as { messages: { role: string; content: string }[] };
      const current = JSON.parse(payload.messages.filter(message => message.role === 'user').at(-1)!.content);
      const origin = current.intent.goal.startsWith('Controlled synthetic acceptance.');
      const proposal = payload.messages.some(message => message.role === 'user' && message.content.includes('Continue with PROPOSAL-T18'));
      const sequence = origin ? originBodies : proposal ? proposalBodies : targetBodies;
      sequence.push(body);
      const turn = sequence.length;
      const toolData = () => JSON.parse(JSON.parse(payload.messages.filter(message => message.role === 'tool').at(-1)!.content).result);
      let call: { name: string; arguments: Record<string, unknown> } | null;
      if (origin) {
        call = turn <= 2 ? { name: 'controlled_echo', arguments: { text: turn === 1 ? 'first' : 'second' } }
          : turn === 3 ? { name: 'source_search', arguments: { query: fixture.marker, scope: 'session' } }
          : turn === 4 ? { name: 'source_expand', arguments: { eventId: toolData().results.find((hit: { role: string; preview: string }) => hit.role === 'tool' && hit.preview.includes(fixture.marker)).eventId, offset: 0, limit: 160 } }
          : turn === 5 ? { name: 'memory_search', arguments: { query: 'Atlas' } }
          : turn === 6 ? { name: 'source_search', arguments: { query: 'EVIDENCE-T18', scope: 'project' } }
          : turn === 7 ? gate === 'skip-expand' ? { name: 'source_search', arguments: { query: 'EVIDENCE-T18', scope: 'project' } }
            : { name: 'source_expand', arguments: { unitId: toolData().results[0].unitId, offset: 0, limit: 512 } }
          : turn === 8 ? { name: 'source_expand', arguments: { eventId: fixture.unavailableEventId, offset: 0, limit: 32 } } : null;
        if (turn === 5) assert.match(toolData().text, /RAW-MARKER-T18/);
        if (turn === 8 && gate !== 'skip-expand') assert.equal(toolData().text, fixture.evidence);
        if (turn === 9) assert.equal(toolData().status, 'unavailable');
      } else if (proposal) {
        call = turn === 1 ? { name: 'source_search', arguments: { query: 'PROPOSAL-T18', scope: 'project' } }
          : turn === 2 ? { name: 'source_expand', arguments: { unitId: toolData().results.find((hit: { kind: string }) => hit.kind === 'proposal').unitId, offset: 0, limit: 4096 } } : null;
        if (turn === 3) { assert.equal(toolData().kind, 'proposal'); assert.match(toolData().text, /PROPOSAL-T18/); }
      } else {
        const hits: { kind: string; version: number; unitId: string }[] = turn > 1
          ? JSON.parse(JSON.parse(payload.messages.filter(message => message.role === 'tool')[0]!.content).result).results : [];
        const selected = turn === 2 ? hits.find(hit => hit.kind === 'report-section' && hit.version === 2)
          : turn === 3 ? hits.find(hit => hit.kind === 'handoff') : hits.find(hit => hit.kind === 'report-section' && hit.version === 1);
        call = turn === 1 ? { name: 'source_search', arguments: { query: 'HANDOFF-T18', scope: 'project' } }
          : turn <= 4 ? { name: 'source_expand', arguments: { unitId: selected!.unitId, offset: 0, limit: 1024 } } : null;
        if (turn === 3) assert.equal(toolData().text, fixture.approvedNextSection);
        if (turn === 4) assert.equal(toolData().text, '# Ordinary Markdown handoff\n\n' + fixture.approvedNextSection);
        if (turn === 5) assert.equal(toolData().text, fixture.approvedSection);
      }
      const message = call ? { role: 'assistant', content: null, tool_calls: [{ id: `${origin ? 'origin' : 'target'}-${turn}`, type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }
        : { role: 'assistant', content: origin ? JSON.stringify({ facts: fixture.evidence, inferences: fixture.inference,
          recommendations: fixture.approvedSection, unresolved: fixture.unresolved })
          : proposal ? '{"assessment":"requires-current-source-review","authority":"local-only","proposal":"inert"}'
          : '{"assessment":"requires-current-source-review","authority":"local-only"}' };
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message, finish_reason: call ? 'tool_calls' : 'stop' }],
        system: 'UNTRUSTED-REMOTE-GUIDANCE', usage: { prompt_tokens: 30, completion_tokens: 10 } }));
    } catch (error) { serverError = error; response.statusCode = 500; response.end('{}'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const config = join(temp, 'route.json');
  writeFileSync(config, JSON.stringify({ provider: 'fixture', model: 'context-http', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    authNamespace: 'synthetic-test', credentialEnv: 'EULER_CONTEXT_TEST_KEY', contextWindow: 24000, maxTokens: 1024,
    authorization: 'synthetic-test-only', budget: { ...DEFAULT_BUDGET, contextLimit: 24000, outputReserve: 1024,
      maxModelAttempts: 10, maxToolCalls: 10, maxTotalTokens: 600000, wallClockMs: 30000 } }));
  const cli = startCli(['context', '--scenario', 'real', '--sandbox', sandbox.root, '--transport-config', config], 150000, undefined,
    { ...process.env, EULER_CONTEXT_TEST_KEY: 'synthetic-context-key', ...(gate === 'reject' ? {
      T13_PREREQUISITE_FIXTURE: 'reject', NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${prerequisiteFixture}`,
    } : {}) });
  try {
    const prerequisite = await cli.waitFor('context-prerequisites');
    const started = cli.observations.find(event => event.event === 'context-prerequisites-started');
    assert.ok(started && Number.isSafeInteger(started.pid));
    assert.deepEqual(started.command, prerequisite.command);
    assert.ok(typeof prerequisite.elapsedMs === 'number' && prerequisite.elapsedMs >= 0);
    assert.doesNotMatch(JSON.stringify(cli.observations) + cli.stderr(), /synthetic-context-key/);
    assert.equal(prerequisite.passed, gate !== 'reject', JSON.stringify(cli.observations));
    if (gate === 'reject') {
      assert.match((prerequisite.command as string[]).join(' '), /context-prerequisite-fixture/);
      assert.equal((await cli.exit).code, 1);
      assert.equal(bodies.length, 0); return;
    }
    assert.ok((prerequisite.command as string[]).includes('apps/cli/test/context-window.test.ts'));
    if (gate === 'skip-expand') {
      assert.equal((await cli.exit).code, 1); assert.ifError(serverError);
      assert.match(cli.stderr() + JSON.stringify(cli.observations), /context-project-evidence-gap/);
      assert.equal(originBodies.length, 9); assert.equal(targetBodies.length, 0);
      assert.ok(!cli.observations.some(event => event.event === 'context-result')); return;
    }
    const result = await cli.waitFor('context-result');
    assert.equal((await cli.exit).code, 0, cli.stderr());
    assert.ifError(serverError);
    assert.equal(result.networkCount, bodies.length);
    assert.equal(bodies.length, 17);
    const guidanceBlocks = (body: string) => JSON.parse(JSON.parse(body).messages
      .find((message: { role: string; content: string }) => message.role === 'system' && message.content.includes('local-guidance')).content).blocks as { kind: string; text: string }[];
    assert.equal(guidanceBlocks(originBodies[0]!).find(block => block.kind === 'skill')!.text, fixture.skillBody);
    assert.equal(guidanceBlocks(originBodies[2]!).find(block => block.kind === 'agents')!.text, fixture.updatedGuidance);
    assert.ok(originBodies.every(body => body.includes('local-guidance')));
    assert.ok([...targetBodies, ...proposalBodies].every(body => !body.includes('local-guidance') && !body.includes(fixture.marker)));
    assert.ok(bodies.every(body => !body.includes('UNTRUSTED-REMOTE-GUIDANCE')));
    const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    try {
      const ledger = probe.store.requestStatus(probe.activity, result.originRunId as string);
      assert.deepEqual(ledger.attempts.map(attempt => attempt.payloadHash), originBodies.map(body => sha256(body)));
      assert.ok(ledger.attempts.every(attempt => attempt.outcome === 'received'));
      assert.ok(new Set(ledger.assemblies.map(assembly => assembly.context!.windowId)).size > 1);
    } finally { probe.close(); }
    const target = openProbe(sandbox, undefined, undefined, result.targetBinding as Binding, undefined, true);
    try {
      for (const [runId, captured] of [[result.targetRunId, targetBodies], [result.proposalRunId, proposalBodies]] as const) {
        const ledger = target.store.requestStatus(target.activity, runId as string);
        assert.deepEqual(ledger.attempts.map(attempt => attempt.payloadHash), captured.map(body => sha256(body)));
        assert.ok(ledger.attempts.every(attempt => attempt.outcome === 'received'));
      }
    } finally { target.close(); }
  } finally {
    if (!cli.observations.some(event => event.event === 'process-exit')) { cli.child.kill('SIGKILL'); await cli.exit; }
    server.closeAllConnections(); server.close(); await once(server, 'close');
    rmSync(sandbox.root, { recursive: true, force: true }); rmSync(temp, { recursive: true, force: true });
  }
});
