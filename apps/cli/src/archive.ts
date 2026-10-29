import { closeSync, fstatSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { check, inspectPurgeSource, sameBinding, sha256, uuid, sameFile } from '@euler/core';
import type { PurgeCarrierSelection, PurgeSourceAck, PurgeSourcePlan, SourceAck, SourceExcerpt } from '@euler/core';
import { bindingOf } from './sandbox.ts';
import type { Sandbox } from './sandbox.ts';

type Gate = <T>(action: () => T) => T;
interface RawEvent { schema: 'cli-input@1'; eventId: string; role: 'user' | 'assistant' | 'tool'; text: string }

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

// The CLI owns this carrier. Core sees acknowledgements and bounded source operations.
export class CliArchive {
  readonly #sandbox: Sandbox;
  readonly #gate: Gate;
  readonly #path: string;
  constructor(sandbox: Sandbox, gate: Gate) {
    this.#sandbox = sandbox;
    this.#gate = gate;
    this.#path = join(sandbox.root, sandbox.sourceName ?? 'session.jsonl');
  }

  #scan(): { event: RawEvent; ack: SourceAck }[] {
    sameFile(this.#sandbox.root, this.#sandbox.rootIdentity);
    sameFile(this.#path, this.#sandbox.archiveIdentity);
    const fd = openSync(this.#path, 'r');
    let bytes: Buffer;
    try {
      check(fstatSync(fd).size <= 1_048_576, 'archive-limit');
      bytes = readFileSync(fd);
    } finally { closeSync(fd); }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    check(text.endsWith('\n'), 'archive-integrity: incomplete line');
    const lines = text.slice(0, -1).split('\n');
    const header = JSON.parse(lines.shift()!);
    check(header.schema === 'cli-session@1' && sameBinding(header.binding, bindingOf(this.#sandbox)), 'archive-binding-mismatch');
    const seen = new Set<string>();
    return lines.filter(line => !/^ +$/.test(line)).map(line => {
      const event = JSON.parse(line) as RawEvent;
      uuid(event.eventId);
      check(event.schema === 'cli-input@1' && ['user', 'assistant', 'tool'].includes(event.role) && typeof event.text === 'string'
        && event.text.length > 0 && Buffer.byteLength(event.text) <= 65536, 'archive-integrity');
      check(line === JSON.stringify({ schema: event.schema, eventId: event.eventId, role: event.role, text: event.text }),
        'archive-integrity: event bytes conflict');
      check(!seen.has(event.eventId), 'archive-integrity: duplicate identity');
      seen.add(event.eventId);
      return { event, ack: {
        schema: 'cli-source-ack@1', status: 'durable', binding: bindingOf(this.#sandbox),
        eventId: event.eventId, locator: `cli-jsonl@1/${this.#sandbox.fixture.sessionId}/${event.eventId}`,
        hash: sha256(line), byteLength: Buffer.byteLength(line), contentHash: sha256(event.text),
      } };
    });
  }

  append(eventId: string, text: string, role: RawEvent['role'] = 'user'): SourceAck {
    uuid(eventId);
    check(['user', 'assistant', 'tool'].includes(role), 'invalid-source-role');
    check(typeof text === 'string' && text.length > 0 && Buffer.byteLength(text) <= 65536, 'invalid-input');
    return this.#gate(() => {
      const events = this.#scan();
      const previous = events.find(item => item.event.eventId === eventId);
      const line = JSON.stringify({ schema: 'cli-input@1', eventId, role, text }) + '\n';
      if (previous) {
        check(previous.event.text === text && previous.event.role === role, 'identity-conflict');
      } else appendDurably(this.#path, line, 1_048_576, 'archive');
      // Also sync a prior append whose acknowledgement may have been lost.
      const fd = openSync(this.#path, 'r+');
      try { fsyncSync(fd); } finally { closeSync(fd); }
      const recovered = this.#scan().find(item => item.event.eventId === eventId);
      check(recovered?.event.text === text, 'archive-ack-failed');
      return recovered.ack;
    });
  }

  lookup(eventId: string): SourceAck | null {
    uuid(eventId);
    return this.#gate(() => {
      const found = this.#scan().find(item => item.event.eventId === eventId);
      if (!found) return null;
      const fd = openSync(this.#path, 'r+');
      try { fsyncSync(fd); } finally { closeSync(fd); }
      return this.#scan().find(item => item.event.eventId === eventId)!.ack;
    });
  }

  read(ref: SourceAck): { text: string; role: RawEvent['role'] } {
    return this.#gate(() => {
      check(sameBinding(ref.binding, bindingOf(this.#sandbox)), 'source-scope-mismatch');
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

  preparePurge(selection: PurgeCarrierSelection): PurgeSourcePlan {
    return this.#gate(() => {
      this.#scan();
      check(selection.file.path === this.#path && selection.role === 'source', 'purge-source-owner-mismatch');
      sameFile(this.#path, selection.file.identity);
      const bytes = readFileSync(this.#path);
      check(bytes.length === selection.bytes && sha256(bytes) === selection.hash, 'purge-source-carrier-changed');
      const ranges: PurgeSourcePlan['ranges'] = [];
      let offset = bytes.indexOf(10) + 1;
      while (offset < bytes.length) {
        const end = bytes.indexOf(10, offset), line = bytes.subarray(offset, end);
        const selected = selection.entries[ranges.length];
        if (selected && sha256(line) === selected.hash) {
          check(JSON.parse(line.toString('utf8')).eventId === selected.id, 'purge-source-entry-changed');
          ranges.push({ offset, bytes: line.length }); bytes.fill(32, offset, end);
        }
        offset = end + 1;
      }
      check(ranges.length === selection.entries.length, 'purge-source-evidence-gap');
      return { ranges, afterHash: sha256(bytes) };
    });
  }

  /** Erase approved line bytes in place; file identity and unrelated acknowledgements stay stable. */
  purge(selection: PurgeCarrierSelection, plan: PurgeSourcePlan): PurgeSourceAck {
    return this.#gate(() => {
      check(selection.file.path === this.#path && selection.role === 'source', 'purge-source-owner-mismatch');
      sameFile(this.#sandbox.root, this.#sandbox.rootIdentity);
      sameFile(this.#path, this.#sandbox.archiveIdentity); sameFile(this.#path, selection.file.identity);
      const fd = openSync(this.#path, 'r+');
      try {
        const identity = fstatSync(fd, { bigint: true });
        check(String(identity.dev) === selection.file.identity.dev && String(identity.ino) === selection.file.identity.ino
          && identity.nlink === 1n && identity.isFile(), 'file-identity-changed');
        const bytes = readFileSync(fd), erased = inspectPurgeSource(selection, plan, bytes);
        for (const range of plan.ranges) {
          sameFile(this.#path, selection.file.identity);
          let offset = range.offset;
          const end = offset + range.bytes;
          while (offset < end) {
            const written = writeSync(fd, erased, offset, end - offset, offset);
            check(written > 0, 'purge-source-write-failed'); offset += written;
          }
        }
        fsyncSync(fd);
        sameFile(this.#path, selection.file.identity);
        const actual = readFileSync(this.#path);
        check(actual.length === selection.bytes && sha256(actual) === plan.afterHash, 'purge-source-postcondition-failed');
        this.#scan();
        return { hash: plan.afterHash, bytes: actual.length };
      } finally { closeSync(fd); }
    });
  }

  /** Durable events in archive order, for Host backfill and referent resolution. */
  events(): { role: RawEvent['role']; text: string; ack: SourceAck }[] {
    return this.#gate(() => this.#scan().map(({ event, ack }) => ({ role: event.role, text: event.text, ack })));
  }
}
