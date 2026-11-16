import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Roots } from "./types.js";

/**
 * Where a user profile's launchers live (`14`, *Instance discovery*), for the local profile and,
 * under WSL, for the Windows profile: `cmd.exe /c echo %USERPROFILE%`, then `wslpath`. Never a
 * search of `/mnt/c/Users`.
 */

/** Runs a command and returns its stdout. Injected in tests (a stubbed `cmd.exe` and `wslpath`). */
export type Run = (cmd: string, args: string[]) => Promise<string>;

/** The real runner: 5 s timeout; started from `/mnt/c` when it exists, so `cmd.exe` doesn't warn about a UNC working folder. */
export const runCommand: Run = (cmd, args) =>
  new Promise((ok, fail) => {
    const cwd = existsSync("/mnt/c") ? "/mnt/c" : undefined;
    execFile(cmd, args, { timeout: 5000, windowsHide: true, encoding: "utf8", ...(cwd ? { cwd } : {}) }, (err, stdout) => (err ? fail(err) : ok(stdout)));
  });

/** True under WSL (`WSL_DISTRO_NAME`, or "microsoft" in `/proc/version`). */
export function detectWsl(env: Readonly<Record<string, string | undefined>> = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "linux") return false;
  if (env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

/** `C:\…`, `C:/…` or `\\server\…`: a Windows absolute path. */
export const isWindowsAbsolute = (p: string): boolean => /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\/.test(p);

/** The local profile's roots for this OS. */
export function localRoots(platform: NodeJS.Platform, home: string, env: Readonly<Record<string, string | undefined>>): Roots {
  const local = async (p: string, base?: string) => (isAbsolute(p) ? p : base ? resolve(base, p) : resolve(p));
  if (platform === "win32") {
    const appData = env.APPDATA || join(home, "AppData", "Roaming");
    return { os: "win32", home, data: appData, config: appData, local };
  }
  if (platform === "darwin") {
    const support = join(home, "Library", "Application Support");
    return { os: "darwin", home, data: support, config: support, local };
  }
  return { os: "linux", home, data: env.XDG_DATA_HOME || join(home, ".local", "share"), config: env.XDG_CONFIG_HOME || join(home, ".config"), local };
}

/** `C:\Users\me` → `/mnt/c/Users/me`: WSL's default mount layout, used when `wslpath` fails. */
export function defaultWslPath(win: string): string {
  const m = /^([a-zA-Z]):[\\/]?(.*)$/.exec(win);
  return m ? `/mnt/${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, "/")}`.replace(/\/+$/, "") : win.replace(/\\/g, "/");
}

/**
 * The Windows profile's roots, seen from WSL: asks Windows for `%USERPROFILE%` and turns it into a
 * WSL path with `wslpath`. Paths in the Windows launchers' files go through `wslpath` too. Returns
 * undefined (with a reason) when Windows can't be asked.
 */
export async function wslWindowsRoots(run: Run = runCommand): Promise<{ roots?: Roots; warning?: string }> {
  let profile: string;
  try {
    profile = (await run("cmd.exe", ["/c", "echo %USERPROFILE%"])).trim().split(/\r?\n/).pop()!.trim();
  } catch (e) {
    return { warning: `WSL: couldn't ask Windows for the user profile folder (cmd.exe: ${(e as Error).message.split("\n")[0]}); Windows launchers not read` };
  }
  if (!profile || profile.includes("%") || !isWindowsAbsolute(profile)) return { warning: `WSL: cmd.exe gave no user profile folder ("${profile}"); Windows launchers not read` };
  const toWsl = async (win: string): Promise<string> => {
    try {
      const out = (await run("wslpath", ["-u", win])).trim();
      if (out) return out;
    } catch {
      /* fall back to the default mount layout */
    }
    return defaultWslPath(win);
  };
  const home = await toWsl(profile);
  const appData = join(home, "AppData", "Roaming");
  const roots: Roots = {
    os: "win32",
    home,
    data: appData,
    config: appData,
    label: "Windows profile",
    local: async (p, base) => {
      if (isWindowsAbsolute(p)) return toWsl(p);
      if (p.startsWith("/")) return p;
      const rel = p.replace(/\\/g, "/");
      return base ? resolve(base, rel) : resolve(rel);
    },
  };
  return { roots };
}
