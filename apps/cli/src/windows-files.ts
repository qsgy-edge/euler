import koffi from 'koffi';
import { join } from 'node:path';
import { check } from '@euler/core';
import type { BoundFile, FileIdentity, FileTarget, FileReceipt, FileFailureReason } from '@euler/core';

// Native calls live only in the Host. No model-controlled library, symbol or command.
const SYNCHRONIZE = 0x100000, READ_CONTROL = 0x20000, FILE_READ_ATTRIBUTES = 0x80, FILE_TRAVERSE = 0x20;
const FILE_READ_DATA = 1, FILE_WRITE_DATA = 2, FILE_SHARE_READ = 1;
const FILE_OPEN = 1, FILE_CREATE = 2, OPEN_EXISTING = 3;
const FILE_SYNCHRONOUS_IO_NONALERT = 0x20, FILE_OPEN_REPARSE_POINT = 0x200000;
const FILE_DIRECTORY_FILE = 1, FILE_NON_DIRECTORY_FILE = 0x40, OBJ_CASE_INSENSITIVE = 0x40;
const FILE_ATTRIBUTE_NORMAL = 0x80, FILE_ATTRIBUTE_DIRECTORY = 0x10, FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000, FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
function loadApi() {
  check(process.platform === 'win32', 'file-platform-unavailable');
  const kernel = koffi.load('kernel32.dll');
  const nt = koffi.load('ntdll.dll');
  const security = koffi.load('advapi32.dll');
  const mapping = koffi.struct({ GenericRead: 'uint32', GenericWrite: 'uint32', GenericExecute: 'uint32', GenericAll: 'uint32' });
  const unicode = koffi.struct({ Length: 'uint16', MaximumLength: 'uint16', Buffer: 'str16' });
  const attributes = koffi.struct({ Length: 'uint32', RootDirectory: 'void *', ObjectName: koffi.pointer(unicode),
    Attributes: 'uint32', SecurityDescriptor: 'void *', SecurityQualityOfService: 'void *' });
  const io = koffi.struct({ Status: 'uintptr_t', Information: 'uintptr_t' });
  const info = koffi.struct({ attributes: 'uint32', creationLow: 'uint32', creationHigh: 'uint32',
    accessLow: 'uint32', accessHigh: 'uint32', writeLow: 'uint32', writeHigh: 'uint32',
    volume: 'uint32', sizeHigh: 'uint32', sizeLow: 'uint32', links: 'uint32', indexHigh: 'uint32', indexLow: 'uint32' });
  return {
    attributeSize: koffi.sizeof(attributes),
    currentProcess: kernel.func('void * __stdcall GetCurrentProcess()'),
    openToken: security.func('int __stdcall OpenProcessToken(void *process, uint32 access, _Out_ void **token)'),
    duplicateToken: security.func('int __stdcall DuplicateToken(void *token, int level, _Out_ void **duplicate)'),
    securityInfo: security.func('uint32 __stdcall GetSecurityInfo(void *handle, int type, uint32 flags, void *owner, void *group, void *dacl, void *sacl, _Out_ void **descriptor)'),
    accessCheck: security.func('__stdcall', 'AccessCheck', 'int', ['void *', 'void *', 'uint32', koffi.pointer(mapping), 'void *', koffi.inout('uint32 *'), koffi.out('uint32 *'), koffi.out('int *')]),
    free: kernel.func('void * __stdcall LocalFree(void *memory)'),
    openRoot: kernel.func('void * __stdcall CreateFileW(str16 path, uint32 access, uint32 share, void *security, uint32 disposition, uint32 flags, void *templateFile)'),
    openAt: nt.func('__stdcall', 'NtCreateFile', 'int32', [koffi.out('void **'), 'uint32', koffi.pointer(attributes), koffi.out(koffi.pointer(io)),
      'void *', 'uint32', 'uint32', 'uint32', 'uint32', 'void *', 'uint32']),
    volume: kernel.func('int __stdcall GetVolumeInformationByHandleW(void *handle, void *name, uint32 nameSize, void *serial, void *maxComponent, void *flags, void *filesystem, uint32 filesystemSize)'),
    finalPath: kernel.func('uint32 __stdcall GetFinalPathNameByHandleW(void *handle, void *buffer, uint32 count, uint32 flags)'),
    info: kernel.func('__stdcall', 'GetFileInformationByHandle', 'int', ['void *', koffi.out(koffi.pointer(info))]),
    read: kernel.func('int __stdcall ReadFile(void *handle, void *buffer, uint32 count, _Out_ uint32 *done, void *overlapped)'),
    write: kernel.func('int __stdcall WriteFile(void *handle, const void *buffer, uint32 count, _Out_ uint32 *done, void *overlapped)'),
    seek: kernel.func('int __stdcall SetFilePointerEx(void *handle, int64 distance, void *position, uint32 method)'),
    truncate: kernel.func('int __stdcall SetEndOfFile(void *handle)'),
    flush: kernel.func('int __stdcall FlushFileBuffers(void *handle)'),
    close: kernel.func('int __stdcall CloseHandle(void *handle)'),
  };
}
let api: ReturnType<typeof loadApi> | undefined;
function native() { return api ??= loadApi(); }
interface HandleInfo { attributes: number; volume: number; indexHigh: number; indexLow: number; links: number; sizeHigh: number; sizeLow: number }
function inspect(handle: bigint, directory: boolean): { identity: FileIdentity; size: number } {
  const value = {} as HandleInfo;
  check(native().info(handle, value), 'file-identity-unavailable');
  check(!(value.attributes & FILE_ATTRIBUTE_REPARSE_POINT) && Boolean(value.attributes & FILE_ATTRIBUTE_DIRECTORY) === directory, 'file-reparse-or-type-denied');
  check(directory || value.links === 1, 'file-hardlink-denied');
  return { identity: { dev: String(value.volume), ino: String((BigInt(value.indexHigh) << 32n) | BigInt(value.indexLow)) },
    size: value.sizeHigh * 4294967296 + value.sizeLow };
}
function openAt(parent: bigint, name: string, directory: boolean, write: boolean, create = false): bigint | null {
  check(name.length > 0 && !/[\\/:\0]/.test(name) && name !== '.' && name !== '..', 'file-invalid-component');
  const a = native();
  const handle: (bigint | null)[] = [null];
  const status = a.openAt(handle, SYNCHRONIZE | FILE_READ_ATTRIBUTES | (directory ? FILE_TRAVERSE | READ_CONTROL : write ? FILE_WRITE_DATA : FILE_READ_DATA),
    { Length: a.attributeSize, RootDirectory: parent, ObjectName: { Length: name.length * 2, MaximumLength: name.length * 2, Buffer: name },
      Attributes: OBJ_CASE_INSENSITIVE, SecurityDescriptor: null, SecurityQualityOfService: null }, {}, null, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ,
    create ? FILE_CREATE : FILE_OPEN, FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT
      | (directory ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE), null, 0);
  if ((status >>> 0) === 0xc0000034 && !create) return null;
  // Even a denied create can have effects: filesystem filters may cancel an
  // already completed create before returning a handle (FltCancelFileOpen).
  // No failed FILE_CREATE status is promoted to a no-effect result here.
  check(status >= 0 && handle[0], `file-open-denied:${(status >>> 0).toString(16)}`);
  return handle[0];
}
export class FileOperationRejected extends Error {
  readonly reason: FileFailureReason;
  constructor(reason: FileFailureReason) { super(reason); this.reason = reason; }
}
function checkCreatePermission(parent: bigint): void {
  const a = native();
  const descriptor: (bigint | null)[] = [null], token: (bigint | null)[] = [null], impersonation: (bigint | null)[] = [null];
  try {
    const reject = () => { throw new FileOperationRejected('file-create-denied'); };
    // Query the pinned directory, then evaluate FILE_ADD_FILE with the Host's
    // token. A negative result is reliable because FILE_CREATE is not called.
    if (a.securityInfo(parent, 1, 7, null, null, null, null, descriptor) !== 0 || !descriptor[0]) reject();
    if (!a.openToken(a.currentProcess(), 0x0a, token) || !a.duplicateToken(token[0], 2, impersonation)) reject();
    const allowed = [0], granted = [0], privileges = Buffer.alloc(1024), length = [privileges.length];
    if (!a.accessCheck(descriptor[0], impersonation[0], FILE_WRITE_DATA,
      { GenericRead: 0x120089, GenericWrite: 0x120116, GenericExecute: 0x1200a0, GenericAll: 0x1f01ff },
      privileges, length, granted, allowed) || !allowed[0]) reject();
  } finally {
    if (impersonation[0]) a.close(impersonation[0]);
    if (token[0]) a.close(token[0]);
    if (descriptor[0]) a.free(descriptor[0]);
  }
}
export interface OpenedFile {
  target: FileTarget;
  execute(content: string | undefined, signal: AbortSignal): Promise<FileReceipt>;
  close(): void;
}
export class WindowsFileRoot {
  readonly #root: BoundFile;
  #handle: bigint | null;
  constructor(root: BoundFile) {
    const a = native();
    check(/^[A-Za-z]:\\/.test(root.path) && !root.path.startsWith('\\\\'), 'file-local-root-required');
    this.#root = structuredClone(root);
    const handle = a.openRoot(root.path, SYNCHRONIZE | READ_CONTROL | FILE_READ_ATTRIBUTES | FILE_TRAVERSE, FILE_SHARE_READ, null, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, null) as bigint;
    check(handle && handle !== 0xffffffffffffffffn && handle !== -1n, 'file-root-unavailable');
    this.#handle = handle;
    try {
      const filesystem = Buffer.alloc(64);
      check(a.volume(handle, null, 0, null, null, null, filesystem, 32)
        && filesystem.toString('utf16le').replace(/\0.*$/s, '') === 'NTFS', 'file-filesystem-unavailable');
      const buffer = Buffer.alloc(8192);
      const length = a.finalPath(handle, buffer, 4096, 0) as number;
      check(length > 0 && length < 4096 && buffer.toString('utf16le', 0, length * 2).slice(4).toLowerCase() === root.path.toLowerCase(), 'file-root-alias-denied');
      check(JSON.stringify(inspect(handle, true).identity) === JSON.stringify(root.identity), 'file-root-identity-changed');
    }
    catch (error) { this.close(); throw error; }
  }
  prepare(parts: string[], operation: 'file.read' | 'file.write'): OpenedFile {
    check(this.#handle && parts.length > 0 && parts.length <= 32, 'file-root-closed');
    const handles: bigint[] = [];
    let parent = this.#handle;
    let target: bigint | null = null;
    let busy = false, closed = false, used = false;
    const close = () => {
      if (closed) return;
      check(!busy, 'file-operation-in-flight');
      closed = true;
      if (target) native().close(target);
      for (const handle of handles.reverse()) native().close(handle);
    };
    try {
      for (const part of parts.slice(0, -1)) {
        const directory = openAt(parent, part, true, false);
        check(directory, 'file-parent-missing');
        handles.push(directory); inspect(directory, true); parent = directory;
      }
      target = openAt(parent, parts.at(-1)!, false, operation === 'file.write');
      check(target || operation === 'file.write', 'file-target-missing');
      const identity = target ? inspect(target, false).identity : null;
      const description = { path: join(this.#root.path, ...parts), parent: { path: join(this.#root.path, ...parts.slice(0, -1)), identity: inspect(parent, true).identity }, identity };
      return {
        target: structuredClone(description), close,
        execute: async (content, signal) => {
          check(!closed && !used && !signal.aborted, 'file-operation-not-admissible');
          used = true;
          if (operation === 'file.write') check(typeof content === 'string' && Buffer.byteLength(content) <= 4096, 'invalid-file-content');
          if (!target) {
            // These probes cannot create or write the target. A failed probe
            // safely rejects this call; FILE_CREATE stays outside that catch.
            try {
              checkCreatePermission(parent);
              const existing = openAt(parent, parts.at(-1)!, false, false);
              if (existing) { native().close(existing); throw new FileOperationRejected('file-create-conflict'); }
            } catch (error) {
              if (error instanceof FileOperationRejected) throw error;
              throw new FileOperationRejected('file-create-denied');
            }
            target = openAt(parent, parts.at(-1)!, false, true, true);
          }
          check(target, 'file-create-failed');
          const opened = inspect(target, false);
          if (identity) check(JSON.stringify(opened.identity) === JSON.stringify(identity), 'file-identity-changed');
          check(native().seek(target, 0, null, 0), 'file-seek-failed');
          busy = true;
          try {
            const buffer = operation === 'file.read' ? Buffer.alloc(4097) : Buffer.from(content!, 'utf8');
            if (operation === 'file.read' && opened.size > 4096) throw new FileOperationRejected('file-output-too-large');
            const done = [0];
            const fn = operation === 'file.read' ? native().read : native().write;
            await new Promise<void>((resolve, reject) => fn.async(target, buffer, buffer.length, done, null,
              (error: unknown, ok: number) => error || !ok ? reject(new Error('file-io-incomplete')) : resolve()));
            if (operation === 'file.write') {
              check(done[0] === buffer.length && native().truncate(target) && native().flush(target), 'file-write-incomplete');
            }
            if (done[0]! > 4096) throw new FileOperationRejected('file-output-too-large');
            const after = inspect(target, false);
            check(JSON.stringify(after.identity) === JSON.stringify(opened.identity), 'file-identity-changed');
            let text: string | undefined;
            if (operation === 'file.read') {
              try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, done[0])); }
              catch { throw new FileOperationRejected('file-invalid-utf8'); }
            }
            return { identity: after.identity, ...(text === undefined ? {} : { text }), byteLength: done[0]! };
          } finally { busy = false; }
        },
      };
    } catch (error) { close(); throw error; }
  }
  close(): void { if (this.#handle) { native().close(this.#handle); this.#handle = null; } }
}
