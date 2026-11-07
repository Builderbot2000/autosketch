import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import nbt, { type Compound, type NBT } from "prismarine-nbt";
import type { Box, Vec3 } from "../core/region.js";
import type { Component } from "./components.js";
import { entryBytes, type Checkpoint, type JournalEntry } from "./journal.js";
import type { StateTable } from "./voxels.js";

/**
 * On-disk journal segments (docs/design/04-document.md, Persistence): `<doc>/journal/` holds
 * immutable segment files, each a contiguous run of journal entries, plus `index.json` listing
 * them in history order with the checkpoints and the next sequence number. Segments name block
 * states by string (their own small table), so they survive the document's state table being
 * renumbered on save. I/O is synchronous: undo and redo are synchronous, and segments are small.
 */

export const JOURNAL_INDEX_VERSION = 1;
/** Small segments are merged with the next save's entries until they reach about this size. */
export const SEGMENT_BYTES = 4 * 1024 * 1024;

export interface SegmentRef {
  file: string;
  /** Sequence numbers of its entries, in history order. */
  seqs: number[];
  /** Estimated in-memory size (entryBytes). */
  bytes: number;
}

export interface JournalIndex {
  version: number;
  nextSeq: number;
  /** Entries trimmed from memory before the journal was persisted (unreachable). */
  lost: number;
  segments: SegmentRef[];
  checkpoints: Checkpoint[];
}

export class JournalStore {
  segments: SegmentRef[] = [];
  private readonly persisted = new Set<number>();

  private constructor(
    readonly dir: string,
    private readonly states: StateTable,
  ) {}

  /** A fresh, empty store in `dir`; whatever journal was there is deleted. */
  static create(dir: string, states: StateTable): JournalStore {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    return new JournalStore(dir, states);
  }

  /** Opens the store in `dir`, or undefined when there is no readable index. */
  static open(dir: string, states: StateTable): { store: JournalStore; index: JournalIndex } | undefined {
    let index: JournalIndex;
    try {
      index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as JournalIndex;
    } catch {
      return undefined;
    }
    if (index.version !== JOURNAL_INDEX_VERSION || !Array.isArray(index.segments)) return undefined;
    const store = new JournalStore(dir, states);
    store.segments = index.segments;
    for (const s of index.segments) for (const q of s.seqs) store.persisted.add(q);
    return { store, index };
  }

  has(seq: number): boolean {
    return this.persisted.has(seq);
  }

  /** Every persisted sequence number, in history order. */
  allSeqs(): number[] {
    return this.segments.flatMap((s) => s.seqs);
  }

  segmentOf(seq: number): SegmentRef | undefined {
    return this.segments.find((s) => s.seqs.includes(seq));
  }

  /** Appends entries (which follow every persisted one) as a segment, merging into a small last segment. */
  append(entries: JournalEntry[]): void {
    if (!entries.length) return;
    const bytes = entries.reduce((n, e) => n + entryBytes(e), 0);
    const last = this.segments[this.segments.length - 1];
    if (last && last.bytes + bytes <= SEGMENT_BYTES) {
      const merged = [...this.read(last), ...entries];
      this.segments.pop();
      this.remove(last);
      this.segments.push(this.write(merged));
    } else this.segments.push(this.write(entries));
    for (const e of entries) this.persisted.add(e.seq);
  }

  /** Forgets entries (a discarded redo tail): drops their segments, rewriting one that also holds kept entries. */
  discard(seqs: Iterable<number>): void {
    const gone = new Set([...seqs].filter((q) => this.persisted.has(q)));
    if (!gone.size) return;
    const next: SegmentRef[] = [];
    for (const s of this.segments) {
      if (!s.seqs.some((q) => gone.has(q))) {
        next.push(s);
        continue;
      }
      const kept = s.seqs.some((q) => !gone.has(q)) ? this.read(s).filter((e) => !gone.has(e.seq)) : [];
      this.remove(s);
      if (kept.length) next.push(this.write(kept));
    }
    this.segments = next;
    for (const q of gone) this.persisted.delete(q);
  }

  writeIndex(meta: { nextSeq: number; lost: number; checkpoints: Checkpoint[] }): void {
    const index: JournalIndex = { version: JOURNAL_INDEX_VERSION, ...meta, segments: this.segments };
    atomicWrite(join(this.dir, "index.json"), Buffer.from(JSON.stringify(index)));
    // Remove files no segment refers to (left by a crash between a write and the index).
    const live = new Set(this.segments.map((s) => s.file));
    for (const f of readdirSync(this.dir)) if (f.endsWith(".seg") && !live.has(f)) rmSync(join(this.dir, f), { force: true });
  }

  read(ref: SegmentRef): JournalEntry[] {
    const root = nbt.parseUncompressed(gunzipSync(readFileSync(join(this.dir, ref.file))));
    const v = root.value;
    const names = listOf<string>(v.States);
    const ids = names.map((n) => this.states.intern(n));
    return listOf<Compound["value"]>(v.Entries).map((c) => decodeEntry(c, ids));
  }

  private write(entries: JournalEntry[]): SegmentRef {
    const local = new Map<number, number>();
    const names: string[] = [];
    const idx = (id: number) => {
      let i = local.get(id);
      if (i === undefined) {
        i = names.length;
        names.push(this.states.get(id));
        local.set(id, i);
      }
      return i;
    };
    const root: NBT = {
      type: "compound",
      name: "",
      value: {
        Entries: { type: "list", value: { type: "compound", value: entries.map((e) => encodeEntry(e, idx)) } },
        States: { type: "list", value: { type: "string", value: names } },
      },
    };
    const file = `${entries[0]!.seq}-${entries[entries.length - 1]!.seq}.seg`;
    atomicWrite(join(this.dir, file), gzipSync(nbt.writeUncompressed(root)));
    return { file, seqs: entries.map((e) => e.seq), bytes: entries.reduce((n, e) => n + entryBytes(e), 0) };
  }

  private remove(ref: SegmentRef): void {
    rmSync(join(this.dir, ref.file), { force: true });
  }
}

// -- entry encoding -------------------------------------------------------------------------------

const int = (value: number) => ({ type: "int" as const, value });
const str = (value: string) => ({ type: "string" as const, value });
const ints = (value: number[]) => ({ type: "intArray" as const, value });
const dbl = (value: number) => ({ type: "double" as const, value });
const box = (b: Box) => ints([...b.min, ...b.max]);

function encodeEntry(e: JournalEntry, idx: (id: number) => number): Compound["value"] {
  return {
    Seq: int(e.seq),
    Op: str(e.op),
    Summary: str(e.summary),
    Time: dbl(e.time),
    Positions: ints([...e.positions]),
    Before: ints([...e.before].map(idx)),
    After: ints([...e.after].map(idx)),
    OriginBefore: ints([...e.originBefore]),
    OriginAfter: ints([...e.originAfter]),
    ...(e.boundsBefore ? { BoundsBefore: box(e.boundsBefore) } : {}),
    ...(e.boundsAfter ? { BoundsAfter: box(e.boundsAfter) } : {}),
    ...(e.nbt?.length
      ? {
          Nbt: {
            type: "list" as const,
            value: { type: "compound" as const, value: e.nbt.map((c) => ({ Index: int(c.index), ...(c.before ? { Before: c.before } : {}), ...(c.after ? { After: c.after } : {}) })) },
          },
        }
      : {}),
    ...(e.componentsBefore ? { ComponentsBefore: str(JSON.stringify(e.componentsBefore)) } : {}),
    ...(e.componentsAfter ? { ComponentsAfter: str(JSON.stringify(e.componentsAfter)) } : {}),
  };
}

function decodeEntry(c: Compound["value"], ids: number[]): JournalEntry {
  const state = (i: number) => {
    const id = ids[i];
    if (id === undefined) throw new Error(`corrupt journal segment: state index ${i} out of range`);
    return id;
  };
  const bb = arr(c.BoundsBefore), ba = arr(c.BoundsAfter);
  const toBox = (b: number[]): Box => ({ min: [b[0]!, b[1]!, b[2]!], max: [b[3]!, b[4]!, b[5]!] });
  const nbtChanges = listOf<Compound["value"]>(c.Nbt).map((n) => ({
    index: num(n.Index) ?? 0,
    ...(n.Before ? { before: n.Before as Compound } : {}),
    ...(n.After ? { after: n.After as Compound } : {}),
  }));
  const cb = text(c.ComponentsBefore), ca = text(c.ComponentsAfter);
  return {
    seq: num(c.Seq) ?? 0,
    op: text(c.Op) ?? "",
    summary: text(c.Summary) ?? "",
    time: num(c.Time) ?? 0,
    positions: Int32Array.from(arr(c.Positions)),
    before: Uint16Array.from(arr(c.Before).map(state)),
    after: Uint16Array.from(arr(c.After).map(state)),
    originBefore: arr(c.OriginBefore) as Vec3,
    originAfter: arr(c.OriginAfter) as Vec3,
    ...(bb.length === 6 ? { boundsBefore: toBox(bb) } : {}),
    ...(ba.length === 6 ? { boundsAfter: toBox(ba) } : {}),
    ...(nbtChanges.length ? { nbt: nbtChanges } : {}),
    ...(cb ? { componentsBefore: JSON.parse(cb) as Component[] } : {}),
    ...(ca ? { componentsAfter: JSON.parse(ca) as Component[] } : {}),
  };
}

function atomicWrite(file: string, buf: Buffer): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, buf);
  renameSync(tmp, file);
}

type Tag = Compound["value"][string];
const num = (t: Tag | undefined): number | undefined => (t && typeof t.value === "number" ? t.value : undefined);
const text = (t: Tag | undefined): string | undefined => (t && t.type === "string" ? t.value : undefined);
const arr = (t: Tag | undefined): number[] => (t && t.type === "intArray" ? t.value : []);
function listOf<T>(t: Tag | undefined): T[] {
  return t && t.type === "list" ? (t.value.value as T[]) : [];
}
