import { writeSync } from 'node:fs';

/**
 * Test-only kill point: announce the stage on stdout, then hold the process (and any open
 * transaction) so the parent can SIGKILL it at exactly this boundary.
 */
export function killPoint(event: string, stage: string, waitMs: number): never {
  writeSync(1, JSON.stringify({ event, stage, pid: process.pid }) + '\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
  throw new Error('checkpoint-was-not-killed');
}
