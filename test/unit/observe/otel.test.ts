import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoggedEvent } from "../../../src/core/events.js";
import { EventBus } from "../../../src/observe/bus.js";
import { ObserveHttp } from "../../../src/observe/http.js";
import { EventLog } from "../../../src/observe/log.js";
import { readSessionLog } from "../../../src/observe/reader.js";
import { observeCall } from "../../../src/server/observe-call.js";
import { modelAt } from "../../../src/observe/replay.js";
import { SessionModel } from "../../../src/observe/session-model.js";

/** Token spend from the OTLP receiver (13, *Backlog* B3). */

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
    const http = new ObserveHttp({ port: 0, publish: (e) => void bus.publish("base", e) });
    const base = await http.start();
    bus.publish("base", { kind: "session.open", name: "keep" });

    // Nothing but /v1/logs is served, and only to loopback hosts.
    expect((await send(`${base}info`)).status).toBe(404);
    expect((await send(`${base}api/settings`)).status).toBe(404);
    expect((await send(`${base}v1/logs`, { method: "POST", headers: { host: "evil.example" }, body: batch([]) })).status).toBe(403);

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
    expect(http.otelRecords).toBe(9);

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

});
