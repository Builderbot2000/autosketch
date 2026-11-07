import type { Compound } from "prismarine-nbt";
import type { Box, Vec3 } from "../core/region.js";
import type { Component } from "./components.js";

/**
 * Journal (docs/design/04-document.md): one entry per op, holding a sparse before/after diff in
 * store coordinates, so undo/redo replays exactly regardless of later origin shifts.
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
}

export function entryBytes(e: JournalEntry): number {
  return 200 + e.positions.byteLength + e.before.byteLength + e.after.byteLength + (e.nbt?.length ?? 0) * 256;
}

export interface Checkpoint {
  name: string;
  /** seq of the last applied entry when the checkpoint was made (0 = before any op). */
  seq: number;
  time: number;
}

export class Journal {
  /** Applied entries are entries[0..cursor); entries[cursor..] can be redone. */
  readonly entries: JournalEntry[] = [];
  cursor = 0;
  private nextSeq = 1;
  /** Entries dropped from the front to respect the memory cap. */
  dropped = 0;
  readonly checkpoints = new Map<string, Checkpoint>();

  constructor(private readonly maxBytes = 256 * 1024 * 1024) {}

  newSeq(): number {
    return this.nextSeq++;
  }

  /** Records a committed op: discards the redo tail, then trims old entries to the memory cap. */
  push(e: JournalEntry): void {
    this.entries.length = this.cursor;
    this.entries.push(e);
    this.cursor = this.entries.length;
    let bytes = this.entries.reduce((s, x) => s + entryBytes(x), 0);
    while (bytes > this.maxBytes && this.entries.length > 1) {
      bytes -= entryBytes(this.entries.shift()!);
      this.cursor--;
      this.dropped++;
    }
  }

  get canUndo(): boolean {
    return this.cursor > 0;
  }
  get canRedo(): boolean {
    return this.cursor < this.entries.length;
  }

  /** seq of the last applied entry (0 when none). */
  get headSeq(): number {
    return this.cursor > 0 ? this.entries[this.cursor - 1]!.seq : 0;
  }

  /**
   * Cursor position for a checkpoint, or undefined when it can no longer be reached (its op was
   * discarded by a later edit after undo, or trimmed by the memory cap).
   */
  cursorFor(cp: Checkpoint): number | undefined {
    if (cp.seq === 0) return this.dropped === 0 ? 0 : undefined;
    const i = this.entries.findIndex((e) => e.seq === cp.seq);
    return i < 0 ? undefined : i + 1;
  }
}
