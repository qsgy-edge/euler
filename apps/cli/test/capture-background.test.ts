import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { AGENT_BUDGET } from '../src/agent-cli.ts';
import { startCli } from '../src/process-driver.ts';
import { createSandbox, resourcesOf } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

async function fixture(hold = false) {
  const sandbox = createSandbox(), root = mkdtempSync(join(tmpdir(), 'capture-background-'));
  const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  const job = probe.store.queueOwnerCapture(probe.activity, probe.archive.append(randomUUID(), '记住：只使用合成证据'));
  probe.close();
  const bodies: string[] = [];
  let received!: () => void, release!: () => void;
  const requestReceived = new Promise<void>(resolve => { received = resolve; });
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'));
      release = () => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'null' } }], usage: { prompt_tokens: 30, completion_tokens: 1 } })); };
      received(); if (!hold) release();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const path = join(root, 'transport.json');
  writeFileSync(path, JSON.stringify({ provider: 'synthetic-http', model: 'background-test',
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, authNamespace: 'synthetic-http', credentialEnv: 'T13_BACKGROUND_TOKEN',
    contextWindow: 32000, maxTokens: 1024, budget: { ...AGENT_BUDGET, maxModelAttempts: 8 }, authorization: 'synthetic-test-only', captureCapability: 'standard' }));
  return { sandbox, job, bodies, requestReceived, release: () => release(),
    start: (command: string, ...args: string[]) => startCli([command, '--sandbox', sandbox.root, '--capture-config', path, ...args], 60000, undefined,
      { ...process.env, T13_BACKGROUND_TOKEN: 'SYNTHETIC-BACKGROUND-TOKEN' }),
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(sandbox.root, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); },
  };
}

test('an HTTP delivery killed before reply never reconciles against the empty local counting file', async () => {
  const f = await fixture(true), cli = f.start('capture-drain');
  try {
    await Promise.race([f.requestReceived, cli.waitFor('error').then(error => { throw new Error(JSON.stringify(error)); })]);
    cli.child.kill('SIGKILL'); await cli.exit;
    const probe = openProbe(f.sandbox, undefined, undefined, undefined, undefined, true);
    try { assert.throws(() => probe.store.reconcileCaptureJob(probe.activity, f.job.jobId), /reconciliation-reader-unavailable/); }
    finally { probe.close(); }
    const db = new DatabaseSync(resourcesOf(f.sandbox).store.path, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM request_attempts WHERE outcome='unknown-sent'").get()!.n, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM request_events WHERE kind='model/request-attempt-reconciled@v1'").get()!.n, 0);
    } finally { db.close(); }
    const retry = f.start('capture-drain'); assert.equal((await retry.exit).code, 0, retry.stderr());
    assert.equal(f.bodies.length, 1);
  } finally { if (cli.child.exitCode === null) cli.child.kill('SIGKILL'); await cli.exit; await f.close(); }
});

test('remember preserves piped startup commands while a configured background queue exists', async () => {
  const f = await fixture(), cli = f.start('remember');
  cli.child.stdin.end('info\nstop\n');
  try {
    assert.equal((await cli.exit).code, 0, cli.stderr());
    assert(cli.observations.some(item => item.event === 'info-list'), JSON.stringify(cli.observations.map(item => item.event)));
  } finally { if (cli.child.exitCode === null) cli.child.kill('SIGKILL'); await cli.exit; await f.close(); }
});

test('agent emits its foreground response and handles controls before the background reply', async () => {
  const f = await fixture(true), cli = f.start('agent', '--interactive');
  try {
    await cli.waitFor('agent-result');
    await Promise.race([f.requestReceived, cli.waitFor('capture-error').then(error => { throw new Error(JSON.stringify(error)); })]);
    cli.command('status');
    assert.equal((await cli.waitFor('agent-status')).terminal, 'completed');
    cli.command('follow-up');
    assert.equal((await cli.waitFor('agent-command-rejected')).reason, 'run-not-admissible');
    assert.equal(f.bodies.length, 1);
    cli.command('cancel'); assert.equal((await cli.exit).code, 0, cli.stderr());
  } finally { if (cli.child.exitCode === null) cli.child.kill('SIGKILL'); await cli.exit; await f.close(); }
});

test('owner agreement retains its displayed proposal across a background reply and restart', async () => {
  const f = await fixture(true);
  let cli = f.start('remember', '--synthetic-proposals');
  try {
    await cli.waitFor('remember-ready');
    await Promise.race([f.requestReceived, cli.waitFor('capture-error').then(error => { throw new Error(JSON.stringify(error)); })]);
    cli.command('propose 建议记住决定：可见的合成提议');
    const proposal = await cli.waitFor('assistant-proposal');
    f.release();
    await cli.waitFor('capture-queue');
    cli.command('stop'); assert.equal((await cli.exit).code, 0, cli.stderr());
    cli = f.start('remember', '--synthetic-proposals'); await cli.waitFor('remember-ready');
    const send = async (text: string, event = 'remember-result') => {
      const count = cli.observations.filter(item => item.event === event).length;
      cli.command(text);
      while (cli.observations.filter(item => item.event === event).length === count)
        await once(cli.child.stdout, 'data', { signal: AbortSignal.timeout(15000) });
      return cli.observations.filter(item => item.event === event)[count]!;
    };
    const agreed = await send('同意');
    assert.equal(agreed.status, 'activated');
    assert.equal((agreed.range as string[])[0], proposal.eventId);
    assert.equal((await send('同意')).reason, 'agreement-target-missing');
    await send('propose 建议记住决定：另一项可见提议', 'assistant-proposal');
    // A foreground JSON lookalike has no worker ownership and still invalidates its predecessor.
    await send('propose {"text":"null","calls":[],"stop":"end"}', 'assistant-proposal');
    assert.equal((await send('同意')).reason, 'agreement-target-missing');
    cli.command('stop'); assert.equal((await cli.exit).code, 0, cli.stderr());
    assert.equal(f.bodies.length, 1);
  } finally { if (cli.child.exitCode === null && cli.child.signalCode === null) cli.child.kill('SIGKILL'); await cli.exit; await f.close(); }
});

test('remember answers and stops while its background HTTP reply is withheld', async () => {
  const f = await fixture(true), cli = f.start('remember');
  try {
    await cli.waitFor('remember-ready');
    await Promise.race([f.requestReceived, cli.waitFor('capture-error').then(error => { throw new Error(JSON.stringify(error)); })]);
    cli.command('ask 合成问题');
    const answer = await cli.waitFor('ask-result');
    assert(answer.receipt); assert.equal(f.bodies.length, 1);
    cli.command('stop');
    assert.equal((await cli.exit).code, 0, cli.stderr());
    assert.equal(f.bodies.length, 1);
    const db = new DatabaseSync(resourcesOf(f.sandbox).store.path, { readOnly: true });
    try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM request_attempts WHERE adapter_version='capture-http@1' AND outcome='unknown-sent'").get()!.n, 1); }
    finally { db.close(); }
  } finally { if (cli.child.exitCode === null) cli.child.kill('SIGKILL'); await cli.exit; await f.close(); }
});
