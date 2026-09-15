import { basename, join } from 'node:path';
import { openSync, closeSync, readFileSync, writeSync, fsyncSync } from 'node:fs';
import { API_VERSION, DEFAULT_BUDGET, ProbeSession, ProbeStore, sha256, validateBudget, check, sameFile } from '@euler/core';
import type { Activity, Binding, SourceAck, ExecutionOwner, ProbeBudget, RequestRecovery, RequestAttempt, RequestReconciliation } from '@euler/core';
import { CliArchive } from './archive.ts';
import { bindingOf, openSandbox, resourcesOf } from './sandbox.ts';
import type { Sandbox } from './sandbox.ts';

export class CountingTransport {
  readonly kind = 'local-counting@1';
  readonly #payloads: string[] = [];
  readonly sandbox: Sandbox | undefined;
  constructor(sandbox?: Sandbox) { this.sandbox = sandbox; }
  get count(): number { return this.#payloads.length; }
  get payloads(): readonly string[] { return [...this.#payloads]; }
  #readReceiver(): { bytes: string; records: { attemptId: string | null; runId: string | null; payloadHash: string; byteLength: number }[] } {
    check(this.sandbox, 'receiver-unavailable');
    const path = join(this.sandbox.root, 'counting-receiver.jsonl');
    sameFile(path, this.sandbox.receiverIdentity);
    const bytes = readFileSync(path, 'utf8');
    check(bytes.endsWith('\n'), 'receiver-evidence-gap');
    const lines = bytes.trimEnd().split('\n').map(line => JSON.parse(line));
    const header = lines.shift();
    check(header?.schema === 'counting-receiver@1' && header.storeId === this.sandbox.storeId, 'receiver-evidence-gap');
    const records = lines.map(({ record, hash }) => {
      check(record && hash === sha256(JSON.stringify(record)), 'receiver-evidence-gap');
      return record;
    });
    return { bytes, records };
  }
  query(attempt: RequestAttempt): RequestReconciliation {
    check(attempt.adapterVersion === API_VERSION, 'reconciliation-reader-unavailable');
    const { bytes, records } = this.#readReceiver();
    check(records.every(record => record.attemptId !== null), 'receiver-unbound-observation');
    const hits = records.filter(record => record.attemptId === attempt.attemptId);
    check(hits.length <= 1 && hits.every(record => record.runId === attempt.runId
      && record.payloadHash === attempt.payloadHash && record.byteLength === attempt.byteLength), 'receiver-evidence-gap');
    return { attemptId: attempt.attemptId, runId: attempt.runId, payloadHash: attempt.payloadHash,
      byteLength: attempt.byteLength, outcome: hits.length ? 'received' : 'not-received', receiptHash: sha256(bytes) };
  }
  send(payload: string, attempt?: { attemptId: string; runId: string; payloadHash: string; byteLength: number }): { hash: string; byteLength: number; count: number } {
    const hash = sha256(payload), byteLength = Buffer.byteLength(payload);
    check(!attempt || (attempt.payloadHash === hash && attempt.byteLength === byteLength), 'receiver-payload-mismatch');
    if (this.sandbox) {
      this.#readReceiver();
      const record = { attemptId: attempt?.attemptId ?? null, runId: attempt?.runId ?? null, payloadHash: hash, byteLength };
      const fd = openSync(join(this.sandbox.root, 'counting-receiver.jsonl'), 'a');
      try {
        const bytes = Buffer.from(JSON.stringify({ record, hash: sha256(JSON.stringify(record)) }) + '\n');
        check(writeSync(fd, bytes) === bytes.length, 'receiver-short-write');
        fsyncSync(fd);
      } finally { closeSync(fd); }
    }
    this.#payloads.push(payload);
    return { hash, byteLength, count: this.count };
  }
}

export function openProbe(sandbox: Sandbox, budget: ProbeBudget = DEFAULT_BUDGET, registration?: ExecutionOwner | string, selectedBinding?: Binding, recovery?: RequestRecovery, diagnosticsOnly = false) {
  validateBudget(budget);
  sandbox = openSandbox(sandbox.root);
  const binding = selectedBinding ?? bindingOf(sandbox);
  let activity: Activity;
  const transport = new CountingTransport(sandbox);
  const queryRequest = (attempt: RequestAttempt) => transport.query(attempt);
  const readSource = (input: SourceAck) => archiveFor(input.binding).read(input);
  let store = new ProbeStore(resourcesOf(sandbox), sandbox.storeId, bindingOf(sandbox), false, readSource, sandbox.appId, queryRequest);
  if (selectedBinding) {
    try {
      const source = store.sessionSource(binding);
      store.close();
      store = new ProbeStore({ ...resourcesOf(sandbox), source }, sandbox.storeId, binding, false, readSource, sandbox.appId, queryRequest);
    } catch (error) { try { store.close(); } catch {} throw error; }
  }
  function archiveFor(sourceBinding: Binding): CliArchive {
    const source = store.sessionSource(sourceBinding);
    return new CliArchive({ ...sandbox, sourceName: basename(source.path), archiveIdentity: source.identity,
      fixture: { ...sandbox.fixture, ...sourceBinding } }, action => store.withActivity(activity, action));
  }
  try {
    activity = typeof registration === 'string' ? store.claimChild(registration) : store.register(registration);
    const archive = archiveFor(binding);
    let session: ProbeSession | undefined = diagnosticsOnly ? undefined
      : new ProbeSession(store, activity, { version: API_VERSION, binding, source: archive, transport }, budget, recovery);
    return { store, activity, archive, transport,
      get session() { return session ??= new ProbeSession(store, activity, { version: API_VERSION, binding, source: archive, transport }, budget, recovery); },
      close: () => { try { session?.close(); } finally { store.close(); } } };
  } catch (error) { store.close(); throw error; }
}
