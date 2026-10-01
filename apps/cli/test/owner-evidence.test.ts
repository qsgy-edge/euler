import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { sha256 } from '@euler/core';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const preload = new URL('./support/owner-evidence-fault.mjs', import.meta.url).href;
for (const fault of ['stdout', 'spawn', 'receipt']) {
  test(`evidence runner retains real failure evidence and does not leak bodies: ${fault}`, () => {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${preload}`,
      T12_FAULT: fault, T12_ABSENT_CWD: join(tmpdir(), `absent-${randomUUID()}`) };
    // This is a new top-level runner, not a recursively nested node:test worker.
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [join(repo, 'scripts/evidence-owner-memory.ts')], {
      cwd: repo, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024,
      env,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    const consoleResult = JSON.parse(result.stdout.trim());
    const path = resolve(repo, consoleResult.path);
    assert.equal(dirname(dirname(path)), join(repo, 'artifacts'));
    const directory = dirname(path);
    let verified = false;
    try {
      const bytes = readFileSync(path, 'utf8');
      assert.equal(bytes.includes('数据库使用 Postgres'), false);
      assert.equal(result.stdout.includes('数据库使用 Postgres'), false);
      const receipt = JSON.parse(bytes);
      assert.equal(receipt.status, 'fail');
      assert.ok(existsSync(join(directory, 'raw/main/probe.sqlite')));
      if (fault === 'receipt') {
        assert.equal(receipt.reason, 'receipt-body-rejected');
        const rejected = readFileSync(join(directory, receipt.raw.path));
        assert.equal(sha256(rejected), receipt.raw.sha256);
        assert.ok(rejected.toString().includes('数据库使用 Postgres'));
      } else {
        assert.equal(receipt.receiptError, null);
        assert.equal(receipt.focusedPass, true, `retained ${directory}\n${readFileSync(join(directory, 'focused-test.txt'), 'utf8')}`);
        const child = receipt.processes.find((item: { label: string }) => item.label === 'main');
        assert.ok(child);
        for (const stream of [child.stdout, child.stderr]) {
          assert.equal(sha256(readFileSync(join(directory, stream.path))), stream.sha256);
        }
        if (fault === 'stdout') {
          assert.equal(child.signal, 'SIGKILL');
          assert.ok(readFileSync(join(directory, child.stdout.path), 'utf8').includes('invalid-CLI-output'));
        }
        for (const effect of receipt.controlledSideEffects) {
          assert.equal(existsSync(effect.path), effect.disposition === 'retain');
        }
      }
      verified = true;
    } finally { if (verified) rmSync(directory, { recursive: true, force: true }); }
  });
}
