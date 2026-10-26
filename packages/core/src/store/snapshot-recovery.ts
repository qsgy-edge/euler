import { closeSync, fstatSync, fsyncSync, ftruncateSync, openSync, writeSync } from 'node:fs';
import type { ControlledFile } from '../context/file-contract.ts';
import type { BoundFile } from './probe-store.ts';
import type { StoreSnapshot, SnapshotFile } from './snapshots.ts';
import { sameFile } from './probe-store.ts';
import { check } from '../contracts.ts';

export interface SnapshotRecoveryReceipt {
  schema: 'store/recovered-from-snapshot@v1'; operationId: string; outcome: 'recovered_with_gap'; createdAt: string;
}
export interface SnapshotRecoveryPlan {
  operationId: string; snapshot: StoreSnapshot; original: BoundFile; stage: BoundFile;
  originals: SnapshotFile[]; controlledFiles: ControlledFile[]; receipt: SnapshotRecoveryReceipt;
}
export interface SnapshotRecoveryPreparation {
  operationId: string; snapshot: StoreSnapshot; original: { path: string; identity: BoundFile['identity'] | null };
  files: Pick<SnapshotFile, 'source' | 'name' | 'role'>[]; controlledFiles: ControlledFile[]; receipt: SnapshotRecoveryReceipt;
}
export function recoveryFileNames(recovery: SnapshotRecoveryPlan | SnapshotRecoveryPreparation): string[] {
  const files = 'originals' in recovery ? recovery.originals : recovery.files;
  return [...files.map(file => file.name), 'store.sqlite-wal',
    'restore.sqlite', 'restore.sqlite-wal', 'restore.sqlite-shm', 'restore.sqlite-journal'];
}

/** Existing resources keep their identity; interruption is resumed under the closed Store fence. */
export function restoreFile(file: BoundFile, bytes: Uint8Array): void {
  sameFile(file.path, file.identity);
  const fd = openSync(file.path, 'r+');
  try {
    const stat = fstatSync(fd, { bigint: true });
    check(stat.dev.toString() === file.identity.dev && stat.ino.toString() === file.identity.ino, 'file-identity-changed');
    ftruncateSync(fd, 0);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
      check(written > 0, 'snapshot-restore-short-write');
      offset += written;
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  sameFile(file.path, file.identity);
}
