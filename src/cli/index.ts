import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { chooseInstance, discover, InstanceChoiceError, LAUNCHER_NAMES, type Discovery } from "../assets/discover/index.js";
import { configPath as defaultConfigPath, expandHome, readConfig, setInstance, unsetInstance, updateConfig } from "../core/config.js";
import { registeredSettings } from "../core/settings.js";
// Every module that declares settings, so `config set` validates any key (15, *Settings tab*).
import "../assets/settings.js";
import "../observe/settings.js";
import "../scope/settings.js";
import "../server/settings.js";
import "../world/settings.js";

/**
 * Command-line setup (docs/design/14-distribution.md, *Setup*). Each command edits
 * `~/.autosketch/config.toml`, the same file and with the same validation as the in-game
 * settings screen (docs/design/16-in-game-ui.md):
 *
 *   autosketch instances [--json]
 *   autosketch setup --instance <id | path> [--workspace <path>] [--version <v>] [--base-jar <jar>] [--client claude]
 *   autosketch config set <key> <value>      instance, workspace, version, baseJar, or a setting key
 *   autosketch config unset <key>            `config unset instance` unlinks the instance
 *
 * Output goes to stdout, problems to stderr; the exit code is 0 on success.
 */

export const CLI_COMMANDS: ReadonlySet<string> = new Set(["instances", "setup", "config"]);

export interface CliDeps {
  discover?: () => Promise<Discovery>;
  configPath?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** Runs the agent client's registration command; returns its exit code. */
  exec?: (cmd: string, args: string[]) => Promise<number>;
}

/** The command `setup --client claude` runs: config.toml holds the instance, so the server needs no arguments. */
export const CLAUDE_ADD = ["claude", ["mcp", "add", "--scope", "user", "autosketch", "--", "npx", "-y", "autosketch"]] as const;

export async function runCli(command: string, args: string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => void process.stdout.write(`${l}\n`));
  const err = deps.err ?? ((l: string) => void process.stderr.write(`${l}\n`));
  const ctx: Ctx = { out, err, path: deps.configPath ?? defaultConfigPath(), discover: deps.discover ?? (() => discover()), exec: deps.exec ?? execInherit };
  try {
    if (command === "instances") return await instances(args, ctx);
    if (command === "setup") return await setup(args, ctx);
    if (command === "config") return await config(args, ctx);
    err(`unknown command ${command}`);
    return 2;
  } catch (e) {
    err(e instanceof InstanceChoiceError ? e.message : `error: ${(e as Error).message}`);
    return 1;
  }
}

interface Ctx {
  out: (l: string) => void;
  err: (l: string) => void;
  path: string;
  discover: () => Promise<Discovery>;
  exec: (cmd: string, args: string[]) => Promise<number>;
}

/** `--name value` options; `flags` are the names allowed. Returns undefined (after printing why) on a bad option. */
function options(args: string[], flags: readonly string[], ctx: Ctx, usage: string): Record<string, string> | undefined {
  const o: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const name = a.startsWith("--") ? a.slice(2) : undefined;
    if (name === "json" && flags.includes("json")) {
      o.json = "true";
      continue;
    }
    if (!name || !flags.includes(name) || args[i + 1] === undefined) {
      ctx.err(`usage: ${usage}`);
      return undefined;
    }
    o[name] = args[++i]!;
  }
  return o;
}

async function instances(args: string[], ctx: Ctx): Promise<number> {
  const o = options(args, ["json"], ctx, "autosketch instances [--json]");
  if (!o) return 2;
  const found = await ctx.discover();
  for (const w of found.warnings) ctx.err(`warning: ${w}`);
  if (o.json) {
    ctx.out(JSON.stringify(found.candidates, null, 2));
    return 0;
  }
  if (!found.candidates.length) {
    ctx.out("No instances found in the known launcher folders. Use: autosketch setup --instance <path to the instance folder>");
    return 0;
  }
  const rows = found.candidates.map((c) => [c.id, c.name, c.mcVersion ?? "?", c.loader ? `${c.loader.name}${c.loader.version ? ` ${c.loader.version}` : ""}` : "vanilla", LAUNCHER_NAMES[c.launcher], c.folder]);
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  found.candidates.forEach((c, k) => {
    ctx.out(rows[k]!.map((cell, i) => (i < rows[k]!.length - 1 ? cell.padEnd(widths[i]!) : cell)).join("  "));
    if (!c.check.ok) ctx.out(`  can't load yet: ${c.check.detail}`);
  });
  ctx.out("");
  ctx.out("Choose one with: autosketch setup --instance <id>");
  return 0;
}

const SETUP_USAGE = "autosketch setup --instance <id | path> [--workspace <path>] [--version <v>] [--base-jar <jar>] [--client claude]";

async function setup(args: string[], ctx: Ctx): Promise<number> {
  const o = options(args, ["instance", "workspace", "version", "base-jar", "client"], ctx, SETUP_USAGE);
  if (!o) return 2;
  if (!o.instance) {
    ctx.err(`usage: ${SETUP_USAGE}`);
    return 2;
  }
  if (o.client && o.client !== "claude") {
    ctx.err(`--client: only "claude" is supported (got "${o.client}")`);
    return 2;
  }
  const found = await ctx.discover();
  const choice = await chooseInstance(o.instance, { ...(o.version ? { version: o.version } : {}), ...(o["base-jar"] ? { baseJar: o["base-jar"] } : {}) }, found.candidates);
  const workspace = o.workspace;
  updateConfig((c) => {
    setInstance(c, choice.folder, choice);
    if (workspace) c.workspace = resolve(expandHome(workspace));
  }, ctx.path);
  ctx.out(`Saved instance ${choice.name} (${choice.check.detail}): ${choice.folder}`);
  if (choice.version || choice.baseJar) ctx.out(`  with ${[choice.version && `version ${choice.version}`, choice.baseJar && `base jar ${choice.baseJar}`].filter(Boolean).join(", ")}`);
  if (workspace) ctx.out(`Saved workspace ${resolve(expandHome(workspace))}`);
  ctx.out(`in ${ctx.path}. A running Autosketch server picks it up on its next tool call.`);
  if (!o.client) return 0;
  const [cmd, cargs] = CLAUDE_ADD;
  ctx.out(`Running: ${[cmd, ...cargs].join(" ")}`);
  const code = await ctx.exec(cmd, [...cargs]).catch((e: NodeJS.ErrnoException) => {
    ctx.err(e.code === "ENOENT" ? `claude was not found on PATH; run that command yourself once Claude Code is installed` : `claude failed: ${e.message}`);
    return 1;
  });
  return code;
}

/** Keys of config.toml that aren't settings. */
const TOP_KEYS = ["instance", "workspace", "version", "baseJar"] as const;
const CONFIG_USAGE = "autosketch config set <key> <value> | autosketch config unset <key>   (keys: instance, workspace, version, baseJar, or a setting such as observe.snapshots)";

async function config(args: string[], ctx: Ctx): Promise<number> {
  const [verb, key, value, ...rest] = args;
  if ((verb !== "set" && verb !== "unset") || !key || (verb === "set" ? value === undefined : value !== undefined) || rest.length) {
    ctx.err(`usage: ${CONFIG_USAGE}`);
    return 2;
  }
  if (verb === "unset") return unset(key, ctx);
  if (key === "instance") return setup(["--instance", value!], ctx);
  if (key === "workspace") {
    updateConfig((c) => void (c.workspace = value!), ctx.path);
    ctx.out(`workspace = ${value} (in ${ctx.path})`);
    return 0;
  }
  if (key === "version" || key === "baseJar") {
    // They describe the saved instance and apply only with it (14, *Setup*).
    if (!readConfig(ctx.path).config.instance) {
      ctx.err(`${key} goes with an instance: set one first (autosketch setup --instance <id | path> --${key === "baseJar" ? "base-jar" : "version"} …)`);
      return 1;
    }
    const v = key === "baseJar" ? resolve(expandHome(value!)) : value!.trim();
    updateConfig((c) => void (c[key] = v), ctx.path);
    ctx.out(`${key} = ${v} (in ${ctx.path})`);
    return 0;
  }
  const s = registeredSettings().find((x) => x.key === key);
  if (!s) {
    ctx.err(`unknown key "${key}". Keys: ${[...TOP_KEYS, ...registeredSettings().map((x) => x.key)].join(", ")}`);
    return 1;
  }
  if (s.parse(value!) === undefined) {
    ctx.err(`${key}: "${value}" is not valid; expected ${s.accepts}`);
    return 1;
  }
  updateConfig((c) => void (c.settings[key] = value!), ctx.path);
  ctx.out(`${key} = ${value} (in ${ctx.path}; a running server applies it when it restarts)`);
  return 0;
}

function unset(key: string, ctx: Ctx): number {
  if (key === "instance") {
    updateConfig(unsetInstance, ctx.path);
    ctx.out(`Instance unlinked (in ${ctx.path}); the next server start opens the setup wizard.`);
    return 0;
  }
  if ((TOP_KEYS as readonly string[]).includes(key)) {
    updateConfig((c) => void delete c[key as "workspace" | "version" | "baseJar"], ctx.path);
  } else {
    if (!registeredSettings().some((x) => x.key === key) && readConfig(ctx.path).config.settings[key] === undefined) {
      ctx.err(`unknown key "${key}"`);
      return 1;
    }
    updateConfig((c) => void delete c.settings[key], ctx.path);
  }
  ctx.out(`${key} removed (in ${ctx.path}); the launch value or default applies.`);
  return 0;
}

function execInherit(cmd: string, args: string[]): Promise<number> {
  return new Promise((ok, fail) => {
    const child = spawn(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
    child.once("error", fail);
    child.once("exit", (code) => ok(code ?? 1));
  });
}
