import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AgentRun, CaptureRun, DEFAULT_BUDGET, GuidanceSession, fileIdentity, sha256 } from '@euler/core';
import type { Activity, AgentHost, ModelReply, ModelRequest, ModelRoute, NeutralRequest, RequestAttempt } from '@euler/core';
import { HttpModelTransport } from '../apps/cli/src/model-transport.ts';
import type { TransportObservation } from '../apps/cli/src/model-transport.ts';
import { bindingOf, createSandbox } from '../apps/cli/src/sandbox.ts';
import { openProbe } from '../apps/cli/src/probe.ts';

const budget = { ...DEFAULT_BUDGET, contextLimit: 64000, outputReserve: 1024, maxModelAttempts: 40, maxToolCalls: 40, maxTotalTokens: 1_000_000 };
const echo = (id: string, text = ''): ModelReply => ({ text, stop: 'tools', calls: [{ id, name: 'controlled.echo', arguments: { text: id } }] });
const end: ModelReply = { text: 'IDENTITY-OK', stop: 'end', calls: [] };
type Sender = Pick<AgentRun, 'nextModel' | 'startModel' | 'maySend' | 'finishModel'> & { runId: string };

/** Fixed local probes of existing public Core interfaces; never selects a remote endpoint. */
export async function measureProviderIdentities(directory: string) {
  mkdirSync(directory, { recursive: true });
  const cases: { name: string; passed: boolean; sends: number; received: number; transportCount: number }[] = [];
  let replies: (ModelReply | number)[] = [], received: string[] = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    received.push(body);
    const reply = replies.shift();
    if (typeof reply === 'number') {
      if (reply === 0) { response.writeHead(200); response.write('{'); setImmediate(() => response.destroy()); }
      else { response.writeHead(reply); response.end('{}'); }
      return;
    }
    if (!reply) { response.writeHead(500); response.end('{}'); return; }
    response.end(JSON.stringify({ model: 'identity-fixture', choices: [{ finish_reason: reply.calls.length ? 'tool_calls' : 'stop',
      message: { role: 'assistant', content: reply.text, ...(reply.calls.length ? { tool_calls: reply.calls.map(call => ({
        id: call.id, type: 'function', function: { name: call.name.replaceAll('.', '_'), arguments: JSON.stringify(call.arguments) } })) } : {}) } }],
      usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const route: ModelRoute = { provider: 'fixture', model: 'identity-fixture',
    route: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, authNamespace: 'synthetic' };
  try {
    for (const name of ['stable-p3', 'fresh-same-prefix', 'namespace-and-binding', 'guidance-release', 'historian-selection', 'emergency', 'emergency-write-failure', 'ledger-retry-schema-order']) {
      const path = join(directory, name); mkdirSync(path);
      const sandbox = createSandbox(), probe = openProbe(sandbox, budget, undefined, undefined, undefined, true);
      const sends: { request: ModelRequest; attempt: RequestAttempt; observation: TransportObservation; neutral: NeutralRequest | null }[] = [];
      const neutrals = new Map<string, NeutralRequest>(), runs: Sender[] = [];
      const activities = new Map<string, Activity>();
      const transports: HttpModelTransport[] = [];
      const checkpoints: Record<string, unknown>[] = [];
      replies = []; received = [];
      let release: (() => void) | undefined, passed = false;
      const makeTransport = (binding = route) => {
        const transport = new HttpModelTransport({ api: 'openai-completions', provider: binding.provider, id: binding.model, name: binding.model,
          baseUrl: binding.route, reasoning: false, input: ['text'], contextWindow: 64000, maxTokens: 1024,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, budget, () => 'identity-fixture-key');
        transports.push(transport); return transport;
      };
      const host = (transport: HttpModelTransport): AgentHost => ({ binding: bindingOf(sandbox), source: probe.archive,
        encode: neutral => { const payload = transport.encode(neutral); neutrals.set(sha256(payload), neutral); return payload; } });
      const agent = (transport: HttpModelTransport, binding = route, extra: Partial<AgentHost> = {}) => {
        const run = new AgentRun(probe.store, probe.activity, { ...host(transport), ...extra }, binding, budget);
        runs.push(run); activities.set(run.runId, probe.activity); run.receive(randomUUID(), 'Retain the fixed synthetic identity goal.'); return run;
      };
      const dispatch = async (run: Sender, transport: HttpModelTransport, reply: ModelReply | number, prepared = run.nextModel()!) => {
        assert.ok(prepared); replies.push(reply);
        let attempt: RequestAttempt | undefined, observed: TransportObservation | undefined;
        const count = transport.count;
        try {
          for await (const event of transport.stream(prepared, AbortSignal.timeout(10000), payload => {
            assert.equal(attempt, undefined);
            attempt = run.startModel(prepared, payload); assert.equal(run.maySend(attempt.attemptId, payload), true); return attempt;
          }, observation => { observed = observation; })) run.finishModel(attempt!.attemptId, event.reply);
        } finally {
          if (transport.count === count) replies.pop();
          if (attempt && observed) sends.push({ request: prepared, attempt, observation: observed, neutral: neutrals.get(prepared.payloadHash) ?? null });
        }
        const ledger = probe.store.requestStatus(activities.get(run.runId)!, run.runId);
        const assembly = ledger.assemblies.find(item => item.assemblyId === prepared.assemblyId)!;
        checkpoints.push({ runId: run.runId, assembly, attempt: ledger.attempts.find(item => item.attemptId === attempt!.attemptId) });
        return { request: prepared, assembly, neutral: neutrals.get(prepared.payloadHash)! };
      };
      const finishEcho = (run: AgentRun, id: string) => {
        assert.equal(run.startTool(id)?.name, 'controlled.echo');
        run.finishTool(id, `Result ${id}: exact value 47; fixture.ts:19`);
      };
      const stable = (value: { request: ModelRequest; neutral: NeutralRequest }) => {
        const data = JSON.parse(value.request.payload);
        const count = 1 + (value.neutral.p0.guidance?.length || value.neutral.p0.guidanceRules ? 1 : 0) + (Object.keys(value.neutral.p1).length ? 1 : 0);
        return JSON.stringify({ tools: data.tools, messages: data.messages.slice(0, count) });
      };
      try {
        const transport = makeTransport();
        if (name === 'ledger-retry-schema-order') {
          const template = agent(transport), first = template.nextModel()!;
          const neutral = structuredClone(neutrals.get(first.payloadHash)!);
          template.cancel();
          const intent = probe.store.readIntent(probe.activity)!;
          const runId = randomUUID();
          probe.store.authorizeRequestRun(probe.activity, runId, { budget, intent: { eventId: intent.eventId, hash: intent.hash }, relatedRunId: null, acceptDuplicateRisk: false });
          const assemble = (value: NeutralRequest) => {
            const payload = transport.encode(value); neutrals.set(sha256(payload), value);
            const assembly = probe.store.appendRequestAssembly(probe.activity, { runId, epoch: probe.activity.epoch,
              route: JSON.stringify(route), model: route.model, policyHash: sha256(JSON.stringify(value.p0)), estimator: 'utf8-bytes-upper-bound@1',
              sources: [intent.goalInput], intent: { eventId: intent.eventId, hash: intent.hash }, payload, payloadHash: sha256(payload), byteLength: Buffer.byteLength(payload),
              estimatedTokens: Buffer.byteLength(payload), budget,
              zones: { p0: Buffer.byteLength(JSON.stringify(value.p0)), p1: 2, p2: 2, p3: Buffer.byteLength(JSON.stringify(value.p3)) },
              selection: [{ ordinal: 0, hash: intent.goalInput.hash, reason: 'mandatory-source' }], degradation: 'none' });
            return { assemblyId: assembly.assemblyId, payload, payloadHash: sha256(payload) };
          };
          let current = assemble(neutral);
          const sender: Sender = { runId, nextModel: () => current,
            startModel(request, payload) {
              probe.store.assertDispatchBoundary(); assert.equal(request.payload, payload);
              return probe.store.startRequestAttempt(probe.activity, { runId, assemblyId: request.assemblyId,
                payloadHash: sha256(payload), byteLength: Buffer.byteLength(payload), adapterVersion: 'provider-ledger-fixture@1' });
            },
            maySend(attemptId, payload) {
              const attempt = probe.store.requestStatus(probe.activity, runId).attempts.find(item => item.attemptId === attemptId)!;
              assert.equal(attempt.payloadHash, sha256(payload));
              return probe.store.requestMaySend(probe.activity, runId);
            },
            finishModel(attemptId, reply) { probe.store.finishRequestAttempt(probe.activity, { attemptId, outcome: 'received',
              usage: { count: 1, finishReason: reply.stop, ...(reply.usage ? { inputTokens: reply.usage.input, outputTokens: reply.usage.output } : {}) } }); },
          };
          runs.push(sender); activities.set(runId, probe.activity);
          const failed = await dispatch(sender, transport, 503);
          const retry = await dispatch(sender, transport, end);
          assert.equal(failed.assembly.assemblyId, retry.assembly.assemblyId);
          assert.deepEqual(sends.map(send => send.attempt.ordinal), [1, 2]);
          const schema = structuredClone(neutral);
          schema.p0.tools[0]!.parameters = { ...schema.p0.tools[0]!.parameters, title: 'Synthetic schema revision' };
          current = assemble(schema);
          const changed = await dispatch(sender, transport, end);
          assert.notEqual(changed.assembly.assemblyId, retry.assembly.assemblyId);
          const order = structuredClone(neutral); order.p0.tools.reverse(); current = assemble(order);
          const reordered = await dispatch(sender, transport, end);
          assert.notEqual(reordered.assembly.assemblyId, retry.assembly.assemblyId);
          assert.notEqual(reordered.request.payload, retry.request.payload);
          await assert.rejects(dispatch(sender, transport, 0));
          const count = received.length;
          await assert.rejects(dispatch(sender, transport, end), /unknown/);
          assert.equal(received.length, count);
          checkpoints.push({ scope: 'Host-owned ledger serialization/retry; no AgentRun rebind or epoch-reuse claim' });
        } else if (name === 'namespace-and-binding') {
          const base = await dispatch(agent(transport), transport, end);
          for (const key of ['provider', 'model', 'route', 'authNamespace'] as const) {
            const binding = { ...route, [key]: route[key] + '-other' };
            const otherTransport = makeTransport(binding);
            const changed = await dispatch(agent(otherTransport, binding), otherTransport, end);
            assert.notEqual(changed.assembly.context!.prefixHash, base.assembly.context!.prefixHash);
            assert.notEqual(changed.assembly.context!.cacheEpoch, base.assembly.context!.cacheEpoch);
            assert.notEqual(changed.assembly.assemblyId, base.assembly.assemblyId);
          }
          const bound = await dispatch(agent(transport, route, { memoryCorrections: true }), transport, end);
          assert.notDeepEqual(bound.neutral.p0.tools, base.neutral.p0.tools);
          assert.notEqual(bound.assembly.context!.prefixHash, base.assembly.context!.prefixHash);
        } else if (name === 'guidance-release' || name.startsWith('emergency')) {
          const root = join(sandbox.root, 'project'), skillRoot = join(root, '.agents', 'skills', 'identity');
          mkdirSync(skillRoot, { recursive: true });
          writeFileSync(join(root, 'AGENTS.md'), 'Keep the synthetic identity marker A.');
          writeFileSync(join(skillRoot, 'SKILL.md'), '---\nname: identity\ndescription: identity fixture\n---\nSKILL-IDENTITY-BYTES\n');
          const input = probe.archive.append(randomUUID(), 'Retain the fixed synthetic identity goal.');
          probe.store.transitionIntent(probe.activity, null, input, { status: 'active', step: 'identity' }, 'Retain the fixed synthetic identity goal.');
          const session = new GuidanceSession(probe.store, probe.activity, probe.archive, {
            dataRoot: { path: sandbox.root, identity: fileIdentity(sandbox.root) },
            projects: [{ projectId: sandbox.fixture.projectId, root: { path: root, identity: fileIdentity(root) } }], sharedSkills: null, sources: [],
          });
          const target = { projectId: sandbox.fixture.projectId, path: join(root, 'fixture.ts') };
          session.activate(session.select('identity', target.projectId).selected, target.projectId, 'owner-explicit');
          const extra = { guidance: { session, targets: [target], operation: { name: 'synthetic.read' as const, targets: [target.path] } } };
          const run = agent(transport, route, extra);
          const before = await dispatch(run, transport, echo('first')); finishEcho(run, 'first');
          if (name === 'guidance-release') {
            writeFileSync(join(root, 'AGENTS.md'), 'Keep the synthetic identity marker B.');
            const changed = await dispatch(run, transport, end);
            assert.notEqual(before.assembly.context!.cacheEpoch, changed.assembly.context!.cacheEpoch);
            assert.match(changed.request.payload, /marker B/);
            const intent = probe.store.readIntent(probe.activity)!;
            probe.store.transitionIntent(probe.activity, intent.eventId, probe.archive.append(randomUUID(), 'Complete the identity task.'), { status: 'completed', step: 'complete' });
            assert.equal(session.prepare([target]).snapshot.activations.length, 0);
            const next = await dispatch(agent(transport, route, extra), transport, end);
            assert.doesNotMatch(next.request.payload, /SKILL-IDENTITY-BYTES/);
            assert.notEqual(changed.assembly.context!.prefixHash, next.assembly.context!.prefixHash);
          } else {
            const prepared = run.nextModel()!;
            const original = probe.store.requestStatus(probe.activity, run.runId).attempts;
            writeFileSync(join(root, 'AGENTS.md'), 'Emergency: require identity marker C.');
            const exec = DatabaseSync.prototype.exec;
            let injected = false;
            if (name === 'emergency-write-failure') DatabaseSync.prototype.exec = function(sql) {
              if (sql === 'COMMIT') { injected = true; throw new Error('injected-commit-failure'); }
              return exec.call(this, sql);
            };
            try { await assert.rejects(dispatch(run, transport, end, prepared)); }
            finally { DatabaseSync.prototype.exec = exec; }
            assert.equal(received.length, 1);
            assert.deepEqual(probe.store.requestStatus(probe.activity, run.runId).attempts, original);
            if (name === 'emergency-write-failure') assert.equal(injected, true);
            else assert.equal(run.status().cacheEpoch, null);
            checkpoints.push({ invalidationFailed: injected, zeroAdditionalSends: received.length === 1, state: run.status() });
            run.cancel();
          }
        } else {
          const run = agent(transport);
          release = run.observeExecution();
          const first = await dispatch(run, transport, echo('first', name === 'historian-selection' ? 'Long raw observation. '.repeat(240) : ''));
          finishEcho(run, 'first');
          if (name === 'fresh-same-prefix') {
            run.newWindow();
            const fresh = await dispatch(run, transport, end);
            assert.equal(stable(first), stable(fresh));
            assert.notEqual(first.assembly.context!.windowId, fresh.assembly.context!.windowId);
            assert.notEqual(first.assembly.context!.cacheEpoch, fresh.assembly.context!.cacheEpoch);
          } else {
            if (name === 'stable-p3') {
              const intent = probe.store.readIntent(probe.activity)!;
              probe.store.transitionIntent(probe.activity, intent.eventId, probe.archive.append(randomUUID(), 'Advance only the synthetic step.'), { status: 'active', step: 'next-step' });
            }
            const second = await dispatch(run, transport, echo('recent')); finishEcho(run, 'recent');
            assert.equal(stable(first), stable(second));
            assert.equal(first.assembly.context!.cacheEpoch, second.assembly.context!.cacheEpoch);
            assert.notEqual(first.assembly.assemblyId, second.assembly.assemblyId);
            if (name === 'stable-p3') assert.notEqual(first.neutral.p3.intent.step, second.neutral.p3.intent.step);
            else {
              const job = probe.store.queueHistorianBoundary(probe.activity, run.runId, { minBytes: 1000, maxBytes: 30000 })!;
              assert.ok(job);
              const lease = probe.store.claimCaptureJob(probe.activity, job.jobId, budget, 30000)!;
              const historian = new CaptureRun(probe.store, lease, probe.archive, { historian: [{ ...route, capability: 'standard' }] }, transport.encode.bind(transport));
              runs.push(historian); activities.set(historian.runId, lease.activity);
              await dispatch(historian, transport, { text: '{"result":"pass","summary":"A completed synthetic observation."}', calls: [], stop: 'end' });
              const unselected = await dispatch(run, transport, echo('after-publication')); finishEcho(run, 'after-publication');
              assert.equal(stable(second), stable(unselected));
              assert.equal(second.assembly.context!.cacheEpoch, unselected.assembly.context!.cacheEpoch);
            }
            run.newWindow();
            const selected = await dispatch(run, transport, end);
            assert.notEqual(second.assembly.context!.cacheEpoch, selected.assembly.context!.cacheEpoch);
            assert.notDeepEqual(second.neutral.p1, selected.neutral.p1);
            if (name === 'historian-selection') assert.equal(selected.neutral.p1.compartments?.[0]?.summary, 'A completed synthetic observation.');
          }
        }
        assert.equal(sends.length, received.length);
        assert.equal(transports.reduce((sum, transport) => sum + transport.count, 0), received.length);
        assert.equal(new Set(sends.map(send => send.attempt.attemptId)).size, sends.length);
        sends.forEach((send, index) => {
          assert.equal(send.request.payload, received[index]);
          assert.equal(send.observation.attemptId, send.attempt.attemptId);
          assert.equal(send.attempt.payloadHash, sha256(received[index]!));
          assert.equal(send.attempt.byteLength, Buffer.byteLength(received[index]!));
        });
        passed = true;
      } finally {
        release?.();
        const ledgers = runs.map(run => probe.store.requestStatus(activities.get(run.runId)!, run.runId));
        writeFileSync(join(path, 'evidence.json'), JSON.stringify({ name, passed, sends, received, checkpoints, ledgers }, null, 2));
        probe.close(); cpSync(sandbox.root, join(path, 'sandbox'), { recursive: true }); rmSync(sandbox.root, { recursive: true, force: true });
        cases.push({ name, passed, sends: sends.length, received: received.length,
          transportCount: transports.reduce((sum, transport) => sum + transport.count, 0) });
      }
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  const report = { passed: cases.every(item => item.passed), hiddenSends: cases.reduce((sum, item) => sum + item.transportCount - item.sends, 0),
    networkCount: cases.reduce((sum, item) => sum + item.transportCount, 0), cases };
  writeFileSync(join(directory, 'receipt.json'), JSON.stringify(report, null, 2));
  return report;
}
