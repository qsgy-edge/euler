import { spawnSync } from 'node:child_process';

export function runBackupCli(root: string, command: string, args: string[] = [], input?: string) {
  const result = spawnSync(process.execPath, ['apps/cli/src/main.ts', command, '--sandbox', root, ...args],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, ...(input === undefined ? {} : { input }) });
  return { ...result, events: result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}
