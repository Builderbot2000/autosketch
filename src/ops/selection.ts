import type { Registry } from "../assets/registry.js";
import { parseState, stateId } from "../core/blockstate.js";
import { deltaE } from "../palette/color.js";
import { Mask, shellOf } from "../core/mask.js";
import { defaultPivot, mirrorPos, rotatePos, type MirrorAxis } from "../core/rotate.js";
import { boxVolume, formatBox, fromPublic, intersectBox, isEmptyBox, type Box, type PublicBox, type Vec3 } from "../core/region.js";
import type { Document } from "../document/document.js";
import type { PaletteIndex } from "../palette/index.js";
import { hash01 } from "../core/rng.js";
import { blockMatcher, MAX_OP_VOLUME } from "./edit.js";
import { diffSince } from "../perception/diff.js";
import { getRender, renderIds } from "../perception/render/cameras.js";
import { pickLasso, pickRect, type PickDepth } from "../perception/render/pick.js";
import { enclosedMask, interiorMask, heightmapMask } from "../perception/morphology.js";

/**
 * Selections (docs/design/05-operations.md, L1): JSON expressions an agent sends with a tool call,
 * resolved against the document into a voxel mask when an op uses them. Named selections stay
 * expressions, so `connected`/`similar`/`filter` follow later edits.
 *
 * Shapes      {"min":[..],"max":[..]} (box shorthand) · {"box":{min,max}} · "all" (document bounds)
 *             {"cylinder":{center,radius,height,axis?}} · {"sphere":{center,radius}} · {"ellipsoid":{center,radii}}
 *             {"polygon":{points:[[x,z],..],y:[y0,y1]}} · {"plane":{axis,at,within?}} · {"component":"id"}
 * Picking     {"connected":{seed,match?,connectivity?,within?}} · {"similar":{seed,by?,within?}}
 *             (match/by: block|state|family|solid|air|tag|role|colour|prop:<name>; tag?, palette?, role?, tolerance?)
 *             {"kind":"tower"|"prefab:*"} · {"tagged":"ruined"} (component boxes, by registered metadata)
 * References  "<name>" (a named selection) · "last" (the most recent selection)
 * Booleans    {"union":[a,b,..]} · {"intersect":[a,b,..]} · {"subtract":[a,b,..]} · {"xor":[a,b]} · {"invert":a,"within"?:b}
 * Modifiers   {"dilate":a,"by":n|[dx,dy,dz]|{up,down,north,south,east,west}} · {"erode":a,"by":..}
 *             {"offset":a,"by":[dx,dy,dz]} · {"shell":a,"thickness"?,"walls_only"?} · {"layer":a,"y":n|"min"|"max"}
 *             {"surface":a} · {"bbox":a} · {"filter":a,"block"?:"..","air"?:bool}
 *             {"rotate":a,"turns":n,"pivot"?:[x,y,z]} · {"mirror":a,"axis":"x|y|z","about"?:n}
 *             {"grow":a,"by"?:n,"match"?:"solid|same|any"} · {"shrink":a,"by"?:n} (topological, along connected blocks)
 *             {"edges":a} · {"slab":a,"axis","from","to"} · {"convex":a} · {"fill_holes":a}
 *             {"checker":a,"size"?,"odd"?} · {"random":a,"ratio","seed"?} · {"every":a,"n","along"?,"offset"?}
 *             {"freeze":a} (stored as resolved voxels, {"frozen":[[x,y,z,len],..]})
 * More shapes {"hull":[[x,y,z],..]} (convex hull of points) · {"tube":{path:[[x,y,z],..],radius}}
 * Morphological (measured geometry, no architectural labels, 06; in perception/morphology.ts; S = a scope
 *             selection, a bare component id, or "all"/true for the whole build)
 *             {"enclosed":[x,y,z]|n,"of"?:S} (enclosed air; n as analyze lists them) · {"interior":S}
 *             {"heightmap":S} · {"changed":"op:-n|checkpoint:<name>"}
 * Render      {"view_box":{render?,rect:[x0,y0,x1,y1],depth?}} · {"view_lasso":{render?,points:[[px,py],..],depth?}}
 *             (render = id from a render caption, default the latest; depth "visible" (default) | "through")
 */

/** Selection keys renamed to established terms (docs/design/01-conventions.md, *Terminology*). */
const RENAMED: Record<string, string> = { expand: "dilate", contract: "erode", top: "heightmap" };

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
  if (!op) {
    const old = Object.keys(e).find((k) => k in RENAMED);
    if (old) throw new Error(`"${old}" was renamed "${RENAMED[old]}" (01, Terminology): use {"${RENAMED[old]}": ...}`);
    throw new Error(`unknown selection ${JSON.stringify(e).slice(0, 80)}; expected one of: ${Object.keys(BUILDERS).join(", ")} (or {min,max})`);
  }
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

  // Component metadata (05, Picking): the union of the boxes of every component of a kind, or
  // carrying a tag. Kinds and tags are whatever was registered; nothing is inferred from blocks.
  kind: (e, b) => componentsWhere(e.kind, "kind", b, (c, k) => (k.endsWith("*") ? (c.kind ?? "").startsWith(k.slice(0, -1)) : c.kind === k)),
  tagged: (e, b) => componentsWhere(e.tagged, "tagged", b, (c, t) => c.tags.includes(t)),

  connected: (e, b) => {
    const c = obj(e.connected, "connected");
    const seed = vec(c.seed, "connected.seed");
    const match = (c.match ?? "block") as string;
    const conn = (c.connectivity ?? 6) as number;
    if (![6, 18, 26].includes(conn)) throw new Error("connected.connectivity must be 6, 18 or 26");
    const within = withinBox(c.within, b);
    const doc = b.doc;
    const seedState = doc.getState(...seed);
    const test = sameAs(match, seedState, b.ctx, matchOpts(c), b.notes, "connected");
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
    const test = sameAs(by, seedState, b.ctx, matchOpts(c), b.notes);
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

  hull: (e) => {
    if (!Array.isArray(e.hull) || e.hull.length < 1) throw new Error('hull takes a list of [x,y,z] points, e.g. {"hull":[[0,0,0],[8,0,0],[4,6,4]]}');
    const pts = e.hull.map((p, i) => vec(p, `hull[${i}]`));
    return kdop(pts);
  },

  tube: (e) => {
    const t = obj(e.tube, "tube");
    if (!Array.isArray(t.path) || t.path.length < 1) throw new Error("tube.path needs at least one [x,y,z] point");
    const path = t.path.map((p, i) => vec(p, `tube.path[${i}]`, false));
    const r = num(t.radius ?? 0, "tube.radius", 0);
    const rr = (r + 0.5) ** 2;
    const lo = [0, 1, 2].map((a) => Math.floor(Math.min(...path.map((p) => p[a]!)) - r - 0.5)) as Vec3;
    const hi = [0, 1, 2].map((a) => Math.ceil(Math.max(...path.map((p) => p[a]!)) + r + 0.5) + 1) as Vec3;
    checkBox({ min: lo, max: hi }, "tube");
    const segs = path.length === 1 ? [[path[0]!, path[0]!]] : path.slice(1).map((p, i) => [path[i]!, p]);
    const m = new Mask();
    for (const [a, c] of segs as [Vec3, Vec3][]) {
      const sl = [0, 1, 2].map((k) => Math.floor(Math.min(a[k]!, c[k]!) - r - 0.5)) as Vec3, sh = [0, 1, 2].map((k) => Math.ceil(Math.max(a[k]!, c[k]!) + r + 0.5)) as Vec3;
      for (let x = sl[0]; x <= sh[0]; x++) for (let y = sl[1]; y <= sh[1]; y++) for (let z = sl[2]; z <= sh[2]; z++) if (segDist3(x, y, z, a, c) <= rr + 1e-9) m.add(x, y, z);
    }
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

  dilate: (e, b) => morph(b.ev(e.dilate), parseBy(e.by ?? 1, "dilate.by"), "dilate"),
  erode: (e, b) => morph(b.ev(e.erode), parseBy(e.by ?? 1, "erode.by"), "erode"),

  offset: (e, b) => b.ev(e.offset).translated(vec(e.by, "offset.by")),

  grow: (e, b) => {
    let m = b.ev(e.grow);
    const n = int(e.by ?? 1, "grow.by", 0);
    const match = (e.match ?? "solid") as string;
    if (!["solid", "same", "any"].includes(match)) throw new Error('grow.match must be "solid" (connected blocks, default), "same" (same block as its selected neighbour) or "any"');
    const doc = b.doc;
    for (let i = 0; i < n; i++) {
      const next = m.clone();
      let added = 0;
      m.forEach((x, y, z) => {
        const here = match === "same" ? stateId(doc.getState(x, y, z)) : "";
        for (const d of DIRS6) {
          const q: Vec3 = [x + d[0], y + d[1], z + d[2]];
          if (next.has(...q)) continue;
          const st = doc.getState(...q);
          if (match === "solid" && st === "minecraft:air") continue;
          if (match === "same" && stateId(st) !== here) continue;
          next.add(...q);
          added++;
        }
      });
      if (next.count() > MAX_OP_VOLUME) throw new Error("grown selection is too large");
      m = next;
      if (!added) break;
    }
    return m;
  },

  shrink: (e, b) => {
    let m = b.ev(e.shrink);
    const n = int(e.by ?? 1, "shrink.by", 0);
    const doc = b.doc;
    for (let i = 0; i < n; i++) {
      const next = m.clone();
      m.forEach((x, y, z) => {
        if (DIRS6.some((d) => !m.has(x + d[0], y + d[1], z + d[2]) && doc.getState(x + d[0], y + d[1], z + d[2]) !== "minecraft:air")) next.delete(x, y, z);
      });
      m = next;
    }
    return m;
  },

  checker: (e, b) => {
    const m = b.ev(e.checker);
    const size = int(e.size ?? 1, "checker.size", 1);
    const odd = e.odd === true ? 1 : 0;
    const out = new Mask();
    m.forEach((x, y, z) => ((Math.floor(x / size) + Math.floor(y / size) + Math.floor(z / size)) & 1) === odd && out.add(x, y, z));
    return out;
  },

  random: (e, b) => {
    const m = b.ev(e.random);
    const ratio = num(e.ratio, "random.ratio", 0);
    if (ratio > 1) throw new Error("random.ratio must be between 0 and 1");
    const seed = e.seed !== undefined ? int(e.seed, "random.seed") : b.doc.meta.seed;
    const out = new Mask();
    m.forEach((x, y, z) => hash01(seed, RANDOM_SALT, x, y, z) < ratio && out.add(x, y, z));
    return out;
  },

  every: (e, b) => {
    const m = b.ev(e.every);
    const n = int(e.n, "every.n", 1);
    const along = (e.along ?? "x") as string;
    if (!["x", "y", "z"].includes(along)) throw new Error('every.along must be "x", "y" or "z"');
    const a = "xyz".indexOf(along);
    const bb = m.bbox();
    if (!bb) return m;
    const offset = int(e.offset ?? 0, "every.offset", 0);
    const out = new Mask();
    m.forEach((x, y, z) => {
      const p = [x, y, z][a]! - bb.min[a]!;
      if (p % n === offset % n) out.add(x, y, z);
    });
    return out;
  },

  freeze: (e, b) => b.ev(e.freeze),

  frozen: (e) => {
    if (!Array.isArray(e.frozen)) throw new Error("frozen holds [x,y,z,length] runs (made by select with freeze)");
    const m = new Mask();
    for (const r of e.frozen as unknown[]) {
      if (!Array.isArray(r) || r.length !== 4 || r.some((v) => !Number.isInteger(v))) throw new Error("frozen runs must be [x,y,z,length] integers");
      const [x, y, z, len] = r as number[];
      for (let i = 0; i < len!; i++) m.add(x! + i, y!, z!);
    }
    return m;
  },

  edges: (e, b) => {
    const m = b.ev(e.edges);
    const out = new Mask();
    m.forEach((x, y, z) => {
      let axes = 0;
      if (!m.has(x + 1, y, z) || !m.has(x - 1, y, z)) axes++;
      if (!m.has(x, y + 1, z) || !m.has(x, y - 1, z)) axes++;
      if (!m.has(x, y, z + 1) || !m.has(x, y, z - 1)) axes++;
      if (axes >= 2) out.add(x, y, z);
    });
    return out;
  },

  slab: (e, b) => {
    const m = b.ev(e.slab);
    const axis = (e.axis ?? "y") as string;
    if (!["x", "y", "z"].includes(axis)) throw new Error('slab.axis must be "x", "y" or "z"');
    const a = "xyz".indexOf(axis);
    const from = int(e.from, "slab.from"), to = int(e.to ?? e.from, "slab.to");
    const lo = Math.min(from, to), hi = Math.max(from, to);
    const out = new Mask();
    m.forEach((x, y, z) => {
      const v = [x, y, z][a]!;
      if (v >= lo && v <= hi) out.add(x, y, z);
    });
    return out;
  },

  convex: (e, b) => {
    const m = b.ev(e.convex);
    return m.isEmpty() ? m : kdop(m.positions()).unionWith(m);
  },

  fill_holes: (e, b) => {
    const m = b.ev(e.fill_holes);
    const bb = m.bbox();
    if (!bb) return m;
    const outer: Box = { min: [bb.min[0] - 1, bb.min[1] - 1, bb.min[2] - 1], max: [bb.max[0] + 1, bb.max[1] + 1, bb.max[2] + 1] };
    checkBox(outer, "fill_holes");
    // Flood the outside from the padded box's corner; whatever the flood can't reach is enclosed.
    const outside = new Mask();
    const stack: Vec3[] = [[...outer.min]];
    outside.add(...outer.min);
    while (stack.length) {
      const [x, y, z] = stack.pop()!;
      for (const d of DIRS6) {
        const q: Vec3 = [x + d[0], y + d[1], z + d[2]];
        if (!inside(outer, q) || outside.has(...q) || m.has(...q)) continue;
        outside.add(...q);
        stack.push(q);
      }
    }
    const out = m.clone();
    for (let y = bb.min[1]; y < bb.max[1]; y++) for (let z = bb.min[2]; z < bb.max[2]; z++) for (let x = bb.min[0]; x < bb.max[0]; x++) if (!outside.has(x, y, z)) out.add(x, y, z);
    return out;
  },

  rotate: (e, b) => {
    const m = b.ev(e.rotate);
    const turns = int(e.turns ?? 1, "rotate.turns");
    const bb = m.bbox();
    if (!bb) return m;
    const pivot = e.pivot !== undefined ? vec(e.pivot, "rotate.pivot") : defaultPivot(bb);
    const out = new Mask();
    m.forEach((x, y, z) => out.add(...rotatePos([x, y, z], turns, pivot)));
    return out;
  },

  mirror: (e, b) => {
    const m = b.ev(e.mirror);
    const axis = e.axis as MirrorAxis;
    if (!["x", "y", "z"].includes(axis)) throw new Error('mirror.axis must be "x", "y" or "z"');
    const bb = m.bbox();
    if (!bb) return m;
    const a = "xyz".indexOf(axis);
    const about = e.about !== undefined ? num(e.about, "mirror.about") : (bb.min[a]! + bb.max[a]! - 1) / 2;
    if (!Number.isInteger(about * 2)) throw new Error("mirror.about must be a block coordinate or a half (e.g. 4 or 4.5)");
    const out = new Mask();
    m.forEach((x, y, z) => out.add(...mirrorPos([x, y, z], axis, about)));
    return out;
  },

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

  // -- morphological (05, Morphological): thin cases over perception/morphology.ts ----------------------------

  enclosed: (e, b) => {
    const which = typeof e.enclosed === "number" ? int(e.enclosed, "enclosed", 1) : vec(e.enclosed, "enclosed");
    const r = enclosedMask(b.doc, which, scopeOf(e.of, b));
    if (r.note) b.notes.push(r.note);
    return r.mask;
  },

  interior: (e, b) => {
    const m = interiorMask(b.doc, scopeOf(e.interior, b));
    if (m.isEmpty()) b.notes.push("interior: no enclosed air (every air position connects to the outside)");
    return m;
  },

  heightmap: (e, b) => {
    const scope = scopeOf(e.heightmap, b);
    if (scope) return heightmapMask(b.doc, scope);
    const lb = b.doc.localBounds();
    return lb ? heightmapMask(b.doc, fromBoxChecked(lb)) : new Mask();
  },

  changed: (e, b) => {
    if (typeof e.changed !== "string") throw new Error('changed takes "op:-n" or "checkpoint:<name>", e.g. {"changed":"op:-1"}');
    return diffSince(b.doc, e.changed).mask;
  },

  // -- render-seeded (05, Picking): perception/render/pick.ts --------------------------------------

  view_box: (e, b) => {
    const v = obj(e.view_box, "view_box");
    const rect = v.rect;
    if (!Array.isArray(rect) || rect.length !== 4 || rect.some((n) => !Number.isInteger(n))) throw new Error("view_box.rect must be [x0,y0,x1,y1] pixel integers (inclusive)");
    const r = pickRect(b.doc, renderOf(v.render, b), rect as [number, number, number, number], depthOf(v.depth, "view_box"));
    b.notes.push(...r.notes);
    return r.mask;
  },

  view_lasso: (e, b) => {
    const v = obj(e.view_lasso, "view_lasso");
    if (!Array.isArray(v.points) || v.points.length < 3) throw new Error("view_lasso.points needs at least 3 [px,py] points");
    const pts = v.points.map((p, i) => {
      if (!Array.isArray(p) || p.length !== 2 || p.some((n) => typeof n !== "number" || !Number.isFinite(n))) throw new Error(`view_lasso.points[${i}] must be [px,py]`);
      return p as [number, number];
    });
    const r = pickLasso(b.doc, renderOf(v.render, b), pts, depthOf(v.depth, "view_lasso"));
    b.notes.push(...r.notes);
    return r.mask;
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

/**
 * Scope of a morphological selection: undefined (the whole build) for absent, "all" or true; a bare
 * string that names no stored selection but a component means that component; anything else is
 * a selection.
 */
function scopeOf(x: unknown, b: BuildEnv): Mask | undefined {
  if (x === undefined || x === "all" || x === true) return undefined;
  if (typeof x === "string" && x !== "last" && !b.doc.selections.has(x)) {
    const c = b.doc.componentLocal(x);
    if (c) return fromBoxChecked(c.box);
  }
  return b.ev(x);
}

function componentsWhere(x: unknown, what: "kind" | "tagged", b: BuildEnv, test: (c: { kind?: string; tags: string[] }, v: string) => boolean): Mask {
  if (typeof x !== "string" || !x) throw new Error(what === "kind" ? 'kind takes a component kind, e.g. {"kind":"tower"} (a trailing * matches a prefix, "prefab:*")' : 'tagged takes a component tag, e.g. {"tagged":"ruined"}');
  const m = new Mask();
  const ids: string[] = [];
  for (const id of b.doc.components.keys()) {
    const c = b.doc.componentLocal(id)!;
    if (!test(c, x)) continue;
    ids.push(id);
    m.unionWith(fromBoxChecked(c.box));
  }
  if (!ids.length) {
    const have = new Set<string>();
    for (const c of b.doc.components.values()) for (const v of what === "kind" ? (c.kind ? [c.kind] : []) : c.tags) have.add(v);
    b.notes.push(`${what}: no component ${what === "kind" ? "of kind" : "tagged"} "${x}"${have.size ? ` (have: ${[...have].sort().join(", ")})` : ""}; nothing selected`);
  }
  if (m.count() > MAX_OP_VOLUME) throw new Error(`${what} "${x}" covers more than ${MAX_OP_VOLUME.toLocaleString("en-US")} blocks`);
  return m;
}

function renderOf(id: unknown, b: BuildEnv) {
  if (id !== undefined && typeof id !== "string") throw new Error('render must be a render id from a render caption, e.g. "r3"');
  const rec = getRender(b.doc, id);
  if (!rec) throw new Error(id ? `no recent render "${id}" (kept: ${renderIds(b.doc).join(", ") || "none"}); render again, and freeze picks you store` : "no render of this document yet; call render first");
  return rec;
}

function depthOf(d: unknown, what: string): PickDepth {
  if (d === undefined) return "visible";
  if (d !== "visible" && d !== "through") throw new Error(`${what}.depth must be "visible" (the surface the camera saw) or "through" (the whole volume behind the outline)`);
  return d;
}

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

/** Extra parameters of the palette- and tag-based matches (05, Picking). */
interface MatchOpts {
  /** by "tag": the tag to match ("#minecraft:logs"); default the seed's most specific tag. */
  tag?: unknown;
  /** by "role": the palette (default the only one) and role (default every role holding the seed). */
  palette?: unknown;
  role?: unknown;
  /** by "colour": largest CIELAB ΔE between family mean colours (default 10). */
  tolerance?: unknown;
}

function matchOpts(c: Record<string, unknown>): MatchOpts {
  return { tag: c.tag, palette: c.palette, role: c.role, tolerance: c.tolerance };
}

/** Caches a per-state test: picks call it for every voxel, but a build has few distinct states. */
function cached(test: (s: string) => boolean): (s: string) => boolean {
  const memo = new Map<string, boolean>();
  return (s) => {
    let r = memo.get(s);
    if (r === undefined) memo.set(s, (r = test(s)));
    return r;
  };
}

function sameAs(by: string, seed: string, ctx: SelContext, o: MatchOpts = {}, notes: string[] = [], what = "similar"): (s: string) => boolean {
  if (by.startsWith("prop:")) {
    const k = by.slice(5);
    const v = parseState(seed).props[k];
    if (v === undefined) {
      notes.push(`${what}: the seed ${seed} has no property "${k}"; nothing matches`);
      return () => false;
    }
    return cached((s) => parseState(s).props[k] === v);
  }
  switch (by) {
    case "tag": {
      if (!ctx.registry) throw new Error('matching by "tag" needs a loaded instance');
      const own = ctx.registry.get(stateId(seed))?.tags ?? [];
      let tag: string;
      if (o.tag !== undefined) {
        if (typeof o.tag !== "string" || !o.tag) throw new Error('tag must be a block tag, e.g. "#minecraft:logs"');
        tag = o.tag.replace(/^#/, "");
        if (!own.includes(tag)) notes.push(`${what}: the seed ${stateId(seed)} is not in #${tag}`);
      } else {
        if (!own.length) {
          notes.push(`${what}: the seed ${stateId(seed)} has no block tags; nothing matches`);
          return () => false;
        }
        // The most specific tag (fewest blocks), ties by name, so the choice is stable.
        tag = [...own].sort((a, b) => ctx.registry!.withTag(a).length - ctx.registry!.withTag(b).length || a.localeCompare(b))[0]!;
        notes.push(`${what}: by tag #${tag} (the seed's most specific of ${own.length} tag${own.length > 1 ? "s" : ""}; pass tag to choose another)`);
      }
      const ids = new Set(ctx.registry.withTag(tag).map((b) => b.id));
      return (s) => ids.has(stateId(s));
    }
    case "role": {
      const book = ctx.doc.palettes;
      let p;
      if (o.palette !== undefined) {
        if (typeof o.palette !== "string") throw new Error("palette must be a palette name");
        p = book.get(o.palette.replace(/^palette:/, ""));
        if (!p) throw new Error(`no palette "${o.palette}" (have: ${book.list().map((x) => x.name).join(", ") || "none"})`);
      } else {
        const all = book.list();
        if (all.length !== 1) throw new Error(all.length ? `matching by "role" needs palette (have: ${all.map((x) => x.name).join(", ")})` : 'matching by "role" needs a named palette (palette_pick) and none exists');
        p = all[0]!;
      }
      const seedId = stateId(seed);
      const seedFam = ctx.index?.familyOfBlock(seedId)?.id;
      const holds = (ms: { family: string; block: string }[]) => ms.some((m) => m.block === seedId || (seedFam !== undefined && m.family === seedFam));
      let roles: string[];
      if (o.role !== undefined) {
        if (typeof o.role !== "string" || !p.roles[o.role]) throw new Error(`palette "${p.name}" has no role ${JSON.stringify(o.role)} (roles: ${Object.keys(p.roles).join(", ")})`);
        roles = [o.role];
        if (!holds(p.roles[o.role]!)) notes.push(`${what}: the seed ${seedId} is not in ${p.name}.${o.role}`);
      } else {
        roles = Object.keys(p.roles).filter((r) => holds(p.roles[r]!));
        if (!roles.length) {
          notes.push(`${what}: the seed ${seedId} is in no role of palette "${p.name}"; nothing matches`);
          return () => false;
        }
        notes.push(`${what}: by role ${roles.map((r) => `${p.name}.${r}`).join(", ")}`);
      }
      const fams = new Set<string>(), blocks = new Set<string>();
      for (const r of roles) for (const m of p.roles[r]!) (fams.add(m.family), blocks.add(m.block));
      const index = ctx.index;
      return cached((s) => {
        const id = stateId(s);
        if (blocks.has(id)) return true;
        const f = index?.familyOfBlock(id)?.id;
        return f !== undefined && fams.has(f);
      });
    }
    case "colour":
    case "color": {
      const index = ctx.index;
      if (!index) throw new Error('matching by "colour" needs a loaded instance');
      const tol = o.tolerance === undefined ? 10 : num(o.tolerance, "tolerance", 0);
      const fam = index.familyOfBlock(stateId(seed))?.id;
      const lab = fam !== undefined ? index.stats(fam)?.lab : undefined;
      if (!lab) {
        notes.push(`${what}: the seed ${stateId(seed)} has no colour in the palette index; matching the block instead`);
        const id = stateId(seed);
        return (s) => stateId(s) === id;
      }
      return cached((s) => {
        const f = index.familyOfBlock(stateId(s))?.id;
        const l = f !== undefined ? index.stats(f)?.lab : undefined;
        return l !== undefined && deltaE(l, lab) <= tol;
      });
    }
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
      throw new Error(`unknown match "${by}"; use solid, air, block, state, family, tag, role, colour or prop:<name>`);
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
 * Dilation/erosion by a box kernel, one axis at a time. Dilating a box by n grows each
 * side by n; eroding shrinks it (and drops parts thinner than the kernel).
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
      if (n > MAX_OP_VOLUME * 4) throw new Error("dilated selection is too large");
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
  checkBox(cur.bbox() ?? { min: [0, 0, 0], max: [0, 0, 0] }, "dilated selection");
  return cur === m ? m.clone() : cur;
}

const RANDOM_SALT = 0x5e1ec7;

/**
 * Directions for the convex approximation: every primitive integer vector with components in
 * -2..2 (98 of them). A position is inside when it lies within the points' extent along every
 * direction, a k-DOP that hugs the true convex hull (slightly generous on faces at other angles).
 */
const KDOP_DIRS: Vec3[] = (() => {
  const out: Vec3[] = [];
  const gcd = (a: number, c: number): number => (c ? gcd(c, a % c) : Math.abs(a));
  for (let x = -2; x <= 2; x++) for (let y = -2; y <= 2; y++) for (let z = -2; z <= 2; z++) if ((x || y || z) && gcd(gcd(x, y), z) === 1) out.push([x, y, z]);
  return out;
})();

function kdop(pts: Vec3[]): Mask {
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) for (let a = 0; a < 3; a++) [lo[a], hi[a]] = [Math.min(lo[a]!, p[a]!), Math.max(hi[a]!, p[a]! + 1)];
  checkBox({ min: lo, max: hi }, "hull");
  const max = KDOP_DIRS.map(() => -Infinity);
  for (const p of pts) KDOP_DIRS.forEach((d, i) => (max[i] = Math.max(max[i]!, d[0] * p[0] + d[1] * p[1] + d[2] * p[2])));
  const m = new Mask();
  for (let x = lo[0]; x < hi[0]; x++)
    for (let y = lo[1]; y < hi[1]; y++)
      for (let z = lo[2]; z < hi[2]; z++) if (KDOP_DIRS.every((d, i) => d[0] * x + d[1] * y + d[2] * z <= max[i]!)) m.add(x, y, z);
  return m;
}

function segDist3(x: number, y: number, z: number, a: Vec3, b: Vec3): number {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = d[0]! ** 2 + d[1]! ** 2 + d[2]! ** 2;
  const t = len ? Math.max(0, Math.min(1, ((x - a[0]) * d[0]! + (y - a[1]) * d[1]! + (z - a[2]) * d[2]!) / len)) : 0;
  return (a[0] + t * d[0]! - x) ** 2 + (a[1] + t * d[1]! - y) ** 2 + (a[2] + t * d[2]! - z) ** 2;
}

/**
 * Replaces every `freeze` node in an expression with its resolved voxels (`{"frozen": runs}`), so a
 * stored selection keeps exactly what it covered now instead of re-evaluating (05, Naming).
 */
export function freezeNodes(expr: SelExpr, ctx: SelContext): SelExpr {
  if (typeof expr === "string" || !expr || typeof expr !== "object") return expr;
  if ("freeze" in expr) {
    const runs: number[][] = [];
    const m = resolveSelection(asExpr(expr.freeze), ctx).mask;
    const pts = m.positions().sort((p, q) => p[1] - q[1] || p[2] - q[2] || p[0] - q[0]);
    for (const p of pts) {
      const last = runs[runs.length - 1];
      if (last && last[1] === p[1] && last[2] === p[2] && last[0]! + last[3]! === p[0]) last[3]!++;
      else runs.push([p[0], p[1], p[2], 1]);
    }
    return { frozen: runs };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(expr)) {
    if (Array.isArray(v)) out[k] = v.map((x) => (x && typeof x === "object" && !Array.isArray(x) ? freezeNodes(x as SelExpr, ctx) : x));
    else out[k] = v && typeof v === "object" ? freezeNodes(v as SelExpr, ctx) : v;
  }
  return out;
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
