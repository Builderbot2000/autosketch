import { unionBox, type Box, type Vec3 } from "../core/region.js";
import { lookTarget, saveCamera } from "../document/cameras.js";
import { Document, type WriteGuard } from "../document/document.js";
import type { PaletteBook } from "../palette/pick.js";
import { refusal } from "../scope/scopes.js";
import type { BridgeConnection } from "./bridge.js";
import type { GameContext, PromptMessage, ScanGrant, SnapshotResult, SurfaceLayer, SurfaceResult, WireArea, WireBox } from "./protocol/messages.js";

/**
 * The scan probe (docs/design/13-live-world.md, *Backlog* B4, *Probe document*): what a
 * `/autosketch scan` request lets the agent see before any link, loaded into a temporary
 * read-only document the usual views work on.
 *
 * - **Full blocks** of the grant's `scan.box` (a blocks snapshot: states and block entities).
 * - **The surface** of the grant's `scan.columns`: per column, its topmost non-air block, written
 *   into the document as that one block (a skin over the terrain, so a `top` render is a map of the
 *   surface and an iso render shows the land around). Inside the full-block box the box's own blocks
 *   already hold it.
 * - **The ceiling**, only when the player is covered: some non-air block above their eyes in their
 *   own column within the full-block box (a cave, or indoors). It is then read from the player's
 *   feet up, so each column also gets the lowest non-air block at or above the feet (the cave roof
 *   or the room's ceiling), written the same way. A covered player more than `scanAbove` blocks
 *   under open air isn't seen as covered; the surface is still read.
 * - **Coordinates:** local (0, 0, 0) is the north-west corner of the scanned columns, at the bottom
 *   of the full-block box, so the surface can lie at negative local y in a deep valley.
 * - **Handles:** the player's view is saved as camera `player`, the crosshair block as selection
 *   `target`, and the focus box as `focus`, when they lie in the scanned columns.
 * - **Read-only:** every edit is refused with `probe_read_only`, and the session never saves it
 *   (`Session.adoptTemporary`). Nothing in the probe reaches the world.
 *
 * The probe reads; it never decides where a build ends. The agent does, through `world_volumes`.
 */

/** A loaded probe. */
export interface Probe {
  doc: Document;
  /** World position of local (0, 0, 0). */
  origin: Vec3;
  dimension: string;
  /** The request it was loaded for. */
  request: number;
  grant: ScanGrant;
  /** The y the ceiling was read from, when the player was covered. */
  ceiling?: number;
  /** Chunks of the area that aren't generated. */
  missing: [number, number][];
}

/** The probe's name as a document. */
export const PROBE_NAME = "probe";

/** Reads the probe for a scan prompt (two requests: the full-block box, then the surface). */
export async function loadProbe(bridge: Pick<BridgeConnection, "request">, m: PromptMessage & { scan: ScanGrant }, opts: { dataVersion: number; palettes?: PaletteBook }): Promise<Probe> {
  const ctx = m.context, grant = m.scan, dimension = ctx.dimension;
  const origin: Vec3 = [grant.columns.min[0], grant.box.min[1], grant.columns.min[1]];
  const blocks = await bridge.request({ type: "snapshot", dimension, boxes: [grant.box] });
  const doc = Document.create({ name: PROBE_NAME, dataVersion: opts.dataVersion, ...(opts.palettes ? { palettes: opts.palettes } : {}) });
  doc.meta.source = `world:probe ${dimension} ${fmtArea(grant.columns)}`;
  writeBlocks(doc, blocks, origin);
  const ceiling = covered(doc, grant.box, ctx, origin) ? Math.floor(ctx.position[1]) : undefined;
  const surface = await bridge.request({ type: "snapshot", dimension, kind: "surface", columns: grant.columns, ...(ceiling !== undefined ? { ceiling } : {}) });
  let bounds: Box | undefined = localBox(grant.box, origin);
  bounds = writeLayer(doc, surface, surface.surface, grant.box, origin, bounds);
  if (surface.ceilings) bounds = writeLayer(doc, surface, surface.ceilings, grant.box, origin, bounds);
  doc.bounds = bounds;
  saveHandles(doc, ctx, grant.columns, origin);
  doc.guards.push(readOnly(m.id));
  return { doc, origin, dimension, request: m.id, grant, ...(ceiling !== undefined ? { ceiling } : {}), missing: surface.missing };
}

/** Refuses every edit on the probe. */
function readOnly(request: number): WriteGuard {
  return (_changes, op) => {
    throw refusal(
      "probe_read_only",
      `The probe (from scan request ${request}) is a read-only look at the world around the player, so ${op} can't edit it; nothing in it reaches the world. ` +
        "Set the volumes with world_volumes({work, context}) in its coordinates; building happens on the linked document once the player gives build instructions (/autosketch build), or doc_new/doc_open another document.",
    );
  };
}

/** The probe's lines for the channel event (measurements only). */
export function probeText(p: Probe): string {
  const c = p.grant.columns, b = p.grant.box;
  const w = c.max[0] - c.min[0] + 1, d = c.max[1] - c.min[1] + 1;
  const chunks = 2 * p.grant.radius + 1;
  const lb = localBox(b, p.origin);
  const parts = [
    `The probe is open as the read-only document "${PROBE_NAME}" (nothing is linked yet): the surface of ${chunks}×${chunks} chunks (${w}×${d} columns, local x 0–${w - 1}, z 0–${d - 1})` +
      `${p.grant.clipped ? ", the radius clipped in-game" : ""}, and full blocks in local (${lb.min.join(", ")})–(${lb.max.map((v) => v - 1).join(", ")}) (${b.max[0] - b.min[0] + 1}×${b.max[1] - b.min[1] + 1}×${b.max[2] - b.min[2] + 1}).`,
  ];
  if (p.ceiling !== undefined) parts.push(`You are covered, so each column's ceiling from local y ${p.ceiling - p.origin[1]} up is in it too.`);
  if (p.missing.length) parts.push(`${p.missing.length} chunk${p.missing.length === 1 ? " isn't" : "s aren't"} generated (empty columns).`);
  parts.push(`Outside the full-block box each column holds only its top block: render({views:["top"]}) is a map of the surface. Set the volumes with world_volumes({work, context}) in this document's coordinates.`);
  return parts.join(" ");
}

// -- reading ------------------------------------------------------------------------------------

const AIR = "minecraft:air";
const airy = (s: string) => s === AIR || s === "minecraft:cave_air" || s === "minecraft:void_air";

function writeBlocks(doc: Document, snap: SnapshotResult, origin: Vec3): void {
  const ids = snap.palette.map((s) => doc.states.intern(airy(s) ? AIR : s));
  for (const r of snap.regions) {
    const { min, max } = r.box;
    let i = 0;
    for (let y = min[1]; y <= max[1]; y++)
      for (let z = min[2]; z <= max[2]; z++)
        for (let x = min[0]; x <= max[0]; x++) doc.voxels.set(x - origin[0], y - origin[1], z - origin[2], ids[r.states[i++]!]!);
    for (const be of r.blockEntities) doc.blockEntities.set(`${be.pos[0] - origin[0]},${be.pos[1] - origin[1]},${be.pos[2] - origin[2]}`, be.nbt);
  }
}

/** Whether the player's own column holds a non-air block above their eyes, within the box. */
function covered(doc: Document, box: WireBox, ctx: GameContext, origin: Vec3): boolean {
  const x = Math.floor(ctx.position[0]), z = Math.floor(ctx.position[2]);
  if (x < box.min[0] || x > box.max[0] || z < box.min[2] || z > box.max[2]) return false;
  const air = doc.states.intern(AIR);
  for (let y = Math.max(box.min[1], Math.floor(ctx.eye[1]) + 1); y <= box.max[1]; y++) if (doc.voxels.get(x - origin[0], y - origin[1], z - origin[2]) !== air) return true;
  return false;
}

/** Writes one block per column where the full-block box doesn't already hold it; returns the grown bounds. */
function writeLayer(doc: Document, r: SurfaceResult, layer: SurfaceLayer, box: WireBox, origin: Vec3, bounds: Box | undefined): Box | undefined {
  const ids = r.palette.map((s) => doc.states.intern(s));
  const { min, max } = r.columns;
  const w = max[0] - min[0] + 1;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < layer.heights.length; i++) {
    const h = layer.heights[i]!;
    if (h === 0) continue;
    const x = min[0] + (i % w), z = min[1] + Math.floor(i / w), y = r.minY + h - 1;
    lo = Math.min(lo, y);
    hi = Math.max(hi, y);
    if (x >= box.min[0] && x <= box.max[0] && z >= box.min[2] && z <= box.max[2] && y >= box.min[1] && y <= box.max[1]) continue;
    doc.voxels.set(x - origin[0], y - origin[1], z - origin[2], ids[layer.states[i]!]!);
  }
  if (lo > hi) return bounds;
  return unionBox(bounds, { min: [min[0] - origin[0], lo - origin[1], min[1] - origin[2]], max: [max[0] + 1 - origin[0], hi + 1 - origin[1], max[1] + 1 - origin[2]] });
}

function saveHandles(doc: Document, ctx: GameContext, cols: WireArea, origin: Vec3): void {
  const inCols = (p: readonly number[]) => p[0]! >= cols.min[0] && p[0]! <= cols.max[0] && p[2]! >= cols.min[1] && p[2]! <= cols.max[1];
  const sub = (p: readonly number[]): Vec3 => [p[0]! - origin[0], p[1]! - origin[1], p[2]! - origin[2]];
  if (ctx.target && inCols(ctx.target.pos)) {
    const t = sub(ctx.target.pos);
    doc.selections.set("target", { min: t, max: t });
  }
  if (ctx.focus && inCols(ctx.focus.min) && inCols(ctx.focus.max)) doc.selections.set("focus", { min: sub(ctx.focus.min), max: sub(ctx.focus.max) });
  // Camera positions are document-local with integers at block centres (06, *Cameras*).
  const eye = sub(ctx.eye).map((c) => c - 0.5) as Vec3;
  saveCamera(doc, "player", { eye, target: lookTarget(eye, ctx.yaw, ctx.pitch) });
}

/** The local half-open box of a world box. */
function localBox(b: WireBox, origin: Vec3): Box {
  return { min: [b.min[0] - origin[0], b.min[1] - origin[1], b.min[2] - origin[2]], max: [b.max[0] + 1 - origin[0], b.max[1] + 1 - origin[1], b.max[2] + 1 - origin[2]] };
}

const fmtArea = (a: WireArea) => `(${a.min.join(",")})–(${a.max.join(",")})`;
