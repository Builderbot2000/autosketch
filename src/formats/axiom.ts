import type { Compound, NBT } from "prismarine-nbt";
import nbt from "prismarine-nbt";
import { PNG } from "pngjs";
import { AIR, parseState } from "../core/blockstate.js";
import type { Vec3 } from "../core/region.js";
import { compound, compounds, num, readNbt, T, text, writeGzipNbt } from "./nbt.js";
import type { Decoded, DecodeOptions } from "./sponge.js";
import { blockIndex, importState, MAX_SNAPSHOT_VOLUME, stateFromNameProps, type Snapshot } from "./snapshot.js";

/**
 * Axiom blueprint `.bp` (docs/design/08-formats.md). Layout, verified against a blueprint saved by
 * Axiom (2026-11-07, decoded block-for-block equal to the same build's .schem):
 *
 *   int32 magic 0x0AE5BB36
 *   int32 n, n bytes: uncompressed NBT header {Name, Author, Tags[], BlockCount, ContainsAir,
 *                     LockedThumbnail, ThumbnailYaw, ThumbnailPitch, Version: 2}
 *   int32 n, n bytes: PNG thumbnail (96×96, transparent background)
 *   int32 n, n bytes: gzip NBT {DataVersion, BlockRegion[], BlockEntities[], Entities[]}
 *
 * BlockRegion entries are 16³ sections {X, Y, Z (section coords), BlockStates {palette, data}}
 * packed like vanilla chunk sections: ≥4 bits per index, indices never straddle a long, index
 * order x, then z, then y. `minecraft:void_air` marks positions the blueprint leaves untouched.
 *
 * Not yet verified: how block entities and entities are stored (the fixture had none). The writer
 * leaves them out (the caller warns); the reader accepts compounds carrying x/y/z.
 */

export const BP_MAGIC = 0x0ae5bb36;
const VOID = "minecraft:void_air";

export interface BlueprintOptions {
  /** PNG; a blank 96×96 one is used when missing. */
  thumbnail?: Buffer;
  author?: string;
  tags?: string[];
  /** Write explicit air (clears space when pasted) instead of void_air. */
  includeAir?: boolean;
}

export function encodeBlueprint(s: Snapshot, opts: BlueprintOptions = {}): Buffer {
  const includeAir = opts.includeAir ?? false;
  const [w, h, l] = s.size;
  const regions: Compound[] = [];
  let blockCount = 0;
  const ids = new Uint16Array(4096);

  for (let sy = 0; sy * 16 < h; sy++)
    for (let sz = 0; sz * 16 < l; sz++)
      for (let sx = 0; sx * 16 < w; sx++) {
        // Section palette: index 0 = void_air; snapshot index p → section index.
        const local = new Map<string, number>([[VOID, 0]]);
        const states = [VOID];
        let any = false;
        for (let i = 0; i < 4096; i++) {
          const x = sx * 16 + (i & 15), y = sy * 16 + (i >> 8), z = sz * 16 + ((i >> 4) & 15);
          let state = VOID;
          if (x < w && y < h && z < l) {
            const p = s.blocks[blockIndex(s, x, y, z)]!;
            if (p !== 0) state = s.palette[p]!;
            else if (includeAir) state = AIR;
          }
          let li = local.get(state);
          if (li === undefined) {
            li = states.length;
            states.push(state);
            local.set(state, li);
          }
          ids[i] = li;
          if (li !== 0) {
            any = true;
            if (state !== AIR) blockCount++;
          }
        }
        if (!any) continue;
        regions.push(
          T.compound({
            X: T.int(sx),
            Y: T.int(sy),
            Z: T.int(sz),
            BlockStates: T.compound({
              palette: T.compoundList(states.map(nameProps)),
              data: { type: "longArray", value: packLongs(ids, Math.max(4, Math.ceil(Math.log2(states.length)))) },
            }),
          }),
        );
      }

  const header: NBT = {
    type: "compound",
    name: "",
    value: {
      Name: T.str(s.name),
      Author: T.str(opts.author ?? s.author ?? ""),
      Tags: opts.tags?.length ? T.strList(opts.tags) : emptyList(),
      BlockCount: T.int(blockCount),
      ContainsAir: T.byte(includeAir ? 1 : 0),
      LockedThumbnail: T.byte(0),
      ThumbnailYaw: { type: "float", value: 135 },
      ThumbnailPitch: { type: "float", value: 30 },
      Version: T.int(2),
    },
  };
  const data: NBT = {
    type: "compound",
    name: "",
    value: { DataVersion: T.int(s.dataVersion), BlockRegion: T.compoundList(regions), BlockEntities: emptyList(), Entities: emptyList() },
  };
  const headerBuf = nbt.writeUncompressed(header);
  const thumb = opts.thumbnail ?? blankThumbnail();
  const dataBuf = writeGzipNbt(data);
  const out = Buffer.alloc(16 + headerBuf.length + thumb.length + dataBuf.length);
  let o = out.writeInt32BE(BP_MAGIC | 0, 0);
  o = out.writeInt32BE(headerBuf.length, o);
  o += headerBuf.copy(out, o);
  o = out.writeInt32BE(thumb.length, o);
  o += thumb.copy(out, o);
  o = out.writeInt32BE(dataBuf.length, o);
  dataBuf.copy(out, o);
  return out;
}

export interface BlueprintHeader {
  name: string;
  author: string;
  tags: string[];
  blockCount: number;
  containsAir: boolean;
  version: number;
}

export function decodeBlueprint(buf: Buffer, opts: DecodeOptions = {}): Decoded & { header: BlueprintHeader; thumbnail: Buffer } {
  const chunks = splitBlueprint(buf);
  const hv = nbt.parseUncompressed(chunks.header).value;
  const header: BlueprintHeader = {
    name: text(hv.Name) ?? "imported",
    author: text(hv.Author) ?? "",
    tags: hv.Tags?.type === "list" && hv.Tags.value.type === "string" ? (hv.Tags.value.value as string[]) : [],
    blockCount: num(hv.BlockCount) ?? 0,
    containsAir: num(hv.ContainsAir) === 1,
    version: num(hv.Version) ?? 0,
  };
  const warnings = new Set<string>();
  if (header.version !== 2) warnings.add(`blueprint header version ${header.version} (verified layout is version 2)`);
  const v = readNbt(chunks.data).value;

  // Decode sections into a sparse map first: blueprints are centred on their own origin, so the
  // extent is only known after reading every section.
  type Sec = { X: number; Y: number; Z: number; states: (number | undefined)[]; idx: Uint16Array };
  const palette = [AIR];
  const byState = new Map([[AIR, 0]]);
  const intern = (raw: string): number | undefined => {
    if (raw === VOID) return undefined;
    const st = importState(raw, opts.registry, warnings);
    let p = byState.get(st);
    if (p === undefined) {
      p = palette.length;
      palette.push(st);
      byState.set(st, p);
    }
    return p;
  };
  const secs: Sec[] = [];
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const r of compounds(v.BlockRegion)) {
    const bs = compound(r.value.BlockStates)?.value ?? {};
    const pal = compounds(bs.palette).map((c) => intern(stateFromNameProps(c)));
    if (!pal.length) continue;
    const data = bs.data?.type === "longArray" ? (bs.data.value as [number, number][]) : [];
    const idx = unpackLongs(data, Math.max(4, Math.ceil(Math.log2(pal.length))));
    const sec: Sec = { X: num(r.value.X) ?? 0, Y: num(r.value.Y) ?? 0, Z: num(r.value.Z) ?? 0, states: pal, idx };
    let used = false;
    for (let i = 0; i < 4096; i++) {
      const li = idx[i]!;
      if (li >= pal.length) throw new Error(`corrupt blueprint: section index ${li} past its ${pal.length}-entry palette`);
      if (pal[li] === undefined) continue;
      used = true;
      const p: Vec3 = [sec.X * 16 + (i & 15), sec.Y * 16 + (i >> 8), sec.Z * 16 + ((i >> 4) & 15)];
      for (let a = 0; a < 3; a++) {
        if (p[a]! < min[a]!) min[a] = p[a]!;
        if (p[a]! > max[a]!) max[a] = p[a]!;
      }
    }
    if (used) secs.push(sec);
  }

  const empty = !secs.length;
  const size: Vec3 = empty ? [0, 0, 0] : [max[0] - min[0] + 1, max[1] - min[1] + 1, max[2] - min[2] + 1];
  const volume = size[0] * size[1] * size[2];
  if (volume > MAX_SNAPSHOT_VOLUME) throw new Error(`blueprint volume ${volume} is over the ${MAX_SNAPSHOT_VOLUME} limit`);
  const blocks = new Uint16Array(volume);
  const snap = { size };
  for (const sec of secs)
    for (let i = 0; i < 4096; i++) {
      const p = sec.states[sec.idx[i]!];
      if (p === undefined || p === 0) continue;
      blocks[blockIndex(snap, sec.X * 16 + (i & 15) - min[0], sec.Y * 16 + (i >> 8) - min[1], sec.Z * 16 + ((i >> 4) & 15) - min[2])] = p;
    }

  const blockEntities: Snapshot["blockEntities"] = [];
  let unplaced = 0;
  for (const be of compounds(v.BlockEntities)) {
    const x = num(be.value.x), y = num(be.value.y), z = num(be.value.z);
    if (x === undefined || y === undefined || z === undefined || empty) {
      unplaced++;
      continue;
    }
    const { x: _x, y: _y, z: _z, ...rest } = be.value;
    blockEntities.push({ pos: [x - min[0], y - min[1], z - min[2]], nbt: { type: "compound", value: rest } });
  }
  const nEntities = compounds(v.Entities).length;
  if (unplaced) warnings.add(`${unplaced} block entities in an unrecognised layout were dropped`);
  if (nEntities) warnings.add(`${nEntities} entities dropped (the blueprint entity layout is not verified yet)`);

  return {
    version: header.version,
    warnings: [...warnings],
    header,
    thumbnail: chunks.thumbnail,
    snapshot: {
      name: header.name,
      front: "south",
      dataVersion: num(v.DataVersion) ?? 0,
      ...(header.author ? { author: header.author } : {}),
      size,
      offset: [0, 0, 0],
      palette,
      blocks,
      blockEntities,
      entities: [],
    },
  };
}

export function isBlueprint(buf: Buffer): boolean {
  return buf.length >= 8 && buf.readInt32BE(0) === (BP_MAGIC | 0);
}

/** The three length-prefixed parts of a blueprint. */
export function splitBlueprint(buf: Buffer): { header: Buffer; thumbnail: Buffer; data: Buffer } {
  if (!isBlueprint(buf)) throw new Error("not an Axiom blueprint (bad magic number)");
  let o = 4;
  const take = (what: string) => {
    if (o + 4 > buf.length) throw new Error(`truncated blueprint: missing ${what}`);
    const n = buf.readInt32BE(o);
    o += 4;
    if (n < 0 || o + n > buf.length) throw new Error(`truncated blueprint: ${what} claims ${n} bytes`);
    const part = buf.subarray(o, o + n);
    o += n;
    return part;
  };
  return { header: take("header"), thumbnail: take("thumbnail"), data: take("block data") };
}

function nameProps(state: string): Compound {
  const { id, props } = parseState(state);
  const keys = Object.keys(props);
  return T.compound({ Name: T.str(id), ...(keys.length ? { Properties: T.compound(Object.fromEntries(keys.map((k) => [k, T.str(props[k]!)]))) } : {}) });
}

/** Empty list tagged TAG_End, as Axiom writes it (prismarine-nbt handles it; its types don't list "end"). */
function emptyList(): Compound["value"][string] {
  return { type: "list", value: { type: "end", value: [] } } as unknown as Compound["value"][string];
}

/** Vanilla section packing: `per = floor(64 / bits)` indices per long, low bits first. */
export function packLongs(ids: Uint16Array, bits: number): [number, number][] {
  const per = Math.floor(64 / bits);
  const out: [number, number][] = [];
  for (let start = 0; start < ids.length; start += per) {
    let hi = 0, lo = 0;
    for (let k = 0; k < per && start + k < ids.length; k++) {
      const v = ids[start + k]!, shift = k * bits;
      if (shift >= 32) hi |= v << (shift - 32);
      else {
        lo |= v << shift;
        if (shift + bits > 32) hi |= v >>> (32 - shift);
      }
    }
    out.push([hi | 0, lo | 0]);
  }
  return out;
}

export function unpackLongs(data: [number, number][], bits: number): Uint16Array {
  const out = new Uint16Array(4096);
  if (!data.length) return out; // single-entry palette: everything is index 0
  const per = Math.floor(64 / bits), mask = (1 << bits) - 1;
  for (let i = 0; i < 4096; i++) {
    const pair = data[Math.floor(i / per)];
    if (!pair) throw new Error(`corrupt blueprint: section data has ${data.length} longs, need ${Math.ceil(4096 / per)}`);
    const [hi, lo] = pair, shift = (i % per) * bits;
    let v: number;
    if (shift >= 32) v = (hi >>> (shift - 32)) & mask;
    else if (shift + bits <= 32) v = (lo >>> shift) & mask;
    else v = ((lo >>> shift) | (hi << (32 - shift))) & mask;
    out[i] = v;
  }
  return out;
}

let blank: Buffer | undefined;
function blankThumbnail(): Buffer {
  if (!blank) {
    const png = new PNG({ width: 96, height: 96 });
    png.data.fill(0);
    blank = PNG.sync.write(png);
  }
  return blank;
}
