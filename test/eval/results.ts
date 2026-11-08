import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Price } from "./cost.js";
import type { RunRecord } from "./runner.js";

/**
 * Results of the agent evaluation tier (docs/design/10-testing.md, tier 3, *Results*): one JSON
 * file per suite run, `test/eval/results/<date>-<git-sha>.json`, a markdown summary table next to
 * it, and a comparison against the last baseline. The baseline is `results/baseline.json` when it
 * exists (copy a results file there to pin one), otherwise the newest earlier results file.
 */

export interface SuiteMeta {
  date: string;
  gitSha: string;
  model: string;
  judgeModel?: string;
  rubricVersion: string;
  serverVersion: string;
  driver: string;
  price?: Price;
  prompts: string[];
  ablations: string[];
  scoped: string[];
  /** Tools the server offered (nothing hidden). */
  serverTools: string[];
}

export interface Aggregate {
  runs: number;
  errors: number;
  /** Share of runs that passed every check. */
  passRate: number;
  /** Share of all checks passed. */
  checkRate: number;
  rubricMean?: number;
  meanTokens: number;
  meanImageTokens: number;
  meanToolCalls: number;
  meanWallMs: number;
  meanForks: number;
  costUsd?: number;
}

export interface Summary {
  byAblation: Record<string, Aggregate>;
  /** Scoped comparison per large prompt (11): monolithic vs delegated. */
  scoped: Record<string, { monolithic?: Aggregate; delegated?: Aggregate; consistency: { monolithic?: number; delegated?: number }; skipped?: string }>;
  /** Forks per run in the main suite's `full` runs, by prompt size: should be near zero (11). */
  forkRate: Partial<Record<"small" | "medium", { runs: number; forks: number; runsWithFork: number }>>;
}

export interface SuiteResult {
  meta: SuiteMeta;
  runs: RunRecord[];
  summary: Summary;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function aggregate(runs: readonly RunRecord[]): Aggregate {
  const done = runs.filter((r) => r.status !== "skipped");
  const rubric = done.flatMap((r) => (r.rubric ? [r.rubric.mean] : []));
  const costs = done.flatMap((r) => (r.costUsd !== undefined ? [r.costUsd] : []));
  const checks = done.reduce((n, r) => n + r.checks.length, 0);
  return {
    runs: done.length,
    errors: done.filter((r) => r.status === "error").length,
    passRate: done.length ? done.filter((r) => r.pass).length / done.length : 0,
    checkRate: checks ? done.reduce((n, r) => n + r.checksPassed, 0) / checks : 0,
    ...(rubric.length ? { rubricMean: mean(rubric) } : {}),
    meanTokens: mean(done.map((r) => r.totalTokens)),
    meanImageTokens: mean(done.map((r) => r.imageTokens)),
    meanToolCalls: mean(done.map((r) => r.toolCalls)),
    meanWallMs: mean(done.map((r) => r.wallMs)),
    meanForks: mean(done.map((r) => r.session.forks)),
    ...(costs.length ? { costUsd: costs.reduce((a, b) => a + b, 0) } : {}),
  };
}

export function summarize(runs: readonly RunRecord[]): Summary {
  const byAblation: Summary["byAblation"] = {};
  const main = runs.filter((r) => r.mode === "main");
  for (const name of [...new Set(main.map((r) => r.ablation))]) byAblation[name] = aggregate(main.filter((r) => r.ablation === name));

  const scoped: Summary["scoped"] = {};
  for (const id of [...new Set(runs.filter((r) => r.mode !== "main").map((r) => r.prompt))]) {
    const of = (mode: "monolithic" | "delegated") => runs.filter((r) => r.prompt === id && r.mode === mode);
    const consistency = (rs: RunRecord[]) => rs.flatMap((r) => r.checks.filter((c) => c.kind === "consistency" && c.value !== undefined).map((c) => c.value!))[0];
    const mono = of("monolithic"), del = of("delegated");
    const skipped = del.find((r) => r.status === "skipped")?.skipped;
    const cm = consistency(mono), cd = consistency(del);
    scoped[id] = {
      ...(mono.some((r) => r.status !== "skipped") ? { monolithic: aggregate(mono) } : {}),
      ...(del.some((r) => r.status !== "skipped") ? { delegated: aggregate(del) } : {}),
      consistency: { ...(cm !== undefined ? { monolithic: cm } : {}), ...(cd !== undefined ? { delegated: cd } : {}) },
      ...(skipped ? { skipped } : {}),
    };
  }

  const forkRate: Summary["forkRate"] = {};
  for (const size of ["small", "medium"] as const) {
    const rs = main.filter((r) => r.ablation === "full" && r.size === size && r.status !== "skipped");
    if (rs.length) forkRate[size] = { runs: rs.length, forks: rs.reduce((n, r) => n + r.session.forks, 0), runsWithFork: rs.filter((r) => r.session.forks > 0).length };
  }
  return { byAblation, scoped, forkRate };
}

const f1 = (n: number | undefined, d = 1) => (n === undefined ? "–" : n.toFixed(d));
const pct = (n: number) => `${Math.round(n * 100)}%`;
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

/** The summary table (markdown). */
export function formatSummary(r: SuiteResult): string {
  const m = r.meta;
  const out = [
    `# Eval ${m.date} ${m.gitSha}`,
    "",
    `model ${m.model} · judge ${m.judgeModel ?? "off"} (rubric ${m.rubricVersion}) · driver ${m.driver} · server ${m.serverVersion}`,
    "",
    "| ablation | runs | errors | all checks | checks | rubric | tokens | image tok | calls | wall s | forks | $ |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const [name, a] of Object.entries(r.summary.byAblation))
    out.push(`| ${name} | ${a.runs} | ${a.errors} | ${pct(a.passRate)} | ${pct(a.checkRate)} | ${f1(a.rubricMean, 2)} | ${k(a.meanTokens)} | ${k(a.meanImageTokens)} | ${f1(a.meanToolCalls)} | ${f1(a.meanWallMs / 1000)} | ${f1(a.meanForks, 2)} | ${f1(a.costUsd, 2)} |`);
  const scoped = Object.entries(r.summary.scoped);
  if (scoped.length) {
    out.push("", "## Scoped sessions (monolithic vs delegated)", "", "| prompt | mode | checks | consistency | rubric | tokens | wall s | forks |", "|---|---|---|---|---|---|---|---|");
    for (const [id, s] of scoped) {
      for (const mode of ["monolithic", "delegated"] as const) {
        const a = s[mode];
        if (!a) {
          out.push(`| ${id} | ${mode} | skipped${mode === "delegated" && s.skipped ? `: ${s.skipped}` : ""} | | | | | |`);
          continue;
        }
        out.push(`| ${id} | ${mode} | ${pct(a.checkRate)} | ${f1(s.consistency[mode], 2)} | ${f1(a.rubricMean, 2)} | ${k(a.meanTokens)} | ${f1(a.meanWallMs / 1000)} | ${f1(a.meanForks, 1)} |`);
      }
    }
  }
  const fr = Object.entries(r.summary.forkRate);
  if (fr.length) {
    out.push("", "## Fork rate on small and medium prompts (should be near zero)", "");
    for (const [size, v] of fr) out.push(`- ${size}: ${v.forks} forks in ${v.runs} runs (${v.runsWithFork} runs forked)`);
  }
  return out.join("\n") + "\n";
}

export interface Regression {
  ablation: string;
  metric: string;
  baseline: number;
  current: number;
}

/**
 * Compares two summaries ablation by ablation. A regression is a drop of more than 5 points in
 * the all-checks or checks rate, a rubric drop of more than 0.25, or 20% more tokens.
 */
export function compareSummaries(current: Summary, baseline: Summary): { lines: string[]; regressions: Regression[] } {
  const lines: string[] = [];
  const regressions: Regression[] = [];
  for (const [name, a] of Object.entries(current.byAblation)) {
    const b = baseline.byAblation[name];
    if (!b) {
      lines.push(`${name}: no baseline`);
      continue;
    }
    const d = (label: string, cur: number | undefined, base: number | undefined, worse: (c: number, b: number) => boolean, fmt: (n: number) => string) => {
      if (cur === undefined || base === undefined) return `${label} –`;
      if (worse(cur, base)) regressions.push({ ablation: name, metric: label, baseline: base, current: cur });
      return `${label} ${fmt(base)}→${fmt(cur)}`;
    };
    lines.push(
      `${name}: ` +
        [
          d("all checks", a.passRate, b.passRate, (c, x) => c < x - 0.05, pct),
          d("checks", a.checkRate, b.checkRate, (c, x) => c < x - 0.05, pct),
          d("rubric", a.rubricMean, b.rubricMean, (c, x) => c < x - 0.25, (n) => n.toFixed(2)),
          d("tokens", a.meanTokens, b.meanTokens, (c, x) => x > 0 && c > x * 1.2, k),
          d("calls", a.meanToolCalls, b.meanToolCalls, () => false, (n) => n.toFixed(1)),
        ].join(", "),
    );
  }
  return { lines, regressions };
}

export function resultName(date: string, sha: string): string {
  return `${date}-${sha}`;
}

/** The baseline for a new results file: `baseline.json`, else the newest other results file. */
export async function findBaseline(dir: string, exclude?: string): Promise<string | undefined> {
  const pinned = join(dir, "baseline.json");
  if (existsSync(pinned)) return pinned;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return undefined;
  }
  const files = names.filter((n) => /^\d{4}-\d{2}-\d{2}.*\.json$/.test(n) && join(dir, n) !== exclude).sort();
  const last = files.at(-1);
  return last ? join(dir, last) : undefined;
}

export async function readResult(path: string): Promise<SuiteResult> {
  return JSON.parse(await readFile(path, "utf8")) as SuiteResult;
}

/** Writes `<name>.json` and `<name>.md` (summary plus the baseline comparison). Returns both paths. */
export async function writeResult(dir: string, name: string, r: SuiteResult, comparison?: { baseline: string; lines: string[]; regressions: Regression[] }): Promise<{ json: string; md: string }> {
  await mkdir(dir, { recursive: true });
  const json = join(dir, `${name}.json`);
  const md = join(dir, `${name}.md`);
  await writeFile(json, JSON.stringify(r, null, 1));
  let text = formatSummary(r);
  if (comparison) {
    text += `\n## Against baseline ${comparison.baseline}\n\n${comparison.lines.map((l) => `- ${l}`).join("\n")}\n`;
    text += comparison.regressions.length ? `\n**Regressions:** ${comparison.regressions.map((g) => `${g.ablation} ${g.metric}`).join(", ")}\n` : "\nNo regressions.\n";
  }
  await writeFile(md, text);
  return { json, md };
}
