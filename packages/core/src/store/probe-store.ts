import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { check, sameBinding, sha256, uuid } from '../contracts.ts';
import type { Binding, SourceAck } from '../contracts.ts';

export interface FileIdentity { dev: string; ino: string }
export interface BoundFile { path: string; identity: FileIdentity }
export interface StoreResources { root: BoundFile; source: BoundFile; store: BoundFile }

export function fileIdentity(path: string): FileIdentity {
  const stat = lstatSync(path, { bigint: true });
  check(!stat.isSymbolicLink() && (stat.isDirectory() || stat.nlink === 1n), 'unsafe-file-identity');
  return { dev: String(stat.dev), ino: String(stat.ino) };
}
export function sameFile(path: string, identity: FileIdentity): void {
  const actual = fileIdentity(path);
  check(actual.dev === identity.dev && actual.ino === identity.ino, 'file-identity-changed');
}

export interface Activity {
  id: string;
  pid: number;
  incarnation: string;
  startedAt: string;
  epoch: number;
  root: BoundFile;
}
const processIdentity = Object.freeze({ pid: process.pid, incarnation: randomUUID(), startedAt: new Date(performance.timeOrigin).toISOString() });
export interface Intent {
  schema: 'intent@1';
  intentId: string;
  eventId: string;
  version: number;
  binding: Binding;
  goal: string;
  constraints: string[];
  step: string;
  status: 'active' | 'paused' | 'completed' | 'needs-input';
  input: SourceAck;
  goalInput: SourceAck;
  hash: string;
}
export type IntentTransition = Pick<Intent, 'step' | 'status'>;
interface Fence {
  store_id: string;
  state: 'open' | 'closing' | 'exclusive';
  epoch: number;
  coordinator: string | null;
  coordinator_pid: number | null;
}

const DDL = `
CREATE TABLE owner_fences (
  store_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, host_id TEXT NOT NULL,
  project_id TEXT NOT NULL, session_id TEXT NOT NULL, branch_id TEXT NOT NULL,
  root_path TEXT NOT NULL, root_dev TEXT NOT NULL, root_ino TEXT NOT NULL,
  source_path TEXT NOT NULL, source_dev TEXT NOT NULL, source_ino TEXT NOT NULL,
  store_path TEXT NOT NULL, store_dev TEXT NOT NULL, store_ino TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('open','closing','exclusive')),
  epoch INTEGER NOT NULL CHECK(epoch > 0), coordinator TEXT, coordinator_pid INTEGER,
  UNIQUE(store_id, root_path, root_dev, root_ino)
) STRICT;
CREATE TABLE owner_activities (
  id TEXT PRIMARY KEY, store_id TEXT NOT NULL,
  pid INTEGER NOT NULL, incarnation TEXT NOT NULL, started_at TEXT NOT NULL, epoch INTEGER NOT NULL,
  root_path TEXT NOT NULL, root_dev TEXT NOT NULL, root_ino TEXT NOT NULL,
  FOREIGN KEY(store_id, root_path, root_dev, root_ino) REFERENCES owner_fences(store_id, root_path, root_dev, root_ino)
) STRICT;
CREATE TABLE intent_events (
  event_id TEXT PRIMARY KEY, intent_id TEXT NOT NULL, version INTEGER NOT NULL,
  session_id TEXT NOT NULL, branch_id TEXT NOT NULL,
  input_event_id TEXT NOT NULL, expected_event_id TEXT REFERENCES intent_events(event_id),
  status TEXT NOT NULL CHECK(status IN ('active','paused','completed','needs-input')),
  input_hash TEXT NOT NULL, input_content_hash TEXT NOT NULL, input_locator TEXT NOT NULL, input_bytes INTEGER NOT NULL CHECK(input_bytes > 0),
  goal_input_event_id TEXT NOT NULL, goal_input_hash TEXT NOT NULL, goal_input_content_hash TEXT NOT NULL,
  goal_input_locator TEXT NOT NULL, goal_input_bytes INTEGER NOT NULL CHECK(goal_input_bytes > 0),
  transition_hash TEXT NOT NULL, snapshot TEXT NOT NULL, hash TEXT NOT NULL,
  UNIQUE(session_id, branch_id, version), UNIQUE(session_id, branch_id, input_event_id)
) STRICT;
CREATE TABLE intent_heads (
  session_id TEXT NOT NULL, branch_id TEXT NOT NULL,
  event_id TEXT NOT NULL REFERENCES intent_events(event_id), PRIMARY KEY(session_id, branch_id)
) STRICT;
CREATE TRIGGER immutable_intent_update BEFORE UPDATE ON intent_events BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER immutable_intent_delete BEFORE DELETE ON intent_events BEGIN SELECT RAISE(ABORT, 'append-only'); END;
PRAGMA user_version=1;
`;
export const probeSchemaDigest = sha256(DDL);

// P0 disposable schema; not migrations/001-initial.sql and not the execution ledger.
export class ProbeStore {
  readonly #db: DatabaseSync;
  readonly #storeId: string;
  readonly #binding: Binding;
  readonly #resources: StoreResources;
  #depth = 0;

  constructor(resources: StoreResources, storeId: string, binding: Binding, initialize = false) {
    this.#storeId = storeId;
    this.#binding = structuredClone(binding);
    this.#resources = structuredClone(resources);
    this.#verifyResources();
    this.#db = new DatabaseSync(resources.store.path);
    try {
      this.#db.exec('PRAGMA busy_timeout=2000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
      const version = this.#db.prepare('PRAGMA user_version').get()!.user_version;
      if (initialize) {
        check(version === 0, 'already-initialized');
        this.#db.exec('PRAGMA journal_mode=WAL;');
        this.#transaction(() => {
          this.#db.exec(DDL);
          this.#db.prepare('INSERT INTO owner_fences VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL)')
            .run(storeId, binding.ownerId, binding.hostId, binding.projectId, binding.sessionId, binding.branchId,
              resources.root.path, resources.root.identity.dev, resources.root.identity.ino,
              resources.source.path, resources.source.identity.dev, resources.source.identity.ino,
              resources.store.path, resources.store.identity.dev, resources.store.identity.ino, 'open');
        });
      } else {
        check(version === 1, 'unsupported-probe-schema');
        check(this.#db.prepare('PRAGMA journal_mode').get()!.journal_mode === 'wal', 'invalid-journal-mode');
      }
      const row = this.#db.prepare('SELECT * FROM owner_fences WHERE store_id=?').get(storeId);
      check(row && row.owner_id === binding.ownerId && row.host_id === binding.hostId
        && row.project_id === binding.projectId && row.session_id === binding.sessionId && row.branch_id === binding.branchId, 'store-binding-mismatch');
      this.fence();
    } catch (error) { this.#db.close(); throw error; }
  }

  #verifyResources(): void {
    for (const resource of Object.values(this.#resources)) sameFile(resource.path, resource.identity);
  }

  #transaction<T>(action: () => T): T {
    this.#verifyResources();
    if (this.#depth) return action();
    this.#db.exec('BEGIN IMMEDIATE');
    this.#depth++;
    try {
      const value = action();
      check(!(value instanceof Promise), 'async-store-transaction');
      this.#verifyResources();
      this.#db.exec('COMMIT');
      return value;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    } finally { this.#depth--; }
  }

  fence(): Fence {
    this.#verifyResources();
    const row = this.#db.prepare('SELECT * FROM owner_fences WHERE store_id=?').get(this.#storeId);
    check(row, 'missing-owner-fence');
    for (const kind of ['root', 'source', 'store'] as const) {
      const resource = this.#resources[kind];
      check(row[`${kind}_path`] === resource.path && row[`${kind}_dev`] === resource.identity.dev
        && row[`${kind}_ino`] === resource.identity.ino, 'store-resource-mismatch');
    }
    return row as unknown as Fence;
  }

  register(): Activity {
    return this.#transaction(() => {
      const fence = this.fence();
      check(fence.state === 'open', 'admission-closed');
      const activity = { ...processIdentity, id: randomUUID(), epoch: fence.epoch, root: structuredClone(this.#resources.root) };
      this.#db.prepare('INSERT INTO owner_activities VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(activity.id, this.#storeId, activity.pid, activity.incarnation, activity.startedAt, activity.epoch,
          activity.root.path, activity.root.identity.dev, activity.root.identity.ino);
      return activity;
    });
  }

  withActivity<T>(activity: Activity, action: () => T): T {
    return this.#transaction(() => {
      const fence = this.fence();
      const row = this.#db.prepare('SELECT * FROM owner_activities WHERE id=?').get(activity.id);
      check(fence.state === 'open' && fence.epoch === activity.epoch && row
        && row.incarnation === processIdentity.incarnation && row.pid === process.pid && row.store_id === this.#storeId
        && row.root_path === this.#resources.root.path && row.root_dev === this.#resources.root.identity.dev
        && row.root_ino === this.#resources.root.identity.ino
        && JSON.stringify(activity.root) === JSON.stringify(this.#resources.root)
        && row.epoch === activity.epoch, 'admission-closed');
      return action();
    });
  }

  readIntent(activity: Activity): Intent | null {
    return this.withActivity(activity, () => {
      const row = this.#db.prepare(`SELECT e.* FROM intent_heads h JOIN intent_events e ON h.event_id=e.event_id
        WHERE h.session_id=? AND h.branch_id=?`).get(this.#binding.sessionId, this.#binding.branchId);
      if (!row) {
        const event = this.#db.prepare('SELECT 1 FROM intent_events WHERE session_id=? AND branch_id=? LIMIT 1').get(this.#binding.sessionId, this.#binding.branchId);
        check(!event, 'intent-evidence-gap');
        return null;
      }
      const snapshot = String(row.snapshot);
      check(sha256(snapshot) === row.hash, 'intent-evidence-gap');
      const intent = JSON.parse(snapshot) as Omit<Intent, 'hash'>;
      check(intent.schema === 'intent@1' && intent.eventId === row.event_id && intent.version === row.version
        && intent.intentId === row.intent_id && intent.status === row.status
        && intent.input.eventId === row.input_event_id && intent.input.hash === row.input_hash
        && intent.input.contentHash === row.input_content_hash
        && intent.input.locator === row.input_locator && intent.input.byteLength === row.input_bytes
        && intent.goalInput.eventId === row.goal_input_event_id && intent.goalInput.hash === row.goal_input_hash
        && intent.goalInput.contentHash === row.goal_input_content_hash
        && intent.goalInput.locator === row.goal_input_locator && intent.goalInput.byteLength === row.goal_input_bytes
        && sameBinding(intent.input.binding, this.#binding) && sameBinding(intent.goalInput.binding, this.#binding)
        && sameBinding(intent.binding, this.#binding), 'intent-evidence-gap');
      return { ...intent, hash: String(row.hash) };
    });
  }

  recoverIntent(activity: Activity): Intent | null {
    return this.withActivity(activity, () => {
      const current = this.readIntent(activity);
      const rows = this.#db.prepare('SELECT * FROM intent_events WHERE session_id=? AND branch_id=? ORDER BY version')
        .all(this.#binding.sessionId, this.#binding.branchId);
      let prior: string | null = null;
      for (const [index, row] of rows.entries()) {
        check(row.version === index + 1 && row.expected_event_id === prior && sha256(String(row.snapshot)) === row.hash, 'intent-evidence-gap');
        prior = String(row.event_id);
      }
      check(prior === (current?.eventId ?? null), 'intent-evidence-gap');
      return current;
    });
  }

  transitionIntent(activity: Activity, expected: string | null, input: SourceAck, transition: IntentTransition, initialGoal?: string): Intent {
    return this.withActivity(activity, () => {
      check(sameBinding(input.binding, this.#binding) && input.status === 'durable', 'source-scope-mismatch');
      uuid(input.eventId);
      check(transition && typeof transition === 'object'
        && Object.keys(transition).every(key => key === 'step' || key === 'status'), 'invalid-transition');
      check(['active', 'paused', 'completed', 'needs-input'].includes(transition.status)
        && typeof transition.step === 'string' && transition.step.length > 0 && Buffer.byteLength(transition.step) <= 1024, 'invalid-transition');
      const transitionHash = sha256(JSON.stringify({ expected, input, transition, initialGoal: initialGoal ?? null }));
      const previous = this.#db.prepare('SELECT * FROM intent_events WHERE session_id=? AND branch_id=? AND input_event_id=?')
        .get(this.#binding.sessionId, this.#binding.branchId, input.eventId);
      if (previous) {
        check(previous.transition_hash === transitionHash, 'identity-conflict');
        return { ...JSON.parse(String(previous.snapshot)), hash: previous.hash } as Intent;
      }
      const current = this.readIntent(activity);
      check((current?.eventId ?? null) === expected, 'intent-stale');
      check(current || (typeof initialGoal === 'string' && Buffer.byteLength(initialGoal) <= 65536
        && sha256(initialGoal) === input.contentHash), 'intent-needs-input');
      const snapshot: Omit<Intent, 'hash'> = {
        schema: 'intent@1', intentId: current?.intentId ?? randomUUID(), eventId: randomUUID(),
        version: (current?.version ?? 0) + 1, binding: this.#binding,
        goal: current?.goal ?? initialGoal!, constraints: current?.constraints ?? ['synthetic-only', 'local-counting-transport-only'],
        step: transition.step, status: transition.status, input, goalInput: current?.goalInput ?? input,
      };
      const bytes = JSON.stringify(snapshot);
      const hash = sha256(bytes);
      this.#db.prepare('INSERT INTO intent_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(snapshot.eventId, snapshot.intentId, snapshot.version, this.#binding.sessionId, this.#binding.branchId,
          input.eventId, expected, snapshot.status, input.hash, input.contentHash, input.locator, input.byteLength,
          snapshot.goalInput.eventId, snapshot.goalInput.hash, snapshot.goalInput.contentHash, snapshot.goalInput.locator, snapshot.goalInput.byteLength,
          transitionHash, bytes, hash);
      this.#db.prepare(`INSERT INTO intent_heads VALUES (?, ?, ?) ON CONFLICT(session_id,branch_id) DO UPDATE SET event_id=excluded.event_id`)
        .run(this.#binding.sessionId, this.#binding.branchId, snapshot.eventId);
      return { ...snapshot, hash };
    });
  }

  beginMaintenance(coordinator: string): Fence {
    return this.#transaction(() => {
      const fence = this.fence();
      if (fence.state !== 'open' && fence.coordinator !== coordinator) {
        check(fence.coordinator_pid !== null && processAbsent(fence.coordinator_pid), 'maintenance-owned');
      }
      if (fence.coordinator !== coordinator) {
        this.#db.prepare(`UPDATE owner_fences SET state='closing',epoch=epoch+1,coordinator=?,coordinator_pid=? WHERE store_id=?`)
          .run(coordinator, process.pid, this.#storeId);
      }
      return this.fence();
    });
  }

  acquireMaintenance(coordinator: string): { acquired: boolean; observations: { id: string; pid: number; incarnation: string; absent: boolean; observedAt: string; method: string }[] } {
    return this.#transaction(() => {
      const fence = this.fence();
      check(fence.coordinator === coordinator && fence.coordinator_pid === process.pid && fence.state !== 'open', 'maintenance-owned');
      const rows = this.#db.prepare('SELECT * FROM owner_activities WHERE store_id=?').all(this.#storeId);
      const observations = rows.map(row => ({
        id: String(row.id), pid: Number(row.pid), incarnation: String(row.incarnation),
        absent: processAbsent(Number(row.pid)), observedAt: new Date().toISOString(), method: 'node-process-kill-0/ESRCH',
      }));
      const acquired = observations.every(item => item.absent);
      if (acquired) this.#db.prepare("UPDATE owner_fences SET state='exclusive' WHERE store_id=?").run(this.#storeId);
      return { acquired, observations };
    });
  }

  releaseMaintenance(coordinator: string): Fence {
    return this.#transaction(() => {
      const fence = this.fence();
      check(fence.coordinator === coordinator && fence.coordinator_pid === process.pid && fence.state === 'exclusive', 'maintenance-not-exclusive');
      this.#db.prepare('DELETE FROM owner_activities WHERE store_id=?').run(this.#storeId);
      this.#db.prepare("UPDATE owner_fences SET state='open',epoch=epoch+1,coordinator=NULL,coordinator_pid=NULL WHERE store_id=?").run(this.#storeId);
      return this.fence();
    });
  }

  diagnostics(): { sqlite: string; journalMode: unknown; synchronous: unknown; foreignKeys: unknown; busyTimeout: unknown } {
    return {
      sqlite: String(this.#db.prepare('SELECT sqlite_version() AS version').get()!.version),
      journalMode: this.#db.prepare('PRAGMA journal_mode').get()!.journal_mode,
      synchronous: this.#db.prepare('PRAGMA synchronous').get()!.synchronous,
      foreignKeys: this.#db.prepare('PRAGMA foreign_keys').get()!.foreign_keys,
      busyTimeout: this.#db.prepare('PRAGMA busy_timeout').get()!.timeout,
    };
  }
  close(): void { this.#db.close(); }
}

function processAbsent(pid: number): boolean {
  check(Number.isSafeInteger(pid) && pid > 0, 'invalid-process-identity');
  try { process.kill(pid, 0); return false; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    throw new Error('process-exit-evidence-gap', { cause: error });
  }
}
