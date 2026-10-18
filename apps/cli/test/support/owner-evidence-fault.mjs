// Fault injection confined to the evidence runner and its direct CLI children.
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const runner = process.argv[1]?.replaceAll('\\', '/').endsWith('/scripts/evidence-owner-memory.ts');
const cli = process.argv[1]?.replaceAll('\\', '/').endsWith('/apps/cli/src/main.ts');
const body = '数据库使用 Postgres';
if (runner) {
  process.env.T12_FAULT_PARENT = String(process.pid);
  if (process.env.T12_FAULT === 'spawn') {
    const spawn = cp.spawn;
    cp.spawn = (exe, args, options) => spawn(exe, args, { ...options, cwd: process.env.T12_ABSENT_CWD });
    syncBuiltinESMExports();
  }
  if (process.env.T12_FAULT === 'receipt') {
    const stringify = JSON.stringify;
    JSON.stringify = function(value, ...args) {
      if (value?.schema === 't12-owner-memory-evidence@1') {
        value.rawValidation = { status: 'fail', error: 'injected raw assertion body: ' + body };
        value.assertions.push({ name: 'injected', passed: false, error: body });
      }
      return stringify(value, ...args);
    };
  }
}
if (cli && String(process.ppid) === process.env.T12_FAULT_PARENT && process.env.T12_FAULT === 'stdout') {
  const write = process.stdout.write.bind(process.stdout);
  let injected = false;
  process.stdout.write = function(chunk, ...args) {
    if (!injected && String(chunk).includes('remember-ready')) {
      injected = true;
      write('invalid-CLI-output ' + body + '\n');
    }
    return write(chunk, ...args);
  };
}
