import { afterAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookBody, runHook } from "../../../src/cli/hook.js";
import type { LoggedEvent } from "../../../src/core/events.js";
import { Settings } from "../../../src/core/settings.js";
import { Document } from "../../../src/document/document.js";
import { ObserveHttp } from "../../../src/observe/http.js";
import { startObserve } from "../../../src/observe/index.js";
import { livePortFiles, pluginHook, turnHookLine, writePortFile } from "../../../src/observe/turn-hook.js";

/** The turn-end hook and its route (19, *When a request has concluded*). */

const ROOT = join(import.meta.dirname, "../../..");
const roots: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "autosketch-hook-"));
  roots.push(d);
  return d;
};
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

function send(url: string, opts: { headers?: Record<string, string>; body?: string } = {}): Promise<number> {
  return new Promise((ok, fail) => {
    const req = request(url, { method: "POST", headers: opts.headers ?? {} }, (res) => {
      res.resume();
      res.on("end", () => ok(res.statusCode ?? 0));
    });
    req.on("error", fail);
    req.end(opts.body);
  });
}

describe("POST /v1/hooks/turn-end", () => {
  it("needs the bearer token and passes Host and Origin checks; only a valid ping is an event", async () => {
    const got: unknown[] = [];
    const http = new ObserveHttp({ port: 0, publish: (e) => void got.push(e), turnEndToken: "secret", now: () => 1234 });
    const url = `${await http.start()}v1/hooks/turn-end`;
    const body = JSON.stringify({ reason: "stop", session: "abc" });
    const json = { "content-type": "application/json" };
    expect(await send(url, { headers: json, body })).toBe(403);
    expect(await send(url, { headers: { ...json, authorization: "Bearer wrong" }, body })).toBe(403);
    expect(await send(url, { headers: { ...json, authorization: "Bearer secretx" }, body })).toBe(403);
    expect(await send(url, { headers: { ...json, authorization: "secret" }, body })).toBe(403);
    expect(await send(url, { headers: { ...json, authorization: "Bearer secret", host: "evil.example" }, body })).toBe(403);
    expect(await send(url, { headers: { ...json, authorization: "Bearer secret", origin: "http://evil.example" }, body })).toBe(403);
    expect(await send(url, { headers: { ...json, authorization: "Bearer secret" }, body: "{not json" })).toBe(400);
    expect(got).toEqual([]);
    expect(http.turnEnds).toBe(0);
    expect(await send(url, { headers: { ...json, authorization: "Bearer secret" }, body })).toBe(200);
    expect(await send(url, { headers: { authorization: "bearer secret" } })).toBe(200);
    expect(got).toEqual([
      { kind: "turn.end", at: 1234, reason: "stop", session: "abc" },
      { kind: "turn.end", at: 1234 },
    ]);
    expect(http.turnEnds).toBe(2);
    expect(http.lastTurnEnd).toBe(1234);
    await http.close();
  });

  it("doesn't exist without a token", async () => {
    const http = new ObserveHttp({ port: 0, publish: () => {} });
    const url = await http.start();
    expect(await send(`${url}v1/hooks/turn-end`, { headers: { authorization: "Bearer " } })).toBe(404);
    await http.close();
  });
});

describe("port file", () => {
  it("is written when the listener opens (owner-only, port and token) and removed on close", async () => {
    const dir = join(temp(), "run");
    const o = startObserve({ workspace: temp(), settings: Settings.from(["--set", "observe.http=true"], {}), getDoc: () => new Document({ name: "d" }), runDir: dir });
    await o.ready;
    const files = readdirSync(dir);
    expect(files).toEqual([`mcp-${process.pid}.json`]);
    const f = JSON.parse(readFileSync(join(dir, files[0]!), "utf8"));
    expect(f).toEqual({ v: 1, pid: process.pid, port: o.http!.port, token: expect.stringMatching(/^[0-9a-f]{64}$/) });
    if (process.platform !== "win32") expect(statSync(join(dir, files[0]!)).mode & 0o077).toBe(0);
    expect(o.turnHook()).toEqual({ listening: true, reports: 0 });
    await o.close();
    expect(readdirSync(dir)).toEqual([]);
    expect(o.turnHook().listening).toBe(false);
  });

  it("isn't written when observe.http is off", async () => {
    const dir = join(temp(), "run");
    const o = startObserve({ workspace: temp(), settings: Settings.from(["--set", "observe.http=false"], {}), getDoc: () => new Document({ name: "d" }), runDir: dir });
    await o.ready;
    expect(existsSync(dir)).toBe(false);
    expect(o.turnHook()).toEqual({ listening: false, reports: 0 });
    await o.close();
  });

  it("of a process that is gone is dropped by the reader; malformed files are skipped", () => {
    const dir = join(temp(), "run");
    writePortFile(dir, { pid: 111, port: 1, token: "a" });
    writePortFile(dir, { pid: 222, port: 2, token: "b" });
    writeFileSync(join(dir, "mcp-333.json"), "{");
    writeFileSync(join(dir, "other.json"), "{}");
    expect(livePortFiles(dir, (pid) => pid === 222)).toEqual([{ v: 1, pid: 222, port: 2, token: "b" }]);
    expect(readdirSync(dir).sort()).toEqual(["mcp-222.json", "mcp-333.json", "other.json"]);
    expect(livePortFiles(join(dir, "none"))).toEqual([]);
  });
});

describe("autosketch hook turn-end", () => {
  const settings = () => Settings.from(["--set", "observe.http=true"], {});

  it("against a running MCP produces exactly one turn.end on the bus, with the hook's reason and session", async () => {
    const dir = join(temp(), "run");
    const o = startObserve({ workspace: temp(), settings: settings(), getDoc: () => new Document({ name: "d" }), runDir: dir });
    await o.ready;
    const events: LoggedEvent[] = [];
    o.bus.subscribe((e) => void events.push(e));
    const input = JSON.stringify({ session_id: "s-1", hook_event_name: "Stop", stop_hook_active: false });
    expect(await runHook(["turn-end"], { dir, input: async () => input })).toBe(0);
    const ends = events.filter((e) => e.kind === "turn.end");
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ kind: "turn.end", reason: "stop", session: "s-1", doc: "base" });
    expect(o.turnHook()).toMatchObject({ listening: true, reports: 1 });
    await o.close();
  });

  it("pings every live MCP", async () => {
    const dir = join(temp(), "run");
    const a = startObserve({ workspace: temp(), settings: settings(), getDoc: () => new Document({ name: "a" }), runDir: dir });
    await a.ready;
    // A second MCP in another process: same layout, another pid (this one's is taken by `a`).
    const got: unknown[] = [];
    const b = new ObserveHttp({ port: 0, publish: (e) => void got.push(e), turnEndToken: "tb" });
    await b.start();
    writePortFile(dir, { pid: process.ppid, port: b.port, token: "tb" });
    expect(await runHook(["turn-end"], { dir, input: async () => "" })).toBe(0);
    expect(a.turnHook().reports).toBe(1);
    expect(got).toMatchObject([{ kind: "turn.end", reason: "stop" }]);
    await a.close();
    await b.close();
  });

  it("with no MCP running returns at once with 0; with an MCP that never answers, within the 1 s budget", async () => {
    const empty = join(temp(), "run");
    let t = Date.now();
    expect(await runHook(["turn-end"], { dir: empty, input: () => new Promise(() => {}) })).toBe(0);
    expect(Date.now() - t).toBeLessThan(100);
    // A port file whose listener accepts but never answers.
    const { createServer } = await import("node:net");
    const silent = createServer(() => {});
    await new Promise<void>((ok) => silent.listen(0, "127.0.0.1", () => ok()));
    const dir = join(temp(), "run");
    mkdirSync(dir);
    writePortFile(dir, { pid: process.pid, port: (silent.address() as { port: number }).port, token: "x" });
    t = Date.now();
    expect(await runHook(["turn-end"], { dir, input: () => new Promise(() => {}) })).toBe(0);
    const ms = Date.now() - t;
    expect(ms).toBeGreaterThanOrEqual(900);
    expect(ms).toBeLessThan(1300);
    silent.close();
  });

  it("from the command line: prints nothing and exits 0, reading the hook input from stdin", async () => {
    const home = temp();
    const dir = join(home, "run");
    const o = startObserve({ workspace: temp(), settings: settings(), getDoc: () => new Document({ name: "d" }), runDir: dir });
    await o.ready;
    const events: LoggedEvent[] = [];
    o.bus.subscribe((e) => void events.push(e));
    const child = spawn(process.execPath, ["--import", "tsx", join(ROOT, "src/server/index.ts"), "hook", "turn-end"], { env: { ...process.env, AUTOSKETCH_HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.stdin.end(JSON.stringify({ session_id: "s-2", hook_event_name: "StopFailure", error: "rate_limit" }));
    const code = await new Promise<number | null>((ok) => child.once("exit", ok));
    expect(code).toBe(0);
    expect(out).toBe("");
    expect(events.filter((e) => e.kind === "turn.end")).toMatchObject([{ kind: "turn.end", reason: "error", session: "s-2" }]);
    await o.close();
  });

  it("ignores other subcommands and odd input", async () => {
    expect(await runHook(["nope"])).toBe(0);
    expect(hookBody("")).toEqual({ reason: "stop" });
    expect(hookBody("not json")).toEqual({ reason: "stop" });
    expect(hookBody('{"hook_event_name":"StopFailure","session_id":"x"}')).toEqual({ reason: "error", session: "x" });
  });
});

describe("install check (14)", () => {
  it("reads the plugin's hooks.json through CLAUDE_PLUGIN_ROOT", () => {
    expect(pluginHook({})).toEqual({ state: "no-plugin" });
    const root = temp();
    expect(pluginHook({ CLAUDE_PLUGIN_ROOT: root })).toEqual({ state: "missing", root });
    mkdirSync(join(root, "hooks"));
    writeFileSync(join(root, "hooks", "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo hi" }] }] } }));
    expect(pluginHook({ CLAUDE_PLUGIN_ROOT: root }).state).toBe("missing");
    writeFileSync(join(root, "hooks", "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "npx -y autosketch@9.9.9 hook turn-end" }] }] } }));
    expect(pluginHook({ CLAUDE_PLUGIN_ROOT: root }).state).toBe("installed");
  });

  it("states what it measured", () => {
    expect(turnHookLine({ listening: true, reports: 2, last: 7000 }, { state: "installed", root: "/p" }, 10_000)).toBe(
      "turn-end hook: installed (Claude Code plugin); 2 turn ends reported this session, last 3 s ago. Without it, in-game requests end on world_reply done or the idle timeout",
    );
    expect(turnHookLine({ listening: true, reports: 0 }, { state: "missing", root: "/p" })).toContain("missing from the Claude Code plugin at /p (update the plugin); no turn end reported yet this session");
    expect(turnHookLine({ listening: false, reports: 0 }, { state: "no-plugin" })).toContain("not started by the Claude Code plugin");
    expect(turnHookLine({ listening: false, reports: 0 }, { state: "no-plugin" })).toContain("the route is off (observe.http is false");
  });
});
