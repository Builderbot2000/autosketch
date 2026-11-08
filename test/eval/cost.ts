import type { TokenTotals } from "./transcript.js";

/**
 * Token prices for cost scoring (docs/design/10-testing.md, tier 3, *Scoring: cost*), USD per
 * million tokens. Cache writes are priced at 1.25× input (5-minute TTL). A model missing here
 * gets no dollar figure; tokens are always reported. Update when prices change: the results file
 * records the price used, so old results stay comparable.
 */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const price = (input: number, output: number, cacheRead: number): Price => ({ input, output, cacheRead, cacheWrite: input * 1.25 });

export const PRICES: Record<string, Price> = {
  "claude-sonnet-5-5": price(2, 10, 0.2),
  "claude-opus-5-5": price(4, 20, 0.2),
};

export function costUsd(model: string, t: TokenTotals): number | undefined {
  const p = PRICES[model];
  if (!p) return undefined;
  return (t.input * p.input + t.output * p.output + t.cacheRead * p.cacheRead + t.cacheWrite * p.cacheWrite) / 1e6;
}

/** What one suite invocation will run: the cost drivers `npm run eval` prints before spending. */
export interface Plan {
  model: string;
  judgeModel?: string;
  prompts: string[];
  ablations: string[];
  /** Agent runs: main-suite prompts × ablations, plus large prompts × 2 modes when scoped. */
  agentRuns: number;
  scopedRuns: number;
  judgeCalls: number;
  maxTurns: number;
}

export function formatPlan(p: Plan): string {
  const lines = [
    `model ${p.model}, up to ${p.maxTurns} turns per run`,
    `main suite: ${p.prompts.length} prompts × ${p.ablations.length} ablations (${p.ablations.join(", ")}) = ${p.agentRuns} agent runs`,
    `scoped comparison: ${p.scopedRuns} agent runs (large prompts × monolithic/delegated; delegated runs are skipped when the server has no scope tools)`,
    p.judgeModel ? `judge: ${p.judgeModel}, ${p.judgeCalls} calls (one per finished run, 2 renders each)` : "judge: off",
  ];
  const pr = PRICES[p.model];
  if (pr) {
    // A rough envelope, not a promise: a medium build is often 30–60 calls and 0.3–1.5M context tokens, mostly cache reads.
    const lo = (0.3e6 * pr.cacheRead + 0.03e6 * pr.input + 0.02e6 * pr.output) / 1e6;
    const hi = (1.5e6 * pr.cacheRead + 0.15e6 * pr.input + 0.08e6 * pr.output) / 1e6;
    const runs = p.agentRuns + p.scopedRuns;
    lines.push(`rough cost: $${lo.toFixed(2)}–$${hi.toFixed(2)} per run → about $${(lo * runs).toFixed(0)}–$${(hi * runs).toFixed(0)} for ${runs} runs (large prompts cost several times more)`);
  }
  return lines.join("\n");
}
