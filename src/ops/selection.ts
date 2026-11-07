import type { Registry } from "../assets/registry.js";
import { stateId } from "../core/blockstate.js";
import { Mask, shellOf } from "../core/mask.js";
import { boxVolume, formatBox, fromPublic, intersectBox, isEmptyBox, type Box, type PublicBox, type Vec3 } from "../core/region.js";
import type { Document } from "../document/document.js";
import type { PaletteIndex } from "../palette/index.js";
import { blockMatcher, MAX_OP_VOLUME } from "./edit.js";

/**
 * Selections (docs/design/05-operations.md, L1): JSON expressions an agent sends with a tool call,
 * resolved against the document into a voxel mask when an op uses them. Named selections stay
 * expressions, so `connected`/`similar`/`filter` follow later edits.
 *
 * Shapes      {"min":[..],"max":[..]} (box shorthand) · {"box":{min,max}} · "all" (document bounds)
 *             {"cylinder":{center,radius,height,axis?}} · {"sphere":{center,radius}} · {"ellipsoid":{center,radii}}
 *             {"polygon":{points:[[x,z],..],y:[y0,y1]}} · {"plane":{axis,at,within?}} · {"component":"id"}
 * Picking     {"connected":{seed,match?,connectivity?,within?}} · {"similar":{seed,by?,within?}}
 * References  "<name>" (a named selection) · "last" (the most recent selection)
 * Booleans    {"union":[a,b,..]} · {"intersect":[a,b,..]} · {"subtract":[a,b,..]} · {"xor":[a,b]} · {"invert":a,"within"?:b}
 * Modifiers   {"expand":a,"by":n|[dx,dy,dz]|{up,down,north,south,east,west}} · {"contract":a,"by":..}
 *             {"offset":a,"by":[dx,dy,dz]} · {"shell":a,"thickness"?,"walls_only"?} · {"layer":a,"y":n|"min"|"max"}
 *             {"surface":a} · {"bbox":a} · {"filter":a,"block"?:"..","air"?:bool}
 */

export type SelExpr = string | { [k: string]: unknown };

export interface SelContext {
  doc: Document;
  registry?: Registry;
  index?: PaletteIndex;
}

export interface Resolved {
  mask: Mask;
  notes: string[];
}

const MAX_DEPTH = 32;
const DIRS6: Vec3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const NAMED_DIRS: Record<string, Vec3> = { up: [0, 1, 0], down: [0, -1, 0], north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0] };

export const SELECTION_NAME = /^[a-z][a-z0-9_.-]{0,63}$/i;
const RESERVED = new Set(["all", "last"]);

export function checkSelectionName(name: string): void {
  if (!SELECTION_NAME.test(name)) throw new Error(`selection name must start with a letter and use letters, digits, _ . or - (got "${name}")`);
  if (RESERVED.has(name)) throw new Error(`"${name}" is reserved`);
}

/** Resolves a selection expression to a mask of document-local positions. */
export function resolveSelection(expr: SelExpr, ctx: SelContext): Resolved {
  const notes: string[] = [];
  const mask = evaluate(expr, ctx, notes, 0, []);
  return { mask, notes };
}

function evaluate(e: SelExpr, ctx: SelContext, notes: string[], depth: number, names: string[]): Mask {
  if (depth > MAX_DEPTH) throw new Error("selection nests too deeply");
  const ev = (x: unknown) => evaluate(asExpr(x), ctx, notes, depth + 1, names);
  const doc = ctx.doc;

  if (typeof e === "string") {
    if (e === "all") {
      const b = doc.localBounds();
      return b ? fromBoxChecked(b) : new Mask();
    }
    if (e === "last") {
      if (!doc.lastSelection) throw new Error('no selection has been used yet, so "last" is undefined');
      return evaluate(doc.lastSelection, ctx, notes, depth + 1, names);
    }
    const named = doc.selections.get(e);
    if (!named) throw new Error(`no selection named "${e}"${doc.selections.size ? ` (have: ${[...doc.selections.keys()].join(", ")})` : ""}; strings must be "all", "last" or a selection name`);
    if (names.includes(e)) throw new Error(`selection "${e}" refers to itself (${[...names, e].join(" → ")})`);
    return evaluate(named, ctx, notes, depth + 1, [...names, e]);
  }
  if (!e || typeof e !== "object" || Array.isArray(e)) throw new Error(`bad selection ${JSON.stringify(e)}`);

  // Box shorthand {min, max}.
  if ("min" in e && "max" in e) return fromBoxChecked(publicBox(e, "box"));
  const op = Object.keys(e).find((k) => k in BUILDERS);
  if (!op) throw new Error(`unknown selection ${JSON.stringify(e).slice(0, 80)}; expected one of: ${Object.keys(BUILDERS).join(", ")} (or {min,max})`);
  return BUILDERS[op]!(e, { ctx, notes, ev, doc });
}

interface BuildEnv {
  ctx: SelContext;
  notes: string[];
  ev: (x: unknown) => Mask;
  doc: Document;
}

const BUILDERS: Record<string, (e: Record<string, unknown>, b: BuildEnv) => Mask> = {
  box: (e) => fromBoxChecked(publicBox(e.box, "box")),

  cylinder: (e) => {
    const c = obj(e.cylinder, "cylinder");
    const center = vec(c.center, "cylinder.center", false);
    const r = num(c.radius, "cylinder.radius", 0);
    const h = int(c.height ?? 1, "cylinder.height", 1);
    const axis = (c.axis ?? "y") as "x" | "y" | "z";
    if (!["x", "y", "z"].includes(axis)) throw new Error('cylinder.axis must be "x", "y" or "z"');
    const a = "xyz".indexOf(axis), [u, v] = [0, 1, 2].filter((i) => i !== a) as [number, number];
    const rr = (r + 0.5) ** 2;
    const lo = center.map((cv) => Math.floor(cv - r - 0.5)) as Vec3, hi = center.map((cv) => Math.ceil(cv + r + 0.5)) as Vec3;
    const base = Math.floor(center[a]!);
    lo[a] = base;
    hi[a] = base + h;
    checkBox({ min: lo, max: hi }, "cylinder");
    const m = new Mask();
    const p: Vec3 = [0, 0, 0];
    for (p[0] = lo[0]; p[0] < hi[0]; p[0]++)
      for (p[1] = lo[1]; p[1] < hi[1]; p[1]++)
        for (p[2] = lo[2]; p[2] < hi[2]; p[2]++) {
          const du = p[u]! - center[u]!, dv = p[v]! - center[v]!;
          if (du * du + dv * dv <= rr) m.add(p[0], p[1], p[2]);
        }
    return m;
  },

  sphere: (e) => {
    const s = obj(e.sphere, "sphere");
    const r = num(s.radius, "sphere.radius", 0);
    return ellipsoid(vec(s.center, "sphere.center", false), [r, r, r]);
  },

  ellipsoid: (e) => {
    const s = obj(e.ellipsoid, "ellipsoid");
    const radii = vec(s.radii, "ellipsoid.radii", false);
    if (radii.some((r) => r < 0)) throw new Error("ellipsoid.radii must be ≥ 0");
    return ellipsoid(vec(s.center, "ellipsoid.center", false), radii);
  },

  polygon: (e) => {
    const p = obj(e.polygon, "polygon");
    if (!Array.isArray(p.points) || p.points.length < 3) throw new Error("polygon.points needs at least 3 [x,z] points");
    const pts = p.points.map((q, i) => {
      if (!Array.isArray(q) || q.length !== 2 || q.some((n) => typeof n !== "number")) throw new Error(`polygon.points[${i}] must be [x,z]`);
      return q as [number, number];
    });
    const ys = Array.isArray(p.y) ? (p.y as number[]) : [num(p.y ?? 0, "polygon.y")];
    const y0 = Math.min(...ys), y1 = Math.max(...ys);
    const xs = pts.map((q) => q[0]), zs = pts.map((q) => q[1]);
    const box: Box = { min: [Math.floor(Math.min(...xs)), y0, Math.floor(Math.min(...zs))], max: [Math.ceil(Math.max(...xs)) + 1, y1 + 1, Math.ceil(Math.max(...zs)) + 1] };
    checkBox(box, "polygon");
    const m = new Mask();
    for (let x = box.min[0]; x < box.max[0]; x++)
      for (let z = box.min[2]; z < box.max[2]; z++) {
        if (!inPolygon(x, z, pts)) continue;
        for (let y = y0; y <= y1; y++) m.add(x, y, z);
      }
    return m;
  },

  plane: (e, b) => {
    const p = obj(e.plane, "plane");
    const axis = p.axis as string;
    if (!["x", "y", "z"].includes(axis)) throw new Error('plane.axis must be "x", "y" or "z"');
    const at = int(p.at, "plane.at");
    const within = p.within !== undefined ? b.ev(p.within).bbox() : b.doc.localBounds();
    if (!within) return new Mask();
    const a = "xyz".indexOf(axis);
    const box: Box = { min: [...within.min], max: [...within.max] };
    box.min[a] = at;
    box.max[a] = at + 1;
    return fromBoxChecked(box);
  },

  component: (e, b) => {
    const id = e.component;
    if (typeof id !== "string") throw new Error('component must be a component id, e.g. {"component":"keep"}');
    const c = b.doc.componentLocal(id);
    if (!c) throw new Error(`no component "${id}"${b.doc.components.size ? ` (have: ${[...b.doc.components.keys()].join(", ")})` : ""}`);
    return fromBoxChecked(c.box);
  },

  connected: (e, b) => {
    const c = obj(e.connected, "connected");
    const seed = vec(c.seed, "connected.seed");
    const match = (c.match ?? "block") as string;
    const conn = (c.connectivity ?? 6) as number;
    if (![6, 18, 26].includes(conn)) throw new Error("connected.connectivity must be 6, 18 or 26");
    const within = withinBox(c.within, b);
    const doc = b.doc;
    const seedState = doc.getState(...seed);
    const test = sameAs(match, seedState, b.ctx);
    const m = new Mask();
    if (!within || !inside(within, seed) || !test(seedState)) {
      b.notes.push(`connected: the seed ${fmt(seed)} is ${seedState === "minecraft:air" ? "air" : seedState}, which doesn't match "${match}"; nothing selected`);
      return m;
    }
    const nbrs: Vec3[] = [];
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const n = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
          if (n === 0 || (conn === 6 && n > 1) || (conn === 18 && n > 2)) continue;
          nbrs.push([dx, dy, dz]);
        }
    if (seedState === "minecraft:air" && c.match === undefined) b.notes.push(`connected: the seed ${fmt(seed)} is air, so this selects the connected air (pass match:"solid" to require a block)`);
    const stack: Vec3[] = [seed];
    m.add(...seed);
    let n = 1;
    while (stack.length) {
      const [x, y, z] = stack.pop()!;
      for (const d of nbrs) {
        const q: Vec3 = [x + d[0], y + d[1], z + d[2]];
        if (!inside(within, q) || m.has(...q) || !test(doc.getState(...q))) continue;
        m.add(...q);
        if (++n > MAX_OP_VOLUME) throw new Error(`connected selection passed ${MAX_OP_VOLUME.toLocaleString("en-US")} blocks; limit it with within`);
        stack.push(q);
      }
    }
    return m;
  },

  similar: (e, b) => {
    const c = obj(e.similar, "similar");
    const seed = vec(c.seed, "similar.seed");
    const by = (c.by ?? "block") as string;
    const seedState = b.doc.getState(...seed);
    const test = sameAs(by, seedState, b.ctx);
    const within = withinBox(c.within, b);
    const m = new Mask();
    if (!within) return m;
    const air = seedState === "minecraft:air";
    if (air) {
      checkBox(within, "similar (air)");
      for (let y = within.min[1]; y < within.max[1]; y++) for (let z = within.min[2]; z < within.max[2]; z++) for (let x = within.min[0]; x < within.max[0]; x++) if (test(b.doc.getState(x, y, z))) m.add(x, y, z);
      return m;
    }
    const doc = b.doc;
    doc.voxels.forEachInBox(doc.boxToStore(within), (sx, sy, sz, id) => {
      if (test(doc.states.get(id))) m.add(...doc.toLocal(sx, sy, sz));
    });
    return m;
  },

  union: (e, b) => list(e.union, "union", 1).reduce<Mask>((acc, x) => acc.unionWith(b.ev(x)), new Mask()),
  intersect: (e, b) => {
    const [first, ...rest] = list(e.intersect, "intersect", 2);
    return rest.reduce<Mask>((acc, x) => acc.intersectWith(b.ev(x)), b.ev(first));
  },
  subtract: (e, b) => {
    const [first, ...rest] = list(e.subtract, "subtract", 2);
    return rest.reduce<Mask>((acc, x) => acc.subtract(b.ev(x)), b.ev(first));
  },
  xor: (e, b) => {
    const [a, c] = list(e.xor, "xor", 2);
    return b.ev(a).xorWith(b.ev(c));
  },
  invert: (e, b) => {
    const within = e.within !== undefined ? b.ev(e.within) : (() => {
      const lb = b.doc.localBounds();
      return lb ? fromBoxChecked(lb) : new Mask();
    })();
    return within.subtract(b.ev(e.invert));
  },

  expand: (e, b) => morph(b.ev(e.expand), parseBy(e.by ?? 1, "expand.by"), "dilate"),
  contract: (e, b) => morph(b.ev(e.contract), parseBy(e.by ?? 1, "contract.by"), "erode"),

  offset: (e, b) => b.ev(e.offset).translated(vec(e.by, "offset.by")),

  shell: (e, b) => {
    const m = b.ev(e.shell);
    const t = int(e.thickness ?? 1, "shell.thickness", 1);
    return shellOf(m, t, e.walls_only === true);
  },

  layer: (e, b) => {
    const m = b.ev(e.layer);
    const bb = m.bbox();
    if (!bb) return m;
    const y = e.y === "min" || e.y === undefined ? bb.min[1] : e.y === "max" ? bb.max[1] - 1 : int(e.y, "layer.y");
    const out = new Mask();
    m.forEach((x, yy, z) => yy === y && out.add(x, yy, z));
    return out;
  },

  surface: (e, b) => {
    const m = b.ev(e.surface);
    const doc = b.doc;
    const out = new Mask();
    m.forEach((x, y, z) => {
      if (doc.getState(x, y, z) === "minecraft:air") return;
      if (DIRS6.some((d) => doc.getState(x + d[0], y + d[1], z + d[2]) === "minecraft:air")) out.add(x, y, z);
    });
    return out;
  },

  bbox: (e, b) => {
    const bb = b.ev(e.bbox).bbox();
    return bb ? fromBoxChecked(bb) : new Mask();
  },

  filter: (e, b) => {
    const m = b.ev(e.filter);
    const doc = b.doc;
    const match = typeof e.block === "string" ? blockMatcher(e.block, b.ctx.registry) : undefined;
    const air = e.air;
    if (air !== undefined && typeof air !== "boolean") throw new Error("filter.air must be true or false");
    if (!match && air === undefined) throw new Error('filter needs "block" (e.g. "oak_planks", "#minecraft:logs", "*") and/or "air": true|false');
    const out = new Mask();
    m.forEach((x, y, z) => {
      const st = doc.getState(x, y, z);
      const isAir = st === "minecraft:air";
      if (air !== undefined && isAir !== air) return;
      if (match && !match(st)) return;
      out.add(x, y, z);
    });
    return out;
  },
};

// -- helpers --------------------------------------------------------------------------------------

function asExpr(x: unknown): SelExpr {
  if (typeof x === "string" || (x && typeof x === "object" && !Array.isArray(x))) return x as SelExpr;
  throw new Error(`bad selection ${JSON.stringify(x)}`);
}

function obj(x: unknown, what: string): Record<string, unknown> {
  if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error(`${what} must be an object`);
  return x as Record<string, unknown>;
}

function list(x: unknown, what: string, min: number): unknown[] {
  if (!Array.isArray(x) || x.length < min) throw new Error(`${what} takes a list of at least ${min} selection${min > 1 ? "s" : ""}`);
  return x;
}

function num(x: unknown, what: string, min?: number): number {
  if (typeof x !== "number" || !Number.isFinite(x)) throw new Error(`${what} must be a number`);
  if (min !== undefined && x < min) throw new Error(`${what} must be ≥ ${min}`);
  return x;
}

function int(x: unknown, what: string, min?: number): number {
  const n = num(x, what, min);
  if (!Number.isInteger(n)) throw new Error(`${what} must be a whole number`);
  return n;
}

function vec(x: unknown, what: string, integer = true): Vec3 {
  if (!Array.isArray(x) || x.length !== 3 || x.some((n) => typeof n !== "number" || !Number.isFinite(n) || (integer && !Number.isInteger(n))))
    throw new Error(`${what} must be [x,y,z]${integer ? " integers" : ""}`);
  return x as Vec3;
}

function publicBox(x: unknown, what: string): Box {
  const o = obj(x, what);
  return fromPublic({ min: vec(o.min, `${what}.min`), max: vec(o.max, `${what}.max`) } as PublicBox);
}

function checkBox(b: Box, what: string): void {
  const v = boxVolume(b);
  if (v > MAX_OP_VOLUME) throw new Error(`${what} spans ${formatBox(b)} = ${v.toLocaleString("en-US")} blocks; a selection may cover at most ${MAX_OP_VOLUME.toLocaleString("en-US")}`);
}

function fromBoxChecked(b: Box): Mask {
  if (isEmptyBox(b)) return new Mask();
  checkBox(b, "selection");
  return Mask.fromBox(b);
}

function inside(b: Box, p: Vec3): boolean {
  return p[0] >= b.min[0] && p[0] < b.max[0] && p[1] >= b.min[1] && p[1] < b.max[1] && p[2] >= b.min[2] && p[2] < b.max[2];
}

/** Box limiting a pick: `within` if given (its bounding box), else the document bounds grown by one. */
function withinBox(w: unknown, b: BuildEnv): Box | undefined {
  if (w !== undefined) return b.ev(w).bbox();
  const lb = b.doc.localBounds();
  return lb && { min: [lb.min[0] - 1, lb.min[1] - 1, lb.min[2] - 1], max: [lb.max[0] + 1, lb.max[1] + 1, lb.max[2] + 1] };
}

function sameAs(by: string, seed: string, ctx: SelContext): (s: string) => boolean {
  switch (by) {
    case "solid":
      return (s) => s !== "minecraft:air";
    case "air":
      return (s) => s === "minecraft:air";
    case "state":
      return (s) => s === seed;
    case "block": {
      const id = stateId(seed);
      return (s) => stateId(s) === id;
    }
    case "family": {
      if (!ctx.index) throw new Error('matching by "family" needs a loaded instance');
      const fam = ctx.index.familyOfBlock(stateId(seed))?.id;
      if (!fam) {
        const id = stateId(seed);
        return (s) => stateId(s) === id;
      }
      return (s) => ctx.index!.familyOfBlock(stateId(s))?.id === fam;
    }
    default:
      throw new Error(`unknown match "${by}"; use solid, air, block, state or family`);
  }
}

function ellipsoid(center: Vec3, radii: Vec3): Mask {
  const r = radii.map((v) => v + 0.5) as Vec3;
  const lo = center.map((c, i) => Math.floor(c - r[i]!)) as Vec3, hi = center.map((c, i) => Math.ceil(c + r[i]!) + 1) as Vec3;
  checkBox({ min: lo, max: hi }, "ellipsoid");
  const m = new Mask();
  for (let x = lo[0]; x < hi[0]; x++)
    for (let y = lo[1]; y < hi[1]; y++)
      for (let z = lo[2]; z < hi[2]; z++) {
        const dx = (x - center[0]) / r[0], dy = (y - center[1]) / r[1], dz = (z - center[2]) / r[2];
        if (dx * dx + dy * dy + dz * dz <= 1) m.add(x, y, z);
      }
  return m;
}

/** Block (x,z) is in the polygon when it is inside (even-odd) or within half a block of an edge. */
function inPolygon(x: number, z: number, pts: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i]!, [xj, zj] = pts[j]!;
    if (segDist2(x, z, xi, zi, xj, zj) <= 0.25 + 1e-9) return true;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function segDist2(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az;
  const len = dx * dx + dz * dz;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len)) : 0;
  const qx = ax + t * dx - px, qz = az + t * dz - pz;
  return qx * qx + qz * qz;
}

/** Per-direction amounts: [+x, -x, +y, -y, +z, -z]. */
type By = [number, number, number, number, number, number];

function parseBy(x: unknown, what: string): By {
  if (typeof x === "number") {
    const n = int(x, what, 0);
    return [n, n, n, n, n, n];
  }
  if (Array.isArray(x)) {
    const [dx, dy, dz] = vec(x, what);
    if (dx < 0 || dy < 0 || dz < 0) throw new Error(`${what} amounts must be ≥ 0`);
    return [dx, dx, dy, dy, dz, dz];
  }
  const o = obj(x, what);
  const out: By = [0, 0, 0, 0, 0, 0];
  for (const [k, v] of Object.entries(o)) {
    const d = NAMED_DIRS[k];
    if (!d) throw new Error(`${what}: unknown direction "${k}" (use up, down, north, south, east, west)`);
    const n = int(v, `${what}.${k}`, 0);
    const slot = d[0] === 1 ? 0 : d[0] === -1 ? 1 : d[1] === 1 ? 2 : d[1] === -1 ? 3 : d[2] === 1 ? 4 : 5;
    out[slot] = n;
  }
  return out;
}

/**
 * Geometric expand/contract by a box kernel, one axis at a time. Expanding a box by n grows each
 * side by n; contracting shrinks it (and drops parts thinner than the kernel).
 */
function morph(m: Mask, by: By, mode: "dilate" | "erode"): Mask {
  let cur = m;
  for (let a = 0; a < 3; a++) {
    const pos = by[a * 2]!, neg = by[a * 2 + 1]!;
    if (!pos && !neg) continue;
    const next = new Mask();
    let n = 0;
    if (mode === "dilate") {
      cur.forEach((x, y, z) => {
        const p: Vec3 = [x, y, z];
        for (let k = -neg; k <= pos; k++) {
          const q: Vec3 = [...p];
          q[a] = p[a]! + k;
          next.add(q[0], q[1], q[2]);
          n++;
        }
      });
      if (n > MAX_OP_VOLUME * 4) throw new Error("expanded selection is too large");
    } else {
      // Contract by `pos` on the + side: keep p only if p+1..p+pos are in (and likewise below).
      cur.forEach((x, y, z) => {
        const p: Vec3 = [x, y, z];
        for (let k = -neg; k <= pos; k++) {
          if (!k) continue;
          const q: Vec3 = [...p];
          q[a] = p[a]! + k;
          if (!cur.has(q[0], q[1], q[2])) return;
        }
        next.add(x, y, z);
      });
    }
    cur = next;
  }
  checkBox(cur.bbox() ?? { min: [0, 0, 0], max: [0, 0, 0] }, "expanded selection");
  return cur === m ? m.clone() : cur;
}

function fmt(p: Vec3): string {
  return `(${p.join(",")})`;
}

// -- summaries ------------------------------------------------------------------------------------

export interface SelectionSummary {
  count: number;
  solid: number;
  bbox?: Box;
  top: [string, number][];
  components: string[];
}

export function summarize(doc: Document, m: Mask): SelectionSummary {
  const counts = new Map<string, number>();
  let solid = 0;
  m.forEach((x, y, z) => {
    const st = doc.getState(x, y, z);
    if (st === "minecraft:air") return;
    solid++;
    const id = stateId(st);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  });
  const bbox = m.bbox();
  const components: string[] = [];
  if (bbox)
    for (const id of doc.components.keys()) {
      const c = doc.componentLocal(id)!;
      if (!isEmptyBox(intersectBox(c.box, bbox))) {
        let touches = false;
        const ib = intersectBox(c.box, bbox);
        m.forEach((x, y, z) => {
          if (!touches && inside(ib, [x, y, z])) touches = true;
        });
        if (touches) components.push(id);
      }
    }
  return { count: m.count(), solid, ...(bbox ? { bbox } : {}), top: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 6), components };
}
