import { Mask } from "../../core/mask.js";
import type { Vec3 } from "../../core/region.js";
import type { Document } from "../../document/document.js";
import { opEdit, type OpEnv, type Region } from "../edit.js";
import type { MaterialExpr } from "../material.js";
import { componentId, dirOf, footprintOf, Writer, shapeSet, type GenOptions, type GenResult } from "./shared.js";

/**
 * roof (docs/design/05-operations.md, Generators): a roof over any footprint (a selection's
 * projection, so round towers and L-shapes work), built from the material's stairs and slabs.
 *
 * Every footprint cell gets a distance d from the eave: hip and pyramid use the distance to the
 * nearest cell outside the footprint, gable the distance across the ridge axis only, shed the
 * distance from the low side. The surface height is a function of d in half blocks
 * (`pitch` blocks of rise per block of run), and each cell's top block follows the slope into
 * its inner neighbour: stairs facing up the slope where it rises a block or more per step, slabs
 * (bottom or top) where it rises half a block, full blocks under steep runs and on ridges.
 * Auto-connection then shapes the stair corners. `overhang` grows the footprint, lowering the
 * eaves so the roof still meets the wall top at the original edge.
 *
 * Styles: gable · hip · pyramid (hip; a point on square footprints) · shed · mansard (pitch 2 for
 * `break` steps, then `pitch`, default 0.5) · dome (a quarter-circle profile in full blocks) · flat
 * (one layer of slabs). A material without stairs or slabs falls back to full blocks, with a
 * warning (03, shape-aware resolution).
 */

export type RoofStyle = "gable" | "hip" | "pyramid" | "shed" | "mansard" | "dome" | "flat";

export interface RoofOptions extends GenOptions {
  style?: RoofStyle;
  /** Rise per block of run (default 1; 0.5 = slab roof; 2 = steep). */
  pitch?: number;
  /** Blocks the roof extends past the footprint (default 0). */
  overhang?: number;
  /** Ridge axis for gable (default: the longer side) and the axis a shed slopes across. */
  axis?: "x" | "z";
  /** Shed: the high side (default north). */
  high?: "north" | "south" | "east" | "west";
  /** Mansard: steps at the steep lower pitch (default a third of the depth, ≥ 1). */
  break?: number;
  /** y of the roof's lowest course at the original edge (default: one above the footprint). */
  base?: number;
  stairs?: MaterialExpr;
  slab?: MaterialExpr;
  /** Gable roofs: fill the gable ends under the roof (default true), in this material (default the roof's). */
  gables?: boolean | MaterialExpr;
}

const N4: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function roof(doc: Document, env: OpEnv, over: Region, material: MaterialExpr, opts: RoofOptions = {}): GenResult {
  const style = opts.style ?? "gable";
  if (!["gable", "hip", "pyramid", "shed", "mansard", "dome", "flat"].includes(style)) throw new Error(`unknown roof style "${style}" (gable, hip, pyramid, shed, mansard, dome, flat)`);
  const pitch = opts.pitch ?? (style === "mansard" ? 0.5 : 1);
  if (!(pitch > 0) || pitch > 8 || !Number.isInteger(pitch * 2)) throw new Error("pitch must be a multiple of 0.5 between 0.5 and 8");
  const overhang = opts.overhang ?? 0;
  if (!Number.isInteger(overhang) || overhang < 0 || overhang > 8) throw new Error("overhang must be a whole number 0..8");

  const src = over instanceof Mask ? over : Mask.fromBox(over);
  const fp = footprintOf(src);
  const top = opts.base ?? fp.box.max[1];
  // Grow the footprint by the overhang (square kernel, so corners stay square).
  let cells = fp.cells;
  for (let i = 0; i < overhang; i++) {
    const next = new Set(cells);
    for (const k of cells) {
      const [x, z] = k.split(",").map(Number) as [number, number];
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) next.add(`${x + dx},${z + dz}`);
    }
    cells = next;
  }
  if (cells.size > 250_000) throw new Error("roof footprint is over 250,000 cells; split it up");
  const xs = [...cells].map((k) => Number(k.split(",")[0])), zs = [...cells].map((k) => Number(k.split(",")[1]));
  const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
  const axis = opts.axis ?? (x1 - x0 >= z1 - z0 ? "x" : "z");
  const notes: string[] = [];
  let effective: RoofStyle = style;
  if (style === "pyramid" && x1 - x0 !== z1 - z0) notes.push("pyramid on a non-square footprint makes a hip roof");
  if (style === "pyramid") effective = "hip";

  const has = (x: number, z: number) => cells.has(`${x},${z}`);
  const dist = new Map<string, number>();
  const high = opts.high ?? "north";
  for (const k of cells) {
    const [x, z] = k.split(",").map(Number) as [number, number];
    dist.set(k, distance(effective, x, z, has, axis, high, cells));
  }
  const maxD = Math.max(...dist.values());
  const brk = opts.break ?? Math.max(1, Math.floor((maxD + 1) / 3));
  const H = (d: number): number => {
    if (d < 0) return -1;
    switch (effective) {
      case "flat":
        return 0;
      case "mansard":
        return d <= brk ? 4 * d : 4 * brk + Math.round(2 * pitch * (d - brk));
      case "dome": {
        const R = maxD + 1;
        return Math.round(2 * pitch * Math.sqrt(Math.max(0, R * R - (R - d - 1) ** 2)));
      }
      default:
        return Math.round(2 * pitch * d);
    }
  };
  // Eaves drop below the wall top so the roof meets it at the original edge.
  const base = top - Math.floor(H(overhang) / 2);

  const shapes = shapeSet(doc, env, material, { ...(opts.stairs !== undefined ? { stairs: opts.stairs } : {}), ...(opts.slab !== undefined ? { slab: opts.slab } : {}) }, "roof material");
  const useStairs = effective !== "dome" && effective !== "flat";
  const id = componentId(doc, opts, "roof");
  const gableMat = opts.gables === false ? undefined : opts.gables === undefined || opts.gables === true ? material : opts.gables;

  const r = opEdit(doc, env, "roof", `roof ${style} over ${fp.box.max[0] - fp.box.min[0]}×${fp.box.max[2] - fp.box.min[2]} as ${id}`, opts, (tx) => {
    const w = new Writer(doc, env, tx);
    const full = w.material(shapes.full);
    const stairs = shapes.stairs !== undefined && useStairs ? w.material(shapes.stairs, "stairs") : undefined;
    const slab = shapes.slab !== undefined ? w.material(shapes.slab, "slab") : undefined;
    for (const warn of shapes.warnings) if (effective !== "dome" && (useStairs || !/stairs/.test(warn))) tx.warn(warn); // domes use full blocks only
    for (const k of cells) {
      const [x, z] = k.split(",").map(Number) as [number, number];
      const d = dist.get(k)!;
      const hh = H(d), hPrev = H(d - 1), hNext = H(d + 1);
      const y = base + Math.floor(hh / 2), half = hh % 2;
      // Close steep runs: full blocks down to the outer neighbour's top.
      if (d > 0) for (let yy = base + Math.floor(hPrev / 2) + 1; yy < y; yy++) w.set([x, yy, z], full(x, yy, z));
      const inward = inner(effective, x, z, d, dist, axis, high);
      const p: Vec3 = [x, y, z];
      const slope = inward ? hNext - hh : 0;
      if (inward && slope >= 2 && useStairs) {
        w.set(p, stairs ? w.shaped(stairs, p, { facing: dirOf([inward[0], 0, inward[1]]), half: "bottom" }) : full(x, y, z));
      } else if (effective === "dome" || (!inward && hh - hPrev >= 2 && half === 0)) {
        w.set(p, full(x, y, z));
      } else {
        w.set(p, slab ? w.shaped(slab, p, { type: half ? "top" : "bottom" }) : full(x, y, z));
      }
    }
    // Gable ends: fill under the roof over the original footprint's two ends.
    if (effective === "gable" && gableMat !== undefined) {
      const g = w.material(gableMat);
      const ends = fp.box;
      for (const k of fp.cells) {
        const [x, z] = k.split(",").map(Number) as [number, number];
        const isEnd = axis === "x" ? x === ends.min[0] || x === ends.max[0] - 1 : z === ends.min[2] || z === ends.max[2] - 1;
        if (!isEnd) continue;
        const roofY = base + Math.floor(H(dist.get(k)!) / 2);
        for (let yy = top; yy < roofY; yy++) w.set([x, yy, z], g(x, yy, z));
      }
    }
    w.register(id, "roof", opts, { ridge: ridgePoint(dist, maxD, base + Math.floor(H(maxD) / 2)) });
  });
  notes.unshift(`${style} roof, pitch ${pitch}, eaves at y=${base}${overhang ? `, overhang ${overhang}` : ""}${effective === "gable" || effective === "shed" ? `, ridge along ${axis}` : ""}`);
  return { ...r, component: id, notes };
}

function distance(style: RoofStyle, x: number, z: number, has: (x: number, z: number) => boolean, axis: "x" | "z", high: string, cells: Set<string>): number {
  if (style === "gable") {
    // Across the ridge axis only.
    const [dx, dz] = axis === "x" ? [0, 1] : [1, 0];
    return Math.min(run(x, z, dx, dz, has), run(x, z, -dx, -dz, has));
  }
  if (style === "shed") {
    const v = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[high] as [number, number];
    return run(x, z, -v[0], -v[1], has); // distance from the low side
  }
  if (style === "flat") return 0;
  // hip / mansard / dome: Euclidean distance to the nearest outside cell, minus one.
  let best = Infinity;
  for (let r = 1; r < best + 1 && r < 512; r++) {
    for (let dx = -r; dx <= r; dx++)
      for (const dz of Math.abs(dx) === r ? range(-r, r) : [-r, r]) {
        if (!cells.has(`${x + dx},${z + dz}`)) best = Math.min(best, Math.hypot(dx, dz));
      }
    if (best <= r) break;
  }
  return Math.max(0, Math.floor(best - 1 + 1e-9));
}

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}

/** Cells from (x,z) to the footprint edge going (dx,dz): 0 on the edge. */
function run(x: number, z: number, dx: number, dz: number, has: (x: number, z: number) => boolean): number {
  let n = 0;
  while (has(x + dx * (n + 1), z + dz * (n + 1))) n++;
  return n;
}

/** The step toward the next cell up the slope, or undefined on a ridge or peak. */
function inner(style: RoofStyle, x: number, z: number, d: number, dist: Map<string, number>, axis: "x" | "z", high: string): [number, number] | undefined {
  const dirs: [number, number][] =
    style === "gable" ? (axis === "x" ? [[0, 1], [0, -1]] : [[1, 0], [-1, 0]]) : style === "shed" ? [({ north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] } as Record<string, [number, number]>)[high]!] : N4;
  for (const [dx, dz] of dirs) if ((dist.get(`${x + dx},${z + dz}`) ?? -1) > d) return [dx, dz];
  // Hip corners rise only diagonally: face along one axis and let auto-connection turn the corner.
  if (dirs === N4) for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) if ((dist.get(`${x + dx},${z + dz}`) ?? -1) > d) return [0, dz];
  return undefined;
}

function ridgePoint(dist: Map<string, number>, maxD: number, y: number): Vec3 {
  const pts = [...dist].filter(([, d]) => d === maxD).map(([k]) => k.split(",").map(Number) as [number, number]);
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const mid = pts[Math.floor(pts.length / 2)]!;
  return [mid[0], y, mid[1]];
}
