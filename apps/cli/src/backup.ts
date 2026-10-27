import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { check, ProbeStore } from '@euler/core';
import type { StoreSnapshot } from '@euler/core';
import { CliArchive } from './archive.ts';
import { OwnerInfoLog } from './owner-memory.ts';
import { openProbe } from './probe.ts';
import { bindingOf, createSandboxSession, openSandbox, resourcesOf, OWNER_INFO_FILE } from './sandbox.ts';
import type { Sandbox } from './sandbox.ts';

export async function backupSandbox(input: Sandbox, kind: StoreSnapshot['kind'] = 'daily') {
  const sandbox = openSandbox(input.root);
  const probe = openProbe(sandbox, undefined, undefined, undefined, undefined, true);
  try {
    check(sandbox.ownerInfoIdentity, 'owner-info-unavailable');
    return await probe.store.createSnapshot(probe.activity, {
      files: [
        { file: { path: join(sandbox.root, OWNER_INFO_FILE), identity: sandbox.ownerInfoIdentity }, role: 'owner-info' },
        { file: { path: join(sandbox.root, 'counting-receiver.jsonl'), identity: sandbox.receiverIdentity }, role: 'receiver' },
      ],
      validate: () => {
        for (const item of probe.store.snapshotSources(probe.activity)) {
          const archive = new CliArchive({ ...sandbox, sourceName: basename(item.source.path), archiveIdentity: item.source.identity,
            fixture: { ...sandbox.fixture, ...item.binding } }, action => action());
          archive.inspect();
        }
        const ownerInfo = new OwnerInfoLog(sandbox, action => action(), entries => probe.store.assertHostInfoCarrier(probe.activity,
          entries.map(entry => ({ batchId: entry.record.batchId, digest: entry.record.digest,
            entryId: entry.record.entryId, entryHash: entry.entryHash }))));
        probe.store.assertHostInfoCarrier(probe.activity, ownerInfo.entries().map(entry => ({ batchId: entry.record.batchId,
          digest: entry.record.digest, entryId: entry.record.entryId, entryHash: entry.entryHash })));
        probe.transport.inspect();
      },
    }, kind);
  } finally { probe.close(); }
}

export async function restoreSandboxSnapshot(input: Sandbox, snapshotId: string) {
  const sandbox = openSandbox(input.root);
  const store: ProbeStore = new ProbeStore(resourcesOf(sandbox), sandbox.storeId, bindingOf(sandbox), false, ref => {
    const source = store.sessionSource(ref.binding);
    return new CliArchive({ ...sandbox, sourceName: basename(source.path), archiveIdentity: source.identity,
      fixture: { ...sandbox.fixture, ...ref.binding } }, action => action()).read(ref);
  }, sandbox.appId);
  const coordinator = randomUUID();
  try {
    store.beginSnapshotRecovery(coordinator, snapshotId);
    check(store.acquireMaintenance(coordinator).acquired, 'maintenance-residuals-or-participants');
    return await store.restoreSnapshot(coordinator, snapshotId);
  } finally { store.close(); }
}

export function runNewRecoverySession(input: Sandbox) {
  const binding = { ...bindingOf(input), sessionId: randomUUID(), branchId: randomUUID() };
  createSandboxSession(input, binding);
  const probe = openProbe(input, undefined, undefined, binding);
  try {
    const receipt = probe.session.dispatch(probe.session.prepare(randomUUID(), 'Synthetic new task after snapshot recovery.'));
    return { sessionId: binding.sessionId, receipt };
  } finally { probe.close(); }
}

export function listSandboxBackups(input: Sandbox): StoreSnapshot[] {
  const probe = openProbe(input, undefined, undefined, undefined, undefined, true);
  try { return probe.store.listSnapshots(probe.activity); } finally { probe.close(); }
}
