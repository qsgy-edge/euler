import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export interface Observation { event: string; [key: string]: unknown }
export const cliEntry = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './main.ts' : './main.js', import.meta.url));

// Drives only this repository's synthetic CLI, never arbitrary commands.
export function startCli(args: string[], timeoutMs = 15000, cwd?: string) {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [cliEntry, ...args], { stdio: 'pipe', windowsHide: true, ...(cwd ? { cwd } : {}) });
  const observations: Observation[] = [];
  const waiters = new Set<() => void>();
  let stderr = '';
  let failure: Error | null = null;
  let exited = false;
  child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-65536); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try { observations.push(JSON.parse(line) as Observation); }
    catch { failure = new Error(`invalid CLI output: ${line.slice(0, 200)}`); }
    for (const waiter of waiters) waiter();
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', error => { failure = error; reject(error); for (const waiter of waiters) waiter(); });
    child.once('close', (code, signal) => {
      exited = true;
      observations.push({ event: 'process-exit', pid: child.pid, code, signal });
      resolve({ code, signal });
      for (const waiter of waiters) waiter();
    });
  });
  // Kept observed even if a spawn error precedes a caller's explicit exit await.
  void exit.catch(() => {});
  function waitFor(event: string): Promise<Observation> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`observation-timeout: ${event}; ${stderr}`)), timeoutMs);
      function finish(error?: Error, value?: Observation) {
        clearTimeout(timer);
        waiters.delete(check);
        if (error) reject(error); else resolve(value!);
      }
      function check() {
        const value = observations.find(item => item.event === event);
        if (value) finish(undefined, value);
        else if (failure || exited) finish(failure ?? new Error(`process exited before ${event}: ${stderr}`));
      }
      waiters.add(check);
      check();
    });
  }
  function command(value: string) { child.stdin.write(value + '\n'); }
  return { child, observations, exit, waitFor, command, stderr: () => stderr };
}
