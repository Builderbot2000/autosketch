import { defaultCacheDir } from "../assets/cache.js";
import { biomeClimate } from "../assets/biomes.js";
import { MOD_ORDER, TINT_BIOME } from "../assets/settings.js";
import { expandHome, type ConfigSnapshot } from "../core/config.js";
import { Settings, type SettingSource, type SourcedText } from "../core/settings.js";
import { locateInstance, type InstanceInfo, type LocateOptions } from "../assets/locate.js";
import { openStack, type PackStack } from "../assets/pack.js";
import { loadRegistry, type Registry } from "../assets/registry.js";
import { loadPaletteIndex, type PaletteIndex } from "../palette/index.js";
import { PaletteBook } from "../palette/pick.js";
import { SheetRenderer } from "../palette/sheet.js";
import { defaultWorkspace } from "./session.js";
import { BUILTIN_PLUGINS } from "../plugins/builtin.js";
import { loadPluginDir, mergePlugins, pluginDir } from "../plugins/loader.js";
import { activePlugins, type AutosketchPlugin } from "../plugins/types.js";

/** Everything tools need about the user's Minecraft instance, loaded once per server. */
export interface InstanceContext {
  info: Pick<InstanceInfo, "name" | "mcVersion" | "loader" | "launcher" | "root">;
  stack: PackStack;
  registry: Registry;
  palette: PaletteIndex;
  plugins: AutosketchPlugin[];
  sheets: SheetRenderer;
  /** Named palettes for this session (moves into the document model later). */
  book: PaletteBook;
  warnings: string[];
  timings: Record<string, number>;
  /** Biome for colormapped tints (02); undefined = plains. */
  tintBiome?: string;
  /** Which source named the instance (`ServerConfig.instanceSource`). */
  instanceSource?: SettingSource;
}

export interface ServerConfig extends LocateOptions {
  instance: string;
  /** Which source named the instance (`config.toml`, `--instance`, `AUTOSKETCH_INSTANCE`); `instance_info` reports it. */
  instanceSource?: SettingSource;
  /** Folder for documents (default ~/autosketch). */
  workspace?: string;
  /** Biome for grass/foliage tints in renders, sheets and colour stats (default plains). */
  tintBiome?: string;
}

/**
 * A startup argument resolved like a setting (`15`, *Settings tab*; `14`, *Setup*): config.toml, then
 * `--<flag>`, then `AUTOSKETCH_<NAME>`. `overrides` is the launch value config.toml beat, if any.
 */
export interface StartupArg {
  value: string;
  source: SettingSource;
  overrides?: SourcedText;
}

/**
 * An `AUTOSKETCH_*` launch variable, or undefined when it is empty or an unexpanded placeholder
 * (`${user_config.instance}`): an MCPB host (Claude Desktop) may pass an optional field the user
 * left empty either way (`14`, *Package and listings*).
 */
export function launchEnv(env: Readonly<Record<string, string | undefined>>, key: string): string | undefined {
  const v = env[key]?.trim();
  return v && !/^\$\{[^}]*\}$/.test(v) ? v : undefined;
}

/**
 * The instance or workspace: config.toml's `instance` / `workspace` (with `~` expanded) first, then
 * the launch `--instance` / `--workspace`, then `AUTOSKETCH_INSTANCE` / `AUTOSKETCH_WORKSPACE`, else
 * undefined (`14`, *Setup*: config.toml has priority, launch options fill what it leaves unset).
 */
export function startupArg(name: "instance" | "workspace", argv: readonly string[], env: Readonly<Record<string, string | undefined>>, file?: ConfigSnapshot): StartupArg | undefined {
  const i = argv.indexOf(`--${name}`);
  const envKey = `AUTOSKETCH_${name.toUpperCase()}`;
  const launch: SourcedText[] = [];
  const flagValue = i >= 0 ? argv[i + 1] : undefined;
  if (flagValue) launch.push({ source: { kind: "flag", label: `--${name}` }, raw: flagValue });
  const envValue = launchEnv(env, envKey);
  if (envValue) launch.push({ source: { kind: "env", label: envKey }, raw: envValue });
  const saved = file?.config[name];
  if (saved) return { value: expandHome(saved), source: { kind: "config", label: "config.toml" }, ...(launch[0] ? { overrides: launch[0] } : {}) };
  return launch[0] && { value: launch[0].raw, source: launch[0].source };
}

/**
 * Reads config from config.toml when given (`instance`, `workspace`, `[settings]`: core/config.ts),
 * then CLI args (--instance, --version, --base-jar, --workspace) and env (AUTOSKETCH_*).
 * modOrder and tintBiome are settings (`assets/settings.ts`): `--set modOrder=a,b` or the older
 * `--mod-order a,b` / `AUTOSKETCH_MOD_ORDER`, likewise `tintBiome`. The launch `--version` and
 * `--base-jar` describe the launch instance, so they are dropped when config.toml names a different one.
 * config.toml's own `version` and `baseJar` were saved with its `instance` (`setup`), so they apply
 * when that instance is the one chosen, before the launch values.
 */
export function configFromEnv(argv = process.argv.slice(2), env = process.env, file?: ConfigSnapshot): ServerConfig | undefined {
  const arg = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const instance = startupArg("instance", argv, env, file);
  if (!instance) return undefined;
  const cfg: ServerConfig = { instance: instance.value, instanceSource: instance.source, ...launchOptions(argv, env, file) };
  if (instance.source.kind === "config") {
    if (file?.config.version) cfg.version = file.config.version;
    if (file?.config.baseJar) cfg.baseJar = expandHome(file.config.baseJar);
  }
  if (!instance.overrides || instance.overrides.raw === instance.value) {
    const version = arg("version") ?? launchEnv(env, "AUTOSKETCH_VERSION");
    const baseJar = arg("base-jar") ?? launchEnv(env, "AUTOSKETCH_BASE_JAR");
    if (version) cfg.version ??= version;
    if (baseJar) cfg.baseJar ??= baseJar;
  }
  return cfg;
}

/**
 * Everything `configFromEnv` reads besides the instance (mod order, tint biome, workspace), for a
 * server that starts with no instance and loads one later (`14`, *Setup*: not configured).
 */
export function launchOptions(argv = process.argv.slice(2), env = process.env, file?: ConfigSnapshot): Omit<ServerConfig, "instance" | "instanceSource"> {
  const cfg: Omit<ServerConfig, "instance" | "instanceSource"> = {};
  // Settings (core/settings.ts): config.toml, --set key=value, the flag alias, then AUTOSKETCH_<KEY>.
  const settings = Settings.from(argv, env, file);
  const modOrder = settings.get(MOD_ORDER);
  if (modOrder) cfg.modOrder = modOrder;
  const tintBiome = settings.get(TINT_BIOME);
  if (tintBiome) cfg.tintBiome = tintBiome;
  const workspace = startupArg("workspace", argv, env, file);
  if (workspace) cfg.workspace = workspace.value;
  return cfg;
}

/** Startup log lines for an instance or workspace config.toml overrides (`15`: a launch value is never ignored silently). */
export function startupArgNotes(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, file?: ConfigSnapshot): string[] {
  const out: string[] = [];
  for (const name of ["instance", "workspace"] as const) {
    const a = startupArg(name, argv, env, file);
    if (a?.overrides && a.overrides.raw !== a.value) {
      const how = a.overrides.source.kind === "flag" ? `${a.overrides.source.label} ${a.overrides.raw}` : `${a.overrides.source.label}=${a.overrides.raw}`;
      out.push(`${name}: launch value ${how} ignored; config.toml says ${a.value}`);
    }
  }
  return out;
}

export async function loadInstanceContext(cfg: ServerConfig, log: (msg: string) => void = () => {}): Promise<InstanceContext> {
  const timings: Record<string, number> = {};
  const time = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    const t = Date.now();
    const r = await fn();
    timings[label] = Date.now() - t;
    log(`${label}: ${timings[label]} ms`);
    return r;
  };
  if (cfg.tintBiome) biomeClimate(cfg.tintBiome); // fail early on a misspelt biome
  const tint = cfg.tintBiome ? { tintBiome: cfg.tintBiome } : {};
  const info = await time("locate", () => locateInstance(cfg.instance, cfg));
  log(`instance ${info.name}: Minecraft ${info.mcVersion}${info.loader ? `, ${info.loader.name} ${info.loader.version}` : ""}, ${info.layers.length} layers`);
  const { stack, warnings } = await time("pack stack", () => openStack(info));
  const { registry } = await time("registry", () => loadRegistry(stack, { mcVersion: info.mcVersion, onProgress: log }));
  // Third-party plugins run with full trust (09); a missing folder is fine.
  const extra = await time("plugins", () => loadPluginDir(pluginDir(cfg.workspace ?? defaultWorkspace())));
  const merged = mergePlugins(BUILTIN_PLUGINS, extra.plugins);
  const plugins = activePlugins(merged.plugins, registry);
  if (extra.plugins.length) log(`third-party plugins: ${extra.plugins.map((p) => p.id).join(", ")} (full trust)`);
  const { index } = await time("palette", () => loadPaletteIndex(stack, registry, { plugins, ...tint }));
  log(`ready: ${registry.size} blocks, ${index.buildable().length} buildable families`);
  return {
    info: { name: info.name, mcVersion: info.mcVersion, loader: info.loader, launcher: info.launcher, root: info.root },
    stack,
    registry,
    palette: index,
    plugins,
    sheets: new SheetRenderer(index, stack, { ...tint, cacheDir: defaultCacheDir() }),
    book: new PaletteBook(),
    warnings: [...warnings, ...registry.data.warnings, ...extra.warnings, ...merged.warnings],
    timings,
    ...tint,
    ...(cfg.instanceSource ? { instanceSource: cfg.instanceSource } : {}),
  };
}
