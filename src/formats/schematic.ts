import { AIR } from "../core/blockstate.js";
import type { Vec3 } from "../core/region.js";
import { compound, compounds, num, numbers, readNbt, text, without } from "./nbt.js";
import { legacyState, mergeUpperHalf } from "./legacy.js";
import type { Decoded, DecodeOptions } from "./sponge.js";
import { blockIndex, importState, MAX_SNAPSHOT_VOLUME, type Snapshot } from "./snapshot.js";

/**
 * Legacy MCEdit / Schematica `.schematic` (docs/design/08-formats.md), read only. gzip NBT:
 *
 *   Schematic { Width, Height, Length (shorts), Materials: "Alpha", Blocks (byte[]), Data (byte[]),
 *               AddBlocks? (byte[], high nibbles for ids > 255), TileEntities [], Entities [],
 *               SchematicaMapping? { name: id } }
 *
 * Index order is x, then z, then y. Numeric ids and data values go through the hand-written
 * legacy table (`legacy.ts`); ids it doesn't know stay visible as `legacy:id_<id>[data=<d>]`.
 * Block entities and entities are kept verbatim in their pre-1.13 layout.
 */

/** The table targets 1.21 block names, so decoded states carry the 1.21.1 DataVersion. */
export const LEGACY_TARGET_DATA_VERSION = 3955;

export function decodeSchematic(buf: Buffer, opts: DecodeOptions = {}): Decoded {
  const v = readNbt(buf).value;
  const ids = numbers(v.Blocks), data = numbers(v.Data), add = numbers(v.AddBlocks);
  if (!v.Blocks) throw new Error("not an MCEdit schematic (no Blocks)");
  const size: Vec3 = [(num(v.Width) ?? 0) & 0xffff, (num(v.Height) ?? 0) & 0xffff, (num(v.Length) ?? 0) & 0xffff];
  const volume = size[0] * size[1] * size[2];
  if (volume > MAX_SNAPSHOT_VOLUME) throw new Error(`schematic volume ${volume} is over the ${MAX_SNAPSHOT_VOLUME} limit`);
  if (ids.length < volume) throw new Error(`corrupt schematic: ${ids.length} blocks for a ${size.join("×")} volume`);
  const warnings = new Set<string>();
  const materials = text(v.Materials);
  if (materials && materials !== "Alpha") warnings.add(`Materials "${materials}" (expected Alpha); read as Alpha`);

  // Schematica writes a name → id mapping for modded blocks.
  const mapping = new Map<number, string>();
  for (const [name, t] of Object.entries(compound(v.SchematicaMapping)?.value ?? {})) {
    const id = num(t);
    if (id !== undefined) mapping.set(id, name.includes(":") ? name : `minecraft:${name}`);
  }

  const palette = [AIR];
  const byState = new Map([[AIR, 0]]);
  const byKey = new Map<number, number>();
  const unknown = new Map<number, number>(), partial = new Map<number, number>();
  const intern = (raw: string) => {
    const st = importState(raw, opts.registry, warnings);
    let p = byState.get(st);
    if (p === undefined) {
      p = palette.length;
      palette.push(st);
      byState.set(st, p);
    }
    return p;
  };
  const stateFor = (id: number, d: number): string => {
    const named = mapping.get(id);
    if (named && !named.startsWith("minecraft:")) {
      if (d) partial.set(id, (partial.get(id) ?? 0) + 1);
      return named;
    }
    const r = legacyState(id, d);
    if (r.quality === "unknown") unknown.set(id, (unknown.get(id) ?? 0) + 1);
    else if (r.quality === "partial") partial.set(id, (partial.get(id) ?? 0) + 1);
    return r.state;
  };

  /** (id << 4) | data at a position; ids above 255 take their high nibble from AddBlocks (WorldEdit's layout). */
  const keyAt = (i: number) => {
    let id = ids[i]! & 0xff;
    const nib = add[i >> 1];
    if (nib !== undefined) id |= (i & 1 ? nib & 0x0f : (nib & 0xf0) >> 4) << 8;
    return (id << 4) | ((data[i] ?? 0) & 0x0f);
  };
  const blocks = new Uint16Array(volume);
  const raw: string[] = [];
  let uppers = false;
  for (let i = 0; i < volume; i++) {
    const key = keyAt(i);
    if (key >> 4 === 0) continue;
    let p = byKey.get(key);
    if (p === undefined) {
      const st = stateFor(key >> 4, key & 15);
      raw[key] = st;
      if (st.includes("half=upper")) uppers = true;
      p = intern(st);
      byKey.set(key, p);
    }
    blocks[i] = p;
  }

  // Upper door halves and double plants take their facing/variant from the block below.
  if (uppers) {
    const snap = { size };
    for (let y = 1; y < size[1]; y++)
      for (let z = 0; z < size[2]; z++)
        for (let x = 0; x < size[0]; x++) {
          const i = blockIndex(snap, x, y, z);
          const up = raw[keyAt(i)];
          if (!up?.includes("half=upper")) continue;
          const below = raw[keyAt(blockIndex(snap, x, y - 1, z))];
          const merged = below && mergeUpperHalf(up, below);
          if (merged) blocks[i] = intern(merged);
        }
  }

  if (unknown.size) warnings.add(`${[...unknown.values()].reduce((a, b) => a + b, 0)} blocks with legacy ids the table doesn't know (${[...unknown.keys()].sort((a, b) => a - b).slice(0, 12).join(", ")}) kept as legacy:id_<id> placeholders`);
  if (partial.size) warnings.add(`data values not mapped for legacy ids ${[...partial.keys()].sort((a, b) => a - b).slice(0, 12).join(", ")}; used their default variant`);

  const blockEntities: Snapshot["blockEntities"] = [];
  for (const be of compounds(v.TileEntities)) {
    const x = num(be.value.x), y = num(be.value.y), z = num(be.value.z);
    if (x === undefined || y === undefined || z === undefined) continue;
    if (x < 0 || y < 0 || z < 0 || x >= size[0] || y >= size[1] || z >= size[2]) continue;
    blockEntities.push({ pos: [x, y, z], nbt: without(be, "x", "y", "z") });
  }
  if (blockEntities.length) warnings.add(`${blockEntities.length} block entities kept in their pre-1.13 layout (the game may not read them)`);

  const entities: Snapshot["entities"] = [];
  for (const e of compounds(v.Entities)) {
    const p = numbers(e.value.Pos);
    if (p.length === 3) entities.push({ pos: p as Vec3, nbt: without(e, "Pos") });
  }

  return {
    version: 0,
    warnings: [...warnings],
    snapshot: {
      name: "imported",
      front: "south",
      dataVersion: LEGACY_TARGET_DATA_VERSION,
      size,
      offset: [0, 0, 0],
      palette,
      blocks,
      blockEntities,
      entities,
    },
  };
}
