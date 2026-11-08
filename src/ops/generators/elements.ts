import type { Vec3 } from "../../core/region.js";
import type { Document } from "../../document/document.js";
import type { AtSpec } from "../anchors.js";
import { opEdit, type OpEnv } from "../edit.js";
import type { MaterialExpr } from "../material.js";
import { at, checkInt, componentId, DIRS, Writer, shapeSet, type Dir, type GenOptions, type GenResult } from "./shared.js";

/**
 * Small architectural generators (docs/design/05-operations.md, Generators): arch, staircase and
 * column. Positions take any `at:` form (05, Anchors).
 */

// -- arch -------------------------------------------------------------------------------------------

export type ArchStyle = "round" | "pointed" | "segmental" | "flat";

export interface ArchOptions extends GenOptions {
  /** Bottom centre of the opening (for even widths, the centre column toward min). */
  at: AtSpec;
  /** Opening width in blocks. */
  width: number;
  /** Opening height at the crown, from `at` (default: width/2 + 2 for round arches). */
  height?: number;
  /** Axis the arch spans along (the wall's direction), default x. */
  axis?: "x" | "z";
  style?: ArchStyle;
  /** Ring (voussoir) thickness, default 1. */
  ring?: number;
  /** Thickness through the wall, default 1. */
  depth?: number;
  /** Also fill the jambs from the floor to the springing line (default false). */
  jambs?: boolean;
  /** Clear the opening to air (default true). */
  clear?: boolean;
}

/** Height of the opening's top at offset u from the centre line (cell centres). */
function archTop(style: ArchStyle, u: number, w: number, h: number): number {
  const r = w / 2;
  switch (style) {
    case "flat":
      return h;
    case "round":
      return h - r + Math.sqrt(Math.max(0, r * r - u * u));
    case "segmental": {
      const rise = Math.max(1, w / 4), R = (r * r + rise * rise) / (2 * rise);
      return h - rise + (Math.sqrt(Math.max(0, R * R - u * u)) - (R - rise));
    }
    case "pointed": {
      // Two arcs of radius w centred on the opposite springing points.
      const crown = Math.sqrt(w * w - r * r);
      return h - crown + Math.sqrt(Math.max(0, w * w - (Math.abs(u) + r) ** 2));
    }
  }
}

export function arch(doc: Document, env: OpEnv, material: MaterialExpr, opts: ArchOptions): GenResult {
  const notes: string[] = [];
  const w = checkInt(opts.width, "width", 1, 64);
  const style = opts.style ?? "round";
  if (!["round", "pointed", "segmental", "flat"].includes(style)) throw new Error(`unknown arch style "${style}" (round, pointed, segmental, flat)`);
  const h = opts.height ?? Math.ceil(w / 2) + 2;
  checkInt(h, "height", 1, 128);
  const ring = checkInt(opts.ring ?? 1, "ring", 1, 8);
  const depth = checkInt(opts.depth ?? 1, "depth", 1, 16);
  const axis = opts.axis ?? "x";
  const base = at(doc, env, opts.at, notes);
  const ua: Vec3 = axis === "x" ? [1, 0, 0] : [0, 0, 1], na: Vec3 = axis === "x" ? [0, 0, 1] : [1, 0, 0];
  const left = -Math.floor((w - 1) / 2);
  const centre = (w - 1) / 2;
  const opening = (i: number, y: number) => i >= 0 && i < w && y >= 0 && y + 0.5 <= archTop(style, i - centre, w, h);
  const springing = style === "flat" ? h : Math.floor(h - (style === "pointed" ? Math.sqrt(w * w - (w / 2) ** 2) : style === "segmental" ? Math.max(1, w / 4) : w / 2));
  const id = componentId(doc, opts, "arch");
  const r = opEdit(doc, env, "arch", `arch ${style} ${w}×${h} at ${base.join(",")} as ${id}`, opts, (tx) => {
    const W = new Writer(doc, env, tx);
    const m = W.material(material);
    for (let i = -ring; i < w + ring; i++)
      for (let y = 0; y < h + ring + 1; y++) {
        const open = opening(i, y);
        let near = false;
        if (!open) for (let di = -ring; di <= ring && !near; di++) for (let dy = -ring; dy <= ring && !near; dy++) if (opening(i + di, y + dy)) near = true;
        const isRing = !open && near && (y >= springing || opts.jambs === true);
        if (!open && !isRing) continue;
        for (let k = 0; k < depth; k++) {
          const o = left + i;
          const p: Vec3 = [base[0] + ua[0] * o + na[0] * k, base[1] + y, base[2] + ua[2] * o + na[2] * k];
          if (isRing) W.set(p, m(...p));
          else if (opts.clear !== false) W.clear(p);
        }
      }
    W.register(id, "arch", opts, { base, crown: [base[0] + ua[0] * (left + Math.floor(centre)), base[1] + h, base[2] + ua[2] * (left + Math.floor(centre))] });
  });
  notes.unshift(`${style} arch, opening ${w} wide × ${h} high, springing at y=${base[1] + springing}`);
  return { ...r, component: id, notes };
}

// -- staircase --------------------------------------------------------------------------------------

export interface StaircaseOptions extends GenOptions {
  /** The first (lowest) step. */
  from: AtSpec;
  /** Direction of climb. */
  dir?: Dir;
  /** Number of steps (rise). */
  height?: number;
  /** The top step instead of dir + height: must be a straight 45° climb. */
  to?: AtSpec;
  /** Steps wide, extending to the right of the climb (default 1). */
  width?: number;
  stairs?: MaterialExpr;
  /** What fills under the steps: solid (default), none. */
  support?: "solid" | "none";
}

export function staircase(doc: Document, env: OpEnv, material: MaterialExpr, opts: StaircaseOptions): GenResult {
  const notes: string[] = [];
  const from = at(doc, env, opts.from, notes, "from");
  let dir = opts.dir;
  let n = opts.height;
  if (opts.to !== undefined) {
    const to = at(doc, env, opts.to, notes, "to");
    const d: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    const run = Math.abs(d[0]) + Math.abs(d[2]);
    if ((d[0] !== 0 && d[2] !== 0) || run !== d[1] || d[1] <= 0) throw new Error(`to must be straight up a 45° run from from: same x or z and as many blocks across as up (from ${from.join(",")} to ${to.join(",")})`);
    dir = d[0] > 0 ? "east" : d[0] < 0 ? "west" : d[2] > 0 ? "south" : "north";
    n = d[1] + 1;
  }
  if (!dir || !(dir in DIRS)) throw new Error("give dir (north, south, east, west) and height, or to");
  checkInt(n, "height", 1, 256);
  const width = checkInt(opts.width ?? 1, "width", 1, 32);
  const shapes = shapeSet(doc, env, material, opts.stairs !== undefined ? { stairs: opts.stairs } : {}, "staircase material");
  const fwd = DIRS[dir], right: Vec3 = [-fwd[2], 0, fwd[0]];
  const id = componentId(doc, opts, "staircase");
  const r = opEdit(doc, env, "staircase", `staircase ${n} steps ${dir} from ${from.join(",")} as ${id}`, opts, (tx) => {
    const W = new Writer(doc, env, tx);
    const full = W.material(shapes.full);
    const st = shapes.stairs !== undefined ? W.material(shapes.stairs, "stairs") : undefined;
    for (const wn of shapes.warnings) if (/stairs/.test(wn)) tx.warn(wn);
    for (let k = 0; k < n!; k++)
      for (let j = 0; j < width; j++) {
        const p: Vec3 = [from[0] + fwd[0] * k + right[0] * j, from[1] + k, from[2] + fwd[2] * k + right[2] * j];
        W.set(p, st ? W.shaped(st, p, { facing: dir!, half: "bottom" }) : full(...p));
        if (opts.support !== "none") for (let y = from[1]; y < p[1]; y++) W.set([p[0], y, p[2]], full(p[0], y, p[2]));
      }
    const top: Vec3 = [from[0] + fwd[0] * (n! - 1), from[1] + n! - 1, from[2] + fwd[2] * (n! - 1)];
    W.register(id, "staircase", opts, { bottom: from, top, landing: [top[0] + fwd[0], top[1] + 1, top[2] + fwd[2]] });
  });
  notes.unshift(`${n} steps climbing ${dir}, ${width} wide`);
  return { ...r, component: id, notes };
}

// -- column -----------------------------------------------------------------------------------------

export interface ColumnOptions extends GenOptions {
  /** Base of the shaft (its lowest block). */
  at: AtSpec;
  height: number;
  /** 0 = one block (default); 1 = 3×3 round; larger = round with that radius. */
  radius?: number;
  /** Block or material for the lowest layer, and for the top layer. */
  base?: MaterialExpr;
  capital?: MaterialExpr;
}

export function column(doc: Document, env: OpEnv, material: MaterialExpr, opts: ColumnOptions): GenResult {
  const notes: string[] = [];
  const p0 = at(doc, env, opts.at, notes);
  const h = checkInt(opts.height, "height", 1, 384);
  const r = checkInt(opts.radius ?? 0, "radius", 0, 16);
  const id = componentId(doc, opts, "column");
  const res = opEdit(doc, env, "column", `column ${h} high r=${r} at ${p0.join(",")} as ${id}`, opts, (tx) => {
    const W = new Writer(doc, env, tx);
    const shaft = W.material(material);
    const baseM = opts.base !== undefined ? W.material(opts.base) : undefined;
    const capM = opts.capital !== undefined ? W.material(opts.capital) : undefined;
    const rr = (r + 0.5) ** 2;
    for (let y = 0; y < h; y++)
      for (let dx = -r; dx <= r; dx++)
        for (let dz = -r; dz <= r; dz++) {
          if (dx * dx + dz * dz > rr) continue;
          const p: Vec3 = [p0[0] + dx, p0[1] + y, p0[2] + dz];
          const m = y === 0 && baseM ? baseM : y === h - 1 && capM ? capM : shaft;
          W.set(p, m(...p));
        }
    W.register(id, "column", opts, { base: p0, top: [p0[0], p0[1] + h, p0[2]] });
  });
  return { ...res, component: id, notes };
}
