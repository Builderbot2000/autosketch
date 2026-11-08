import type { Mask } from "../../core/mask.js";
import type { Box, Vec3 } from "../../core/region.js";
import type { Document } from "../../document/document.js";
import { NEAR, type Camera } from "./raster.js";

/**
 * Cameras of recent renders, kept per document (docs/design/06-perception.md, `raycast`), so a
 * pixel in an image the agent has seen resolves back to a block. The render-seeded selections
 * (`view_box`, `view_lasso`, 05) build on the same records.
 */

export interface ViewCamera {
  label: string;
  /** Cell of the contact sheet this view occupies, in output pixels. */
  ox: number;
  oy: number;
  width: number;
  height: number;
  /** Supersampling factor: the camera works in raster pixels = output pixels × ss. */
  ss: number;
  cam: Camera;
  /** What was drawn: a local half-open box, optionally narrowed by a mask and a near clip. */
  clip: Box;
  mask?: Mask;
  cut?: Cut;
  /** Depth peeling: the view shows the n-th block along each ray (06, *Cameras*). */
  peel?: number;
}

/** A near clip (06, *Cameras*): a block is drawn when its centre lies at least `d` along `normal`. */
export interface Cut {
  normal: [number, number, number];
  d: number;
}

/** True when a block is on the kept side of a near clip. */
export function kept(c: Cut, x: number, y: number, z: number): boolean {
  return (x + 0.5) * c.normal[0] + (y + 0.5) * c.normal[1] + (z + 0.5) * c.normal[2] >= c.d;
}

export interface RenderRecord {
  id: string;
  /** Document revision when rendered (a later edit makes hits approximate). */
  revision: number;
  width: number;
  height: number;
  views: ViewCamera[];
}

export const KEPT_RENDERS = 8;
const logs = new WeakMap<Document, { next: number; list: RenderRecord[] }>();

/** Stores a render's cameras and returns its id ("r1", "r2", …). */
export function recordRender(doc: Document, rec: Omit<RenderRecord, "id">): string {
  let log = logs.get(doc);
  if (!log) logs.set(doc, (log = { next: 1, list: [] }));
  const id = `r${log.next++}`;
  log.list.push({ ...rec, id });
  if (log.list.length > KEPT_RENDERS) log.list.shift();
  return id;
}

/** A stored render by id, or the latest one. */
export function getRender(doc: Document, id?: string): RenderRecord | undefined {
  const list = logs.get(doc)?.list ?? [];
  return id ? list.find((r) => r.id === id) : list[list.length - 1];
}

export function renderIds(doc: Document): string[] {
  return (logs.get(doc)?.list ?? []).map((r) => r.id);
}

export type HitFace = "up" | "down" | "north" | "south" | "east" | "west";

export interface RayHit {
  view: ViewCamera;
  /** The block under the pixel, or undefined when the ray hits nothing drawn. */
  pos?: Vec3;
  state?: string;
  face?: HitFace;
}

/** The view containing an output pixel. */
export function viewAt(rec: RenderRecord, px: number, py: number): ViewCamera | undefined {
  return rec.views.find((v) => px >= v.ox && px < v.ox + v.width && py >= v.oy && py < v.oy + v.height);
}

/**
 * World-space ray (unit direction) through the centre of an output pixel. Orthographic: the origin
 * lies on the view plane and the ray is a whole line. Perspective: the origin is the eye and the
 * ray starts there (`tMin` 0).
 */
export function pixelRay(v: ViewCamera, px: number, py: number): { origin: Vec3; dir: Vec3; tMin: number } {
  return rayThrough(v, px + 0.5, py + 0.5);
}

/** World-space ray through a point of the output image (continuous pixel coordinates: pixel (3,4) spans 3..4 × 4..5). */
export function rayThrough(v: ViewCamera, fx: number, fy: number): { origin: Vec3; dir: Vec3; tMin: number } {
  const c = v.cam;
  const rx = (fx - v.ox) * v.ss, ry = (fy - v.oy) * v.ss;
  if (c.eye) {
    const a = (rx - c.width / 2) / c.scale, b = -(ry - c.height / 2) / c.scale;
    const d = [0, 1, 2].map((i) => c.forward[i]! + c.right[i]! * a + c.up[i]! * b);
    const l = Math.hypot(d[0]!, d[1]!, d[2]!);
    return { origin: [...c.eye], dir: [d[0]! / l, d[1]! / l, d[2]! / l], tMin: 0 };
  }
  const sx = (rx - c.width / 2) / c.scale + c.cx;
  const sy = -(ry - c.height / 2) / c.scale + c.cy;
  const origin: Vec3 = [c.right[0] * sx + c.up[0] * sy, c.right[1] * sx + c.up[1] * sy, c.right[2] * sx + c.up[2] * sy];
  return { origin, dir: [...c.forward], tMin: -Infinity };
}

/** Output-image position of a world point in a view, or undefined when it lies behind a perspective camera's near plane. */
export function projectToImage(v: ViewCamera, p: Vec3): [number, number] | undefined {
  const c = v.cam;
  if (c.eye) {
    const d = [p[0] - c.eye[0], p[1] - c.eye[1], p[2] - c.eye[2]] as const;
    const vz = d[0] * c.forward[0] + d[1] * c.forward[1] + d[2] * c.forward[2];
    if (vz < NEAR) return undefined;
    const k = c.scale / vz;
    const vx = d[0] * c.right[0] + d[1] * c.right[1] + d[2] * c.right[2], vy = d[0] * c.up[0] + d[1] * c.up[1] + d[2] * c.up[2];
    return [v.ox + (vx * k + c.width / 2) / v.ss, v.oy + (-vy * k + c.height / 2) / v.ss];
  }
  const sx = p[0] * c.right[0] + p[1] * c.right[1] + p[2] * c.right[2];
  const sy = p[0] * c.up[0] + p[1] * c.up[1] + p[2] * c.up[2];
  return [v.ox + ((sx - c.cx) * c.scale + c.width / 2) / v.ss, v.oy + (-(sy - c.cy) * c.scale + c.height / 2) / v.ss];
}

const FACE_OF: [HitFace, HitFace][] = [["west", "east"], ["down", "up"], ["north", "south"]];

/**
 * Walks the voxels along a ray through the clip box (Amanatides–Woo) and calls `visit` for each
 * drawn position, nearest first, with the face the ray entered by. Stops when `visit` returns true.
 * `tMin` starts a half-line (a perspective ray starts at the eye); the default walks the whole line.
 */
export function marchRay(clip: Box, mask: Mask | undefined, origin: Vec3, dir: Vec3, visit: (p: Vec3, face: HitFace) => boolean, tMin = -Infinity): void {
  let t0 = -Infinity, t1 = Infinity, enterAxis = 0;
  for (let a = 0; a < 3; a++) {
    const d = dir[a]!, o = origin[a]!;
    if (Math.abs(d) < 1e-12) {
      if (o < clip.min[a]! || o >= clip.max[a]!) return;
      continue;
    }
    let ta = (clip.min[a]! - o) / d, tb = (clip.max[a]! - o) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    if (ta > t0) (t0 = ta), (enterAxis = a);
    t1 = Math.min(t1, tb);
  }
  if (tMin > t0) t0 = tMin;
  if (t0 >= t1) return;
  const start = origin.map((o, a) => o + dir[a]! * (t0 + 1e-6)) as Vec3;
  const p = start.map((v, a) => Math.min(clip.max[a]! - 1, Math.max(clip.min[a]!, Math.floor(v)))) as Vec3;
  const step = dir.map((d) => (d > 0 ? 1 : d < 0 ? -1 : 0));
  const tMax = dir.map((d, a) => (d > 0 ? (p[a]! + 1 - start[a]!) / d : d < 0 ? (p[a]! - start[a]!) / d : Infinity));
  const tDelta = dir.map((d) => (d ? Math.abs(1 / d) : Infinity));
  let face = FACE_OF[enterAxis]![dir[enterAxis]! > 0 ? 0 : 1];
  for (let guard = 0; guard < 100_000; guard++) {
    if (p.some((v, a) => v < clip.min[a]! || v >= clip.max[a]!)) return;
    if ((!mask || mask.has(p[0], p[1], p[2])) && visit([...p], face)) return;
    const a = tMax[0]! < tMax[1]! ? (tMax[0]! < tMax[2]! ? 0 : 2) : tMax[1]! < tMax[2]! ? 1 : 2;
    p[a] = p[a]! + step[a]!;
    tMax[a] = tMax[a]! + tDelta[a]!;
    face = FACE_OF[a]![step[a]! > 0 ? 0 : 1];
  }
}

/**
 * raycast: the first drawn, non-air block under an output pixel of a stored render (the n-th on a
 * peeled view: every block the ray enters is one more surface, as the renderer counts them).
 */
export function raycast(doc: Document, rec: RenderRecord, px: number, py: number): RayHit | undefined {
  const view = viewAt(rec, px, py);
  if (!view) return undefined;
  const { origin, dir, tMin } = pixelRay(view, px, py);
  let hit: RayHit = { view };
  let skip = (view.peel ?? 1) - 1;
  marchRay(
    view.clip,
    view.mask,
    origin,
    dir,
    (p, face) => {
      if (view.cut && !kept(view.cut, p[0], p[1], p[2])) return false;
      const state = doc.getState(p[0], p[1], p[2]);
      if (state === "minecraft:air") return false;
      if (skip-- > 0) return false;
      hit = { view, pos: p, state, face };
      return true;
    },
    tMin,
  );
  return hit;
}
