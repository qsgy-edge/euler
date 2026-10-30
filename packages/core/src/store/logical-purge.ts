import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { check, sameBinding, sha256 } from '../contracts.ts';
import type { SourceAck } from '../contracts.ts';
import type { BoundFile, BoundSource, MemoryRecord } from './probe-store.ts';
import type { SnapshotCleanupManifest } from './snapshots.ts';
import { parseAnalysisArtifact } from '../context/analysis-artifacts.ts';
import { parseCorrectionCommand } from '../context/memory-correction.ts';

// Implemented database carriers participating in logical purge.
export const PURGE_DATABASE_INVENTORY = {
  control: ['schema_meta', 'owner_fences', 'maintenance_residuals', 'owner_activities', 'sessions', 'projects',
    'project_resources', 'workspaces', 'workspace_projects', 'memory_scopes', 'source_projection_health',
    'store_recovery_events', 'store_recovered_owners', 'execution_streams', 'execution_events'],
  content: ['intent_events', 'intent_heads', 'memory_discovery_grants', 'memory_discovery_projects',
    'memory_discovery_targets', 'source_query_receipts', 'memory_records', 'memory_revisions', 'memory_applicability',
    'capture_jobs', 'compartments', 'capture_work', 'provenance_refs', 'memory_heads', 'memory_events',
    'host_presentations', 'presentation_targets', 'pending_operations', 'host_operation_delivery', 'activation_batches',
    'projection_jobs', 'host_info_batches', 'source_units', 'source_projection_jobs', 'search_documents',
    'search_projection_jobs', 'feedback_events', 'verification_runs', 'conflict_sets', 'conflict_members',
    'evolution_proposals', 'verification_evidence', 'proposal_evidence', 'proposal_source_units'],
  ledger: ['request_runs', 'request_events', 'request_assemblies', 'request_attempts'],
  backup: ['store_snapshots', 'store_restores'],
} as const;

const identities: Record<string, readonly string[]> = {
  intent_events: ['event_id', 'intent_id'], intent_heads: [],
  memory_discovery_grants: ['grant_id'], memory_discovery_projects: [], memory_discovery_targets: [],
  source_query_receipts: ['query_id'], memory_records: ['record_id'],
  memory_revisions: ['record_id', 'revision_id'], memory_applicability: [], capture_jobs: ['job_id'],
  compartments: ['job_id'], capture_work: ['job_id'], provenance_refs: ['ref_id'], memory_heads: ['record_id'],
  memory_events: ['event_id', 'record_id'], host_presentations: ['presentation_id', 'operation_id', 'token'],
  presentation_targets: ['presentation_id', 'update_event_id'], pending_operations: ['operation_id'],
  host_operation_delivery: ['operation_id', 'summary_event_id'], activation_batches: ['batch_id'],
  projection_jobs: ['job_id'], host_info_batches: ['batch_id', 'entry_id'], source_units: ['unit_id'],
  source_projection_jobs: ['job_id'], search_documents: ['unit_id'], search_projection_jobs: [],
  feedback_events: ['feedback_id'], verification_runs: ['run_id', 'record_id'], conflict_sets: ['conflict_set_id'],
  conflict_members: ['conflict_set_id'], evolution_proposals: ['proposal_id'], verification_evidence: ['run_id'],
  proposal_evidence: ['proposal_id'], proposal_source_units: ['proposal_id'],
  request_runs: ['run_id'], request_events: ['event_id', 'run_id'], request_assemblies: ['assembly_id', 'run_id'],
  request_attempts: ['attempt_id', 'run_id'],
};

type Row = Record<string, SQLInputValue>;
export interface PurgeCarrierEntry { id: string; value: unknown; hash: string; source?: SourceAck; content?: string }
export interface PurgeCarrier {
  role: 'source' | 'owner-info' | 'receiver' | 'project-output'; file: BoundFile; hash: string; bytes: number;
  entries: PurgeCarrierEntry[];
}
export interface PurgeCarrierSelection {
  role: PurgeCarrier['role']; file: BoundFile; hash: string; bytes: number; entries: { id: string; hash: string }[];
}
export interface PurgeManifest {
  schema: 'purge-manifest@1'; recordId: string; records: MemoryRecord[];
  database: { table: string; count: number; rows: { rowid: number; hash: string; action: 'delete' | 'redact-ledger' | 'detach-batch' }[] }[];
  inventory: { tables: string[]; sources: BoundSource[]; carriers: { role: PurgeCarrier['role']; file: BoundFile; hash: string; bytes: number }[] };
  carriers: PurgeCarrierSelection[]; backups: SnapshotCleanupManifest[];
  residuals: string[]; consequences: string[];
}
export interface PurgeInput { readonly id: string }
export interface PurgeReceipt { schema: 'purge/logical-commit@1'; operationId: string; status: 'logical-commit' }
export interface PurgeContinuation {
  schema: 'purge-continuation@1'; operationId: string; phase: 'external-cleanup';
  carriers: PurgeCarrierSelection[]; backups: SnapshotCleanupManifest[];
  inventory: PurgeManifest['inventory']['carriers']; sources: BoundSource[];
  sourceCleanup?: { index: number; plan: PurgeSourcePlan; ack: PurgeSourceAck | null }[];
}
export interface PurgeSourcePlan { ranges: { offset: number; bytes: number }[]; afterHash: string }
export interface PurgeSourceAck { hash: string; bytes: number }
export interface PurgeSourceOwner {
  preparePurge(selection: PurgeCarrierSelection): PurgeSourcePlan;
  purge(selection: PurgeCarrierSelection, plan: PurgeSourcePlan): PurgeSourceAck;
}

/** Verify the frozen ranges and the untouched bytes, accepting already-erased entries after a crash. */
export function inspectPurgeSource(selection: PurgeCarrierSelection, plan: PurgeSourcePlan, bytes: Uint8Array): Buffer {
  check(selection.role === 'source' && bytes.length === selection.bytes && plan.ranges.length === selection.entries.length,
    'purge-source-evidence-gap');
  const result = Buffer.from(bytes);
  let end = 0;
  for (const [index, range] of plan.ranges.entries()) {
    check(Number.isSafeInteger(range.offset) && Number.isSafeInteger(range.bytes) && range.bytes > 0
      && range.offset > end && range.offset + range.bytes < result.length
      && result[range.offset - 1] === 10 && result[range.offset + range.bytes] === 10, 'purge-source-range-mismatch');
    end = range.offset + range.bytes;
    const line = result.subarray(range.offset, end);
    check(sha256(line) === selection.entries[index]!.hash || line.every(byte => byte === 32), 'purge-source-entry-changed');
    result.fill(32, range.offset, end);
  }
  check(sha256(result) === plan.afterHash, 'purge-source-carrier-changed');
  return result;
}
export interface PurgePresentation {
  operationId: string; token: string; nonce: string; phrase: string; manifest: PurgeManifest; digest: string;
}
export interface PurgePlan {
  manifest: PurgeManifest; selected: Map<string, Row[]>; detachBatches: Row[]; tokens: Set<string>; qualifiedSources: Map<string, SourceAck[]>; digest: string;
}

function resolveQualifiedSource(value: unknown, sources: SourceAck[]): SourceAck | undefined {
  const pending: unknown[] = [value], seen = new Set<unknown>(), found = new Set<SourceAck>();
  while (pending.length) {
    const next = pending.pop();
    if (seen.has(next)) continue;
    seen.add(next);
    if (typeof next === 'string') {
      try { pending.push(JSON.parse(next)); } catch { /* A field may contain ordinary text. */ }
    } else if (next && typeof next === 'object') {
      const object = next as Partial<SourceAck>;
      if (object.schema === 'cli-source-ack@1') {
        const source = sources.find(source => ['schema', 'status', 'eventId', 'locator', 'hash', 'contentHash', 'byteLength']
          .every(key => object[key as keyof SourceAck] === source[key as keyof SourceAck])
          && object.binding && sameBinding(object.binding, source.binding));
        if (source) found.add(source);
      } else pending.push(...Object.values(next));
    }
  }
  return found.size === 1 ? [...found][0] : undefined;
}

/** Structured equality, including object keys and nested serialized payloads. */
export function purgeValues(value: unknown, qualifiedSources = new Map<string, SourceAck[]>()): string[] {
  const values = new Set<string>(), seen = new Set<object>(), pending: unknown[] = [value];
  while (pending.length) {
    const next = pending.pop();
    if (typeof next === 'string') {
      if (values.has(next)) continue;
      values.add(next);
      if (/^\s*[\[{"]/u.test(next)) {
        try { pending.push(JSON.parse(next)); }
        catch { /* Free text may start with a bracket; canonical JSON columns are checked by the planner. */ }
      } else {
        const command = parseCorrectionCommand(next);
        if (command) pending.push(command);
        const purge = /^purge ([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/u.exec(next);
        if (purge) pending.push({ recordId: purge[1] });
        const artifact = parseAnalysisArtifact(next);
        if (artifact) pending.push(artifact.header);
      }
    } else if (next && typeof next === 'object' && !seen.has(next)) {
      seen.add(next);
      for (const [key, child] of Object.entries(next)) {
        const object = next as Record<string, unknown>, sources = typeof child === 'string' ? qualifiedSources.get(child) : undefined;
        const source = !sources ? undefined : key === 'eventId' && object.schema === 'cli-source-ack@1'
          ? resolveQualifiedSource(object, sources) : key === 'source_event_id'
            ? sources.find(source => source.binding.sessionId === object.source_owner)
              ?? resolveQualifiedSource(object.source_json ?? object.payload, sources) : undefined;
        if (sources && (key === 'source_event_id' || key === 'eventId' && object.schema === 'cli-source-ack@1'))
          check(source, 'purge-unqualified-source-reference');
        if (source) { pending.push(key, source.locator); continue; }
        pending.push(key, child);
      }
    }
  }
  return [...values];
}

function sourceValues(value: unknown, qualifiedSources: Map<string, SourceAck[]>): string[] {
  const result = new Set<string>(), seen = new Set<object>(), pending: unknown[] = [value];
  while (pending.length) {
    let next = pending.pop();
    if (typeof next === 'string' && /^\s*[\[{]/u.test(next)) {
      try { next = JSON.parse(next); } catch { continue; }
    }
    if (!next || typeof next !== 'object' || seen.has(next)) continue;
    seen.add(next);
    const object = next as Record<string, unknown>;
    if (object.schema === 'cli-source-ack@1') {
      for (const key of ['eventId', 'locator', 'hash', 'contentHash']) {
        check(typeof object[key] === 'string', 'purge-source-evidence-gap');
        if (key !== 'eventId' || !qualifiedSources.has(object[key] as string)) result.add(object[key] as string);
      }
    }
    for (const child of Object.values(object)) pending.push(child);
  }
  return [...result];
}

const schemaColumns = new Map<string, Map<string, string>>();
function assertPurgeSchema(db: DatabaseSync, ddl: string, tables: string[]): void {
  let expected = schemaColumns.get(ddl);
  if (!expected) {
    const reference = new DatabaseSync(':memory:');
    try {
      reference.exec(ddl);
      expected = new Map(tables.map(table => [table, JSON.stringify(reference.prepare(`PRAGMA table_xinfo(${table})`).all())]));
      schemaColumns.set(ddl, expected);
    } finally { reference.close(); }
  }
  for (const table of tables) check(expected.get(table) === JSON.stringify(db.prepare(`PRAGMA table_xinfo(${table})`).all()),
    'purge-unregistered-database-reference');
}

export function planPurge(db: DatabaseSync, recordId: string, carriers: PurgeCarrier[], backups: SnapshotCleanupManifest[], ddl: string, sources: BoundSource[]): PurgePlan {
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(row => String(row.name));
  const known = Object.values(PURGE_DATABASE_INVENTORY).flat() as string[];
  check(tables.every(table => known.includes(table) || ['search_fts', 'search_fts_data', 'search_fts_idx', 'search_fts_docsize', 'search_fts_config'].includes(table))
    && known.every(table => tables.includes(table)), 'purge-unregistered-database-carrier');
  assertPurgeSchema(db, ddl, known);
  check(db.prepare('SELECT 1 FROM memory_records WHERE record_id=?').get(recordId), 'purge-target-unavailable');
  const rows = new Map([...PURGE_DATABASE_INVENTORY.content, ...PURGE_DATABASE_INVENTORY.ledger]
    .map(table => [table, db.prepare(`SELECT rowid AS _rowid,* FROM ${table} ORDER BY rowid`).all() as Row[]]));
  const tokens = new Set([recordId]), selected = new Map<string, Row[]>();
  const allSources = new Map<string, SourceAck[]>();
  for (const carrier of carriers) for (const entry of carrier.entries) if (entry.source) {
    const sources = allSources.get(entry.source.eventId) ?? [];
    sources.push(entry.source); allSources.set(entry.source.eventId, sources);
  }
  const qualifiedSources = new Map([...allSources].filter(([, sources]) => sources.length > 1));
  for (const [table, tableRows] of rows) for (const column of identities[table] ?? []) {
    // Job and attempt IDs deliberately name their archived output. Other object
    // kinds cannot acquire a source event merely by sharing its UUID.
    if (column === 'job_id' && ['capture_jobs', 'capture_work', 'compartments'].includes(table)
      || table === 'request_attempts' && column === 'attempt_id') continue;
    for (const row of tableRows) if (typeof row[column] === 'string' && allSources.has(row[column] as string))
      qualifiedSources.set(row[column] as string, allSources.get(row[column] as string)!);
  }
  const selectedRows = new Set<string>(), selectedEntries = new Set<string>();
  const rowValues = new Map<Row, string[]>();
  for (const [table, tableRows] of rows) for (const row of tableRows) {
    for (const [column, value] of Object.entries(row)) if (typeof value === 'string' &&
      (['_json', '_snapshot', '_refs'].some(suffix => column.endsWith(suffix))
        || ['payload', 'snapshot', 'sources', 'used_memories', 'selection', 'zones', 'budget', 'context'].includes(column)
        || table === 'pending_operations' && column === 'result')) {
      try { JSON.parse(value); } catch { throw new Error('purge-unsupported-structured-copy'); }
    }
    rowValues.set(row, purgeValues(row, qualifiedSources));
  }
  const entryValues = carriers.map(carrier => carrier.entries.map(entry => [
    ...purgeValues(entry.value, qualifiedSources),
    ...entry.content === undefined ? [] : purgeValues(entry.content).map(value => sha256(value)),
  ]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [table, tableRows] of rows) for (const row of tableRows) {
      const key = `${table}/${row._rowid}`;
      const matches = rowValues.get(row)!.filter(value => tokens.has(value));
      if (selectedRows.has(key) || !matches.length) continue;
      // A frozen Info batch is a presentation container, not a dependency of its other memories.
      if (table === 'memory_events' && row.record_id !== null && matches.every(value => value === row.batch_id)) continue;
      if (table === 'memory_events' && row.record_id === null) continue;
      selectedRows.add(key); (selected.get(table) ?? selected.set(table, []).get(table)!).push(row); changed = true;
      for (const column of identities[table] ?? []) if (typeof row[column] === 'string') tokens.add(row[column] as string);
      for (const [column, value] of Object.entries(row)) {
        if (typeof value === 'string' && (column.endsWith('_hash') || column === 'hash' || column === 'digest')) tokens.add(value);
      }
      // Follow original material owned by the removed memory, and output material
      // produced by affected jobs/runs. A derived artifact does not own its other inputs.
      let sources: unknown;
      if (['memory_revisions', 'provenance_refs', 'compartments', 'host_operation_delivery'].includes(table)) sources = row;
      else if (table === 'capture_jobs' && row.consumer === 'memory') sources = JSON.parse(String(row.payload)).source;
      else if (table === 'host_presentations') sources = JSON.parse(String(row.payload)).input;
      else if (table === 'request_events' && row.payload !== null) {
        const payload = JSON.parse(String(row.payload));
        if (row.kind === 'capture/step@v1') sources = payload.source;
        else if (row.kind === 'agent/event@v1' && ['response', 'tool-result', 'file-approved', 'file-reconciled'].includes(payload.event?.kind))
          sources = payload.event;
      }
      for (const value of sourceValues(sources, qualifiedSources)) tokens.add(value);
    }
    for (const [ci, carrier] of carriers.entries()) for (const [ei, entry] of carrier.entries.entries()) {
      const key = `${ci}/${ei}`;
      if (selectedEntries.has(key) || !entryValues[ci]![ei]!.some(value => tokens.has(value))) continue;
      selectedEntries.add(key); changed = true;
      if (!entry.source || !qualifiedSources.has(entry.id)) tokens.add(entry.id);
      tokens.add(entry.hash);
      if (entry.source) for (const value of sourceValues(entry.source, qualifiedSources)) tokens.add(value);
    }
  }
  const removedSources = new Set(carriers.flatMap((carrier, ci) => carrier.entries
    .filter((entry, ei) => entry.source && selectedEntries.has(`${ci}/${ei}`)).map(entry => entry.source!.eventId)));
  for (const [table, tableRows] of rows) for (const row of tableRows) if (!selectedRows.has(`${table}/${row._rowid}`))
    check(!rowValues.get(row)!.some(value => qualifiedSources.has(value) && removedSources.has(value)), 'purge-unqualified-source-reference');
  for (const [ci, carrier] of carriers.entries()) for (const [ei] of carrier.entries.entries()) if (!selectedEntries.has(`${ci}/${ei}`))
    check(!entryValues[ci]![ei]!.some(value => qualifiedSources.has(value) && removedSources.has(value)), 'purge-unqualified-source-reference');
  for (const table of PURGE_DATABASE_INVENTORY.backup) {
    const catalog = db.prepare(`SELECT rowid AS _rowid,* FROM ${table} ORDER BY rowid`).all() as Row[];
    if (catalog.length) selected.set(table, catalog);
  }
  const detachBatches = (rows.get('memory_events') ?? []).filter(row => row.record_id !== null
    && !selectedRows.has(`memory_events/${row._rowid}`) && tokens.has(String(row.batch_id)));
  const records = (selected.get('memory_heads') ?? []).map(row => JSON.parse(String(row.snapshot)) as MemoryRecord);
  const database: PurgeManifest['database'] = [...selected].map(([table, chosen]) => ({ table, count: chosen.length,
    rows: chosen.map(row => ({ rowid: Number(row._rowid), hash: sha256(JSON.stringify(row)),
      action: (PURGE_DATABASE_INVENTORY.ledger as readonly string[]).includes(table) ? 'redact-ledger' as const : 'delete' as const })) })).sort((a, b) => a.table.localeCompare(b.table));
  if (detachBatches.length) {
    const item = database.find(item => item.table === 'memory_events')!;
    item.rows.push(...detachBatches.map(row => ({ rowid: Number(row._rowid), hash: sha256(JSON.stringify(row)), action: 'detach-batch' as const })));
    item.count = item.rows.length;
  }
  const selectedCarriers = carriers.flatMap((carrier, ci) => {
    const entries = carrier.entries.filter((_, ei) => selectedEntries.has(`${ci}/${ei}`)).map(entry => ({ id: entry.id, hash: entry.hash }));
    return entries.length ? [{ role: carrier.role, file: carrier.file, hash: carrier.hash, bytes: carrier.bytes, entries }] : [];
  });
  const manifest: PurgeManifest = {
    schema: 'purge-manifest@1', recordId, records, database,
    inventory: { tables, sources, carriers: carriers.map(({ role, file, hash, bytes }) => ({ role, file, hash, bytes })) },
    carriers: selectedCarriers, backups,
    residuals: ['Copies explicitly exported outside the registered local carriers, including remote repositories and external backups.'],
    consequences: ['The listed database contents and references will be irreversibly removed.',
      'Source, Host carriers, backups and SQLite physical cleanup remain incomplete until their owners finish cleanup.',
      'Normal runtime admission, recovery, derivation and model dispatch remain closed while cleanup is incomplete.'],
  };
  return { manifest, selected, detachBatches, tokens, qualifiedSources, digest: sha256(JSON.stringify(manifest)) };
}

function safeOwnerReceipt(row: Row): boolean {
  if (typeof row.receipt_payload !== 'string' || sha256(row.receipt_payload) !== row.receipt_hash) return false;
  const receipt = JSON.parse(row.receipt_payload);
  return Object.keys(receipt).sort().join(',') === 'afterRevision,beforeRevision,kind,operationId,outcome,receiptId,schema,subjectRef'
    && receipt.schema === 'owner-receipt@1' && receipt.receiptId === row.receipt_id
    && receipt.operationId === (row.operation_id ?? row.event_id) && receipt.kind === row.kind
    && ['correct', 'forget', 'restore', 'rollback'].includes(receipt.kind) && receipt.outcome === 'committed'
    && typeof receipt.subjectRef === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(receipt.subjectRef)
    && receipt.subjectRef !== row.record_id && receipt.subjectRef !== row.revision_id
    && Number.isSafeInteger(receipt.afterRevision) && receipt.afterRevision > 0
    && (receipt.beforeRevision === null || Number.isSafeInteger(receipt.beforeRevision))
    && JSON.stringify(JSON.parse(String(row.payload)).ownerReceipt) === row.receipt_payload;
}

/** Only called inside the Store's exclusive, approved privacy transaction. No filesystem writes. */
export function applyLogicalPurge(db: DatabaseSync, plan: PurgePlan): void {
  db.exec('PRAGMA defer_foreign_keys=ON');
  for (const row of plan.detachBatches) {
    const payload = JSON.stringify({ ...JSON.parse(String(row.payload)), batchId: null, batchOrdinal: null });
    db.prepare('UPDATE memory_events SET batch_id=NULL,batch_ordinal=NULL,payload=?,payload_hash=? WHERE rowid=?')
      .run(payload, sha256(payload), row._rowid!);
  }
  for (const [table, rows] of plan.selected) {
    if ((PURGE_DATABASE_INVENTORY.ledger as readonly string[]).includes(table)) continue;
    for (const row of rows) {
      if (table === 'memory_events' && safeOwnerReceipt(row)) {
        db.prepare(`UPDATE memory_events SET record_id=NULL,seq=NULL,revision_id=NULL,before_snapshot=NULL,after_snapshot=NULL,
          request_hash=NULL,origin_host_id=NULL,origin_seq=NULL,batch_id=NULL,target_event_id=NULL,payload=NULL,payload_hash=NULL,
          source_event_id=NULL,batch_ordinal=NULL,operation_id=NULL WHERE rowid=?`).run(row._rowid!);
      } else db.prepare(`DELETE FROM ${table} WHERE rowid=?`).run(row._rowid!);
    }
  }
  for (const run of plan.selected.get('request_runs') ?? []) {
    db.prepare(`UPDATE request_events SET payload=NULL,hash=NULL WHERE run_id=?`).run(run.run_id!);
    db.prepare(`UPDATE request_assemblies SET route=NULL,model=NULL,policy_hash=NULL,estimator=NULL,identity_hash=NULL,
      payload_hash=NULL,budget=NULL,sources=NULL,used_memories=NULL,intent_event_id=NULL,intent_hash=NULL,zones=NULL,
      selection=NULL,degradation=NULL,claim_head_event_id=NULL,context=NULL WHERE run_id=?`).run(run.run_id!);
    db.prepare('UPDATE request_attempts SET payload_hash=NULL,encoding=NULL,hash_algorithm=NULL,adapter_version=NULL WHERE run_id=?').run(run.run_id!);
    db.prepare(`UPDATE request_runs SET state='sealed',redacted=1,budget='{}',authorization_id='',
      intent_event_id=NULL,intent_hash=NULL,related_run_id=NULL WHERE run_id=?`).run(run.run_id!);
    db.prepare("UPDATE execution_streams SET redacted=1,authorization_id='' WHERE stream_id=?").run(run.stream_id!);
    if (run.owner_kind === 'job' && plan.tokens.has(String(run.owner_id))) {
      const owner = randomUUID();
      db.prepare('UPDATE execution_streams SET owner_id=?,authorization_id=? WHERE stream_id=?').run(owner, '', run.stream_id!);
      db.prepare('UPDATE request_runs SET owner_id=? WHERE stream_id=? AND redacted=1').run(owner, run.stream_id!);
    }
  }
  // Every controlled snapshot can reproduce an earlier database/source state. Its exact
  // file inventory is retained by the operation before catalog references are removed.
  check(!db.prepare('SELECT 1 FROM store_snapshots UNION ALL SELECT 1 FROM store_restores LIMIT 1').get(), 'purge-database-postcondition-failed');
  for (const row of db.prepare('SELECT rowid AS _rowid,* FROM store_recovered_owners').all()) {
    if (plan.tokens.has(String(row.owner_id))) db.prepare('DELETE FROM store_recovered_owners WHERE rowid=?').run(row._rowid!);
  }
  for (const event of db.prepare('SELECT operation_id FROM store_recovery_events').all()) {
    const owners = db.prepare('SELECT kind,owner_id FROM store_recovered_owners WHERE operation_id=? ORDER BY kind,owner_id').all(event.operation_id!);
    db.prepare('UPDATE store_recovery_events SET purged_owners_hash=? WHERE operation_id=?').run(sha256(JSON.stringify(owners)), event.operation_id!);
  }
  db.exec("INSERT INTO search_fts(search_fts) VALUES ('rebuild')");
  for (const run of plan.selected.get('request_runs') ?? []) {
    check(db.prepare("SELECT 1 FROM request_runs WHERE run_id=? AND redacted=1 AND state='sealed' AND budget='{}' AND authorization_id='' AND intent_hash IS NULL AND intent_event_id IS NULL AND related_run_id IS NULL").get(run.run_id!), 'purge-database-postcondition-failed');
    check(!db.prepare('SELECT 1 FROM request_events WHERE run_id=? AND (payload IS NOT NULL OR hash IS NOT NULL)').get(run.run_id!), 'purge-database-postcondition-failed');
    check(!db.prepare('SELECT 1 FROM request_attempts WHERE run_id=? AND (payload_hash IS NOT NULL OR encoding IS NOT NULL OR hash_algorithm IS NOT NULL OR adapter_version IS NOT NULL)').get(run.run_id!), 'purge-database-postcondition-failed');
    check(!db.prepare(`SELECT 1 FROM request_assemblies WHERE run_id=? AND (sources IS NOT NULL OR used_memories IS NOT NULL
      OR payload_hash IS NOT NULL OR identity_hash IS NOT NULL OR claim_head_event_id IS NOT NULL OR context IS NOT NULL
      OR selection IS NOT NULL OR zones IS NOT NULL OR intent_hash IS NOT NULL OR intent_event_id IS NOT NULL)`).get(run.run_id!), 'purge-database-postcondition-failed');
  }
  check(db.prepare('PRAGMA foreign_key_check').all().length === 0, 'purge-database-postcondition-failed');
  for (const table of PURGE_DATABASE_INVENTORY.content) {
    for (const row of db.prepare(`SELECT * FROM ${table}`).all()) {
      if (table === 'memory_events' && row.record_id === null) continue;
      check(!purgeValues(row, plan.qualifiedSources).some(value => plan.tokens.has(value)), 'purge-database-postcondition-failed');
    }
  }
}
