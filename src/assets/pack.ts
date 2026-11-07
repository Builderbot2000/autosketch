import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { FileByteSource } from "./bytes.js";
import { ZipArchive, type EntryFilter } from "./zip.js";
import type { InstanceInfo, LayerRole, LayerSpec } from "./locate.js";

/** One layer of the virtual filesystem: a jar, zip pack, folder pack, or a sub-folder of one. */
export interface PackSource {
  readonly id: string;
  readonly role: LayerRole;
  has(path: string): boolean;
  read(path: string): Promise<Buffer>;
  paths(): Iterable<string>;
}

type Scope = "assets" | "data" | undefined;

function inScope(path: string, scope: Scope): boolean {
  return scope === undefined || path.startsWith(scope + "/");
}

export class ZipPackSource implements PackSource {
  constructor(
    readonly id: string,
    readonly role: LayerRole,
    readonly archive: ZipArchive,
    private readonly prefix = "",
    private readonly scope?: Scope,
  ) {}

  has(path: string): boolean {
    return inScope(path, this.scope) && this.archive.has(this.prefix + path);
  }
  read(path: string): Promise<Buffer> {
    return this.archive.read(this.prefix + path);
  }
  *paths(): Iterable<string> {
    for (const name of this.archive.entries.keys()) {
      if (!name.startsWith(this.prefix)) continue;
      const p = name.slice(this.prefix.length);
      if (inScope(p, this.scope)) yield p;
    }
  }
  /** A view of a sub-folder of the same archive (built-in packs, overlays). */
  sub(id: string, role: LayerRole, dir: string, scope?: Scope): ZipPackSource {
    return new ZipPackSource(id, role, this.archive, this.prefix + dir.replace(/\/?$/, "/"), scope);
  }
}

export class DirPackSource implements PackSource {
  private constructor(
    readonly id: string,
    readonly role: LayerRole,
    private readonly root: string,
    private readonly files: Set<string>,
    private readonly scope?: Scope,
  ) {}

  static async open(id: string, role: LayerRole, root: string, scope?: Scope): Promise<DirPackSource> {
    const files = new Set<string>();
    for (const top of ["assets", "data"]) {
      await walk(join(root, top), top, files);
    }
    try {
      if ((await stat(join(root, "pack.mcmeta"))).isFile()) files.add("pack.mcmeta");
    } catch {
      /* no mcmeta */
    }
    return new DirPackSource(id, role, root, files, scope);
  }

  has(path: string): boolean {
    return inScope(path, this.scope) && this.files.has(path);
  }
  read(path: string): Promise<Buffer> {
    return readFile(join(this.root, path));
  }
  *paths(): Iterable<string> {
    for (const p of this.files) if (inScope(p, this.scope)) yield p;
  }
  sub(id: string, role: LayerRole, dir: string, scope?: Scope): Promise<DirPackSource> {
    return DirPackSource.open(id, role, join(this.root, dir), scope);
  }
}

async function walk(abs: string, rel: string, out: Set<string>): Promise<void> {
  let ents;
  try {
    ents = await readdir(abs, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    ents.map(async (e) => {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) await walk(join(abs, e.name), r, out);
      else if (e.isFile()) out.add(r);
    }),
  );
}

/**
 * Ordered stack of pack layers, lowest priority first, resolved like the game's resource manager:
 * single files (models, textures, blockstates) come from the topmost layer that has them; tags and
 * other merging data can be read from every layer with `readAll`.
 */
export class PackStack {
  constructor(readonly layers: readonly PackSource[]) {}

  resolve(path: string): PackSource | undefined {
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const l = this.layers[i]!;
      if (l.has(path)) return l;
    }
    return undefined;
  }

  has(path: string): boolean {
    return this.resolve(path) !== undefined;
  }

  async read(path: string): Promise<Buffer | undefined> {
    return this.resolve(path)?.read(path);
  }

  async readJson<T = unknown>(path: string): Promise<T | undefined> {
    const buf = await this.read(path);
    return buf === undefined ? undefined : (parseJsonLenient(buf, path) as T);
  }

  /** Every layer's copy of a file, lowest priority first (for tags and other merged data). */
  async readAll(path: string): Promise<{ source: PackSource; data: Buffer }[]> {
    const hits = this.layers.filter((l) => l.has(path));
    return Promise.all(hits.map(async (source) => ({ source, data: await source.read(path) })));
  }

  /** Union of paths under a prefix across all layers, sorted. */
  list(prefix: string, suffix = ""): string[] {
    const out = new Set<string>();
    for (const l of this.layers) {
      for (const p of l.paths()) if (p.startsWith(prefix) && p.endsWith(suffix)) out.add(p);
    }
    return [...out].sort();
  }

  /** Namespaces present under `assets/` or `data/`. */
  namespaces(kind: "assets" | "data" = "assets"): string[] {
    const out = new Set<string>();
    for (const l of this.layers) {
      for (const p of l.paths()) {
        if (!p.startsWith(kind + "/")) continue;
        const ns = p.slice(kind.length + 1, p.indexOf("/", kind.length + 1));
        if (ns) out.add(ns);
      }
    }
    return [...out].sort();
  }
}

/** Mojang's JSON parser tolerates some things JSON.parse doesn't (comments, BOM); packs rely on it. */
export function parseJsonLenient(buf: Buffer, label = "json"): unknown {
  let text = buf.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(stripJsonComments(text).replace(/,\s*([}\]])/g, "$1"));
    } catch (e) {
      throw new Error(`invalid JSON in ${label}: ${(e as Error).message}`);
    }
  }
}

function stripJsonComments(s: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      out += c;
      if (c === "\\") out += s[++i] ?? "";
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === "/" && s[i + 1] === "/") {
      while (i < s.length && s[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && s[i + 1] === "*") {
      i += 2;
      while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Building a stack from a located instance
// ---------------------------------------------------------------------------------------------

/** Only these parts of jars matter to us; skipping classes keeps indexes small. */
const JAR_FILTER: EntryFilter = (n) =>
  n.startsWith("assets/") ||
  n.startsWith("data/") ||
  n.startsWith("resourcepacks/") ||
  n.startsWith("META-INF/jarjar/") ||
  /^[^/]+\/(assets|data)\//.test(n) || // pack folders that mods register in code under their own names
  /^[^/]+\/pack\.mcmeta$/.test(n) ||
  n === "pack.mcmeta" ||
  n === "META-INF/neoforge.mods.toml" ||
  n === "META-INF/mods.toml" ||
  n === "fabric.mod.json";

/** Pack formats per game version, used to apply pack.mcmeta overlays. */
const PACK_FORMATS: Record<string, { resource: number; data: number }> = {
  "1.20.5": { resource: 32, data: 41 },
  "1.20.6": { resource: 32, data: 41 },
  "1.21": { resource: 34, data: 48 },
  "1.21.1": { resource: 34, data: 48 },
  "1.21.4": { resource: 46, data: 61 },
};

export interface OpenStackResult {
  stack: PackStack;
  warnings: string[];
  stats: { layers: number; archives: number; nestedJars: number; entries: number; ms: number };
}

export async function openStack(info: InstanceInfo, opts: { concurrency?: number } = {}): Promise<OpenStackResult> {
  const t0 = Date.now();
  const warnings = [...info.warnings];
  const formats = PACK_FORMATS[info.mcVersion];
  if (!formats) warnings.push(`unknown pack format for ${info.mcVersion}; pack overlays will be ignored`);

  // Open every archive/dir layer concurrently, preserving order.
  const opened: (PackSource[] | null)[] = await mapLimit(info.layers, opts.concurrency ?? 16, async (spec) => {
    try {
      return await openLayer(spec, warnings);
    } catch (e) {
      warnings.push(`skipped layer ${spec.id}: ${(e as Error).message}`);
      return null;
    }
  });

  // Built-in packs (shipped inside mod jars under resourcepacks/<name>/) resolve against the opened jars.
  const jarSources = opened.flat().filter((s): s is ZipPackSource => s instanceof ZipPackSource && (s.role === "mod" || s.role === "base"));
  const layers: PackSource[] = [];
  for (let i = 0; i < info.layers.length; i++) {
    const spec = info.layers[i]!;
    let srcs = opened[i];
    if (spec.kind === "builtin") {
      const found = findBuiltinPack(spec.name, jarSources);
      if (found) srcs = [found.host.sub(spec.id, spec.role, found.dir)];
      else warnings.push(`built-in pack "${spec.name}" not found in the game or mod jars`);
    }
    for (const s of srcs ?? []) layers.push(...(await withOverlays(s, formats, warnings)));
  }

  let entries = 0;
  for (const l of layers) for (const _ of l.paths()) entries++;
  return {
    stack: new PackStack(layers),
    warnings,
    stats: {
      layers: layers.length,
      archives: layers.filter((l) => l instanceof ZipPackSource).length,
      nestedJars: layers.filter((l) => l.id.includes("!/")).length,
      entries,
      ms: Date.now() - t0,
    },
  };
}

/**
 * Finds a pack that a mod registers in code. The conventional location is `resourcepacks/<name>/`,
 * but mods can use any folder (XyCraft registers "add_xycraft_overrides_stone" from `OverridesStone/`),
 * so fall back to matching top-level pack folders by normalised name.
 */
export function findBuiltinPack(entry: string, jars: readonly ZipPackSource[]): { host: ZipPackSource; dir: string } | undefined {
  const name = entry.replace(/^mod\/[^:]+:/, "");
  for (const j of jars) {
    if (j.archive.has(`resourcepacks/${name}/pack.mcmeta`) || hasPrefix(j.archive, `resourcepacks/${name}/assets/`)) {
      return { host: j, dir: `resourcepacks/${name}` };
    }
  }
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const target = norm(name);
  const modHint = /^mod\/([^:]+):/.exec(entry)?.[1];
  let best: { host: ZipPackSource; dir: string; score: number } | undefined;
  for (const j of jars) {
    for (const dir of topLevelPackDirs(j.archive)) {
      const d = norm(dir);
      if (d.length < 6 || !target.includes(d)) continue;
      // Prefer longer folder-name matches, then jars whose file name shares a token with the pack name.
      const jarName = norm(j.id);
      const tokenBonus = name.split(/[^a-z0-9]+/i).some((t) => t.length >= 4 && jarName.includes(t.toLowerCase())) ? 100 : 0;
      const modBonus = modHint && jarName.includes(norm(modHint)) ? 200 : 0;
      const score = d.length + tokenBonus + modBonus;
      if (!best || score > best.score) best = { host: j, dir, score };
    }
  }
  return best && { host: best.host, dir: best.dir };
}

function hasPrefix(archive: ZipArchive, prefix: string): boolean {
  for (const n of archive.entries.keys()) if (n.startsWith(prefix)) return true;
  return false;
}

const topDirCache = new WeakMap<ZipArchive, string[]>();
function topLevelPackDirs(archive: ZipArchive): string[] {
  let dirs = topDirCache.get(archive);
  if (!dirs) {
    const set = new Set<string>();
    for (const n of archive.entries.keys()) {
      const m = /^([^/]+)\/(assets|data)\//.exec(n);
      if (m && m[1] !== "resourcepacks") set.add(m[1]!);
    }
    dirs = [...set];
    topDirCache.set(archive, dirs);
  }
  return dirs;
}

async function openLayer(spec: LayerSpec, warnings: string[]): Promise<PackSource[]> {
  switch (spec.kind) {
    case "builtin":
      return []; // resolved after all jars are open
    case "dir":
      return [await DirPackSource.open(spec.id, spec.role, spec.path)];
    case "archive": {
      const archive = await ZipArchive.open(await FileByteSource.open(spec.path), spec.id, JAR_FILTER);
      const main = new ZipPackSource(spec.id, spec.role, archive);
      if (spec.role !== "mod" && spec.role !== "loader") return [main];
      // Jar-in-jar: nested jars that carry assets/data sit just below their parent.
      const nested: PackSource[] = [];
      for (const name of archive.entries.keys()) {
        if (!name.startsWith("META-INF/jarjar/") || !name.endsWith(".jar")) continue;
        try {
          const inner = await archive.openNested(name, JAR_FILTER);
          if (inner.entries.size > 0 && [...inner.entries.keys()].some((n) => n.startsWith("assets/") || n.startsWith("data/"))) {
            nested.push(new ZipPackSource(inner.label, spec.role, inner));
          }
        } catch (e) {
          warnings.push(`skipped nested jar ${spec.id}!/${name}: ${(e as Error).message}`);
        }
      }
      return [...nested, main];
    }
  }
}

type FormatRange = number | [number, number] | { min_inclusive: number; max_inclusive: number };

function formatMatches(range: FormatRange, f: number): boolean {
  if (typeof range === "number") return range === f;
  if (Array.isArray(range)) return f >= range[0] && f <= range[1];
  return f >= range.min_inclusive && f <= range.max_inclusive;
}

/** pack.mcmeta overlays: extra sub-folders applied on top of the pack when the format matches. */
async function withOverlays(src: PackSource, formats: { resource: number; data: number } | undefined, warnings: string[]): Promise<PackSource[]> {
  if (!formats || !src.has("pack.mcmeta")) return [src];
  if (!(src instanceof ZipPackSource) && !(src instanceof DirPackSource)) return [src];
  let meta: { overlays?: { entries?: { formats: FormatRange; directory: string }[] } };
  try {
    meta = parseJsonLenient(await src.read("pack.mcmeta"), `${src.id}/pack.mcmeta`) as typeof meta;
  } catch (e) {
    warnings.push((e as Error).message);
    return [src];
  }
  const out: PackSource[] = [src];
  for (const o of meta.overlays?.entries ?? []) {
    for (const [scope, f] of [["assets", formats.resource], ["data", formats.data]] as const) {
      if (!formatMatches(o.formats, f)) continue;
      const id = `${src.id}#overlay:${o.directory}:${scope}`;
      out.push(src instanceof ZipPackSource ? src.sub(id, src.role, o.directory, scope) : await src.sub(id, src.role, o.directory, scope));
    }
  }
  return out;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}
