import type { Mask } from "../../core/mask.js";
import type { Vec3 } from "../../core/region.js";
import type { VolumesMessage, WireBox } from "../protocol/messages.js";
import { CANDIDATE } from "./fill.js";

/**
 * Confirming a shape as the volumes (docs/design/18-select.md, piece 9; step T3): the work volume is
 * the shape's bounding box, the context that box grown by `margin`, and the shape itself follows
 * into the linked document as the named selection `candidate`, a guide and never a limit (*Advise,
 * don't constrain*: only the box is enforced). Measurements only: sizes, counts and boxes.
 *
 * With the canvas (docs/design/19-canvas-and-requests.md, *Setting the canvas*; step M1): when no
 * canvas holds the box plus margin, the confirm sets one to it first (`canvas.set`; the mod widens it
 * to whole chunk columns and the build height). A shape whose context is over the brush cap
 * (`contextCap`, the mod's `bad_volumes`) then sets no volumes: the canvas is the result, and the
 * agent places the brush itself inside it.
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
  /** The canvas holding the box plus margin (world, inclusive); absent when none does (a mod without `canvas`, or refused). */
  canvas?: WireBox;
  /** Whether this confirm set that canvas (else one already held the box plus margin). */
  canvasSet?: boolean;
  /** The mod's refusal of `canvas.set` (over `canvasChunks`). */
  canvasRefused?: string;
  /** Whether linking follows on its own (`world.autoLink`). */
  autoLink: boolean;
  /** Whether the shape was already put into the linked document (the link didn't change). */
  placed: boolean;
}

/** `16×8 chunks at world (0,-64,0)–(255,319,127)`: a canvas, as the mod confirmed it. */
export function canvasWords(c: WireBox): string {
  return `${(c.max[0] - c.min[0] + 1) >> 4}×${(c.max[2] - c.min[2] + 1) >> 4} chunks at world ${span(c)}`;
}

/** `world_volumes({from})`'s text (`18`, piece 9; `19`, *Setting the canvas*). */
export function describeConfirm(d: ConfirmDescription): string {
  const what = `"${d.from}" (${n(d.count)} block${d.count === 1 ? "" : "s"}, box ${size(d.box)} at world ${span(d.box)})`;
  const names = d.withCandidate ? `"${d.from}" and the whole "${CANDIDATE}"` : `"${d.from}"`;
  const v = d.volumes;
  const keep = `keep it with select({view:"world", sel:{freeze:{intersect:["${CANDIDATE}", <box>]}}, name:"part"}) and confirm it with world_volumes({from:"part"})`;
  if (!v && d.canvas) {
    const canvas = d.canvasSet ? `The canvas is set to ${canvasWords(d.canvas)} (the box plus ${d.margin}, widened to whole chunk columns and the build height).` : `The canvas, ${canvasWords(d.canvas)}, already holds it.`;
    return [
      `ok · world_volumes · from ${what}: over the brush cap, so no volumes were set. The mod refused them (${d.tooLarge}): with its context (+${d.margin}) the box is over the mod's contextCap. ${canvas}`,
      `The shape stays the named selection ${names} in the world view, and comes along into the next document linked in this request.`,
      `You place the brush (the work volume) yourself, anywhere in the canvas, without asking the player: look at the whole canvas with world_map, choose a part, ${keep}. Reads anywhere in the canvas work in every mode (world_view_read, render with view:"world", world_search).`,
    ].join("\n");
  }
  if (!v) {
    return [
      `ok · world_volumes · from ${what}: confirmed as a selection, but too large for a work volume. The mod refused the volumes (${d.tooLarge}): with its context (+${d.margin}) the box is over the mod's contextCap, which isn't raised, so no volumes were set.${d.canvasRefused ? ` The canvas wasn't set either (${d.canvasRefused}).` : ""}`,
      `The shape stays the named selection ${names} in the world view, and comes along into the next document linked in this request.`,
      `Propose a part to the player (world_reply with choices), ${keep}; then work on the shape part by part, splitting a part into sandboxes (scope_fork) where it is still too big to work on at once.`,
    ].join("\n");
  }
  const ctx = `context +${d.margin} (${v.context.length} box${v.context.length === 1 ? "" : "es"} after the game's build-height clipping)`;
  const follow = d.placed
    ? `The linked document already holds these volumes: ${names} ${d.withCandidate ? "are" : "is"} now named selection${d.withCandidate ? "s" : ""} there (local coordinates).`
    : d.autoLink
      ? `The game shows the outlines; linking follows on its own (${d.canvas ? "in the canvas's frame: coordinates don't move with the brush" : "the work volume's minimum corner becomes local (0,0,0)"}), with its fresh blocks, and ${names} come${d.withCandidate ? "" : "s"} along as named selection${d.withCandidate ? "s" : ""} in the linked document.`
      : `The game shows the outlines; call doc_open({world: true}) to link (world.autoLink is off), and ${names} come${d.withCandidate ? "" : "s"} along as named selection${d.withCandidate ? "s" : ""} in the linked document.`;
  const canvas = d.canvasSet && d.canvas
    ? [`The canvas is set to ${canvasWords(d.canvas)} (the box plus ${d.margin}, widened to whole chunk columns and the build height): reads work anywhere in it in every mode, and the brush can move inside it.`]
    : d.canvasRefused
      ? [`The canvas wasn't set (${d.canvasRefused}).`]
      : [];
  return [
    `ok · world_volumes · from ${what}: work ${size(v.work)} at world ${span(v.work)}, ${ctx} · link ${v.link}.`,
    `${follow} The shape is a guide for where to work; only the work volume's box is enforced.`,
    ...canvas,
  ].join("\n");
}

/** Whether `o` holds `b` (inclusive world boxes). */
export const holdsWire = (o: WireBox, b: WireBox): boolean => [0, 1, 2].every((i) => o.min[i]! <= b.min[i]! && o.max[i]! >= b.max[i]!);
