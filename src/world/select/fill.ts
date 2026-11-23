import { Mask } from "../../core/mask.js";
import { formatBox, type Box, type Vec3 } from "../../core/region.js";
import type { ExpandBy, FillResult, FrontierSection, MaskSection } from "../protocol/messages.js";
import type { ViewRead } from "../view.js";

/**
 * The candidate a fill grows (docs/design/18-select.md, pieces 3 and 4): the shape the mod answers
 * as per-section masks, turned into the world view's named selection `candidate`, and the text the
 * agent reads. Measurements only (`18`, *Principles*): box, count, sections, and whether the frontier
 * is empty; nothing says whether the shape is "the building".
 */

/** The view's selection a fill names (`18`, piece 3). */
export const CANDIDATE = "candidate";

/** A section's key in the held shape. */
export const sectionKey = (s: Vec3) => s.join(",");

/** Visits the world positions of one mask section, in wire order (`x + 16·(z + 16·y)`). */
function eachInSection(s: MaskSection, fn: (x: number, y: number, z: number) => void): void {
  const bx = s.section[0] * 16, by = s.section[1] * 16, bz = s.section[2] * 16;
  for (let i = 0; i < 4096; i++) {
    if (s.mask !== "full" && !(s.mask[i >> 3]! & (1 << (i & 7)))) continue;
    fn(bx + (i & 15), by + (i >> 8), bz + ((i >> 4) & 15));
  }
}

/** The held sections as a mask, in world coordinates. */
export function candidateMask(sections: Iterable<MaskSection>): Mask {
  const m = new Mask();
  for (const s of sections) eachInSection(s, (x, y, z) => m.add(x, y, z));
  return m;
}

/**
 * The held sections as `{frozen}` runs (`[x, y, z, length]` along x), the form a named selection
 * stores resolved voxels in (`05`, `{freeze}`), so `"candidate"` resolves in the view like any
 * frozen selection. Runs don't cross a section's edge.
 */
export function frozenRuns(sections: Iterable<MaskSection>): number[][] {
  const runs: number[][] = [];
  for (const s of sections) {
    let last: number[] | undefined;
    eachInSection(s, (x, y, z) => {
      if (last && last[1] === y && last[2] === z && last[0]! + last[3]! === x) last[3]!++;
      else runs.push((last = [x, y, z, 1]));
    });
  }
  return runs;
}

/** Frontier faces: the unexplored sides of every frontier position, summed. */
export function frontierFaces(frontier: readonly FrontierSection[]): number {
  let n = 0;
  for (const f of frontier) for (const m of f.faces) for (let b = m; b; b &= b - 1) n++;
  return n;
}

const n = (k: number) => k.toLocaleString("en-US");
const plural = (k: number, w: string) => `${n(k)} ${w}${k === 1 ? "" : "s"}`;
const wireBox = (b: { min: Vec3; max: Vec3 }): Box => ({ min: [...b.min], max: [b.max[0] + 1, b.max[1] + 1, b.max[2] + 1] });

/** How an expand grew the read area, in words. */
export function describeBy(by: ExpandBy): string {
  if (by === "frontier") return "by the frontier";
  if ("box" in by) return `by the chunks of ${formatBox(wireBox(by.box))}`;
  return `${plural(by.chunks, "chunk")} ${by.direction}`;
}

export interface FillDescription {
  /** `world_fill`, or `world_expand` with how it grew. */
  tool: "world_fill" | "world_expand";
  by?: ExpandBy;
  /** The answer (an expand's carries only the changed sections). */
  result: FillResult;
  /** Sections held now, the whole shape. */
  sections: number;
  /** Blocks before this step (an expand). */
  before?: number;
  /** The match, as the agent will recognise it. */
  match: string;
  connectivity: number;
  /** The step's budget (the request's, else the mod's contextCap). */
  budget?: number;
  /** The margin read into the world view, or why it failed. */
  read?: { what: ViewRead; margin: number; sections: number } | { error: string };
}

/** The fill's or expand's text (`18`, piece 3): box, count, sections, frontier, the view read. */
export function describeFill(d: FillDescription): string {
  const r = d.result;
  const lines: string[] = [];
  const head = d.tool === "world_fill" ? "ok · world_fill" : `ok · world_expand (${describeBy(d.by!)})`;
  if (!r.box) {
    lines.push(`${head} · nothing filled: the seed (${r.seed.join(",")}) doesn't match ${d.match}${r.missing.length ? " or lies in an ungenerated chunk" : ""}.`);
    lines.push(`Nothing was named ${CANDIDATE}. Pick a seed on a block of the build (view_slice or raycast on the world view, or the search's sections), or match its material.`);
    return lines.join("\n");
  }
  const box = wireBox(r.box);
  const size = [0, 1, 2].map((a) => box.max[a]! - box.min[a]!).join("×");
  const grew = d.before !== undefined ? ` (+${n(r.count - d.before)}, ${plural(r.sections.length, "section")} changed)` : "";
  lines.push(`${head} · ${CANDIDATE}: ${plural(r.count, "block")}${grew} in ${plural(d.sections, "section")}, box ${formatBox(box)} (${size}) · seed (${r.seed.join(",")}), match ${d.match}, connectivity ${d.connectivity}`);
  const faces = frontierFaces(r.frontier);
  const positions = r.frontier.reduce((k, f) => k + f.index.length, 0);
  if (r.stopped === "complete" && !faces) lines.push("Complete: the shape ends at non-matching blocks (or air) on every side; the frontier is empty.");
  else if (r.stopped === "budget")
    lines.push(`Cut off at ${plural(faces, "face")} (${plural(positions, "frontier block")}): the step's budget${d.budget !== undefined ? ` of ${n(d.budget)} blocks` : ""} ran out. world_expand({by:"frontier"}) continues with a fresh budget.`);
  else
    lines.push(`Cut off at ${plural(faces, "face")} (${plural(positions, "frontier block")}) where the shape reaches the read area's edge: world_expand({by:"frontier"}) to continue (or by a direction and chunks, or a box).`);
  if (r.missing.length)
    lines.push(`${plural(r.missing.length, "ungenerated chunk")} in the read area stop the fill like non-matching blocks (expanding can't read them): ${r.missing.slice(0, 8).map((c) => `[${c.join(",")}]`).join(" ")}${r.missing.length > 8 ? " …" : ""}.`);
  const rd = d.read;
  if (rd && "error" in rd) lines.push(`The world view's read around it failed (${rd.error}); read it with world_view_read({sel:{dilate:"${CANDIDATE}",by:8}}).`);
  else if (rd) {
    const w = rd.what;
    const which = d.tool === "world_fill" ? `its ${plural(rd.sections, "section")}` : `the ${plural(rd.sections, "changed section")}`;
    lines.push(
      `Read into the world view: ${which} plus ${rd.margin} blocks around, ${n(w.blocks)} blocks` +
        (w.level === "coarse" ? `, over the per-read cap so coarse, one block per ${w.cell}³ cell (read a smaller box with world_view_read for full detail)` : ` (${n(w.solid)} non-air)`) +
        (w.missing?.length ? `, ${plural(w.missing.length, "ungenerated chunk")} read as nothing` : "") +
        ".",
    );
  }
  lines.push(
    `The shape is the named selection "${CANDIDATE}" in the world view (world coordinates): render({view:"world", region:{dilate:"${CANDIDATE}",by:8}, fade:"${CANDIDATE}"}) shows it among its surroundings. ` +
      `Trim or combine it with the selection algebra, frozen since a selection can't name itself: select({view:"world", sel:{freeze:{subtract:["${CANDIDATE}", …]}}, name:"${CANDIDATE}"}). ` +
      `A new world_fill replaces it; keep one first with select({view:"world", sel:{freeze:"${CANDIDATE}"}, name}).`,
  );
  return lines.join("\n");
}
