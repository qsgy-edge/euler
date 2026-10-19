import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { API_VERSION, DEFAULT_BUDGET, ProbeSession, fileIdentity, sha256 } from '@euler/core';
import type { MemoryComparison, MemoryRecord, SourceAck } from '@euler/core';
import { approvedSourceUnit } from './source-publication.ts';
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

export function compareCandidate(probe: Probe, jobId: string, relation: MemoryComparison['relation']) {
  for (let step = 0; step < 5; step++) {
    const lease = probe.store.claimCaptureJob(probe.activity, jobId, evolutionBudget, 30000)!;
    const input = probe.store.captureComparison(lease)!;
    const evidence = [input.candidate.source, input.peer.source, ...input.feedback];
    probe.store.searchCaptureSources(lease, '本项目');
    if (input.feedback.length) probe.store.searchCaptureSources(lease, 'memory-feedback');
    for (const ref of evidence) probe.store.expandCaptureSource(lease, { ref, offset: 0, limit: 4096 });
    const pass = input.relation === relation;
    const job = probe.store.completeCaptureVerification(lease, { result: pass ? 'pass' : 'block', evidence });
    if (pass) return job;
  }
  throw Error('comparison-fixture-exhausted');
}

export function verifiedCandidate(probe: Probe, content: string,
  bounds: { appliesTo?: string[]; validFrom?: string; validUntil?: string; type?: 'fact' | 'decision'; evidence?: SourceAck[] } = {}) {
  const { evidence = [], ...proposal } = bounds;
  const source = probe.archive.append(randomUUID(), '记住：' + content);
  const job = probe.store.queueOwnerCapture(probe.activity, source);
  let lease = probe.store.claimCaptureJob(probe.activity, job.jobId, evolutionBudget, 30000)!;
  assert.equal(probe.store.captureProposedMemory(lease, { type: 'decision', content, ...proposal }).stage, 'verifying');
  lease = probe.store.claimCaptureJob(probe.activity, job.jobId, evolutionBudget, 30000)!;
  probe.store.searchCaptureSources(lease, content);
  for (const ref of [source, ...evidence]) probe.store.expandCaptureSource(lease, { ref, offset: 0, limit: 4096 });
  return probe.store.completeCaptureVerification(lease, { result: 'pass', evidence: [source, ...evidence] });
}

export function observedFact(probe: Probe, sandbox: Sandbox, content: string, bounds: { validFrom: string; validUntil: string }) {
  const path = join(sandbox.root, 'observed-resource.txt');
  writeFileSync(path, JSON.stringify({ content, ...bounds }));
  const session = new ProbeSession(probe.store, probe.activity,
    { version: API_VERSION, binding: bindingOf(sandbox), source: probe.archive, transport: probe.transport }, evolutionBudget);
  try {
    const prepared = session.prepare(randomUUID(), '读取合成资源的当前观测');
    const event = (value: Parameters<typeof probe.store.appendAgentEvent>[2]) => probe.store.appendAgentEvent(probe.activity, session.runId, value);
    event({ kind: 'opened', route: { provider: 'synthetic', model: 'none', route: 'local-counting', authNamespace: 'synthetic' } });
    event({ kind: 'input', source: prepared.input, mode: 'steer' });
    event({ kind: 'admitted', eventIds: [prepared.input.eventId] });
    event({ kind: 'bound', assemblyId: prepared.assemblyId, eventIds: [prepared.input.eventId] });
    const receipt = session.dispatch(prepared), callId = randomUUID(), argumentsHash = sha256(JSON.stringify({ path }));
    const calls = [{ callId, name: 'file.read', argumentsHash }];
    const response = probe.archive.append(randomUUID(), JSON.stringify({ text: '', calls, stop: 'tools' }), 'assistant');
    event({ kind: 'response', attemptId: receipt.attemptId, source: response, calls });
    event({ kind: 'tool-started', callId });
    const text = readFileSync(path, 'utf8'), source = probe.archive.append(randomUUID(), text, 'tool');
    event({ kind: 'tool-result', result: { callId, argumentsHash, executionState: 'started', outcome: 'success', errorClass: null,
      source, file: { identity: fileIdentity(path), text, byteLength: Buffer.byteLength(text) } } });
    event({ kind: 'terminal', terminal: 'completed' });
    probe.store.publishSourceUnit(probe.activity, approvedSourceUnit(probe, { ref: source, projectId: sandbox.fixture.projectId,
      kind: 'report-section', offset: 0, length: Array.from(text).length }));
    probe.store.drainSourceProjection(probe.activity);
    return source;
  } finally { session.close(); }
}
