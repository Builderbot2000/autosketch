import { discover, LAUNCHER_NAMES, type Candidate, type Discovery } from "../assets/discover/index.js";
import { expandHome, readConfig } from "../core/config.js";
import { loadInstanceContext, type ServerConfig } from "./context.js";
import type { InstanceSetup } from "./session.js";

/**
 * The server side of first-run setup (docs/design/14-distribution.md, *Setup*; docs/design/16-in-game-ui.md,
 * *Command line*): what tools answer while no instance is loaded, and how an instance is loaded in
 * place. Choosing one is command-line only (`autosketch setup`); there is no wizard.
 */

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
 * The `not_configured` answer (`14`, *Setup*; `16`, *Command line*): the discovered instances with
 * the exact `setup` command for each, so the agent can tell the user what to run.
 */
export function notConfiguredText(found: Discovery): string {
  const lines = ["Autosketch has no Minecraft instance to read blocks from yet. Ask the user to choose one in a terminal, then call the tool again (no restart needed):"];
  const sorted = [...found.candidates].sort((a, b) => Number(b.check.ok) - Number(a.check.ok));
  if (sorted.length) {
    lines.push(`- one of${sorted.length > MAX_LISTED ? ` (${sorted.length} found, first ${MAX_LISTED} shown; \`npx -y autosketch instances\` lists all)` : ""}:`);
    for (const c of sorted.slice(0, MAX_LISTED)) lines.push(`  ${setupCommand(c)}   # ${candidateSummary(c)}`);
  } else {
    lines.push(`- ${setupCommand("<instance folder>")}  (no instance was found in the known launcher folders)`);
  }
  return lines.join("\n");
}

/** How long one discovery serves not_configured answers before it is run again. */
const DISCOVERY_TTL_MS = 30_000;

export interface InstanceSetupOptions {
  /** The launch options besides the instance (`launchOptions` in context.ts). */
  launch: Omit<ServerConfig, "instance" | "instanceSource">;
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
    notConfigured: async () => notConfiguredText(await discovered()),
  };
}
