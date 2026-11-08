import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "../../../src/core/settings.js";
import { startObserve } from "../../../src/observe/index.js";
import { SERVER_VERSION } from "../../../src/server/server.js";
import { Session } from "../../../src/server/session.js";
import { ABLATIONS, ablationByName } from "../../eval/ablations.js";
import { ScriptedDriver, type Step } from "../../eval/drivers/scripted.js";
import { promptById } from "../../eval/prompts.js";
import { compareSummaries, findBaseline, formatSummary, readResult, summarize, writeResult, type SuiteResult } from "../../eval/results.js";
import { RUBRIC_VERSION, type Judge } from "../../eval/rubric.js";
import { runCase, runSuite, type DriverTask, type RunnerOptions, type ServerHost } from "../../eval/runner.js";
import { connectServer, smallContext } from "../../helpers/context.js";

const root = mkdtempSync(join(tmpdir(), "autosketch-evaltest-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const ctx = smallContext();

const door = (x: number, z: number) => [
  { pos: [x, 1, z], block: "oak_door[facing=south,half=lower]" },
  { pos: [x, 2, z], block: "oak_door[facing=south,half=upper]" },
];
const HUT: Step[] = [
  { tool: "doc_new", args: { name: "hut" } },
  { tool: "fill", args: { sel: { min: [0, 0, 0], max: [4, 0, 4] }, pattern: "cobblestone" } },
  { tool: "fill", args: { sel: { min: [0, 1, 0], max: [4, 3, 4] }, pattern: "oak_planks", mode: "walls" } },
  { parallel: [
    { tool: "set_blocks", args: { blocks: door(2, 4) } },
    { tool: "set_blocks", args: { blocks: [[2, 2, 0], [0, 2, 2], [4, 2, 2]].map((pos) => ({ pos, block: "glass_pane" })) } },
  ] },
  { tool: "fill", args: { sel: { min: [0, 4, 0], max: [4, 4, 4] }, pattern: "oak_planks" } },
  { tool: "analyze", args: {} },
  { tool: "render", args: { views: ["iso_se"], size: 256 } },
  { text: "Built a 5×5 oak hut." },
];

/** The in-process stand-in for the stdio server: same server code, an observer writing events.ndjson into the run's workspace. */
const host: ServerHost = {
  listTools: async () => (await (await connectServer(ctx, { session: new Session(root) })).listTools()).tools.map((t) => t.name),
  spec: () => ({ command: "unused", args: [] }),
  settle: async () => {},
};
const connect = async (task: DriverTask) => {
  const session = new Session(task.workspace);
  const observer = startObserve({ workspace: task.workspace, settings: new Settings(), version: SERVER_VERSION, flushMs: 5 });
  session.events = observer.sink("base");
  const client = await connectServer(ctx, { session, hideTools: task.hiddenTools });
  return { client, close: async () => (await session.close(), await observer.close()) };
};
const opts = (script: (t: DriverTask) => Step[], extra: Partial<RunnerOptions> = {}): RunnerOptions => ({ driver: new ScriptedDriver(script, connect), host, workDir: root, ...extra });

let tools: string[];
beforeAll(async () => {
  tools = await host.listTools();
});

describe("eval runner with a scripted driver (10, tier 3)", () => {
  it("runs, scores, joins the event log and writes the transcript", async () => {
    const transcriptDir = join(root, "transcripts");
    const judged: { task: string; images: number }[] = [];
    const judge: Judge = { model: "fake-judge", grade: async (i) => (judged.push({ task: i.task, images: i.images.length }), { text: 'ok {"prompt_match": 4, "style": 3, "proportion": 4, "craft": 5, "notes": "fine"}' }) };
    const r = await runCase(promptById("s-hut")!, ablationByName("full")!, "main", opts(() => HUT, { transcriptDir, judge, render: async () => [Buffer.from("a"), Buffer.from("b")] }), tools);

    expect(r.error).toBeUndefined();
    expect(r.status).toBe("ok");
    expect(r.checks.filter((c) => !c.pass)).toEqual([]);
    expect(r.pass).toBe(true);
    expect(r.blocks).toBe(25 + 16 * 3 + 25); // floor, wall ring (door and panes replace wall blocks), roof
    expect(r.bounds).toEqual({ min: [0, 0, 0], max: [4, 4, 4] });
    expect(r.toolCalls).toBe(8);
    expect(r.failedCalls).toBe(0);
    expect(r.turns).toBe(8);
    // Every Autosketch call found its logged counterpart.
    expect(r.join).toEqual({ unmatchedTranscript: 0, unmatchedLog: 0, dropped: 0 });
    expect(r.tools.fill!.n).toBe(3);
    expect(r.tools.render).toMatchObject({ n: 1, images: 1 });
    expect(r.images).toBe(1);
    expect(r.imageTokens).toBeGreaterThan(0);
    // Single-call turns: the joined tokens equal the synthetic context growth (chars / 4).
    expect(r.tools.analyze!.tokens).toBe(Math.round(r.tools.analyze!.chars / 4));
    expect(r.totalTokens).toBe(r.tokens.input + r.tokens.output + r.tokens.cacheRead + r.tokens.cacheWrite);
    expect(r.costUsd).toBeGreaterThan(0);
    expect(r.session.forks).toBe(0);
    expect(r.rubric).toMatchObject({ mean: 4, notes: "fine" });
    expect(judged).toEqual([{ task: promptById("s-hut")!.text, images: 2 }]);
    const saved = JSON.parse(readFileSync(r.transcript!, "utf8"));
    expect(saved.calls).toHaveLength(8);
    expect(saved.events.some((e: { kind: string }) => e.kind === "doc.op")).toBe(true);
  });

  it("hides tools for an ablation: the hidden call fails and the server never logs it", async () => {
    const r = await runCase(promptById("s-hut")!, ablationByName("no_analyze")!, "main", opts(() => HUT), tools);
    expect(r.hidden).toEqual(["analyze"]);
    expect(r.failedCalls).toBe(1);
    expect(r.join.unmatchedTranscript).toBe(1);
    expect(r.pass).toBe(true);
  });

  it("starts from the seed document and checks it was preserved", async () => {
    const steps: Step[] = [
      { tool: "doc_open", args: { name: "porch" } },
      { tool: "fill", args: { sel: { min: [2, 0, 7], max: [6, 0, 9] }, pattern: "oak_planks" } },
      { tool: "fill", args: { sel: { min: [2, 1, 9], max: [2, 3, 9] }, pattern: "oak_planks" } },
      { tool: "fill", args: { sel: { min: [6, 1, 9], max: [6, 3, 9] }, pattern: "oak_planks" } },
      { tool: "fill", args: { sel: { min: [2, 4, 7], max: [6, 4, 9] }, pattern: "oak_planks" } },
      { text: "Added a porch." },
    ];
    const r = await runCase(promptById("m-porch")!, ablationByName("full")!, "main", opts(() => steps), tools);
    expect(r.status).toBe("ok");
    const byKind = Object.fromEntries(r.checks.map((c) => [c.kind, c]));
    expect(byKind.preserved).toMatchObject({ pass: true, value: 1 });
    expect(byKind.minBlocks!.pass).toBe(true);
  });

  it("fails every check when the document was never saved, and skips the judge", async () => {
    const judge: Judge = { model: "j", grade: async () => ({ text: "{}" }) };
    const r = await runCase(promptById("s-hut")!, ablationByName("full")!, "main", opts(() => [{ text: "I can't." }], { judge, render: async () => [] }), tools);
    expect(r.status).toBe("ok");
    expect(r.pass).toBe(false);
    expect(r.checks.every((c) => !c.pass && c.detail === 'document "hut" was not saved')).toBe(true);
    expect(r.rubric).toBeUndefined();
  });

  it("records a driver failure as an error run", async () => {
    const r = await runCase(promptById("s-hut")!, ablationByName("full")!, "main", opts(() => {
      throw new Error("boom");
    }), tools);
    expect(r).toMatchObject({ status: "error", error: "driver: boom" });
  });

  it("skips a delegated run when the server has no scope tools", async () => {
    const r = await runCase(promptById("l-castle")!, ablationByName("full")!, "delegated", opts(() => []), tools.filter((t) => !t.startsWith("scope_")));
    expect(r).toMatchObject({ status: "skipped", skipped: "server has no scope_fork/scope_merge tools" });
  });

  it("runs a suite with the scoped comparison and writes results compared against a baseline", async () => {
    const plan = { main: [promptById("s-hut")!], ablations: ["full", "text_only"], scoped: [promptById("l-castle")!] };
    const runs = await runSuite(plan, opts((t) => (t.prompt.includes('"castle"') ? [{ tool: "doc_new", args: { name: "castle" } }, { text: "gave up" }] : HUT)));
    expect(runs.map((r) => `${r.id}:${r.status}`)).toEqual(["s-hut.full.main:ok", "s-hut.text_only.main:ok", "l-castle.full.monolithic:ok", "l-castle.full.delegated:ok"]);
    expect(runs[1]!.hidden).toEqual(["palette_sheet", "prefab_sheet", "render"]);
    expect(runs[2]!.hidden).toEqual(["scope_abandon", "scope_fork", "scope_list", "scope_merge"]); // monolithic runs hide the scope tools
    expect(runs[3]!.hidden).toEqual([]);

    const summary = summarize(runs);
    expect(Object.keys(summary.byAblation)).toEqual(["full", "text_only"]);
    expect(summary.byAblation.full).toMatchObject({ runs: 1, errors: 0, passRate: 1, checkRate: 1 });
    expect(summary.byAblation.text_only!.passRate).toBe(1);
    expect(summary.scoped["l-castle"]).toMatchObject({ delegated: { runs: 1, errors: 0 }, consistency: { monolithic: 0, delegated: 0 } });
    expect(summary.scoped["l-castle"]!.monolithic!.passRate).toBe(0);
    expect(summary.forkRate).toEqual({ small: { runs: 1, forks: 0, runsWithFork: 0 } });

    const meta = { date: "2026-11-07", gitSha: "abc1234", model: "claude-sonnet-5-5", rubricVersion: RUBRIC_VERSION, serverVersion: SERVER_VERSION, driver: "scripted", prompts: ["s-hut"], ablations: plan.ablations, scoped: ["l-castle"], serverTools: tools };
    const result: SuiteResult = { meta, runs, summary };
    const dir = join(root, "results");
    expect(await findBaseline(dir)).toBeUndefined();
    const first = await writeResult(dir, "2026-11-06-0000000", result);
    expect(await findBaseline(dir, join(dir, "2026-11-07-abc1234.json"))).toBe(first.json);

    // A worse run: every check failing and twice the tokens.
    const worse: SuiteResult = JSON.parse(JSON.stringify(result));
    worse.summary.byAblation.full = { ...worse.summary.byAblation.full!, passRate: 0, checkRate: 0.5, meanTokens: worse.summary.byAblation.full!.meanTokens * 2 };
    const cmp = compareSummaries(worse.summary, (await readResult(first.json)).summary);
    expect(cmp.regressions.map((g) => `${g.ablation} ${g.metric}`)).toEqual(["full all checks", "full checks", "full tokens"]);
    const second = await writeResult(dir, "2026-11-07-abc1234", worse, { baseline: first.json, ...cmp });
    const md = readFileSync(second.md, "utf8");
    expect(md).toMatch(/^# Eval 2026-11-07 abc1234/);
    expect(md).toMatch(/\| full \| 1 \| 0 \| 0% \| 50% \|/);
    expect(md).toMatch(/\| l-castle \| delegated \|/);
    expect(md).toMatch(/small: 0 forks in 1 runs/);
    expect(md).toMatch(/\*\*Regressions:\*\* full all checks, full checks, full tokens/);
    expect(formatSummary(result)).toMatch(/\| text_only \| 1 \| 0 \| 100% \| 100% \|/);
    expect(existsSync(second.json)).toBe(true);
  });

  it("names only real tools in every ablation", () => {
    for (const a of ABLATIONS) for (const t of a.hide) expect(tools, `${a.name}: ${t}`).toContain(t);
  });
});
