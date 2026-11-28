import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

/**
 * Whether the Claude Code session that launched this server listens to it as a channel (13,
 * *Delivery through Claude Code channels*). Claude Code sends the same client capabilities with or
 * without `--channels`, so the only place this shows is the `claude` process's own command line,
 * found by walking up from this process's parent.
 *
 * - `true`: a `claude` ancestor started with `--channels` or `--dangerously-load-development-channels`
 *   naming this server (`server:autosketch`, `plugin:autosketch@…`).
 * - `false`: a `claude` ancestor started without that (a plain terminal session, the VS Code
 *   extension, `claude -p`). In-game requests to it would be dropped silently.
 * - `undefined`: no `claude` ancestor found, or the process table can't be read (another MCP
 *   client, Windows). The caller keeps its default.
 *
 * Reason: the mod hands the link to the newest connection, so a session that can't take requests
 * must not connect on its own, or it takes the link from the one that can.
 */
export function channelSession(server = "autosketch", proc: ProcessTable = systemProcessTable()): boolean | undefined {
  let pid = process.ppid;
  for (let depth = 0; depth < 6 && pid > 1; depth++) {
    const p = proc(pid);
    if (!p) return undefined;
    if (isClaude(p.args)) return namesChannel(p.args, server);
    pid = p.ppid;
  }
  return undefined;
}

/** One process: its parent and its argument vector. */
export interface ProcessInfo {
  ppid: number;
  args: string[];
}

/** Looks a process up by pid; undefined when it can't be read. */
export type ProcessTable = (pid: number) => ProcessInfo | undefined;

const CHANNEL_FLAGS = ["--channels", "--dangerously-load-development-channels"];

/** Whether these arguments are Claude Code's own (`claude`, `claude.exe`, `node …/claude`). */
export function isClaude(args: string[]): boolean {
  const name = (a: string | undefined) => (a ? basename(a).replace(/\.(exe|js|mjs|cjs)$/, "") : "");
  if (name(args[0]) === "claude") return true;
  return /^node(js)?$/.test(name(args[0])) && name(args[1]) === "claude";
}

/** Whether a channel flag in these arguments names `server` (`server:<name>` or `plugin:<name>@<marketplace>`). */
export function namesChannel(args: string[], server: string): boolean {
  const names = (v: string) => v.split(/[\s,]+/).some((e) => e === `server:${server}` || e.startsWith(`plugin:${server}@`));
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const eq = CHANNEL_FLAGS.find((f) => a.startsWith(`${f}=`));
    if (eq && names(a.slice(eq.length + 1))) return true;
    if (!CHANNEL_FLAGS.includes(a)) continue;
    // The flag takes one or more values, up to the next option.
    for (let j = i + 1; j < args.length && !args[j]!.startsWith("-"); j++) if (names(args[j]!)) return true;
  }
  return false;
}

/** The process table: `/proc` on Linux, `ps` on macOS, nothing elsewhere. */
export function systemProcessTable(): ProcessTable {
  if (process.platform === "linux")
    return (pid) => {
      try {
        const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter((a) => a !== "");
        // The command name in `stat` is parenthesised and may hold spaces: the fields after the last ")".
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
        return Number.isInteger(ppid) ? { ppid, args } : undefined;
      } catch {
        return undefined;
      }
    };
  if (process.platform === "darwin")
    return (pid) => {
      try {
        const out = execFileSync("ps", ["-o", "ppid=,args=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).trim();
        const m = /^(\d+)\s+(.*)$/.exec(out);
        // ps joins the arguments with spaces; good enough for flag and value matching.
        return m ? { ppid: Number(m[1]), args: m[2]!.split(/\s+/) } : undefined;
      } catch {
        return undefined;
      }
    };
  return () => undefined;
}
