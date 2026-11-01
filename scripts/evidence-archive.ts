import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, release } from 'node:os';
import { join } from 'node:path';
import { archiveCrashCases, artifactFiles, runArchiveCrashCase } from '../apps/cli/test/support/archive-evidence.ts';

const directory = process.argv[2] ?? join('artifacts', `archive-${process.platform}-${Date.now()}`);
mkdirSync(directory, { recursive: true });
const startedAt = new Date().toISOString();
const cases: Awaited<ReturnType<typeof runArchiveCrashCase>>[] = [];
let failure: string | null = null;
try {
  for (const { scenario, point } of archiveCrashCases) {
    cases.push(await runArchiveCrashCase(join(directory, `${scenario}-${point}`), scenario, point));
  }
  assert.equal(cases.length, archiveCrashCases.length);
} catch (error) { failure = error instanceof Error ? error.stack ?? error.message : String(error); }
const files = artifactFiles(directory);
for (const file of files) assert.equal(createHash('sha256').update(readFileSync(join(directory, file.path))).digest('hex'), file.hash);
const receipt = {
  schema: 'archive-reconciliation-evidence@1', issue: 38, experimentIds: ['X-04', 'X-11'],
  status: failure ? 'fail' : 'pass', startedAt, finishedAt: new Date().toISOString(),
  command: [process.execPath, ...process.execArgv, ...process.argv.slice(1)],
  implementationCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workingTree: execFileSync('git', ['status', '--short'], { encoding: 'utf8' }).trim(),
  diffHash: createHash('sha256').update(execFileSync('git', ['diff', 'HEAD'])).digest('hex'),
  environment: { platform: process.platform, release: release(), arch: arch(), node: process.version, provider: 'none' },
  cases, files, failure,
  verification: 'Actual child SIGKILL at OS write/flush/readback and Store commit boundaries; raw SQLite and archive hashes recomputed independently of product replay.',
  scope: 'Synthetic CLI archive reconciliation on the recorded host; no provider calls, production data, Pi integration or power-loss claim.',
};
writeFileSync(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ directory, status: receipt.status, cases: cases.length, failure }));
if (failure) process.exitCode = 1;
