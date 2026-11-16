import { discover, LAUNCHER_NAMES, type Candidate, type Discovery } from "../assets/discover/index.js";
import { expandHome, readConfig, type ConfigSnapshot } from "../core/config.js";
import { loadInstanceContext, type ServerConfig } from "./context.js";
import type { InstanceSetup } from "./session.js";

/**
 * The server side of first-run setup (docs/design/14-distribution.md, *Setup*; docs/design/15-management-ui.md,
 * *Instance tab and first-run setup*): what tools answer while no instance is loaded, how an instance
 * is loaded in place, and the signal for opening the UI on its Instance tab at startup.
 */

/** The URL fragment that opens the management UI on its Instance tab (the setup wizard). */
export const INSTANCE_TAB_FRAGMENT = "tab=instance";

/** `url` with `fragment` added to its `#…` part (kept alongside one already there, such as the UI token). */
export function withFragment(url: string, fragment: string): string {
  const i = url.indexOf("#");
  if (i < 0) return `${url}#${fragment}`;
  return i === url.length - 1 ? `${url}${fragment}` : `${url}&${fragment}`;
}

/**
 * Whether the server opens the UI on the Instance tab at startup: when config.toml remembers no
 * instance (`15`: the wizard shows until an instance is saved; a launch `--instance` still loads
 * meanwhile and is offered first). Otherwise the viewer opens on the first tool call as usual.
 */
export function wantsSetupWizard(file: ConfigSnapshot): boolean {
  return !file.config.instance;
}

/** The setup command for a candidate or a folder, as the user would paste it. */
export function setupCommand(target: Pick<Candidate, "folder"> | string): string {
  const folder = typeof target === "string" ? target : target.folder;
  return `npx -y autosketch setup --instance ${quote(folder)}`;
}

const quote = (s: string): string => (/^[\w./:@~+-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, "\\$1")}"`);

/** One line describing a candidate: name, version, loader, launcher, mods, and why it can't load yet when it can't. */
export function candidateSummary(c: Candidate): string {
  const parts = [c.mcVersion ? `Minecraft ${c.mcVersion}` : undefined, c.loader ? `${c.loader.name}${c.loader.version ? ` ${c.loader.version}` : ""}` : undefined, LAUNCHER_NAMES[c.launcher], `${c.check.mods} mods`];
  const line = `${c.name} (${parts.filter(Boolean).join(", ")})`;
  return c.check.ok ? line : `${line}; can't load yet: ${c.check.detail}`;
}

/** At most this many candidates in a not_configured answer (it reaches the agent's context). */
const MAX_LISTED = 8;

/**
 * The `not_configured` answer (`14`, *Setup*): the discovered instances with the exact `setup`
 * command for each, and the UI's URL on its Instance tab, so the agent can point the user at either.
 */
export function notConfiguredText(found: Discovery, uiUrl?: string): string {
  const lines = ["Autosketch has no Minecraft instance to read blocks from yet. Ask the user to choose one, then call the tool again (no restart needed):"];
  if (uiUrl) lines.push(`- in the browser: ${uiUrl} (Instance tab)`);
  const sorted = [...found.candidates].sort((a, b) => Number(b.check.ok) - Number(a.check.ok));
  if (sorted.length) {
    lines.push(`- or in a terminal, one of${sorted.length > MAX_LISTED ? ` (${sorted.length} found, first ${MAX_LISTED} shown; \`npx -y autosketch instances\` lists all)` : ""}:`);
    for (const c of sorted.slice(0, MAX_LISTED)) lines.push(`  ${setupCommand(c)}   # ${candidateSummary(c)}`);
  } else {
    lines.push(`- or in a terminal: ${setupCommand("<instance folder>")}  (no instance was found in the known launcher folders)`);
  }
  return lines.join("\n");
}

/** How long one discovery serves not_configured answers before it is run again. */
const DISCOVERY_TTL_MS = 30_000;

export interface InstanceSetupOptions {
  /** The launch options besides the instance (`launchOptions` in context.ts). */
  launch: Omit<ServerConfig, "instance" | "instanceSource">;
  /** The UI's URL, without the fragment; undefined when the viewer is off. */
  uiUrl: () => Promise<string | undefined>;
  log?: (msg: string) => void;
  /** Where config.toml is read (default `configPath()`). */
  configPath?: string;
  /** Discovery (stubbed in tests). */
  discover?: () => Promise<Discovery>;
}

/** The entry point's `session.setup`: loads instances in place, picks up a choice saved since startup, explains not_configured. */
export function makeInstanceSetup(opts: InstanceSetupOptions): InstanceSetup {
  const run = opts.discover ?? (() => discover());
  let cached: { at: number; result: Promise<Discovery> } | undefined;
  const discovered = (): Promise<Discovery> => {
    if (!cached || Date.now() - cached.at > DISCOVERY_TTL_MS) {
      const result = run().catch((e: Error): Discovery => ({ candidates: [], warnings: [`discovery failed: ${e.message}`] }));
      cached = { at: Date.now(), result };
    }
    return cached.result;
  };
  return {
    load: (path, o = {}) =>
      loadInstanceContext(
        { ...opts.launch, instance: path, instanceSource: { kind: "config", label: "config.toml" }, ...(o.version ? { version: o.version } : {}), ...(o.baseJar ? { baseJar: o.baseJar } : {}) },
        opts.log,
      ),
    saved: () => {
      const c = readConfig(opts.configPath).config;
      if (!c.instance) return undefined;
      return { path: expandHome(c.instance), ...(c.version ? { version: c.version } : {}), ...(c.baseJar ? { baseJar: expandHome(c.baseJar) } : {}) };
    },
    notConfigured: async () => {
      const [found, url] = await Promise.all([discovered(), opts.uiUrl().catch(() => undefined)]);
      return notConfiguredText(found, url && withFragment(url, INSTANCE_TAB_FRAGMENT));
    },
  };
}
