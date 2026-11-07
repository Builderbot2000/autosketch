import type { Compound } from "prismarine-nbt";
import { AIR } from "../core/blockstate.js";
import { boxVolume, type Box, type Vec3 } from "../core/region.js";
import { PaletteBook } from "../palette/pick.js";
import { checkComponentId, cloneComponents, type Component } from "./components.js";
import { Journal, type JournalEntry } from "./journal.js";
import { indexInSection, StateTable, VoxelStore } from "./voxels.js";

/**
 * One schematic being edited (docs/design/04-document.md).
 *
 * Coordinates: callers use document-local coordinates, which stay fixed while editing (01): an op
 * that builds below zero grows the bounds into negative coordinates instead of renumbering
 * everything, so a planned build's coordinates stay valid. Exports normalise to (0,0,0) (08).
 * Internally blocks live in "store" coordinates and `origin` is the store position of local
 * (0,0,0); journal entries are recorded in store coordinates, so an explicit re-origin (moving
 * `origin`, O(1)) never invalidates undo.
 */

export type Facing = "north" | "south" | "east" | "west";
export const FACINGS: readonly Facing[] = ["north", "south", "east", "west"];

export interface DocMeta {
  name: string;
  front: Facing;
  dataVersion: number;
  seed: number;
  createdAt: string;
  /** Where the document came from, when imported. */
  source?: string;
}

export interface EditResult {
  op: string;
  seq: number;
  /** Positions whose block or block entity changed. */
  changed: number;
  /** Local box of the changed positions (after any shift). */
  box?: Box;
  /** How far the origin moved: existing local coordinates changed by minus this. */
  shift?: Vec3;
  warnings: string[];
}

export interface ComponentInput {
  id: string;
  kind?: string;
  /** Local half-open box. */
  box: Box;
  parent?: string;
  anchors?: Record<string, Vec3>;
  tags?: string[];
  notes?: string;
}

const sectionKey = (sx: number, sy: number, sz: number) => ((sx + 2048) * 4096 + (sz + 2048)) * 128 + (sy + 64);
const posKey = (x: number, y: number, z: number) => `${x},${y},${z}`;

export class Document {
  readonly states: StateTable;
  readonly voxels: VoxelStore;
  /** Block entities by store position "x,y,z". */
  readonly blockEntities = new Map<string, Compound>();
  /** Preserved verbatim on round-trip; not edited in v1. */
  entities: Compound[] = [];
  components = new Map<string, Component>();
  palettes: PaletteBook;
  readonly journal: Journal;
  /** Store position of local (0,0,0). */
  origin: Vec3 = [0, 0, 0];
  /** Grow-only bounds in store coordinates (declared size ∪ everything ever written). */
  bounds?: Box;
  /**
   * Named selection expressions (05), re-evaluated on each use. Not journaled (like checkpoints);
   * saved with the document. Kept as plain JSON so this module doesn't depend on ops.
   */
  selections = new Map<string, string | Record<string, unknown>>();
  /** The most recent selection an op or select used ("last"). Not saved. */
  lastSelection?: string | Record<string, unknown>;
  /** Bumped on every change; the session uses it for autosave. */
  revision = 0;

  constructor(
    public meta: DocMeta,
    opts: { states?: StateTable; voxels?: VoxelStore; palettes?: PaletteBook; journalBytes?: number } = {},
  ) {
    this.states = opts.states ?? new StateTable();
    this.voxels = opts.voxels ?? new VoxelStore();
    this.palettes = opts.palettes ?? new PaletteBook();
    this.journal = new Journal(opts.journalBytes);
  }

  static create(opts: { name: string; size?: Vec3; front?: Facing; dataVersion: number; seed?: number; palettes?: PaletteBook }): Document {
    const meta: DocMeta = {
      name: opts.name,
      front: opts.front ?? "south",
      dataVersion: opts.dataVersion,
      seed: opts.seed ?? (Math.random() * 0x7fffffff) | 0,
      createdAt: new Date().toISOString(),
    };
    const doc = new Document(meta, opts.palettes ? { palettes: opts.palettes } : {});
    if (opts.size) {
      if (opts.size.some((n) => !Number.isInteger(n) || n < 1 || n > 4096)) throw new Error(`size must be three integers 1..4096 (got ${JSON.stringify(opts.size)})`);
      doc.bounds = { min: [0, 0, 0], max: [...opts.size] };
    }
    return doc;
  }

  // -- coordinates ------------------------------------------------------------------------------

  toStore(x: number, y: number, z: number): Vec3 {
    return [x + this.origin[0], y + this.origin[1], z + this.origin[2]];
  }

  toLocal(x: number, y: number, z: number): Vec3 {
    return [x - this.origin[0], y - this.origin[1], z - this.origin[2]];
  }

  boxToStore(b: Box): Box {
    return { min: this.toStore(...b.min), max: this.toStore(...b.max) };
  }

  boxToLocal(b: Box): Box {
    return { min: this.toLocal(...b.min), max: this.toLocal(...b.max) };
  }

  /** Local bounds (min may be negative after building below zero), or undefined when empty. */
  localBounds(): Box | undefined {
    return this.bounds && this.boxToLocal(this.bounds);
  }

  // -- reads ------------------------------------------------------------------------------------

  getState(x: number, y: number, z: number): string {
    const [sx, sy, sz] = this.toStore(x, y, z);
    return this.states.get(this.voxels.get(sx, sy, sz));
  }

  getBlockEntity(x: number, y: number, z: number): Compound | undefined {
    return this.blockEntities.get(posKey(...this.toStore(x, y, z)));
  }

  blockCount(): number {
    return this.voxels.count();
  }

  componentLocal(id: string): (Omit<Component, "box" | "anchors"> & { box: Box; anchors: Record<string, Vec3> }) | undefined {
    const c = this.components.get(id);
    if (!c) return undefined;
    const anchors: Record<string, Vec3> = {};
    for (const [k, v] of Object.entries(c.anchors)) anchors[k] = this.toLocal(...v);
    return { ...c, box: this.boxToLocal(c.box), anchors };
  }

  // -- edits ------------------------------------------------------------------------------------

  /**
   * Runs `body` as one journaled op. Writes go straight to the store and are rolled back if the
   * body throws, so an op either commits completely or not at all.
   */
  edit<T>(op: string, summary: string, body: (tx: Transaction) => T): EditResult & { value: T } {
    const tx = new Transaction(this);
    let value: T;
    try {
      value = body(tx);
    } catch (e) {
      tx.rollback();
      throw e;
    }
    return { ...this.commit(op, summary, tx), value };
  }

  private commit(op: string, summary: string, tx: Transaction): EditResult {
    const { positions, before, after, nbt } = tx.finish();
    const componentsChanged = tx.componentsBefore !== undefined;
    const n = before.length;
    if (n === 0 && !componentsChanged) return { op, seq: this.journal.headSeq, changed: 0, warnings: tx.warnings };

    const boundsBefore = this.bounds && structuredClone(this.bounds);
    const originBefore: Vec3 = [...this.origin];
    // Grow bounds over written non-air blocks (bounds never shrink on their own).
    let lo: Vec3 | undefined, hi: Vec3 | undefined;
    for (let i = 0; i < n; i++) {
      if (after[i] === 0) continue;
      const x = positions[i * 3]!, y = positions[i * 3 + 1]!, z = positions[i * 3 + 2]!;
      if (!lo || !hi) {
        lo = [x, y, z];
        hi = [x + 1, y + 1, z + 1];
        continue;
      }
      lo = [Math.min(lo[0], x), Math.min(lo[1], y), Math.min(lo[2], z)];
      hi = [Math.max(hi[0], x + 1), Math.max(hi[1], y + 1), Math.max(hi[2], z + 1)];
    }
    if (lo && hi) {
      const b = this.bounds;
      this.bounds = b
        ? { min: [Math.min(b.min[0], lo[0]), Math.min(b.min[1], lo[1]), Math.min(b.min[2], lo[2])], max: [Math.max(b.max[0], hi[0]), Math.max(b.max[1], hi[1]), Math.max(b.max[2], hi[2])] }
        : { min: lo, max: hi };
    }

    const entry: JournalEntry = {
      seq: this.journal.newSeq(),
      op,
      summary,
      time: Date.now(),
      positions,
      before,
      after,
      originBefore,
      originAfter: [...this.origin],
      ...(nbt.length ? { nbt } : {}),
      ...(boundsBefore ? { boundsBefore } : {}),
      ...(this.bounds ? { boundsAfter: structuredClone(this.bounds) } : {}),
      ...(componentsChanged ? { componentsBefore: tx.componentsBefore, componentsAfter: cloneComponents(this.components.values()) } : {}),
    };
    this.journal.push(entry);
    this.revision++;

    const shift = diff(this.origin, originBefore);
    const box = changedBox(positions);
    return {
      op,
      seq: entry.seq,
      changed: n,
      ...(box ? { box: this.boxToLocal(box) } : {}),
      ...(shift ? { shift } : {}),
      warnings: tx.warnings,
    };
  }

  undo(): { entry: JournalEntry; shift?: Vec3 } | undefined {
    this.journal.ensureUndo(); // loads an on-disk journal segment when undo reaches past memory (04)
    if (!this.journal.canUndo) return undefined;
    const e = this.journal.entries[--this.journal.cursor]!;
    this.apply(e, "before");
    return { entry: e, ...shiftOf(e.originAfter, e.originBefore) };
  }

  redo(): { entry: JournalEntry; shift?: Vec3 } | undefined {
    this.journal.ensureRedo();
    if (!this.journal.canRedo) return undefined;
    const e = this.journal.entries[this.journal.cursor++]!;
    this.apply(e, "after");
    return { entry: e, ...shiftOf(e.originBefore, e.originAfter) };
  }

  private apply(e: JournalEntry, side: "before" | "after"): void {
    const ids = side === "before" ? e.before : e.after;
    const order = side === "before" ? range(ids.length).reverse() : range(ids.length);
    for (const i of order) this.voxels.set(e.positions[i * 3]!, e.positions[i * 3 + 1]!, e.positions[i * 3 + 2]!, ids[i]!);
    for (const c of e.nbt ?? []) {
      const k = posKey(e.positions[c.index * 3]!, e.positions[c.index * 3 + 1]!, e.positions[c.index * 3 + 2]!);
      const v = side === "before" ? c.before : c.after;
      if (v) this.blockEntities.set(k, v);
      else this.blockEntities.delete(k);
    }
    const bounds = side === "before" ? e.boundsBefore : e.boundsAfter;
    if (bounds) this.bounds = structuredClone(bounds);
    else delete this.bounds;
    this.origin = [...(side === "before" ? e.originBefore : e.originAfter)];
    const comps = side === "before" ? e.componentsBefore : e.componentsAfter;
    if (comps) this.components = new Map(cloneComponents(comps).map((c) => [c.id, c]));
    this.revision++;
  }

  checkpoint(name: string): void {
    if (!/^[a-z0-9_.-]+$/i.test(name)) throw new Error(`checkpoint name must be letters, digits, _ . or - (got "${name}")`);
    this.journal.checkpoints.set(name, { name, seq: this.journal.headSeq, time: Date.now() });
  }

  /** Undoes or redoes to a checkpoint; returns how many ops were stepped over and the net shift. */
  restore(name: string): { steps: number; direction: "undo" | "redo" | "none"; shift?: Vec3 } {
    const cp = this.journal.checkpoints.get(name);
    if (!cp) throw new Error(`no checkpoint "${name}" (have: ${[...this.journal.checkpoints.keys()].join(", ") || "none"})`);
    const target = this.journal.cursorFor(cp);
    if (target === undefined) throw new Error(`checkpoint "${name}" can no longer be restored: the ops after it were replaced by newer edits or trimmed from memory`);
    const originBefore: Vec3 = [...this.origin];
    const steps = Math.abs(target - this.journal.position);
    const direction = target < this.journal.position ? "undo" : target > this.journal.position ? "redo" : "none";
    while (this.journal.position > target) this.undo();
    while (this.journal.position < target) this.redo();
    return { steps, direction, ...shiftOf(originBefore, this.origin) };
  }
}

/**
 * The write side of one op. Coordinates are local (at the time the op started). Records the first
 * "before" value of each position so the op can be undone or rolled back.
 */
export class Transaction {
  /** Per touched 16³ section: (diff index + 1) per block, 0 = untouched. Cheap dedupe for big fills. */
  private readonly touched = new Map<number, Int32Array>();
  private pos = new Int32Array(3 * 1024);
  private before = new Uint16Array(1024);
  private n = 0;
  private readonly nbtChanges = new Map<number, { before?: Compound; after?: Compound }>();
  readonly warnings: string[] = [];
  componentsBefore?: Component[];
  private readonly origin: Vec3;

  constructor(private readonly doc: Document) {
    this.origin = [...doc.origin];
  }

  /** State at a local position. */
  get(x: number, y: number, z: number): string {
    return this.doc.states.get(this.doc.voxels.get(x + this.origin[0], y + this.origin[1], z + this.origin[2]));
  }

  getId(x: number, y: number, z: number): number {
    return this.doc.voxels.get(x + this.origin[0], y + this.origin[1], z + this.origin[2]);
  }

  intern(state: string): number {
    return this.doc.states.intern(state);
  }

  /**
   * Sets a canonical state (or interned id) at a local position. `nbt`: a compound sets the block
   * entity, null removes it, undefined keeps it only if the block is unchanged (01: replacing a
   * block drops its NBT).
   */
  set(x: number, y: number, z: number, state: string | number, nbt?: Compound | null): void {
    const sx = x + this.origin[0], sy = y + this.origin[1], sz = z + this.origin[2];
    const id = typeof state === "number" ? state : this.doc.states.intern(state);
    const sk = sectionKey(sx >> 4, sy >> 4, sz >> 4);
    let t = this.touched.get(sk);
    if (!t) this.touched.set(sk, (t = new Int32Array(4096)));
    const ti = indexInSection(sx, sy, sz);
    const prev = this.doc.voxels.set(sx, sy, sz, id);
    let i = t[ti]! - 1;
    if (i < 0) {
      i = this.n++;
      if (this.n > this.before.length) this.grow();
      t[ti] = i + 1;
      this.pos[i * 3] = sx;
      this.pos[i * 3 + 1] = sy;
      this.pos[i * 3 + 2] = sz;
      this.before[i] = prev;
    }
    if (nbt === undefined && this.doc.blockEntities.size === 0) return; // fast path: no NBT anywhere
    const pk = posKey(sx, sy, sz);
    const had = this.doc.blockEntities.get(pk);
    let next: Compound | undefined = had;
    if (nbt === null || id === 0) next = undefined;
    else if (nbt) next = nbt;
    else if (prev !== id) next = undefined;
    if (next !== had) {
      const c = this.nbtChanges.get(i) ?? { ...(had ? { before: had } : {}) };
      if (next) {
        c.after = next;
        this.doc.blockEntities.set(pk, next);
      } else {
        delete c.after;
        this.doc.blockEntities.delete(pk);
      }
      this.nbtChanges.set(i, c);
    }
  }

  private grow(): void {
    const pos = new Int32Array(this.pos.length * 2);
    pos.set(this.pos);
    this.pos = pos;
    const before = new Uint16Array(this.before.length * 2);
    before.set(this.before);
    this.before = before;
  }

  /** Visits each local position written so far in this op, once (auto-connection reads it, 05). */
  forEachTouched(fn: (x: number, y: number, z: number) => void): void {
    for (let i = 0; i < this.n; i++) fn(this.pos[i * 3]! - this.origin[0], this.pos[i * 3 + 1]! - this.origin[1], this.pos[i * 3 + 2]! - this.origin[2]);
  }

  /** Clears a local position to air. */
  clear(x: number, y: number, z: number): void {
    this.set(x, y, z, 0);
  }

  warn(msg: string): void {
    if (!this.warnings.includes(msg)) this.warnings.push(msg);
  }

  /** Registers or replaces a component (local box and anchors). */
  setComponent(c: ComponentInput): void {
    checkComponentId(c.id);
    if (c.parent && c.parent !== c.id && !this.doc.components.has(c.parent)) throw new Error(`parent component "${c.parent}" does not exist`);
    if (boxVolume(c.box) === 0) throw new Error(`component "${c.id}" has an empty box`);
    this.componentsBefore ??= cloneComponents(this.doc.components.values());
    const anchors: Record<string, Vec3> = {};
    for (const [k, v] of Object.entries(c.anchors ?? {})) anchors[k] = [v[0] + this.origin[0], v[1] + this.origin[1], v[2] + this.origin[2]];
    this.doc.components.set(c.id, {
      id: c.id,
      ...(c.kind ? { kind: c.kind } : {}),
      box: { min: add(c.box.min, this.origin), max: add(c.box.max, this.origin) },
      ...(c.parent ? { parent: c.parent } : {}),
      anchors,
      tags: c.tags ?? [],
      ...(c.notes ? { notes: c.notes } : {}),
    });
  }

  removeComponent(id: string): boolean {
    if (!this.doc.components.has(id)) return false;
    this.componentsBefore ??= cloneComponents(this.doc.components.values());
    this.doc.components.delete(id);
    for (const c of this.doc.components.values()) if (c.parent === id) delete c.parent;
    return true;
  }

  /** Undoes every write made so far (on error). */
  rollback(): void {
    for (let i = this.n - 1; i >= 0; i--) this.doc.voxels.set(this.pos[i * 3]!, this.pos[i * 3 + 1]!, this.pos[i * 3 + 2]!, this.before[i]!);
    for (const [i, c] of this.nbtChanges) {
      const pk = posKey(this.pos[i * 3]!, this.pos[i * 3 + 1]!, this.pos[i * 3 + 2]!);
      if (c.before) this.doc.blockEntities.set(pk, c.before);
      else this.doc.blockEntities.delete(pk);
    }
    if (this.componentsBefore) this.doc.components = new Map(this.componentsBefore.map((c) => [c.id, c]));
  }

  /** Compacts the diff, dropping positions that ended where they started. */
  finish(): { positions: Int32Array; before: Uint16Array; after: Uint16Array; nbt: NonNullable<JournalEntry["nbt"]> } {
    const n = this.n;
    const afterAll = new Uint16Array(n);
    let kept = 0;
    for (let i = 0; i < n; i++) {
      const a = this.doc.voxels.get(this.pos[i * 3]!, this.pos[i * 3 + 1]!, this.pos[i * 3 + 2]!);
      afterAll[i] = a;
      const c = this.nbtChanges.get(i);
      if (a !== this.before[i] || (c && c.before !== c.after)) kept++;
    }
    const positions = new Int32Array(kept * 3);
    const before = new Uint16Array(kept);
    const after = new Uint16Array(kept);
    const nbt: NonNullable<JournalEntry["nbt"]> = [];
    let j = 0;
    for (let i = 0; i < n; i++) {
      const c = this.nbtChanges.get(i);
      const nbtChanged = !!c && c.before !== c.after;
      if (afterAll[i] === this.before[i] && !nbtChanged) continue;
      positions[j * 3] = this.pos[i * 3]!;
      positions[j * 3 + 1] = this.pos[i * 3 + 1]!;
      positions[j * 3 + 2] = this.pos[i * 3 + 2]!;
      before[j] = this.before[i]!;
      after[j] = afterAll[i]!;
      if (nbtChanged) nbt.push({ index: j, ...c });
      j++;
    }
    return { positions, before, after, nbt };
  }
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function diff(a: Vec3, b: Vec3): Vec3 | undefined {
  const d: Vec3 = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  return d.some((v) => v !== 0) ? d : undefined;
}

function shiftOf(from: Vec3, to: Vec3): { shift?: Vec3 } {
  const d = diff(to, from);
  return d ? { shift: d } : {};
}

function changedBox(p: Int32Array): Box | undefined {
  if (p.length === 0) return undefined;
  const min: Vec3 = [p[0]!, p[1]!, p[2]!], max: Vec3 = [p[0]! + 1, p[1]! + 1, p[2]! + 1];
  for (let i = 3; i < p.length; i += 3)
    for (let a = 0; a < 3; a++) {
      const v = p[i + a]!;
      if (v < min[a]!) min[a] = v;
      if (v + 1 > max[a]!) max[a] = v + 1;
    }
  return { min, max };
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

export { AIR };
