import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentRun, DEFAULT_BUDGET, fileIdentity } from '@euler/core';
import type { FileCapability } from '@euler/core';
import { openSandbox, bindingOf } from '../../src/sandbox.ts';
import { openProbe } from '../../src/probe.ts';
import { createFileToolHost } from '../../src/file-tools.ts';
import { pumpAgent } from '../../src/agent-pump.ts';

const [sandboxPath, root, decision = 'approved'] = process.argv.slice(2);
const sandbox = openSandbox(sandboxPath!);
const budget = { ...DEFAULT_BUDGET, contextLimit: 32000, maxTotalTokens: 128000, maxToolCalls: 8, maxModelAttempts: 3, toolTimeoutMs: 2000, wallClockMs: 30000 };
const probe = openProbe(sandbox,budget);
try {
  const source = probe.archive.append(randomUUID(),'Owner binds this disposable test project for a controlled file write.','user');
  const files: FileCapability = { schema: 'file-capability@1', grantId: randomUUID(), binding: bindingOf(sandbox),
    root: { path: root!, identity: fileIdentity(root!) }, source };
  const run = new AgentRun(probe.store,probe.activity,{ binding: bindingOf(sandbox),source: probe.archive,files },
    { provider: 'fake',model: 'test',route: 'fixture',authNamespace: 'none' },budget);
  run.receive(sandbox.fixture.eventId,sandbox.fixture.text);
  let count = 0;
  const result = await pumpAgent(run,{ ...createFileToolHost(async () => decision === 'rejected' ? 'rejected' : 'approved'), async *stream(request,_signal,send) {
    send(request.payload); yield { kind: 'complete',reply: ++count === 1
      ? { text: '',stop: 'tools',calls: [{ id: 'project-output',name: 'file.write',arguments: { path: 'result.md',content: 'EULER-T20 controlled project output' } }] }
      : { text: 'Done',stop: 'end',calls: [] } };
  },async execute() { throw new Error('unexpected-non-file-tool'); } });
  assert.equal(result.terminal,'completed');
  if (decision === 'approved') assert.equal(readFileSync(join(root!,'result.md'),'utf8'),'EULER-T20 controlled project output');
  console.log(JSON.stringify({ controlledFiles: probe.store.maintenanceStatus().controlledFiles }));
} finally { probe.close(); }
