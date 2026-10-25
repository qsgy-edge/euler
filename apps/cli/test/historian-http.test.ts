import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_BUDGET, sha256 } from '@euler/core';
import { startCli } from '../src/process-driver.ts';
import { createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

const prerequisiteFixture = new URL('./support/capture-prerequisite-fixture.mjs', import.meta.url).href;
for (const gate of ['full','reject'] as const) test('Historian CLI binds actual HTTP bytes and refuses a failed preflight: ' + gate, async () => {
  const sandbox = createSandbox(), temp = mkdtempSync(join(tmpdir(), 'euler-historian-http-'));
  const bodies: string[] = [];
  let serverError: unknown;
  const server = createServer(async (request, response) => {
    try {
      let body = ''; for await (const chunk of request) body += chunk;
      bodies.push(body);
      assert.equal(request.headers.authorization, 'Bearer synthetic-historian-key');
      const payload = JSON.parse(body);
      assert.match(body, /Synthetic intermediate inspection/);
      assert.ok(payload.messages.every((message: { role: string }) => message.role !== 'tool'));
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ result: 'pass', summary: 'HTTP synthetic observation completed.' }) }, finish_reason: 'stop' }],
        system: 'UNTRUSTED-HISTORIAN-INSTRUCTION', usage: { prompt_tokens: 12, completion_tokens: 5 } }));
    } catch (error) { serverError = error; response.statusCode = 500; response.end('{}'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const config = join(temp, 'route.json');
  writeFileSync(config, JSON.stringify({ provider: 'fixture', model: 'historian-http', baseUrl: 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1',
    authNamespace: 'synthetic-test', credentialEnv: 'EULER_HISTORIAN_TEST_KEY', contextWindow: 40000, maxTokens: 1024,
    captureCapability: 'standard', authorization: 'synthetic-test-only', budget: { ...DEFAULT_BUDGET, contextLimit: 40000, outputReserve: 1024,
      maxModelAttempts: 12, maxToolCalls: 12, maxTotalTokens: 600000, wallClockMs: 30000 } }));
  const cli = startCli(['historian', '--scenario', 'real', '--sandbox', sandbox.root, '--transport-config', config], 150000, undefined,
    { ...process.env, EULER_HISTORIAN_TEST_KEY: 'synthetic-historian-key', ...(gate === 'reject' ? {
      T13_PREREQUISITE_FIXTURE: 'reject', NODE_OPTIONS: (process.env.NODE_OPTIONS ?? '') + ' --import=' + prerequisiteFixture,
    } : {}) });
  try {
    const preflight = await cli.waitFor('historian-prerequisites');
    assert.equal(preflight.passed, gate !== 'reject');
    assert.doesNotMatch(JSON.stringify(cli.observations) + cli.stderr(), /synthetic-historian-key|UNTRUSTED-HISTORIAN-INSTRUCTION/);
    if (gate === 'reject') { assert.equal((await cli.exit).code, 1); assert.equal(bodies.length, 0); return; }
    assert.ok((preflight.command as string[]).includes('apps/cli/test/historian.test.ts'));
    const result = await cli.waitFor('historian-result');
    assert.equal((await cli.exit).code, 0, cli.stderr() + JSON.stringify(cli.observations.filter(item => item.event === 'error')));
    assert.ifError(serverError);
    assert.equal(bodies.length, 1); assert.equal(result.selected, true); assert.equal(result.reopened, true);
    const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
    try {
      const compartment = probe.store.readCompartment(probe.activity, String(result.jobId));
      assert.equal(compartment.body.summary, 'HTTP synthetic observation completed.');
      const observed = cli.observations.find(event => event.event === 'historian-request')!;
      const request = observed.request as { payload: string; payloadHash: string };
      assert.equal(request.payload, bodies[0]); assert.equal(request.payloadHash, sha256(bodies[0]!));
      assert.equal(compartment.attemptId, observed.attemptId);
    } finally { probe.close(); }
  } finally {
    if (!cli.observations.some(event => event.event === 'process-exit')) { cli.child.kill('SIGKILL'); await cli.exit; }
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(temp, { recursive: true, force: true }); rmSync(sandbox.root, { recursive: true, force: true });
  }
});
