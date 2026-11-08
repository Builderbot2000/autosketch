/**
 * `npm run eval` (docs/design/10-testing.md, tier 3). Opt-in and costs tokens: it refuses to run
 * without ANTHROPIC_API_KEY, never runs in CI, and always prints its cost drivers first.
 *
 *   npm run eval -- --dry-run                       # print the plan and cost drivers only
 *   npm run eval                                    # reduced suite: 3 prompts, every tool
 *   npm run eval -- --suite full --ablations all    # 16 main prompts × 6 ablations
 *   npm run eval -- --scoped                        # + large prompts, monolithic vs delegated
 *   npm run eval -- --prompts s-hut,m-cottage --model claude-sonnet-5-5 --no-judge
 *
 * Options: --suite reduced|full, --prompts a,b, --ablations all|a,b, --scoped [a,b], --model m,
 * --judge-model m, --no-judge, --max-turns n, --out dir, --baseline file, --keep (workspaces),
 * --instance path (or AUTOSKETCH_INSTANCE). Results go to test/eval/results/<date>-<sha>.json/.md.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVER_VERSION } from "../../src/server/server.js";
import { ABLATIONS, ablationByName } from "./ablations.js";
import { formatPlan, PRICES, type Plan } from "./cost.js";
import { PROMPTS, promptById, type EvalPrompt } from "./prompts.js";
import { compareSummaries, findBaseline, readResult, resultName, summarize, writeResult, type SuiteResult } from "./results.js";
import { RUBRIC_VERSION } from "./rubric.js";
import { DEFAULT_MODEL, type SuitePlan } from "./runner.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface CliOptions {
  plan: SuitePlan;
  model: string;
  judgeModel?: string;
  maxTurns: number;
  dryRun: boolean;
  keep: boolean;
  out: string;
  baseline?: string;
}

/** Parses arguments into a plan. Throws with a usage message on bad input. */
export function parseArgs(argv: readonly string[]): CliOptions {
  const val = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    return v === undefined || v.startsWith("--") ? "" : v;
  };
  const has = (name: string) => argv.includes(`--${name}`);
  const list = (v: string | undefined) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
  const prompts = (ids: string[]): EvalPrompt[] =>
    ids.map((id) => {
      const p = promptById(id);
      if (!p) throw new Error(`unknown prompt "${id}" (have: ${PROMPTS.map((q) => q.id).join(", ")})`);
      return p;
    });

  const suite = val("suite") || "reduced";
  if (suite !== "reduced" && suite !== "full") throw new Error(`--suite is reduced or full (got "${suite}")`);
  const explicit = list(val("prompts"));
  const main = explicit.length ? prompts(explicit).filter((p) => p.size !== "large") : PROMPTS.filter((p) => p.size !== "large" && (suite === "full" || p.reduced));
  const scopedArg = val("scoped");
  const scoped = has("scoped") ? (scopedArg ? prompts(list(scopedArg)) : PROMPTS.filter((p) => p.size === "large")) : explicit.length ? prompts(explicit).filter((p) => p.size === "large") : [];
  if (scoped.some((p) => p.size !== "large")) throw new Error("--scoped takes large prompts only");
  const abArg = val("ablations");
  const ablations = abArg === "all" ? ABLATIONS.map((a) => a.name) : list(abArg).length ? list(abArg) : ["full"];
  for (const a of ablations) if (!ablationByName(a)) throw new Error(`unknown ablation "${a}" (have: ${ABLATIONS.map((x) => x.name).join(", ")})`);
  const model = val("model") || DEFAULT_MODEL;
  const maxTurns = Number(val("max-turns") || 80);
  if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new Error("--max-turns takes a positive integer");
  return {
    plan: { main, ablations, scoped },
    model,
    ...(has("no-judge") ? {} : { judgeModel: val("judge-model") || model }),
    maxTurns,
    dryRun: has("dry-run"),
    keep: has("keep"),
    out: val("out") || join(HERE, "results"),
    ...(val("baseline") ? { baseline: val("baseline")! } : {}),
  };
}

export function planOf(o: CliOptions): Plan {
  const agentRuns = o.plan.main.length * o.plan.ablations.length;
  const scopedRuns = o.plan.scoped.length * 2;
  return {
    model: o.model,
    ...(o.judgeModel ? { judgeModel: o.judgeModel } : {}),
    prompts: o.plan.main.map((p) => p.id),
    ablations: o.plan.ablations,
    agentRuns,
    scopedRuns,
    judgeCalls: o.judgeModel ? agentRuns + scopedRuns : 0,
    maxTurns: o.maxTurns,
  };
}

/** Why the eval must not run here, or undefined when it may. */
export function refusal(env: Readonly<Record<string, string | undefined>>): string | undefined {
  if (env.CI) return "the eval tier never runs in CI (CI is set)";
  if (!env.ANTHROPIC_API_KEY) return "ANTHROPIC_API_KEY is not set; the eval tier calls the Anthropic API and costs tokens";
  return undefined;
}

function gitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "nogit";
  }
}

async function main(argv: string[]): Promise<number> {
  const log = (m: string) => process.stderr.write(`[eval] ${m}\n`);
  let o: CliOptions;
  try {
    o = parseArgs(argv);
  } catch (e) {
    log((e as Error).message);
    return 2;
  }
  const plan = planOf(o);
  process.stdout.write(`Autosketch agent eval plan\n${formatPlan(plan)}\n`);
  if (!PRICES[o.model]) log(`no price for ${o.model}: tokens are reported, dollars are not`);
  if (o.dryRun) return 0;
  const why = refusal(process.env);
  if (why) {
    log(`refusing to run: ${why}. Use --dry-run to see the plan without running.`);
    return 1;
  }

  // Only now load anything that talks to the instance or the SDK.
  const { loadInstance, judgeRenderer, StdioHost } = await import("./host.js");
  const inst = await loadInstance(argv, log);
  if (!inst) {
    log('no instance: pass --instance "<path>" or set AUTOSKETCH_INSTANCE (the server needs one)');
    return 2;
  }
  const { SdkDriver, SdkJudge } = await import("./drivers/sdk.js");
  const { runSuite } = await import("./runner.js");
  const host = new StdioHost(inst.instance);
  const serverTools = await host.listTools();
  log(`server offers ${serverTools.length} tools`);

  const date = new Date().toISOString().slice(0, 10);
  let name = resultName(date, gitSha());
  for (let i = 2; existsSync(join(o.out, `${name}.json`)); i++) name = `${resultName(date, gitSha())}-${i}`;
  const runs = await runSuite(o.plan, {
    driver: new SdkDriver(),
    host,
    model: o.model,
    maxTurns: o.maxTurns,
    ...(o.judgeModel ? { judge: new SdkJudge(o.judgeModel), render: judgeRenderer(inst.ctx) } : {}),
    registry: inst.ctx.registry,
    transcriptDir: join(o.out, name),
    keepWorkspaces: o.keep,
    log,
  });
  const result: SuiteResult = {
    meta: {
      date,
      gitSha: gitSha(),
      model: o.model,
      ...(o.judgeModel ? { judgeModel: o.judgeModel } : {}),
      rubricVersion: RUBRIC_VERSION,
      serverVersion: SERVER_VERSION,
      driver: "agent-sdk",
      ...(PRICES[o.model] ? { price: PRICES[o.model] } : {}),
      prompts: o.plan.main.map((p) => p.id),
      ablations: o.plan.ablations,
      scoped: o.plan.scoped.map((p) => p.id),
      serverTools,
    },
    runs,
    summary: summarize(runs),
  };
  const baselinePath = o.baseline ?? (await findBaseline(o.out));
  const comparison = baselinePath ? { baseline: baselinePath, ...compareSummaries(result.summary, (await readResult(baselinePath)).summary) } : undefined;
  const paths = await writeResult(o.out, name, result, comparison);
  process.stdout.write(`\nwrote ${paths.json}\nwrote ${paths.md}\n`);
  if (comparison?.regressions.length) log(`regressions against ${comparison.baseline}: ${comparison.regressions.map((g) => `${g.ablation} ${g.metric}`).join(", ")}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: Error) => {
      process.stderr.write(`[eval] fatal: ${e.stack ?? e.message}\n`);
      process.exit(1);
    },
  );
}
