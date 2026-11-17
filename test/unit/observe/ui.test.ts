import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, writeConfig } from "../../../src/core/config.js";
import type { LoggedEvent } from "../../../src/core/events.js";
import { registeredSettings, settingControl, Settings } from "../../../src/core/settings.js";
import { EventBus } from "../../../src/observe/bus.js";
import { ObserveHttp } from "../../../src/observe/http.js";
import { EventLog } from "../../../src/observe/log.js";
import { readSessionLog } from "../../../src/observe/reader.js";
import { OBSERVE_SNAPSHOTS } from "../../../src/observe/settings.js";
import { LogTables } from "../../../src/observe/states.js";
import { SCOPE_MAX_DEPTH } from "../../../src/scope/settings.js";
// Every area that declares settings, so the registry is the server's.
import "../../../src/assets/settings.js";
import "../../../src/server/settings.js";
import "../../../src/world/settings.js";
import { observeCall } from "../../../src/server/observe-call.js";
import { modelAt } from "../../../src/observe/replay.js";
import { SessionModel } from "../../../src/observe/session-model.js";

/** The management UI (docs/design/15-management-ui.md, U1 and U2) and token spend (13, *Backlog* B3). */

const roots: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "autosketch-ui-"));
  roots.push(d);
  return d;
};
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

interface Reply {
  status: number;
  body: string;
  json: () => any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function send(url: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Reply> {
  const data = opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  return new Promise((ok, fail) => {
    const req = request(url, { method: opts.method ?? "GET", headers: { ...(data !== undefined ? { "content-type": "application/json" } : {}), ...opts.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        ok({ status: res.statusCode ?? 0, body, json: () => JSON.parse(body) });
      });
    });
    req.on("error", fail);
    req.end(data);
  });
}

async function settingsServer(argv: string[] = [], env: Record<string, string> = {}, configPollMs?: number) {
  const dir = temp();
  const path = join(dir, "config.toml");
  writeFileSync(path, '[settings]\n"scope.maxDepth" = 2\n');
  const settings = Settings.from(argv, env, readConfig(path));
  const http = new ObserveHttp({ bus: new EventBus(), tables: new LogTables(() => {}), sessionId: "s", dirFor: () => dir, docFor: () => undefined, port: 0, settings, ...(configPollMs ? { configPollMs } : {}) });
  const page = await http.start();
  const base = page.replace(/#.*$/, "");
  const origin = base.replace(/\/$/, "");
  const token = /#t=(.+)$/.exec(page)![1]!;
  const write = { origin, "x-autosketch-token": token };
  return { dir, path, settings, http, page, base, origin, token, write };
}

describe("app shell security (15, *Security*)", () => {
  it("refuses writes without the token, with a foreign or missing Origin, or through GET; the page's own requests go through", async () => {
    const { http, base, origin, token, write, path } = await settingsServer();
    const key = `${base}api/settings/observe.snapshots`;
    const before = readFileSync(path, "utf8");
    const body = { value: "merge" };
    expect((await send(key, { method: "PUT", body, headers: { origin } })).status).toBe(403);
    expect((await send(key, { method: "PUT", body, headers: { origin, "x-autosketch-token": "nope" } })).status).toBe(403);
    expect((await send(key, { method: "PUT", body, headers: { origin: "http://evil.example", "x-autosketch-token": token } })).status).toBe(403);
    expect((await send(key, { method: "PUT", body, headers: { origin: "http://127.0.0.1:1", "x-autosketch-token": token } })).status).toBe(403);
    expect((await send(key, { method: "PUT", body, headers: { "x-autosketch-token": token } })).status).toBe(403);
    // GET never changes anything, even when it carries everything a write needs.
    expect((await send(`${key}?value=merge`, { headers: write })).status).toBe(405);
    expect((await send(key, { method: "POST", body, headers: write })).status).toBe(405);
    // A preflight is never approved.
    const pre = await send(key, { method: "OPTIONS", headers: { origin: "http://evil.example", "access-control-request-method": "PUT" } });
    expect(pre.status).toBe(405);
    expect(readFileSync(path, "utf8")).toBe(before);
    // Non-API paths stay GET only.
    expect((await send(`${base}info`, { method: "POST", headers: write })).status).toBe(405);
    expect((await send(key, { method: "PUT", body, headers: write })).status).toBe(200);
    expect(readConfig(path).config.settings["observe.snapshots"]).toBe("merge");
    // localhost is the same server too.
    expect((await send(key.replace("127.0.0.1", "localhost"), { method: "DELETE", headers: { ...write, origin: origin.replace("127.0.0.1", "localhost") } })).status).toBe(200);
    await http.close();
  });

  it("puts the token in the URL fragment and the url file, and serves the shell without extra requests for Observe", async () => {
    const { http, page, base, dir } = await settingsServer();
    expect(page).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#t=[\w-]{32}$/);
    const html = await send(base);
    expect(html.status).toBe(200);
    // The Observe tab's static requests are what they were before the shell: the stylesheet and main.js
    // (plus three.js, by main.js's imports). Other tabs are only reached through import() on first open.
    const statics = [...html.body.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    expect(statics).toEqual(["style.css", "js/main.js"]);
    expect([...html.body.matchAll(/import\(/g)]).toHaveLength(1);
    expect(html.body).toMatch(/settings: "\.\/js\/tabs\/settings\.js"/);
    const graph = new Set<string>();
    const walk = (file: string) => {
      if (graph.has(file)) return;
      graph.add(file);
      const src = readFileSync(join(import.meta.dirname, "..", "..", "..", "viewer", "js", file), "utf8");
      expect(src).not.toMatch(/\bimport\((?!"\.\/voxels\.js"\))/); // (a JSDoc type reference is not a load)
      expect(src).not.toMatch(/tabs\//);
      for (const m of src.matchAll(/^import .* from "\.\/([\w./]+)";$/gm)) walk(m[1]!);
    };
    walk("main.js");
    expect([...graph].sort()).toEqual(["gl.js", "main.js", "model.js", "panels.js", "replay.js", "voxels.js"]);
    expect((await send(`${base}js/tabs/settings.js`)).status).toBe(200);
    // The url file is written once a document opens (session.open).
    http.onEvent({ v: 1, seq: 1, t: 0, doc: "base", kind: "session.open", name: "keep" });
    await new Promise((r) => setTimeout(r, 50));
    expect(readFileSync(join(dir, "url"), "utf8")).toBe(page + "\n");
    await http.close();
  });
});

describe("Settings tab endpoints (15, *Settings tab*)", () => {
  it("lists every registered setting with control, source, overridden launch value and restart note", async () => {
    const { http, base, write } = await settingsServer(["--set", "observe.snapshots=checkpoint", "--set", "scope.maxDepth=4"], { AUTOSKETCH_OBSERVE_LOG: "false" });
    const view = (await send(`${base}api/settings`)).json();
    expect(view.settings.map((s: { key: string }) => s.key)).toEqual(registeredSettings().map((s) => s.key));
    const row = (k: string) => view.settings.find((s: { key: string }) => s.key === k);
    expect(row("scope.maxDepth")).toMatchObject({
      group: "Scopes",
      applies: "restart",
      control: { type: "number", min: 1, max: 16 },
      value: 2,
      source: { kind: "config", label: "config.toml" },
      overrides: { label: "--set", raw: "4", same: false, note: "launch command sets --set scope.maxDepth=4; ignored, config.toml says 2" },
      restartNeeded: false,
    });
    expect(row("observe.snapshots")).toMatchObject({ control: { type: "select", options: ["merge", "checkpoint", "off"] }, value: "checkpoint", source: { kind: "set", label: "command line (--set)" } });
    expect(row("observe.log")).toMatchObject({ control: { type: "toggle" }, value: false, source: { kind: "env", label: "environment: AUTOSKETCH_OBSERVE_LOG" } });
    expect(row("modOrder")).toMatchObject({ group: "Assets", control: { type: "list" }, value: null, default: null });
    expect(row("tintBiome")).toMatchObject({ group: "Assets", control: { type: "text" } });
    for (const s of view.settings) expect(s.summary, s.key).toBeTruthy();

    // Saving: config.toml beats the launch value, and the running value is now stale.
    const put = await send(`${base}api/settings/observe.snapshots`, { method: "PUT", headers: write, body: { value: "merge", hash: view.hash } });
    expect(put.status).toBe(200);
    expect(put.json()).toMatchObject({ value: "merge", source: { kind: "config" }, restartNeeded: true, running: "checkpoint", overrides: { note: "launch command sets --set observe.snapshots=checkpoint; ignored, config.toml says merge" } });
    // Reset: the launch value applies again, and matches what is running.
    const del = await send(`${base}api/settings/observe.snapshots`, { method: "DELETE", headers: write });
    expect(del.json()).toMatchObject({ value: "checkpoint", source: { kind: "set" }, restartNeeded: false });
    expect(del.json().overrides).toBeUndefined();
    await http.close();
  });

  it("round-trips through config.toml, follows outside edits, and refuses stale or invalid writes", async () => {
    const { http, base, write, path, settings } = await settingsServer();
    const url = `${base}api/settings/scope.maxDepth`;
    let view = (await send(`${base}api/settings`)).json();
    expect((await send(url, { method: "PUT", headers: write, body: { value: 99, hash: view.hash } })).status).toBe(400);
    expect((await send(`${base}api/settings/no.such`, { method: "PUT", headers: write, body: { value: 1 } })).status).toBe(404);
    expect((await send(url, { method: "PUT", headers: write, body: "{not json" })).status).toBe(400);

    const ok = await send(url, { method: "PUT", headers: write, body: { value: 5, hash: view.hash } });
    expect(ok.status).toBe(200);
    expect(readConfig(path).config.settings["scope.maxDepth"]).toBe("5");
    expect(settings.get(SCOPE_MAX_DEPTH)).toBe(5);

    // `autosketch config set` (the same store) changes the file behind the page's back.
    const snap = readConfig(path);
    writeConfig({ ...snap.config, settings: { ...snap.config.settings, "observe.snapshots": "merge" } }, snap.hash, path);
    // A write that names the hash the page read before is refused, and the file stays as written.
    const stale = await send(url, { method: "PUT", headers: write, body: { value: 7, hash: ok.json().hash } });
    expect(stale.status).toBe(409);
    expect(stale.json().conflict).toBe(true);
    expect(readConfig(path).config.settings).toEqual({ "scope.maxDepth": "5", "observe.snapshots": "merge" });
    // The open page sees the outside edit on its next read.
    view = (await send(`${base}api/settings`)).json();
    expect(view.settings.find((s: { key: string }) => s.key === "observe.snapshots")).toMatchObject({ value: "merge", source: { kind: "config" } });
    expect(settings.get(OBSERVE_SNAPSHOTS)).toBe("merge");

    // A file with problems is reported and never rewritten (a save would drop what didn't parse).
    writeFileSync(path, "[settings\n");
    view = (await send(`${base}api/settings`)).json();
    expect(view.warnings[0]).toMatch(/not valid TOML/);
    const broken = await send(url, { method: "PUT", headers: write, body: { value: 3 } });
    expect(broken.status).toBe(409);
    expect(readFileSync(path, "utf8")).toBe("[settings\n");

    // An invalid value written by hand shows on its row, and the next source applies.
    writeFileSync(path, '[settings]\n"scope.maxDepth" = "deep"\n"other.key" = "x"\n');
    view = (await send(`${base}api/settings`)).json();
    expect(view.settings.find((s: { key: string }) => s.key === "scope.maxDepth")).toMatchObject({ value: 3, source: { kind: "default" }, invalid: { raw: "deep" } });
    expect(view.unknown).toEqual(["other.key"]);
    await http.close();
  });

  it("reloads Settings when config.toml changes on disk, with no request", async () => {
    const { http, path, settings } = await settingsServer([], {}, 50);
    // Waits for the watch's own reload (no request is made), however long the poll takes under load.
    const reloaded = new Promise<void>((r) => http.onSettingsReload(r));
    const snap = readConfig(path);
    writeConfig({ ...snap.config, settings: { "scope.maxDepth": "6" } }, snap.hash, path);
    await reloaded;
    expect(settings.get(SCOPE_MAX_DEPTH)).toBe(6);
    await http.close();
  });

  it("picks the control from the parser", () => {
    const byKey = new Map(registeredSettings().map((s) => [s.key, settingControl(s)]));
    expect(byKey.get("observe.open")).toEqual({ type: "toggle" });
    expect(byKey.get("observe.http")).toEqual({ type: "text" });
    expect(byKey.get("world.promptPlayers")).toEqual({ type: "list" });
    expect(byKey.get("observe.deltas")).toEqual({ type: "select", options: ["auto", "on", "off"] });
  });
});

// -- token spend (13, *Backlog* B3) -----------------------------------------------------------------

type Attr = string | number | boolean;
const anyValue = (v: Attr) =>
  typeof v === "boolean" ? { boolValue: v } : typeof v === "number" ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }) : { stringValue: v };
/** A Claude Code log record as its OTLP exporter writes it (event name as body and `event.name`). */
const record = (name: string, ts: number, seq: number, attrs: Record<string, Attr>) => ({
  timeUnixNano: String(ts * 1e6),
  observedTimeUnixNano: String(ts * 1e6),
  body: { stringValue: `claude_code.${name}` },
  attributes: Object.entries({ "event.name": name, "event.timestamp": new Date(ts).toISOString(), "event.sequence": seq, "session.id": "cc-1", "prompt.id": "p1", ...attrs }).map(([key, v]) => ({ key, value: anyValue(v) })),
});
const batch = (records: unknown[]) => ({
  resourceLogs: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] }, scopeLogs: [{ scope: { name: "com.anthropic.claude_code.events", version: "2.0.0" }, logRecords: records }] }],
});
const mcp = (tool: string) => JSON.stringify({ mcp_server_name: "autosketch", mcp_tool_name: tool });

describe("token spend from Claude Code's OpenTelemetry (13, B3)", () => {
  it("receives OTLP/HTTP JSON at /v1/logs, logs records unchanged, and gives prompt totals and per-action labels, live and after replay", async () => {
    const workspace = temp();
    let clock = 1000;
    const bus = new EventBus({ now: () => clock });
    const log = new EventLog({ workspace, sessionId: "s", retain: 5, flushMs: 5 });
    bus.subscribe(log.onEvent);
    const tables = new LogTables((e) => bus.publish("base", e));
    const http = new ObserveHttp({ bus, tables, sessionId: "s", dirFor: () => workspace, docFor: () => undefined, port: 0, publish: (e) => void bus.publish("base", e) });
    bus.subscribe(http.onEvent);
    const base = (await http.start()).replace(/#.*$/, "");
    bus.publish("base", { kind: "session.open", name: "keep" });

    // No telemetry yet: /info carries the setup snippet for the notice.
    const info = (await send(`${base}info`)).json();
    expect(info.otel).toMatchObject({ records: 0, portPinned: false, setup: { OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json", OTEL_LOG_TOOL_DETAILS: "1" } });
    expect(info.otel.setup.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(`${base.replace("127.0.0.1", "localhost")}v1/logs`);

    // Three autosketch calls: two fills (the second in sandbox s1, by a subagent) and a doc_info.
    const sink = () => bus.sink("base");
    const ok = async () => ({ content: [{ type: "text" as const, text: "done" }] });
    clock = 10_000;
    await observeCall(sink, "fill", ok)({ sel: "a", pattern: "stone" });
    clock = 11_000;
    await observeCall(sink, "fill", ok)({ sel: "b", pattern: "glass", scope: "s1" });
    clock = 12_000;
    await observeCall(sink, "doc_info", ok)({});

    // Batch 1: the prompt, two API requests (one a subagent's) and three tool results. The glass
    // result is logged before the stone one, so order alone would pair it with the wrong fill.
    const first = batch([
      record("user_prompt", 9000, 1, { prompt_length: 42 }),
      record("api_request", 9500, 2, { request_id: "r1", model: "claude-x", input_tokens: 1000, output_tokens: 300, cache_read_tokens: 5000, cache_creation_tokens: 200, cost_usd: 0.0125 }),
      record("api_request", 10_500, 3, { request_id: "r3", agent_id: "a1", parent_agent_id: "main", input_tokens: 400, output_tokens: 40, cache_read_tokens: 0, cache_creation_tokens: 100, cost_usd: 0.002 }),
      record("tool_result", 11_100, 4, { request_id: "r3", agent_id: "a1", tool_name: "mcp__autosketch__fill", tool_parameters: mcp("fill"), tool_input: JSON.stringify({ sel: "b", pattern: "glass", scope: "s1" }), success: true, tool_result_size_bytes: 512 }),
      record("tool_result", 11_150, 5, { request_id: "r1", tool_name: "Read", success: true, tool_result_size_bytes: 99 }),
      record("tool_result", 11_200, 6, { request_id: "r1", tool_name: "mcp__autosketch__fill", tool_parameters: mcp("fill"), tool_input: JSON.stringify({ sel: "a", pattern: "stone" }), success: true, tool_result_size_bytes: 2048 }),
    ]);
    clock = 15_000;
    const r1 = await send(`${base}v1/logs`, { method: "POST", body: first });
    expect(r1.status).toBe(200);
    expect(r1.json()).toEqual({});
    // Batch 2: the next request, its doc_info result with a tool_input cut off mid-way (order decides),
    // and an exporter retry of a record already received.
    const second = batch([
      record("api_request", 11_900, 7, { request_id: "r2", input_tokens: 1500, output_tokens: 90, cache_read_tokens: 6000, cache_creation_tokens: 0, cost_usd: 0.004 }),
      record("tool_result", 12_100, 8, { request_id: "r2", tool_name: "mcp__autosketch__doc_info", tool_parameters: mcp("doc_info"), tool_input: '{"verbose":tr', success: true, tool_result_size_bytes: 300 }),
      record("api_request", 9500, 2, { request_id: "r1", input_tokens: 1000, output_tokens: 300, cache_read_tokens: 5000, cache_creation_tokens: 200, cost_usd: 0.0125 }),
    ]);
    expect((await send(`${base}v1/logs`, { method: "POST", body: second })).status).toBe(200);

    // Refused: protobuf (the exporter's default), a foreign page, a non-OTLP body, GET.
    expect((await send(`${base}v1/logs`, { method: "POST", headers: { "content-type": "application/x-protobuf" }, body: "x" })).status).toBe(415);
    expect((await send(`${base}v1/logs`, { method: "POST", headers: { origin: "http://evil.example" }, body: first })).status).toBe(403);
    expect((await send(`${base}v1/logs`, { method: "POST", body: { hello: 1 } })).status).toBe(400);
    expect((await send(`${base}v1/logs`)).status).toBe(405);
    expect((await send(`${base}info`)).json().otel.records).toBe(9);

    await log.flush();
    await http.close();

    const check = (events: LoggedEvent[]) => {
      const otel = events.filter((e) => e.kind === "otel") as Extract<LoggedEvent, { kind: "otel" }>[];
      // Unchanged: the records as posted, in order.
      expect(otel.map((e) => e.record)).toEqual([...first.resourceLogs[0]!.scopeLogs[0]!.logRecords, ...second.resourceLogs[0]!.scopeLogs[0]!.logRecords]);
      const calls = (events.filter((e) => e.kind === "call.start") as Extract<LoggedEvent, { kind: "call.start" }>[]).map((e) => e.call);
      expect((events.find((e) => e.kind === "call.start") as { input?: unknown }).input).toEqual({ sel: "a", pattern: "stone" });
      const live = new SessionModel();
      for (const e of events) live.apply(e);
      for (const m of [live, modelAt(events, events[events.length - 1]!.seq)]) {
        const p = m.spend.prompts.get("p1");
        expect(p.length).toBe(42);
        expect(p.tokens).toEqual({ input: 2900, output: 430, cacheRead: 11000, cacheWrite: 300, cost: expect.closeTo(0.0185, 10), requests: 3 });
        // r1 issued the stone fill and a Read: its 300 output tokens are split between them.
        expect(m.spend.label(calls[0])).toEqual({ request: "r1", bytes: 2048, outputTokens: 150, shared: 2 });
        expect(m.spend.label(calls[1])).toEqual({ request: "r3", bytes: 512, outputTokens: 40, shared: 1 });
        expect(m.spend.label(calls[2])).toEqual({ request: "r2", bytes: 300, outputTokens: 90, shared: 1 });
        // Per job: the subagent's spend lands on the sandbox its calls named.
        expect(m.spend.scopeTotals("s1")).toMatchObject({ input: 400, output: 40, requests: 1 });
        expect(m.spend.scopeTotals("base")).toMatchObject({ input: 2500, output: 390, requests: 2 });
      }
      // Halfway through the replay, only the first batch counts.
      const mid = modelAt(events, otel[5]!.seq);
      expect(mid.spend.prompts.get("p1").tokens).toMatchObject({ output: 340, requests: 2 });
      expect(mid.spend.label(calls[2])).toBeUndefined();
    };
    const logged = (await readSessionLog(join(workspace, "keep", "observe", "s"))).events;
    check(logged);
  });

  it("accepts no telemetry for a finished log", async () => {
    const http = new ObserveHttp({ bus: { lastSeq: 0 }, tables: new LogTables(() => {}), sessionId: "s", dirFor: () => temp(), docFor: () => undefined, port: 0, live: false });
    const base = (await http.start()).replace(/#.*$/, "");
    expect((await send(`${base}v1/logs`, { method: "POST", body: batch([]) })).status).toBe(404);
    expect((await send(`${base}info`)).json().otel).toBeUndefined();
    expect((await send(`${base}api/settings`)).status).toBe(404);
    await http.close();
  });
});
