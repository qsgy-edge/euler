import assert from 'node:assert/strict';
import type { MemoryPresentation, SourceAck } from '@euler/core';
import type { Sandbox } from '../../src/sandbox.ts';
import { openProbe } from '../../src/probe.ts';
import type { startCli } from '../../src/process-driver.ts';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

/** Hold one actual stdout write without blocking the CLI's live stdin callback. */
export function delayedCliOutput(sandbox: Sandbox, command: string, event: string) {
  const directory = mkdtempSync(join(tmpdir(), 'euler-cli-output-'));
  const preload = join(directory, 'delay.mjs'), released = join(directory, 'released');
  const held = join(directory, 'held'), received = join(directory, 'received'), ended = join(directory, 'ended');
  writeFileSync(preload, `import { existsSync, writeFileSync } from 'node:fs';
if (process.argv.includes(${JSON.stringify(command)}) && process.argv.includes(${JSON.stringify(sandbox.root)})) {
  const write = process.stdout.write.bind(process.stdout);
  let delayed = false;
  process.stdout.write = (chunk, ...args) => {
    if (!delayed && typeof chunk === 'string' && chunk.startsWith(${JSON.stringify(`{"event":"${event}",`)})) {
      delayed = true;
      process.stdin.once('data', () => writeFileSync(${JSON.stringify(received)}, 'received'));
      process.stdin.once('end', () => writeFileSync(${JSON.stringify(ended)}, 'ended'));
      writeFileSync(${JSON.stringify(held)}, 'held');
      const deliver = () => existsSync(${JSON.stringify(released)}) ? write(chunk, ...args) : setTimeout(deliver, 10);
      setTimeout(deliver, 10);
      return false;
    }
    return write(chunk, ...args);
  };
}`);
  return { preload, held, received, ended, env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}` },
    release() { writeFileSync(released, 'release'); }, close() { rmSync(directory, { recursive: true, force: true }); } };
}

export async function bufferedCorrectionApproval(cli: ReturnType<typeof startCli>, sandbox: Sandbox, recordId: string, content: string,
  output: ReturnType<typeof delayedCliOutput>) {
  const from = cli.observations.length;
  const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  let preview: MemoryPresentation | undefined, early: SourceAck | undefined;
  try {
    cli.command(`correct ${recordId} ${JSON.stringify(content)}`);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      preview = probe.store.recoverMemoryOperations(probe.activity).find(row => row.result.status === 'pending')?.presentation;
      if (preview) break;
      assert.equal(cli.observations.some(row => row.event === 'process-exit'), false, cli.stderr());
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(preview, 'durable preview was not created');
    const text = `commit ${preview.token} ${JSON.stringify(content)}`;
    cli.command(text);
    while (Date.now() < deadline) {
      early = probe.archive.events().find(row => row.role === 'user' && row.text === text)?.ack;
      if (early) break;
      assert.equal(cli.observations.some(row => row.event === 'process-exit'), false, cli.stderr());
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(early, 'Host did not durably receive approval while preview output was held');
    assert.equal(probe.store.memoryOperationStatus(probe.activity, preview.token).status, 'pending');
  } finally { probe.close(); output.release(); }
  const shown = await cli.waitFor('memory-preview', from);
  assert.equal(shown.token, preview.token);
  const rejected = await cli.waitFor('memory-result', from);
  return { preview, early, rejected };
}
