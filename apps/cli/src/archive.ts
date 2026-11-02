import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { check, inspectPurgeLines, sameBinding, sha256, uuid, sameFile } from '@euler/core';
import type { PurgeCarrierSelection, PurgeLineAck, PurgeLinePlan, SourceAck, SourceExcerpt, SourceAppend } from '@euler/core';
import { bindingOf } from './sandbox.ts';
import type { Sandbox } from './sandbox.ts';

type Gate = <T>(action: () => T) => T;
interface RawEvent { schema: 'cli-input@1'; eventId: string; role: 'user' | 'assistant' | 'tool'; text: string; projectId?: string | null }
export interface ArchiveJournal {
  prepare(input: () => SourceAppend | SourceAck): SourceAppend | SourceAck;
  pending(): SourceAppend[];
  acknowledged(eventId: string): SourceAck | null;
  settle(source: SourceAck): void;
}

/** Appends one line to a CLI-owned JSONL carrier under a size cap and fsyncs it before returning. */
export function appendDurably(path: string, line: string, maxBytes: number, carrier: string): void {
  const fd = openSync(path, 'a');
  try {
    check(fstatSync(fd).size + Buffer.byteLength(line) <= maxBytes, `${carrier}-limit`);
    const bytes = Buffer.from(line);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      check(written > 0, `${carrier}-write-failed`);
      offset += written;
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

/** Resolve an approved JSONL selection without changing any carrier bytes. */
export function preparePurgeLines(selection: PurgeCarrierSelection, identity: (entry: any, index: number) => string): PurgeLinePlan {
  sameFile(selection.file.path, selection.file.identity);
  const bytes = readFileSync(selection.file.path);
  check(bytes.length === selection.bytes && sha256(bytes) === selection.hash && bytes.at(-1) === 10, 'purge-source-carrier-changed');
  const ranges: PurgeLinePlan['ranges'] = [];
  let offset = bytes.indexOf(10) + 1, index = 0;
  while (offset < bytes.length) {
    const end = bytes.indexOf(10, offset), line = bytes.subarray(offset, end);
    const present = !line.every(byte => byte === 32), selected = selection.entries[ranges.length];
    if (selected && sha256(line) === selected.hash) {
      check(identity(JSON.parse(line.toString('utf8')), index) === selected.id, 'purge-source-entry-changed');
      ranges.push({ offset, bytes: line.length }); bytes.fill(32, offset, end);
    }
    if (present) index++;
    offset = end + 1;
  }
  check(ranges.length === selection.entries.length, 'purge-source-evidence-gap');
  return { ranges, afterHash: sha256(bytes) };
}

/** Flush approved line erasures through the bound handle and independently read them back. */
export function purgeLines(selection: PurgeCarrierSelection, plan: PurgeLinePlan): PurgeLineAck {
  const path = selection.file.path;
  sameFile(path, selection.file.identity);
  const fd = openSync(path, 'r+');
  try {
    const identity = fstatSync(fd, { bigint: true });
    check(String(identity.dev) === selection.file.identity.dev && String(identity.ino) === selection.file.identity.ino
      && identity.nlink === 1n && identity.isFile(), 'file-identity-changed');
    const erased = inspectPurgeLines(selection, plan, readFileSync(fd));
    for (const range of plan.ranges) {
      sameFile(path, selection.file.identity);
      let offset = range.offset;
      const end = offset + range.bytes;
      while (offset < end) {
        const written = writeSync(fd, erased, offset, end - offset, offset);
        check(written > 0, 'purge-source-write-failed'); offset += written;
      }
    }
    fsyncSync(fd);
    sameFile(path, selection.file.identity);
    const actual = readFileSync(path);
    check(actual.length === selection.bytes && sha256(actual) === plan.afterHash, 'purge-source-postcondition-failed');
    return { hash: plan.afterHash, bytes: actual.length };
  } finally { closeSync(fd); }
}

// The CLI owns this carrier. Core sees acknowledgements and bounded source operations.

export class CliArchive {
  readonly #sandbox: Sandbox;
  readonly #gate: Gate;
  readonly #path: string;
  readonly #journal: ArchiveJournal | undefined;
  constructor(sandbox: Sandbox, gate: Gate, journal?: ArchiveJournal) {
    this.#journal = journal;
    this.#sandbox = sandbox;
    this.#gate = gate;
    this.#path = join(sandbox.root, sandbox.sourceName ?? 'session.jsonl');
  }

  #open(flags: string | number): number {
    sameFile(this.#sandbox.root, this.#sandbox.rootIdentity);
    sameFile(this.#path, this.#sandbox.archiveIdentity);
    const fd = openSync(this.#path, flags);
    try {
      const stat = fstatSync(fd, { bigint: true }), identity = this.#sandbox.archiveIdentity;
      check(stat.isFile() && stat.nlink === 1n && String(stat.dev) === identity.dev && String(stat.ino) === identity.ino, 'file-identity-changed');
      return fd;
    } catch (error) { closeSync(fd); throw error; }
  }

  #bytes(): Buffer {
    const fd = this.#open('r');
    let bytes: Buffer;
    try {
      check(fstatSync(fd).size <= 1_048_576, 'archive-limit');
      bytes = readFileSync(fd);
    } finally { closeSync(fd); }
    return bytes;
  }

  #scan(bytes = this.#bytes()): { event: RawEvent; ack: SourceAck }[] {
    check(bytes.at(-1) === 10, 'archive-integrity: incomplete line');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const lines = text.slice(0, -1).split('\n');
    const header = JSON.parse(lines.shift()!);
    const current = bindingOf(this.#sandbox);
    check(header.schema === 'cli-session@1' && sameBinding({ ...header.binding, projectId: current.projectId }, current)
      && (header.binding.projectId === null || header.binding.projectId === current.projectId), 'archive-binding-mismatch');
    const seen = new Set<string>();
    return lines.filter(line => !/^ +$/.test(line)).map(line => {
      const event = JSON.parse(line) as RawEvent;
      uuid(event.eventId);
      check(event.schema === 'cli-input@1' && ['user', 'assistant', 'tool'].includes(event.role) && typeof event.text === 'string'
        && event.text.length > 0 && Buffer.byteLength(event.text) <= 65536, 'archive-integrity');
      const projectId = event.projectId === undefined ? header.binding.projectId : event.projectId;
      if (projectId !== null) uuid(projectId);
      check(line === JSON.stringify({ schema: event.schema, eventId: event.eventId, role: event.role, text: event.text,
        ...(event.projectId === undefined ? {} : { projectId }) }),
        'archive-integrity: event bytes conflict');
      check(!seen.has(event.eventId), 'archive-integrity: duplicate identity');
      seen.add(event.eventId);
      return { event, ack: {
        schema: 'cli-source-ack@1', status: 'durable', binding: { ...current, projectId },
        eventId: event.eventId, locator: `cli-jsonl@1/${this.#sandbox.fixture.sessionId}/${event.eventId}`,
        hash: sha256(line), byteLength: Buffer.byteLength(line), contentHash: sha256(event.text),
      } };
    });
  }

  append(eventId: string, text: string | (() => string), role: RawEvent['role'] = 'user'): SourceAck {
    uuid(eventId);
    check(['user', 'assistant', 'tool'].includes(role), 'invalid-source-role');
    check(typeof text === 'function' || typeof text === 'string' && text.length > 0 && Buffer.byteLength(text) <= 65536, 'invalid-input');
    check(this.#journal, 'archive-journal-required');
    const prepared = this.#journal.prepare(() => {
      const pending = this.#journal!.pending()[0];
      if (pending) {
        check(pending.eventId === eventId, 'archive-append-pending');
        const event = JSON.parse(pending.bytes) as RawEvent;
        check(event.role === role && (typeof text === 'function' || event.text === text), 'identity-conflict');
        return pending;
      }
      const bytes = this.#bytes();
      const previous = this.#scan(bytes).find(item => item.event.eventId === eventId);
      const witness = this.#journal!.acknowledged(eventId);
      check(!witness || previous?.ack.hash === witness.hash, 'archive-integrity: acknowledged bytes changed');
      if (previous) {
        check(previous.event.role === role && (typeof text === 'function' || previous.event.text === text), 'identity-conflict');
        return previous.ack;
      }
      // Core's local result and budget mutation commit with this exact-byte reservation.
      const content = typeof text === 'function' ? text() : text;
      check(typeof content === 'string' && content.length > 0 && Buffer.byteLength(content) <= 65536, 'invalid-input');
      const line = JSON.stringify({ schema: 'cli-input@1', eventId, role, text: content,
        ...(this.#sandbox.sessionBinding ? { projectId: bindingOf(this.#sandbox).projectId } : {}) }) + '\n';
      check(bytes.length + Buffer.byteLength(line) <= 1_048_576, 'archive-limit');
      return { eventId, binding: bindingOf(this.#sandbox), bytes: line, offset: bytes.length, prefixHash: sha256(bytes) };
    });
    return 'schema' in prepared ? this.#gate(() => this.#syncedAck(eventId, prepared.hash)) : this.#complete(prepared);
  }

  #complete(pending: SourceAppend): SourceAck {
    return this.#gate(() => {
      check(this.#journal && sameBinding(pending.binding, bindingOf(this.#sandbox)), 'archive-binding-mismatch');
      const current = this.#journal.pending()[0];
      const lineHash = sha256(pending.bytes.slice(0, -1));
      if (!current) return this.#syncedAck(pending.eventId, lineHash);
      check(JSON.stringify(current) === JSON.stringify(pending), 'archive-append-pending');
      const bytes = this.#bytes(), expected = Buffer.from(pending.bytes);
      check(bytes.length >= pending.offset && sha256(bytes.subarray(0, pending.offset)) === pending.prefixHash,
        'archive-integrity: append prefix changed');
      const planned = this.#scan(Buffer.concat([bytes.subarray(0, pending.offset), expected])).at(-1);
      check(planned?.ack.eventId === pending.eventId && planned.ack.hash === lineHash
        && pending.offset + expected.length <= 1_048_576, 'archive-append-integrity');
      const tail = bytes.subarray(pending.offset);
      check(tail.length <= expected.length && tail.equals(expected.subarray(0, tail.length)), 'archive-integrity: append tail conflict');
      const fd = this.#open(constants.O_RDWR | constants.O_APPEND);
      try {
        check(fstatSync(fd).size === bytes.length, 'archive-integrity: append position changed');
        let offset = tail.length;
        while (offset < expected.length) {
          const written = writeSync(fd, expected, offset, expected.length - offset);
          check(written > 0, 'archive-write-failed'); offset += written;
        }
        fsyncSync(fd);
      } finally { closeSync(fd); }
      const ack = this.#verifiedAck(pending.eventId, lineHash);
      this.#journal.settle(ack);
      return ack;
    });
  }

  #verifiedAck(eventId: string, hash: string): SourceAck {
    const recovered = this.#scan().find(item => item.event.eventId === eventId);
    check(recovered?.ack.hash === hash, 'archive-ack-failed');
    return recovered.ack;
  }

  #syncedAck(eventId: string, hash: string): SourceAck {
    const fd = this.#open('r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    return this.#verifiedAck(eventId, hash);
  }

  /** Complete only durably reserved bytes; this never repeats a model or tool operation. */
  reconcile(): SourceAck[] {
    check(this.#journal, 'archive-journal-required');
    const acknowledgements = this.#journal.pending().map(pending => this.#complete(pending));
    this.#gate(() => this.#scan());
    return acknowledgements;
  }

  lookup(eventId: string): SourceAck | null {
    uuid(eventId);
    const pending = this.#journal?.pending().find(item => item.eventId === eventId);
    if (pending) return this.#complete(pending);
    return this.#gate(() => {
      const found = this.#scan().find(item => item.event.eventId === eventId);
      const witness = this.#journal?.acknowledged(eventId);
      check(!witness || found?.ack.hash === witness.hash, 'archive-integrity: acknowledged bytes changed');
      if (!found) return null;
      return this.#syncedAck(eventId, found.ack.hash);
    });
  }

  read(ref: SourceAck): { text: string; role: RawEvent['role'] } {
    return this.#gate(() => {
      check(sameBinding({ ...ref.binding, projectId: bindingOf(this.#sandbox).projectId }, bindingOf(this.#sandbox)), 'source-scope-mismatch');
      check(!this.#journal?.pending().some(item => item.eventId === ref.eventId), 'archive-append-pending');
      const result = this.#scan().find(item => item.event.eventId === ref.eventId);
      check(result && JSON.stringify(result.ack) === JSON.stringify(ref), 'source-evidence-gap');
      return { text: result.event.text, role: result.event.role };
    });
  }

  expand(ref: SourceAck, offset: number, limit: number): SourceExcerpt {
    check(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit > 0 && limit <= 4096, 'invalid-range');
    const points = Array.from(this.read(ref).text);
    check(offset <= points.length, 'invalid-range');
    const text = points.slice(offset, offset + limit).join('');
    const end = Math.min(offset + limit, points.length);
    return { ref, text, offset, end, total: points.length, truncated: offset > 0 || end < points.length, excerptHash: sha256(text) };
  }

  inspect(): { eventCount: number } {
    return this.#gate(() => ({ eventCount: this.#scan().length }));
  }

  preparePurge(selection: PurgeCarrierSelection): PurgeLinePlan {
    return this.#gate(() => {
      this.#scan();
      check(selection.file.path === this.#path && selection.role === 'source', 'purge-source-owner-mismatch');
      return preparePurgeLines(selection, entry => entry.eventId);
    });
  }

  /** Erase approved line bytes in place; file identity and unrelated acknowledgements stay stable. */
  purge(selection: PurgeCarrierSelection, plan: PurgeLinePlan): PurgeLineAck {
    return this.#gate(() => {
      check(selection.file.path === this.#path && selection.role === 'source', 'purge-source-owner-mismatch');
      sameFile(this.#sandbox.root, this.#sandbox.rootIdentity);
      sameFile(this.#path, this.#sandbox.archiveIdentity);
      const ack = purgeLines(selection, plan);
      this.#scan();
      return ack;
    });
  }

  /** Durable events in archive order, for Host backfill and referent resolution. */
  events(): { role: RawEvent['role']; text: string; ack: SourceAck }[] {
    return this.#gate(() => {
      check(!this.#journal?.pending().length, 'archive-append-pending');
      return this.#scan().map(({ event, ack }) => ({ role: event.role, text: event.text,
        ack: this.#journal?.acknowledged(event.eventId) ?? ack }));
    });
  }
}
