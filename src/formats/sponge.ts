import type { Compound, NBT } from "prismarine-nbt";
import type { Registry } from "../assets/registry.js";
import { AIR } from "../core/blockstate.js";
import type { Vec3 } from "../core/region.js";
import { FACINGS, type Facing } from "../document/document.js";
import { compound, compounds, num, numbers, readNbt, T, text, without, withKeys, writeGzipNbt } from "./nbt.js";
import { importState, MAX_SNAPSHOT_VOLUME, type Snapshot } from "./snapshot.js";

/**
 * Sponge Schematic `.schem` (docs/design/08-formats.md), used by Axiom, WorldEdit and FAWE.
 * Writes v3 (default) or v2; reads v1–v3. Block data is a varint stream of palette indices in
 * x, z, y order. Block entities and entities keep their NBT verbatim.
 */

export type SpongeVersion = 2 | 3;

export function encodeSponge(s: Snapshot, opts: { version?: SpongeVersion; author?: string; date?: number } = {}): Buffer {
  const version = opts.version ?? 3;
  const [w, h, l] = s.size;
  if (w > 0xffff || h > 0xffff || l > 0xffff) throw new Error(`.schem dimensions are limited to 65535 (got ${s.size.join("×")})`);

  const data = encodeVarints(s.blocks);
  const paletteTag: Compound["value"] = {};
  s.palette.forEach((state, i) => (paletteTag[state] = T.int(i)));
  const metadata = T.compound({
    Name: T.str(s.name),
    ...(opts.author ?? s.author ? { Author: T.str((opts.author ?? s.author)!) } : {}),
    Date: T.long(opts.date ?? Date.now()),
    Autosketch: T.compound({ Front: T.str(s.front), Offset: T.ints([...s.offset]) }),
  });

  const blockEntities = s.blockEntities.map((b) => {
    const id = text(b.nbt.value.id) ?? text(b.nbt.value.Id) ?? "";
    const rest = without(b.nbt, "id", "Id", "x", "y", "z");
    return version === 3
      ? T.compound({ Pos: T.ints([...b.pos]), Id: T.str(id), Data: rest })
      : T.compound({ ...rest.value, Pos: T.ints([...b.pos]), Id: T.str(id) });
  });
  const entities = s.entities.map((e) => {
    const id = text(e.nbt.value.id) ?? text(e.nbt.value.Id) ?? "";
    const rest = without(e.nbt, "id", "Id", "Pos");
    return version === 3
      ? T.compound({ Pos: T.doubleList([...e.pos]), Id: T.str(id), Data: rest })
      : T.compound({ ...rest.value, Pos: T.doubleList([...e.pos]), Id: T.str(id) });
  });

  const common = {
    Version: T.int(version),
    DataVersion: T.int(s.dataVersion),
    Width: T.short(toShort(w)),
    Height: T.short(toShort(h)),
    Length: T.short(toShort(l)),
    Offset: T.ints([0, 0, 0]),
    Metadata: metadata,
    ...(entities.length ? { Entities: T.compoundList(entities) } : {}),
  };
  const root: NBT =
    version === 3
      ? {
          type: "compound",
          name: "",
          value: {
            Schematic: T.compound({
              ...common,
              Blocks: T.compound({ Palette: T.compound(paletteTag), Data: T.bytes(data), BlockEntities: T.compoundList(blockEntities) }),
            }),
          },
        }
      : {
          type: "compound",
          name: "Schematic",
          value: { ...common, PaletteMax: T.int(s.palette.length), Palette: T.compound(paletteTag), BlockData: T.bytes(data), BlockEntities: T.compoundList(blockEntities) },
        };
  return writeGzipNbt(root);
}

export interface DecodeOptions {
  registry?: Registry;
}

export interface Decoded {
  snapshot: Snapshot;
  warnings: string[];
  /** Format version that was read. */
  version: number;
}

export function decodeSponge(buf: Buffer, opts: DecodeOptions = {}): Decoded {
  const root = readNbt(buf);
  // v3 wraps everything in a "Schematic" compound; v1/v2 put it at the root.
  const s = compound(root.value.Schematic)?.value ?? root.value;
  const version = num(s.Version) ?? 0;
  if (version < 1 || version > 3) throw new Error(`not a Sponge schematic (Version ${version || "missing"})`);
  const size: Vec3 = [(num(s.Width) ?? 0) & 0xffff, (num(s.Height) ?? 0) & 0xffff, (num(s.Length) ?? 0) & 0xffff];
  const volume = size[0] * size[1] * size[2];
  if (volume > MAX_SNAPSHOT_VOLUME) throw new Error(`schematic volume ${volume} is over the ${MAX_SNAPSHOT_VOLUME} limit`);

  const blocksTag = version === 3 ? compound(s.Blocks)?.value ?? {} : s;
  const paletteTag = compound(version === 3 ? blocksTag.Palette : s.Palette)?.value ?? {};
  const data = numbers(version === 3 ? blocksTag.Data : s.BlockData);

  const warnings = new Set<string>();
  // File palette index → snapshot palette index (air first, duplicates after canonicalisation merged).
  const palette = [AIR];
  const byState = new Map([[AIR, 0]]);
  const map = new Map<number, number>();
  for (const [raw, t] of Object.entries(paletteTag)) {
    const idx = num(t);
    if (idx === undefined) continue;
    const state = importState(raw, opts.registry, warnings);
    let p = byState.get(state);
    if (p === undefined) {
      p = palette.length;
      palette.push(state);
      byState.set(state, p);
    }
    map.set(idx, p);
  }

  const blocks = new Uint16Array(volume);
  const indices = decodeVarints(data, volume);
  for (let i = 0; i < volume; i++) {
    const p = map.get(indices[i]!);
    if (p === undefined) throw new Error(`corrupt schematic: block data uses palette index ${indices[i]} which the palette doesn't define`);
    blocks[i] = p;
  }

  const blockEntities: Snapshot["blockEntities"] = [];
  for (const be of [...compounds(blocksTag.BlockEntities), ...compounds(s.TileEntities)]) {
    const pos = numbers(be.value.Pos);
    if (pos.length !== 3) continue;
    const id = text(be.value.Id) ?? text(be.value.id);
    const body = version === 3 ? compound(be.value.Data) ?? T.compound({}) : without(be, "Pos", "Id", "id");
    blockEntities.push({ pos: pos as Vec3, nbt: withKeys(without(body, "x", "y", "z"), id ? { id: T.str(id) } : {}) });
  }

  const entities: Snapshot["entities"] = [];
  for (const e of compounds(s.Entities)) {
    const pos = numbers(e.value.Pos);
    if (pos.length !== 3) continue;
    const id = text(e.value.Id) ?? text(e.value.id);
    const body = version === 3 ? compound(e.value.Data) ?? T.compound({}) : without(e, "Pos", "Id", "id");
    entities.push({ pos: pos as Vec3, nbt: withKeys(without(body, "Pos"), id ? { id: T.str(id) } : {}) });
  }

  const meta = compound(s.Metadata)?.value ?? {};
  const ours = compound(meta.Autosketch)?.value ?? {};
  const front = text(ours.Front) as Facing | undefined;
  const author = text(meta.Author);
  return {
    version,
    warnings: [...warnings],
    snapshot: {
      name: text(meta.Name) ?? "imported",
      front: front && FACINGS.includes(front) ? front : "south",
      dataVersion: num(s.DataVersion) ?? 0,
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

function toShort(n: number): number {
  return n > 0x7fff ? n - 0x10000 : n;
}

/** Unsigned LEB128 varints, as signed bytes (NBT byte arrays are signed). */
export function encodeVarints(values: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    let v = values[i]!;
    while (v >= 0x80) {
      out.push(((v & 0x7f) | 0x80) - 256);
      v >>>= 7;
    }
    out.push(v > 127 ? v - 256 : v);
  }
  return out;
}

export function decodeVarints(bytes: ArrayLike<number>, count: number): Uint32Array {
  const out = new Uint32Array(count);
  let j = 0;
  for (let i = 0; i < count; i++) {
    let v = 0, shift = 0, b: number;
    do {
      if (j >= bytes.length) throw new Error(`corrupt schematic: block data ends after ${i} of ${count} blocks`);
      b = bytes[j++]! & 0xff;
      v |= (b & 0x7f) << shift;
      shift += 7;
      if (shift > 28) throw new Error("corrupt schematic: varint too long");
    } while (b & 0x80);
    out[i] = v >>> 0;
  }
  return out;
}
