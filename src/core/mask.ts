import { boxVolume, type Box, type Vec3 } from "./region.js";

/**
 * A sparse set of block positions (docs/design/05-operations.md, selections), chunked into 16³
 * sections of 4096 bits like the voxel store. Coordinates are document-local.
 */

interface Chunk {
  sx: number;
  sy: number;
  sz: number;
  bits: Uint32Array; // 128 words; bit i = ((y&15)<<8)|((z&15)<<4)|(x&15)
}

const key = (sx: number, sy: number, sz: number) => ((sx + 4096) * 8192 + (sz + 4096)) * 256 + (sy + 128);
const bitIndex = (x: number, y: number, z: number) => ((y & 15) << 8) | ((z & 15) << 4) | (x & 15);

function popcount(v: number): number {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export class Mask {
  private readonly chunks = new Map<number, Chunk>();

  static fromBox(b: Box): Mask {
    const m = new Mask();
    for (let y = b.min[1]; y < b.max[1]; y++) for (let z = b.min[2]; z < b.max[2]; z++) for (let x = b.min[0]; x < b.max[0]; x++) m.add(x, y, z);
    return m;
  }

  has(x: number, y: number, z: number): boolean {
    const c = this.chunks.get(key(x >> 4, y >> 4, z >> 4));
    if (!c) return false;
    const i = bitIndex(x, y, z);
    return (c.bits[i >>> 5]! & (1 << (i & 31))) !== 0;
  }

  add(x: number, y: number, z: number): void {
    const k = key(x >> 4, y >> 4, z >> 4);
    let c = this.chunks.get(k);
    if (!c) this.chunks.set(k, (c = { sx: x >> 4, sy: y >> 4, sz: z >> 4, bits: new Uint32Array(128) }));
    const i = bitIndex(x, y, z);
    c.bits[i >>> 5]! |= 1 << (i & 31);
  }

  delete(x: number, y: number, z: number): void {
    const k = key(x >> 4, y >> 4, z >> 4);
    const c = this.chunks.get(k);
    if (!c) return;
    const i = bitIndex(x, y, z);
    c.bits[i >>> 5]! &= ~(1 << (i & 31));
  }

  count(): number {
    let n = 0;
    for (const c of this.chunks.values()) for (const w of c.bits) if (w) n += popcount(w);
    return n;
  }

  isEmpty(): boolean {
    for (const c of this.chunks.values()) for (const w of c.bits) if (w) return false;
    return true;
  }

  /** Visits positions in section order (y, z, x within each section). */
  forEach(fn: (x: number, y: number, z: number) => void): void {
    for (const c of this.chunks.values()) {
      const bx = c.sx * 16, by = c.sy * 16, bz = c.sz * 16;
      for (let w = 0; w < 128; w++) {
        let word = c.bits[w]!;
        while (word) {
          const t = word & -word;
          const i = (w << 5) | (31 - Math.clz32(t));
          fn(bx + (i & 15), by + (i >> 8), bz + ((i >> 4) & 15));
          word ^= t;
        }
      }
    }
  }

  /** Positions as a flat list, for callers that edit while iterating. */
  positions(): Vec3[] {
    const out: Vec3[] = [];
    this.forEach((x, y, z) => out.push([x, y, z]));
    return out;
  }

  /** Tight half-open bounding box, or undefined when empty. */
  bbox(): Box | undefined {
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
      if (x >= max[0]) max[0] = x + 1;
      if (y >= max[1]) max[1] = y + 1;
      if (z >= max[2]) max[2] = z + 1;
    });
    return min && max ? { min, max } : undefined;
  }

  clone(): Mask {
    const m = new Mask();
    for (const [k, c] of this.chunks) m.chunks.set(k, { ...c, bits: c.bits.slice() });
    return m;
  }

  /** In-place set operations (word-wise over aligned chunks). */
  unionWith(o: Mask): this {
    for (const [k, c] of o.chunks) {
      const mine = this.chunks.get(k);
      if (!mine) this.chunks.set(k, { ...c, bits: c.bits.slice() });
      else for (let w = 0; w < 128; w++) mine.bits[w]! |= c.bits[w]!;
    }
    return this;
  }

  intersectWith(o: Mask): this {
    for (const [k, c] of this.chunks) {
      const theirs = o.chunks.get(k);
      if (!theirs) this.chunks.delete(k);
      else for (let w = 0; w < 128; w++) c.bits[w]! &= theirs.bits[w]!;
    }
    return this;
  }

  subtract(o: Mask): this {
    for (const [k, c] of this.chunks) {
      const theirs = o.chunks.get(k);
      if (theirs) for (let w = 0; w < 128; w++) c.bits[w]! &= ~theirs.bits[w]!;
    }
    return this;
  }

  xorWith(o: Mask): this {
    for (const [k, c] of o.chunks) {
      const mine = this.chunks.get(k);
      if (!mine) this.chunks.set(k, { ...c, bits: c.bits.slice() });
      else for (let w = 0; w < 128; w++) mine.bits[w]! ^= c.bits[w]!;
    }
    return this;
  }

  translated(d: Vec3): Mask {
    const m = new Mask();
    this.forEach((x, y, z) => m.add(x + d[0], y + d[1], z + d[2]));
    return m;
  }

  /** True when the mask is exactly its bounding box (lets ops take the fast box path). */
  isBox(): Box | undefined {
    const b = this.bbox();
    return b && this.count() === boxVolume(b) ? b : undefined;
  }
}

const DIRS6: Vec3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const DIRS4: Vec3[] = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];

/**
 * Outer layers of a selection: positions within `t` face-steps of outside (6 neighbours, or the 4
 * horizontal ones for walls_only). For a box this is exactly fill's hollow/outline (walls_only:
 * its walls) shell.
 */
export function shellOf(m: Mask, t: number, wallsOnly: boolean): Mask {
  const dirs = wallsOnly ? DIRS4 : DIRS6;
  let core = m;
  for (let i = 0; i < t; i++) {
    const next = new Mask();
    core.forEach((x, y, z) => {
      if (dirs.every((d) => core.has(x + d[0], y + d[1], z + d[2]))) next.add(x, y, z);
    });
    core = next;
  }
  return m.clone().subtract(core);
}
