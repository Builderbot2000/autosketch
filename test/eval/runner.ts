import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Registry } from "../../src/assets/registry.js";
import type { PublicBox } from "../../src/core/region.js";
import type { Document } from "../../src/document/document.js";
import { loadNative, saveNative } from "../../src/document/native.js";
import { ablationByName, SCOPE_REQUIRED, SCOPE_TOOLS, type Ablation } from "./ablations.js";
import { publicBounds, runChecks, type CheckResult } from "./checks.js";
import { costUsd } from "./cost.js";
import { imageTokens, jobTable, joinCalls, readEvents, type JobRow, type SessionStats } from "./join.js";
import type { EvalPrompt, PromptSize } from "./prompts.js";
import { parseJudgeReply, type Judge, type RubricScore } from "./rubric.js";
import { SEEDS } from "./seeds.js";
import { normalizeTranscript, totalTokens, type SdkMessage, type TokenTotals } from "./transcript.js";

/**
 * The agent evaluation runner (docs/design/10-testing.md, tier 3, *Runner*). For each prompt and
 * variant it prepares a fresh workspace (with the seed document, if any), lets a model driver work
 * against the Autosketch MCP server with some tools hidden, then scores the saved document with
 * automatic checks and, optionally, the model-graded rubric, and joins the server's event log
 * with the transcript for token and fork accounting (12, *Metrics and evals*).
 *
 * The driver is pluggable: `drivers/sdk.ts` runs a Claude model through the Agent SDK;
 * `drivers/scripted.ts` replays scripted tool calls so the harness is tested without a model.
 */

export const DEFAULT_MODEL = "claude-sonnet-5-5";
export const SERVER_NAME = "autosketch";

export interface StdioServerSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface DriverTask {
  runId: string;
  prompt: string;
  systemPrompt: string;
  model: string;
  maxTurns: number;
  workspace: string;
  hiddenTools: string[];
  /** Delegation to a sandboxed subagent is allowed (scoped comparison, delegated mode). */
  delegation: boolean;
  server: StdioServerSpec;
}

export interface ModelDriver {
  readonly name: string;
  run(task: DriverTask): AsyncIterable<SdkMessage>;
}

/** Where the MCP server comes from. */
export interface ServerHost {
  /** Every tool the server offers (nothing hidden). */
  listTools(): Promise<string[]>;
  spec(workspace: string, hiddenTools: string[]): StdioServerSpec;
  /** Resolves once the server has saved the document and flushed its log after a run. */
  settle(workspace: string): Promise<void>;
}

export interface RunnerOptions {
  driver: ModelDriver;
  host: ServerHost;
  model?: string;
  maxTurns?: number;
  judge?: Judge;
  /** Renders a finished build for the judge (iso + front). Without it, the rubric is skipped. */
  render?: (doc: Document) => Promise<Buffer[]>;
  registry?: Registry;
  /** Where per-run transcripts go (one JSON file per run). */
  transcriptDir?: string;
  /** Parent for run workspaces (default: the OS temp folder). */
  workDir?: string;
  keepWorkspaces?: boolean;
  log?: (msg: string) => void;
}

export type RunMode = "main" | "monolithic" | "delegated";

export interface RunRecord {
  id: string;
  prompt: string;
  size: PromptSize;
  ablation: string;
  mode: RunMode;
  hidden: string[];
  status: "ok" | "error" | "skipped";
  error?: string;
  skipped?: string;
  wallMs: number;
  turns: number;
  toolCalls: number;
  failedCalls: number;
  tokens: TokenTotals;
  totalTokens: number;
  imageTokens: number;
  images: number;
  costUsd?: number;
  reportedCostUsd?: number;
  checks: CheckResult[];
  checksPassed: number;
  pass: boolean;
  rubric?: RubricScore;
  rubricError?: string;
  judgeTokens?: TokenTotals;
  blocks: number;
  bounds?: PublicBox;
  /** Per Autosketch tool: calls, result tokens (joined), response characters, images. */
  tools: Record<string, { n: number; tokens: number; chars: number; images: number }>;
  session: SessionStats;
  jobs: JobRow[];
  join: { unmatchedTranscript: number; unmatchedLog: number; dropped: number };
  transcript?: string;
}

const SYSTEM = `You are an agent building Minecraft structures with the Autosketch MCP tools. Work only through those tools; you have no file system or shell. Complete the request fully and check your work, then reply with one sentence saying what you built.`;

const DELEGATION = `

Scoped sessions are available for builds too large to comprehend at once: scope_fork a sandbox for one distinct part, hand its handoff text to the "builder" subagent, and scope_merge its result. This is optional and costs a brief, a handoff and a merge per job; below that size, just work directly.`;

export function systemPrompt(delegation: boolean): string {
  return delegation ? SYSTEM + DELEGATION : SYSTEM;
}

const emptySession = (): SessionStats => ({ forks: 0, merges: 0, abandons: 0, maxDepth: 0, refusals: {}, maxParallel: 0, repeatedBriefs: 0 });
const zeroTokens = (): TokenTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function skippedRecord(p: EvalPrompt, ablation: string, mode: RunMode, reason: string): RunRecord {
  return {
    id: `${p.id}.${ablation}.${mode}`,
    prompt: p.id,
    size: p.size,
    ablation,
    mode,
    hidden: [],
    status: "skipped",
    skipped: reason,
    wallMs: 0,
    turns: 0,
    toolCalls: 0,
    failedCalls: 0,
    tokens: zeroTokens(),
    totalTokens: 0,
    imageTokens: 0,
    images: 0,
    checks: [],
    checksPassed: 0,
    pass: false,
    blocks: 0,
    tools: {},
    session: emptySession(),
    jobs: [],
    join: { unmatchedTranscript: 0, unmatchedLog: 0, dropped: 0 },
  };
}

/** Runs one prompt in one variant and scores it. Never throws: failures become `status: "error"`. */
export async function runCase(p: EvalPrompt, ablation: Ablation, mode: RunMode, opts: RunnerOptions, serverTools: readonly string[]): Promise<RunRecord> {
  const model = opts.model ?? DEFAULT_MODEL;
  const delegation = mode === "delegated";
  if (delegation && !SCOPE_REQUIRED.every((t) => serverTools.includes(t))) return skippedRecord(p, ablation.name, mode, `server has no ${SCOPE_REQUIRED.join("/")} tools`);
  // Monolithic runs hide the scope tools the server actually has (naming absent ones would only add noise).
  const hidden = [...new Set([...ablation.hide, ...(mode === "monolithic" ? SCOPE_TOOLS.filter((t) => serverTools.includes(t)) : [])])].sort();
  const rec = skippedRecord(p, ablation.name, mode, "");
  delete rec.skipped;
  rec.status = "ok";
  rec.hidden = hidden;

  const workspace = await mkdtemp(join(opts.workDir ?? tmpdir(), `autosketch-eval-${p.id}-`));
  const docPath = join(workspace, p.doc, "doc.autosketch");
  let seed: Document | undefined;
  const messages: SdkMessage[] = [];
  try {
    if (p.seed) {
      seed = SEEDS[p.seed](p.doc);
      await saveNative(seed, docPath);
    }
    const task: DriverTask = {
      runId: rec.id,
      prompt: p.text,
      systemPrompt: systemPrompt(delegation),
      model,
      maxTurns: opts.maxTurns ?? 80,
      workspace,
      hiddenTools: hidden,
      delegation,
      server: opts.host.spec(workspace, hidden),
    };
    const t0 = performance.now();
    try {
      for await (const m of opts.driver.run(task)) messages.push(m);
    } catch (e) {
      rec.status = "error";
      rec.error = `driver: ${(e as Error).message}`;
    }
    rec.wallMs = Math.round(performance.now() - t0);
    await opts.host.settle(workspace);

    // Transcript, event log and the join.
    const t = normalizeTranscript(messages, SERVER_NAME);
    if (t.isError && rec.status === "ok") {
      rec.status = "error";
      rec.error = `run ended with ${t.stopReason ?? "an error"}`;
    }
    const { events, dropped } = await readEvents(workspace);
    const joined = joinCalls(t, events);
    const { jobs, session } = jobTable(events, joined);
    rec.turns = t.turns.length;
    rec.toolCalls = t.calls.length;
    rec.failedCalls = t.calls.filter((c) => c.ok === false).length;
    rec.tokens = t.usage;
    rec.totalTokens = totalTokens(t.usage);
    const cost = costUsd(model, t.usage);
    if (cost !== undefined) rec.costUsd = cost;
    if (t.reportedCostUsd !== undefined) rec.reportedCostUsd = t.reportedCostUsd;
    for (const c of joined.calls) {
      const l = c.logged;
      const row = (rec.tools[c.tool] ??= { n: 0, tokens: 0, chars: 0, images: 0 });
      row.n++;
      row.tokens += c.tokens ?? 0;
      if (l) {
        row.chars += l.chars;
        row.images += l.images;
        rec.images += l.images;
        rec.imageTokens += imageTokens(l.pixels);
      }
    }
    rec.session = session;
    rec.jobs = jobs;
    rec.join = { unmatchedTranscript: joined.unmatchedTranscript, unmatchedLog: joined.unmatchedLog, dropped };

    // Scoring the saved document.
    let doc: Document | undefined;
    if (existsSync(docPath)) {
      try {
        doc = await loadNative(docPath);
      } catch (e) {
        rec.error = `could not load ${p.doc}: ${(e as Error).message}`;
      }
    }
    if (doc) {
      rec.blocks = doc.blockCount();
      const b = publicBounds(doc);
      if (b) rec.bounds = b;
      rec.checks = runChecks(doc, p.checks, { ...(seed ? { seed } : {}), ...(opts.registry ? { registry: opts.registry } : {}) });
    } else rec.checks = p.checks.map((c) => ({ kind: c.kind, pass: false, detail: `document "${p.doc}" was not saved` }));
    rec.checksPassed = rec.checks.filter((c) => c.pass).length;
    rec.pass = rec.checks.length > 0 && rec.checksPassed === rec.checks.length;

    if (opts.judge && opts.render && doc && rec.blocks > 0) {
      try {
        const images = await opts.render(doc);
        const r = await opts.judge.grade({ task: p.text, style: p.style, images });
        if (r.usage) rec.judgeTokens = r.usage;
        const score = parseJudgeReply(r.text);
        if (score) rec.rubric = score;
        else rec.rubricError = `unparseable judge reply: ${r.text.slice(0, 200)}`;
      } catch (e) {
        rec.rubricError = (e as Error).message;
      }
    }

    if (opts.transcriptDir) {
      await mkdir(opts.transcriptDir, { recursive: true });
      const path = join(opts.transcriptDir, `${rec.id}.json`);
      await writeFile(path, JSON.stringify({ id: rec.id, hidden, messages, calls: joined.calls, events }, null, 1));
      rec.transcript = path;
    }
  } catch (e) {
    rec.status = "error";
    rec.error = (e as Error).message;
  } finally {
    if (!opts.keepWorkspaces) await rm(workspace, { recursive: true, force: true });
  }
  opts.log?.(`${rec.id}: ${rec.status}${rec.error ? ` (${rec.error})` : ""}, checks ${rec.checksPassed}/${rec.checks.length}, ${rec.toolCalls} calls, ${rec.totalTokens} tokens`);
  return rec;
}

export interface SuitePlan {
  /** Main-suite prompts (small and medium), run once per ablation. */
  main: EvalPrompt[];
  ablations: string[];
  /** Large prompts for the scoped comparison, run monolithic and delegated with every tool. */
  scoped: EvalPrompt[];
}

/** Runs the whole plan in sequence. */
export async function runSuite(plan: SuitePlan, opts: RunnerOptions): Promise<RunRecord[]> {
  const tools = await opts.host.listTools();
  const full = ablationByName("full")!;
  const runs: RunRecord[] = [];
  for (const name of plan.ablations) {
    const ab = ablationByName(name);
    if (!ab) throw new Error(`unknown ablation "${name}"`);
    for (const p of plan.main) runs.push(await runCase(p, ab, "main", opts, tools));
  }
  for (const p of plan.scoped) for (const mode of ["monolithic", "delegated"] as const) runs.push(await runCase(p, full, mode, opts, tools));
  return runs;
}
