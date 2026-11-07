import type { Compound, NBT } from "prismarine-nbt";
import { AIR, parseState } from "../core/blockstate.js";
import type { Box, Vec3 } from "../core/region.js";
import { compound, compounds, num, numbers, readNbt, T, text, without, withKeys, writeGzipNbt } from "./nbt.js";
import type { Decoded, DecodeOptions } from "./sponge.js";
import { blockIndex, importState, MAX_SNAPSHOT_VOLUME, stateFromNameProps, type Snapshot } from "./snapshot.js";

/**
 * Litematica `.litematic` (docs/design/08-formats.md). gzip NBT:
 *
 *   { MinecraftDataVersion, Version, SubVersion,
 *     Metadata { Name, Author, Description, RegionCount, TotalBlocks, TotalVolume,
 *                TimeCreated, TimeModified, EnclosingSize {x,y,z} },
 *     Regions { <name>: { Position {x,y,z}, Size {x,y,z} (a negative size extends the other way),
 *                         BlockStatePalette [{Name, Properties}], BlockStates (long[]),
 *                         TileEntities [{x,y,z,…}], Entities [{Pos,…}],
 *                         PendingBlockTicks [], PendingFluidTicks [] } } }
 *
 * BlockStates is a tightly packed bit array: max(2, ceil(log2(palette))) bits per entry, entries
 * may straddle two longs, low bits first, index order x, then z, then y. Palette index 0 is air.
 * Block entity x/y/z and entity Pos are relative to the region's minimum corner.
 *
 * Reading merges every region into one snapshot over their enclosing box (later regions win where
 * they overlap) and reports each region's box, so the importer can register it as a component.
 * Writing produces one region named after the build.
 */

/** Litematica's schematic version for 1.20.5+ (data components). Not verified in game. */
export const LITEMATIC_VERSION = 7;
export const LITEMATIC_SUBVERSION = 1;

export function encodeLitematic(s: Snapshot, opts: { author?: string; description?: string; date?: number } = {}): Buffer {
  const [w, h, l] = s.size;
  const volume = w * h * l;
  const bits = bitsFor(s.palette.length);
  let total = 0;
  for (const i of s.blocks) if (i !== 0) total++;
  const date = opts.date ?? Date.now();
  const vec = (v: readonly number[]) => T.compound({ x: T.int(v[0]!), y: T.int(v[1]!), z: T.int(v[2]!) });

  const region = T.compound({
    Position: vec([0, 0, 0]),
    Size: vec(s.size),
    BlockStatePalette: T.compoundList(s.palette.map(nameProps)),
    BlockStates: { type: "longArray", value: packTight(s.blocks, bits, volume) },
    TileEntities: T.compoundList(s.blockEntities.map((b) => withKeys(without(b.nbt, "x", "y", "z"), { x: T.int(b.pos[0]), y: T.int(b.pos[1]), z: T.int(b.pos[2]) }))),
    Entities: T.compoundList(s.entities.map((e) => withKeys(e.nbt, { Pos: T.doubleList([...e.pos]) }))),
    PendingBlockTicks: T.compoundList([]),
    PendingFluidTicks: T.compoundList([]),
  });
  const root: NBT = {
    type: "compound",
    name: "",
    value: {
      MinecraftDataVersion: T.int(s.dataVersion),
      Version: T.int(LITEMATIC_VERSION),
      SubVersion: T.int(LITEMATIC_SUBVERSION),
      Metadata: T.compound({
        Name: T.str(s.name),
        Author: T.str(opts.author ?? s.author ?? ""),
        Description: T.str(opts.description ?? ""),
        RegionCount: T.int(1),
        TotalBlocks: T.int(total),
        TotalVolume: T.int(volume),
        TimeCreated: T.long(date),
        TimeModified: T.long(date),
        EnclosingSize: vec(s.size),
      }),
      Regions: T.compound({ [regionName(s.name)]: region }),
    },
  };
  return writeGzipNbt(root);
}

export interface LitematicRegion {
  name: string;
  /** Half-open box in snapshot coordinates. */
  box: Box;
}

export function decodeLitematic(buf: Buffer, opts: DecodeOptions = {}): Decoded & { regions: LitematicRegion[] } {
  const v = readNbt(buf).value;
  const regionsTag = compound(v.Regions)?.value;
  if (!regionsTag) throw new Error("not a Litematica schematic (no Regions)");
  const version = num(v.Version) ?? 0;
  const warnings = new Set<string>();
  if (version > LITEMATIC_VERSION) warnings.add(`Litematica schematic version ${version} is newer than the ${LITEMATIC_VERSION} this build knows; read it as ${LITEMATIC_VERSION}`);

  // Each region's minimum corner and size, from Position plus a possibly negative Size.
  type R = { name: string; min: Vec3; size: Vec3; tag: Compound["value"] };
  const regions: R[] = [];
  for (const [name, t] of Object.entries(regionsTag)) {
    const r = compound(t)?.value;
    if (!r) continue;
    const pos = xyz(r.Position), sz = xyz(r.Size);
    const min: Vec3 = [0, 1, 2].map((a) => pos[a]! + (sz[a]! < 0 ? sz[a]! + 1 : 0)) as Vec3;
    const size: Vec3 = sz.map(Math.abs) as Vec3;
    if (size.some((n) => n === 0)) continue;
    regions.push({ name, min, size, tag: r });
  }
  if (!regions.length) throw new Error("Litematica schematic has no non-empty region");

  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const r of regions)
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a]!, r.min[a]!);
      hi[a] = Math.max(hi[a]!, r.min[a]! + r.size[a]!);
    }
  const size: Vec3 = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  const volume = size[0] * size[1] * size[2];
  if (volume > MAX_SNAPSHOT_VOLUME) throw new Error(`litematic volume ${volume} is over the ${MAX_SNAPSHOT_VOLUME} limit`);
  if (regions.length > 1) warnings.add(`${regions.length} regions merged into one document; each region is registered as a component`);

  const palette = [AIR];
  const byState = new Map([[AIR, 0]]);
  const blocks = new Uint16Array(volume);
  const written = regions.length > 1 ? new Uint8Array(volume) : undefined;
  let overlap = false;
  const snap = { size };
  const blockEntities: Snapshot["blockEntities"] = [];
  const entities: Snapshot["entities"] = [];
  const out: LitematicRegion[] = [];

  for (const r of regions) {
    const off: Vec3 = [r.min[0] - lo[0], r.min[1] - lo[1], r.min[2] - lo[2]];
    out.push({ name: r.name, box: { min: off, max: [off[0] + r.size[0], off[1] + r.size[1], off[2] + r.size[2]] } });
    const pal = compounds(r.tag.BlockPalette ?? r.tag.BlockStatePalette).map((c) => {
      const st = importState(stateFromNameProps(c), opts.registry, warnings);
      let p = byState.get(st);
      if (p === undefined) {
        p = palette.length;
        palette.push(st);
        byState.set(st, p);
      }
      return p;
    });
    if (!pal.length) pal.push(0);
    const n = r.size[0] * r.size[1] * r.size[2];
    const data = r.tag.BlockStates?.type === "longArray" ? (r.tag.BlockStates.value as [number, number][]) : [];
    const idx = unpackTight(data, bitsFor(pal.length), n);
    const [rw, , rl] = r.size;
    for (let i = 0; i < n; i++) {
      const li = idx[i]!;
      const p = pal[li];
      if (p === undefined) throw new Error(`corrupt litematic: region "${r.name}" uses palette index ${li} past its ${pal.length}-entry palette`);
      const x = i % rw, z = Math.floor(i / rw) % rl, y = Math.floor(i / (rw * rl));
      const j = blockIndex(snap, x + off[0], y + off[1], z + off[2]);
      if (written) {
        if (written[j] && p !== 0) overlap = true;
        if (p === 0 && written[j]) continue; // air in a later region doesn't erase an earlier region's block
        if (p !== 0) written[j] = 1;
      }
      blocks[j] = p;
    }
    for (const be of compounds(r.tag.TileEntities)) {
      const x = num(be.value.x), y = num(be.value.y), z = num(be.value.z);
      if (x === undefined || y === undefined || z === undefined) continue;
      blockEntities.push({ pos: [x + off[0], y + off[1], z + off[2]], nbt: without(be, "x", "y", "z") });
    }
    for (const e of compounds(r.tag.Entities)) {
      const p = numbers(e.value.Pos);
      if (p.length !== 3) continue;
      entities.push({ pos: [p[0]! + off[0], p[1]! + off[1], p[2]! + off[2]], nbt: without(e, "Pos") });
    }
  }
  if (overlap) warnings.add("regions overlap; where both have a block, the later region's is kept");

  const meta = compound(v.Metadata)?.value ?? {};
  const author = text(meta.Author);
  return {
    version,
    warnings: [...warnings],
    regions: out,
    snapshot: {
      name: text(meta.Name) ?? "imported",
      front: "south",
      dataVersion: num(v.MinecraftDataVersion) ?? 0,
      ...(author ? { author } : {}),
      size,
      offset: [0, 0, 0],
      palette,
      blocks,
      blockEntities,
      entities,
    },
  };
}

/** Bits per entry Litematica uses for a palette of `n` states. */
export function bitsFor(n: number): number {
  return Math.max(2, Math.ceil(Math.log2(Math.max(1, n))));
}

/**
 * Tight bit packing (entries may straddle longs), as prismarine-nbt [high, low] pairs. Works on
 * 32-bit words: stream bit p lives in word p >> 5, and long k is words 2k (low) and 2k+1 (high).
 */
export function packTight(values: ArrayLike<number>, bits: number, count = values.length): [number, number][] {
  const nLongs = Math.ceil((count * bits) / 64);
  const words = new Uint32Array(nLongs * 2);
  for (let i = 0; i < count; i++) {
    const v = values[i]! >>> 0, p = i * bits, w = p >>> 5, sh = p & 31;
    words[w]! |= v << sh;
    if (sh + bits > 32) words[w + 1]! |= v >>> (32 - sh);
  }
  const out: [number, number][] = new Array(nLongs);
  for (let k = 0; k < nLongs; k++) out[k] = [words[2 * k + 1]! | 0, words[2 * k]! | 0];
  return out;
}

export function unpackTight(data: [number, number][], bits: number, count: number): Uint32Array {
  const need = Math.ceil((count * bits) / 64);
  if (data.length < need) throw new Error(`corrupt litematic: block data has ${data.length} longs, need ${need}`);
  const words = new Uint32Array(need * 2);
  for (let k = 0; k < need; k++) {
    words[2 * k] = data[k]![1] >>> 0;
    words[2 * k + 1] = data[k]![0] >>> 0;
  }
  const mask = bits >= 32 ? 0xffffffff : (1 << bits) - 1;
  const out = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const p = i * bits, w = p >>> 5, sh = p & 31;
    let v = words[w]! >>> sh;
    if (sh + bits > 32) v |= words[w + 1]! << (32 - sh);
    out[i] = (v & mask) >>> 0;
  }
  return out;
}

function xyz(t: Compound["value"][string] | undefined): Vec3 {
  const c = compound(t)?.value ?? {};
  return [num(c.x) ?? 0, num(c.y) ?? 0, num(c.z) ?? 0];
}

function nameProps(state: string): Compound {
  const { id, props } = parseState(state);
  const keys = Object.keys(props);
  return T.compound({ Name: T.str(id), ...(keys.length ? { Properties: T.compound(Object.fromEntries(keys.map((k) => [k, T.str(props[k]!)]))) } : {}) });
}

/** A region name Litematica shows; anything goes, but keep it tidy. */
function regionName(name: string): string {
  return name.trim() || "main";
}
