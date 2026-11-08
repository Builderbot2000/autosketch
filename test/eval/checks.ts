import type { Registry } from "../../src/assets/registry.js";
import { stateId } from "../../src/core/blockstate.js";
import { formatBox, fromPublic, isEmptyBox, toPublic, type Box, type PublicBox } from "../../src/core/region.js";
import type { Document } from "../../src/document/document.js";
import { analyzeStructure, type Analysis, type RoofType, type Side } from "../../src/perception/analyze.js";

/**
 * Automatic checks for the agent evaluation tier (docs/design/10-testing.md, tier 3, *Scoring*),
 * written with the `analyze` API (06). Each prompt lists the checks that apply to it; each check
 * returns pass/fail with a one-line detail, so a results file says why a run failed.
 *
 * Boxes in specs are public inclusive boxes in document-local coordinates (01).
 */

export type CheckSpec =
  /** At least n non-air blocks. */
  | { kind: "minBlocks"; n: number }
  /** Every block lies inside the box. */
  | { kind: "withinBox"; box: PublicBox }
  /** Storey count from analyze, in [min, max]. */
  | { kind: "storeys"; min: number; max?: number }
  /** A door on this side of the footprint. */
  | { kind: "door"; side: Side }
  /** At least n windows (glazed openings). */
  | { kind: "windows"; min: number }
  /** A roof was detected and it has no gaps (analyze's roof_gap issues). */
  | { kind: "roofWatertight" }
  | { kind: "roofType"; types: RoofType[] }
  /** No block groups floating free of the ground layer. */
  | { kind: "noFloating" }
  /**
   * Palette roles respected: at least `minShare` of the blocks in `where` have an id containing
   * one of `ids` (substring match, so "oak" matches oak_planks and oak_stairs). `walls` uses
   * analyze's wall material (footprint sides, floors excluded), `roof` the roof box, `all` everything.
   */
  | { kind: "material"; where: "walls" | "roof" | "all"; ids: string[]; minShare: number }
  /** Seed blocks inside the box are still there (for "extend the existing …" prompts). */
  | { kind: "preserved"; box: PublicBox; minShare: number }
  /**
   * Cross-part consistency (10, *Scoped sessions*): the parts are meant to match (towers, wings,
   * townhouses). Mean pairwise Jaccard similarity of their block-id sets, and the spread of their
   * top heights relative to each part's own base.
   */
  | { kind: "consistency"; parts: PublicBox[]; minJaccard: number; maxHeightSpread: number };

export interface CheckResult {
  kind: CheckSpec["kind"];
  pass: boolean;
  detail: string;
  /** The measured value, where one number says it (share, count, Jaccard). */
  value?: number;
}

export interface CheckContext {
  /** The seed document the run started from (for `preserved`). */
  seed?: Document;
  registry?: Registry;
}

/** Non-air blocks in a local half-open box (default: the whole document), keyed "x,y,z". */
export function blocksIn(doc: Document, box?: Box): Map<string, string> {
  const out = new Map<string, string>();
  const b = box ?? doc.localBounds();
  if (!b || isEmptyBox(b)) return out;
  doc.voxels.forEachInBox(doc.boxToStore(b), (sx, sy, sz, id) => {
    const [x, y, z] = doc.toLocal(sx, sy, sz);
    out.set(`${x},${y},${z}`, doc.states.get(id));
  });
  return out;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const matches = (state: string, ids: string[]) => {
  const id = stateId(state);
  return ids.some((s) => id.includes(s));
};

export function runChecks(doc: Document, specs: readonly CheckSpec[], ctx: CheckContext = {}): CheckResult[] {
  let analysis: Analysis | undefined;
  let analyzeError: string | undefined;
  const needsAnalysis = specs.some((s) => ["storeys", "door", "windows", "roofWatertight", "roofType", "noFloating", "material"].includes(s.kind));
  if (needsAnalysis) {
    try {
      analysis = analyzeStructure(doc, ctx.registry ? { registry: ctx.registry } : {});
    } catch (e) {
      analyzeError = (e as Error).message;
    }
  }
  return specs.map((s) => {
    try {
      return runCheck(doc, s, analysis, analyzeError, ctx);
    } catch (e) {
      return { kind: s.kind, pass: false, detail: `check failed: ${(e as Error).message}` };
    }
  });
}

function runCheck(doc: Document, s: CheckSpec, a: Analysis | undefined, analyzeError: string | undefined, ctx: CheckContext): CheckResult {
  const fail = (detail: string): CheckResult => ({ kind: s.kind, pass: false, detail });
  switch (s.kind) {
    case "minBlocks": {
      const n = doc.blockCount();
      return { kind: s.kind, pass: n >= s.n, detail: `${n} blocks (need ≥ ${s.n})`, value: n };
    }
    case "withinBox": {
      const b = doc.localBounds();
      if (!b) return fail("empty document");
      const limit = fromPublic(s.box);
      const inside = b.min.every((v, i) => v >= limit.min[i]!) && b.max.every((v, i) => v <= limit.max[i]!);
      return { kind: s.kind, pass: inside, detail: `bounds ${formatBox(b)} vs allowed ${formatBox(limit)}` };
    }
    case "consistency":
      return consistency(doc, s);
    case "preserved": {
      if (!ctx.seed) return fail("no seed document");
      const box = fromPublic(s.box);
      const before = blocksIn(ctx.seed, box);
      if (!before.size) return fail(`seed has no blocks in ${formatBox(box)}`);
      let kept = 0;
      for (const [k, state] of before) {
        const [x, y, z] = k.split(",").map(Number) as [number, number, number];
        if (stateId(doc.getState(x, y, z)) === stateId(state)) kept++;
      }
      const share = kept / before.size;
      return { kind: s.kind, pass: share >= s.minShare, detail: `${kept}/${before.size} seed blocks kept (${pct(share)}, need ≥ ${pct(s.minShare)})`, value: share };
    }
  }
  if (!a) return fail(`analyze failed: ${analyzeError ?? "no analysis"}`);
  switch (s.kind) {
    case "storeys": {
      const n = a.storeys.length;
      const max = s.max ?? s.min;
      return { kind: s.kind, pass: n >= s.min && n <= max, detail: `${n} storeys (want ${s.min === max ? s.min : `${s.min}–${max}`})`, value: n };
    }
    case "door": {
      const doors = a.openings.filter((o) => o.kind === "door");
      const sides = [...new Set(doors.map((o) => o.side))];
      return { kind: s.kind, pass: sides.includes(s.side), detail: doors.length ? `doors on ${sides.join(", ")} (want ${s.side})` : "no door found", value: doors.length };
    }
    case "windows": {
      const n = a.openings.filter((o) => o.kind === "window").length;
      return { kind: s.kind, pass: n >= s.min, detail: `${n} windows (need ≥ ${s.min})`, value: n };
    }
    case "roofWatertight": {
      const gaps = a.issues.filter((i) => i.kind === "roof_gap");
      const holes = gaps.reduce((n, g) => n + g.positions.length, 0);
      if (a.roof.type === "none") return fail("no roof detected");
      return { kind: s.kind, pass: holes === 0, detail: holes ? `${a.roof.type} roof with ${holes} gap positions` : `${a.roof.type} roof, no gaps`, value: holes };
    }
    case "roofType":
      return { kind: s.kind, pass: s.types.includes(a.roof.type), detail: `roof ${a.roof.type} (want ${s.types.join("|")})` };
    case "noFloating": {
      const groups = a.issues.filter((i) => i.kind === "floating");
      const n = groups.reduce((t, g) => t + (g.count ?? g.positions.length), 0);
      return { kind: s.kind, pass: groups.length === 0, detail: groups.length ? `${groups.length} floating groups, ${n} blocks` : "nothing floating", value: n };
    }
    case "material": {
      // Walls: analyze's own wall-material counts (footprint sides, floor layers excluded).
      let counts: [string, number][];
      if (s.where === "walls") {
        if (!a.walls) return fail("no walls detected");
        counts = a.walls.material;
      } else {
        if (s.where === "roof" && !a.roof.box) return fail("no roof detected");
        const tally = new Map<string, number>();
        for (const state of blocksIn(doc, s.where === "roof" ? a.roof.box : undefined).values()) tally.set(stateId(state), (tally.get(stateId(state)) ?? 0) + 1);
        counts = [...tally];
      }
      const total = counts.reduce((n, [, c]) => n + c, 0);
      if (!total) return fail(`no blocks in ${s.where}`);
      const hit = counts.reduce((n, [id, c]) => n + (matches(id, s.ids) ? c : 0), 0);
      const share = hit / total;
      return { kind: s.kind, pass: share >= s.minShare, detail: `${s.where}: ${pct(share)} ${s.ids.join("|")} (need ≥ ${pct(s.minShare)})`, value: share };
    }
  }
}

function consistency(doc: Document, s: Extract<CheckSpec, { kind: "consistency" }>): CheckResult {
  const parts = s.parts.map((p) => {
    const box = fromPublic(p);
    const blocks = blocksIn(doc, box);
    const ids = new Set([...blocks.values()].map(stateId));
    let top = -Infinity;
    for (const k of blocks.keys()) top = Math.max(top, Number(k.split(",")[1]));
    return { ids, height: blocks.size ? top - box.min[1] + 1 : 0, count: blocks.size };
  });
  const empty = parts.filter((p) => !p.count).length;
  if (empty) return { kind: s.kind, pass: false, detail: `${empty} of ${parts.length} parts empty`, value: 0 };
  let sum = 0, pairs = 0;
  for (let i = 0; i < parts.length; i++)
    for (let j = i + 1; j < parts.length; j++) {
      const a = parts[i]!.ids, b = parts[j]!.ids;
      const inter = [...a].filter((x) => b.has(x)).length;
      sum += inter / (a.size + b.size - inter);
      pairs++;
    }
  const jaccard = pairs ? sum / pairs : 1;
  const heights = parts.map((p) => p.height);
  const spread = Math.max(...heights) - Math.min(...heights);
  const pass = jaccard >= s.minJaccard && spread <= s.maxHeightSpread;
  return { kind: s.kind, pass, detail: `palette Jaccard ${jaccard.toFixed(2)} (need ≥ ${s.minJaccard}), heights ${heights.join("/")} (spread ≤ ${s.maxHeightSpread})`, value: jaccard };
}

/** The tight bounds as a public box, for results files. */
export function publicBounds(doc: Document): PublicBox | undefined {
  const b = doc.localBounds();
  return b && !isEmptyBox(b) ? toPublic(b) : undefined;
}

