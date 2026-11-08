import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { mapLimit } from "../core/async.js";
import { codeHash } from "../core/codehash.js";
import { defaultCacheDir, pruneCache } from "./cache.js";
import {
  blockstateProperties,
  FACES,
  isFullCube,
  ModelResolver,
  parseBlockstate,
  rotateFace,
  texturePath,
  selectModels,
  type Face,
  type Props,
  type ResolvedModel,
} from "./models.js";
import { parseJsonLenient, type PackSource, type PackStack } from "./pack.js";

export type BlockShape = "full" | "partial" | "none";
export type Renderable = "exact" | "approximate" | "fallback";

export interface BlockInfo {
  id: string; // "create:andesite_casing"
  namespace: string;
  displayName?: string;
  properties: Record<string, string[]>;
  defaults: Props;
  /** From the default state's model. */
  shape: BlockShape;
  renderable: Renderable;
  /** Textures of the default state, per face direction (first element facing that way). */
  faceTextures: Partial<Record<Face, string>>;
  textures: string[];
  tinted: boolean;
  /** Vertex colour from model JSON (NeoForge), when the block is coloured that way. */
  vertexColor?: string;
  tags: string[];
  light?: number;
  transparent?: boolean;
  /** Layer that defines the block's blockstate (mod jar, base jar, …). */
  source: string;
  /** Set when properties/defaults come from complete vanilla data rather than inferred from assets. */
  exactProperties?: boolean;
}

export interface RegistryData {
  cacheVersion: string;
  fingerprint: string;
  mcVersion: string;
  builtMs: number;
  blocks: BlockInfo[];
  /** namespace → mod display name. */
  mods: Record<string, string>;
  warnings: string[];
}

/** Changes whenever the registry-building code changes, invalidating caches automatically. */
const CACHE_VERSION = codeHash(import.meta.url, ["./registry", "./models", "./pack"]);

export class Registry {
  private readonly byId: Map<string, BlockInfo>;
  private tagIndex?: Map<string, BlockInfo[]>;

  constructor(readonly data: RegistryData) {
    this.byId = new Map(data.blocks.map((b) => [b.id, b]));
  }

  get size(): number {
    return this.byId.size;
  }
  get(id: string): BlockInfo | undefined {
    return this.byId.get(id.includes(":") ? id : `minecraft:${id}`);
  }
  has(id: string): boolean {
    return this.get(id) !== undefined;
  }
  all(): IterableIterator<BlockInfo> {
    return this.byId.values();
  }
  modName(namespace: string): string {
    return this.data.mods[namespace] ?? namespace;
  }
  withTag(tag: string): BlockInfo[] {
    if (!this.tagIndex) {
      this.tagIndex = new Map();
      for (const b of this.byId.values())
        for (const t of b.tags) {
          let l = this.tagIndex.get(t);
          if (!l) this.tagIndex.set(t, (l = []));
          l.push(b);
        }
    }
    return this.tagIndex.get(tag.replace(/^#/, "")) ?? [];
  }
  namespaces(): Map<string, number> {
    const out = new Map<string, number>();
    for (const b of this.byId.values()) out.set(b.namespace, (out.get(b.namespace) ?? 0) + 1);
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// Vanilla data (complete properties + defaults; see scripts/gen-vanilla-blocks.mjs)
// ---------------------------------------------------------------------------------------------

interface VanillaBlock {
  name: string;
  props?: Record<string, string[]>;
  def?: Props;
  light?: number;
  transparent?: boolean;
}

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data");

export async function loadVanillaBlocks(mcVersion: string): Promise<Record<string, VanillaBlock> | undefined> {
  try {
    const j = JSON.parse(await readFile(join(DATA_DIR, "vanilla", `${mcVersion}.json`), "utf8")) as { blocks: Record<string, VanillaBlock> };
    return j.blocks;
  } catch {
    return undefined;
  }
}

/**
 * Default value guess for modded blocks, whose blockstate files list values but not defaults.
 * Mirrors the conventions most blocks follow.
 */
export function guessDefault(prop: string, values: string[]): string {
  const has = (v: string) => values.includes(v);
  const pref: Record<string, string[]> = {
    facing: ["north", "up"],
    horizontal_facing: ["north"],
    half: ["bottom", "lower"],
    type: ["bottom", "single", "normal"],
    shape: ["straight", "north_south"],
    axis: ["y"],
    face: ["wall", "floor"],
    part: ["foot", "lower", "single", "middle"],
    hinge: ["left"],
    attachment: ["floor"],
  };
  for (const v of pref[prop] ?? []) if (has(v)) return v;
  if (has("false") && has("true")) return "false";
  if (has("none")) return "none";
  if (values.every((v) => /^-?\d+$/.test(v))) return String(Math.min(...values.map(Number)));
  return values[0]!;
}

// ---------------------------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------------------------

const DEFINING_ROLES = new Set(["base", "loader", "mod", "generated"]);
const BLOCKSTATE_RE = /^assets\/([^/]+)\/blockstates\/([^/]+)\.json$/;
const TAG_RE = /^data\/([^/]+)\/tags\/blocks?\/(.+)\.json$/;

export interface BuildOptions {
  mcVersion: string;
  /** Cache directory; `false` disables caching. Defaults to $AUTOSKETCH_CACHE or ~/.cache/autosketch. */
  cacheDir?: string | false;
  concurrency?: number;
  onProgress?: (msg: string) => void;
}


/** Loads the registry from cache when the stack is unchanged, otherwise builds and caches it. */
export async function loadRegistry(stack: PackStack, opts: BuildOptions): Promise<{ registry: Registry; cached: boolean }> {
  const fingerprint = stack.fingerprint();
  const cacheDir = opts.cacheDir === false ? undefined : (opts.cacheDir ?? defaultCacheDir());
  const stem = `registry-${fingerprint.slice(0, 16)}`;
  const file = cacheDir && join(cacheDir, `${stem}.json.gz`);
  if (cacheDir) await pruneCache(cacheDir, { match: /^(registry-[0-9a-f]+)\.json\.gz$/, current: stem });
  if (file) {
    try {
      const data = JSON.parse(gunzipSync(await readFile(file)).toString("utf8")) as RegistryData;
      if (data.cacheVersion === CACHE_VERSION && data.fingerprint === fingerprint) return { registry: new Registry(data), cached: true };
    } catch {
      /* cache miss */
    }
  }
  const data = await buildRegistryData(stack, fingerprint, opts);
  if (file) {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`; // unique: parallel loads may save at once
    await writeFile(tmp, gzipSync(JSON.stringify(data)));
    await rename(tmp, file);
  }
  return { registry: new Registry(data), cached: false };
}

export async function buildRegistryData(stack: PackStack, fingerprint: string, opts: BuildOptions): Promise<RegistryData> {
  const t0 = Date.now();
  const warnings: string[] = [];
  const conc = opts.concurrency ?? 64;
  const vanilla = await loadVanillaBlocks(opts.mcVersion);
  if (!vanilla) warnings.push(`no vanilla block data for ${opts.mcVersion}; vanilla properties/defaults are inferred from assets`);

  // A block exists when the game, the loader, a mod, or a generated pack defines its blockstate.
  // Resource packs only restyle blocks: their blockstates for absent mods must not create blocks.
  const defined = new Map<string, PackSource>();
  for (const layer of stack.layers) {
    if (!DEFINING_ROLES.has(layer.role)) continue;
    for (const p of layer.paths()) if (BLOCKSTATE_RE.test(p)) defined.set(p, layer);
  }
  opts.onProgress?.(`resolving ${defined.size} blockstates`);

  const resolver = new ModelResolver(stack);
  const entries = [...defined.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  const blocks = (
    await mapLimit(entries, conc, async ([path, layer]) => {
      const m = BLOCKSTATE_RE.exec(path)!;
      const id = `${m[1]}:${m[2]}`;
      try {
        return await buildBlock(id, m[1]!, path, layer, stack, resolver, vanilla?.[id]);
      } catch (e) {
        warnings.push(`${id}: ${(e as Error).message}`);
        return undefined;
      }
    })
  ).filter((b): b is BlockInfo => !!b);

  // Vanilla blocks without blockstate assets (air variants, moving_piston…).
  const have = new Set(blocks.map((b) => b.id));
  for (const [id, v] of Object.entries(vanilla ?? {})) {
    if (have.has(id)) continue;
    blocks.push({
      id,
      namespace: "minecraft",
      displayName: v.name,
      properties: v.props ?? {},
      defaults: v.def ?? {},
      shape: "none",
      renderable: "fallback",
      faceTextures: {},
      textures: [],
      tinted: false,
      tags: [],
      source: "vanilla-data",
      exactProperties: true,
    });
  }

  opts.onProgress?.("reading block tags");
  const tagMembers = await loadBlockTags(stack, conc);
  const byId = new Map(blocks.map((b) => [b.id, b]));
  for (const [tag, members] of tagMembers) for (const id of members) byId.get(id)?.tags.push(tag);
  for (const b of blocks) b.tags.sort();

  const mods = await loadModNames(stack);
  blocks.sort((a, b) => (a.id < b.id ? -1 : 1));
  opts.onProgress?.(`registry: ${blocks.length} blocks, ${resolver.size} models, ${tagMembers.size} tags`);
  return { cacheVersion: CACHE_VERSION, fingerprint, mcVersion: opts.mcVersion, builtMs: Date.now() - t0, blocks, mods, warnings };
}

async function buildBlock(
  id: string,
  namespace: string,
  path: string,
  layer: PackSource,
  stack: PackStack,
  resolver: ModelResolver,
  vanilla: VanillaBlock | undefined,
): Promise<BlockInfo> {
  // The topmost layer's blockstate decides appearance (resource packs may override it).
  const def = parseBlockstate(await stack.readJson(path));
  let properties = blockstateProperties(def);
  let defaults: Props;
  if (vanilla) {
    properties = vanilla.props ?? {};
    defaults = vanilla.def ?? {};
  } else {
    defaults = Object.fromEntries(Object.entries(properties).map(([k, vs]) => [k, guessDefault(k, vs)]));
  }

  const refs = selectModels(def, defaults);
  const models: ResolvedModel[] = await Promise.all(refs.map((r) => resolver.resolve(r.model)));
  const placed = models.map((model, i) => ({ model, x: refs[i]!.x, y: refs[i]!.y }));
  const elements = models.flatMap((m) => m.elements);

  const faceTextures: BlockInfo["faceTextures"] = {};
  const textures = new Set<string>();
  let tinted = false;
  let vertexColor: string | undefined;
  for (const { model, x, y } of placed)
    for (const e of model.elements)
      for (const f of FACES) {
        const face = e.faces[f];
        if (!face || face.texture === "#missing") continue;
        textures.add(face.texture);
        // Skip textures that don't exist as files (generated at runtime, e.g. XyCraft's cloud layer).
        if (stack.has(texturePath(face.texture))) faceTextures[rotateFace(f, x, y)] ??= face.texture;
        if (face.tintindex !== undefined && face.tintindex >= 0) tinted = true;
        vertexColor ??= face.color;
      }
  if (textures.size === 0) for (const m of models) if (m.particle) textures.add(m.particle);

  const issues = new Set(models.flatMap((m) => m.issues));
  const renderable: Renderable = elements.length === 0 ? "fallback" : issues.size > 0 || refs.length === 0 ? "approximate" : "exact";

  const info: BlockInfo = {
    id,
    namespace,
    properties,
    defaults,
    shape: elements.length === 0 ? "none" : isFullCube(placed) ? "full" : "partial",
    renderable,
    faceTextures,
    textures: [...textures],
    tinted,
    tags: [],
    source: layer.id,
  };
  if (vertexColor) info.vertexColor = vertexColor;
  if (vanilla) {
    info.displayName = vanilla.name;
    info.exactProperties = true;
    if (vanilla.light) info.light = vanilla.light;
    if (vanilla.transparent) info.transparent = true;
  }
  return info;
}

type TagEntry = string | { id: string; required?: boolean };

/** Merges tag files across all layers (respecting `replace`) and expands nested tag references. */
export async function loadBlockTags(stack: PackStack, concurrency = 64): Promise<Map<string, Set<string>>> {
  const paths = stack.list("data/").filter((p) => TAG_RE.test(p));
  const raw = new Map<string, string[]>();
  await mapLimit(paths, concurrency, async (p) => {
    const m = TAG_RE.exec(p)!;
    const tag = `${m[1]}:${m[2]}`;
    let values = raw.get(tag) ?? [];
    for (const { data } of await stack.readAll(p)) {
      try {
        const j = parseJsonLenient(data, p) as { replace?: boolean; values?: TagEntry[] };
        const ids = (j.values ?? []).map((v) => (typeof v === "string" ? v : v.id)).filter((v): v is string => typeof v === "string");
        values = j.replace ? ids : values.concat(ids);
      } catch {
        /* malformed tag file: ignored, like the game does */
      }
    }
    raw.set(tag, values);
  });

  const resolved = new Map<string, Set<string>>();
  const expand = (tag: string, stackGuard: Set<string>): Set<string> => {
    const done = resolved.get(tag);
    if (done) return done;
    const out = new Set<string>();
    if (stackGuard.has(tag)) return out;
    stackGuard.add(tag);
    for (const v of raw.get(tag) ?? []) {
      if (v.startsWith("#")) for (const x of expand(normNs(v.slice(1)), stackGuard)) out.add(x);
      else out.add(normNs(v));
    }
    stackGuard.delete(tag);
    resolved.set(tag, out);
    return out;
  };
  for (const tag of raw.keys()) expand(tag, new Set());
  return resolved;
}

const normNs = (id: string) => (id.includes(":") ? id : `minecraft:${id}`);

/** namespace → display name, from mods.toml (NeoForge/Forge) and fabric.mod.json. */
async function loadModNames(stack: PackStack): Promise<Record<string, string>> {
  const out: Record<string, string> = { minecraft: "Minecraft" };
  for (const layer of stack.layers) {
    if (layer.role !== "mod" && layer.role !== "loader") continue;
    for (const file of ["META-INF/neoforge.mods.toml", "META-INF/mods.toml"]) {
      if (!layer.has(file)) continue;
      try {
        for (const [id, name] of parseModsToml((await layer.read(file)).toString("utf8"))) out[id] ??= name;
      } catch {
        /* ignore */
      }
    }
    if (layer.has("fabric.mod.json")) {
      try {
        const j = parseJsonLenient(await layer.read("fabric.mod.json")) as { id?: string; name?: string };
        if (j.id) out[j.id] ??= j.name ?? j.id;
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

/** Minimal extraction of modId/displayName pairs from [[mods]] tables. */
export function parseModsToml(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const block of text.split(/^\s*\[\[mods\]\]\s*$/m).slice(1)) {
    const body = block.split(/^\s*\[/m)[0] ?? "";
    const id = /^\s*modId\s*=\s*["']([^"']+)["']/m.exec(body)?.[1];
    const name = /^\s*displayName\s*=\s*["']([^"']+)["']/m.exec(body)?.[1];
    if (id) out.push([id, name ?? id]);
  }
  return out;
}
