// Control the prerequisite process only in synthetic CLI lifecycle tests.
// capture-cooperative.test.ts exercises the full prerequisite suite over real HTTP.
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const cli = process.argv[1]?.replaceAll('\\', '/').endsWith('/apps/cli/src/main.ts');
if (cli && ['accept', 'reject'].includes(process.env.T13_PREREQUISITE_FIXTURE)) {
  const execFile = cp.execFile;
  cp.execFile = (file, args, ...rest) => {
    const fixture = args?.includes('apps/cli/test/capture.test.ts') ? 'capture'
      : args?.includes('apps/cli/test/memory-correction.test.ts') ? 'correction'
      : args?.includes('apps/cli/test/context-window.test.ts') ? 'context' : null;
    if (file === process.execPath && args?.[0] === '--test' && fixture) {
      const status = process.env.T13_PREREQUISITE_FIXTURE === 'reject' ? 1 : 0;
      // The Host records this exact fixture command, not a claim that the full suite ran here.
      args.splice(0, args.length, '-e', `console.log('${fixture}-prerequisite-fixture');process.exitCode=${status}`);
    }
    return execFile(file, args, ...rest);
  };
  syncBuiltinESMExports();
}
