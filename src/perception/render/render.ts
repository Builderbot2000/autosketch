import type { RGB } from "../../palette/color.js";
import { textWidth } from "../../palette/font.js";
import { Image, type RGBA } from "../../palette/image.js";
import { formatBox, intersectBox, isEmptyBox, type Box } from "../../core/region.js";
import type { Facing } from "../../document/document.js";
import type { Document } from "../../document/document.js";
import type { BakedBlock, BakedQuad, BlockBaker } from "./bake.js";
import { basis, Raster, type Camera, type V3 } from "./raster.js";
import type { Face } from "../../assets/models.js";

/**
 * render (docs/design/06-perception.md): textured orthographic views of the document with axis
 * ticks, a ground grid and a compass, so pixels map back to block coordinates. Several views go
 * into one contact sheet.
 */

export const ISO_VIEWS = ["iso_se", "iso_sw", "iso_ne", "iso_nw"] as const;
export const VIEW_NAMES = [...ISO_VIEWS, "front", "back", "left", "right", "top"] as const;
export type ViewName = (typeof VIEW_NAMES)[number];
/** Custom camera: yaw = compass bearing of the camera from the build (0 north, 90 east…), pitch in degrees above the horizon. */
export type CustomView = { yaw: number; pitch: number };
export type View = ViewName | CustomView;

export interface RenderOptions {
  views?: View[];
  /** Local half-open box to draw (default: everything). */
  region?: Box;
  /** Hide everything above this y (inclusive limit), to look inside. */
  cutaway?: { maxY?: number };
  /** Output size in pixels (longest side). */
  size?: number;
  style?: "textured" | "flat";
}

export interface RenderResult {
  png: Buffer;
  width: number;
  height: number;
  caption: string;
}

export const DEFAULT_VIEWS: ViewName[] = ["iso_se", "iso_nw", "front", "top"];
const SS = 2; // supersampling factor
const BG_TOP: RGB = [205, 221, 236];
const BG_BOTTOM: RGB = [176, 194, 212];
const INK: RGBA = [32, 40, 52, 255];
const GRID: RGB = [70, 90, 110];

const OPPOSITE: Record<Face, Face> = { up: "down", down: "up", north: "south", south: "north", east: "west", west: "east" };
const DIR: Record<Face, V3> = { up: [0, 1, 0], down: [0, -1, 0], north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0] };
const FACING_VEC: Record<Facing, V3> = { south: [0, 0, 1], north: [0, 0, -1], east: [1, 0, 0], west: [-1, 0, 0] };

interface Scene {
  /** Local positions and baked blocks of everything drawn. */
  xs: Int32Array;
  ys: Int32Array;
  zs: Int32Array;
  baked: BakedBlock[];
  /** Tight local box of drawn blocks (half-open). */
  box: Box;
  /** Occluder lookup for culling (only blocks inside the drawn region count). */
  occluderAt: (x: number, y: number, z: number) => BakedBlock | undefined;
  fallbackIds: Set<string>;
}

export async function renderDocument(doc: Document, baker: BlockBaker, opts: RenderOptions = {}): Promise<RenderResult> {
  const views = opts.views?.length ? opts.views : DEFAULT_VIEWS;
  if (views.length > 4) throw new Error("render takes at most 4 views per call (they share one image)");
  const size = Math.min(1024, Math.max(128, Math.round(opts.size ?? (views.length > 1 ? 768 : 512))));
  const scene = await buildScene(doc, baker, opts);
  if (!scene) {
    const img = new Image(256, 64);
    img.fillRect(0, 0, 256, 64, [205, 221, 236, 255]);
    img.text("EMPTY", 100, 28, INK);
    return { png: img.encodePng(), width: 256, height: 64, caption: "Nothing to draw: the document (or the region) is empty." };
  }

  const cols = views.length === 1 ? 1 : 2;
  const rows = views.length <= 2 ? 1 : 2;
  const cellW = Math.floor(size / cols);
  const cellH = views.length === 2 ? Math.floor(size / 2) : Math.floor(size / rows);
  const out = new Image(cellW * cols, cellH * rows);
  const notes: string[] = [];
  views.forEach((v, i) => {
    const ox = (i % cols) * cellW, oy = Math.floor(i / cols) * cellH;
    const scale = drawView(out, ox, oy, cellW, cellH, v, scene, doc.meta.front, opts.style ?? "textured");
    notes.push(`${viewLabel(v)} ${scale.toFixed(1)} px/block`);
  });
  if (cols * rows > 1) {
    for (let i = 1; i < cols; i++) out.fillRect(i * cellW, 0, 1, out.height, [120, 135, 150, 255]);
    for (let i = 1; i < rows; i++) out.fillRect(0, i * cellH, out.width, 1, [120, 135, 150, 255]);
  }

  const n = scene.baked.length;
  const caption = [
    `render ${out.width}×${out.height} · ${notes.join(" · ")}`,
    `drew ${n.toLocaleString("en-US")} blocks in ${formatBox(scene.box)}${opts.cutaway?.maxY !== undefined ? ` (cutaway above y=${opts.cutaway.maxY})` : ""} · front=${doc.meta.front}`,
    "Ticks label block coordinates along the bottom edges; N marks north.",
    scene.fallbackIds.size ? `no model for ${[...scene.fallbackIds].slice(0, 5).join(", ")}${scene.fallbackIds.size > 5 ? " …" : ""} (drawn as magenta checker)` : "",
  ].filter(Boolean);
  return { png: out.encodePng(), width: out.width, height: out.height, caption: caption.join("\n") };
}

async function buildScene(doc: Document, baker: BlockBaker, opts: RenderOptions): Promise<Scene | undefined> {
  const bounds = doc.localBounds();
  if (!bounds) return undefined;
  let region = opts.region ? intersectBox(opts.region, bounds) : bounds;
  if (opts.cutaway?.maxY !== undefined) region = { min: region.min, max: [region.max[0], Math.min(region.max[1], opts.cutaway.maxY + 1), region.max[2]] };
  if (isEmptyBox(region)) return undefined;

  const xs: number[] = [], ys: number[] = [], zs: number[] = [], ids: number[] = [];
  doc.voxels.forEachInBox(doc.boxToStore(region), (sx, sy, sz, id) => {
    const [x, y, z] = doc.toLocal(sx, sy, sz);
    xs.push(x);
    ys.push(y);
    zs.push(z);
    ids.push(id);
  });
  if (!xs.length) return undefined;

  const distinct = [...new Set(ids)];
  const bakedById = new Map<number, BakedBlock>();
  await Promise.all(distinct.map(async (id) => bakedById.set(id, await baker.bake(doc.states.get(id)))));
  const fallbackIds = new Set(distinct.filter((id) => bakedById.get(id)!.fallback).map((id) => doc.states.get(id).split("[")[0]!));

  const box: Box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let i = 0; i < xs.length; i++) {
    box.min = [Math.min(box.min[0], xs[i]!), Math.min(box.min[1], ys[i]!), Math.min(box.min[2], zs[i]!)];
    box.max = [Math.max(box.max[0], xs[i]! + 1), Math.max(box.max[1], ys[i]! + 1), Math.max(box.max[2], zs[i]! + 1)];
  }
  const inRegion = (x: number, y: number, z: number) =>
    x >= region.min[0] && x < region.max[0] && y >= region.min[1] && y < region.max[1] && z >= region.min[2] && z < region.max[2];
  return {
    xs: Int32Array.from(xs),
    ys: Int32Array.from(ys),
    zs: Int32Array.from(zs),
    baked: ids.map((id) => bakedById.get(id)!),
    box,
    fallbackIds,
    occluderAt: (x, y, z) => {
      if (!inRegion(x, y, z)) return undefined;
      const [sx, sy, sz] = doc.toStore(x, y, z);
      const id = doc.voxels.get(sx, sy, sz);
      return id ? bakedById.get(id) : undefined;
    },
  };
}

function cameraFor(v: View, front: Facing): { toward: V3; upHint: V3; kind: "iso" | "elevation" | "top" } {
  if (typeof v === "object") {
    const yaw = (v.yaw * Math.PI) / 180, p = (Math.max(-89, Math.min(89, v.pitch)) * Math.PI) / 180;
    return { toward: [Math.sin(yaw) * Math.cos(p), Math.sin(p), -Math.cos(yaw) * Math.cos(p)], upHint: [0, 1, 0], kind: Math.abs(v.pitch) < 1 ? "elevation" : "iso" };
  }
  const h = Math.tan((30 * Math.PI) / 180) * Math.SQRT2;
  const F = FACING_VEC[front];
  // Seen by a viewer facing the front facade, their right hand points along (Fz, 0, -Fx)
  // (front = south → east), so the "right" facade is viewed from there and "left" from the opposite side.
  const rightSide: V3 = [F[2], 0, -F[0]];
  switch (v) {
    case "iso_se": return { toward: [1, h, 1], upHint: [0, 1, 0], kind: "iso" };
    case "iso_sw": return { toward: [-1, h, 1], upHint: [0, 1, 0], kind: "iso" };
    case "iso_ne": return { toward: [1, h, -1], upHint: [0, 1, 0], kind: "iso" };
    case "iso_nw": return { toward: [-1, h, -1], upHint: [0, 1, 0], kind: "iso" };
    case "front": return { toward: F, upHint: [0, 1, 0], kind: "elevation" };
    case "back": return { toward: [-F[0], 0, -F[2]], upHint: [0, 1, 0], kind: "elevation" };
    case "left": return { toward: [-rightSide[0], 0, -rightSide[2]], upHint: [0, 1, 0], kind: "elevation" };
    case "right": return { toward: rightSide, upHint: [0, 1, 0], kind: "elevation" };
    case "top": return { toward: [0, 1, 0], upHint: [0, 0, -1], kind: "top" };
  }
}

function viewLabel(v: View): string {
  return typeof v === "object" ? `yaw ${v.yaw} pitch ${v.pitch}` : v;
}

function drawView(out: Image, ox: number, oy: number, w: number, h: number, v: View, s: Scene, front: Facing, style: "textured" | "flat"): number {
  const { toward, upHint, kind } = cameraFor(v, front);
  const b = basis(toward, upHint);
  // Fit the drawn box (plus a little room for tick labels) into the cell.
  const corners: V3[] = [];
  for (const x of [s.box.min[0], s.box.max[0]]) for (const y of [s.box.min[1], s.box.max[1]]) for (const z of [s.box.min[2], s.box.max[2]]) corners.push([x, y, z]);
  const sxs = corners.map((c) => c[0] * b.right[0] + c[1] * b.right[1] + c[2] * b.right[2]);
  const sys = corners.map((c) => c[0] * b.up[0] + c[1] * b.up[1] + c[2] * b.up[2]);
  const margin = 26;
  const spanX = Math.max(1, Math.max(...sxs) - Math.min(...sxs)), spanY = Math.max(1, Math.max(...sys) - Math.min(...sys));
  const scale = Math.min((w - 2 * margin) / spanX, (h - 2 * margin - 10) / spanY);
  const cam: Camera = {
    ...b,
    scale: scale * SS,
    cx: (Math.max(...sxs) + Math.min(...sxs)) / 2,
    cy: (Math.max(...sys) + Math.min(...sys)) / 2 - 5 / scale,
    width: w * SS,
    height: h * SS,
  };
  const r = new Raster(w * SS, h * SS, cam);
  r.fillBackground(BG_TOP, BG_BOTTOM);
  if (kind !== "elevation") drawGrid(r, s.box, scale);

  // Opaque pass, collecting translucent quads for a sorted blended pass.
  const blended: { q: BakedQuad; x: number; y: number; z: number; d: number }[] = [];
  const fwd = b.forward;
  for (let i = 0; i < s.baked.length; i++) {
    const blk = s.baked[i]!;
    const x = s.xs[i]!, y = s.ys[i]!, z = s.zs[i]!;
    for (const q of blk.quads) {
      if (q.cull) {
        const d = DIR[q.cull];
        const nb = s.occluderAt(x + d[0], y + d[1], z + d[2]);
        // Hidden by an opaque neighbour, or between two blocks of the same translucent kind (glass, water).
        if (nb && (nb.occludes.has(OPPOSITE[q.cull]) || (nb === blk && blk.translucent))) continue;
      }
      if (facesAway(q, fwd)) continue;
      if (q.tex.translucent && style === "textured") {
        const c = (q.pos[0]! + q.pos[6]!) / 2 + x, cy = (q.pos[1]! + q.pos[7]!) / 2 + y, cz = (q.pos[2]! + q.pos[8]!) / 2 + z;
        blended.push({ q, x, y, z, d: c * fwd[0] + cy * fwd[1] + cz * fwd[2] });
        continue;
      }
      drawQuad(r, q, x, y, z, "opaque", style);
    }
  }
  blended.sort((a, c) => c.d - a.d);
  for (const e of blended) drawQuad(r, e.q, e.x, e.y, e.z, "blend", style);

  r.downsampleInto(out, ox, oy, SS);
  drawOverlays(out, ox, oy, w, h, r, s.box, kind, v, toward);
  return scale;
}

function facesAway(q: BakedQuad, fwd: V3): boolean {
  const p = q.pos;
  const ax = p[3]! - p[0]!, ay = p[4]! - p[1]!, az = p[5]! - p[2]!;
  const bx = p[9]! - p[0]!, by = p[10]! - p[1]!, bz = p[11]! - p[2]!;
  // Inward normal (see bake.ts normalOf); the face points away when its outward normal · forward > 0.
  const nx = -(ay * bz - az * by), ny = -(az * bx - ax * bz), nz = -(ax * by - ay * bx);
  return nx * fwd[0] + ny * fwd[1] + nz * fwd[2] > 1e-6;
}

function drawQuad(r: Raster, q: BakedQuad, x: number, y: number, z: number, mode: "opaque" | "blend", style: "textured" | "flat"): void {
  const p = q.pos;
  const P = [0, 1, 2, 3].map((i) => r.project(p[i * 3]! + x, p[i * 3 + 1]! + y, p[i * 3 + 2]! + z));
  const uv = q.uv;
  const flat = style === "flat" ? q.tex.mean : undefined;
  r.triangle(P[0]!, P[1]!, P[2]!, [uv[0]!, uv[1]!, uv[2]!, uv[3]!, uv[4]!, uv[5]!], q.tex.img, q.tint, q.shade, mode, flat);
  r.triangle(P[0]!, P[2]!, P[3]!, [uv[0]!, uv[1]!, uv[4]!, uv[5]!, uv[6]!, uv[7]!], q.tex.img, q.tint, q.shade, mode, flat);
}

/** Ground grid on the lowest layer's floor, every block when blocks are big enough, else every 4. */
function drawGrid(r: Raster, box: Box, scale: number): void {
  const y = box.min[1];
  const step = scale >= 7 ? 1 : scale >= 2 ? 4 : 16;
  const pad = 1;
  const x0 = box.min[0] - pad, x1 = box.max[0] + pad, z0 = box.min[2] - pad, z1 = box.max[2] + pad;
  const lw = Math.max(1, Math.round(SS / 2));
  for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) r.line(r.project(x, y, z0), r.project(x, y, z1), GRID, x % 16 === 0 ? 0.35 : 0.18, lw);
  for (let z = Math.ceil(z0 / step) * step; z <= z1; z += step) r.line(r.project(x0, y, z), r.project(x1, y, z), GRID, z % 16 === 0 ? 0.35 : 0.18, lw);
}

function tickStep(pxPerBlock: number): number {
  for (const s of [1, 2, 4, 8, 16, 32, 64, 128]) if (s * pxPerBlock >= 26) return s;
  return 256;
}

function drawOverlays(out: Image, ox: number, oy: number, w: number, h: number, r: Raster, box: Box, kind: string, v: View, toward: V3): void {
  const toPx = (x: number, y: number, z: number): [number, number] => {
    const p = r.project(x, y, z);
    return [ox + p[0] / SS, oy + p[1] / SS];
  };
  const centre = toPx((box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2);
  // Label rectangles already drawn (shared by all edges, so corner labels never overprint).
  const taken: [number, number, number, number][] = [];
  const label = (text: string, at: [number, number], away: [number, number], dist = 11): boolean => {
    const len = Math.hypot(away[0], away[1]) || 1;
    const tw = textWidth(text);
    const tx = Math.round(at[0] + (away[0] / len) * dist - tw / 2);
    const ty = Math.round(at[1] + (away[1] / len) * dist - 3);
    if (tx < ox + 1 || ty < oy + 1 || tx + tw > ox + w - 1 || ty + 7 > oy + h - 1) return false;
    if (taken.some(([x, y, ww, hh]) => tx < x + ww + 3 && tx + tw + 3 > x && ty < y + hh + 2 && ty + 7 + 2 > y)) return false;
    taken.push([tx, ty, tw, 7]);
    out.text(text, tx, ty, INK);
    return true;
  };
  const tick = (a: [number, number], away: [number, number]) => {
    const len = Math.hypot(away[0], away[1]) || 1;
    for (let k = 1; k <= 4; k++) out.fillRect(Math.round(a[0] + (away[0] / len) * k), Math.round(a[1] + (away[1] / len) * k), 1, 1, INK);
  };
  /** Ticks along one box edge: axis varies, the other two coordinates fixed. */
  const edge = (axis: 0 | 1 | 2, fixed: [number, number, number]) => {
    const lo = box.min[axis]!, hi = box.max[axis]! - 1;
    const a = toPx(...withAxis(fixed, axis, lo + 0.5)), b = toPx(...withAxis(fixed, axis, hi + 0.5));
    const px = Math.hypot(b[0] - a[0], b[1] - a[1]) / Math.max(1, hi - lo);
    const step = tickStep(px || 1);
    const mid = toPx(...withAxis(fixed, axis, (lo + hi + 1) / 2));
    // Offset labels perpendicular to the edge, on the side away from the build, so two edges
    // meeting at a corner push their labels apart.
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const outward: [number, number] = [mid[0] - centre[0], mid[1] - centre[1]];
    let away: [number, number] = Math.hypot(dx, dy) > 1e-3 ? [dy, -dx] : outward;
    if (away[0] * outward[0] + away[1] * outward[1] < 0) away = [-away[0], -away[1]];
    const values = new Set<number>([lo, hi]);
    for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) values.add(t);
    // Ends first so the range is always readable, then the round values in between.
    const order = [lo, hi, ...[...values].filter((t) => t !== lo && t !== hi).sort((p, q) => p - q)];
    for (const t of order) {
      const at = toPx(...withAxis(fixed, axis, t + 0.5));
      if (label(String(t), at, away)) tick(at, away);
    }
    // Axis name beyond the numbers, at the middle of the edge.
    label(["x", "y", "z"][axis]!.toUpperCase(), mid, away, 24);
  };
  const [x0, y0, z0] = box.min, [x1, y1, z1] = box.max;
  if (kind === "top") {
    edge(0, [0, y1, z0]); // x along the north edge
    edge(2, [x0, y1, 0]); // z along the west edge
  } else if (kind === "elevation") {
    // Horizontal axis along the bottom, y up the left side (as seen on screen).
    const horiz: 0 | 2 = Math.abs(toward[0]) > Math.abs(toward[2]) ? 2 : 0;
    const nearSide = horiz === 0 ? (toward[2] > 0 ? z1 : z0) : toward[0] > 0 ? x1 : x0;
    edge(horiz, horiz === 0 ? [0, y0, nearSide] : [nearSide, y0, 0]);
    // Pick the vertical edge that lands on the left of the image.
    const cand: [number, number, number][] = horiz === 0 ? [[x0, 0, nearSide], [x1, 0, nearSide]] : [[nearSide, 0, z0], [nearSide, 0, z1]];
    const left = cand.sort((p, q) => toPx(...p)[0] - toPx(...q)[0])[0]!;
    edge(1, left);
  } else {
    // Iso: the two bottom edges nearest the camera.
    const zNear = toward[2] > 0 ? z1 : z0, xNear = toward[0] > 0 ? x1 : x0;
    edge(0, [0, y0, zNear]);
    edge(2, [xNear, y0, 0]);
  }
  // View name and compass.
  out.text(viewLabel(v).replace(/_/g, " "), ox + 6, oy + 6, INK);
  const n = r.project(0, 0, -1), o = r.project(0, 0, 0);
  const nx = (n[0] - o[0]) / SS, ny = (n[1] - o[1]) / SS;
  const len = Math.hypot(nx, ny);
  const cx = ox + w - 18, cy = oy + 18;
  if (len > 0.15 * r.cam.scale / SS) {
    const ux = nx / len, uy = ny / len;
    for (let k = -9; k <= 9; k++) out.fillRect(Math.round(cx + ux * k), Math.round(cy + uy * k), 1, 1, k > 0 ? [190, 40, 40, 255] : [90, 100, 115, 255]);
    out.text("N", Math.round(cx + ux * 15 - 2), Math.round(cy + uy * 15 - 3), [190, 40, 40, 255]);
  } else {
    const facing = Math.abs(toward[0]) > Math.abs(toward[2]) ? (toward[0] > 0 ? "W" : "E") : toward[2] > 0 ? "N" : "S";
    out.text(`LOOKING ${facing}`, ox + w - 6 - textWidth(`LOOKING ${facing}`), oy + 6, INK);
  }
}

function withAxis(p: [number, number, number], axis: number, v: number): [number, number, number] {
  const q: [number, number, number] = [...p];
  q[axis] = v;
  return q;
}
