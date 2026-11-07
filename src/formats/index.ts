import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { Registry } from "../assets/registry.js";
import { stateId } from "../core/blockstate.js";
import { formatVec, type Box, type Vec3 } from "../core/region.js";
import type { Document, Facing } from "../document/document.js";
import { decodeNative, encodeNative } from "../document/native.js";
import type { PaletteBook } from "../palette/pick.js";
import type { AutosketchPlugin } from "../plugins/types.js";
import { materialList, type MaterialList } from "./materials.js";
import { isGzip, readNbt } from "./nbt.js";
import { documentFromSnapshot, snapshotBlockCount, snapshotOf, type Snapshot } from "./snapshot.js";
import { decodeBlueprint, encodeBlueprint, isBlueprint } from "./axiom.js";
import { decodeSponge, encodeSponge, type Decoded, type SpongeVersion } from "./sponge.js";
import { decodeStructure, encodeStructure, splitToFit } from "./structure.js";
import { decodeLitematic, encodeLitematic, type LitematicRegion } from "./litematic.js";

/**
 * Export and import (docs/design/08-formats.md). Export writes a normalised snapshot of the
 * document to Axiom (.schem), Create (.nbt) or any path; import reads any readable format into a
 * fresh document.
 */

export type ExportFormat = "schem" | "bp" | "nbt" | "litematic" | "native";
export type ExportTarget = "axiom" | "create" | "path";

export const EXTENSIONS: Record<ExportFormat, string> = { schem: ".schem", bp: ".bp", nbt: ".nbt", litematic: ".litematic", native: ".autosketch" };

/** Create's default `maxTotalSchematicSize`, in KB. */
export const CREATE_DEFAULT_LIMIT_KB = 256;

export interface ExportRequest {
  format?: ExportFormat;
  target?: ExportTarget;
  /** File or folder for target "path". */
  path?: string;
  /** File name without extension (default: the document name). */
  name?: string;
  /** Local box to export (default: the whole document). */
  region?: Box;
  schemVersion?: SpongeVersion;
  includeAir?: boolean;
  /** Split a Create export that is over the size limit into tiles. */
  split?: boolean;
  overwrite?: boolean;
  author?: string;
}

export interface ExportEnv {
  /** Instance root (for targets axiom and create). */
  instanceRoot?: string;
  /** Folder used when no target is given (the document's exports/ folder). */
  defaultDir: string;
  /** DataVersion of the target instance; falls back to the document's. */
  dataVersion?: number;
  registry?: Registry;
  plugins?: readonly AutosketchPlugin[];
  /** Create size limit in KB (default: read from the instance config, else 256). */
  createLimitKb?: number;
  /** Renders a .bp thumbnail (PNG) of a local region; a blank one is used without it. */
  thumbnail?: (region: Box) => Promise<Buffer>;
}

export interface ExportResult {
  format: ExportFormat;
  files: { path: string; bytes: number; at?: Vec3 }[];
  size: Vec3;
  /** Document-local position of the exported (0,0,0). */
  offset: Vec3;
  blocks: number;
  hint: string;
  materials?: MaterialList;
  limitKb?: number;
  warnings: string[];
}

export async function exportDocument(doc: Document, req: ExportRequest, env: ExportEnv): Promise<ExportResult> {
  const warnings: string[] = [];
  const target = req.target;
  const format = req.format ?? defaultFormat(target, req.path);
  if (target === "path" && !req.path) throw new Error('target "path" needs a path');
  if (target && target !== "path" && !env.instanceRoot) throw new Error(`target "${target}" needs a Minecraft instance; use target "path" instead`);

  const snap = snapshotOf(doc, req.region);
  if (env.dataVersion) {
    if (doc.meta.dataVersion && doc.meta.dataVersion !== env.dataVersion) warnings.push(`document DataVersion ${doc.meta.dataVersion} differs from the instance's ${env.dataVersion}; wrote ${env.dataVersion}`);
    snap.dataVersion = env.dataVersion;
  }
  if (req.author) snap.author = req.author;
  if (env.registry) {
    const unknown = [...new Set(snap.palette.map(stateId).filter((id) => id !== "minecraft:air" && !env.registry!.get(id)))];
    if (unknown.length) warnings.push(`${unknown.length} block id${unknown.length > 1 ? "s" : ""} not in this instance (kept): ${unknown.slice(0, 8).join(", ")}${unknown.length > 8 ? " …" : ""}`);
  }

  const name = req.name ?? doc.meta.name;
  if (!/^[\w-][\w .-]{0,63}$/.test(name) || name.includes("..")) throw new Error(`export name must be letters, digits, space, _ . or - (max 64; got "${name}")`);
  snap.name = name;

  // Where to write.
  const ext = EXTENSIONS[format];
  let file: string;
  let ours = false;
  if (target === "path") {
    const p = resolve(req.path!);
    file = extname(p) ? p : join(p, name + ext);
  } else if (target === "create") file = join(env.instanceRoot!, "schematics", name + ext);
  else if (target === "axiom") file = join(env.instanceRoot!, ...(format === "bp" ? ["config", "axiom", "blueprints"] : ["schematics"]), name + ext);
  else {
    file = join(env.defaultDir, name + ext);
    ours = true;
  }
  const overwrite = ours || !!req.overwrite;

  let thumbnail: Buffer | undefined;
  if (format === "bp") {
    if (snap.blockEntities.length || snap.entities.length)
      warnings.push(`left out ${[snap.blockEntities.length ? `${snap.blockEntities.length} block entities (chest contents, sign text…)` : "", snap.entities.length ? `${snap.entities.length} entities` : ""].filter(Boolean).join(" and ")}: their .bp layout isn't verified yet. Export format "schem" to keep them.`);
    if (env.thumbnail) {
      const region = req.region ?? doc.localBounds()!;
      try {
        thumbnail = await env.thumbnail(region);
      } catch (e) {
        warnings.push(`thumbnail failed (${(e as Error).message}); wrote a blank one`);
      }
    }
  }

  const encode = (s: Snapshot): Buffer => {
    switch (format) {
      case "bp":
        return encodeBlueprint(s, { ...(thumbnail ? { thumbnail } : {}), ...(req.includeAir ? { includeAir: true } : {}) });
      case "schem":
        return encodeSponge(s, { ...(req.schemVersion ? { version: req.schemVersion } : {}) });
      case "nbt":
        return encodeStructure(s, { ...(req.includeAir ? { includeAir: true } : {}) });
      case "litematic":
        return encodeLitematic(s);
      case "native":
        return req.region ? encodeNative(documentFromSnapshot(s, { name: s.name, dataVersion: s.dataVersion, front: s.front, source: doc.meta.name }, { seed: doc.meta.seed })) : encodeNative(doc);
      default:
        throw new Error(`unsupported format ${format}`);
    }
  };

  const result: ExportResult = { format, files: [], size: snap.size, offset: snap.offset, blocks: snapshotBlockCount(snap), hint: "", warnings };
  const isCreate = target === "create" || format === "nbt";
  if (isCreate) result.materials = materialList(snap, env.plugins);

  const buf = encode(snap);
  const limitKb = isCreate ? env.createLimitKb ?? (env.instanceRoot ? await readCreateLimitKb(env.instanceRoot) : undefined) ?? CREATE_DEFAULT_LIMIT_KB : undefined;
  if (limitKb !== undefined) result.limitKb = limitKb;

  if (limitKb !== undefined && buf.length > limitKb * 1024) {
    if (!req.split)
      throw new Error(
        `the export is ${Math.ceil(buf.length / 1024)} KB, over Create's ${limitKb} KB schematic limit (maxTotalSchematicSize). ` +
          "Pass split:true to write it as tiles with a placement guide, or export a region at a time.",
      );
    const pieces = splitToFit(snap, limitKb * 1024, encode);
    const files = pieces.map((p) => ({ file: join(dirname(file), p.snapshot.name + ext), buf: p.buf, at: p.at }));
    if (!overwrite) for (const f of files) await refuseExisting(f.file);
    for (const f of files) {
      await writeAtomic(f.file, f.buf);
      result.files.push({ path: f.file, bytes: f.buf.length, at: f.at });
    }
    const guide = [`${name}: ${pieces.length} pieces; place each piece's minimum corner at the offset from the first piece's anchor`, ...files.map((f) => `${basename(f.file)} at ${formatVec(f.at)}`)].join("\n");
    const guideFile = join(dirname(file), `${name}_placement.txt`);
    await writeAtomic(guideFile, Buffer.from(guide + "\n"));
    result.files.push({ path: guideFile, bytes: guide.length + 1 });
  } else {
    if (!overwrite) await refuseExisting(file);
    await writeAtomic(file, buf);
    result.files.push({ path: file, bytes: buf.length });
  }

  result.hint = hintFor(target, format, result.files.filter((f) => !f.path.endsWith(".txt")).map((f) => basename(f.path, ext)));
  return result;
}

function defaultFormat(target: ExportTarget | undefined, path: string | undefined): ExportFormat {
  if (target === "create") return "nbt";
  if (target === "axiom") return "bp";
  if (target === "path" && path) {
    const ext = extname(path).toLowerCase();
    for (const [f, e] of Object.entries(EXTENSIONS)) if (e === ext) return f as ExportFormat;
    if (ext) throw new Error(`can't tell the format from "${ext}"; pass format (schem, bp, nbt, litematic or native)`);
  }
  return "schem";
}

function hintFor(target: ExportTarget | undefined, format: ExportFormat, names: string[]): string {
  const list = names.join(", ");
  if (target === "create") return `In game: Schematic Table → select ${list} → upload, then print it with a Schematicannon.`;
  if (target === "axiom" && format === "bp") return `In game: Axiom → Blueprints → ${list}.`;
  if (target === "axiom") return `In game: load ${list}.schem from the instance's schematics/ folder with Axiom (or //schem load with WorldEdit).`;
  if (format === "bp") return "Copy into <instance>/config/axiom/blueprints/ to see it in Axiom's blueprint browser.";
  if (format === "nbt") return "Copy into the instance's schematics/ folder for Create, or a world's generated/<namespace>/structure/ folder for structure blocks.";
  if (format === "schem") return "Works with Axiom, WorldEdit and FAWE (schematics/ folder).";
  if (format === "litematic") return "Copy into the instance's schematics/ folder and load it from Litematica's Load Schematics menu.";
  return "Open with doc_open({path}).";
}

/** Reads `maxTotalSchematicSize` from the instance's Create server config, when present. */
export async function readCreateLimitKb(instanceRoot: string): Promise<number | undefined> {
  for (const rel of ["config/create-server.toml", "defaultconfigs/create-server.toml"]) {
    try {
      const m = /^\s*maxTotalSchematicSize\s*=\s*(\d+)/m.exec(await readFile(join(instanceRoot, rel), "utf8"));
      if (m) return Number(m[1]);
    } catch {
      /* not there */
    }
  }
  return undefined;
}

async function refuseExisting(file: string): Promise<void> {
  try {
    await access(file);
  } catch {
    return;
  }
  throw new Error(`${file} already exists; pass overwrite:true to replace it, or choose another name`);
}

async function writeAtomic(file: string, buf: Buffer): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, buf);
  await rename(tmp, file);
}

// -- import ---------------------------------------------------------------------------------------

export type ImportFormat = "schem" | "nbt" | "native" | "bp" | "litematic" | "schematic";

/** Detects a file's format from its contents (falls back to the extension for error messages). */
export function detectFormat(buf: Buffer, path = ""): ImportFormat {
  const ext = extname(path).toLowerCase();
  if (isBlueprint(buf)) return "bp";
  if (ext === ".litematic") return "litematic";
  let root;
  try {
    root = readNbt(buf);
  } catch {
    throw new Error(`${basename(path) || "file"} is not an NBT schematic${isGzip(buf) ? " (gzip, but not NBT inside)" : ""}`);
  }
  const v = root.value;
  if (root.name === "Autosketch" || v.Version && v.Meta && v.Sections) return "native";
  if (v.Schematic || (v.Version && (v.BlockData || v.Blocks || v.Palette))) return "schem";
  if (v.Materials && v.Blocks) return "schematic";
  if (v.size && v.blocks) return "nbt";
  if (v.Regions) return "litematic";
  throw new Error(`${basename(path) || "file"} is NBT but not a schematic format Autosketch reads (.schem, .nbt, .autosketch)`);
}

export interface Imported {
  doc: Document;
  format: ImportFormat;
  warnings: string[];
}

/** Reads a schematic file into a fresh document named `name`. */
export async function importFile(path: string, opts: { name: string; registry?: Registry; dataVersion?: number; palettes?: PaletteBook; front?: Facing }): Promise<Imported> {
  const buf = await readFile(path);
  const format = detectFormat(buf, path);
  const warnings: string[] = [];
  let doc: Document;
  if (format === "native") {
    doc = decodeNative(buf, opts.palettes ? { palettes: opts.palettes } : {});
    doc.meta.source = path;
  } else if (format === "schem" || format === "nbt" || format === "bp" || format === "litematic") {
    const ro = opts.registry ? { registry: opts.registry } : {};
    const lite = format === "litematic" ? decodeLitematic(buf, ro) : undefined;
    const dec: Decoded = lite ?? (format === "schem" ? decodeSponge(buf, ro) : format === "nbt" ? decodeStructure(buf, ro) : decodeBlueprint(buf, ro));
    warnings.push(...dec.warnings);
    doc = documentFromSnapshot(dec.snapshot, { name: opts.name, dataVersion: dec.snapshot.dataVersion, source: path, ...(opts.front ? { front: opts.front } : {}) });
    if (lite && lite.regions.length > 1) addRegionComponents(doc, lite.regions);
    if (opts.palettes) doc.palettes = opts.palettes;
  } else {
    throw new Error(`can't import ${basename(path)}: legacy MCEdit .schematic files need a legacy ID map (not supported)`);
  }
  doc.meta.name = opts.name;
  if (opts.front) doc.meta.front = opts.front;
  if (opts.dataVersion && doc.meta.dataVersion && doc.meta.dataVersion !== opts.dataVersion)
    warnings.push(`file DataVersion ${doc.meta.dataVersion} differs from this instance's ${opts.dataVersion}; blocks renamed between versions are not upgraded`);
  return { doc, format, warnings };
}

/** Registers each Litematica region as a component (no journal entry: the document is fresh). */
function addRegionComponents(doc: Document, regions: LitematicRegion[]): void {
  const used = new Set<string>();
  for (const r of regions) {
    const base = r.name.toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").replace(/^[^a-z0-9_]+/, "") || "region";
    let id = base;
    for (let i = 2; used.has(id); i++) id = `${base}_${i}`;
    used.add(id);
    doc.components.set(id, { id, kind: "litematica_region", box: doc.boxToStore(r.box), anchors: {}, tags: [], notes: `Litematica region "${r.name}"` });
  }
}
