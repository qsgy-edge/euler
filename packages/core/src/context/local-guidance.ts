import { closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { check, sha256 } from '../contracts.ts';
import type { BoundFile } from '../store/probe-store.ts';
import { sameFile } from '../store/probe-store.ts';

export interface GuidanceFile { locator: string; version: string; hash: string; byteLength: number; text: string }
export function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
export function verifyRoot(root: BoundFile): string {
  sameFile(root.path, root.identity);
  check(statSync(root.path).isDirectory(), 'guidance-root-unavailable');
  return realpathSync.native(root.path);
}
export function targetChain(root: BoundFile, path: string): string[] {
  const canonical = verifyRoot(root);
  check(isAbsolute(path) && within(root.path, path), 'guidance-outside-project');
  const target = resolve(canonical, relative(root.path, path));
  const chain = [canonical];
  let current = canonical;
  const parts = relative(canonical, target).split(sep).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    current = resolve(current, part);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) {
      check((error as NodeJS.ErrnoException).code === 'ENOENT' && index === parts.length - 1, 'guidance-resource-unavailable');
      break;
    }
    check(!stat.isSymbolicLink() && realpathSync.native(current) === current, 'guidance-resource-alias');
    if (stat.isDirectory()) chain.push(current);
    else check(stat.isFile() && index === parts.length - 1, 'guidance-resource-unavailable');
  }
  return chain;
}

// Cache only verified bytes with a full file identity/version stamp. Every boundary
// checks metadata again; a new window deliberately bypasses the cached body.
export class LocalGuidanceFiles {
  #cache = new Map<string, GuidanceFile>();
  clear(): void { this.#cache.clear(); }
  read(path: string, root: string, optional = false): GuidanceFile | null {
    check(within(root, path), 'guidance-source-outside-root');
    let current = root;
    for (const part of relative(root, path).split(sep).filter(Boolean)) {
      current = resolve(current, part);
      try {
        const stat = lstatSync(current);
        check(!stat.isSymbolicLink(), 'guidance-source-alias');
      } catch (error) {
        if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    }
    const locator = realpathSync.native(path);
    check(within(root, locator), 'guidance-source-outside-root');
    const fd = openSync(locator, 'r');
    try {
      const stat = fstatSync(fd, { bigint: true });
      check(stat.isFile() && stat.nlink === 1n && stat.size <= 49152n, 'guidance-source-integrity');
      const version = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
      const cached = this.#cache.get(locator);
      if (cached?.version === version) return structuredClone(cached);
      const bytes = readFileSync(fd);
      const after = fstatSync(fd, { bigint: true });
      check(version === [after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs].join(':'), 'guidance-source-changed');
      check(realpathSync.native(path) === locator && lstatSync(path, { bigint: true }).ino === stat.ino, 'guidance-source-changed');
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      check(Buffer.from(text).equals(bytes), 'guidance-source-integrity');
      const file = { locator, version, hash: sha256(bytes), byteLength: bytes.length, text };
      this.#cache.set(locator, file);
      return structuredClone(file);
    } finally { closeSync(fd); }
  }
}
