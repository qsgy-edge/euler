import { randomUUID } from 'node:crypto';
import koffi from 'koffi';
import { AgentRun, check, fileIdentity } from '@euler/core';
import { AGENT_BUDGET } from '../src/agent-cli.ts';
import { openSandbox, bindingOf } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';
import { createFileToolHost } from '../src/file-tools.ts';
import { pumpAgent } from '../src/agent-pump.ts';

const [sandboxPath, root, phase] = process.argv.slice(2);
check(sandboxPath && root && ['before-io', 'after-flush', 'filter-denial'].includes(phase!), 'invalid-test-phase');
if (phase === 'filter-denial') {
  // Isolated external-API fault: emulate FltCancelFileOpen's documented outcome
  // using a real NTFS create, then close its handle and return denied/no handle.
  // This does not install a kernel filter or change the production Host API.
  const load = koffi.load;
  const close = load('kernel32.dll').func('int __stdcall CloseHandle(void *handle)');
  Object.defineProperty(koffi, 'load', { value: (name: string) => {
    const library = load(name);
    if (name !== 'ntdll.dll') return library;
    return new Proxy(library, { get(target, key) {
      if (key !== 'func') return Reflect.get(target, key);
      return (...signature: unknown[]) => {
        const fn = Reflect.apply(target.func, target, signature) as (...args: unknown[]) => number;
        if (!signature.includes('NtCreateFile')) return fn;
        return (...args: unknown[]) => {
          const status = fn(...args);
          if (args[7] === 2 && status >= 0) {
            const handles = args[0] as (bigint | null)[];
            check(handles[0] && close(handles[0]), 'test-filter-close-failed');
            handles[0] = null;
            return 0xc0000022 | 0;
          }
          return status;
        };
      };
    } });
  } });
}
const sandbox = openSandbox(sandboxPath);
const budget = { ...AGENT_BUDGET, wallClockMs: 60000, toolTimeoutMs: 60000 };
const probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
const binding = bindingOf(sandbox);
const run = new AgentRun(probe.store, probe.activity, { binding, source: probe.archive,
  files: { schema: 'file-capability@1', grantId: randomUUID(), binding, root: { path: root, identity: fileIdentity(root) },
    source: probe.archive.append(randomUUID(), 'Owner binds the disposable crash-test project root', 'user') } },
  { provider: 'fake', model: 'crash', route: 'fixture', authNamespace: 'synthetic' }, budget);
run.receive(randomUUID(), 'Create only crash.txt with synthetic content after independent test-owner approval.');
const native = createFileToolHost(async () => 'approved');
const pause = async () => {
  process.stdin.resume();
  process.stdout.write(JSON.stringify({ event: 'file-crash-barrier', phase, pid: process.pid, runId: run.runId }) + '\n');
  await new Promise<void>(() => {});
};
try {
  const status = await pumpAgent(run, {
    async *stream(request, _signal, send) {
      send(request.payload);
      yield { kind: 'complete', reply: { text: '', stop: 'tools', calls: [
        { id: 'write', name: 'file.write', arguments: { path: 'crash.txt', content: 'DURABLE SYNTHETIC COPY' } },
        { id: 'next', name: 'controlled.echo', arguments: { text: 'MUST NOT RUN' } },
      ] } };
    },
    async execute() { throw new Error('not-used'); },
    ...native,
    async prepareFile(call, capability, signal) {
      const file = await native.prepareFile!(call, capability, signal);
      return { ...file, async execute() {
        if (phase === 'before-io') await pause();
        const receipt = await file.execute();
        if (phase === 'after-flush') await pause();
        return receipt;
      } };
    },
  });
  process.stdout.write(JSON.stringify({ event: 'file-operation-result', runId: run.runId, status }) + '\n');
} finally { probe.close(); }
