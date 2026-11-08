import { describe, expect, it } from "vitest";
import { parseArgs, planOf, refusal } from "../../eval/cli.js";
import { formatPlan } from "../../eval/cost.js";
import { permissionFor } from "../../eval/drivers/sdk.js";
import { parseJudgeReply, RUBRIC_VERSION } from "../../eval/rubric.js";

describe("npm run eval arguments and safety", () => {
  it("defaults to the reduced suite, every tool, with the judge on the same model", () => {
    const o = parseArgs([]);
    expect(o.plan.main.map((p) => p.id)).toEqual(["s-hut", "m-cottage", "m-porch"]);
    expect(o.plan.ablations).toEqual(["full"]);
    expect(o.plan.scoped).toEqual([]);
    expect(o.model).toBe("claude-sonnet-5-5");
    expect(o.judgeModel).toBe("claude-sonnet-5-5");
    expect(planOf(o)).toMatchObject({ agentRuns: 3, scopedRuns: 0, judgeCalls: 3 });
  });

  it("plans the full suite, all ablations and the scoped comparison", () => {
    const o = parseArgs(["--suite", "full", "--ablations", "all", "--scoped", "--no-judge", "--model", "claude-opus-5-5"]);
    const plan = planOf(o);
    expect(plan).toMatchObject({ agentRuns: 16 * 6, scopedRuns: 8, judgeCalls: 0, model: "claude-opus-5-5" });
    const text = formatPlan(plan);
    expect(text).toMatch(/16 prompts × 6 ablations .* = 96 agent runs/);
    expect(text).toMatch(/scoped comparison: 8 agent runs/);
    expect(text).toMatch(/judge: off/);
    expect(text).toMatch(/rough cost: \$/);
  });

  it("routes explicit prompts by size and rejects unknown names", () => {
    const o = parseArgs(["--prompts", "s-wall,l-manor", "--ablations", "no_analyze,text_only"]);
    expect(o.plan.main.map((p) => p.id)).toEqual(["s-wall"]);
    expect(o.plan.scoped.map((p) => p.id)).toEqual(["l-manor"]);
    expect(() => parseArgs(["--prompts", "nope"])).toThrow(/unknown prompt "nope"/);
    expect(() => parseArgs(["--ablations", "nope"])).toThrow(/unknown ablation "nope"/);
    expect(() => parseArgs(["--scoped", "s-hut"])).toThrow(/large prompts only/);
    expect(() => parseArgs(["--max-turns", "0"])).toThrow(/positive integer/);
  });

  it("refuses without an API key and in CI", () => {
    expect(refusal({})).toMatch(/ANTHROPIC_API_KEY is not set/);
    expect(refusal({ ANTHROPIC_API_KEY: "k", CI: "true" })).toMatch(/never runs in CI/);
    expect(refusal({ ANTHROPIC_API_KEY: "k" })).toBeUndefined();
  });

  it("lets the agent use only Autosketch tools (and Task when delegating)", async () => {
    const solo = permissionFor(false), deleg = permissionFor(true);
    expect(await solo("mcp__autosketch__fill", { a: 1 })).toEqual({ behavior: "allow", updatedInput: { a: 1 } });
    expect((await solo("Bash", {})).behavior).toBe("deny");
    expect((await solo("Task", {})).behavior).toBe("deny");
    expect((await deleg("Task", {})).behavior).toBe("allow");
    expect((await deleg("mcp__other__x", {})).behavior).toBe("deny");
  });
});

describe("rubric", () => {
  it("parses complete in-range replies only", () => {
    expect(parseJudgeReply('{"prompt_match": 5, "style": 4, "proportion": 3, "craft": 2, "notes": "n"}')).toEqual({ scores: { prompt_match: 5, style: 4, proportion: 3, craft: 2 }, mean: 3.5, notes: "n" });
    expect(parseJudgeReply('Sure: {"prompt_match": 5, "style": 4, "proportion": 3, "craft": 2}')!.notes).toBe("");
    expect(parseJudgeReply('{"prompt_match": 6, "style": 4, "proportion": 3, "craft": 2}')).toBeUndefined();
    expect(parseJudgeReply('{"prompt_match": 5, "style": 4}')).toBeUndefined();
    expect(parseJudgeReply("no json")).toBeUndefined();
    expect(RUBRIC_VERSION).toMatch(/^[0-9a-f]{12}$/);
  });
});
