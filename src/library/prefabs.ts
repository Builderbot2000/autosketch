import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import nbt from "prismarine-nbt";
import type { Registry } from "../assets/registry.js";
import { stateId } from "../core/blockstate.js";
import type { Vec3 } from "../core/region.js";
import type { Facing } from "../document/document.js";
import { BP_MAGIC, splitBlueprint } from "../formats/axiom.js";
import { importFile } from "../formats/index.js";
import { text as nbtText } from "../formats/nbt.js";
import { snapshotOf, type Snapshot } from "../formats/snapshot.js";
import { encodeSponge } from "../formats/sponge.js";
import type { PaletteIndex } from "../palette/index.js";
import { walk, words } from "./files.js";
import { checkEntryName, writableRoot, type LibraryRoot } from "./roots.js";

/**
 * Prefabs (docs/design/07-library.md): schematic files in any readable format (08) plus optional
 * `prefab.json` metadata. Library roots hold `prefabs/<id>/prefab.<ext>` folders (or loose
 * `prefabs/<id>.<ext>` files); an Axiom root holds `.bp` blueprints anywhere below it, with their
 * own names, tags and thumbnails.
 */

export const PREFAB_EXTENSIONS = [".schem", ".nbt", ".bp", ".autosketch"];

export interface PrefabMeta {
  name: string;
  tags: string[];
  front?: Facing;
  /** Prefab-local points; `base` is the default stamp point. */
  anchors: Record<string, Vec3>;
  footprint?: [number, number];
  height?: number;
  /** Role → block ids, so a stamp can recolour them (palette_remap). */
  roles: Record<string, string[]>;
  /** Namespaces the prefab needs. */
  requires: string[];
  notes?: string;
}

export interface Prefab {
  /** Unique name: the folder or file stem; "axiom/<path>" for blueprints in the instance. */
  id: string;
  root: LibraryRoot;
  file: string;
  /** Folder holding prefab.json and thumb.png (undefined for loose files). */
  dir?: string;
  meta: PrefabMeta;
}

const isPrefabFile = (n: string) => PREFAB_EXTENSIONS.includes(extname(n).toLowerCase()) && !n.endsWith(".tmp");

/** Every prefab in the roots, first root winning on equal ids, sorted by id. */
export async function scanPrefabs(roots: readonly LibraryRoot[]): Promise<Prefab[]> {
  const seen = new Map<string, Prefab>();
  for (const root of roots) {
    const found = root.kind === "axiom" ? await scanAxiom(root) : await scanLibrary(root);
    for (const p of found) if (!seen.has(p.id)) seen.set(p.id, p);
  }
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function scanLibrary(root: LibraryRoot): Promise<Prefab[]> {
  const base = join(root.path, "prefabs");
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Prefab[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith(".")) continue;
    if (e.isDirectory()) {
      const dir = join(base, e.name);
      const files = (await readdir(dir)).filter(isPrefabFile).sort();
      const file = files.find((f) => f.startsWith("prefab.")) ?? files[0];
      if (!file) continue;
      out.push({ id: e.name, root, file: join(dir, file), dir, meta: await readMeta(join(dir, "prefab.json"), join(dir, file), e.name) });
    } else if (isPrefabFile(e.name)) {
      const id = e.name.slice(0, -extname(e.name).length);
      out.push({ id, root, file: join(base, e.name), meta: await readMeta(undefined, join(base, e.name), id) });
    }
  }
  return out;
}

async function scanAxiom(root: LibraryRoot): Promise<Prefab[]> {
  const out: Prefab[] = [];
  for (const rel of await walk(root.path, (n) => n.toLowerCase().endsWith(".bp"))) {
    const file = join(root.path, rel);
    out.push({ id: `axiom/${rel.slice(0, -3)}`, root, file, meta: await readMeta(undefined, file, basename(rel, ".bp")) });
  }
  return out;
}

/** prefab.json when present; blueprint headers fill in name and tags; the rest defaults. */
async function readMeta(jsonFile: string | undefined, file: string, id: string): Promise<PrefabMeta> {
  let raw: Partial<PrefabMeta> = {};
  if (jsonFile) {
    try {
      raw = JSON.parse(await readFile(jsonFile, "utf8")) as Partial<PrefabMeta>;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") raw = { notes: `prefab.json unreadable: ${(e as Error).message}` };
    }
  }
  if (file.toLowerCase().endsWith(".bp") && (!raw.name || !raw.tags)) {
    const h = await readBlueprintHeader(file).catch(() => undefined);
    if (h) raw = { ...(h.name ? { name: h.name } : {}), tags: h.tags, ...raw };
  }
  const vec = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((n) => Number.isInteger(n));
  return {
    name: typeof raw.name === "string" ? raw.name : id,
    tags: Array.isArray(raw.tags) ? raw.tags.map((t) => String(t).toLowerCase()) : [],
    ...(raw.front && ["north", "south", "east", "west"].includes(raw.front) ? { front: raw.front } : {}),
    anchors: Object.fromEntries(Object.entries(raw.anchors ?? {}).filter(([, v]) => vec(v))) as Record<string, Vec3>,
    ...(Array.isArray(raw.footprint) && raw.footprint.length === 2 ? { footprint: raw.footprint } : {}),
    ...(typeof raw.height === "number" ? { height: raw.height } : {}),
    roles: Object.fromEntries(Object.entries(raw.roles ?? {}).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.map((b) => (String(b).includes(":") ? String(b) : `minecraft:${b}`))])),
    requires: Array.isArray(raw.requires) ? raw.requires.map(String) : [],
    ...(typeof raw.notes === "string" ? { notes: raw.notes } : {}),
  };
}

/** Name and tags from a blueprint's uncompressed header, reading only the start of the file. */
export async function readBlueprintHeader(file: string): Promise<{ name?: string; tags: string[] }> {
  const fh = await open(file, "r");
  try {
    const head = Buffer.alloc(8);
    await fh.read(head, 0, 8, 0);
    if (head.readInt32BE(0) !== BP_MAGIC) throw new Error("not a blueprint");
    const n = head.readInt32BE(4);
    if (n < 0 || n > 1 << 20) throw new Error("bad header length");
    const buf = Buffer.alloc(n);
    await fh.read(buf, 0, n, 8);
    const v = nbt.parseUncompressed(buf).value;
    const name = nbtText(v.Name);
    const tags = v.Tags?.type === "list" && v.Tags.value.type === "string" ? (v.Tags.value.value as string[]) : [];
    return { ...(name ? { name } : {}), tags };
  } finally {
    await fh.close();
  }
}

// -- loading ---------------------------------------------------------------------------------------

export interface LoadedPrefab {
  snapshot: Snapshot;
  warnings: string[];
}

const loaded = new Map<string, { mtime: number; value: LoadedPrefab }>();

/** Reads a prefab's blocks (cached per file and modification time). Unknown blocks are kept (01). */
export async function loadPrefab(p: Prefab, registry?: Registry): Promise<LoadedPrefab> {
  const mtime = (await stat(p.file)).mtimeMs;
  const hit = loaded.get(p.file);
  if (hit && hit.mtime === mtime) return hit.value;
  const imp = await importFile(p.file, { name: "prefab", ...(registry ? { registry } : {}) });
  const snapshot = snapshotOf(imp.doc);
  const value = { snapshot, warnings: imp.warnings };
  loaded.set(p.file, { mtime, value });
  return value;
}

/** [footprint x, footprint z, height] from metadata, else from the blocks. */
export async function prefabSize(p: Prefab, registry?: Registry): Promise<Vec3> {
  if (p.meta.footprint && p.meta.height !== undefined) return [p.meta.footprint[0], p.meta.footprint[1], p.meta.height];
  const s = (await loadPrefab(p, registry)).snapshot.size;
  return [s[0], s[2], s[1]];
}

// -- search ----------------------------------------------------------------------------------------

export interface PrefabQuery {
  query?: string;
  tags?: string[];
  /** Largest footprint [x, z] (either orientation fits). */
  maxFootprint?: [number, number];
}

/** Prefabs matching tags and footprint, ranked by how well name, tags and notes match the query. */
export async function searchPrefabs(all: readonly Prefab[], q: PrefabQuery, registry?: Registry): Promise<Prefab[]> {
  const tags = (q.tags ?? []).map((t) => t.toLowerCase());
  const terms = words(q.query ?? "");
  const scored: { p: Prefab; score: number }[] = [];
  for (const p of all) {
    if (!tags.every((t) => p.meta.tags.includes(t))) continue;
    let score = 1;
    if (terms.length) {
      const name = words(`${p.id} ${p.meta.name}`);
      const notes = words(p.meta.notes ?? "");
      score = 0;
      for (const t of terms) {
        if (name.includes(t)) score += 3;
        else if (name.some((w) => w.startsWith(t))) score += 2;
        if (p.meta.tags.includes(t)) score += 2;
        if (notes.includes(t)) score += 1;
      }
      if (score === 0) continue;
    }
    if (q.maxFootprint) {
      const [fx, fz] = await prefabSize(p, registry).catch(() => [Infinity, Infinity, 0] as Vec3);
      const [mx, mz] = q.maxFootprint;
      if (!((fx <= mx && fz <= mz) || (fx <= mz && fz <= mx))) continue;
    }
    scored.push({ p, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.p.id.localeCompare(b.p.id)).map((s) => s.p);
}

/** Finds one prefab by id or display name (case-insensitive). */
export function findPrefab(all: readonly Prefab[], name: string): Prefab {
  const n = name.trim().toLowerCase();
  const p = all.find((x) => x.id.toLowerCase() === n) ?? all.find((x) => x.meta.name.toLowerCase() === n);
  if (!p) {
    const near = all.filter((x) => x.id.toLowerCase().includes(n) || x.meta.name.toLowerCase().includes(n)).slice(0, 5).map((x) => x.id);
    throw new Error(`no prefab "${name}"${near.length ? ` (did you mean ${near.join(", ")}?)` : ""}; prefab_search or prefab_sheet shows what's there`);
  }
  return p;
}

// -- thumbnails ------------------------------------------------------------------------------------

/** Renders a thumbnail (PNG) of a snapshot; supplied by the server, which owns the renderer (06). */
export type ThumbnailRenderer = (snapshot: Snapshot) => Promise<Buffer>;

/**
 * The prefab's thumbnail: a fresh `thumb.png` beside it, the image embedded in a `.bp`, or a
 * rendered one. Rendered thumbnails are written next to the prefab in a writable root, and to
 * `cacheDir` otherwise (never into read-only roots or the instance).
 */
export async function prefabThumbnail(p: Prefab, opts: { render?: ThumbnailRenderer; cacheDir?: string; registry?: Registry }): Promise<Buffer | undefined> {
  const mtime = (await stat(p.file)).mtimeMs;
  const fresh = async (f: string) => {
    try {
      return (await stat(f)).mtimeMs >= mtime ? await readFile(f) : undefined;
    } catch {
      return undefined;
    }
  };
  if (p.dir) {
    const t = await fresh(join(p.dir, "thumb.png"));
    if (t) return t;
  }
  if (p.file.toLowerCase().endsWith(".bp")) {
    try {
      const t = splitBlueprint(await readFile(p.file)).thumbnail;
      if (t.length) return Buffer.from(t);
    } catch {
      /* fall through to rendering */
    }
  }
  const cacheFile = opts.cacheDir ? join(opts.cacheDir, "prefab-thumbs", `${createHash("sha1").update(`${p.file}\0${mtime}`).digest("hex").slice(0, 20)}.png`) : undefined;
  if (cacheFile) {
    const t = await fresh(cacheFile);
    if (t) return t;
  }
  if (!opts.render) return undefined;
  const png = await opts.render((await loadPrefab(p, opts.registry)).snapshot);
  const target = p.dir && !p.root.readOnly ? join(p.dir, "thumb.png") : cacheFile;
  if (target) {
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, png);
    } catch {
      /* a thumbnail that can't be cached is still returned */
    }
  }
  return png;
}

// -- saving ----------------------------------------------------------------------------------------

export interface SavePrefabOptions {
  name: string;
  tags?: string[];
  notes?: string;
  anchors?: Record<string, Vec3>;
  roles?: Record<string, string[]>;
  front?: Facing;
  overwrite?: boolean;
}

/**
 * Writes `prefabs/<name>/prefab.schem` (Sponge v3) and `prefab.json` into the first writable root.
 * Without explicit roles, each of the most common families becomes a role named after it, so any
 * saved prefab can be recoloured by family name.
 */
export async function savePrefab(roots: readonly LibraryRoot[], snapshot: Snapshot, opts: SavePrefabOptions, index?: PaletteIndex): Promise<{ prefab: Prefab; dir: string; replaced: boolean }> {
  checkEntryName("prefab", opts.name);
  const root = writableRoot(roots);
  const dir = join(root.path, "prefabs", opts.name);
  let replaced = false;
  try {
    await stat(dir);
    replaced = true;
  } catch {
    /* new */
  }
  if (replaced && !opts.overwrite) throw new Error(`prefab "${opts.name}" already exists in ${root.path}; pass overwrite:true or another name`);

  const requires = [...new Set(snapshot.palette.slice(1).map((s) => stateId(s).split(":")[0]!))].sort();
  const meta: PrefabMeta = {
    name: opts.name,
    tags: (opts.tags ?? []).map((t) => t.toLowerCase()),
    front: opts.front ?? snapshot.front,
    anchors: opts.anchors ?? {},
    footprint: [snapshot.size[0], snapshot.size[2]],
    height: snapshot.size[1],
    roles: opts.roles ? Object.fromEntries(Object.entries(opts.roles).map(([k, v]) => [k, v.map((b) => (b.includes(":") ? b : `minecraft:${b}`))])) : autoRoles(snapshot, index),
    requires,
    ...(opts.notes ? { notes: opts.notes } : {}),
  };
  await mkdir(dir, { recursive: true });
  const file = join(dir, "prefab.schem");
  await writeFile(`${file}.tmp`, encodeSponge({ ...snapshot, name: opts.name }));
  await rename(`${file}.tmp`, file);
  await writeFile(join(dir, "prefab.json"), JSON.stringify(meta, null, 2) + "\n");
  return { prefab: { id: opts.name, root, file, dir, meta }, dir, replaced };
}

/** Up to 8 roles, one per most-used family, named after the family's base block. */
export function autoRoles(s: Snapshot, index?: PaletteIndex): Record<string, string[]> {
  const counts = new Map<string, { n: number; blocks: Set<string> }>();
  const hist = new Array<number>(s.palette.length).fill(0);
  for (const i of s.blocks) hist[i]!++;
  s.palette.forEach((st, i) => {
    if (i === 0 || !hist[i]) return;
    const id = stateId(st);
    const fam = index?.familyOfBlock(id)?.id ?? id;
    let c = counts.get(fam);
    if (!c) counts.set(fam, (c = { n: 0, blocks: new Set() }));
    c.n += hist[i]!;
    c.blocks.add(id);
  });
  const roles: Record<string, string[]> = {};
  for (const [fam, c] of [...counts].sort((a, b) => b[1].n - a[1].n).slice(0, 8)) roles[fam.slice(fam.indexOf(":") + 1)] = [fam, ...[...c.blocks].filter((b) => b !== fam)].sort();
  return roles;
}
