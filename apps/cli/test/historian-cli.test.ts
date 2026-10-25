import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import test from 'node:test';

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
