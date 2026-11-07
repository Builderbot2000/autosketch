import type { Compound } from "prismarine-nbt";
import type { Registry } from "../assets/registry.js";
import { AIR, canonicalState, formatState, isAir, parseState } from "../core/blockstate.js";
import { boxSize, boxVolume, intersectBox, isEmptyBox, type Box, type Vec3 } from "../core/region.js";
import { Document, type DocMeta, type Facing } from "../document/document.js";
import { num, numbers, T, text, withKeys } from "./nbt.js";

/**
 * A dense, normalised view of (part of) a document: the common ground between the document model
 * and every export format (docs/design/08-formats.md). The minimum corner is (0,0,0) (01:
 * "exports normalise"); `offset` says where that corner was in document-local coordinates.
 */
export interface Snapshot {
  name: string;
  front: Facing;
  dataVersion: number;
  author?: string;
  size: Vec3;
  /** Document-local position of the snapshot's (0,0,0). */
  offset: Vec3;
  /** Canonical states; index 0 is always minecraft:air. */
  palette: string[];
  /** Palette indices, x fastest, then z, then y (Sponge order): x + z*W + y*W*L. */
  blocks: Uint16Array;
  /** Block entities at snapshot positions; the compound carries `id` and no x/y/z. */
  blockEntities: { pos: Vec3; nbt: Compound }[];
  /** Entities at snapshot positions (block units, fractional); the compound carries `id`, no `Pos`. */
  entities: { pos: Vec3; nbt: Compound }[];
}

/** Largest volume a snapshot may hold (palette indices are dense: 2 bytes per block). */
export const MAX_SNAPSHOT_VOLUME = 64_000_000;

export const blockIndex = (s: Pick<Snapshot, "size">, x: number, y: number, z: number) => x + z * s.size[0] + y * s.size[0] * s.size[2];

/**
 * Takes a snapshot of the document, or of a local region of it. Without a region it covers the
 * document's bounds (declared size ∪ everything built), so a declared plot keeps its air margin.
 */
export function snapshotOf(doc: Document, region?: Box): Snapshot {
  const bounds = doc.bounds;
  if (!bounds || isEmptyBox(bounds)) throw new Error("The document is empty; nothing to export.");
  const box = region ? intersectBox(doc.boxToStore(region), bounds) : bounds;
  if (isEmptyBox(box)) throw new Error("The region does not overlap the document's bounds; nothing to export.");
  const volume = boxVolume(box);
  if (volume > MAX_SNAPSHOT_VOLUME) throw new Error(`export volume ${volume} blocks is over the ${MAX_SNAPSHOT_VOLUME} limit; export a region at a time`);

  const size = boxSize(box);
  const [x0, y0, z0] = box.min;
  const remap = new Map<number, number>([[0, 0]]);
  const palette = [AIR];
  const blocks = new Uint16Array(volume);
  const snap = { size };
  doc.voxels.forEachInBox(box, (x, y, z, id) => {
    let p = remap.get(id);
    if (p === undefined) {
      p = palette.length;
      palette.push(doc.states.get(id));
      remap.set(id, p);
    }
    blocks[blockIndex(snap, x - x0, y - y0, z - z0)] = p;
  });

  const blockEntities: Snapshot["blockEntities"] = [];
  for (const [k, v] of doc.blockEntities) {
    const [x, y, z] = k.split(",").map(Number) as Vec3;
    if (x < x0 || y < y0 || z < z0 || x >= box.max[0] || y >= box.max[1] || z >= box.max[2]) continue;
    blockEntities.push({ pos: [x - x0, y - y0, z - z0], nbt: v });
  }
  blockEntities.sort((a, b) => blockIndex(snap, ...a.pos) - blockIndex(snap, ...b.pos));

  const entities: Snapshot["entities"] = [];
  for (const e of doc.entities) {
    const p = numbers(e.value.Pos);
    if (p.length !== 3) continue;
    const [x, y, z] = p as Vec3;
    if (x < x0 || y < y0 || z < z0 || x >= box.max[0] || y >= box.max[1] || z >= box.max[2]) continue;
    const { Pos: _pos, ...rest } = e.value;
    entities.push({ pos: [x - x0, y - y0, z - z0], nbt: { type: "compound", value: rest } });
  }

  return {
    name: doc.meta.name,
    front: doc.meta.front,
    dataVersion: doc.meta.dataVersion,
    size,
    offset: doc.toLocal(...box.min),
    palette,
    blocks,
    blockEntities,
    entities,
  };
}

/** Counts per palette index (air included). */
export function snapshotHistogram(s: Snapshot): number[] {
  const h = new Array<number>(s.palette.length).fill(0);
  for (const i of s.blocks) h[i]!++;
  return h;
}

/** Non-air block count. */
export function snapshotBlockCount(s: Snapshot): number {
  let n = 0;
  for (const i of s.blocks) if (i !== 0) n++;
  return n;
}

/** A sub-box of a snapshot, normalised again (used to split oversized exports). */
export function subSnapshot(s: Snapshot, box: Box, name: string): Snapshot {
  const size = boxSize(box);
  const [x0, y0, z0] = box.min;
  const out = new Uint16Array(boxVolume(box));
  const used = new Map<number, number>([[0, 0]]);
  const palette = [AIR];
  const sub = { size };
  for (let y = 0; y < size[1]; y++)
    for (let z = 0; z < size[2]; z++)
      for (let x = 0; x < size[0]; x++) {
        const src = s.blocks[blockIndex(s, x + x0, y + y0, z + z0)]!;
        if (!src) continue;
        let p = used.get(src);
        if (p === undefined) {
          p = palette.length;
          palette.push(s.palette[src]!);
          used.set(src, p);
        }
        out[blockIndex(sub, x, y, z)] = p;
      }
  const inside = (p: Vec3) => p[0] >= x0 && p[1] >= y0 && p[2] >= z0 && p[0] < box.max[0] && p[1] < box.max[1] && p[2] < box.max[2];
  return {
    ...s,
    name,
    size,
    offset: [s.offset[0] + x0, s.offset[1] + y0, s.offset[2] + z0],
    palette,
    blocks: out,
    blockEntities: s.blockEntities.filter((b) => inside(b.pos)).map((b) => ({ pos: [b.pos[0] - x0, b.pos[1] - y0, b.pos[2] - z0], nbt: b.nbt })),
    entities: s.entities.filter((e) => inside(e.pos)).map((e) => ({ pos: [e.pos[0] - x0, e.pos[1] - y0, e.pos[2] - z0], nbt: e.nbt })),
  };
}

// -- import ---------------------------------------------------------------------------------------

/**
 * Canonical form of a state read from a file. With a registry, properties get their defaults; a
 * block the registry rejects (renamed property, other version) or doesn't know is kept verbatim
 * (01: unknown blocks are never dropped or rewritten) and noted in `warnings`.
 */
export function importState(raw: string, registry: Registry | undefined, warnings: Set<string>): string {
  let parsed;
  try {
    parsed = parseState(raw);
  } catch {
    warnings.add(`unparseable block "${raw}" kept verbatim`);
    return raw;
  }
  if (isAir(raw)) return AIR;
  const verbatim = formatState(parsed.id, parsed.props);
  if (!registry) return verbatim;
  try {
    const r = canonicalState(verbatim, registry);
    if (r.unknown) warnings.add(`unknown block ${parsed.id} (kept)`);
    return r.state;
  } catch (e) {
    warnings.add(`${(e as Error).message} — kept as written`);
    return verbatim;
  }
}

export interface ImportedMeta {
  name: string;
  dataVersion: number;
  front?: Facing;
  source: string;
}

/** Builds a fresh document (no history) from a snapshot. States are expected to be canonical already. */
export function documentFromSnapshot(s: Snapshot, meta: ImportedMeta, opts: { seed?: number } = {}): Document {
  const m: DocMeta = {
    name: meta.name,
    front: meta.front ?? s.front,
    dataVersion: meta.dataVersion,
    seed: opts.seed ?? (Math.random() * 0x7fffffff) | 0,
    createdAt: new Date().toISOString(),
    source: meta.source,
  };
  const doc = new Document(m);
  const ids = s.palette.map((p) => doc.states.intern(p));
  const [w, h, l] = s.size;
  for (let y = 0; y < h; y++)
    for (let z = 0; z < l; z++)
      for (let x = 0; x < w; x++) {
        const p = s.blocks[x + z * w + y * w * l]!;
        if (p) doc.voxels.set(x, y, z, ids[p]!);
      }
  if (w > 0 && h > 0 && l > 0) doc.bounds = { min: [0, 0, 0], max: [w, h, l] };
  for (const b of s.blockEntities) doc.blockEntities.set(b.pos.join(","), b.nbt);
  doc.entities = s.entities.map((e) => withKeys(e.nbt, { Pos: T.doubleList([...e.pos]) }));
  return doc;
}

/** Reads `{Name, Properties}` palette entries (structure NBT style). */
export function stateFromNameProps(c: Compound): string {
  const name = text(c.value.Name) ?? AIR;
  const props: Record<string, string> = {};
  const p = c.value.Properties;
  if (p && p.type === "compound") for (const [k, v] of Object.entries(p.value)) props[k] = text(v) ?? String(num(v) ?? "");
  return formatState(name, props);
}
