import { copyFileSync, renameSync } from 'node:fs';
import { CliArchive } from '../../src/archive.ts';

const target = process.env.T12_REPLACE_SOURCE;
const append = CliArchive.prototype.append;
let replaced = false;
CliArchive.prototype.append = function(eventId, text, ...args) {
  if (target && !replaced && text === '记住偏好：包管理器使用 pnpm') {
    // Replace before the real append checks identity and opens the file.
    copyFileSync(target, `${target}.copy`);
    renameSync(`${target}.copy`, target);
    replaced = true;
  }
  return append.call(this, eventId, text, ...args);
};
