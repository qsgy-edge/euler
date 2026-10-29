import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { check, ProbeStore, sameFile, sha256 } from '@euler/core';
import type { BoundFile, PurgeCarrier, PurgeInput, PurgePresentation } from '@euler/core';
import { CliArchive } from './archive.ts';
import { openMaintenanceStore } from './backup.ts';
import { killPoint } from './kill-point.ts';
import type { Sandbox } from './sandbox.ts';

export function readPurgeCarriers(sandbox: Sandbox, store: ProbeStore, coordinator: string): PurgeCarrier[] {
  const resources = store.purgeResources(coordinator);
  const capture = (file: BoundFile) => {
    sameFile(file.path, file.identity);
    const bytes = readFileSync(file.path);
    sameFile(file.path, file.identity);
    return { file, hash: sha256(bytes), bytes: bytes.length };
  };
  const carriers: PurgeCarrier[] = resources.sources.map(({ binding, source }) => {
    const archive = new CliArchive({ ...sandbox, sourceName: basename(source.path), archiveIdentity: source.identity,
      fixture: { ...sandbox.fixture, ...binding } }, action => action());
    return { role: 'source', ...capture(source), entries: archive.events().map(entry => ({ id: entry.ack.eventId,
      value: entry, hash: entry.ack.hash, source: entry.ack, content: entry.text })) };
  });
  check(sandbox.ownerInfoIdentity, 'owner-info-unavailable');
  for (const [role, name, identity, schema] of [
    ['owner-info', 'owner-info.jsonl', sandbox.ownerInfoIdentity, 'owner-info@1'],
    ['receiver', 'counting-receiver.jsonl', sandbox.receiverIdentity, 'counting-receiver@1'],
  ] as const) {
    const file = { path: join(sandbox.root, name), identity }, bytes = readFileSync(file.path, 'utf8');
    check(bytes.endsWith('\n'), 'purge-carrier-evidence-gap');
    const lines = bytes.slice(0, -1).split('\n'), header = JSON.parse(lines.shift()!);
    check(header.schema === schema && header.storeId === sandbox.storeId, 'purge-carrier-binding-mismatch');
    carriers.push({ role, ...capture(file), entries: lines.map((line, index) => {
      const value = JSON.parse(line);
      check(role === 'owner-info' ? value.schema === 'owner-info-entry@1' : typeof value.record === 'object', 'purge-unsupported-carrier-entry');
      return { id: String(role === 'owner-info' ? value.entryId : value.record.attemptId ?? index), value, hash: sha256(line),
        ...role === 'owner-info' ? { content: value.payload } : {} };
    }) });
  }
  for (const output of resources.outputs.filter(file => file.started && file.state !== 'no_effect')) {
    check(output.state === 'recorded' && output.identity, 'purge-project-output-evidence-gap');
    const file = { path: output.path, identity: output.identity };
    if (carriers.some(carrier => carrier.file.path === file.path)) continue;
    const captured = capture(file);
    const content = readFileSync(file.path, 'utf8');
    carriers.push({ role: 'project-output', ...captured, entries: [{ id: output.callId,
      value: { ...output, content }, hash: captured.hash, content }] });
  }
  return carriers;
}

export async function runPurge(sandbox: Sandbox, recordId?: string, scenario = 'success') {
  check(['success', 'purge-before-commit', 'purge-after-commit', 'purge-unknown',
    'source-before-delete', 'source-after-delete', 'source-after-ack', 'source-takeover'].includes(scenario), 'invalid-purge-scenario');
  const store = openMaintenanceStore(sandbox);
  const coordinator = randomUUID(), lines = createInterface({ input: process.stdin });
  const emit = (event: string, fields: object) => new Promise<void>((resolve, reject) =>
    process.stdout.write(JSON.stringify({ event, ...fields }) + '\n', error => error ? reject(error) : resolve()));
  let preview: PurgePresentation | undefined;
  try {
    const fence = store.beginMaintenance(coordinator);
    const acquire = async () => {
      const result = store.acquireMaintenance(coordinator);
      if (!result.acquired) { await emit('maintenance-blocked', result); return; }
      const committed = store.purgeStatus(coordinator);
      if (committed) {
        if (scenario === 'source-takeover') killPoint('purge-source-checkpoint', 'takeover', 10000);
        await emit('purge-result', committed); return;
      }
      check(recordId, 'purge-target-required');
      preview = store.previewPurge(coordinator, recordId, readPurgeCarriers(sandbox, store, coordinator));
      await emit('purge-preview', { ...preview, cleanup: 'not-started' });
      store.acknowledgePurgePresentation(coordinator, preview.token, preview.digest);
    };
    const handle = async (line: string, input?: PurgeInput) => {
      try {
        if (line === 'acquire') { await acquire(); return; }
        if (line === 'cancel') {
          const result = store.cancelPurge(coordinator);
          await emit(result.status === 'settled' ? 'purge-settled' : 'purge-cancelled', result);
          if (result.status === 'cancelled') lines.close();
          return;
        }
        if (line === 'cleanup-source') {
          const result = store.cleanupPurgeSources(coordinator, (binding, source) => {
            const archive = new CliArchive({ ...sandbox, sourceName: basename(source.path), archiveIdentity: source.identity,
              fixture: { ...sandbox.fixture, ...binding } }, action => action());
            return {
              preparePurge: selection => archive.preparePurge(selection),
              purge: (selection, plan) => {
                if (scenario === 'source-before-delete') killPoint('purge-source-checkpoint', 'before-delete', 10000);
                const ack = archive.purge(selection, plan);
                if (scenario === 'source-after-delete') killPoint('purge-source-checkpoint', 'after-delete', 10000);
                return ack;
              },
            };
          });
          if (scenario === 'source-after-ack') killPoint('purge-source-checkpoint', 'after-ack', 10000);
          await emit('purge-source-result', result); return;
        }
        const committed = store.purgeStatus(coordinator);
        if (committed) { await emit(line === 'status' ? 'purge-result' : 'purge-settled', committed); return; }
        check(preview && input, 'purge-preview-required');
        if (scenario === 'purge-before-commit') killPoint('purge-checkpoint', 'before-commit', 10000);
        const result = store.commitPurge(coordinator, input, preview.token, readPurgeCarriers(sandbox, store, coordinator));
        preview = undefined;
        if (scenario === 'purge-after-commit') killPoint('purge-checkpoint', 'after-commit', 10000);
        if (scenario === 'purge-unknown') throw new Error('injected-lost-purge-ack');
        await emit('purge-result', result);
      } catch (error) {
        const committed = store.purgeStatus(coordinator);
        if (committed) await emit(line === 'cleanup-source' ? 'purge-source-result' : 'purge-result',
          { ...committed, error: (error as Error).message });
        else {
          const reason = (error as Error).message;
          if (reason !== 'exact-live-purge-phrase-required') {
            store.invalidatePurgePresentation(coordinator); preview = undefined;
          }
          await emit('purge-rejected', { reason, cleanup: 'not-started' });
        }
      }
    };
    let failure: unknown;
    const fail = (error: unknown) => { failure = error; lines.close(); };
    const closed = new Promise<void>(resolve => lines.once('close', resolve));
    let queue = emit('maintenance-closing', { epoch: fence.epoch }).then(() => handle('acquire')).catch(fail);
    lines.on('line', line => {
      try {
        const input = store.receivePurgeInput(coordinator, line);
        queue = queue.then(() => handle(line, input)).catch(fail);
      } catch (error) { fail(error); }
    });
    await closed;
    await queue;
    if (failure) throw failure;
  } finally { lines.close(); store.close(); }
}
