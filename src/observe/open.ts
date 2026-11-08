import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

/** True under WSL, where a Linux browser opener usually has nothing to open. */
const isWsl = (): boolean => {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
};

/** Candidate commands, tried in order until one starts. */
function openers(url: string): [string, string[]][] {
  if (process.platform === "darwin") return [["open", [url]]];
  if (process.platform === "win32") return [["cmd", ["/c", "start", "", url]]];
  if (isWsl()) return [["wslview", [url]], ["cmd.exe", ["/c", "start", "", url]], ["xdg-open", [url]]];
  return [["xdg-open", [url]]];
}

/**
 * Opens `url` in the user's default browser, detached, never touching stdio (which carries MCP).
 * Failures are logged, never thrown.
 */
export function openInBrowser(url: string, log?: (msg: string) => void): void {
  const tries = openers(url);
  const attempt = (i: number) => {
    const next = tries[i];
    if (!next) return log?.(`observe: could not open a browser; open ${url} yourself`);
    const child = spawn(next[0], next[1], { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", () => attempt(i + 1));
    child.once("spawn", () => child.unref());
  };
  attempt(0);
}
