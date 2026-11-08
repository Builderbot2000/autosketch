import { describe, expect, it } from "vitest";
import type { LoggedEvent, ObserveEvent } from "../../../src/core/events.js";
import { costUsd } from "../../eval/cost.js";
import { imageTokens, jobTable, joinCalls } from "../../eval/join.js";
import { normalizeTranscript, resultTokens, type SdkMessage } from "../../eval/transcript.js";

const usage = (ctx: number, out = 100) => ({ input_tokens: 20, cache_read_input_tokens: ctx - 20, cache_creation_input_tokens: 0, output_tokens: out });
const asst = (id: string, blocks: object[], u: object, parent: string | null = null): SdkMessage[] =>
  blocks.map((b) => ({ type: "assistant", parent_tool_use_id: parent, message: { id, content: [b as never], usage: u } }));
const use = (id: string, tool: string, input: object = {}) => ({ type: "tool_use", id, name: tool.includes("__") || tool === "Task" ? tool : `mcp__autosketch__${tool}`, input });
const result = (id: string, text: string, opts: { image?: boolean; error?: boolean } = {}, parent: string | null = null): SdkMessage => ({
  type: "user",
  parent_tool_use_id: parent,
  message: { content: [{ type: "tool_result", tool_use_id: id, is_error: !!opts.error, content: [...(opts.image ? [{ type: "image" }] : []), { type: "text", text }] }] },
});

let seq = 0;
const ev = (e: ObserveEvent, doc = "base", t = 0): LoggedEvent => ({ v: 1, seq: ++seq, t, doc, ...e }) as LoggedEvent;
const call = (n: number, tool: string, chars: number, extra: { pixels?: number; scope?: string; doc?: string; refused?: string } = {}): LoggedEvent[] => [
  ev({ kind: "call.start", call: n, tool, ...(extra.scope ? { scope: extra.scope } : {}) }, extra.doc),
  ...(extra.refused ? [ev({ kind: "call.refused", call: n, tool, code: extra.refused, message: "no" }, extra.doc)] : []),
  ev({ kind: "call.end", call: n, tool, ms: 3, ok: !extra.refused, chars, images: extra.pixels ? 1 : 0, pixels: extra.pixels ?? 0, ...(extra.scope ? { scope: extra.scope } : {}) }, extra.doc),
];

describe("transcript normalization", () => {
  it("groups per-block assistant messages into turns, counts usage once, and tracks subagent threads", () => {
    const msgs: SdkMessage[] = [
      { type: "system", subtype: "init", tools: ["mcp__autosketch__fill", "Task"] },
      ...asst("m1", [{ type: "text", text: "planning" }, use("a", "doc_new"), use("b", "fill")], usage(1000)),
      { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "a", content: "x".repeat(400) }, { type: "tool_result", tool_use_id: "b", content: [{ type: "text", text: "y".repeat(800) }] }] } },
      ...asst("m2", [use("t", "Task")], usage(1400)),
      ...asst("s1", [use("c", "render")], usage(500, 40), "t"),
      result("c", "caption", { image: true }, "t"),
      ...asst("s2", [{ type: "text", text: "sub done" }], usage(1400, 30), "t"),
      result("t", "report"),
      ...asst("m3", [{ type: "text", text: "Built it." }], usage(1600, 20)),
      { type: "result", subtype: "success", total_cost_usd: 0.12, result: "Built it." },
    ];
    const t = normalizeTranscript(msgs);
    expect(t.offeredTools).toEqual(["mcp__autosketch__fill", "Task"]);
    expect(t.turns.map((x) => `${x.thread}:${x.id}`)).toEqual(["main:m1", "main:m2", "t:s1", "t:s2", "main:m3"]);
    expect(t.calls.map((c) => [c.tool ?? c.name, c.thread, c.resultChars, c.resultImages, c.ok])).toEqual([
      ["doc_new", "main", 400, 0, true],
      ["fill", "main", 800, 0, true],
      ["Task", "main", 6, 0, true],
      ["render", "t", 7, 1, true],
    ]);
    // Usage per turn, not per block: 5 turns.
    expect(t.usage).toEqual({ input: 100, output: 290, cacheRead: 1000 + 1400 + 500 + 1400 + 1600 - 100, cacheWrite: 0 });
    expect(t.reportedCostUsd).toBe(0.12);
    expect(t.finalText).toBe("Built it.");
    expect(t.isError).toBe(false);
    expect(costUsd("claude-sonnet-5-5", { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 })).toBeCloseTo(2 + 10 + 0.2 + 2.5);
    expect(costUsd("some-model", t.usage)).toBeUndefined();

    // Context growth after m1 is 1400 - 1000 - 100 = 300, split 1:2 by result size (101 vs 201 weights).
    const tok = resultTokens(t);
    expect(tok[0]! + tok[1]!).toBe(300);
    expect(tok[0]).toBe(Math.round((300 * 101) / 302));
    // Task: main m2 → m3: 1600 - 1400 - 100 = 100. Subagent render: 1400 - 500 - 40 = 860.
    expect(tok[2]).toBe(100);
    expect(tok[3]).toBe(860);
  });

  it("marks errored runs and failed calls", () => {
    const t = normalizeTranscript([...asst("m1", [use("a", "fill")], usage(100)), result("a", "bad", { error: true }), { type: "result", subtype: "error_max_turns", is_error: true }]);
    expect(t.calls[0]!.ok).toBe(false);
    expect(t.isError).toBe(true);
    expect(t.stopReason).toBe("error_max_turns");
  });
});

describe("log join (12, Metrics and evals)", () => {
  it("pairs calls by tool in order, tolerating out-of-order parallel execution", () => {
    const t = normalizeTranscript([
      ...asst("m1", [use("a", "fill"), use("b", "render"), use("c", "fill")], usage(1000)),
      result("a", "f1"),
      result("b", "r", { image: true }),
      result("c", "f2"),
      ...asst("m2", [use("d", "analyze")], usage(3000)),
      result("d", "analysis"),
    ]);
    // The server ran render first, then the fills; analyze never reached it (e.g. log off).
    const events = [...call(1, "render", 40, { pixels: 750 * 400 }), ...call(2, "fill", 10), ...call(3, "fill", 12), ...call(4, "view_slice", 99)];
    const j = joinCalls(t, events);
    expect(j.calls.map((c) => [c.tool, c.logged?.call])).toEqual([["fill", 2], ["render", 1], ["fill", 3], ["analyze", undefined]]);
    expect(j.unmatchedTranscript).toBe(1);
    expect(j.unmatchedLog).toBe(1);
    expect(imageTokens(750 * 400)).toBe(400);
    // Growth 3000 - 1000 - 100 = 1900, split by weight chars/4 + image tokens + 1: the render's
    // weight uses the logged pixels (400 image tokens): 1.5, 401.25, 1.5.
    expect(j.calls.map((c) => c.tokens)).toEqual([7, 1886, 7, undefined]);
  });

  it("builds the per-job and per-session tables from scope events", () => {
    const fork = (scope: string, parent: string, depth: number, brief: string, t: number) =>
      ev({ kind: "scope.fork", scope, parent, depth, brief, work: { min: [0, 0, 0], max: [9, 9, 9] }, context: { min: [-2, 0, -2], max: [11, 9, 11] }, translation: [0, 0, 0] }, parent, t);
    const events: LoggedEvent[] = [
      fork("s1", "base", 1, "north tower", 1000),
      fork("s2", "base", 1, "north tower", 1100),
      ...call(10, "fill", 30, { scope: "s1", doc: "s1" }),
      ev({ kind: "doc.op", jseq: 1, op: "fill", summary: "", changed: 10, counts: { placed: {}, removed: 0 } }, "s1"),
      ev({ kind: "doc.op", jseq: 2, op: "fill", summary: "", changed: 10, counts: { placed: {}, removed: 0 } }, "s1"),
      ...call(11, "render", 50, { scope: "s1", doc: "s1", pixels: 750 * 100 }),
      ...call(12, "fill", 20, { scope: "base", refused: "lock_overlap" }),
      fork("s3", "s1", 2, "turret", 1500),
      ev({ kind: "scope.merge", scope: "s1", report: "done", jseq: 5 }, "base", 4000),
      ev({ kind: "scope.abandon", scope: "s2", reason: "call" }, "base", 4100),
    ];
    const t = normalizeTranscript([
      ...asst("m1", [use("a", "fill", { scope: "s1" })], usage(1000)),
      result("a", "x".repeat(120)),
      ...asst("m2", [use("b", "render", { scope: "s1" })], usage(1200)),
      result("b", "y", { image: true }),
      ...asst("m3", [use("c", "fill")], usage(1700)),
      result("c", "refused"),
    ]);
    const { jobs, session } = jobTable(events, joinCalls(t, events));
    const s1 = jobs.find((j) => j.scope === "s1")!;
    expect(s1).toMatchObject({ outcome: "merged", ops: 2, calls: 2, refusals: 0, responseChars: 80, imageTokens: 100, wallMs: 3000, depth: 1 });
    expect(s1.tokens).toBe(1200 - 1000 - 100 + (1700 - 1200 - 100));
    expect(jobs.find((j) => j.scope === "s2")).toMatchObject({ outcome: "abandoned", wallMs: 3000 });
    expect(jobs.find((j) => j.scope === "s3")).toMatchObject({ outcome: "open", parent: "s1", depth: 2 });
    expect(session).toEqual({ forks: 3, merges: 1, abandons: 1, maxDepth: 2, refusals: { lock_overlap: 1 }, maxParallel: 3, repeatedBriefs: 1 });
  });
});
