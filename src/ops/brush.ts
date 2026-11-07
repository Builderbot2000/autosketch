import { Mask, shellOf } from "../core/mask.js";
import { formatBox, formatVec, unionBox, type Box, type Vec3 } from "../core/region.js";
import { stateTransformer } from "../core/rotate.js";
import type { Document, EditResult } from "../document/document.js";
import { checkRegion, describeMaterial, materialContext, MAX_OP_VOLUME, opEdit, regionBox, registerAs, stateOverrides, type CommonOptions, type OpEnv, type Region } from "./edit.js";
import { compileMaterial, type MaterialExpr } from "./material.js";

/**
 * Brushes (docs/design/05-operations.md, L2 "Edits & brushes"): hollow, paint, smooth / erode /
 * dilate, extrude, sweep and array. Each is one journal entry, auto-connects unless `raw`, and
 * registers `as` for the affected box. Coordinates are document-local; boxes are half-open.
 */

const DIRS6: Vec3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
export const NAMED_DIRS: Record<string, Vec3> = { up: [0, 1, 0], down: [0, -1, 0], north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0] };

const toMask = (r: Region) => (r instanceof Mask ? r : Mask.fromBox(r));
const label = (r: Region, l?: string) => l ?? (r instanceof Mask ? `sel ${r.count()} blocks in ${formatBox(regionBox(r))}` : formatBox(r));
const suffix = (o: CommonOptions) => (o.as ? ` as ${o.as}` : "");

export interface BrushOptions extends CommonOptions {
  label?: string;
}

/** hollow: keeps a shell `thickness` thick (optionally rewritten in `material`) and clears the inside to air. */
export function hollow(doc: Document, env: OpEnv, region: Region, thickness = 1, material?: MaterialExpr, opts: BrushOptions = {}): EditResult {
  checkRegion(region);
  const t = int(thickness, "thickness", 1);
  const m = toMask(region);
  const bb = regionBox(m);
  return opEdit(doc, env, "hollow", `hollow ${label(region, opts.label)} t=${t}${material !== undefined ? ` ${describeMaterial(material)}` : ""}${suffix(opts)}`, opts, (tx) => {
    const shell = shellOf(m, t, false);
    if (material !== undefined) {
      const mat = compileMaterial(material, materialContext(doc, env, tx, bb));
      shell.forEach((x, y, z) => tx.set(x, y, z, mat(x, y, z)));
    }
    m.forEach((x, y, z) => !shell.has(x, y, z) && tx.clear(x, y, z));
    registerAs(tx, opts, bb);
  });
}

/** paint: rewrites only exposed blocks (non-air with an air face neighbour), e.g. moss or weathering. `dirs` limits which faces count. */
export function paint(doc: Document, env: OpEnv, region: Region, material: MaterialExpr, opts: BrushOptions & { dirs?: string[] } = {}): EditResult {
  checkRegion(region);
  const dirs = (opts.dirs ?? Object.keys(NAMED_DIRS)).map((d) => {
    const v = NAMED_DIRS[d];
    if (!v) throw new Error(`unknown direction "${d}" (use up, down, north, south, east, west)`);
    return v;
  });
  const m = toMask(region);
  const bb = regionBox(m);
  return opEdit(doc, env, "paint", `paint ${label(region, opts.label)} ${describeMaterial(material)}${suffix(opts)}`, opts, (tx) => {
    const mat = compileMaterial(material, materialContext(doc, env, tx, bb));
    const hits: Vec3[] = [];
    m.forEach((x, y, z) => {
      if (tx.getId(x, y, z) === 0) return;
      if (dirs.some((d) => tx.getId(x + d[0], y + d[1], z + d[2]) === 0)) hits.push([x, y, z]);
    });
    for (const p of hits) tx.set(...p, mat(...p));
    registerAs(tx, opts, bb);
  });
}

export type MorphMode = "smooth" | "erode" | "dilate";

/**
 * Morphological cleanup over the solid blocks inside a selection, from a snapshot (one pass per
 * iteration):
 * - erode: a block with ≥ `threshold` air face neighbours (default 3) becomes air;
 * - dilate: air with ≥ `threshold` solid face neighbours (default 3) takes `material`, or the most
 *   common neighbouring block;
 * - smooth: majority over the 3×3×3 cube (solid when ≥ 14 of 27 are solid).
 */
export function morph(doc: Document, env: OpEnv, region: Region, mode: MorphMode, opts: BrushOptions & { threshold?: number; iterations?: number; material?: MaterialExpr } = {}): EditResult {
  checkRegion(region);
  if (!["smooth", "erode", "dilate"].includes(mode)) throw new Error('mode must be "smooth", "erode" or "dilate"');
  const threshold = int(opts.threshold ?? 3, "threshold", 1);
  if (threshold > 6) throw new Error("threshold counts face neighbours, so it must be 1–6");
  const iterations = int(opts.iterations ?? 1, "iterations", 1);
  if (iterations > 16) throw new Error("iterations must be at most 16");
  const m = toMask(region);
  const bb = regionBox(m);
  return opEdit(doc, env, mode, `${mode} ${label(region, opts.label)}${mode !== "smooth" ? ` t=${threshold}` : ""}${iterations > 1 ? ` ×${iterations}` : ""}${suffix(opts)}`, opts, (tx) => {
    const mat = opts.material !== undefined ? compileMaterial(opts.material, materialContext(doc, env, tx, bb)) : undefined;
    const pts = m.positions();
    for (let it = 0; it < iterations; it++) {
      const writes: [number, number, number, number][] = [];
      for (const [x, y, z] of pts) {
        const id = tx.getId(x, y, z);
        const nbrs = mode === "smooth" ? cube(tx.getId.bind(tx), x, y, z) : DIRS6.map((d) => tx.getId(x + d[0], y + d[1], z + d[2]));
        const solid = nbrs.filter((n) => n !== 0);
        if (mode === "erode" && id !== 0 && 6 - solid.length >= threshold) writes.push([x, y, z, 0]);
        else if (mode === "dilate" && id === 0 && solid.length >= threshold) writes.push([x, y, z, mat ? mat(x, y, z) : mostCommon(solid)]);
        else if (mode === "smooth") {
          const want = solid.length + (id !== 0 ? 1 : 0) >= 14;
          if (want && id === 0) writes.push([x, y, z, mat ? mat(x, y, z) : mostCommon(solid)]);
          else if (!want && id !== 0) writes.push([x, y, z, 0]);
        }
      }
      if (!writes.length) break;
      for (const [x, y, z, id] of writes) tx.set(x, y, z, id);
    }
    registerAs(tx, opts, bb);
  });
}

function cube(get: (x: number, y: number, z: number) => number, x: number, y: number, z: number): number[] {
  const out: number[] = [];
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) if (dx || dy || dz) out.push(get(x + dx, y + dy, z + dz));
  return out;
}

function mostCommon(ids: number[]): number {
  const c = new Map<number, number>();
  let best = ids[0] ?? 0, n = 0;
  for (const id of ids) {
    const k = (c.get(id) ?? 0) + 1;
    c.set(id, k);
    if (k > n || (k === n && id < best)) [best, n] = [id, k];
  }
  return best;
}

/**
 * extrude: pushes a face outward by `n` (copies each face block n times along `dir`) or inward
 * with a negative n (clears the face and the n-1 layers behind it). Without `dir`, the face's
 * open side is inferred: the direction in which most of its blocks touch air.
 */
export function extrude(doc: Document, env: OpEnv, region: Region, n: number, opts: BrushOptions & { dir?: string } = {}): EditResult {
  checkRegion(region);
  const steps = int(n, "n");
  if (steps === 0) throw new Error("n must be non-zero (positive pushes out, negative pushes in)");
  if (Math.abs(steps) > 256) throw new Error("n must be within ±256");
  const m = toMask(region);
  const solid = new Mask();
  m.forEach((x, y, z) => doc.getState(x, y, z) !== "minecraft:air" && solid.add(x, y, z));
  if (solid.isEmpty()) throw new Error("the face selection holds no blocks to extrude");
  let dirName = opts.dir;
  if (dirName === undefined) {
    let best = -1;
    for (const [name, d] of Object.entries(NAMED_DIRS)) {
      let k = 0;
      solid.forEach((x, y, z) => doc.getState(x + d[0], y + d[1], z + d[2]) === "minecraft:air" && k++);
      if (k > best) [best, dirName] = [k, name];
    }
  }
  const d = NAMED_DIRS[dirName!];
  if (!d) throw new Error(`unknown dir "${dirName}" (use up, down, north, south, east, west)`);
  return opEdit(doc, env, "extrude", `extrude ${label(region, opts.label)} ${steps > 0 ? "out" : "in"} ${Math.abs(steps)} ${dirName}${suffix(opts)}`, opts, (tx) => {
    let box: Box | undefined;
    const pts = solid.positions();
    const ids = pts.map((p) => tx.getId(...p));
    const nbt = pts.map((p) => doc.getBlockEntity(...p));
    pts.forEach((p, i) => {
      for (let k = steps > 0 ? 1 : 0; steps > 0 ? k <= steps : k < -steps; k++) {
        const s = steps > 0 ? k : -k;
        const q: Vec3 = [p[0] + d[0] * s, p[1] + d[1] * s, p[2] + d[2] * s];
        if (steps > 0) tx.set(...q, ids[i]!, nbt[i] ?? null);
        else tx.clear(...q);
        box = unionBox(box, { min: q, max: [q[0] + 1, q[1] + 1, q[2] + 1] });
      }
    });
    if (box) registerAs(tx, opts, box);
  });
}

export interface ProfileCell {
  /** Sideways offset, to the right of the direction of travel. */
  u: number;
  /** Height offset (up). */
  v: number;
  block: MaterialExpr;
}

/**
 * sweep: places a 2D cross-section along a 3D polyline (cornices, walls, roads, bridges). The
 * profile is authored for travel toward north (u = east, v = up); on each segment it turns with
 * the segment's main horizontal direction, and its block states turn with it (stairs, logs…).
 */
export function sweep(doc: Document, env: OpEnv, profile: ProfileCell[], path: Vec3[], opts: BrushOptions = {}): EditResult {
  if (!Array.isArray(profile) || profile.length === 0) throw new Error("profile needs at least one {u, v, block} cell");
  if (profile.length > 4096) throw new Error("profile may have at most 4096 cells");
  for (const c of profile) if (!Number.isInteger(c.u) || !Number.isInteger(c.v)) throw new Error(`profile cells need integer u and v (got ${JSON.stringify(c)})`);
  if (!Array.isArray(path) || path.length < 2) throw new Error("path needs at least two [x,y,z] points");
  for (const p of path) if (!Array.isArray(p) || p.length !== 3 || p.some((v) => !Number.isInteger(v))) throw new Error(`path points must be [x,y,z] integers (got ${JSON.stringify(p)})`);
  // Rasterise the path, recording each step's heading (0 = north, 1 = east, 2 = south, 3 = west).
  const steps: [Vec3, number][] = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i]!, b = path[i + 1]!;
    const dx = b[0] - a[0], dz = b[2] - a[2];
    const heading = Math.abs(dx) >= Math.abs(dz) ? (dx >= 0 ? (dx === 0 && dz === 0 ? 0 : 1) : 3) : dz > 0 ? 2 : 0;
    for (const p of line(a, b)) if (!steps.length || steps[steps.length - 1]![0].join() !== p.join()) steps.push([p, heading]);
  }
  if (steps.length * profile.length > 2_000_000) throw new Error("sweep would place over 2,000,000 blocks; shorten the path or the profile");
  const right: Vec3[] = [[1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 0, -1]];
  const turners = [0, 1, 2, 3].map((t) => stateTransformer({ turns: t }, { ...(env.registry ? { registry: env.registry } : {}), overrides: stateOverrides(env) }));
  return opEdit(doc, env, "sweep", `sweep ${profile.length}-cell profile along ${path.length} points ${formatVec(path[0]!)}→${formatVec(path[path.length - 1]!)}${suffix(opts)}`, opts, (tx) => {
    const ctx = materialContext(doc, env, tx);
    const mats = profile.map((c) => compileMaterial(c.block, ctx));
    let box: Box | undefined;
    for (const [p, h] of steps) {
      const r = right[h]!;
      profile.forEach((c, i) => {
        const q: Vec3 = [p[0] + r[0] * c.u, p[1] + c.v, p[2] + r[2] * c.u];
        const id = mats[i]!(...q);
        tx.set(...q, h ? tx.intern(turners[h]!(doc.states.get(id))) : id);
        box = unionBox(box, { min: q, max: [q[0] + 1, q[1] + 1, q[2] + 1] });
      });
    }
    if (box) registerAs(tx, opts, box);
  });
}

/** 3D Bresenham line from a to b, inclusive. */
export function line(a: Vec3, b: Vec3): Vec3[] {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const n = Math.max(...d.map(Math.abs));
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) out.push(n === 0 ? [...a] : [0, 1, 2].map((k) => a[k]! + Math.round((d[k]! * i) / n)) as Vec3);
  return out;
}

/** array: repeats a selection `count` times in total (the original plus count-1 copies), each shifted by `step` from the last. */
export function array(doc: Document, env: OpEnv, region: Region, step: Vec3, count: number, opts: BrushOptions & { skipAir?: boolean } = {}): EditResult {
  const n = int(count, "count", 2);
  if (n > 1024) throw new Error("count must be at most 1024");
  if (!Array.isArray(step) || step.length !== 3 || step.some((v) => !Number.isInteger(v)) || step.every((v) => v === 0)) throw new Error("step must be a non-zero [dx,dy,dz] of integers");
  const m = toMask(region);
  checkRegion(m);
  if (m.count() * (n - 1) > MAX_OP_VOLUME) throw new Error(`array would write ${(m.count() * (n - 1)).toLocaleString("en-US")} blocks; one op may touch at most ${MAX_OP_VOLUME.toLocaleString("en-US")}`);
  return opEdit(doc, env, "array", `array ${label(region, opts.label)} ×${n} step ${formatVec(step)}${suffix(opts)}`, opts, (tx) => {
    const pts = m.positions();
    const ids = pts.map((p) => tx.getId(...p));
    const nbt = pts.map((p) => doc.getBlockEntity(...p));
    const bb = regionBox(m);
    let box: Box = { min: [...bb.min], max: [...bb.max] };
    for (let i = 1; i < n; i++) {
      const o: Vec3 = [step[0] * i, step[1] * i, step[2] * i];
      pts.forEach((p, k) => {
        if (opts.skipAir && ids[k] === 0) return;
        tx.set(p[0] + o[0], p[1] + o[1], p[2] + o[2], ids[k]!, nbt[k] ?? null);
      });
      box = unionBox(box, { min: [bb.min[0] + o[0], bb.min[1] + o[1], bb.min[2] + o[2]], max: [bb.max[0] + o[0], bb.max[1] + o[1], bb.max[2] + o[2]] });
    }
    registerAs(tx, opts, box);
  });
}

function int(x: unknown, what: string, min?: number): number {
  if (typeof x !== "number" || !Number.isInteger(x)) throw new Error(`${what} must be a whole number`);
  if (min !== undefined && x < min) throw new Error(`${what} must be ≥ ${min}`);
  return x;
}

