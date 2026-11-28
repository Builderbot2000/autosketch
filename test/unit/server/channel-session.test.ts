import { describe, expect, it } from "vitest";
import { channelSession, isClaude, namesChannel, type ProcessInfo } from "../../../src/server/channel-session.js";

/** A process table rooted at this process's parent, from a chain of argument vectors (nearest first). */
function chain(...argvs: string[][]) {
  const table = new Map<number, ProcessInfo>();
  let pid = process.ppid;
  argvs.forEach((args, i) => {
    const next = 9000 + i;
    table.set(pid, { ppid: i === argvs.length - 1 ? 1 : next, args });
    pid = next;
  });
  return (p: number) => table.get(p);
}

describe("channelSession", () => {
  it("is true for a claude parent started with the development channel flag naming the server", () => {
    expect(channelSession("autosketch", chain(["claude", "--dangerously-load-development-channels", "server:autosketch"]))).toBe(true);
  });

  it("is true for --channels, the plugin form, and through a shell wrapper", () => {
    expect(channelSession("autosketch", chain(["/usr/bin/claude", "--channels", "plugin:autosketch@autosketch"]))).toBe(true);
    expect(channelSession("autosketch", chain(["sh", "-c", "node dist/server/index.js"], ["claude", "--channels=server:autosketch"]))).toBe(true);
  });

  it("is false for a claude session without the flag (VS Code extension, plain terminal, other channels)", () => {
    const vscode = ["/home/u/.vscode-server/extensions/anthropic.claude-code/resources/native-binary/claude", "--output-format", "stream-json"];
    expect(channelSession("autosketch", chain(vscode))).toBe(false);
    expect(channelSession("autosketch", chain(["claude"]))).toBe(false);
    expect(channelSession("autosketch", chain(["claude", "--channels", "server:telegram", "-c"]))).toBe(false);
  });

  it("is undefined for another client or an unreadable table", () => {
    expect(channelSession("autosketch", chain(["cursor"], ["init"]))).toBeUndefined();
    expect(channelSession("autosketch", () => undefined)).toBeUndefined();
  });
});

describe("isClaude / namesChannel", () => {
  it("recognises claude binaries and node-run scripts", () => {
    expect(isClaude(["claude.exe"])).toBe(true);
    expect(isClaude(["node", "/x/node_modules/.bin/claude"])).toBe(true);
    expect(isClaude(["node", "dist/server/index.js"])).toBe(false);
  });

  it("reads several values up to the next option, and stops there", () => {
    expect(namesChannel(["claude", "--channels", "server:a", "server:autosketch", "-c"], "autosketch")).toBe(true);
    expect(namesChannel(["claude", "--channels", "server:a", "-c", "server:autosketch"], "autosketch")).toBe(false);
    expect(namesChannel(["claude", "--channels", "server:autosketch-dev"], "autosketch")).toBe(false);
  });
});
