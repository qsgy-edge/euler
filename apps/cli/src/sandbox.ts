import { closeSync, fsyncSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { check, sha256 } from '@euler/core';
import fixtureData from '../../../fixtures/first-turn.json' with { type: 'json' };
import { ProbeStore, fileIdentity, sameFile } from '@euler/core';
import type { FileIdentity, StoreResources } from '@euler/core';
import type { Binding } from '@euler/core';

export interface Fixture extends Binding {
  schema: string;
  eventId: string;
  text: string;
  constraints: string[];
}
export const fixture: Fixture = fixtureData;
export const fixtureDigest = sha256(JSON.stringify(fixture));

export function syncFile(path: string): void {
  const fd = openSync(path, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function syncDirectory(path: string): void {
  if (process.platform === 'win32') return; // No portable Node directory flush on Windows.
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export interface Sandbox {
  schema: 'euler-disposable@1';
  appId: 'euler';
  storeId: string;
  root: string;
  rootIdentity: FileIdentity;
  archiveIdentity: FileIdentity;
  storeIdentity: FileIdentity;
  fixtureDigest: string;
  fixture: Fixture;
}

export function bindingOf(sandbox: Sandbox): Binding {
  const { ownerId, hostId, projectId, sessionId, branchId } = sandbox.fixture;
  return { ownerId, hostId, projectId, sessionId, branchId };
}

export function resourcesOf(sandbox: Sandbox): StoreResources {
  return {
    root: { path: sandbox.root, identity: sandbox.rootIdentity },
    source: { path: join(sandbox.root, 'session.jsonl'), identity: sandbox.archiveIdentity },
    store: { path: join(sandbox.root, 'probe.sqlite'), identity: sandbox.storeIdentity },
  };
}

export function createSandbox(): Sandbox {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'euler-t01-')));
  const archive = join(root, 'session.jsonl');
  const store = join(root, 'probe.sqlite');
  writeFileSync(archive, JSON.stringify({ schema: 'cli-session@1', binding: bindingOf({ fixture } as Sandbox) }) + '\n', { flag: 'wx', mode: 0o600 });
  writeFileSync(store, '', { flag: 'wx', mode: 0o600 });
  syncFile(archive);
  syncFile(store);
  const sandbox: Sandbox = {
    schema: 'euler-disposable@1', appId: 'euler', storeId: randomUUID(), root,
    rootIdentity: fileIdentity(root), archiveIdentity: fileIdentity(archive), storeIdentity: fileIdentity(store),
    fixtureDigest, fixture,
  };
  const initialized = new ProbeStore(resourcesOf(sandbox), sandbox.storeId, bindingOf(sandbox), true);
  initialized.close();
  const { fixture: _fixture, ...manifest } = sandbox;
  writeFileSync(join(root, 'sandbox.json'), JSON.stringify(manifest) + '\n', { flag: 'wx', mode: 0o600 });
  syncFile(join(root, 'sandbox.json'));
  syncDirectory(root);
  return sandbox;
}

export function openSandbox(path: string): Sandbox {
  const root = resolve(path);
  check(dirname(root) === realpathSync(tmpdir()) && basename(root).startsWith('euler-t01-'), 'not-disposable-root');
  check(realpathSync(root) === root, 'unsafe-root-alias');
  const sandbox = JSON.parse(readFileSync(join(root, 'sandbox.json'), 'utf8')) as Omit<Sandbox, 'fixture'>;
  check(sandbox.schema === 'euler-disposable@1' && sandbox.appId === 'euler' && sandbox.root === root, 'invalid-sandbox');
  check(sandbox.fixtureDigest === fixtureDigest, 'fixture-mismatch');
  sameFile(root, sandbox.rootIdentity);
  sameFile(join(root, 'probe.sqlite'), sandbox.storeIdentity);
  sameFile(join(root, 'session.jsonl'), sandbox.archiveIdentity);
  return { ...sandbox, fixture };
}
