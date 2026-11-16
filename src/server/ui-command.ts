import { existsSync } from "node:fs";
import { join } from "node:path";
import { discover, type Discovery } from "../assets/discover/index.js";
import { defaultCacheDir } from "../assets/cache.js";
import { expandHome, readConfig } from "../core/config.js";
import { Settings } from "../core/settings.js";
import { prefabThumbnail } from "../library/prefabs.js";
import { libraryRoots, librarySettings } from "../library/roots.js";
import { ObserveHttp } from "../observe/http.js";
import type { InstanceHost } from "../observe/instance-api.js";
import { listSessionLogs, sessionLogDir } from "../observe/logs.js";
import { serveLog, type OfflineViewer } from "../observe/offline.js";
import { openInBrowser } from "../observe/open.js";
import { LogTables } from "../observe/states.js";
import { launchOptions } from "./context.js";
import { defaultWorkspace } from "./session.js";
// Every area that declares settings, so the Settings tab lists all of them (registered on import).
import "../assets/settings.js";
import "../observe/settings.js";
import "../scope/settings.js";
import "../world/settings.js";
import "./settings.js";

/**
 * `autosketch ui [--port <n>] [--no-open]` (docs/design/15-management-ui.md, U5): the management UI
 * with no MCP session, so settings, the library and the instance can be managed between sessions.
 * Prints the URL (with the write token), opens it unless `--no-open`, and runs until interrupted.
 *
 * Nothing is loaded: the Settings tab edits config.toml (no running values, so nothing is "restart
 * needed"), the Instance tab saves a choice for the next server start, the Library tab works on the
 * roots the settings name (thumbnails only where cached or embedded; previews in flat colours), and
 * the Observe tab lists the workspace's session logs and opens one in its own viewer, as
 * `autosketch observe <path>` does.
 */

export interface UiOptions {
  log?: (msg: string) => void;
  env?: NodeJS.ProcessEnv;
  /** config.toml (default `configPath()`). */
  configPath?: string;
  /** Discovery (stubbed in tests). */
  discover?: () => Promise<Discovery>;
  open?: (url: string) => void;
}

export interface UiServer {
  /** The URL to open, with the token. */
  url: string;
  http: ObserveHttp;
  close(): Promise<void>;
}

export async function startUi(args: readonly string[], opts: UiOptions = {}): Promise<UiServer> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => {});
  const i = args.indexOf("--port");
  const port = i >= 0 ? Number(args[i + 1]) : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("--port must be 0..65535");
  const file = readConfig(opts.configPath);
  const settings = Settings.from(args, env, file);
  const workspace = launchOptions([...args], env, file).workspace ?? defaultWorkspace();

  let cached: Promise<Discovery> | undefined;
  const instance: InstanceHost = {
    standalone: true,
    status: () => ({ state: "none" }),
    hasInstance: () => false,
    load: async () => undefined,
    discover: (refresh = false) => {
      if (refresh || !cached) cached = (opts.discover ?? (() => discover()))().catch((e: Error): Discovery => ({ candidates: [], warnings: [`discovery failed: ${e.message}`] }));
      return cached;
    },
  };

  // The instance's game folder, for its Axiom root: the saved folder, or its minecraft/ subfolder (Prism, MultiMC).
  const gameDir = (): string | undefined => {
    const saved = readConfig(opts.configPath).config.instance;
    if (!saved) return undefined;
    const f = expandHome(saved);
    for (const sub of ["minecraft", ".minecraft"]) if (existsSync(join(f, sub, "config"))) return join(f, sub);
    return f;
  };

  const viewers = new Map<string, OfflineViewer>();
  const http = new ObserveHttp({
    bus: { lastSeq: 0 },
    tables: new LogTables(() => {}),
    sessionId: "ui",
    dirFor: () => workspace,
    docFor: () => undefined,
    live: false,
    port,
    settings,
    ...(opts.configPath ? { configPath: opts.configPath } : {}),
    instance,
    library: {
      roots: () => {
        const dir = gameDir();
        return libraryRoots({ workspace, env, settings: librarySettings([...args], env), ...(dir ? { instanceRoot: dir } : {}) });
      },
      thumbnail: (p) => prefabThumbnail(p, { cacheDir: defaultCacheDir() }),
    },
    standalone: {
      logs: () => listSessionLogs(workspace),
      async open(id) {
        const open = viewers.get(id);
        if (open) return open.url;
        const dir = await sessionLogDir(workspace, id);
        if (!dir) return undefined;
        const v = await serveLog({ path: dir, log });
        viewers.set(id, v);
        return v.url;
      },
    },
    log,
  });
  const url = await http.start();
  return {
    url,
    http,
    async close() {
      await http.close();
      await Promise.all([...viewers.values()].map((v) => v.close()));
    },
  };
}

/** The `ui` subcommand: start, print, open, run until interrupted. */
export async function uiCommand(args: string[], log: (msg: string) => void): Promise<void> {
  let ui: UiServer;
  try {
    ui = await startUi(args, { log });
  } catch (e) {
    log((e as Error).message);
    process.exit(2);
  }
  process.stdout.write(`${ui.url}\n`);
  if (!args.includes("--no-open")) openInBrowser(ui.url, log);
  const stop = () => void ui.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
