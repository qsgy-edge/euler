import { randomUUID } from 'node:crypto';
import { API_VERSION, DEFAULT_BUDGET, ProbeSession, sha256 } from '@euler/core';
import type { MemoryRecord } from '@euler/core';
import { bindingOf } from '../../src/sandbox.ts';
import type { Sandbox } from '../../src/sandbox.ts';
import type { openProbe } from '../../src/probe.ts';

type Probe = ReturnType<typeof openProbe>;
export const evolutionBudget = { ...DEFAULT_BUDGET, maxToolCalls: 32, maxModelAttempts: 24, maxTotalTokens: 65536, contextLimit: 32768 };

export function observedTask(probe: Probe, sandbox: Sandbox, selected: MemoryRecord[],
  terminal: 'completed' | 'failed', question = '本项目测试如何保存原始日志？', selectedBinding = bindingOf(sandbox), answer = '合成任务结果') {
  const session = new ProbeSession(probe.store, probe.activity,
    { version: API_VERSION, binding: selectedBinding, source: probe.archive, transport: probe.transport }, evolutionBudget);
  try {
    const prepared = session.prepare(randomUUID(), question, selected);
    const event = (value: Parameters<typeof probe.store.appendAgentEvent>[2]) => probe.store.appendAgentEvent(probe.activity, session.runId, value);
    event({ kind: 'opened', route: { provider: 'synthetic', model: 'none', route: 'local-counting', authNamespace: 'synthetic' } });
    event({ kind: 'input', source: prepared.input, mode: 'steer' });
    event({ kind: 'admitted', eventIds: [prepared.input.eventId] });
    event({ kind: 'bound', assemblyId: prepared.assemblyId, eventIds: [prepared.input.eventId] });
    const receipt = session.dispatch(prepared);
    const response = probe.archive.append(randomUUID(), JSON.stringify({ text: answer, calls: [], stop: terminal === 'completed' ? 'end' : 'error' }), 'assistant');
    event({ kind: 'response', attemptId: receipt.attemptId, source: response, calls: [] });
    event({ kind: 'terminal', terminal });
    const payload = probe.archive.append(randomUUID(), prepared.payload, 'tool');
    return { runId: session.runId, assemblyId: prepared.assemblyId, payloadHash: prepared.payloadHash, terminal, payload };
  } finally { session.close(); }
}

export function pairedCanary(probe: Probe, sandbox: Sandbox, record: MemoryRecord, selectedBinding = bindingOf(sandbox), transportFailure = false) {
  return [1, 2].map(index => {
    const expectedText = `PASS-${index}`;
    const question = JSON.stringify({ schema: 'memory-canary-case@1', caseId: `case-${index}`, expectedText });
    const baseline = observedTask(probe, sandbox, [], 'completed', question, selectedBinding, expectedText);
    const treatment = observedTask(probe, sandbox, [record], transportFailure ? 'failed' : 'completed', question, selectedBinding,
      transportFailure ? expectedText : `EXTRA ${expectedText}`);
    return { baselineRunId: baseline.runId, treatmentRunId: treatment.runId, baselinePayload: baseline.payload,
      treatmentPayload: treatment.payload, expectedResponseHash: sha256(expectedText) };
  });
}

export function verifiedCandidate(probe: Probe, content: string,
  bounds: { appliesTo?: string[]; validFrom?: string; validUntil?: string } = {}) {
  const source = probe.archive.append(randomUUID(), `记住：${content}`);
  const job = probe.store.queueOwnerCapture(probe.activity, source);
  let lease = probe.store.claimCaptureJob(probe.activity, job.jobId, evolutionBudget, 30000)!;
  probe.store.captureProposedMemory(lease, { type: 'decision', content, ...bounds });
  lease = probe.store.claimCaptureJob(probe.activity, job.jobId, evolutionBudget, 30000)!;
  probe.store.searchCaptureSources(lease, content);
  probe.store.expandCaptureSource(lease, { ref: source, offset: 0, limit: 4096 });
  return probe.store.completeCaptureVerification(lease, { result: 'pass', evidence: [source] });
}
