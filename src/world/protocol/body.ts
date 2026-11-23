import type { Compound } from "prismarine-nbt";
import type { Vec3 } from "../../core/region.js";
import { ByteReader, ByteWriter, bytesToHex, hexToBytes } from "./bytes.js";
import type { CoarseRegion, FillResult, FrontierSection, MaskSection, PatchAck, PatchBlock, RejectReason, SearchChunk, SearchResult, SnapshotRegion, SnapshotResult, SurfaceLayer, SurfaceResult, UpgradeData, WireArea, WireBox, WorldBlock } from "./messages.js";
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

export function encodeSnapshotBody(palette: readonly string[], regions: readonly SnapshotRegion[]): Uint8Array {
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
  const ords: [number, Compound][] = [];
  let base = 0;
  for (const reg of regions) {
    const g = boxGrid(reg.box);
    const local: [number, Compound][] = reg.blockEntities.map((be) => {
      if (!inBox(reg.box, be.pos)) throw new Error(`snapshot block entity at ${be.pos.join(",")} lies outside its region`);
      return [base + indexIn(g, be.pos), be.nbt];
    });
    local.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < local.length; i++) if (local[i]![0] === local[i - 1]![0]) throw new Error("snapshot region lists two block entities at one position");
    ords.push(...local);
    base += reg.states.length;
  }
  writeNbtList(w, ords);
  return w.finish();
}

export function decodeSnapshotBody(body: Uint8Array, boxes: readonly WireBox[]): Pick<SnapshotResult, "palette" | "regions"> {
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
    return { box, states, blockEntities: [] };
  });
  let reg = 0, base = 0;
  for (const [ord, nbt] of readNbtList(r, total, "snapshot")) {
    while (ord >= base + regions[reg]!.states.length) base += regions[reg++]!.states.length;
    const region = regions[reg]!;
    region.blockEntities.push({ pos: posAt(boxGrid(region.box), ord - base), nbt });
  }
  done(r, "snapshot");
  return { palette, regions };
}

// ── snapshot.result, kind surface ──────────────────────────────────────────────────────────────

/** Number of columns in an area (x fastest, then z). */
export function areaColumns(a: WireArea): number {
  const v = (a.max[0] - a.min[0] + 1) * (a.max[1] - a.min[1] + 1);
  if (!Number.isSafeInteger(v) || v <= 0) throw new Error(`bad area ${JSON.stringify(a)}`);
  return v;
}

/**
 * Surface body: the palette (first-use order over the columns, each column's surface before its
 * ceiling), then per column in index order a varint height code (0 = none, else y − minY + 1)
 * followed by the palette index when the code isn't 0; with a ceiling layer, the column's ceiling
 * value follows its surface value.
 */
export function encodeSurfaceBody(m: Pick<SurfaceResult, "columns" | "palette" | "surface" | "ceilings">): Uint8Array {
  const n = areaColumns(m.columns);
  const layers = m.ceilings ? [m.surface, m.ceilings] : [m.surface];
  for (const l of layers) if (l.heights.length !== n || l.states.length !== n) throw new Error(`surface layer holds ${l.heights.length} columns for an area of ${n}`);
  const table = new Table();
  const w = new ByteWriter(Math.max(1024, n * 3 * layers.length + 64));
  const values = new ByteWriter(Math.max(1024, n * 3 * layers.length));
  for (let i = 0; i < n; i++)
    for (const l of layers) {
      const h = l.heights[i]!;
      values.varint(h);
      if (h === 0) continue;
      values.varint(table.of(entry(m.palette, l.states[i]!, "surface state")));
    }
  writeTable(w, table.list);
  w.bytes(values.finish());
  return w.finish();
}

export function decodeSurfaceBody(body: Uint8Array, columns: WireArea, withCeiling: boolean): Pick<SurfaceResult, "palette" | "surface" | "ceilings"> {
  const r = new ByteReader(body);
  const palette = readTable(r);
  const n = areaColumns(columns);
  const layer = (): SurfaceLayer => ({ heights: new Uint32Array(n), states: new Uint32Array(n) });
  const surface = layer(), ceilings = withCeiling ? layer() : undefined;
  const layers = ceilings ? [surface, ceilings] : [surface];
  for (let i = 0; i < n; i++)
    for (const l of layers) {
      const h = r.varint();
      if (h > 0xffffffff) throw new Error(`surface: height code ${h} out of range`);
      l.heights[i] = h;
      if (h === 0) continue;
      const s = r.varint();
      if (s >= palette.length) throw new Error(`surface: state index ${s} outside the palette of ${palette.length}`);
      l.states[i] = s;
    }
  done(r, "surface");
  return { palette, surface, ...(ceilings ? { ceilings } : {}) };
}

// ── upgrade, upgrade.result (protocol 3) ───────────────────────────────────────────────────────

function writeCompounds(w: ByteWriter, list: readonly Compound[]): void {
  w.varint(list.length);
  const tmp = new ByteWriter(256);
  for (const c of list) {
    tmp.length = 0;
    writeNbt(tmp, c);
    w.varint(tmp.length);
    w.bytes(tmp.finish());
  }
}

function readCompound(r: ByteReader, what: string): Compound {
  const len = r.varint();
  if (len > r.remaining) throw new Error(`${what}: NBT of ${len} bytes can't fit`);
  const sub = new ByteReader(r.buf, r.pos, r.pos + len);
  const c = readNbt(sub);
  if (sub.remaining) throw new Error(`${what}: NBT length ${len} doesn't match its content`);
  r.pos += len;
  return c;
}

function readCompounds(r: ByteReader, what: string): Compound[] {
  const n = r.varint();
  if (n > r.remaining) throw new Error(`${what}: ${n} compounds can't fit`);
  return Array.from({ length: n }, () => readCompound(r, what));
}

/**
 * Upgrade body. Kind `elements`: the states as a string list (in the sender's order, duplicates
 * allowed), then the block-entity compounds and the entity compounds, each as a varint count and per
 * compound its varint byte length and NBT. Kind `structure`: the same compound list holding exactly
 * one compound. The result's body has the same layout, order and counts.
 */
export function encodeUpgradeBody(d: UpgradeData): Uint8Array {
  const w = new ByteWriter(1024);
  if (d.kind === "structure") writeCompounds(w, [d.structure]);
  else {
    writeTable(w, d.states);
    writeCompounds(w, d.blockEntities);
    writeCompounds(w, d.entities);
  }
  return w.finish();
}

export function decodeUpgradeBody(body: Uint8Array, kind: UpgradeData["kind"]): UpgradeData {
  const r = new ByteReader(body);
  if (kind === "structure") {
    const list = readCompounds(r, "upgrade structure");
    if (list.length !== 1) throw new Error(`upgrade structure: ${list.length} compounds, expected 1`);
    done(r, "upgrade");
    return { kind, structure: list[0]! };
  }
  const states = readTable(r);
  const blockEntities = readCompounds(r, "upgrade block entities");
  const entities = readCompounds(r, "upgrade entities");
  done(r, "upgrade");
  return { kind, states, blockEntities, entities };
}

// ── in-game UI (feature `ui`) ──────────────────────────────────────────────────────────────────

/** The box of a 16³ section (section coordinates, in whatever grid they belong to). */
export function sectionBox(s: Vec3): WireBox {
  return { min: [s[0] * 16, s[1] * 16, s[2] * 16], max: [s[0] * 16 + 15, s[1] * 16 + 15, s[2] * 16 + 15] };
}

/**
 * States-only regions (`ui.ghost` sections, `replay.frame` keyframes, `library.preview`):
 * `snapshot.result`'s layout with an always-empty NBT list. The palette comes back in first-use order.
 */
export function encodeStatesBody(palette: readonly string[], regions: readonly { box: WireBox; states: Uint32Array }[]): Uint8Array {
  return encodeSnapshotBody(
    palette,
    regions.map((r) => ({ box: r.box, states: r.states, blockEntities: [] })),
  );
}

export function decodeStatesBody(body: Uint8Array, boxes: readonly WireBox[], what: string): { palette: string[]; regions: { box: WireBox; states: Uint32Array }[] } {
  const { palette, regions } = decodeSnapshotBody(body, boxes);
  if (regions.some((r) => r.blockEntities.length)) throw new Error(`${what}: carries no NBT`);
  return { palette, regions: regions.map((r) => ({ box: r.box, states: r.states })) };
}

/** A `library.preview` result body: one region, the prefab's local box from [0, 0, 0] to `size − 1`. */
export function encodePreviewBody(palette: readonly string[], size: Vec3, states: Uint32Array): Uint8Array {
  return encodeStatesBody(palette, [{ box: { min: [0, 0, 0], max: [size[0] - 1, size[1] - 1, size[2] - 1] }, states }]);
}

export function decodePreviewBody(body: Uint8Array, size: Vec3): { palette: string[]; states: Uint32Array } {
  const { palette, regions } = decodeStatesBody(body, [{ min: [0, 0, 0], max: [size[0] - 1, size[1] - 1, size[2] - 1] }], "library.preview");
  return { palette, states: regions[0]!.states };
}

// ── select (`18`; feature `select`) ────────────────────────────────────────────────────────────

/** The chunk grid of a search answer: the square of `radius` chunks around `centre`, as a flat grid (x fastest, then z). */
export function searchGrid(centre: [number, number], radius: number): Grid {
  return { origin: [centre[0] - radius, 0, centre[1] - radius], size: [2 * radius + 1, 1, 2 * radius + 1] };
}

const chunkItems = (list: readonly [number, number][]) => list.map((c) => ({ pos: [c[0], 0, c[1]] as Vec3 }));

function writeChunkList(w: ByteWriter, g: Grid, list: readonly [number, number][], what: string): void {
  const { idx, perm } = sortedIndices(g, chunkItems(list), what);
  for (let i = 0; i < perm.length; i++) if (perm[i] !== i) throw new Error(`${what}: chunks must be ascending by cz, then cx`);
  writeGaps(w, idx, perm);
}

function readChunkList(r: ByteReader, g: Grid, n: number, what: string): [number, number][] {
  const idx = readGaps(r, n, gridVolume(g), what);
  return Array.from(idx, (i) => {
    const p = posAt(g, i);
    return [p[0], p[2]] as [number, number];
  });
}

/**
 * `search.result` body: positions(C) of the matching chunks over the search grid; per chunk, in that
 * order, M varint counts (one per material), its varint cluster index, a varint section count S and S
 * section offsets (sy − minSection) gap-coded ascending; then positions(U) of the missing chunks.
 */
export function encodeSearchBody(m: Pick<SearchResult, "centre" | "radius" | "materials" | "minSection" | "clusters" | "chunks" | "missing">): Uint8Array {
  const g = searchGrid(m.centre, m.radius);
  const w = new ByteWriter(Math.max(1024, m.chunks.length * (m.materials.length + 6) + m.missing.length * 2));
  writeChunkList(w, g, m.chunks.map((c) => c.chunk), "search chunks");
  for (const c of m.chunks) {
    if (c.counts.length !== m.materials.length) throw new Error(`search chunk ${c.chunk.join(",")}: ${c.counts.length} counts for ${m.materials.length} materials`);
    for (const n of c.counts) w.varint(n);
    if (c.cluster >= m.clusters.length) throw new Error(`search chunk ${c.chunk.join(",")}: cluster ${c.cluster} of ${m.clusters.length}`);
    w.varint(c.cluster);
    w.varint(c.sections.length);
    let prev = -1;
    for (const sy of c.sections) {
      const off = sy - m.minSection;
      if (off <= prev) throw new Error(`search chunk ${c.chunk.join(",")}: sections must be unique, ascending and at or above minSection`);
      w.varint(off - prev - 1);
      prev = off;
    }
  }
  writeChunkList(w, g, m.missing, "search missing");
  return w.finish();
}

export function decodeSearchBody(body: Uint8Array, h: { centre: [number, number]; radius: number; materials: number; minSection: number; clusters: number; chunks: number; missing: number }): Pick<SearchResult, "chunks" | "missing"> {
  const r = new ByteReader(body);
  const g = searchGrid(h.centre, h.radius);
  const where = readChunkList(r, g, h.chunks, "search chunks");
  const chunks: SearchChunk[] = where.map((chunk) => {
    const counts = Array.from({ length: h.materials }, () => r.varint());
    const cluster = r.varint();
    if (cluster >= h.clusters) throw new Error(`search: cluster ${cluster} outside ${h.clusters} clusters`);
    const s = r.varint();
    if (s > r.remaining) throw new Error(`search: ${s} sections can't fit`);
    const sections: number[] = [];
    let prev = -1;
    for (let i = 0; i < s; i++) {
      prev = prev + r.varint() + 1;
      sections.push(h.minSection + prev);
    }
    return { chunk, counts, cluster, sections };
  });
  const missing = readChunkList(r, g, h.missing, "search missing");
  done(r, "search");
  return { chunks, missing };
}

/** Bytes in one section's bitset. */
export const MASK_BYTES = 512;

/** Tight section grid over the sections and frontier sections of a fill result (all zero when both are empty). */
export function fillGrid(m: Pick<FillResult, "sections" | "frontier">): Grid {
  return gridOf(
    m.sections.map((s) => ({ pos: s.section })),
    m.frontier.map((s) => ({ pos: s.section })),
  );
}

function checkAscending(items: readonly { section: Vec3 }[], g: Grid, what: string): { idx: Float64Array; perm: Uint32Array } {
  const sorted = sortedIndices(g, items.map((s) => ({ pos: s.section })), what);
  for (let i = 0; i < sorted.perm.length; i++) if (sorted.perm[i] !== i) throw new Error(`${what}: sections must be ascending by sy, then sz, then sx`);
  return sorted;
}

/**
 * `fill.result` body over the header's section grid: positions(S) of the shape's sections, then per
 * section a varint kind (0: every position; 1: a 512-byte bitset follows, neither empty nor full);
 * then positions(F) of the frontier sections, and per frontier section a varint count n, n local
 * indices gap-coded ascending and n face-mask bytes.
 */
export function encodeFillBody(m: Pick<FillResult, "sections" | "frontier">): Encoded {
  const g = fillGrid(m);
  const w = new ByteWriter(1024 + m.sections.length * (MASK_BYTES + 4));
  const s = checkAscending(m.sections, g, "fill sections");
  writeGaps(w, s.idx, s.perm);
  for (const sec of m.sections) {
    if (sec.mask === "full") {
      w.varint(0);
      continue;
    }
    if (sec.mask.length !== MASK_BYTES) throw new Error(`fill section ${sec.section.join(",")}: a mask is ${MASK_BYTES} bytes, got ${sec.mask.length}`);
    const ones = sec.mask.every((b) => b === 0xff), zeros = sec.mask.every((b) => b === 0);
    if (ones || zeros) throw new Error(`fill section ${sec.section.join(",")}: a ${ones ? "full mask is sent as full" : "section with no positions isn't listed"}`);
    w.varint(1);
    w.bytes(sec.mask);
  }
  const f = checkAscending(m.frontier, g, "fill frontier");
  writeGaps(w, f.idx, f.perm);
  for (const sec of m.frontier) {
    if (!sec.index.length || sec.index.length !== sec.faces.length) throw new Error(`frontier section ${sec.section.join(",")}: needs as many faces as positions, at least one`);
    w.varint(sec.index.length);
    let prev = -1;
    for (const i of sec.index) {
      if (!Number.isInteger(i) || i <= prev || i > 4095) throw new Error(`frontier section ${sec.section.join(",")}: indices must be unique, ascending, 0 to 4095`);
      w.varint(i - prev - 1);
      prev = i;
    }
    for (const fc of sec.faces) {
      if (!Number.isInteger(fc) || fc < 1 || fc > 63) throw new Error(`frontier section ${sec.section.join(",")}: a face mask is 1 to 63`);
      w.u8(fc);
    }
  }
  return { grid: g, body: w.finish() };
}

export function decodeFillBody(body: Uint8Array, g: Grid, counts: { sections: number; frontier: number }): Pick<FillResult, "sections" | "frontier"> {
  const r = new ByteReader(body);
  const vol = gridVolume(g);
  const sections: MaskSection[] = Array.from(readGaps(r, counts.sections, vol, "fill sections"), (i) => {
    const section = posAt(g, i);
    const kind = r.varint();
    if (kind === 0) return { section, mask: "full" as const };
    if (kind !== 1) throw new Error(`fill section ${section.join(",")}: kind ${kind} is neither 0 (full) nor 1 (bitset)`);
    const mask = r.bytes(MASK_BYTES).slice();
    if (mask.every((b) => b === 0xff) || mask.every((b) => b === 0)) throw new Error(`fill section ${section.join(",")}: a bitset is neither empty nor full`);
    return { section, mask };
  });
  const frontier: FrontierSection[] = Array.from(readGaps(r, counts.frontier, vol, "fill frontier"), (i) => {
    const section = posAt(g, i);
    const n = r.varint();
    if (n < 1 || n > 4096) throw new Error(`frontier section ${section.join(",")}: ${n} positions`);
    const index = Array.from(readGaps(r, n, 4096, "frontier positions"));
    const faces = Array.from({ length: n }, () => {
      const fc = r.u8();
      if (fc < 1 || fc > 63) throw new Error(`frontier section ${section.join(",")}: face mask ${fc} is not 1 to 63`);
      return fc;
    });
    return { section, index, faces };
  });
  done(r, "fill");
  return { sections, frontier };
}

/** A box grown outward to whole cells of the world grid. */
export function alignBox(b: WireBox, cell: number): WireBox {
  const lo = (v: number) => Math.floor(v / cell) * cell;
  return { min: [lo(b.min[0]), lo(b.min[1]), lo(b.min[2])], max: [lo(b.max[0]) + cell - 1, lo(b.max[1]) + cell - 1, lo(b.max[2]) + cell - 1] };
}

/** The cell-grid box of an aligned world box (cell coordinates = world coordinates / cell). */
function cellBox(b: WireBox, cell: number): WireBox {
  for (let a = 0; a < 3; a++)
    if (b.min[a]! % cell !== 0 || (b.max[a]! + 1) % cell !== 0) throw new Error(`coarse region ${JSON.stringify(b)} isn't aligned to cells of ${cell}`);
  return { min: [b.min[0] / cell, b.min[1] / cell, b.min[2] / cell], max: [(b.max[0] + 1) / cell - 1, (b.max[1] + 1) / cell - 1, (b.max[2] + 1) / cell - 1] };
}

/** Coarse body: `snapshot.result`'s layout over each region's cell grid, nbtList empty. */
export function encodeCoarseBody(palette: readonly string[], regions: readonly CoarseRegion[], cell: number): Uint8Array {
  return encodeStatesBody(
    palette,
    regions.map((r) => ({ box: cellBox(r.box, cell), states: r.states })),
  );
}

export function decodeCoarseBody(body: Uint8Array, boxes: readonly WireBox[], cell: number): { palette: string[]; regions: CoarseRegion[] } {
  const { palette, regions } = decodeStatesBody(
    body,
    boxes.map((b) => cellBox(b, cell)),
    "coarse snapshot",
  );
  return { palette, regions: regions.map((r, i) => ({ box: boxes[i]!, states: r.states })) };
}

/**
 * The regions a `snapshot` kind `mask` is answered with (`13`, *Message schemas*): each listed
 * section's 16³ box in request order, then, ascending by sy, sz, sx, for each unlisted section within
 * `margin` of a listed one, the bounding box of its positions within `margin` (Chebyshev) of the
 * listed sections' boxes. With margin 0, the listed sections only.
 */
export function maskRegions(sections: readonly Vec3[], margin: number): WireBox[] {
  const listed = new Set(sections.map((s) => s.join(",")));
  const out = sections.map(sectionBox);
  if (margin <= 0) return out;
  const extra = new Map<string, WireBox>();
  for (const s of sections) {
    const grown: WireBox = { min: [s[0] * 16 - margin, s[1] * 16 - margin, s[2] * 16 - margin], max: [s[0] * 16 + 15 + margin, s[1] * 16 + 15 + margin, s[2] * 16 + 15 + margin] };
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          const n: Vec3 = [s[0] + dx, s[1] + dy, s[2] + dz];
          const k = n.join(",");
          if (listed.has(k)) continue;
          const nb = sectionBox(n);
          const part: WireBox = {
            min: [Math.max(nb.min[0], grown.min[0]), Math.max(nb.min[1], grown.min[1]), Math.max(nb.min[2], grown.min[2])],
            max: [Math.min(nb.max[0], grown.max[0]), Math.min(nb.max[1], grown.max[1]), Math.min(nb.max[2], grown.max[2])],
          };
          const prev = extra.get(k);
          extra.set(
            k,
            prev
              ? { min: [Math.min(prev.min[0], part.min[0]), Math.min(prev.min[1], part.min[1]), Math.min(prev.min[2], part.min[2])], max: [Math.max(prev.max[0], part.max[0]), Math.max(prev.max[1], part.max[1]), Math.max(prev.max[2], part.max[2])] }
              : part,
          );
        }
  }
  const order = [...extra.keys()].map((k) => k.split(",").map(Number) as Vec3).sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[0] - b[0]);
  return [...out, ...order.map((n) => extra.get(n.join(","))!)];
}
