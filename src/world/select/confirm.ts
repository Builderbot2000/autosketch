import type { Mask } from "../../core/mask.js";
import type { Vec3 } from "../../core/region.js";
import type { VolumesMessage, WireBox } from "../protocol/messages.js";
import { CANDIDATE } from "./fill.js";

/**
 * Confirming a shape as the volumes (docs/design/18-select.md, piece 9; step T3): the work volume is
 * the shape's bounding box, the context that box grown by `margin`, and the shape itself follows
 * into the linked document as the named selection `candidate`, a guide and never a limit (*Advise,
 * don't constrain*: only the box is enforced). Measurements only: sizes, counts and boxes.
 */

/** The context margin around the work volume when none is given (`18`, piece 9). */
export const CONFIRM_MARGIN = 8;

/** A mask's `{frozen}` runs (`[x, y, z, length]` along x), shifted by `-origin`, the form a named selection stores voxels in (`05`, `{freeze}`). */
export function maskRuns(m: Mask, origin: Vec3 = [0, 0, 0]): number[][] {
  const pts = m.positions().sort((p, q) => p[1] - q[1] || p[2] - q[2] || p[0] - q[0]);
  const runs: number[][] = [];
  for (const [x0, y0, z0] of pts) {
    const x = x0 - origin[0], y = y0 - origin[1], z = z0 - origin[2];
    const last = runs[runs.length - 1];
    if (last && last[1] === y && last[2] === z && last[0]! + last[3]! === x) last[3]!++;
    else runs.push([x, y, z, 1]);
  }
  return runs;
}

/** The inclusive world box of a mask, as the wire carries it. */
export function wireBoxOf(m: Mask): WireBox | undefined {
  const b = m.bbox();
  return b && { min: [...b.min], max: [b.max[0] - 1, b.max[1] - 1, b.max[2] - 1] };
}

/** The box grown by `g` on every side. */
export const growWire = (b: WireBox, g: number): WireBox => ({ min: [b.min[0] - g, b.min[1] - g, b.min[2] - g], max: [b.max[0] + g, b.max[1] + g, b.max[2] + g] });

const n = (k: number) => k.toLocaleString("en-US");
const pt = (v: readonly number[]) => `(${v.join(",")})`;
const size = (b: WireBox) => [0, 1, 2].map((i) => b.max[i]! - b.min[i]! + 1).join("×");
const span = (b: WireBox) => `${pt(b.min)}–${pt(b.max)}`;

export interface ConfirmDescription {
  /** The named selection confirmed (`candidate`, or a part kept under another name). */
  from: string;
  /** Its block count and inclusive world box. */
  count: number;
  box: WireBox;
  margin: number;
  /** Whether the whole candidate comes along too (confirming a part). */
  withCandidate: boolean;
  /** The volumes the mod confirmed; absent when too large. */
  volumes?: Extract<VolumesMessage, { work: WireBox }>;
  /** The mod's refusal when the context would be over its `contextCap`. */
  tooLarge?: string;
  /** Whether linking follows on its own (`world.autoLink`). */
  autoLink: boolean;
  /** Whether the shape was already put into the linked document (the link didn't change). */
  placed: boolean;
}

/** `world_volumes({from})`'s text (`18`, piece 9). */
export function describeConfirm(d: ConfirmDescription): string {
  const what = `"${d.from}" (${n(d.count)} block${d.count === 1 ? "" : "s"}, box ${size(d.box)} at world ${span(d.box)})`;
  const names = d.withCandidate ? `"${d.from}" and the whole "${CANDIDATE}"` : `"${d.from}"`;
  const v = d.volumes;
  if (!v) {
    return [
      `ok · world_volumes · from ${what}: confirmed as a selection, but too large for a work volume. The mod refused the volumes (${d.tooLarge}): with its context (+${d.margin}) the box is over the mod's contextCap, which isn't raised, so no volumes were set.`,
      `The shape stays the named selection ${names} in the world view, and comes along into the next document linked in this request.`,
      `Propose a part to the player (world_reply with choices), keep it with select({view:"world", sel:{freeze:{intersect:["${CANDIDATE}", <box>]}}, name:"part"}) and confirm it with world_volumes({from:"part"}); then work on the shape part by part, splitting a part into sandboxes (scope_fork) where it is still too big to work on at once.`,
    ].join("\n");
  }
  const ctx = `context +${d.margin} (${v.context.length} box${v.context.length === 1 ? "" : "es"} after the game's build-height clipping)`;
  const follow = d.placed
    ? `The linked document already holds these volumes: ${names} ${d.withCandidate ? "are" : "is"} now named selection${d.withCandidate ? "s" : ""} there (local coordinates).`
    : d.autoLink
      ? `The game shows the outlines; linking follows on its own (the work volume's minimum corner becomes local (0,0,0)), with its fresh blocks, and ${names} come${d.withCandidate ? "" : "s"} along as named selection${d.withCandidate ? "s" : ""} in the linked document.`
      : `The game shows the outlines; call doc_open({world: true}) to link (world.autoLink is off), and ${names} come${d.withCandidate ? "" : "s"} along as named selection${d.withCandidate ? "s" : ""} in the linked document.`;
  return [
    `ok · world_volumes · from ${what}: work ${size(v.work)} at world ${span(v.work)}, ${ctx} · link ${v.link}.`,
    `${follow} The shape is a guide for where to work; only the work volume's box is enforced.`,
  ].join("\n");
}
