import { API_VERSION, DEFAULT_BUDGET, ProbeSession, ProbeStore, sha256, validateBudget } from '@euler/core';
import type { ProbeBudget } from '@euler/core';
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

export function openProbe(sandbox: Sandbox, budget: ProbeBudget = DEFAULT_BUDGET) {
  validateBudget(budget);
  sandbox = openSandbox(sandbox.root);
  const binding = bindingOf(sandbox);
  let archive: CliArchive;
  const store = new ProbeStore(resourcesOf(sandbox), sandbox.storeId, binding, false, input => archive.read(input));
  try {
    const activity = store.register();
    archive = new CliArchive(sandbox, action => store.withActivity(activity, action));
    const transport = new CountingTransport();
    const session = new ProbeSession(store, activity, { version: API_VERSION, binding, source: archive, transport }, budget);
    return { store, activity, archive, transport, session, close: () => { session.cancel(); store.close(); } };
  } catch (error) { store.close(); throw error; }
}
