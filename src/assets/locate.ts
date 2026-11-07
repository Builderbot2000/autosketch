import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { FileByteSource } from "./bytes.js";
import { ZipArchive } from "./zip.js";

/**
 * Where a layer came from. Order in `InstanceInfo.layers` is what matters for resolution;
 * the role is informational (and used for mod attribution and built-in pack lookup).
 */
export type LayerRole = "base" | "loader" | "mod" | "generated" | "datapack" | "builtin" | "openloader" | "resourcepack";

export type LayerSpec =
  | { kind: "archive"; id: string; role: LayerRole; path: string }
  | { kind: "dir"; id: string; role: LayerRole; path: string }
  /** A pack shipped inside the game or a mod jar under `resourcepacks/<name>/`. */
  | { kind: "builtin"; id: string; role: LayerRole; name: string };

export interface InstanceInfo {
  /** Game folder (mods/, config/, schematics/). For Prism/MultiMC this is the instance's minecraft/ folder. */
  root: string;
  launcher: "curseforge" | "prism" | "vanilla" | "generic";
  name: string;
  mcVersion: string;
  loader?: { name: string; version: string };
  /** Lowest priority first. */
  layers: LayerSpec[];
  warnings: string[];
}

export interface LocateOptions {
  /** Game version, required for a plain vanilla `.minecraft` with several versions installed. */
  version?: string;
  /** Explicit path to the client jar; overrides detection. */
  baseJar?: string;
}

export async function locateInstance(rootIn: string, opts: LocateOptions = {}): Promise<InstanceInfo> {
  const root = resolve(rootIn);
  if (!(await isDir(root))) throw new Error(`instance folder not found: ${root}`);
  if (await isFile(join(root, "minecraftinstance.json"))) return locateCurseForge(root, opts);
  if (await isFile(join(root, "instance.cfg"))) return locatePrism(root, opts);
  // Pointed at a Prism/MultiMC game folder (.minecraft or minecraft inside the instance).
  if (/^\.?minecraft$/.test(basename(root)) && (await isFile(join(root, "..", "instance.cfg")))) return locatePrism(resolve(root, ".."), opts);
  if (await isDir(join(root, "versions"))) return locateVanilla(root, opts);
  if (opts.baseJar) return locateGeneric(root, opts);
  throw new Error(
    `could not recognise ${root} as a Minecraft instance (no minecraftinstance.json, instance.cfg or versions/ folder). ` +
      `Pass baseJar to use it as a generic instance.`,
  );
}

// ---------------------------------------------------------------------------------------------

interface CurseForgeInstance {
  name?: string;
  gameVersion: string;
  baseModLoader?: { name?: string; forgeVersion?: string } | null;
}

async function locateCurseForge(root: string, opts: LocateOptions): Promise<InstanceInfo> {
  const meta = JSON.parse(await readFile(join(root, "minecraftinstance.json"), "utf8")) as CurseForgeInstance;
  const warnings: string[] = [];
  const mcVersion = opts.version ?? meta.gameVersion;
  // Instances live in <cf>/minecraft/Instances/<name>; shared installs in <cf>/minecraft/Install.
  const install = resolve(root, "..", "..", "Install");
  const baseJar = opts.baseJar ?? join(install, "versions", mcVersion, `${mcVersion}.jar`);
  if (!(await isFile(baseJar))) throw new Error(`base game jar not found at ${baseJar} (pass baseJar to override)`);

  let loader: InstanceInfo["loader"];
  let loaderJar: string | undefined;
  const loaderName = meta.baseModLoader?.name;
  if (loaderName) {
    const m = /^(neoforge|forge|fabric|quilt)-(.+)$/.exec(loaderName);
    if (m) {
      loader = { name: m[1]!, version: m[2]! };
      loaderJar = await findLoaderJar(install, loader, mcVersion);
      if (!loaderJar && (loader.name === "neoforge" || loader.name === "forge")) {
        warnings.push(`${loader.name} ${loader.version} jar not found under ${install}/libraries; its own assets will be missing`);
      }
    }
  }

  const layers = await modpackLayers(root, baseJar, loaderJar, warnings);
  return { root, launcher: "curseforge", name: meta.name ?? basename(root), mcVersion, loader, layers, warnings };
}

async function findLoaderJar(install: string, loader: { name: string; version: string }, mc: string): Promise<string | undefined> {
  const candidates =
    loader.name === "neoforge"
      ? [join(install, "libraries/net/neoforged/neoforge", loader.version, `neoforge-${loader.version}-universal.jar`)]
      : loader.name === "forge"
        ? [join(install, "libraries/net/minecraftforge/forge", `${mc}-${loader.version}`, `forge-${mc}-${loader.version}-universal.jar`)]
        : [];
  for (const c of candidates) if (await isFile(c)) return c;
  return undefined;
}

interface MmcPack {
  components?: { uid?: string; version?: string; cachedName?: string }[];
}

/** mmc-pack.json component uid → loader name. */
const MMC_LOADERS: Record<string, string> = {
  "net.neoforged": "neoforge",
  "net.minecraftforge": "forge",
  "net.fabricmc.fabric-loader": "fabric",
  "org.quiltmc.quilt-loader": "quilt",
};

/**
 * Prism Launcher / MultiMC (docs/design/02-assets-registry.md): `<data>/instances/<name>/` holds
 * `instance.cfg` (INI, `name=`) and `mmc-pack.json` (components with versions); the game folder
 * is `minecraft/` (Prism) or `.minecraft/` (MultiMC, older Prism). Jars come from the shared
 * `<data>/libraries/` maven cache.
 */
async function locatePrism(instDir: string, opts: LocateOptions): Promise<InstanceInfo> {
  const warnings: string[] = [];
  const cfg = await readFile(join(instDir, "instance.cfg"), "utf8").catch(() => "");
  const name = /^name=(.*)$/m.exec(cfg)?.[1]?.trim() || basename(instDir);
  let pack: MmcPack = {};
  try {
    pack = JSON.parse(await readFile(join(instDir, "mmc-pack.json"), "utf8")) as MmcPack;
  } catch {
    warnings.push(`no readable mmc-pack.json in ${instDir}`);
  }
  const comps = pack.components ?? [];
  const mcVersion = opts.version ?? comps.find((c) => c.uid === "net.minecraft")?.version;
  if (!mcVersion && !opts.baseJar) throw new Error(`can't tell the game version of ${instDir} (no net.minecraft component in mmc-pack.json); pass version`);

  let gameDir = join(instDir, "minecraft");
  if (!(await isDir(gameDir)) && (await isDir(join(instDir, ".minecraft")))) gameDir = join(instDir, ".minecraft");
  if (!(await isDir(gameDir))) warnings.push(`game folder not found in ${instDir} (minecraft/ or .minecraft/)`);

  const data = resolve(instDir, "..", "..");
  const libs = join(data, "libraries");
  const baseCandidates = mcVersion
    ? [join(libs, "com/mojang/minecraft", mcVersion, `minecraft-${mcVersion}-client.jar`), join(data, "versions", mcVersion, `${mcVersion}.jar`)]
    : [];
  let baseJar = opts.baseJar && resolve(opts.baseJar);
  if (!baseJar) for (const c of baseCandidates) if (await isFile(c)) (baseJar ??= c);
  if (!baseJar) throw new Error(`base game jar not found (looked in ${baseCandidates.join(", ")}); start the instance once in the launcher, or pass baseJar`);

  let loader: InstanceInfo["loader"];
  let loaderJar: string | undefined;
  for (const c of comps) {
    const ln = c.uid && MMC_LOADERS[c.uid];
    if (!ln || !c.version) continue;
    loader = { name: ln, version: c.version };
    loaderJar = await findLoaderJar(data, loader, mcVersion ?? "");
    if (!loaderJar && (ln === "neoforge" || ln === "forge")) warnings.push(`${ln} ${c.version} jar not found under ${libs}; its own assets will be missing`);
    break;
  }

  const layers = await modpackLayers(gameDir, baseJar, loaderJar, warnings);
  const version = mcVersion ?? (await jarVersion(baseJar)) ?? "unknown";
  return { root: gameDir, launcher: "prism", name, mcVersion: version, ...(loader ? { loader } : {}), layers, warnings };
}

async function locateVanilla(root: string, opts: LocateOptions): Promise<InstanceInfo> {
  const warnings: string[] = [];
  let version = opts.version;
  if (!version && !opts.baseJar) {
    const available: string[] = [];
    for (const v of await readdir(join(root, "versions")).catch(() => [] as string[])) {
      if (await isFile(join(root, "versions", v, `${v}.jar`))) available.push(v);
    }
    if (available.length === 1) version = available[0];
    else throw new Error(`several game versions in ${root}/versions; pass version (one of: ${available.join(", ")})`);
  }
  const baseJar = opts.baseJar ?? join(root, "versions", version!, `${version}.jar`);
  if (!(await isFile(baseJar))) throw new Error(`base game jar not found at ${baseJar}`);
  const mcVersion = version ?? (await jarVersion(baseJar)) ?? "unknown";
  const layers = await modpackLayers(root, baseJar, undefined, warnings);
  return { root, launcher: "vanilla", name: basename(root), mcVersion, layers, warnings };
}

async function locateGeneric(root: string, opts: LocateOptions): Promise<InstanceInfo> {
  const warnings: string[] = [];
  const baseJar = resolve(opts.baseJar!);
  if (!(await isFile(baseJar))) throw new Error(`base game jar not found at ${baseJar}`);
  const mcVersion = opts.version ?? (await jarVersion(baseJar)) ?? "unknown";
  const layers = await modpackLayers(root, baseJar, undefined, warnings);
  return { root, launcher: "generic", name: basename(root), mcVersion, layers, warnings };
}

/** Client jars carry a version.json with the version id. */
async function jarVersion(jar: string): Promise<string | undefined> {
  try {
    const z = await ZipArchive.open(await FileByteSource.open(jar), jar, (n) => n === "version.json");
    if (!z.has("version.json")) return undefined;
    return (JSON.parse((await z.read("version.json")).toString("utf8")) as { id?: string }).id;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Layer ordering
// ---------------------------------------------------------------------------------------------

/**
 * Approximates the game's final pack order (lowest first):
 *
 *   base jar
 *   loader jar, mod jars (alphabetical)           ─┐ "mod_resources"
 *   generated packs: KubeJS, Moonlight caches,      │
 *   instance datapacks/                            ─┘
 *   remaining options.txt resourcePacks entries, in order (built-in packs, file/ packs)
 *   OpenLoader packs (filename order; force-enabled, on top)
 *
 * Mod-to-mod order inside mod_resources follows the loader's mod sorting, which we can't reproduce
 * without running it; conflicts between mods over the same asset path are rare.
 */
async function modpackLayers(root: string, baseJar: string, loaderJar: string | undefined, warnings: string[]): Promise<LayerSpec[]> {
  const layers: LayerSpec[] = [{ kind: "archive", id: `minecraft:${basename(baseJar)}`, role: "base", path: baseJar }];

  const modGroup: LayerSpec[] = [];
  if (loaderJar) modGroup.push({ kind: "archive", id: `loader:${basename(loaderJar)}`, role: "loader", path: loaderJar });
  for (const f of (await listDir(join(root, "mods"))).filter((f) => f.endsWith(".jar")).sort(localeless)) {
    modGroup.push({ kind: "archive", id: `mod:${f}`, role: "mod", path: join(root, "mods", f) });
  }
  if (await isDir(join(root, "kubejs"))) {
    modGroup.push({ kind: "dir", id: "generated:kubejs", role: "generated", path: join(root, "kubejs") });
  }
  for (const cache of ["dynamic-resource-pack-cache", "dynamic-data-pack-cache"]) {
    for (const d of (await listDir(join(root, cache))).sort(localeless)) {
      const p = join(root, cache, d);
      if (await isDir(p)) modGroup.push({ kind: "dir", id: `generated:${cache}/${d}`, role: "generated", path: p });
    }
  }
  modGroup.push(...(await packsIn(join(root, "datapacks"), "datapack", "datapack")));

  const selected = await readSelectedPacks(join(root, "options.txt"));
  let modsPlaced = false;
  const later: LayerSpec[] = [];
  for (const entry of selected ?? ["vanilla", "mod_resources"]) {
    if (entry === "vanilla") continue; // the base jar is always the bottom layer
    if (entry === "mod_resources") {
      later.push(...modGroup);
      modsPlaced = true;
    } else if (entry.startsWith("file/")) {
      const name = entry.slice(5);
      const p = join(root, "resourcepacks", name);
      if (await isFile(p)) later.push({ kind: "archive", id: `resourcepack:${name}`, role: "resourcepack", path: p });
      else if (await isDir(p)) later.push({ kind: "dir", id: `resourcepack:${name}`, role: "resourcepack", path: p });
      else warnings.push(`selected resource pack not found: ${p}`);
    } else if (entry.startsWith("openloader/") || entry === "fabric" || entry === "server") {
      // OpenLoader packs are added below; "fabric" is a virtual pack of mod assets we already read.
      continue;
    } else {
      later.push({ kind: "builtin", id: `builtin:${entry}`, role: "builtin", name: entry });
    }
  }
  if (!modsPlaced) layers.push(...modGroup);
  layers.push(...later);
  layers.push(...(await packsIn(join(root, "config", "openloader", "packs"), "openloader", "openloader")));
  return layers;
}

async function packsIn(dir: string, role: LayerRole, idPrefix: string): Promise<LayerSpec[]> {
  const out: LayerSpec[] = [];
  for (const f of (await listDir(dir)).sort(localeless)) {
    const p = join(dir, f);
    if (/\.(zip|jar)$/i.test(f) && (await isFile(p))) out.push({ kind: "archive", id: `${idPrefix}:${f}`, role, path: p });
    else if ((await isDir(p)) && (await isFile(join(p, "pack.mcmeta")))) out.push({ kind: "dir", id: `${idPrefix}:${f}`, role, path: p });
  }
  return out;
}

/** The `resourcePacks:[...]` line of options.txt, lowest priority first. */
export async function readSelectedPacks(optionsTxt: string): Promise<string[] | undefined> {
  let text: string;
  try {
    text = await readFile(optionsTxt, "utf8");
  } catch {
    return undefined;
  }
  const line = text.split(/\r?\n/).find((l) => l.startsWith("resourcePacks:"));
  if (!line) return undefined;
  try {
    const v = JSON.parse(line.slice("resourcePacks:".length)) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
  } catch {
    return undefined;
  }
}

const localeless = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

async function listDir(p: string): Promise<string[]> {
  try {
    return await readdir(p);
  } catch {
    return [];
  }
}
async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}
async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}
