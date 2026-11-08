import { mkdir, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { ObserveEvent } from "../core/events.js";
import type { Document } from "../document/document.js";
import type { Journal, JournalEntry } from "../document/journal.js";
import type { LogTables } from "./states.js";

/**
 * The `deltas.bin` writer (docs/design/12-observability.md, *Block deltas*).
 *
 * A bus annotator. For each `doc.op`, `doc.undo` and `doc.redo` it finds the journal entry the
 * event names, reserves `16 × changed` bytes at the end of the folder's `deltas.bin` and adds
 * `delta: { offset, length }` to the event. The only work on the call path is that reservation and
 * one pass mapping the entry's palette ids to log-wide ids (publishing `state.add` for new ones).
 * Encoding and writing happen on a timer, from the entry's own arrays (journal entries are never
 * changed after commit).
 *
 * Records are `(x, y, z, stateId)`: int32 coordinates in the emitting document's local frame
 * after the step (the base document's frame for base ops and merges, the sandbox's own frame for
 * sandbox ops), then a uint32 id from the `state.add` table, little-endian. An op logs the
 * after-state, an undo the before-state.
 *
 * Past `maxBytes` for the session, events carry no `delta` from then on; replay falls back to the
 * time-lapse snapshots.
 */

export const RECORD_BYTES = 16;

export interface DeltaWriterOptions {
  tables: LogTables;
  dirFor: (name: string) => string;
  /** The document behind an event's `doc` tag ("base" or a scope id). */
  docFor: (doc: string) => Document | undefined;
  maxBytes: number;
  flushMs?: number;
  log?: (msg: string) => void;
}

interface Job {
  name: string;
  offset: number;
  positions: Int32Array;
  values: Uint16Array;
  origin: readonly number[];
  map: Int32Array;
}

interface DeltaFile {
  size: number;
  handle?: Promise<FileHandle | undefined>;
}

export class DeltaWriter {
  /** Bytes reserved this session, across folders. */
  bytes = 0;
  capped = false;
  private jobs: Job[] = [];
  private readonly files = new Map<string, DeltaFile>();
  private timer?: NodeJS.Timeout;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly opts: DeltaWriterOptions) {}

  path(name: string): string {
    return join(this.opts.dirFor(name), "deltas.bin");
  }

  /** Bytes reserved so far in a folder's `deltas.bin`. */
  size(name: string): number {
    return this.files.get(name)?.size ?? 0;
  }

  readonly annotate = (doc: string, e: ObserveEvent): { delta: { offset: number; length: number } } | undefined => {
    if (e.kind !== "doc.op" && e.kind !== "doc.undo" && e.kind !== "doc.redo") return undefined;
    const name = this.opts.tables.current;
    const table = this.opts.tables.table();
    const d = this.opts.docFor(doc);
    if (name === undefined || !table || !d || this.capped) return undefined;
    const entry = findEntry(d.journal, e.jseq);
    if (!entry || entry.after.length === 0) return undefined;
    const undo = e.kind === "doc.undo";
    const values = undo ? entry.before : entry.after;
    const length = values.length * RECORD_BYTES;
    if (this.bytes + length > this.opts.maxBytes) {
      this.capped = true;
      this.opts.log?.(`observe: deltas.bin reached observe.maxDeltaBytes (${this.opts.maxBytes} bytes); later ops are logged without deltas`);
      return undefined;
    }
    const map = new Int32Array(d.states.size).fill(-1);
    for (let i = 0; i < values.length; i++) {
      const v = values[i]!;
      if (map[v]! < 0) map[v] = table.id(d.states.get(v));
    }
    let f = this.files.get(name);
    if (!f) this.files.set(name, (f = { size: 0 }));
    const offset = f.size;
    f.size += length;
    this.bytes += length;
    this.jobs.push({ name, offset, positions: entry.positions, values, origin: [...(undo ? entry.originBefore : entry.originAfter)], map });
    if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.opts.flushMs ?? 50);
      this.timer.unref?.();
    }
    return { delta: { offset, length } };
  };

  /** Encodes and writes every reserved range so far. Resolves when they are on disk. */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const jobs = this.jobs;
    this.jobs = [];
    for (const job of jobs) {
      const buf = encodeJob(job);
      const handle = this.handle(job.name);
      this.writing = this.writing
        .then(async () => {
          const h = await handle;
          if (h) await h.write(buf, 0, buf.length, job.offset);
        })
        .catch((e: Error) => this.opts.log?.(`observe: writing ${this.path(job.name)} failed: ${e.message}`));
    }
    return this.writing;
  }

  /** Reads a written range (waiting for pending writes first). Clamped to what was reserved. */
  async read(name: string, offset: number, length: number): Promise<Buffer> {
    await this.flush();
    const f = this.files.get(name);
    const end = Math.min(offset + length, f?.size ?? 0);
    if (!f || end <= offset) return Buffer.alloc(0);
    const h = await this.handle(name);
    if (!h) return Buffer.alloc(0);
    const buf = Buffer.alloc(end - offset);
    const { bytesRead } = await h.read(buf, 0, buf.length, offset);
    return buf.subarray(0, bytesRead);
  }

  async close(): Promise<void> {
    await this.flush();
    for (const f of this.files.values()) await (await f.handle)?.close();
    this.files.clear();
  }

  private handle(name: string): Promise<FileHandle | undefined> {
    let f = this.files.get(name);
    if (!f) this.files.set(name, (f = { size: 0 }));
    if (!f.handle) {
      const path = this.path(name);
      f.handle = mkdir(this.opts.dirFor(name), { recursive: true })
        .then(() => open(path, "w+"))
        .catch((e: Error) => {
          this.opts.log?.(`observe: opening ${path} failed: ${e.message}`);
          return undefined;
        });
    }
    return f.handle;
  }
}

/** The entry with journal sequence number `jseq`, searched from the newest. */
export function findEntry(j: Journal, jseq: number): JournalEntry | undefined {
  for (let i = j.entries.length - 1; i >= 0; i--) if (j.entries[i]!.seq === jseq) return j.entries[i];
  return undefined;
}

function encodeJob(job: Job): Buffer {
  const n = job.values.length;
  const buf = Buffer.alloc(n * RECORD_BYTES);
  const [ox, oy, oz] = job.origin as [number, number, number];
  for (let i = 0, o = 0; i < n; i++, o += RECORD_BYTES) {
    buf.writeInt32LE(job.positions[i * 3]! - ox, o);
    buf.writeInt32LE(job.positions[i * 3 + 1]! - oy, o + 4);
    buf.writeInt32LE(job.positions[i * 3 + 2]! - oz, o + 8);
    buf.writeUInt32LE(job.map[job.values[i]!]!, o + 12);
  }
  return buf;
}

/** Decodes delta records (for tests and replay). */
export function decodeRecords(buf: Uint8Array): [number, number, number, number][] {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: [number, number, number, number][] = [];
  for (let o = 0; o + RECORD_BYTES <= buf.byteLength; o += RECORD_BYTES)
    out.push([v.getInt32(o, true), v.getInt32(o + 4, true), v.getInt32(o + 8, true), v.getUint32(o + 12, true)]);
  return out;
}
