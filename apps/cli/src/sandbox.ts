import { closeSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
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
  appId: string;
  storeId: string;
  root: string;
  rootIdentity: FileIdentity;
  archiveIdentity: FileIdentity;
  sourceName?: string;
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
    source: { path: join(sandbox.root, sandbox.sourceName ?? 'session.jsonl'), identity: sandbox.archiveIdentity },
    store: { path: join(sandbox.root, sandbox.appId === 'euler' ? 'probe.sqlite' : 'store.sqlite3'), identity: sandbox.storeIdentity },
  };
}

export function resolveDataRoot(appId = 'euler'): string {
  check(/^[a-z][a-z0-9-]{0,80}$/.test(appId), 'invalid-app-id');
  const base = process.platform === 'win32' ? process.env.LOCALAPPDATA
    : process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support')
      : process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  check(base && isAbsolute(base), 'local-data-root-unavailable');
  return join(base, appId);
}

export function createSandbox(appId = 'euler'): Sandbox {
  let root: string;
  if (arguments.length === 0) root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'euler-t01-')));
  else {
    check(/^euler-t04-[0-9a-f-]{36}$/.test(appId), 'synthetic-app-id-required');
    const path = resolveDataRoot(appId);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    mkdirSync(path, { mode: 0o700 }); // Existing identities are opened, never reset.
    root = realpathSync(path);
  }
  const archive = join(root, 'session.jsonl');
  const store = join(root, appId === 'euler' ? 'probe.sqlite' : 'store.sqlite3');
  writeFileSync(archive, JSON.stringify({ schema: 'cli-session@1', binding: bindingOf({ fixture } as Sandbox) }) + '\n', { flag: 'wx', mode: 0o600 });
  writeFileSync(store, '', { flag: 'wx', mode: 0o600 });
  syncFile(archive);
  syncFile(store);
  const sandbox: Sandbox = {
    schema: 'euler-disposable@1', appId, storeId: randomUUID(), root,
    rootIdentity: fileIdentity(root), archiveIdentity: fileIdentity(archive), storeIdentity: fileIdentity(store),
    fixtureDigest, fixture,
  };
  const initialized = new ProbeStore(resourcesOf(sandbox), sandbox.storeId, bindingOf(sandbox), true, undefined, appId);
  initialized.close();
  const { fixture: _fixture, ...manifest } = sandbox;
  writeFileSync(join(root, 'sandbox.json'), JSON.stringify(manifest) + '\n', { flag: 'wx', mode: 0o600 });
  syncFile(join(root, 'sandbox.json'));
  syncDirectory(root);
  return sandbox;
}

export function createSandboxSession(sandbox: Sandbox, binding: Binding): void {
  sandbox = openSandbox(sandbox.root);
  const store = new ProbeStore(resourcesOf(sandbox), sandbox.storeId, bindingOf(sandbox), false, undefined, sandbox.appId);
  try {
    const activity = store.register();
    store.withActivity(activity, () => {
      const path = join(sandbox.root, `session-${binding.sessionId}.jsonl`);
      // The Store validates the complete binding before any session becomes usable.
      check(/^[0-9a-f-]{36}$/.test(binding.sessionId), 'invalid-session-id');
      writeFileSync(path, JSON.stringify({ schema: 'cli-session@1', binding }) + '\n', { flag: 'wx', mode: 0o600 });
      syncFile(path);
      store.bindSession(activity, binding, { path, identity: fileIdentity(path) });
      syncDirectory(sandbox.root);
    });
  } finally { store.close(); }
}

export function openSandbox(path: string): Sandbox {
  const root = resolve(path);
  const standard = /^euler-t04-[0-9a-f-]{36}$/.test(basename(root)) && resolveDataRoot(basename(root)) === root;
  check(standard || (dirname(root) === realpathSync(tmpdir()) && basename(root).startsWith('euler-t01-')), 'not-disposable-root');
  check(realpathSync(root) === root, 'unsafe-root-alias');
  const sandbox = JSON.parse(readFileSync(join(root, 'sandbox.json'), 'utf8')) as Omit<Sandbox, 'fixture'>;
  check(sandbox.schema === 'euler-disposable@1' && sandbox.appId === (standard ? basename(root) : 'euler') && sandbox.root === root, 'invalid-sandbox');
  check(sandbox.fixtureDigest === fixtureDigest, 'fixture-mismatch');
  sameFile(root, sandbox.rootIdentity);
  sameFile(join(root, standard ? 'store.sqlite3' : 'probe.sqlite'), sandbox.storeIdentity);
  sameFile(join(root, 'session.jsonl'), sandbox.archiveIdentity);
  return { ...sandbox, fixture };
}
