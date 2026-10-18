import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { AnalysisArtifacts, DEFAULT_BUDGET } from '@euler/core';
import { createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

function reportInput() { return { eventId: randomUUID(), title: '报告', facts: '事实来自合成样本。',
  inferences: '推断待复验。', recommendations: '建议保留日志。', unresolved: '真实模型未测试。', evidence: [] }; }

test('an unknown report append reconciles the same durable identity and never replaces the saved bytes', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const source = probe.archive.append(randomUUID(), '保存合成分析报告');
    probe.store.transitionIntent(probe.activity, null, source, { status: 'active', step: 'analysis' }, '保存合成分析报告');
    let loseAck = true;
    const carrier = { lookup: probe.archive.lookup.bind(probe.archive), read: probe.archive.read.bind(probe.archive), expand: probe.archive.expand.bind(probe.archive),
      append: (...args: Parameters<typeof probe.archive.append>) => { const ack = probe.archive.append(...args);
        if (loseAck) { loseAck = false; throw new Error('synthetic-ack-lost'); } return ack; } };
    const artifacts = new AnalysisArtifacts(probe.store, probe.activity, carrier);
    const input = reportInput();
    assert.throws(() => artifacts.saveReport(input), /synthetic-ack-lost/);
    const saved = artifacts.saveReport(input);
    assert.equal(saved.ref.eventId, input.eventId);
    assert.equal(probe.archive.events().filter(event => event.ack.eventId === input.eventId).length, 1);
    assert.throws(() => artifacts.saveReport({ ...input, facts: '另一份正文' }), /analysis-identity-conflict/);
    const intent = probe.store.readIntent(probe.activity)!;
    const finished = probe.archive.append(randomUUID(), '完成分析任务');
    probe.store.transitionIntent(probe.activity, intent.eventId, finished, { status: 'completed', step: 'complete' });
    assert.throws(() => artifacts.read(saved.ref), /analysis-task-not-active/);
    assert.throws(() => probe.store.expandSource(probe.activity, { ref: saved.ref, offset: 0, limit: 4096 }), /analysis-task-not-active/);
    assert.equal(artifacts.saveReport(input).ref.hash, saved.ref.hash);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});

test('missing raw evidence blocks capture before any proposer or verifier request', () => {
  const sandbox = createSandbox();
  const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    const source = probe.archive.append(randomUUID(), '记住：保留原始证据');
    const job = probe.store.queueOwnerCapture(probe.activity, source);
    const path = join(sandbox.root, 'session.jsonl');
    const header = readFileSync(path, 'utf8').split('\n')[0]! + '\n';
    writeFileSync(path, header);
    assert.equal(probe.store.claimCaptureJob(probe.activity, job.jobId, DEFAULT_BUDGET, 30000), null);
    const state = probe.store.readCaptureJob(probe.activity, job.jobId);
    assert.equal(state.stage, 'blocked');
    assert.equal(state.reason, 'source-evidence-gap');
    assert.equal(state.record, null);
    assert.equal(probe.transport.count, 0);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
