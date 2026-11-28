import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The turn-end hook's meeting point (docs/design/19-canvas-and-requests.md, *When a request has
 * concluded*). Each MCP process whose observe listener is open writes one **port file**,
 * `<AUTOSKETCH_HOME>/run/mcp-<pid>.json` (`~/.autosketch/run/` by default), holding its port and a
 * random token, and removes it on exit. The plugin's `Stop` hook (`autosketch hook turn-end`,
 * `src/cli/hook.ts`) reads every port file, drops those whose process is gone, and posts to each
 * live one. The token guards `POST /v1/hooks/turn-end` (`http.ts`): only a process that can read the
 * user's own `~/.autosketch` can end a turn.
 *
 * Only node built-ins here, so the hook command stays small.
 */

export const TURN_END_PATH = "/v1/hooks/turn-end";

export interface PortFile {
  v: 1;
  pid: number;
  port: number;
  token: string;
}

/** `<AUTOSKETCH_HOME>/run` (as `autosketchHome` in core/config.ts). */
export function runDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return join(env.AUTOSKETCH_HOME || join(homedir(), ".autosketch"), "run");
}

export const newToken = (): string => randomBytes(32).toString("hex");

/** Writes this process's port file (owner-only, atomically) and returns its path. */
export function writePortFile(dir: string, entry: Omit<PortFile, "v" | "pid"> & { pid?: number }): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pid = entry.pid ?? process.pid;
  const path = join(dir, `mcp-${pid}.json`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ v: 1, pid, port: entry.port, token: entry.token } satisfies PortFile)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return path;
}

export function removePortFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

/** Whether process `pid` is alive (a process we may not signal still counts). */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The port files of live MCPs in `dir`. Files of processes that are gone (a crash skipped the
 * removal) are deleted; unreadable or malformed files are skipped.
 */
export function livePortFiles(dir: string, isAlive: (pid: number) => boolean = alive): PortFile[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => /^mcp-\d+\.json$/.test(n));
  } catch {
    return [];
  }
  const out: PortFile[] = [];
  for (const name of names) {
    let f: Partial<PortFile>;
    try {
      f = JSON.parse(readFileSync(join(dir, name), "utf8")) as Partial<PortFile>;
    } catch {
      continue;
    }
    if (typeof f.pid !== "number" || typeof f.port !== "number" || typeof f.token !== "string") continue;
    if (!isAlive(f.pid)) {
      removePortFile(join(dir, name));
      continue;
    }
    out.push({ v: 1, pid: f.pid, port: f.port, token: f.token });
  }
  return out;
}

/**
 * The install check's line (`14`; `19`): whether the plugin ships the hook and how many turn ends
 * arrived this session. Measurements only.
 */
export function turnHookLine(route: { listening: boolean; reports: number; last?: number }, plugin: ReturnType<typeof pluginHook>, now = Date.now()): string {
  const installed =
    plugin.state === "installed"
      ? "installed (Claude Code plugin)"
      : plugin.state === "missing"
        ? `missing from the Claude Code plugin at ${plugin.root} (update the plugin)`
        : `not started by the Claude Code plugin, so no hook unless one was added by hand (\`npx -y autosketch ${HOOK_COMMAND}\` on Stop)`;
  const reports = !route.listening
    ? "the route is off (observe.http is false or its listener failed)"
    : route.reports
      ? `${route.reports} turn end${route.reports > 1 ? "s" : ""} reported this session, last ${Math.max(0, Math.round((now - (route.last ?? now)) / 1000))} s ago`
      : "no turn end reported yet this session";
  return `turn-end hook: ${installed}; ${reports}. Without it, in-game requests end on world_reply done or the idle timeout`;
}

/** The subcommand the plugin's hook runs (`autosketch hook turn-end`). */
export const HOOK_COMMAND = "hook turn-end";

/**
 * Whether the Claude Code plugin that started this MCP ships the `Stop` hook (the install check,
 * `14`): Claude Code sets `CLAUDE_PLUGIN_ROOT` for a plugin's MCP servers, and the plugin's
 * `hooks/hooks.json` must run `autosketch hook turn-end` on `Stop`.
 */
export function pluginHook(env: Readonly<Record<string, string | undefined>> = process.env): { state: "installed" | "missing" | "no-plugin"; root?: string } {
  const root = env.CLAUDE_PLUGIN_ROOT;
  if (!root) return { state: "no-plugin" };
  try {
    const file = JSON.parse(readFileSync(join(root, "hooks", "hooks.json"), "utf8")) as { hooks?: Record<string, { hooks?: { type?: string; command?: string }[] }[]> };
    const stop = file.hooks?.Stop ?? [];
    const found = stop.some((g) => (g.hooks ?? []).some((h) => h.type === "command" && typeof h.command === "string" && h.command.includes(HOOK_COMMAND)));
    return { state: found ? "installed" : "missing", root };
  } catch {
    return { state: "missing", root };
  }
}
