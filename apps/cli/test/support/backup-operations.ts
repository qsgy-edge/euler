import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sha256 } from '@euler/core';
import { openSandbox } from '../../src/sandbox.ts';
import { openProbe } from '../../src/probe.ts';

export function seedBackupOperations(probe: ReturnType<typeof openProbe>, projectId: string) {
  const { store, activity, archive } = probe;
  const input = archive.append(randomUUID(), 'Original backup operation fact');
  const record = store.captureMemory(activity, input, 'Original backup operation fact', {
    type: 'fact', scope: { kind: 'project', id: projectId, resolved: true }, appliesTo: [],
  }).record;
  const inspect = store.inspectMemoryPresentation(activity, [record.recordId]);
  const content = 'Corrected backup operation fact';
  const source = archive.append(randomUUID(), content);
  const committed = store.previewMemoryOperation(activity, inspect.token, { kind: 'correct', input: source, content });
  store.registerCorrectionDelivery(activity, committed.token);
  store.acknowledgeMemoryPresentation(activity, committed.token, committed.hash);
  const approval = archive.append(randomUUID(), `commit ${committed.token} ${JSON.stringify(content)}`, 'user');
  store.recordCorrectionApproval(activity, committed.token, approval);
  const result = store.commitMemoryOperation(activity, committed.token, { reverify: true });
  store.acknowledgeCorrectionOwner(activity, committed.token);
  const summary = store.correctionSummary(activity, committed.token);
  const delivery = store.correctionDelivery(activity, committed.token);
  store.acknowledgeCorrectionModel(activity, committed.token,
    archive.append(delivery.summaryEventId, JSON.stringify(summary), 'tool'));
  const nextInspect = store.inspectMemoryPresentation(activity, [record.recordId]);
  const nextInput = archive.append(randomUUID(), 'Pending backup operation fact');
  const pending = store.previewMemoryOperation(activity, nextInspect.token, {
    kind: 'correct', input: nextInput, content: 'Pending backup operation fact',
  });
  store.registerCorrectionDelivery(activity, pending.token);
  return { inspect, committed, pending, result, summary, delivery: store.correctionDelivery(activity, committed.token) };
}

export function corruptBackupOperation(root: string, token: string, fault: string): void {
  let model: string | undefined;
  if (fault === 'model-summary') {
    const probe = openProbe(openSandbox(root), undefined, undefined, undefined, undefined, true);
    try { model = JSON.stringify(probe.archive.append(randomUUID(), 'An unrelated tool summary', 'tool')); }
    finally { probe.close(); }
  }
  const db = new DatabaseSync(join(root, 'probe.sqlite'));
  try {
    const presentation = db.prepare('SELECT * FROM host_presentations WHERE token=?').get(token)!;
    const table = fault === 'presentation-hash' ? 'host_presentations' : fault === 'presentation-target' ? 'presentation_targets'
      : fault.startsWith('operation-') ? 'pending_operations' : 'host_operation_delivery';
    db.function('euler_store_writer', () => 1);
    for (const trigger of db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name=? AND sql LIKE '%UPDATE%'").all(table))
      db.exec(`DROP TRIGGER "${String(trigger.name).replaceAll('"', '""')}"`);
    if (fault === 'presentation-hash') db.prepare("UPDATE host_presentations SET payload_hash='broken' WHERE presentation_id=?").run(presentation.presentation_id!);
    else if (fault === 'presentation-target') db.prepare("UPDATE presentation_targets SET lifecycle='tombstoned' WHERE presentation_id=?").run(presentation.presentation_id!);
    else if (fault === 'operation-hash') db.prepare("UPDATE pending_operations SET result_hash='broken' WHERE operation_id=?").run(presentation.operation_id!);
    else if (fault === 'operation-receipts') {
      const row = db.prepare('SELECT result FROM pending_operations WHERE operation_id=?').get(presentation.operation_id!)!;
      const payload = JSON.stringify({ ...JSON.parse(String(row.result)), receiptIds: [] });
      db.prepare('UPDATE pending_operations SET result=?,result_hash=? WHERE operation_id=?').run(payload, sha256(payload), presentation.operation_id!);
    } else if (fault === 'model-summary') {
      db.prepare('UPDATE host_operation_delivery SET model_source=?,model_hash=? WHERE operation_id=?').run(model!, sha256(model!), presentation.operation_id!);
    } else if (fault === 'approval-hash' || fault === 'model-hash') {
      db.prepare(`UPDATE host_operation_delivery SET ${fault === 'approval-hash' ? 'approval_hash' : 'model_hash'}='broken' WHERE operation_id=?`).run(presentation.operation_id!);
    } else throw new Error('unknown-operation-fault');
  } finally { db.close(); }
}
