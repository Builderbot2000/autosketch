import type { Compound } from "prismarine-nbt";
import { Mask } from "../core/mask.js";
import { defaultPivot, mirrorPos, rotatePos, stateTransformer, transformBox, type MirrorAxis, type StateTransform } from "../core/rotate.js";
import { formatBox, formatVec, type Box, type Vec3 } from "../core/region.js";
import type { Document, EditResult, Transaction } from "../document/document.js";
import { checkRegion, opEdit, regionBox, registerAs, stateOverrides, type OpEnv, type Region } from "./edit.js";

/**
 * Transform ops (docs/design/05-operations.md, L2 `move / copy / rotate / mirror`): carry the blocks
 * of any selection, with their block entities, to new positions, remapping block states through
 * the rotation tables (01, Orientation; `core/rotate.ts`). Each op is one journal entry.
 *
 * - Sources are read first, then cleared (move/rotate/mirror), then written, so overlapping source
 *   and destination work like the game's structure placement.
 * - Air in the selection is carried too (it overwrites the destination) unless `skipAir`.
 * - Components whose box lies wholly inside the selection move with it (04); `copy` leaves them.
 */

export interface TransformOptions {
  /** Don't carry air: only non-air blocks are written (and, for moves, cleared). */
  skipAir?: boolean;
  /** Write states exactly as transformed, without auto-connection (05). */
  raw?: boolean;
  /** Register the destination's bounding box as a component. */
  as?: string;
  kind?: string;
  label?: string;
}

interface Plan {
  op: "move" | "copy" | "rotate" | "mirror";
  summary: string;
  place: (p: Vec3) => Vec3;
  state?: StateTransform;
  keepSource: boolean;
}

/** move: shifts a selection by `by`. */
export function move(doc: Document, env: OpEnv, region: Region, by: Vec3, opts: TransformOptions = {}): EditResult {
  checkVec(by, "by");
  return run(doc, env, region, opts, {
    op: "move",
    summary: `move ${label(region, opts)} by ${formatVec(by)}`,
    place: (p) => [p[0] + by[0], p[1] + by[1], p[2] + by[2]],
    keepSource: false,
  });
}

/** copy: duplicates a selection shifted by `by`, optionally rotated/mirrored about its own pivot first. */
export function copy(doc: Document, env: OpEnv, region: Region, by: Vec3, opts: TransformOptions & { turns?: number; mirror?: MirrorAxis } = {}): EditResult {
  checkVec(by, "by");
  const bb = regionBox(region);
  const pivot = defaultPivot(bb);
  const turns = norm(opts.turns ?? 0);
  const axis = opts.mirror;
  const about = axis ? centre(bb, axis) : 0;
  const extra = `${axis ? ` mirror ${axis}` : ""}${turns ? ` rotate ${turns * 90}°` : ""}`;
  return run(doc, env, region, opts, {
    op: "copy",
    summary: `copy ${label(region, opts)} by ${formatVec(by)}${extra}`,
    place: (p) => {
      const q = rotatePos(axis ? mirrorPos(p, axis, about) : p, turns, pivot);
      return [q[0] + by[0], q[1] + by[1], q[2] + by[2]];
    },
    ...(turns || axis ? { state: { turns, ...(axis ? { mirror: axis } : {}) } } : {}),
    keepSource: true,
  });
}

/** rotate: turns a selection clockwise (seen from above) in 90° steps about a pivot block (default: centre, rounded toward min). */
export function rotate(doc: Document, env: OpEnv, region: Region, turns: number, opts: TransformOptions & { pivot?: Vec3 } = {}): EditResult {
  if (!Number.isInteger(turns)) throw new Error("turns must be a whole number of 90° clockwise turns (1 = 90°, -1 = 90° counter-clockwise)");
  const pivot = opts.pivot ?? defaultPivot(regionBox(region));
  if (opts.pivot) checkVec(opts.pivot, "pivot");
  const t = norm(turns);
  return run(doc, env, region, opts, {
    op: "rotate",
    summary: `rotate ${label(region, opts)} ${t * 90}° about ${formatVec(pivot)}`,
    place: (p) => rotatePos(p, t, pivot),
    state: { turns: t },
    keepSource: false,
  });
}

/** mirror: flips a selection across an axis plane (default: through its own centre, so it stays in place). */
export function mirror(doc: Document, env: OpEnv, region: Region, axis: MirrorAxis, opts: TransformOptions & { about?: number } = {}): EditResult {
  if (!["x", "y", "z"].includes(axis)) throw new Error('axis must be "x" (flips east↔west), "z" (flips north↔south) or "y" (flips up↔down)');
  const about = opts.about ?? centre(regionBox(region), axis);
  if (!Number.isFinite(about) || !Number.isInteger(about * 2)) throw new Error("about must be a block coordinate or a half (e.g. 4 or 4.5)");
  return run(doc, env, region, opts, {
    op: "mirror",
    summary: `mirror ${label(region, opts)} ${axis} about ${about}`,
    place: (p) => mirrorPos(p, axis, about),
    state: { mirror: axis },
    keepSource: false,
  });
}

// -- shared ---------------------------------------------------------------------------------------

function run(doc: Document, env: OpEnv, region: Region, opts: TransformOptions, plan: Plan): EditResult {
  checkRegion(region);
  const src = region instanceof Mask ? region : Mask.fromBox(region);
  const mapState = plan.state ? stateTransformer(plan.state, { ...(env.registry ? { registry: env.registry } : {}), overrides: stateOverrides(env) }) : undefined;
  return opEdit(doc, env, plan.op, plan.summary + (opts.as ? ` as ${opts.as}` : ""), opts, (tx) => {
    const blocks = readBlocks(doc, tx, src, opts.skipAir === true);
    if (!plan.keepSource) for (let i = 0; i < blocks.n; i++) tx.clear(blocks.pos[i * 3]!, blocks.pos[i * 3 + 1]!, blocks.pos[i * 3 + 2]!);
    const idMap = new Map<number, number>();
    let dest: Box | undefined;
    for (let i = 0; i < blocks.n; i++) {
      const p = plan.place([blocks.pos[i * 3]!, blocks.pos[i * 3 + 1]!, blocks.pos[i * 3 + 2]!]);
      let id = blocks.ids[i]!;
      if (mapState) {
        let m = idMap.get(id);
        if (m === undefined) idMap.set(id, (m = tx.intern(mapState(doc.states.get(id)))));
        id = m;
      }
      tx.set(p[0], p[1], p[2], id, blocks.nbt.get(i) ?? null);
      dest = grow(dest, p);
    }
    if (!plan.keepSource) moveComponents(doc, tx, region, src, plan.place);
    if (dest && opts.as) registerAs(tx, opts, dest);
    if (!blocks.n) tx.warn("the selection holds only air and skip_air is on; nothing moved");
  });
}

interface Blocks {
  n: number;
  pos: Int32Array;
  ids: Uint16Array;
  nbt: Map<number, Compound>;
}

function readBlocks(doc: Document, tx: Transaction, m: Mask, skipAir: boolean): Blocks {
  const count = m.count();
  const pos = new Int32Array(count * 3);
  const ids = new Uint16Array(count);
  const nbt = new Map<number, Compound>();
  let n = 0;
  m.forEach((x, y, z) => {
    const id = tx.getId(x, y, z);
    if (skipAir && id === 0) return;
    pos[n * 3] = x;
    pos[n * 3 + 1] = y;
    pos[n * 3 + 2] = z;
    ids[n] = id;
    const be = doc.getBlockEntity(x, y, z);
    if (be) nbt.set(n, be);
    n++;
  });
  return { n, pos, ids, nbt };
}

/** Components lying wholly inside the transformed selection take the transform (04). */
function moveComponents(doc: Document, tx: Transaction, region: Region, m: Mask, place: (p: Vec3) => Vec3): void {
  for (const id of [...doc.components.keys()]) {
    const c = doc.componentLocal(id)!;
    if (!covers(region, m, c.box)) continue;
    const anchors: Record<string, Vec3> = {};
    for (const [k, v] of Object.entries(c.anchors)) anchors[k] = place(v);
    tx.setComponent({
      id,
      box: transformBox(c.box, place),
      anchors,
      tags: c.tags,
      ...(c.kind ? { kind: c.kind } : {}),
      ...(c.parent ? { parent: c.parent } : {}),
      ...(c.notes ? { notes: c.notes } : {}),
    });
  }
}

function covers(region: Region, m: Mask, b: Box): boolean {
  if (!(region instanceof Mask)) return b.min.every((v, i) => v >= region.min[i]!) && b.max.every((v, i) => v <= region.max[i]!);
  for (let y = b.min[1]; y < b.max[1]; y++) for (let z = b.min[2]; z < b.max[2]; z++) for (let x = b.min[0]; x < b.max[0]; x++) if (!m.has(x, y, z)) return false;
  return true;
}

function grow(b: Box | undefined, p: Vec3): Box {
  if (!b) return { min: [...p], max: [p[0] + 1, p[1] + 1, p[2] + 1] };
  for (let a = 0; a < 3; a++) {
    if (p[a]! < b.min[a]!) b.min[a] = p[a]!;
    if (p[a]! + 1 > b.max[a]!) b.max[a] = p[a]! + 1;
  }
  return b;
}

/** Exact centre of a box on one axis (a half coordinate for even sizes), so a default mirror stays in place. */
function centre(b: Box, axis: MirrorAxis): number {
  const a = "xyz".indexOf(axis);
  return (b.min[a]! + b.max[a]! - 1) / 2;
}

function norm(turns: number): number {
  return ((turns % 4) + 4) % 4;
}

function checkVec(v: Vec3, what: string): void {
  if (!Array.isArray(v) || v.length !== 3 || v.some((n) => !Number.isInteger(n))) throw new Error(`${what} must be [x,y,z] integers (got ${JSON.stringify(v)})`);
}

function label(region: Region, opts: TransformOptions): string {
  if (opts.label) return opts.label;
  return region instanceof Mask ? `sel ${region.count()} blocks in ${formatBox(regionBox(region))}` : formatBox(region);
}
