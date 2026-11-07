import { locateInstance, type InstanceInfo, type LocateOptions } from "../assets/locate.js";
import { openStack, type PackStack } from "../assets/pack.js";
import { loadRegistry, type Registry } from "../assets/registry.js";
import { loadPaletteIndex, type PaletteIndex } from "../palette/index.js";
import { PaletteBook } from "../palette/pick.js";
import { SheetRenderer } from "../palette/sheet.js";
import { BUILTIN_PLUGINS } from "../plugins/builtin.js";
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
}

export interface ServerConfig extends LocateOptions {
  instance: string;
}

/** Reads config from CLI args (--instance, --version, --base-jar) and env (AUTOSKETCH_*). */
export function configFromEnv(argv = process.argv.slice(2), env = process.env): ServerConfig | undefined {
  const arg = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const instance = arg("instance") ?? env.AUTOSKETCH_INSTANCE;
  if (!instance) return undefined;
  const cfg: ServerConfig = { instance };
  const version = arg("version") ?? env.AUTOSKETCH_VERSION;
  const baseJar = arg("base-jar") ?? env.AUTOSKETCH_BASE_JAR;
  if (version) cfg.version = version;
  if (baseJar) cfg.baseJar = baseJar;
  return cfg;
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
  const info = await time("locate", () => locateInstance(cfg.instance, cfg));
  log(`instance ${info.name}: Minecraft ${info.mcVersion}${info.loader ? `, ${info.loader.name} ${info.loader.version}` : ""}, ${info.layers.length} layers`);
  const { stack, warnings } = await time("pack stack", () => openStack(info));
  const { registry } = await time("registry", () => loadRegistry(stack, { mcVersion: info.mcVersion, onProgress: log }));
  const plugins = activePlugins(BUILTIN_PLUGINS, registry);
  const { index } = await time("palette", () => loadPaletteIndex(stack, registry, { plugins }));
  log(`ready: ${registry.size} blocks, ${index.buildable().length} buildable families`);
  return {
    info: { name: info.name, mcVersion: info.mcVersion, loader: info.loader, launcher: info.launcher, root: info.root },
    stack,
    registry,
    palette: index,
    plugins,
    sheets: new SheetRenderer(index, stack),
    book: new PaletteBook(),
    warnings: [...warnings, ...registry.data.warnings],
    timings,
  };
}
