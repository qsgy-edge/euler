// Deterministic synthetic file fault; independent of uid/ACL/chmod semantics.
import fs from 'node:fs';
import { resolve } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const target = process.env.T12_WRITE_FAULT_FILE;
const flag = process.env.T12_WRITE_FAULT_FLAG;
const mode = process.env.T12_WRITE_FAULT_MODE;
if (target && flag) {
  const open = fs.openSync, write = fs.writeSync, close = fs.closeSync;
  const handles = new Set();
  let shortWritten = false;
  fs.openSync = (path, flags, ...args) => {
    const selected = resolve(String(path)) === resolve(target);
    if (selected && flags === 'a' && fs.existsSync(flag) && mode === 'open') throw new Error('injected-info-open-failed');
    const fd = open(path, flags, ...args);
    if (selected) handles.add(fd);
    return fd;
  };
  fs.writeSync = (fd, buffer, offset, length, ...args) => {
    if (handles.has(fd) && fs.existsSync(flag) && mode === 'partial') {
      if (shortWritten) throw new Error('injected-info-partial-write');
      shortWritten = true;
      return write(fd, buffer, offset, Math.min(length, 17), ...args);
    }
    return write(fd, buffer, offset, length, ...args);
  };
  fs.closeSync = fd => { handles.delete(fd); return close(fd); };
  syncBuiltinESMExports();
}
