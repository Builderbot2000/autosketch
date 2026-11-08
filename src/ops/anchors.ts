import { formatVec, type Box, type Vec3 } from "../core/region.js";
import type { Document, Facing } from "../document/document.js";
import { analyzeStructure } from "../perception/analyze.js";
import type { OpEnv } from "./edit.js";

/**
 * Anchors and relative placement (docs/design/05-operations.md, "Anchors & relative placement").
 * Positions can name existing geometry instead of absolute coordinates:
 *
 *   [x, y, z]                                  a document-local position
 *   "tower_ne.top"                             a component anchor (named or implicit)
 *   { anchor: "gatehouse.door", offset: [0, 0, 3] }
 *   { face: "keep.front", u: 0.5, v: "storey:2" }   a point on a component's face
 *
 * Implicit anchors of every component: `min`, `max` (its corner blocks), `center`, `bottom` (centre
 * of the lowest layer), `top` (centre, one above the box), the face centres `front`, `back`,
 * `left`, `right` (on the box's outer layer, at mid-height; resolved through the document's
 * front, `01`), and `storey:n` (centre of the footprint at storey n's standing level). Named
 * anchors win over implicit ones. A bare component id means its `base` anchor, else `bottom`.
 *
 * Face coordinates: `u` runs across the face from the viewer's left to right (standing outside,
 * looking at it), `v` from the bottom up; on `top`/`bottom` faces u runs east and v south. A number
 * in 0..1 is a fraction of the face (0 = first block, 1 = last), a larger number a block offset from
 * the start, a negative one counts back from the far end (-1 = last block), and a numeric string
 * ("1") is always a block offset. `v: "storey:n"` is storey n's standing level.
 *
 * Storeys come from the component's named anchors (`storey:n` or `storey_n`, whose y is the level)
 * or, failing that, from structural analysis of the component's box (`06`): the layer above the
 * detected floor. Every resolution returns a description that echoes the absolute coordinates.
 */

export type AtSpec = Vec3 | string | { anchor: string; offset?: Vec3 } | FaceAt;

export interface FaceAt {
  face: string;
  u?: number | string;
  v?: number | string;
  offset?: Vec3;
}

export interface ResolvedAt {
  pos: Vec3;
  /** e.g. `tower_ne.top = (4,9,4)`, for op results (05: the mapping is always echoed). */
  desc: string;
}

export type FaceSide = "front" | "back" | "left" | "right" | "north" | "south" | "east" | "west" | "top" | "bottom";

export interface Face {
  component: string;
  side: FaceSide;
  /** Compass side for vertical faces, or top/bottom. */
  dir: "north" | "south" | "east" | "west" | "top" | "bottom";
  /** Outward unit normal. */
  normal: Vec3;
  /** Unit vectors along u and v. */
  u: Vec3;
  v: Vec3;
  /** Local position of (u=0, v=0): a block on the box's outer layer. */
  origin: Vec3;
  /** Face size in blocks along u and v. */
  width: number;
  height: number;
  /** The component's local half-open box. */
  box: Box;
}

type AnchorEnv = Pick<OpEnv, "registry" | "index">;

const COMPASS: Record<string, Vec3> = { north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0] };

/** Compass direction of a facade (front/back/left/right) for a document front (01). */
export function facadeDir(facade: "front" | "back" | "left" | "right", front: Facing): "north" | "south" | "east" | "west" {
  const f = COMPASS[front]!;
  // Right of a viewer facing the front from outside: (n_z, -n_x) for outward normal n = front.
  const v: Record<string, [number, number]> = { front: [f[0], f[2]], back: [-f[0], -f[2]], right: [f[2], -f[0]], left: [-f[2], f[0]] };
  const [x, z] = v[facade]!;
  return x === 1 ? "east" : x === -1 ? "west" : z === 1 ? "south" : "north";
}

/** Resolves any `at:` form to a local position plus a description echoing it. */
export function resolveAnchor(doc: Document, at: AtSpec, env: AnchorEnv = {}): ResolvedAt {
  if (Array.isArray(at)) {
    if (at.length !== 3 || at.some((n) => !Number.isInteger(n))) throw new Error(`at must be [x,y,z] integers (got ${JSON.stringify(at)})`);
    const pos: Vec3 = [at[0], at[1], at[2]];
    return { pos, desc: formatVec(pos) };
  }
  if (typeof at === "string") {
    const pos = namedAnchor(doc, at, env);
    return { pos, desc: `${at} = ${formatVec(pos)}` };
  }
  if (at && typeof at === "object" && typeof (at as { face?: unknown }).face === "string") {
    const f = at as FaceAt;
    const face = resolveFace(doc, f.face);
    const iu = faceIndex(f.u ?? 0.5, face.width, "u");
    const iv = typeof f.v === "string" && /^storey[:_]/.test(f.v) ? storeyLevel(doc, face.component, storeyNumber(f.v), env) - face.origin[1] : faceIndex(f.v ?? 0.5, face.height, "v");
    const p = facePoint(face, iu, iv);
    const pos = addOffset(p, f.offset);
    return { pos, desc: `${f.face}(u ${JSON.stringify(f.u ?? 0.5)}, v ${JSON.stringify(f.v ?? 0.5)})${f.offset ? ` + ${formatVec(f.offset)}` : ""} = ${formatVec(pos)}` };
  }
  if (at && typeof at === "object" && typeof (at as { anchor?: unknown }).anchor === "string") {
    const a = at as { anchor: string; offset?: Vec3 };
    const pos = addOffset(namedAnchor(doc, a.anchor, env), a.offset);
    return { pos, desc: `${a.anchor}${a.offset ? ` + ${formatVec(a.offset)}` : ""} = ${formatVec(pos)}` };
  }
  throw new Error('at must be [x,y,z], "component.anchor", {anchor, offset} or {face:"component.side", u, v}');
}

/** Every anchor of a component: implicit ones first, named ones over them (local coordinates). */
export function componentAnchors(doc: Document, id: string): Record<string, Vec3> {
  const c = doc.componentLocal(id);
  if (!c) throw new Error(noComponent(doc, id));
  return { ...implicitAnchors(doc, c.box), ...c.anchors };
}

function implicitAnchors(doc: Document, b: Box): Record<string, Vec3> {
  const { min, max } = b;
  const cx = Math.floor((min[0] + max[0] - 1) / 2), cy = Math.floor((min[1] + max[1] - 1) / 2), cz = Math.floor((min[2] + max[2] - 1) / 2);
  const out: Record<string, Vec3> = {
    min: [...min],
    max: [max[0] - 1, max[1] - 1, max[2] - 1],
    center: [cx, cy, cz],
    bottom: [cx, min[1], cz],
    top: [cx, max[1], cz],
  };
  for (const f of ["front", "back", "left", "right"] as const) {
    const d = COMPASS[facadeDir(f, doc.meta.front)]!;
    out[f] = [d[0] > 0 ? max[0] - 1 : d[0] < 0 ? min[0] : cx, cy, d[2] > 0 ? max[2] - 1 : d[2] < 0 ? min[2] : cz];
  }
  return out;
}

function namedAnchor(doc: Document, ref: string, env: AnchorEnv): Vec3 {
  const { comp, name } = splitRef(doc, ref);
  const c = doc.componentLocal(comp)!;
  if (name === undefined) {
    if (c.anchors.base) return [...c.anchors.base];
    return implicitAnchors(doc, c.box).bottom!;
  }
  if (c.anchors[name]) return [...c.anchors[name]!];
  const implicit = implicitAnchors(doc, c.box);
  if (implicit[name]) return implicit[name]!;
  if (/^storey[:_]\d+$/.test(name)) {
    const y = storeyLevel(doc, comp, storeyNumber(name), env);
    return [implicit.center![0], y, implicit.center![2]];
  }
  throw new Error(`component "${comp}" has no anchor "${name}" (named: ${Object.keys(c.anchors).join(", ") || "none"}; implicit: ${Object.keys(implicit).join(", ")}, storey:n)`);
}

/**
 * Splits "comp.anchor" into a component and an anchor name. Component ids may contain dots, so
 * the longest existing component prefix wins; a ref that is a component id has no anchor name.
 */
function splitRef(doc: Document, ref: string): { comp: string; name?: string } {
  if (doc.components.has(ref)) return { comp: ref };
  for (let i = ref.lastIndexOf("."); i > 0; i = ref.lastIndexOf(".", i - 1)) {
    const comp = ref.slice(0, i);
    if (doc.components.has(comp)) return { comp, name: ref.slice(i + 1) };
  }
  const dot = ref.indexOf(".");
  throw new Error(noComponent(doc, dot > 0 ? ref.slice(0, dot) : ref));
}

function noComponent(doc: Document, id: string): string {
  return `no component "${id}" (have: ${[...doc.components.keys()].join(", ") || "none"})`;
}

/** A component's face: "keep.front", "keep.north", "keep.top"… (front/back/left/right go through the document front). */
export function resolveFace(doc: Document, ref: string): Face {
  const { comp, name } = splitRef(doc, ref);
  if (!name) throw new Error(`face needs "component.side" (front, back, left, right, north, south, east, west, top, bottom); got "${ref}"`);
  const side = name as FaceSide;
  const box = doc.componentLocal(comp)!.box;
  const { min, max } = box;
  if (side === "top" || side === "bottom") {
    return { component: comp, side, dir: side, normal: [0, side === "top" ? 1 : -1, 0], u: [1, 0, 0], v: [0, 0, 1], origin: [min[0], side === "top" ? max[1] - 1 : min[1], min[2]], width: max[0] - min[0], height: max[2] - min[2], box };
  }
  const dir = side in COMPASS ? (side as "north") : ["front", "back", "left", "right"].includes(side) ? facadeDir(side as "front", doc.meta.front) : undefined;
  if (!dir) throw new Error(`unknown face "${name}" (use front, back, left, right, north, south, east, west, top or bottom)`);
  const n = COMPASS[dir]!;
  const u: Vec3 = [n[2], 0, n[0] === 0 ? 0 : -n[0]];
  const along = u[0] !== 0 ? 0 : 2;
  const origin: Vec3 = [0, min[1], 0];
  // The outer layer on the normal's axis, and the viewer's-left edge on u's axis.
  const nAxis = n[0] !== 0 ? 0 : 2;
  origin[nAxis] = n[nAxis]! > 0 ? max[nAxis]! - 1 : min[nAxis]!;
  origin[along] = u[along]! > 0 ? min[along]! : max[along]! - 1;
  return { component: comp, side, dir, normal: n, u, v: [0, 1, 0], origin, width: max[along]! - min[along]!, height: max[1] - min[1], box };
}

/** Local position of face cell (iu, iv). */
export function facePoint(f: Face, iu: number, iv: number): Vec3 {
  return [f.origin[0] + f.u[0] * iu + f.v[0] * iv, f.origin[1] + f.u[1] * iu + f.v[1] * iv, f.origin[2] + f.u[2] * iu + f.v[2] * iv];
}

/** A u or v coordinate as a block index on a face `len` blocks long (see the module doc). */
export function faceIndex(x: number | string, len: number, what: string): number {
  if (typeof x === "string") {
    if (!/^-?\d+$/.test(x.trim())) throw new Error(`${what} must be a number, a block offset string such as "2"${what === "v" ? ', or "storey:n"' : ""} (got "${x}")`);
    const n = Number(x);
    return n < 0 ? len + n : n;
  }
  if (typeof x !== "number" || !Number.isFinite(x)) throw new Error(`${what} must be a number (got ${JSON.stringify(x)})`);
  if (x >= 0 && x <= 1) return Math.round(x * (len - 1));
  if (!Number.isInteger(x)) throw new Error(`${what} must be a fraction 0..1 or a whole block offset (got ${x})`);
  return x < 0 ? len + x : x;
}

function storeyNumber(s: string): number {
  const m = /^storey[:_](\d+)$/.exec(s);
  if (!m || Number(m[1]) < 1) throw new Error(`storeys are numbered from 1: "storey:1", "storey:2"… (got "${s}")`);
  return Number(m[1]);
}

/**
 * The standing level (y of the first air layer above the floor) of storey `n` of a component,
 * from its named anchors, else from structural analysis of its box (06).
 */
export function storeyLevel(doc: Document, comp: string, n: number, env: AnchorEnv = {}): number {
  const c = doc.componentLocal(comp);
  if (!c) throw new Error(noComponent(doc, comp));
  const named = c.anchors[`storey:${n}`] ?? c.anchors[`storey_${n}`];
  if (named) return named[1];
  const a = analyzeStructure(doc, { region: c.box, ...(env.registry ? { registry: env.registry } : {}), ...(env.index ? { index: env.index } : {}) });
  const s = a.storeys[n - 1];
  if (!s) throw new Error(`component "${comp}" has ${a.storeys.length} storey${a.storeys.length === 1 ? "" : "s"} by analysis (floors at y=${a.storeys.map((x) => x.floorY).join(", ") || "none"}); name an anchor "storey:${n}" to set it`);
  return s.floorY + 1;
}

function addOffset(p: Vec3, o: Vec3 | undefined): Vec3 {
  if (!o) return p;
  if (!Array.isArray(o) || o.length !== 3 || o.some((v) => !Number.isInteger(v))) throw new Error(`offset must be [dx,dy,dz] integers (got ${JSON.stringify(o)})`);
  return [p[0] + o[0], p[1] + o[1], p[2] + o[2]];
}
