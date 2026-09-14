import { basename } from 'node:path';
import { API_VERSION, DEFAULT_BUDGET, ProbeSession, ProbeStore, sha256, validateBudget } from '@euler/core';
import type { Activity, Binding, SourceAck, ExecutionOwner, ProbeBudget } from '@euler/core';
import { CliArchive } from './archive.ts';
import { bindingOf, openSandbox, resourcesOf } from './sandbox.ts';
import type { Sandbox } from './sandbox.ts';

export class CountingTransport {
  readonly kind = 'local-counting@1';
  readonly #payloads: string[] = [];
  get count(): number { return this.#payloads.length; }
  get payloads(): readonly string[] { return [...this.#payloads]; }
  send(payload: string): { hash: string; byteLength: number; count: number } {
    this.#payloads.push(payload);
    return { hash: sha256(payload), byteLength: Buffer.byteLength(payload), count: this.count };
  }
}

export function openProbe(sandbox: Sandbox, budget: ProbeBudget = DEFAULT_BUDGET, registration?: ExecutionOwner | string, selectedBinding?: Binding) {
  validateBudget(budget);
  sandbox = openSandbox(sandbox.root);
  const binding = selectedBinding ?? bindingOf(sandbox);
  let activity: Activity;
  const readSource = (input: SourceAck) => archiveFor(input.binding).read(input);
  let store = new ProbeStore(resourcesOf(sandbox), sandbox.storeId, bindingOf(sandbox), false, readSource, sandbox.appId);
  if (selectedBinding) {
    try {
      const source = store.sessionSource(binding);
      store.close();
      store = new ProbeStore({ ...resourcesOf(sandbox), source }, sandbox.storeId, binding, false, readSource, sandbox.appId);
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
    const transport = new CountingTransport();
    const session = new ProbeSession(store, activity, { version: API_VERSION, binding, source: archive, transport }, budget);
    return { store, activity, archive, transport, session, close: () => { try { session.close(); } finally { store.close(); } } };
  } catch (error) { store.close(); throw error; }
}
