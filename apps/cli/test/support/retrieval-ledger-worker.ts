import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sha256 } from '@euler/core';
import { openSandbox } from '../../src/sandbox.ts';
import { openProbe } from '../../src/probe.ts';
import { backupSandbox } from '../../src/backup.ts';
import { retrievalBudget, retrievalFixture } from './retrieval-fixture.ts';

const f = retrievalFixture(openSandbox(process.argv[2]!));
try {
  const content = 'Juniper ' + 'padding '.repeat(1500);
  const source = f.probe.archive.append(randomUUID(), content);
  const projectId = f.sandbox.fixture.projectId;
  assert.ok(projectId);
  const candidate = f.probe.store.captureMemory(f.probe.activity, source, content, {
    type: 'fact', scope: { kind: 'project', id: projectId, resolved: true }, appliesTo: [],
  }).record;
  const verified = f.probe.store.verifyMemory(f.probe.activity, candidate.recordId, candidate, 'pass', [source]).record;
  f.probe.store.activateMemory(f.probe.activity, candidate.recordId, verified);
  f.probe.store.drainSearchProjection(f.probe.activity);
  const result = f.search();
  f.run.finishTool('find-memory', result.modelResult, result.outcome);
  const next = f.run.nextModel()!, attempt = f.run.startModel(next, next.payload);
  assert.equal(f.run.maySend(attempt.attemptId, next.payload), true);
  f.run.finishModel(attempt.attemptId, { text: 'The local compiler is preferred.', stop: 'end', calls: [] });
  const receipt = f.run.status().tools[0]!.result!.retrieval!;
  assert.equal(receipt.trace.candidates.find(item => item.recordId === candidate.recordId)!.decision, 'candidate-over-byte-budget');
  assert.equal(next.payload.includes(content), false);
  const selection = f.probe.store.requestStatus(f.probe.activity, f.run.runId).assemblies[1]!.selection;
  const backup = await backupSandbox(f.sandbox);
  assert.equal(backup.status, 'created');
  f.disconnect();
  const reopened = openProbe(f.sandbox, retrievalBudget, undefined, undefined, undefined, true);
  try {
    assert.deepEqual(reopened.store.agentStatus(reopened.activity, f.run.runId).tools[0]!.result!.retrieval, receipt);
    assert.deepEqual(reopened.store.requestStatus(reopened.activity, f.run.runId).assemblies[1]!.selection, selection);
  } finally { reopened.close(); }
  console.log(JSON.stringify({ recordId: f.record.recordId, omittedId: candidate.recordId,
    receiptHash: sha256(JSON.stringify(receipt)), selectionHash: sha256(JSON.stringify(selection)), snapshotId: backup.snapshot!.id }));
} finally { f.disconnect(); }
