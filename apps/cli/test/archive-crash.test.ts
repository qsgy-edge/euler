import test from 'node:test';
import { join } from 'node:path';
import { archiveCrashCases, runArchiveCrashCase } from './support/archive-evidence.ts';

const directory = join('artifacts', `archive-crash-${process.platform}-${Date.now()}`);
for (const { scenario, point } of archiveCrashCases) {
  test(`archive ${scenario} survives real process death at ${point}`, { timeout: 30000 }, async () => {
    await runArchiveCrashCase(join(directory, `${scenario}-${point}`), scenario, point);
  });
}
