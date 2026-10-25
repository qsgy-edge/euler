import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { createSandbox } from '../src/sandbox.ts';
import { runHistorianDemo } from '../src/historian.ts';

test('the controlled Historian CLI generates, selects and reopens one stable compartment', () => {
  const output = execFileSync(process.execPath, ['apps/cli/src/main.ts', 'historian'], { encoding: 'utf8', timeout: 20000 });
  const events = output.trim().split(/\r?\n/u).map(line => JSON.parse(line));
  const sandbox = events.find(event => event.event === 'sandbox');
  try {
    const result = events.find(event => event.event === 'historian-result');
    assert.equal(result.stage, 'complete');
    assert.equal(result.selected, true);
    assert.equal(result.backgroundAttempts, 1);
    assert.equal(result.reopened, true);
    assert.equal(result.foregroundTerminal, 'completed');
  } finally { if (sandbox) rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('the unknown fixture propagates an unexpected output failure after the send', async context => {
  const sandbox = createSandbox(), failure = new Error('unexpected-output-failure');
  context.mock.method(console, 'log', (line: string) => {
    if (JSON.parse(line).event === 'historian-request') throw failure;
  });
  try { await assert.rejects(runHistorianDemo(sandbox, 'unknown'), error => error === failure); }
  finally { rmSync(sandbox.root, { recursive: true, force: true }); }
});
