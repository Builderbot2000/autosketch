import { createHash } from "node:crypto";

/**
 * The model-graded rubric (docs/design/10-testing.md, tier 3, *Scoring*): a judge model scores
 * final renders of each build. The prompts are fixed text, versioned by hash in the results file,
 * so scores are only compared across runs judged with the same rubric.
 */

export const RUBRIC_CRITERIA = ["prompt_match", "style", "proportion", "craft"] as const;
export type Criterion = (typeof RUBRIC_CRITERIA)[number];

export const JUDGE_SYSTEM = `You grade Minecraft builds from renders. You are strict and consistent. You never reward effort or intent, only what the images show. Reply with a single JSON object and nothing else.`;

export function judgePrompt(task: string, style: string): string {
  return `The images are renders of one Minecraft build (an isometric view from the south-east, and the front elevation from the south). The builder was asked:

"""${task}"""

Intended style: ${style}.

Score each criterion from 1 (poor) to 5 (excellent):
- prompt_match: everything the request asks for is present and placed as asked (sizes, sides, parts, counts).
- style: the materials and forms read as the intended style.
- proportion: heights, widths, roof pitch and openings are in believable proportion to each other.
- craft: clean execution: no stray or floating blocks, holes, z-fighting materials, or unfinished parts.

Reply exactly in this form: {"prompt_match": n, "style": n, "proportion": n, "craft": n, "notes": "one sentence"}`;
}

/** Identifies the rubric text; it changes whenever the judge prompts change. */
export const RUBRIC_VERSION = createHash("sha256").update(JUDGE_SYSTEM).update(judgePrompt("{task}", "{style}")).digest("hex").slice(0, 12);

export interface RubricScore {
  scores: Record<Criterion, number>;
  /** Mean of the criteria, 1–5. */
  mean: number;
  notes: string;
}

/** Parses the judge's reply; undefined when it isn't a complete, in-range score object. */
export function parseJudgeReply(text: string): RubricScore | undefined {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return undefined;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(m[0]);
  } catch {
    return undefined;
  }
  const scores = {} as Record<Criterion, number>;
  for (const c of RUBRIC_CRITERIA) {
    const v = o[c];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 5) return undefined;
    scores[c] = v;
  }
  const mean = RUBRIC_CRITERIA.reduce((s, c) => s + scores[c], 0) / RUBRIC_CRITERIA.length;
  return { scores, mean, notes: typeof o.notes === "string" ? o.notes : "" };
}

/** Grades renders of a build. Implemented by the SDK driver; tests use a fake. */
export interface Judge {
  readonly model: string;
  grade(input: { task: string; style: string; images: Buffer[] }): Promise<{ text: string; usage?: import("./transcript.js").TokenTotals }>;
}
