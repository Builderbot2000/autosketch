import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import nbt, { type Compound, type NBT } from "prismarine-nbt";
import type { Box, Vec3 } from "../core/region.js";
import { PaletteBook, type NamedPalette } from "../palette/pick.js";
import type { Component } from "./components.js";
import { Document, FACINGS, type DocMeta, type Facing } from "./document.js";
import { StateTable, VoxelStore, type Section } from "./voxels.js";

/**
 * Native document format `.autosketch` (docs/design/04-document.md): gzip NBT holding voxels
 * (16³ sections, local palette + bit-packed indices), block entities, entities, components,
 * palettes and meta. The journal is not persisted in v1: undo history starts fresh on open.
 */

export const NATIVE_VERSION = 1;

const int = (value: number) => ({ type: "int" as const, value });
const str = (value: string) => ({ type: "string" as const, value });
const ints = (value: number[]) => ({ type: "intArray" as const, value });
const byte = (value: number) => ({ type: "byte" as const, value });

export function encodeNative(doc: Document): Buffer {
  // Only states still in use are written, renumbered densely (air stays 0).
  const used = new Set<number>([0]);
  for (const s of doc.voxels.allSections()) for (const id of s.ids) used.add(id);
  const ordered = [...used].sort((a, b) => a - b);
  const remap = new Map(ordered.map((id, i) => [id, i]));

  const sections: Compound[] = [];
  for (const s of doc.voxels.allSections()) {
    const local = [...new Set(s.ids)].sort((a, b) => a - b);
    const localIndex = new Map(local.map((id, i) => [id, i]));
    const bits = Math.max(1, Math.ceil(Math.log2(local.length)));
    const per = Math.floor(32 / bits);
    const words = new Int32Array(Math.ceil(4096 / per));
    for (let i = 0; i < 4096; i++) {
      const w = Math.floor(i / per), shift = (i % per) * bits;
      words[w]! |= localIndex.get(s.ids[i]!)! << shift;
    }
    sections.push({
      type: "compound",
      value: {
        Pos: ints([s.sx, s.sy, s.sz]),
        Palette: ints(local.map((id) => remap.get(id)!)),
        Bits: byte(bits),
        Data: ints([...words]),
      },
    });
  }

  const blockEntities: Compound[] = [...doc.blockEntities].map(([k, v]) => ({ type: "compound", value: { Pos: ints(k.split(",").map(Number)), Nbt: v } }));
  const meta = doc.meta;
  const root: NBT = {
    type: "compound",
    name: "Autosketch",
    value: {
      Version: int(NATIVE_VERSION),
      Meta: {
        type: "compound",
        value: {
          Name: str(meta.name),
          Front: str(meta.front),
          DataVersion: int(meta.dataVersion),
          Seed: int(meta.seed),
          CreatedAt: str(meta.createdAt),
          ...(meta.source ? { Source: str(meta.source) } : {}),
        },
      },
      Origin: ints([...doc.origin]),
      ...(doc.bounds ? { Bounds: ints([...doc.bounds.min, ...doc.bounds.max]) } : {}),
      States: { type: "list", value: { type: "string", value: ordered.map((id) => doc.states.get(id)) } },
      Sections: { type: "list", value: { type: "compound", value: sections.map((c) => c.value) } },
      BlockEntities: { type: "list", value: { type: "compound", value: blockEntities.map((c) => c.value) } },
      Entities: { type: "list", value: { type: "compound", value: doc.entities.map((c) => c.value) } },
      Components: str(JSON.stringify([...doc.components.values()])),
      Palettes: str(JSON.stringify(doc.palettes.toJSON())),
      ...(doc.selections.size ? { Selections: str(JSON.stringify(Object.fromEntries(doc.selections))) } : {}),
    },
  };
  return gzipSync(nbt.writeUncompressed(root));
}

export function decodeNative(buf: Buffer, opts: { palettes?: PaletteBook } = {}): Document {
  let root: NBT;
  try {
    root = nbt.parseUncompressed(gunzipSync(buf));
  } catch (e) {
    throw new Error(`not an Autosketch document (${(e as Error).message})`);
  }
  const v = root.value;
  const version = num(v.Version);
  if (version === undefined || version > NATIVE_VERSION) throw new Error(`unsupported Autosketch document version ${version ?? "?"} (this build reads ≤ ${NATIVE_VERSION})`);
  const m = (v.Meta as Compound | undefined)?.value ?? {};
  const front = text(m.Front) as Facing;
  const meta: DocMeta = {
    name: text(m.Name) ?? "untitled",
    front: FACINGS.includes(front) ? front : "south",
    dataVersion: num(m.DataVersion) ?? 0,
    seed: num(m.Seed) ?? 0,
    createdAt: text(m.CreatedAt) ?? new Date().toISOString(),
    ...(text(m.Source) ? { source: text(m.Source)! } : {}),
  };

  const stateList = listOf<string>(v.States);
  const states = new StateTable(stateList.length ? stateList : undefined);
  const voxels = new VoxelStore();
  for (const c of listOf<Compound["value"]>(v.Sections)) {
    const [sx, sy, sz] = arr(c.Pos) as Vec3;
    const palette = arr(c.Palette);
    const bits = num(c.Bits) ?? 1;
    const data = arr(c.Data);
    const per = Math.floor(32 / bits), mask = bits === 32 ? -1 : (1 << bits) - 1;
    const ids = new Uint16Array(4096);
    let count = 0;
    for (let i = 0; i < 4096; i++) {
      const w = data[Math.floor(i / per)] ?? 0;
      const li = (w >>> ((i % per) * bits)) & mask;
      const id = palette[li] ?? 0;
      if (id >= states.size) throw new Error(`corrupt document: state index ${id} out of range`);
      ids[i] = id;
      if (id) count++;
    }
    voxels.putSection({ sx, sy, sz, ids, count } satisfies Section);
  }

  const palettes = opts.palettes ?? new PaletteBook();
  for (const p of JSON.parse(text(v.Palettes) ?? "[]") as NamedPalette[]) if (!palettes.get(p.name)) palettes.set(p);
  const doc = new Document(meta, { states, voxels, palettes });
  doc.origin = (arr(v.Origin) as Vec3 | undefined)?.length === 3 ? (arr(v.Origin) as Vec3) : [0, 0, 0];
  const b = arr(v.Bounds);
  if (b.length === 6) doc.bounds = { min: [b[0]!, b[1]!, b[2]!], max: [b[3]!, b[4]!, b[5]!] } satisfies Box;
  for (const be of listOf<Compound["value"]>(v.BlockEntities)) {
    const pos = arr(be.Pos);
    if (pos.length === 3 && be.Nbt) doc.blockEntities.set(pos.join(","), be.Nbt as Compound);
  }
  doc.entities = listOf<Compound["value"]>(v.Entities).map((value) => ({ type: "compound", value }));
  for (const c of JSON.parse(text(v.Components) ?? "[]") as Component[]) doc.components.set(c.id, c);
  for (const [k, e] of Object.entries(JSON.parse(text(v.Selections) ?? "{}") as Record<string, string | Record<string, unknown>>)) doc.selections.set(k, e);
  return doc;
}

export async function saveNative(doc: Document, path: string): Promise<number> {
  const buf = encodeNative(doc);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, buf);
  await rename(tmp, path);
  return buf.length;
}

export async function loadNative(path: string, opts: { palettes?: PaletteBook } = {}): Promise<Document> {
  return decodeNative(await readFile(path), opts);
}

type Tag = Compound["value"][string];
const num = (t: Tag): number | undefined => (t && typeof t.value === "number" ? t.value : undefined);
const text = (t: Tag): string | undefined => (t && t.type === "string" ? t.value : undefined);
const arr = (t: Tag): number[] => (t && t.type === "intArray" ? t.value : []);
function listOf<T>(t: Tag): T[] {
  return t && t.type === "list" ? (t.value.value as T[]) : [];
}
