import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileIdentity } from '@euler/core';
import { WindowsFileRoot } from '../src/windows-files.ts';

const windows = { skip: process.platform !== 'win32' };
test('Windows file operations use the approved handle and prevent replacement until it closes', windows, async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'euler-t08-handles-')));
  const path = join(root, 'approved.txt');
  writeFileSync(path, 'ORIGINAL');
  const files = new WindowsFileRoot({ path: root, identity: fileIdentity(root) });
  try {
    const prepared = files.prepare(['approved.txt'], 'file.write');
    try {
      assert.deepEqual(prepared.target.identity, fileIdentity(path));
      assert.throws(() => renameSync(path, path + '.replaced'), /EPERM|EACCES|EBUSY/);
      await prepared.execute('APPROVED', new AbortController().signal);
      assert.equal(readFileSync(path, 'utf8'), 'APPROVED');
    } finally { prepared.close(); }
    files.close();
    renameSync(path, path + '.replaced');
    assert.equal(readFileSync(path + '.replaced', 'utf8'), 'APPROVED');
  } finally { files.close(); rmSync(root, { recursive: true, force: true }); }
});
