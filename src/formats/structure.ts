import type { Compound, NBT } from "prismarine-nbt";
import { AIR, parseState } from "../core/blockstate.js";
import { boxSize, type Box, type Vec3 } from "../core/region.js";
import { compound, compounds, num, numbers, readNbt, T, text, without, withKeys, writeGzipNbt } from "./nbt.js";
import type { Decoded, DecodeOptions } from "./sponge.js";
import { blockIndex, importState, MAX_SNAPSHOT_VOLUME, stateFromNameProps, subSnapshot, type Snapshot } from "./snapshot.js";

/**
 * Vanilla structure NBT `.nbt` (docs/design/08-formats.md): what Create's Schematic Table uploads
 * and structure blocks load. Sparse: positions not listed are left untouched when placed, so air
 * is omitted unless `includeAir` asks for explicit clearing entries.
 */

export function encodeStructure(s: Snapshot, opts: { includeAir?: boolean } = {}): Buffer {
  const includeAir = opts.includeAir ?? false;
  // Structure palette: snapshot index → structure index; air only when written.
  const remap = new Int32Array(s.palette.length).fill(-1);
  const palette: Compound[] = [];
  const use = (i: number) => {
    if (remap[i]! < 0) {
      remap[i] = palette.length;
      const { id, props } = parseState(s.palette[i]!);
      palette.push(T.compound({ Name: T.str(id), ...(Object.keys(props).length ? { Properties: T.compound(Object.fromEntries(Object.entries(props).map(([k, v]) => [k, T.str(v)]))) } : {}) }));
    }
    return remap[i]!;
  };
  const nbtAt = new Map<number, Compound>();
  for (const b of s.blockEntities) nbtAt.set(blockIndex(s, ...b.pos), without(b.nbt, "x", "y", "z"));

  const blocks: Compound[] = [];
  const [w, h, l] = s.size;
  for (let y = 0; y < h; y++)
    for (let z = 0; z < l; z++)
      for (let x = 0; x < w; x++) {
        const i = blockIndex(s, x, y, z);
        const p = s.blocks[i]!;
        if (p === 0 && !includeAir) continue;
        const be = nbtAt.get(i);
        blocks.push(T.compound({ pos: T.intList([x, y, z]), state: T.int(use(p)), ...(be ? { nbt: be } : {}) }));
      }

  const entities = s.entities.map((e) =>
    T.compound({
      pos: T.doubleList([...e.pos]),
      blockPos: T.intList(e.pos.map(Math.floor)),
      nbt: withKeys(e.nbt, { Pos: T.doubleList([...e.pos]) }),
    }),
  );

  const root: NBT = {
    type: "compound",
    name: "",
    value: {
      DataVersion: T.int(s.dataVersion),
      size: T.intList([...s.size]),
      palette: T.compoundList(palette),
      blocks: T.compoundList(blocks),
      entities: T.compoundList(entities),
    },
  };
  return writeGzipNbt(root);
}

export function decodeStructure(buf: Buffer, opts: DecodeOptions = {}): Decoded {
  const v = readNbt(buf).value;
  const size = numbers(v.size) as Vec3;
  if (size.length !== 3 || !v.blocks) throw new Error("not a structure NBT file (no size/blocks)");
  const volume = size[0] * size[1] * size[2];
  if (volume > MAX_SNAPSHOT_VOLUME) throw new Error(`structure volume ${volume} is over the ${MAX_SNAPSHOT_VOLUME} limit`);
  // Some structures (shipwrecks) carry several alternative palettes; the first one is used.
  const warnings = new Set<string>();
  let filePalette = compounds(v.palette);
  if (!filePalette.length && v.palettes?.type === "list" && v.palettes.value.type === "list") {
    const first = (v.palettes.value.value as { type: string; value: unknown }[])[0];
    if (first) filePalette = compounds(first as never);
    warnings.add("structure has several palettes; used the first");
  }

  const palette = [AIR];
  const byState = new Map([[AIR, 0]]);
  const map = filePalette.map((c) => {
    const state = importState(stateFromNameProps(c), opts.registry, warnings);
    let p = byState.get(state);
    if (p === undefined) {
      p = palette.length;
      palette.push(state);
      byState.set(state, p);
    }
    return p;
  });

  const snap = { size };
  const blocks = new Uint16Array(volume);
  const blockEntities: Snapshot["blockEntities"] = [];
  for (const b of compounds(v.blocks)) {
    const pos = numbers(b.value.pos);
    const st = num(b.value.state);
    if (pos.length !== 3 || st === undefined) continue;
    const [x, y, z] = pos as Vec3;
    if (x < 0 || y < 0 || z < 0 || x >= size[0] || y >= size[1] || z >= size[2]) {
      warnings.add("blocks outside the declared size were skipped");
      continue;
    }
    const p = map[st];
    if (p === undefined) throw new Error(`corrupt structure: block uses palette index ${st} which the palette doesn't define`);
    blocks[blockIndex(snap, x, y, z)] = p;
    const be = compound(b.value.nbt);
    if (be && p !== 0) blockEntities.push({ pos: [x, y, z], nbt: without(be, "x", "y", "z") });
  }

  const entities: Snapshot["entities"] = [];
  for (const e of compounds(v.entities)) {
    const pos = numbers(e.value.pos);
    const body = compound(e.value.nbt);
    if (pos.length !== 3 || !body) continue;
    entities.push({ pos: pos as Vec3, nbt: without(body, "Pos") });
  }

  return {
    version: 0,
    warnings: [...warnings],
    snapshot: {
      name: "imported",
      front: "south",
      dataVersion: num(v.DataVersion) ?? 0,
      ...(text(v.author) ? { author: text(v.author)! } : {}),
      size,
      offset: [0, 0, 0],
      palette,
      blocks,
      blockEntities,
      entities,
    },
  };
}

// -- size limit and splitting (Create's maxTotalSchematicSize) ------------------------------------

export interface Piece {
  snapshot: Snapshot;
  buf: Buffer;
  /** Where this piece's (0,0,0) goes, relative to the whole export's (0,0,0). */
  at: Vec3;
}

/**
 * Splits a snapshot into pieces whose encoded size is at most `limitBytes`, halving the longest
 * axis until each fits. Pieces are named `<name>_1`, `<name>_2`, … in placement order.
 */
export function splitToFit(s: Snapshot, limitBytes: number, encode: (s: Snapshot) => Buffer): Piece[] {
  const pieces: { box: Box; buf: Buffer; snap: Snapshot }[] = [];
  const visit = (box: Box, depth: number) => {
    const snap = subSnapshot(s, box, s.name);
    const buf = encode(snap);
    const size = boxSize(box);
    if (buf.length <= limitBytes) {
      pieces.push({ box, buf, snap });
      return;
    }
    const axis = size[0] >= size[2] ? (size[0] >= size[1] || size[1] < 2 ? 0 : 1) : size[2] >= size[1] || size[1] < 2 ? 2 : 1;
    if (size[axis]! < 2 || depth > 24) throw new Error(`a ${size.join("×")} piece still encodes to ${Math.ceil(buf.length / 1024)} KB, over the ${Math.floor(limitBytes / 1024)} KB limit`);
    const mid = box.min[axis]! + Math.floor(size[axis]! / 2);
    const a: Box = { min: [...box.min], max: [...box.max] };
    const b: Box = { min: [...box.min], max: [...box.max] };
    a.max[axis] = mid;
    b.min[axis] = mid;
    visit(a, depth + 1);
    visit(b, depth + 1);
  };
  visit({ min: [0, 0, 0], max: [...s.size] }, 0);
  pieces.sort((p, q) => p.box.min[1] - q.box.min[1] || p.box.min[2] - q.box.min[2] || p.box.min[0] - q.box.min[0]);
  return pieces.map((p, i) => {
    const name = `${s.name}_${i + 1}`;
    const snapshot = { ...p.snap, name };
    return { snapshot, buf: p.buf, at: [...p.box.min] };
  });
}
