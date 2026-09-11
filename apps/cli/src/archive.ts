import { closeSync, fstatSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { check, sameBinding, sha256, uuid, sameFile } from '@euler/core';
import type { SourceAck, SourceExcerpt } from '@euler/core';
import { bindingOf } from './sandbox.ts';
import type { Sandbox } from './sandbox.ts';

type Gate = <T>(action: () => T) => T;
interface RawEvent { schema: 'cli-input@1'; eventId: string; role: 'user'; text: string }

// The CLI owns this carrier. Core sees acknowledgements and bounded source operations.
export class CliArchive {
  readonly #sandbox: Sandbox;
  readonly #gate: Gate;
  readonly #path: string;
  constructor(sandbox: Sandbox, gate: Gate) {
    this.#sandbox = sandbox;
    this.#gate = gate;
    this.#path = join(sandbox.root, 'session.jsonl');
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
    return lines.map(line => {
      const event = JSON.parse(line) as RawEvent;
      uuid(event.eventId);
      check(event.schema === 'cli-input@1' && event.role === 'user' && typeof event.text === 'string'
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

  append(eventId: string, text: string): SourceAck {
    uuid(eventId);
    check(typeof text === 'string' && text.length > 0 && Buffer.byteLength(text) <= 65536, 'invalid-input');
    return this.#gate(() => {
      const events = this.#scan();
      const previous = events.find(item => item.event.eventId === eventId);
      const line = JSON.stringify({ schema: 'cli-input@1', eventId, role: 'user', text }) + '\n';
      if (previous) {
        check(previous.event.text === text, 'identity-conflict');
      } else {
        const fd = openSync(this.#path, 'a');
        try {
          check(fstatSync(fd).size + Buffer.byteLength(line) <= 1_048_576, 'archive-limit');
          const bytes = Buffer.from(line);
          let offset = 0;
          while (offset < bytes.length) {
            const written = writeSync(fd, bytes, offset, bytes.length - offset);
            check(written > 0, 'archive-write-failed');
            offset += written;
          }
          fsyncSync(fd);
        } finally { closeSync(fd); }
      }
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

  read(ref: SourceAck): { text: string } {
    return this.#gate(() => {
      check(sameBinding(ref.binding, bindingOf(this.#sandbox)), 'source-scope-mismatch');
      const result = this.#scan().find(item => item.event.eventId === ref.eventId);
      check(result && JSON.stringify(result.ack) === JSON.stringify(ref), 'source-evidence-gap');
      return { text: result.event.text };
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
}
