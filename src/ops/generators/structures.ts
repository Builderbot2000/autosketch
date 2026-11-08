import { Mask, shellOf } from "../../core/mask.js";
import type { Box, Vec3 } from "../../core/region.js";
import type { Document } from "../../document/document.js";
import type { AtSpec } from "../anchors.js";
import { line } from "../brush.js";
import { opEdit, type OpEnv } from "../edit.js";
import type { MaterialExpr } from "../material.js";
import { roof, type RoofStyle } from "./roof.js";
import { at, checkInt, componentId, growBox, Writer, type GenOptions, type GenResult } from "./shared.js";

/**
 * Larger generators (docs/design/05-operations.md, Generators): `wall_run` along a path and
 * `tower` (a polygon footprint plus a roof). A tower is one journal entry that groups its walls,
 * floors and roof (`Document.group`), and registers the roof as a child component.
 */

// -- wall_run ---------------------------------------------------------------------------------------

export interface WallRunOptions extends GenOptions {
  /** Polyline of points; y is the wall's base. Any at: form per point. */
  path: AtSpec[];
  height: number;
  /** Thickness, centred on the path (an even thickness leans right of travel). Default 1. */
  thickness?: number;
  /** Merlons along the top: every n-th block of the run gets one (default every 2). */
  crenellation?: boolean | { every?: number; height?: number; material?: MaterialExpr };
  /** Buttresses every n blocks along the run, stepping down as they leave the wall. */
  buttresses?: { every: number; depth?: number; side?: "left" | "right" | "both"; material?: MaterialExpr };
  /** A top course in another material (e.g. slabs or a wall block). */
  cap?: MaterialExpr;
  /**
   * How the path is read: polyline (default, straight segments), smooth (a Catmull-Rom curve
   * through every point) or bezier (the points are the control points of one Bézier curve; it
   * passes through the first and last).
   */
  curve?: "polyline" | "smooth" | "bezier";
}

type P3 = [number, number, number];

/** Samples a curve through (smooth) or controlled by (bezier) the points, densely enough for blocks. */
export function curvePoints(pts: Vec3[], curve: "smooth" | "bezier"): P3[] {
  const len = pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i]![0], p[1] - pts[i]![1], p[2] - pts[i]![2]), 0);
  const out: P3[] = [];
  if (curve === "bezier") {
    const n = Math.max(2, Math.ceil(len * 4));
    for (let k = 0; k <= n; k++) {
      // de Casteljau
      const t = k / n;
      let q: P3[] = pts.map((p) => [p[0], p[1], p[2]]);
      while (q.length > 1) q = q.slice(1).map((b, i) => [0, 1, 2].map((a) => q[i]![a]! * (1 - t) + b[a]! * t) as P3);
      out.push(q[0]!);
    }
    return out;
  }
  // Catmull-Rom (uniform), end points repeated so the curve starts and ends on them.
  const P = (i: number) => pts[Math.max(0, Math.min(pts.length - 1, i))]!;
  for (let i = 0; i + 1 < pts.length; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const n = Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]) * 4));
    for (let k = i === 0 ? 0 : 1; k <= n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      out.push([0, 1, 2].map((a) => 0.5 * (2 * p1[a]! + (-p0[a]! + p2[a]!) * t + (2 * p0[a]! - 5 * p1[a]! + 4 * p2[a]! - p3[a]!) * t2 + (-p0[a]! + 3 * p1[a]! - 3 * p2[a]! + p3[a]!) * t3)) as P3);
    }
  }
  return out;
}

/** The path as blocks in walking order, each with the right-hand vector of its local direction. */
function wallSteps(pts: Vec3[], curve: WallRunOptions["curve"]): { p: Vec3; right: Vec3 }[] {
  const steps: { p: Vec3; right: Vec3 }[] = [];
  const push = (a: Vec3, b: Vec3) => {
    const dx = b[0] - a[0], dz = b[2] - a[2];
    const fwd: Vec3 = Math.abs(dx) >= Math.abs(dz) ? [Math.sign(dx) || 1, 0, 0] : [0, 0, Math.sign(dz)];
    const right: Vec3 = [-fwd[2], 0, fwd[0]];
    for (const p of line(a, b)) if (!steps.length || steps[steps.length - 1]!.p.join() !== p.join()) steps.push({ p, right });
  };
  if (curve === undefined || curve === "polyline") {
    for (let i = 0; i + 1 < pts.length; i++) push(pts[i]!, pts[i + 1]!);
    return steps;
  }
  if (curve !== "smooth" && curve !== "bezier") throw new Error(`unknown curve "${curve}" (polyline, smooth, bezier)`);
  // Round the samples to blocks, drop repeats, then join neighbours with lines so there are no gaps.
  const blocks: Vec3[] = [];
  for (const q of curvePoints(pts, curve)) {
    const b: Vec3 = [Math.round(q[0]), Math.round(q[1]), Math.round(q[2])];
    if (!blocks.length || blocks[blocks.length - 1]!.join() !== b.join()) blocks.push(b);
  }
  if (blocks.length === 1) blocks.push(blocks[0]!);
  for (let i = 0; i + 1 < blocks.length; i++) {
    // The local direction looks a few blocks ahead, so thickness follows the curve, not each stair-step.
    const a = blocks[Math.max(0, i - 2)]!, b = blocks[Math.min(blocks.length - 1, i + 3)]!;
    const dx = b[0] - a[0], dz = b[2] - a[2];
    const fwd: Vec3 = Math.abs(dx) >= Math.abs(dz) ? [Math.sign(dx) || 1, 0, 0] : [0, 0, Math.sign(dz)];
    const right: Vec3 = [-fwd[2], 0, fwd[0]];
    for (const p of line(blocks[i]!, blocks[i + 1]!)) if (!steps.length || steps[steps.length - 1]!.p.join() !== p.join()) steps.push({ p, right });
  }
  return steps;
}

export function wallRun(doc: Document, env: OpEnv, material: MaterialExpr, opts: WallRunOptions): GenResult {
  const notes: string[] = [];
  if (!Array.isArray(opts.path) || opts.path.length < 2) throw new Error("path needs at least two points");
  const pts = opts.path.map((p, i) => at(doc, env, p, notes, `path[${i}]`));
  const height = checkInt(opts.height, "height", 1, 384);
  const t = checkInt(opts.thickness ?? 1, "thickness", 1, 16);
  // Rasterise in xz (y interpolated), recording each step's right-hand vector.
  const steps = wallSteps(pts, opts.curve);
  if (steps.length * t * height > 4_000_000) throw new Error("wall_run would place over 4,000,000 blocks; split it up");
  const cren = opts.crenellation === true ? {} : opts.crenellation || undefined;
  const every = cren ? checkInt(cren.every ?? 2, "crenellation.every", 2, 64) : 0;
  const id = componentId(doc, opts, "wall");
  const lo = -Math.floor((t - 1) / 2);
  const r = opEdit(doc, env, "wall_run", `wall_run ${steps.length} long ×${height} as ${id}`, opts, (tx) => {
    const W = new Writer(doc, env, tx);
    const m = W.material(material);
    const cap = opts.cap !== undefined ? W.material(opts.cap) : undefined;
    const merlon = cren?.material !== undefined ? W.material(cren.material) : m;
    const buttress = opts.buttresses?.material !== undefined ? W.material(opts.buttresses.material) : m;
    steps.forEach(({ p, right }, i) => {
      for (let o = lo; o < lo + t; o++)
        for (let y = 0; y < height; y++) {
          const q: Vec3 = [p[0] + right[0] * o, p[1] + y, p[2] + right[2] * o];
          W.set(q, (y === height - 1 && cap ? cap : m)(...q));
        }
      if (cren && i % every === 0)
        for (let o = lo; o < lo + t; o++)
          for (let y = 0; y < (cren.height ?? 1); y++) {
            const q: Vec3 = [p[0] + right[0] * o, p[1] + height + y, p[2] + right[2] * o];
            W.set(q, merlon(...q));
          }
      const b = opts.buttresses;
      if (b && i % checkInt(b.every, "buttresses.every", 2, 256) === 0) {
        const depth = checkInt(b.depth ?? 1, "buttresses.depth", 1, 8);
        const sides = b.side === "left" ? [-1] : b.side === "right" ? [1] : [-1, 1];
        for (const s of sides)
          for (let k = 1; k <= depth; k++) {
            const off = s > 0 ? lo + t - 1 + k : lo - k;
            const top = Math.max(1, height - 1 - (k - 1) * Math.max(1, Math.floor(height / (depth + 1))));
            for (let y = 0; y < top; y++) {
              const q: Vec3 = [p[0] + right[0] * off, p[1] + y, p[2] + right[2] * off];
              W.set(q, buttress(...q));
            }
          }
      }
    });
    W.register(id, "wall", opts, { start: pts[0]!, end: pts[pts.length - 1]! });
  });
  notes.unshift(`${steps.length} blocks of wall, ${height} high, ${t} thick${cren ? `, merlons every ${every}` : ""}`);
  return { ...r, component: id, notes };
}

// -- tower ------------------------------------------------------------------------------------------

export interface TowerOptions extends GenOptions {
  /** Centre of the base. */
  at: AtSpec;
  /** round (default) · square · a number of sides (regular polygon) · [[dx,dz],…] footprint points relative to at. */
  shape?: "round" | "square" | number | [number, number][];
  /** Radius (half-width for square); default 3. */
  radius?: number;
  /** Wall height (default 10). */
  height: number;
  /** Wall thickness (default 1); 0 = solid. */
  thickness?: number;
  /** Floor every n blocks (default none), in this material (default the wall's). */
  floors?: { every: number; material?: MaterialExpr };
  /** Roof: a style or options; false for none. Default a pyramid in the wall material. */
  roof?: false | RoofStyle | { style?: RoofStyle; material?: MaterialExpr; pitch?: number; overhang?: number; stairs?: MaterialExpr; slab?: MaterialExpr };
}

/** A tower footprint mask (one layer at y), as document-local cells. */
export function towerFootprint(centre: Vec3, shape: TowerOptions["shape"], radius: number): Mask {
  const m = new Mask();
  const [cx, y, cz] = centre;
  if (Array.isArray(shape)) {
    if (shape.length < 3) throw new Error("a footprint needs at least 3 points");
    const pts = shape.map(([dx, dz]) => [cx + dx, cz + dz] as [number, number]);
    const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
    for (let x = Math.min(...xs); x <= Math.max(...xs); x++) for (let z = Math.min(...zs); z <= Math.max(...zs); z++) if (inPolygon(x, z, pts) || onEdge(x, z, pts)) m.add(x, y, z);
    return m;
  }
  const s = shape ?? "round";
  for (let dx = -radius - 1; dx <= radius + 1; dx++)
    for (let dz = -radius - 1; dz <= radius + 1; dz++) {
      let inside: boolean;
      if (s === "round") inside = dx * dx + dz * dz <= (radius + 0.5) ** 2;
      else if (s === "square") inside = Math.abs(dx) <= radius && Math.abs(dz) <= radius;
      else if (typeof s === "number" && Number.isInteger(s) && s >= 3 && s <= 64) inside = inRegular(dx, dz, s, radius + 0.5);
      else throw new Error('shape must be "round", "square", a number of sides 3..64, or [[dx,dz],…] points');
      if (inside) m.add(cx + dx, y, cz + dz);
    }
  return m;
}

function inRegular(x: number, z: number, n: number, r: number): boolean {
  // Inside every edge of a regular n-gon with circumradius r, one vertex pointing north.
  const apothem = r * Math.cos(Math.PI / n);
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (2 * Math.PI * (i + 0.5)) / n;
    if (x * Math.cos(a) + z * Math.sin(a) > apothem + 1e-9) return false;
  }
  return true;
}

function inPolygon(x: number, z: number, pts: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i]!, [xj, zj] = pts[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function onEdge(x: number, z: number, pts: [number, number][]): boolean {
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, az] = pts[j]!, [bx, bz] = pts[i]!;
    const len2 = (bx - ax) ** 2 + (bz - az) ** 2;
    const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / len2)) : 0;
    if ((x - (ax + t * (bx - ax))) ** 2 + (z - (az + t * (bz - az))) ** 2 <= 0.25) return true;
  }
  return false;
}

export function tower(doc: Document, env: OpEnv, material: MaterialExpr, opts: TowerOptions): GenResult {
  const notes: string[] = [];
  const c = at(doc, env, opts.at, notes);
  const radius = checkInt(opts.radius ?? 3, "radius", 1, 64);
  const height = checkInt(opts.height, "height", 1, 384);
  const thickness = checkInt(opts.thickness ?? 1, "thickness", 0, 16);
  const fp = towerFootprint(c, opts.shape, radius);
  if (fp.isEmpty()) throw new Error("the tower footprint is empty");
  const id = componentId(doc, opts, "tower");
  const roofSpec = opts.roof === undefined ? { style: "pyramid" as RoofStyle } : opts.roof === false ? undefined : typeof opts.roof === "string" ? { style: opts.roof } : opts.roof;
  let roofResult: GenResult | undefined;
  const r = doc.group("tower", `tower r=${radius} h=${height} at ${c.join(",")} as ${id}`, () => {
    const walls = thickness === 0 ? fp : shellOf(fp, thickness, true);
    let box: Box | undefined;
    opEdit(doc, env, "tower", "tower walls", opts, (tx) => {
      const W = new Writer(doc, env, tx);
      const m = W.material(material);
      const floorM = opts.floors?.material !== undefined ? W.material(opts.floors.material) : m;
      const every = opts.floors ? checkInt(opts.floors.every, "floors.every", 2, 64) : 0;
      for (let y = 0; y < height; y++) {
        const isFloor = every > 0 && y % every === 0;
        (isFloor ? fp : walls).forEach((x, _y, z) => {
          const p: Vec3 = [x, c[1] + y, z];
          W.set(p, (isFloor && !walls.has(x, _y, z) ? floorM : m)(...p));
        });
      }
      box = W.box;
      W.register(id, "tower", opts, { base: c, top: [c[0], c[1] + height, c[2]] });
    });
    if (roofSpec) {
      const over = new Mask();
      fp.forEach((x, _y, z) => over.add(x, c[1] + height - 1, z));
      roofResult = roof(doc, env, over, roofSpec.material ?? material, {
        style: roofSpec.style ?? "pyramid",
        ...("pitch" in roofSpec && roofSpec.pitch !== undefined ? { pitch: roofSpec.pitch } : {}),
        ...("overhang" in roofSpec && roofSpec.overhang !== undefined ? { overhang: roofSpec.overhang } : {}),
        ...("stairs" in roofSpec && roofSpec.stairs !== undefined ? { stairs: roofSpec.stairs } : {}),
        ...("slab" in roofSpec && roofSpec.slab !== undefined ? { slab: roofSpec.slab } : {}),
        as: `${id}_roof`,
        parent: id,
        ...(opts.raw ? { raw: true } : {}),
      });
      // Grow the tower's own box over its roof so moves and selections carry both.
      const rb = doc.componentLocal(`${id}_roof`)!.box;
      let b = box!;
      b = growBox(growBox(b, rb.min), [rb.max[0] - 1, rb.max[1] - 1, rb.max[2] - 1]);
      doc.edit("tower", "tower box", (tx) => {
        const t = doc.componentLocal(id)!;
        tx.setComponent({ id, kind: t.kind ?? "tower", box: b, anchors: { ...t.anchors, top: [c[0], rb.max[1], c[2]] } });
      });
    }
  });
  notes.unshift(`${typeof opts.shape === "number" ? `${opts.shape}-sided` : Array.isArray(opts.shape) ? "polygon" : opts.shape ?? "round"} tower r=${radius}, ${height} high${roofSpec ? `, ${roofSpec.style ?? "pyramid"} roof (component ${id}_roof)` : ""}`);
  if (roofResult) notes.push(...roofResult.notes.slice(1));
  return { ...r, component: id, notes };
}
