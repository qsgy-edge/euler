import { randomUUID } from 'node:crypto';
import { bindingOf, createSandboxSession, openSandbox } from '../../src/sandbox.ts';
import { openProbe } from '../../src/probe.ts';

const [root, sourceJson] = process.argv.slice(2);
const sandbox = openSandbox(root!);
const binding = { ...bindingOf(sandbox), sessionId: randomUUID(), branchId: randomUUID() };
createSandboxSession(sandbox, binding);
const probe = openProbe(sandbox, undefined, undefined, binding, undefined, true);
try {
  const related = probe.archive.append(randomUUID(), JSON.stringify({ source: JSON.parse(sourceJson!) }), 'tool');
  const unrelated = probe.archive.append(randomUUID(), 'T22a independent later-session note.');
  console.log(JSON.stringify({ binding, related, unrelated, source: probe.store.sessionSource(binding) }));
} finally { probe.close(); }
