import type { Compound } from "prismarine-nbt";
import type { Vec3 } from "../../core/region.js";
import { ByteReader, ByteWriter, bytesToHex, hexToBytes } from "./bytes.js";
import type { PatchAck, PatchBlock, RejectReason, SnapshotRegion, SnapshotResult, WireBox, WorldBlock } from "./messages.js";
import { REJECT_REASONS } from "./messages.js";
import { readNbt, writeNbt } from "./nbt.js";

/**
 * Binary bodies (docs/design/13-live-world.md, *Wire format*, *Binary bodies*). Positions are
 * linear indices into the grid given by the header's `origin` and `size` (x fastest, then z, then
 * y), listed in ascending order as gaps (index − previous index − 1, previous starting at −1).
 * Palettes are string tables in first-use order. NBT lists and hash lists address entries by
 * ordinal, gap-coded the same way.
 */

export interface Grid {
  origin: Vec3;
  size: Vec3;
}

const EMPTY_GRID: Grid = { origin: [0, 0, 0], size: [0, 0, 0] };

/** Tight bounding grid of every position listed (all zero when there are none). */
export function gridOf(...lists: Iterable<{ pos: Vec3 }>[]): Grid {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const list of lists)
    for (const { pos } of list) {
      const [x, y, z] = pos;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
  if (minX === Infinity) return EMPTY_GRID;
  return { origin: [minX, minY, minZ], size: [maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1] };
}

export function gridVolume(g: Grid): number {
  const v = g.size[0] * g.size[1] * g.size[2];
  if (!Number.isSafeInteger(v)) throw new Error(`grid ${g.size.join("×")} is too large`);
  return v;
}

function indexIn(g: Grid, p: Vec3): number {
  const dx = p[0] - g.origin[0], dy = p[1] - g.origin[1], dz = p[2] - g.origin[2];
  if (dx < 0 || dy < 0 || dz < 0 || dx >= g.size[0] || dy >= g.size[1] || dz >= g.size[2]) throw new Error(`position ${p.join(",")} outside the message grid`);
  return dx + g.size[0] * (dz + g.size[2] * dy);
}

function posAt(g: Grid, idx: number): Vec3 {
  const sx = g.size[0], sz = g.size[2];
  const dx = idx % sx;
  const t = (idx - dx) / sx;
  const dz = t % sz;
  return [g.origin[0] + dx, g.origin[1] + (t - dz) / sz, g.origin[2] + dz];
}

/** Ascending order of `keys` as a permutation; throws on a duplicate. */
function ascending(keys: Float64Array, what: string): Uint32Array {
  const n = keys.length;
  const perm = new Uint32Array(n);
  let sorted = true;
  for (let i = 1; i < n; i++) if (keys[i]! <= keys[i - 1]!) sorted = false;
  if (sorted) {
    for (let i = 0; i < n; i++) perm[i] = i;
    return perm;
  }
  let max = 0;
  for (let i = 0; i < n; i++) if (keys[i]! > max) max = keys[i]!;
  if ((max + 1) * n < Number.MAX_SAFE_INTEGER) {
    const packed = new Float64Array(n);
    for (let i = 0; i < n; i++) packed[i] = keys[i]! * n + i;
    packed.sort();
    for (let i = 0; i < n; i++) perm[i] = packed[i]! % n;
  } else {
    const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => keys[a]! - keys[b]!);
    perm.set(idx);
  }
  for (let i = 1; i < n; i++) if (keys[perm[i]!] === keys[perm[i - 1]!]) throw new Error(`${what} lists the same position twice`);
  return perm;
}

function sortedIndices(g: Grid, items: readonly { pos: Vec3 }[], what: string): { idx: Float64Array; perm: Uint32Array } {
  const idx = new Float64Array(items.length);
  for (let i = 0; i < items.length; i++) idx[i] = indexIn(g, items[i]!.pos);
  return { idx, perm: ascending(idx, what) };
}

function writeGaps(w: ByteWriter, idx: Float64Array, perm: Uint32Array): void {
  let prev = -1;
  for (let i = 0; i < perm.length; i++) {
    const v = idx[perm[i]!]!;
    w.varint(v - prev - 1);
    prev = v;
  }
}

function readGaps(r: ByteReader, n: number, limit: number, what: string): Float64Array {
  const out = new Float64Array(n);
  let prev = -1;
  for (let i = 0; i < n; i++) {
    prev = prev + r.varint() + 1;
    if (prev >= limit) throw new Error(`${what}: index ${prev} beyond ${limit}`);
    out[i] = prev;
  }
  return out;
}

class Table {
  readonly list: string[] = [];
  private readonly map = new Map<string, number>();
  of(s: string): number {
    let i = this.map.get(s);
    if (i === undefined) {
      i = this.list.length;
      this.list.push(s);
      this.map.set(s, i);
    }
    return i;
  }
}

function writeTable(w: ByteWriter, list: readonly string[]): void {
  w.varint(list.length);
  for (const s of list) w.str(s);
}

function readTable(r: ByteReader): string[] {
  const n = r.varint();
  if (n > r.remaining) throw new Error(`string table of ${n} entries can't fit`);
  return Array.from({ length: n }, () => r.str());
}

function entry<T>(list: readonly T[], i: number, what: string): T {
  const v = list[i];
  if (v === undefined) throw new Error(`${what}: index ${i} outside its table of ${list.length}`);
  return v;
}

/** NBT list: count, then per entry (ordinal gap, byte length, NBT). `nbts` sorted by ordinal. */
function writeNbtList(w: ByteWriter, nbts: [number, Compound][]): void {
  w.varint(nbts.length);
  let prev = -1;
  const tmp = new ByteWriter(256);
  for (const [ord, c] of nbts) {
    w.varint(ord - prev - 1);
    prev = ord;
    tmp.length = 0;
    writeNbt(tmp, c);
    w.varint(tmp.length);
    w.bytes(tmp.finish());
  }
}

function readNbtList(r: ByteReader, limit: number, what: string): [number, Compound][] {
  const n = r.varint();
  const out: [number, Compound][] = [];
  let prev = -1;
  for (let i = 0; i < n; i++) {
    prev = prev + r.varint() + 1;
    if (prev >= limit) throw new Error(`${what}: NBT for entry ${prev} of ${limit}`);
    const len = r.varint();
    if (len > r.remaining) throw new Error(`${what}: NBT of ${len} bytes can't fit`);
    const sub = new ByteReader(r.buf, r.pos, r.pos + len);
    const c = readNbt(sub);
    if (sub.remaining) throw new Error(`${what}: NBT length ${len} doesn't match its content`);
    r.pos += len;
    out.push([prev, c]);
  }
  return out;
}

function done(r: ByteReader, what: string): void {
  if (r.remaining) throw new Error(`${what}: ${r.remaining} trailing bytes`);
}

// ── patch ──────────────────────────────────────────────────────────────────────────────────────

export interface Encoded {
  grid: Grid;
  body: Uint8Array;
}

export function encodePatchBody(blocks: readonly PatchBlock[]): Encoded {
  const grid = gridOf(blocks);
  const { idx, perm } = sortedIndices(grid, blocks, "patch");
  const n = blocks.length;
  const pal = new Table();
  const expected = new Uint32Array(n);
  const next = new Uint32Array(n);
  const hashes: [number, string][] = [];
  const nbts: [number, Compound][] = [];
  for (let i = 0; i < n; i++) {
    const b = blocks[perm[i]!]!;
    expected[i] = pal.of(b.expected);
    next[i] = pal.of(b.state);
    if (b.expectedNbtHash !== undefined) hashes.push([i, b.expectedNbtHash]);
    if (b.nbt) nbts.push([i, b.nbt]);
  }
  const w = new ByteWriter(Math.max(1024, n * 4));
  writeTable(w, pal.list);
  w.varint(n);
  writeGaps(w, idx, perm);
  for (let i = 0; i < n; i++) w.varint(expected[i]!);
  for (let i = 0; i < n; i++) w.varint(next[i]!);
  w.varint(hashes.length);
  let prev = -1;
  for (const [ord, h] of hashes) {
    w.varint(ord - prev - 1);
    prev = ord;
    const hb = hexToBytes(h);
    if (hb.length !== 8) throw new Error(`expected NBT hash "${h}" must be 16 hex digits`);
    w.bytes(hb);
  }
  writeNbtList(w, nbts);
  return { grid, body: w.finish() };
}

export function decodePatchBody(body: Uint8Array, grid: Grid, count: number): PatchBlock[] {
  const r = new ByteReader(body);
  const pal = readTable(r);
  const n = r.varint();
  if (n !== count) throw new Error(`patch: header count ${count}, body lists ${n}`);
  const idx = readGaps(r, n, gridVolume(grid), "patch");
  const blocks: PatchBlock[] = new Array(n);
  for (let i = 0; i < n; i++) blocks[i] = { pos: posAt(grid, idx[i]!), expected: entry(pal, r.varint(), "patch expected"), state: "" };
  for (let i = 0; i < n; i++) blocks[i]!.state = entry(pal, r.varint(), "patch state");
  const h = r.varint();
  let prev = -1;
  for (let i = 0; i < h; i++) {
    prev = prev + r.varint() + 1;
    if (prev >= n) throw new Error(`patch: NBT hash for entry ${prev} of ${n}`);
    blocks[prev]!.expectedNbtHash = bytesToHex(r.bytes(8));
  }
  for (const [ord, c] of readNbtList(r, n, "patch")) blocks[ord]!.nbt = c;
  done(r, "patch");
  return blocks;
}

// ── block lists (dirty, ack skipped) ───────────────────────────────────────────────────────────

function writeBlockList(w: ByteWriter, grid: Grid, blocks: readonly WorldBlock[], what: string): void {
  const { idx, perm } = sortedIndices(grid, blocks, what);
  const pal = new Table();
  const states = new Uint32Array(blocks.length);
  const nbts: [number, Compound][] = [];
  for (let i = 0; i < perm.length; i++) {
    const b = blocks[perm[i]!]!;
    states[i] = pal.of(b.state);
    if (b.nbt) nbts.push([i, b.nbt]);
  }
  writeTable(w, pal.list);
  w.varint(blocks.length);
  writeGaps(w, idx, perm);
  for (const s of states) w.varint(s);
  writeNbtList(w, nbts);
}

function readBlockList(r: ByteReader, grid: Grid, count: number, what: string): WorldBlock[] {
  const pal = readTable(r);
  const n = r.varint();
  if (n !== count) throw new Error(`${what}: header count ${count}, body lists ${n}`);
  const idx = readGaps(r, n, gridVolume(grid), what);
  const out: WorldBlock[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = { pos: posAt(grid, idx[i]!), state: entry(pal, r.varint(), what) };
  for (const [ord, c] of readNbtList(r, n, what)) out[ord]!.nbt = c;
  return out;
}

export function encodeDirtyBody(blocks: readonly WorldBlock[]): Encoded {
  const grid = gridOf(blocks);
  const w = new ByteWriter();
  writeBlockList(w, grid, blocks, "dirty");
  return { grid, body: w.finish() };
}

export function decodeDirtyBody(body: Uint8Array, grid: Grid, count: number): WorldBlock[] {
  const r = new ByteReader(body);
  const out = readBlockList(r, grid, count, "dirty");
  done(r, "dirty");
  return out;
}

// ── patch.ack ──────────────────────────────────────────────────────────────────────────────────

export function encodeAckBody(ack: Pick<PatchAck, "skipped" | "rejected" | "normalized">): Encoded {
  const grid = gridOf(ack.skipped, ack.rejected, ack.normalized);
  const w = new ByteWriter();
  writeBlockList(w, grid, ack.skipped, "ack skipped");
  const rej = sortedIndices(grid, ack.rejected, "ack rejected");
  const reasons = new Table();
  const codes = Array.from(rej.perm, (i) => reasons.of(ack.rejected[i]!.reason));
  writeTable(w, reasons.list);
  w.varint(ack.rejected.length);
  writeGaps(w, rej.idx, rej.perm);
  for (const c of codes) w.varint(c);
  const norm = sortedIndices(grid, ack.normalized, "ack normalized");
  w.varint(ack.normalized.length);
  writeGaps(w, norm.idx, norm.perm);
  const nbts: [number, Compound][] = [];
  norm.perm.forEach((i, ord) => {
    const c = ack.normalized[i]!.nbt;
    if (c) nbts.push([ord, c]);
  });
  writeNbtList(w, nbts);
  return { grid, body: w.finish() };
}

export function decodeAckBody(body: Uint8Array, grid: Grid, counts: { skipped: number; rejected: number; normalized: number }): Pick<PatchAck, "skipped" | "rejected" | "normalized"> {
  const r = new ByteReader(body);
  const volume = gridVolume(grid);
  const skipped = readBlockList(r, grid, counts.skipped, "ack skipped");
  const reasons = readTable(r);
  for (const s of reasons) if (!(REJECT_REASONS as readonly string[]).includes(s)) throw new Error(`ack: unknown reject reason "${s}"`);
  const nr = r.varint();
  if (nr !== counts.rejected) throw new Error(`ack: header rejected ${counts.rejected}, body lists ${nr}`);
  const ridx = readGaps(r, nr, volume, "ack rejected");
  const rejected = Array.from(ridx, (i) => ({ pos: posAt(grid, i), reason: entry(reasons, r.varint(), "ack reason") as RejectReason }));
  const nn = r.varint();
  if (nn !== counts.normalized) throw new Error(`ack: header normalized ${counts.normalized}, body lists ${nn}`);
  const nidx = readGaps(r, nn, volume, "ack normalized");
  const normalized: PatchAck["normalized"] = Array.from(nidx, (i) => ({ pos: posAt(grid, i) }));
  for (const [ord, c] of readNbtList(r, nn, "ack normalized")) normalized[ord]!.nbt = c;
  done(r, "ack");
  return { skipped, rejected, normalized };
}

// ── snapshot.result ────────────────────────────────────────────────────────────────────────────

export function boxVolume(b: WireBox): number {
  const v = (b.max[0] - b.min[0] + 1) * (b.max[1] - b.min[1] + 1) * (b.max[2] - b.min[2] + 1);
  if (!Number.isSafeInteger(v) || v <= 0) throw new Error(`bad box ${JSON.stringify(b)}`);
  return v;
}

function boxGrid(b: WireBox): Grid {
  return { origin: b.min, size: [b.max[0] - b.min[0] + 1, b.max[1] - b.min[1] + 1, b.max[2] - b.min[2] + 1] };
}

function inBox(b: WireBox, p: Vec3): boolean {
  return p[0] >= b.min[0] && p[0] <= b.max[0] && p[1] >= b.min[1] && p[1] <= b.max[1] && p[2] >= b.min[2] && p[2] <= b.max[2];
}

export function encodeSnapshotBody(palette: readonly string[], regions: readonly SnapshotRegion[], blockEntities: readonly { pos: Vec3; nbt: Compound }[]): Uint8Array {
  const remap = new Int32Array(palette.length).fill(-1);
  const used: string[] = [];
  let total = 0;
  for (const reg of regions) {
    const vol = boxVolume(reg.box);
    if (reg.states.length !== vol) throw new Error(`snapshot region holds ${reg.states.length} states for a box of ${vol}`);
    total += vol;
    for (const s of reg.states) {
      if (s >= palette.length) throw new Error(`snapshot state index ${s} outside the palette`);
      if (remap[s] === -1) {
        remap[s] = used.length;
        used.push(palette[s]!);
      }
    }
  }
  const w = new ByteWriter(Math.max(1024, total + 64));
  writeTable(w, used);
  for (const reg of regions) for (const s of reg.states) w.varint(remap[s]!);
  const ords: [number, Compound][] = blockEntities.map((be) => {
    let base = 0;
    for (const reg of regions) {
      if (inBox(reg.box, be.pos)) return [base + indexIn(boxGrid(reg.box), be.pos), be.nbt];
      base += boxVolume(reg.box);
    }
    throw new Error(`snapshot block entity at ${be.pos.join(",")} lies in no region`);
  });
  ords.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ords.length; i++) if (ords[i]![0] === ords[i - 1]![0]) throw new Error("snapshot lists two block entities at one position");
  writeNbtList(w, ords);
  return w.finish();
}

export function decodeSnapshotBody(body: Uint8Array, boxes: readonly WireBox[]): Pick<SnapshotResult, "palette" | "regions" | "blockEntities"> {
  const r = new ByteReader(body);
  const palette = readTable(r);
  let total = 0;
  const regions: SnapshotRegion[] = boxes.map((box) => {
    const vol = boxVolume(box);
    total += vol;
    const states = new Uint32Array(vol);
    for (let i = 0; i < vol; i++) {
      const s = r.varint();
      if (s >= palette.length) throw new Error(`snapshot: state index ${s} outside the palette of ${palette.length}`);
      states[i] = s;
    }
    return { box, states };
  });
  const blockEntities = readNbtList(r, total, "snapshot").map(([ord, nbt]) => {
    let base = 0;
    for (const reg of regions) {
      const vol = reg.states.length;
      if (ord < base + vol) return { pos: posAt(boxGrid(reg.box), ord - base), nbt };
      base += vol;
    }
    throw new Error("unreachable");
  });
  done(r, "snapshot");
  return { palette, regions, blockEntities };
}
