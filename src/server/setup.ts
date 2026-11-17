import { discover, LAUNCHER_NAMES, type Candidate, type Discovery } from "../assets/discover/index.js";
import { expandHome, readConfig } from "../core/config.js";
import { loadInstanceContext, type ServerConfig } from "./context.js";
import type { InstanceSetup, Session } from "./session.js";

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

/**
 * Automatic instance choice (`16`, *Command line*): with no instance saved, the one candidate to
 * load, or undefined when the user has to choose. Only candidates that can be loaded count; among
 * them, games the companion mod has run in (they wrote a pointer file, `14`, *Instance discovery*)
 * are preferred, so one modded instance with the mod wins over vanilla installs beside it.
 */
export function chooseAutomatically(found: Discovery): Candidate | undefined {
  const loadable = found.candidates.filter((c) => c.check.ok);
  const withMod = loadable.filter((c) => c.pointer);
  const pool = withMod.length ? withMod : loadable;
  return pool.length === 1 ? pool[0] : undefined;
}

/** The line that reports an automatic choice, on stderr and in the first tool result. */
export function autoChoiceText(c: Candidate, found: Discovery): string {
  const n = found.candidates.length;
  const why = n === 1 ? "it is the only instance found" : c.pointer ? `it is the only one the Autosketch mod has run in (${n} found)` : `it is the only one that can be loaded (${n} found)`;
  const list = n > 1 ? "; `npx -y autosketch instances` lists the others" : "";
  return `Autosketch chose the Minecraft instance ${candidateSummary(c)} at ${c.folder} automatically: ${why}. It isn't saved; to keep it or choose another, the user runs ${setupCommand(c)}${list}.`;
}

/** The source `instance_info` reports for an automatic choice. */
export const AUTO_SOURCE = { kind: "default", label: "automatic choice" } as const;

/** How long one discovery serves not_configured answers before it is run again. */
const DISCOVERY_TTL_MS = 30_000;

/** The entry point's `session.setup`, plus automatic choice at startup. */
export interface ServerInstanceSetup extends InstanceSetup {
  /**
   * With no instance saved (`16`, *Command line*): runs discovery and, when `chooseAutomatically`
   * picks one, loads it in place and says so on stderr and in the first tool result. Otherwise logs
   * how to choose one; the first tool result lists the candidates (`not_configured`).
   */
  autoChoose(session: Pick<Session, "loadInstance" | "callHooks">): Promise<Candidate | undefined>;
}

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
export function makeInstanceSetup(opts: InstanceSetupOptions): ServerInstanceSetup {
  const run = opts.discover ?? (() => discover());
  const log = opts.log ?? (() => {});
  // The automatic choice while it loads: its folder (for the source instance_info reports) and the
  // note still owed to the first tool result.
  let auto: { folder: string; note: string | undefined } | undefined;
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
        {
          ...opts.launch,
          instance: path,
          instanceSource: auto?.folder === path ? { ...AUTO_SOURCE } : { kind: "config", label: "config.toml" },
          ...(o.version ? { version: o.version } : {}),
          ...(o.baseJar ? { baseJar: o.baseJar } : {}),
        },
        opts.log,
      ),
    saved: () => {
      const c = readConfig(opts.configPath).config;
      if (!c.instance) return undefined;
      return { path: expandHome(c.instance), ...(c.version ? { version: c.version } : {}), ...(c.baseJar ? { baseJar: expandHome(c.baseJar) } : {}) };
    },
    notConfigured: async () => {
      const found = await discovered();
      // A call that arrived while discovery ran: the choice has just started loading.
      if (auto?.note) {
        const note = auto.note;
        auto.note = undefined;
        return `${note} It is loading now: call the tool again.`;
      }
      return notConfiguredText(found);
    },
    autoChoose: async (session) => {
      const found = await discovered();
      const pick = chooseAutomatically(found);
      if (!pick) {
        const n = found.candidates.length;
        log(
          n
            ? `no instance configured and ${n} found, none chosen automatically: choose one with \`npx -y autosketch setup --instance <id|path>\` (\`npx -y autosketch instances\` lists them)`
            : `no instance configured and none found: choose one with \`${setupCommand("<instance folder>")}\``,
        );
        return undefined;
      }
      const note = autoChoiceText(pick, found);
      const choice: { folder: string; note: string | undefined } = { folder: pick.folder, note };
      auto = choice;
      log(note);
      session.callHooks.push({
        after: (_call, result) => {
          if (!choice.note) return result;
          const text = choice.note;
          choice.note = undefined;
          return { ...result, content: [{ type: "text", text }, ...result.content] };
        },
      });
      session.loadInstance(pick.folder, { ...(pick.version ? { version: pick.version } : {}), ...(pick.baseJar ? { baseJar: pick.baseJar } : {}) }).catch((e: Error) => {
        // The tool result reports the failure; later calls list the candidates.
        choice.note = undefined;
        log(`the automatically chosen instance failed to load: ${e.message}`);
      });
      return pick;
    },
  };
}
