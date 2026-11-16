import { readdirSync } from "node:fs";
import { join } from "node:path";
import { discover as runDiscovery, type Discovery } from "../assets/discover/index.js";
import { expandHome, readConfig, type ConfigSnapshot } from "../core/config.js";
import type { SettingSource } from "../core/settings.js";
import type { InstanceHost, InstanceStatus } from "../observe/instance-api.js";
import { startupArg, type InstanceContext } from "./context.js";
import type { Session } from "./session.js";

/**
 * The management UI's view of the session's instance (docs/design/15-management-ui.md, *Instance
 * tab and first-run setup*): what is loaded and how it was chosen, discovery, loading in place
 * (`session.loadInstance`) and the live link, handed to `observe/` as an `InstanceHost` so the
 * viewer's server never imports `server/`.
 */

export interface InstanceHostOptions {
  session: Session;
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  /** config.toml as read at startup. */
  file: ConfigSnapshot;
  /** Where config.toml is read now (default the snapshot's path). */
  configPath?: string;
  /** Discovery (stubbed in tests). */
  discover?: () => Promise<Discovery>;
}

/** How long one discovery serves the tab before it runs again (a refresh runs it at once). */
const DISCOVERY_TTL_MS = 30_000;

export function makeInstanceHost(opts: InstanceHostOptions): InstanceHost {
  const { session } = opts;
  const arg = startupArg("instance", opts.argv, opts.env, opts.file);
  // The instance the launch command or environment names, whether it is in use or config.toml beat it.
  const launch = !arg ? undefined : arg.source.kind !== "config" ? { folder: arg.value, label: arg.source.label } : arg.overrides ? { folder: arg.overrides.raw, label: arg.overrides.source.label } : undefined;
  const settled = new WeakMap<Promise<InstanceContext>, { ctx?: InstanceContext; error?: string }>();
  const chosen = new WeakMap<Promise<InstanceContext>, { folder: string; source: SettingSource }>();
  const mods = new WeakMap<InstanceContext, number>();
  let lastError: { folder: string; error: string } | undefined;
  let startup: { folder: string; source: SettingSource } | undefined = arg ? { folder: arg.value, source: arg.source } : undefined;
  let cached: { at: number; result: Promise<Discovery> } | undefined;

  const track = (p: Promise<InstanceContext>) => {
    if (settled.has(p)) return;
    settled.set(p, {});
    p.then(
      (ctx) => settled.set(p, { ctx }),
      (e: Error) => settled.set(p, { error: e.message }),
    );
  };
  const modCount = (ctx: InstanceContext): number => {
    let n = mods.get(ctx);
    if (n === undefined) {
      try {
        n = readdirSync(join(ctx.info.root, "mods")).filter((f) => f.toLowerCase().endsWith(".jar")).length;
      } catch {
        n = 0;
      }
      mods.set(ctx, n);
    }
    return n;
  };

  return {
    ...(launch ? { launch } : {}),
    hasInstance: () => session.hasInstance,
    status(): InstanceStatus {
      const p = session.instance;
      if (!p) return lastError ? { state: "none", folder: lastError.folder, error: lastError.error } : { state: "none" };
      track(p);
      // The instance the session started with is the first one it was given.
      if (startup && !chosen.has(p)) {
        chosen.set(p, startup);
        startup = undefined;
      }
      const s = settled.get(p)!;
      const saved = readConfig(opts.configPath ?? opts.file.path).config.instance;
      const from = chosen.get(p) ?? (saved ? { folder: expandHome(saved), source: { kind: "config", label: "config.toml" } as SettingSource } : undefined);
      const base = from ? { folder: from.folder, source: { kind: from.source.kind, label: from.source.label } } : {};
      if (s.error) return { state: "failed", ...base, error: s.error };
      if (!s.ctx) return { state: "loading", ...base };
      const c = s.ctx;
      return {
        state: "loaded",
        ...base,
        name: c.info.name,
        mcVersion: c.info.mcVersion,
        ...(c.info.loader ? { loader: c.info.loader } : {}),
        launcher: c.info.launcher,
        gameDir: c.info.root,
        mods: modCount(c),
        blocks: c.registry.size,
        warnings: c.warnings.slice(0, 20),
      };
    },
    load(folder, o) {
      const p = session.loadInstance(folder, o);
      const current = session.instance;
      if (current) chosen.set(current, { folder, source: { kind: "config", label: "config.toml (chosen on this page)" } as SettingSource });
      lastError = undefined;
      startup = undefined;
      p.catch((e: Error) => (lastError = { folder, error: e.message }));
      return p;
    },
    discover(refresh = false) {
      if (refresh || !cached || Date.now() - cached.at > DISCOVERY_TTL_MS) {
        const result = (opts.discover ?? (() => runDiscovery()))().catch((e: Error): Discovery => ({ candidates: [], warnings: [`discovery failed: ${e.message}`] }));
        cached = { at: Date.now(), result };
      }
      return cached.result;
    },
    link() {
      const w = session.world;
      if (!w) return undefined;
      const dimension = w.volumes?.dimension;
      return { state: w.state, ...(dimension ? { dimension } : {}) };
    },
  };
}
