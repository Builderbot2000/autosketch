import type { Compound } from "prismarine-nbt";
import type { Box, Vec3 } from "../core/region.js";
import type { Component } from "./components.js";
import type { JournalStore } from "./journal-store.js";

/**
 * Journal (docs/design/04-document.md): one entry per op, holding a sparse before/after diff in
 * store coordinates, so undo/redo replays exactly regardless of later origin shifts.
 *
 * The history is a chain of entries (`seqs`). Memory holds a contiguous window of it (`entries`,
 * starting at chain index `start`); `cursor` is the undo point inside the window. With a store
 * attached (`journal-store.ts`), entries outside the window live in on-disk segments and are
 * loaded back when undo or redo reaches them, so history survives reopening and memory stays
 * under the cap. Without a store, entries over the cap are dropped from the front (`lost`).
 */
export interface JournalEntry {
  seq: number;
  op: string;
  /** One-line description for history(). */
  summary: string;
  time: number;
  /** x,y,z triplets (store coordinates). */
  positions: Int32Array;
  before: Uint16Array;
  after: Uint16Array;
  /** Block-entity changes by position index; undefined = no block entity. */
  nbt?: { index: number; before?: Compound; after?: Compound }[];
  boundsBefore?: Box;
  boundsAfter?: Box;
  originBefore: Vec3;
  originAfter: Vec3;
  /** Component snapshots when the op changed components. */
  componentsBefore?: Component[];
  componentsAfter?: Component[];
  /** Entity list snapshots (store coordinates in `Pos`) when the op changed entities. */
  entitiesBefore?: Compound[];
  entitiesAfter?: Compound[];
}

export function entryBytes(e: JournalEntry): number {
  return 200 + e.positions.byteLength + e.before.byteLength + e.after.byteLength + ((e.nbt?.length ?? 0) + (e.entitiesBefore?.length ?? 0) + (e.entitiesAfter?.length ?? 0)) * 256;
}

export interface Checkpoint {
  name: string;
  /** seq of the last applied entry when the checkpoint was made (0 = before any op). */
  seq: number;
  time: number;
}

export class Journal {
  /** The in-memory window: chain entries [start, start + entries.length). */
  readonly entries: JournalEntry[] = [];
  /** Applied entries end at window index `cursor`; entries[cursor..] can be redone. */
  cursor = 0;
  /** Chain index of entries[0]. */
  start = 0;
  /** Sequence numbers of the whole reachable history, in order (increasing). */
  readonly seqs: number[] = [];
  /** Entries dropped before a store was attached (no longer reachable). */
  lost = 0;
  private nextSeq = 1;
  /** Redo-tail seqs whose on-disk discard failed; dropped from the store on the next persist. */
  private pendingDiscard: number[] = [];
  readonly checkpoints = new Map<string, Checkpoint>();
  store?: JournalStore;

  constructor(private readonly maxBytes = 256 * 1024 * 1024) {}

  newSeq(): number {
    return this.nextSeq++;
  }

  get next(): number {
    return this.nextSeq;
  }

  /** Entries before the window (on disk or lost); history() reports them as earlier ops. */
  get dropped(): number {
    return this.lost + this.start;
  }

  /** Applied entries in the whole reachable history. */
  get position(): number {
    return this.start + this.cursor;
  }

  /**
   * Records a committed op: discards the redo tail, then trims the window to the memory cap.
   * Disk writes here are best-effort (04, Journal segments): the op has already applied, so a
   * failing store never throws. Entries stay in memory past the cap, the failure comes back as a
   * warning for the op result, and the write is retried on the next trim or save.
   */
  push(e: JournalEntry): string | undefined {
    const discarded = this.seqs.splice(this.position);
    this.entries.length = this.cursor;
    let warning: string | undefined;
    if (discarded.length && this.store) {
      this.pendingDiscard.push(...discarded);
      warning = this.tryDisk(() => this.flushDiscard());
    }
    this.entries.push(e);
    this.seqs.push(e.seq);
    this.cursor = this.entries.length;
    return this.trim() ?? warning;
  }

  get canUndo(): boolean {
    return this.position > 0;
  }
  get canRedo(): boolean {
    return this.position < this.seqs.length;
  }

  /** seq of the last applied entry (0 when none). */
  get headSeq(): number {
    return this.position > 0 ? this.seqs[this.position - 1]! : 0;
  }

  /** Makes sure the entry undo would revert is in memory (loading its segment if needed). */
  ensureUndo(): void {
    if (this.cursor > 0 || this.start === 0 || !this.store) return;
    this.loadBefore();
    this.trim(); // best-effort; a write failure keeps entries in memory
  }

  /** Makes sure the entry redo would apply is in memory. */
  ensureRedo(): void {
    if (this.cursor < this.entries.length || this.start + this.entries.length >= this.seqs.length || !this.store) return;
    this.loadAfter();
    this.trim();
  }

  /**
   * Chain position for a checkpoint (applied entries when it was made), or undefined when it can
   * no longer be reached (its op was discarded by a later edit after undo, or lost to the cap).
   */
  cursorFor(cp: Checkpoint): number | undefined {
    if (cp.seq === 0) return this.lost === 0 ? 0 : undefined;
    const i = this.chainIndex(cp.seq);
    return i < 0 ? undefined : i + 1;
  }

  /** Writes entries not yet on disk and the index. No-op without a store. */
  persist(): void {
    const store = this.store;
    if (!store) return;
    this.flushDiscard();
    store.append(this.entries.filter((e) => !store.has(e.seq)));
    store.writeIndex({ nextSeq: this.nextSeq, lost: this.lost, checkpoints: [...this.checkpoints.values()] });
  }

  /** Attaches a store and restores the chain it holds, with `head` (a seq) as the undo point. */
  attach(store: JournalStore, index: { nextSeq: number; lost: number; checkpoints: Checkpoint[] }, head: number): boolean {
    const seqs = store.allSeqs();
    const pos = head === 0 ? 0 : seqs.indexOf(head) + 1;
    if (head !== 0 && pos === 0) return false;
    this.store = store;
    this.seqs.splice(0, this.seqs.length, ...seqs);
    this.entries.length = 0;
    this.start = pos;
    this.cursor = 0;
    this.lost = index.lost;
    this.pendingDiscard = [];
    this.nextSeq = Math.max(index.nextSeq, (seqs[seqs.length - 1] ?? 0) + 1, head + 1);
    this.checkpoints.clear();
    for (const c of index.checkpoints) this.checkpoints.set(c.name, c);
    return true;
  }

  /** Entries at chain indices [from, to), from memory or read from disk without caching (for history()). */
  peek(from: number, to: number): JournalEntry[] {
    const out: JournalEntry[] = [];
    const read = new Map<string, JournalEntry[]>();
    for (let i = Math.max(0, from); i < Math.min(to, this.seqs.length); i++) {
      const w = i - this.start;
      if (w >= 0 && w < this.entries.length) {
        out.push(this.entries[w]!);
        continue;
      }
      const seq = this.seqs[i]!;
      const ref = this.store?.segmentOf(seq);
      if (!ref) continue;
      let seg = read.get(ref.file);
      if (!seg) read.set(ref.file, (seg = this.store!.read(ref)));
      const e = seg.find((x) => x.seq === seq);
      if (e) out.push(e);
    }
    return out;
  }

  /** Loads every reachable entry into memory (before moving the journal to another store). */
  loadAll(): void {
    if (!this.store) return;
    while (this.start > 0) this.loadBefore();
    while (this.start + this.entries.length < this.seqs.length) this.loadAfter();
  }

  /** Prepends the on-disk entries just before the window (the rest of their segment). */
  private loadBefore(): void {
    const seq = this.seqs[this.start - 1]!;
    const ref = this.store?.segmentOf(seq);
    if (!ref) throw new Error(`journal segment for op #${seq} is missing`);
    const older = this.store!.read(ref).filter((e) => {
      const i = this.chainIndex(e.seq);
      return i >= 0 && i < this.start;
    });
    if (!older.length) throw new Error(`journal segment ${ref.file} does not hold op #${seq}`);
    this.entries.unshift(...older);
    this.start -= older.length;
    this.cursor += older.length;
  }

  /** Appends the on-disk entries just after the window. */
  private loadAfter(): void {
    const end = this.start + this.entries.length;
    const seq = this.seqs[end]!;
    const ref = this.store?.segmentOf(seq);
    if (!ref) throw new Error(`journal segment for op #${seq} is missing`);
    const newer = this.store!.read(ref).filter((e) => this.chainIndex(e.seq) >= end);
    if (!newer.length) throw new Error(`journal segment ${ref.file} does not hold op #${seq}`);
    this.entries.push(...newer);
  }

  private flushDiscard(): void {
    if (!this.pendingDiscard.length) return;
    this.store?.discard(this.pendingDiscard);
    this.pendingDiscard = [];
  }

  /** Runs a disk write, turning a failure into a warning (the caller's op has already applied). */
  private tryDisk(write: () => void): string | undefined {
    try {
      write();
      return undefined;
    } catch (err) {
      return `undo history couldn't be written to disk (${(err as Error).message}); it is kept in memory and retried on the next edit or save`;
    }
  }

  private chainIndex(seq: number): number {
    // seqs only grow, so binary search.
    let lo = 0, hi = this.seqs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, v = this.seqs[mid]!;
      if (v === seq) return mid;
      if (v < seq) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  /**
   * Keeps the window under the memory cap, never evicting the entry undo needs next. Returns a
   * warning when persisting failed: nothing is evicted then, so the window may exceed the cap.
   */
  private trim(): string | undefined {
    let bytes = this.entries.reduce((s, x) => s + entryBytes(x), 0);
    if (bytes <= this.maxBytes) return undefined;
    if (!this.store) {
      while (bytes > this.maxBytes && this.cursor > 1) {
        const e = this.entries.shift()!;
        bytes -= entryBytes(e);
        this.seqs.shift();
        this.cursor--;
        this.lost++;
      }
      return undefined;
    }
    const failed = this.tryDisk(() => this.persist()); // everything evicted must be on disk first
    if (failed) return failed;
    while (bytes > this.maxBytes && this.cursor > 1) {
      bytes -= entryBytes(this.entries.shift()!);
      this.start++;
      this.cursor--;
    }
    while (bytes > this.maxBytes && this.entries.length > this.cursor) bytes -= entryBytes(this.entries.pop()!);
    return undefined;
  }
}
