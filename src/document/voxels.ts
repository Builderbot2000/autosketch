import type { Box, Vec3 } from "../core/region.js";

/**
 * Global table of canonical state strings ↔ small integer ids (docs/design/04-document.md).
 * Id 0 is always air.
 */
export class StateTable {
  private readonly byState = new Map<string, number>();
  private readonly states: string[] = [];

  constructor(initial: readonly string[] = ["minecraft:air"]) {
    for (const s of initial) this.intern(s);
    if (this.states[0] !== "minecraft:air") throw new Error("state table must start with minecraft:air");
  }

  intern(state: string): number {
    let id = this.byState.get(state);
    if (id === undefined) {
      id = this.states.length;
      if (id > 0xffff) throw new Error("too many distinct block states in one document (max 65536)");
      this.states.push(state);
      this.byState.set(state, id);
    }
    return id;
  }

  idOf(state: string): number | undefined {
    return this.byState.get(state);
  }

  get(id: number): string {
    const s = this.states[id];
    if (s === undefined) throw new Error(`unknown state id ${id}`);
    return s;
  }

  get size(): number {
    return this.states.length;
  }

  all(): readonly string[] {
    return this.states;
  }
}

export const SECTION = 16;
const COORD_LIMIT = 32000;

/** One 16³ section: global state ids, x fastest, then z, then y. */
export interface Section {
  sx: number;
  sy: number;
  sz: number;
  ids: Uint16Array;
  /** Non-air blocks in this section. */
  count: number;
}

function sectionKey(sx: number, sy: number, sz: number): number {
  return ((sx + 2048) * 4096 + (sz + 2048)) * 128 + (sy + 64);
}

export function indexInSection(x: number, y: number, z: number): number {
  return ((y & 15) << 8) | ((z & 15) << 4) | (x & 15);
}

/**
 * Sparse voxel store chunked into 16³ sections. Empty sections are dropped. In memory each
 * section is a flat Uint16Array of global state ids (8 KB); the native format packs them with a
 * local palette (see native.ts).
 */
export class VoxelStore {
  private readonly sections = new Map<number, Section>();
  /**
   * Called on every `set`, before it applies, even when the id doesn't change (a transaction sets
   * a position whose block entity alone changes the same way). The live world link keeps its
   * cache section hashes with it (13, *Section hashes*; `world/sync.ts`). Undefined otherwise.
   */
  onWrite?: (x: number, y: number, z: number) => void;

  get(x: number, y: number, z: number): number {
    const s = this.sections.get(sectionKey(x >> 4, y >> 4, z >> 4));
    return s ? s.ids[indexInSection(x, y, z)]! : 0;
  }

  /** Sets a block, returning the previous state id. */
  set(x: number, y: number, z: number, id: number): number {
    if (Math.abs(x) > COORD_LIMIT || Math.abs(z) > COORD_LIMIT || Math.abs(y) > 1000) throw new Error(`position (${x},${y},${z}) is out of range (|x|,|z| ≤ ${COORD_LIMIT}, |y| ≤ 1000)`);
    if (this.onWrite) this.onWrite(x, y, z);
    const key = sectionKey(x >> 4, y >> 4, z >> 4);
    let s = this.sections.get(key);
    if (!s) {
      if (id === 0) return 0;
      s = { sx: x >> 4, sy: y >> 4, sz: z >> 4, ids: new Uint16Array(4096), count: 0 };
      this.sections.set(key, s);
    }
    const i = indexInSection(x, y, z);
    const prev = s.ids[i]!;
    if (prev === id) return prev;
    s.ids[i] = id;
    if (prev === 0) s.count++;
    else if (id === 0) s.count--;
    if (s.count === 0) this.sections.delete(key);
    return prev;
  }

  /** Puts a whole section (used when loading). */
  putSection(s: Section): void {
    if (s.count > 0) this.sections.set(sectionKey(s.sx, s.sy, s.sz), s);
  }

  allSections(): IterableIterator<Section> {
    return this.sections.values();
  }

  get sectionCount(): number {
    return this.sections.size;
  }

  /** Total non-air blocks. */
  count(): number {
    let n = 0;
    for (const s of this.sections.values()) n += s.count;
    return n;
  }

  /** Visits every non-air block inside `box` (half-open, store coordinates). */
  forEachInBox(box: Box, fn: (x: number, y: number, z: number, id: number) => void): void {
    const [x0, y0, z0] = box.min, [x1, y1, z1] = box.max;
    for (const s of this.sections.values()) {
      const bx = s.sx * 16, by = s.sy * 16, bz = s.sz * 16;
      if (bx >= x1 || bx + 16 <= x0 || by >= y1 || by + 16 <= y0 || bz >= z1 || bz + 16 <= z0) continue;
      const ya = Math.max(y0, by), yb = Math.min(y1, by + 16);
      const za = Math.max(z0, bz), zb = Math.min(z1, bz + 16);
      const xa = Math.max(x0, bx), xb = Math.min(x1, bx + 16);
      for (let y = ya; y < yb; y++)
        for (let z = za; z < zb; z++)
          for (let x = xa; x < xb; x++) {
            const id = s.ids[indexInSection(x, y, z)]!;
            if (id) fn(x, y, z, id);
          }
    }
  }

  /** Visits every non-air block. */
  forEach(fn: (x: number, y: number, z: number, id: number) => void): void {
    for (const s of this.sections.values()) {
      const bx = s.sx * 16, by = s.sy * 16, bz = s.sz * 16;
      for (let i = 0; i < 4096; i++) {
        const id = s.ids[i]!;
        if (id) fn(bx + (i & 15), by + (i >> 8), bz + ((i >> 4) & 15), id);
      }
    }
  }

  /** Tight bounding box of non-air blocks, or undefined when empty. */
  contentBox(): Box | undefined {
    let min: Vec3 | undefined, max: Vec3 | undefined;
    this.forEach((x, y, z) => {
      if (!min || !max) {
        min = [x, y, z];
        max = [x + 1, y + 1, z + 1];
        return;
      }
      if (x < min[0]) min[0] = x;
      if (y < min[1]) min[1] = y;
      if (z < min[2]) min[2] = z;
      if (x + 1 > max[0]) max[0] = x + 1;
      if (y + 1 > max[1]) max[1] = y + 1;
      if (z + 1 > max[2]) max[2] = z + 1;
    });
    return min && max ? { min, max } : undefined;
  }

  /** Counts per state id. */
  histogram(box?: Box): Map<number, number> {
    const h = new Map<number, number>();
    const add = (_x: number, _y: number, _z: number, id: number) => h.set(id, (h.get(id) ?? 0) + 1);
    if (box) this.forEachInBox(box, add);
    else this.forEach(add);
    return h;
  }
}
