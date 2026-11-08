import type { RGB } from "../../palette/color.js";
import { textWidth } from "../../palette/font.js";
import { Image, type RGBA } from "../../palette/image.js";
import { Mask } from "../../core/mask.js";
import { formatBox, intersectBox, isEmptyBox, type Box, type Vec3 } from "../../core/region.js";
import type { Facing } from "../../document/document.js";
import type { Document } from "../../document/document.js";
import type { BakedBlock, BakedQuad, BlockBaker } from "./bake.js";
import { recordRender, type ViewCamera } from "./cameras.js";
import { basis, Raster, type Camera, type V3 } from "./raster.js";
import type { Face } from "../../assets/models.js";
import { analyzeStructure } from "../analyze.js";

/**
 * render (docs/design/06-perception.md): textured orthographic views of the document with axis
 * ticks, a ground grid and a compass, so pixels map back to block coordinates. Several views go
 * into one contact sheet. Each render's cameras are kept per document (cameras.ts) for raycast.
 *
 * Styles: textured, flat (mean colours), depth (flat colours darkened with distance) and xray
 * (translucent shell; highlighted blocks stay solid). Per-block flags (HIGHLIGHT, and CONTEXT
 * reserved for sandbox context volumes, 11) change how a block is drawn in any style.
 */

export const ISO_VIEWS = ["iso_se", "iso_sw", "iso_ne", "iso_nw"] as const;
export const VIEW_NAMES = [...ISO_VIEWS, "front", "back", "left", "right", "top"] as const;
export type ViewName = (typeof VIEW_NAMES)[number];
/**
 * Custom camera: yaw = compass bearing of the camera from the build (0 north, 90 east…), pitch in
 * degrees above the horizon. Views are orthographic, so `distance` sets the zoom (the view frames
 * a sphere of that many blocks around `target`) rather than perspective; `target` is the local
 * point the view centres on (default: the middle of what is drawn).
 */
export type CustomView = { yaw: number; pitch: number; distance?: number; target?: Vec3 };
/** "component:<id>" frames that component from the south-east. */
export type ComponentView = `component:${string}`;
export type View = ViewName | ComponentView | CustomView;
export type RenderStyle = "textured" | "flat" | "depth" | "xray";

/** Cut away part of the build to look inside: everything above maxY, or one side of a plane (at stays). */
export type Cutaway = { maxY: number } | { plane: "x" | "y" | "z"; at: number; keep: "west" | "east" | "down" | "up" | "north" | "south" };

export interface RenderOptions {
  views?: View[];
  /** What to draw: a local half-open box or a resolved selection mask (default: everything). */
  region?: Box | Mask;
  cutaway?: Cutaway;
  /** Output size in pixels (longest side). */
  size?: number;
  style?: RenderStyle;
  /** Positions to tint (a resolved selection or a diff). Highlighted air is outlined. */
  highlight?: Mask;
  overlays?: { components?: boolean; storeys?: boolean };
  /** Plain picture for a file thumbnail: transparent background, no grid, ticks, compass or caption room; size may go down to 32. Not recorded for raycast. */
  thumbnail?: boolean;
}

export interface RenderResult {
  png: Buffer;
  width: number;
  height: number;
  caption: string;
  /** Id of the stored cameras (for raycast), unless a thumbnail. */
  id?: string;
  views: ViewCamera[];
}

export const DEFAULT_VIEWS: ViewName[] = ["iso_se", "iso_nw", "front", "top"];
/** Per-block flags. */
export const HIGHLIGHT = 1;
/** Reserved for sandbox context volumes (11, silo F): drawn ghosted. */
export const CONTEXT = 2;

const SS = 2; // supersampling factor
const BG_TOP: RGB = [205, 221, 236];
const BG_BOTTOM: RGB = [176, 194, 212];
const INK: RGBA = [32, 40, 52, 255];
const GRID: RGB = [70, 90, 110];
const HL: [number, number, number, number] = [255, 140, 0, 0.5];
const STOREY: RGB = [200, 40, 60];

const OPPOSITE: Record<Face, Face> = { up: "down", down: "up", north: "south", south: "north", east: "west", west: "east" };
const DIR: Record<Face, V3> = { up: [0, 1, 0], down: [0, -1, 0], north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0] };
const FACING_VEC: Record<Facing, V3> = { south: [0, 0, 1], north: [0, 0, -1], east: [1, 0, 0], west: [-1, 0, 0] };

interface Scene {
  /** Local positions and baked blocks of everything drawn. */
  xs: Int32Array;
  ys: Int32Array;
  zs: Int32Array;
  baked: BakedBlock[];
  flags: Uint8Array;
  /** Tight local box of drawn blocks (half-open). */
  box: Box;
  /** The clip: what may be drawn. */
  clip: Box;
  mask?: Mask;
  /** Occluder lookup for culling (only blocks inside the drawn region count). */
  occluderAt: (x: number, y: number, z: number) => BakedBlock | undefined;
  fallbackIds: Set<string>;
  /** Highlighted positions that are air inside the clip (outlined). */
  airHighlights: Vec3[];
}

interface Label {
  text: string;
  at: V3;
}

export async function renderDocument(doc: Document, baker: BlockBaker, opts: RenderOptions = {}): Promise<RenderResult> {
  const views = opts.views?.length ? opts.views : DEFAULT_VIEWS;
  if (views.length > 4) throw new Error("render takes at most 4 views per call (they share one image)");
  const size = Math.min(1024, Math.max(opts.thumbnail ? 32 : 128, Math.round(opts.size ?? (views.length > 1 ? 768 : 512))));

  // One scene per distinct region (component views frame their own component).
  const scenes = new Map<string, Promise<Scene | undefined>>();
  const regionFor = (v: View): { key: string; region?: Box | Mask } => {
    if (typeof v === "string" && v.startsWith("component:")) {
      const id = v.slice("component:".length);
      const c = doc.componentLocal(id);
      if (!c) throw new Error(`no component "${id}"${doc.components.size ? ` (have: ${[...doc.components.keys()].join(", ")})` : ""}`);
      if (opts.region instanceof Mask) return { key: v, region: opts.region.clone().intersectWith(Mask.fromBox(c.box)) };
      return { key: v, region: opts.region ? intersectBox(opts.region, c.box) : c.box };
    }
    return { key: "", ...(opts.region ? { region: opts.region } : {}) };
  };
  const sceneOf = views.map((v) => {
    const { key, region } = regionFor(v);
    let p = scenes.get(key);
    if (!p) scenes.set(key, (p = buildScene(doc, baker, opts, region)));
    return p;
  });
  const sceneList = await Promise.all(sceneOf);
  if (sceneList.every((s) => !s)) {
    const img = new Image(256, 64);
    img.fillRect(0, 0, 256, 64, [205, 221, 236, 255]);
    img.text("EMPTY", 100, 28, INK);
    return { png: img.encodePng(), width: 256, height: 64, caption: "Nothing to draw: the document (or the region) is empty.", views: [] };
  }

  const cols = views.length === 1 ? 1 : 2;
  const rows = views.length <= 2 ? 1 : 2;
  const cellW = Math.floor(size / cols);
  const cellH = views.length === 2 ? Math.floor(size / 2) : Math.floor(size / rows);
  const out = new Image(cellW * cols, cellH * rows);
  const notes: string[] = [];
  const cams: ViewCamera[] = [];
  const style = opts.style ?? "textured";
  const storeys = opts.overlays?.storeys && !opts.thumbnail ? storeyLines(doc, opts.region) : undefined;
  views.forEach((v, i) => {
    const ox = (i % cols) * cellW, oy = Math.floor(i / cols) * cellH;
    const scene = sceneList[i];
    if (!scene) {
      out.fillRect(ox, oy, cellW, cellH, [205, 221, 236, 255]);
      out.text(`${viewLabel(v)}: EMPTY`, ox + 6, oy + 6, INK);
      notes.push(`${viewLabel(v)} empty`);
      return;
    }
    const labels: Label[] = [];
    if (opts.overlays?.components && !opts.thumbnail)
      for (const id of doc.components.keys()) {
        const c = doc.componentLocal(id)!;
        if (isEmptyBox(intersectBox(c.box, scene.box))) continue;
        labels.push({ text: id, at: [(c.box.min[0] + c.box.max[0]) / 2, c.box.max[1], (c.box.min[2] + c.box.max[2]) / 2] });
      }
    const r = drawView(out, ox, oy, cellW, cellH, v, scene, doc.meta.front, style, opts.thumbnail ?? false, labels, storeys);
    cams.push({ label: viewLabel(v), ox, oy, width: cellW, height: cellH, ss: SS, cam: r.cam, clip: scene.clip, ...(scene.mask ? { mask: scene.mask } : {}) });
    notes.push(`${viewLabel(v)} ${r.scale.toFixed(1)} px/block`);
  });
  if (cols * rows > 1) {
    for (let i = 1; i < cols; i++) out.fillRect(i * cellW, 0, 1, out.height, [120, 135, 150, 255]);
    for (let i = 1; i < rows; i++) out.fillRect(0, i * cellH, out.width, 1, [120, 135, 150, 255]);
  }

  const main = sceneList.find((s) => s)!;
  const n = main.baked.length;
  const fallback = new Set(sceneList.flatMap((s) => (s ? [...s.fallbackIds] : [])));
  const highlighted = opts.highlight ? main.flags.reduce((k, f) => k + (f & HIGHLIGHT ? 1 : 0), 0) + main.airHighlights.length : 0;
  const id = opts.thumbnail ? undefined : recordRender(doc, { revision: doc.revision, width: out.width, height: out.height, views: cams });
  const caption = [
    `render ${out.width}×${out.height} · ${notes.join(" · ")}${id ? ` · id ${id}` : ""}`,
    `drew ${n.toLocaleString("en-US")} blocks in ${formatBox(main.box)}${main.mask ? " (selection)" : ""}${cutawayText(opts.cutaway)}${style !== "textured" ? ` · style ${style}` : ""} · front=${doc.meta.front}`,
    opts.highlight ? `highlighted ${highlighted.toLocaleString("en-US")} position${highlighted === 1 ? "" : "s"} in orange${main.airHighlights.length ? ` (${main.airHighlights.length} now air, outlined)` : ""}` : "",
    storeys?.length ? `storey lines (red) at y=${storeys.map((s) => s.y).join(", ")}` : "",
    "Ticks label block coordinates along the bottom edges; N marks north.",
    id ? `raycast({view:"${id}", px, py}) names the block under a pixel.` : "",
    fallback.size ? `no model for ${[...fallback].slice(0, 5).join(", ")}${fallback.size > 5 ? " …" : ""} (drawn as magenta checker)` : "",
  ].filter(Boolean);
  return { png: out.encodePng(), width: out.width, height: out.height, caption: caption.join("\n"), ...(id ? { id } : {}), views: cams };
}

function cutawayText(c: Cutaway | undefined): string {
  if (!c) return "";
  if ("maxY" in c) return ` (cutaway above y=${c.maxY})`;
  return ` (cutaway: kept ${c.keep} of ${c.plane}=${c.at})`;
}

/** The clip box after a cutaway (the plane's own layer is kept). */
export function applyCutaway(region: Box, c: Cutaway | undefined): Box {
  if (!c) return region;
  const r: Box = { min: [...region.min], max: [...region.max] };
  if ("maxY" in c) {
    r.max[1] = Math.min(r.max[1], c.maxY + 1);
    return r;
  }
  const a = "xyz".indexOf(c.plane);
  const valid: Record<string, [string, string]> = { x: ["west", "east"], y: ["down", "up"], z: ["north", "south"] };
  const [low, high] = valid[c.plane]!;
  if (c.keep !== low && c.keep !== high) throw new Error(`cutaway plane ${c.plane} keeps "${low}" or "${high}" (got "${c.keep}")`);
  if (c.keep === low) r.max[a] = Math.min(r.max[a]!, c.at + 1);
  else r.min[a] = Math.max(r.min[a]!, c.at);
  return r;
}

async function buildScene(doc: Document, baker: BlockBaker, opts: RenderOptions, regionIn: Box | Mask | undefined): Promise<Scene | undefined> {
  const bounds = doc.localBounds();
  if (!bounds) return undefined;
  const mask = regionIn instanceof Mask ? regionIn : undefined;
  const regionBox = mask ? mask.bbox() : (regionIn as Box | undefined);
  if (mask && !regionBox) return undefined;
  const clip = applyCutaway(regionBox ? intersectBox(regionBox, bounds) : bounds, opts.cutaway);
  if (isEmptyBox(clip)) return undefined;
  const inClip = (x: number, y: number, z: number) =>
    x >= clip.min[0] && x < clip.max[0] && y >= clip.min[1] && y < clip.max[1] && z >= clip.min[2] && z < clip.max[2] && (!mask || mask.has(x, y, z));

  const xs: number[] = [], ys: number[] = [], zs: number[] = [], ids: number[] = [], flags: number[] = [];
  doc.voxels.forEachInBox(doc.boxToStore(clip), (sx, sy, sz, id) => {
    const [x, y, z] = doc.toLocal(sx, sy, sz);
    if (mask && !mask.has(x, y, z)) return;
    xs.push(x);
    ys.push(y);
    zs.push(z);
    ids.push(id);
    flags.push(opts.highlight?.has(x, y, z) ? HIGHLIGHT : 0);
  });
  if (!xs.length) return undefined;
  const airHighlights: Vec3[] = [];
  opts.highlight?.forEach((x, y, z) => {
    if (airHighlights.length < 2000 && inClip(x, y, z) && doc.getState(x, y, z) === "minecraft:air") airHighlights.push([x, y, z]);
  });

  const distinct = [...new Set(ids)];
  const bakedById = new Map<number, BakedBlock>();
  await Promise.all(distinct.map(async (id) => bakedById.set(id, await baker.bake(doc.states.get(id)))));
  const fallbackIds = new Set(distinct.filter((id) => bakedById.get(id)!.fallback).map((id) => doc.states.get(id).split("[")[0]!));

  const box: Box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let i = 0; i < xs.length; i++) {
    box.min = [Math.min(box.min[0], xs[i]!), Math.min(box.min[1], ys[i]!), Math.min(box.min[2], zs[i]!)];
    box.max = [Math.max(box.max[0], xs[i]! + 1), Math.max(box.max[1], ys[i]! + 1), Math.max(box.max[2], zs[i]! + 1)];
  }
  const baked = ids.map((id) => bakedById.get(id)!);
  // Blocks drawn from their NBT (09: a framed block with its camo) bake per position.
  if (doc.blockEntities.size && baker.hasRenderHooks)
    await Promise.all(
      xs.map(async (x, i) => {
        const nbt = doc.getBlockEntity(x, ys[i]!, zs[i]!);
        if (nbt) baked[i] = await baker.bakeAt([x, ys[i]!, zs[i]!], doc.states.get(ids[i]!), nbt);
      }),
    );
  return {
    xs: Int32Array.from(xs),
    ys: Int32Array.from(ys),
    zs: Int32Array.from(zs),
    baked,
    flags: Uint8Array.from(flags),
    box,
    clip,
    ...(mask ? { mask } : {}),
    fallbackIds,
    airHighlights,
    occluderAt: (x, y, z) => {
      if (!inClip(x, y, z)) return undefined;
      const [sx, sy, sz] = doc.toStore(x, y, z);
      const id = doc.voxels.get(sx, sy, sz);
      return id ? bakedById.get(id) : undefined;
    },
  };
}

/** Storey floor lines from analysis (empty when nothing structural is found). */
function storeyLines(doc: Document, region: Box | Mask | undefined): { y: number; box: Box }[] {
  try {
    const a = analyzeStructure(doc, region ? { region } : {});
    return a.storeys.map((s) => ({ y: s.floorY, box: s.box }));
  } catch {
    return [];
  }
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
  if (v.startsWith("component:")) return { toward: [1, h, 1], upHint: [0, 1, 0], kind: "iso" };
  switch (v as ViewName) {
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
  if (typeof v === "object") return `yaw ${v.yaw} pitch ${v.pitch}${v.distance !== undefined ? ` dist ${v.distance}` : ""}`;
  return v;
}

/** How one block is drawn, from the style and its flags. */
interface Look {
  flat?: RGB;
  overlay?: [number, number, number, number];
  mode: "opaque" | "blend";
  alpha: number;
}

function drawView(
  out: Image, ox: number, oy: number, w: number, h: number, v: View, s: Scene, front: Facing, style: RenderStyle, thumbnail: boolean,
  labels: Label[], storeys: { y: number; box: Box }[] | undefined,
): { scale: number; cam: Camera } {
  const { toward, upHint, kind } = cameraFor(v, front);
  const b = basis(toward, upHint);
  // Fit the drawn box (plus a little room for tick labels) into the cell.
  const corners: V3[] = [];
  for (const x of [s.box.min[0], s.box.max[0]]) for (const y of [s.box.min[1], s.box.max[1]]) for (const z of [s.box.min[2], s.box.max[2]]) corners.push([x, y, z]);
  const sxs = corners.map((c) => c[0] * b.right[0] + c[1] * b.right[1] + c[2] * b.right[2]);
  const sys = corners.map((c) => c[0] * b.up[0] + c[1] * b.up[1] + c[2] * b.up[2]);
  const margin = thumbnail ? 2 : 26;
  const capRoom = thumbnail ? 0 : 10;
  const spanX = Math.max(1, Math.max(...sxs) - Math.min(...sxs)), spanY = Math.max(1, Math.max(...sys) - Math.min(...sys));
  let scale = Math.min((w - 2 * margin) / spanX, (h - 2 * margin - capRoom) / spanY);
  let cx = (Math.max(...sxs) + Math.min(...sxs)) / 2, cy = (Math.max(...sys) + Math.min(...sys)) / 2;
  if (typeof v === "object") {
    if (v.distance !== undefined) {
      if (!(v.distance > 0)) throw new Error("camera distance must be > 0 (blocks framed around the target)");
      scale = Math.min(w - 2 * margin, h - 2 * margin - capRoom) / (2 * v.distance);
    }
    if (v.target) {
      const t: V3 = [v.target[0] + 0.5, v.target[1] + 0.5, v.target[2] + 0.5];
      cx = t[0] * b.right[0] + t[1] * b.right[1] + t[2] * b.right[2];
      cy = t[0] * b.up[0] + t[1] * b.up[1] + t[2] * b.up[2];
    }
  }
  const cam: Camera = { ...b, scale: scale * SS, cx, cy: cy - capRoom / 2 / scale, width: w * SS, height: h * SS };
  const r = new Raster(w * SS, h * SS, cam);
  if (!thumbnail) r.fillBackground(BG_TOP, BG_BOTTOM);
  if (!thumbnail && kind !== "elevation") drawGrid(r, s.box, scale);

  // Depth range for the depth style.
  const ds = corners.map((c) => c[0] * b.forward[0] + c[1] * b.forward[1] + c[2] * b.forward[2]);
  const dmin = Math.min(...ds), dspan = Math.max(1e-6, Math.max(...ds) - dmin);
  const lookOf = (flags: number, q: BakedQuad, x: number, y: number, z: number): Look => {
    const hl = flags & HIGHLIGHT ? HL : undefined;
    if (style === "xray") return hl ? { flat: q.tex.mean, overlay: hl, mode: "opaque", alpha: 1 } : { flat: q.tex.mean, mode: "blend", alpha: 0.28 };
    if (style === "depth") {
      const c = (q.pos[0]! + q.pos[6]!) / 2 + x, cy2 = (q.pos[1]! + q.pos[7]!) / 2 + y, cz = (q.pos[2]! + q.pos[8]!) / 2 + z;
      const t = (c * b.forward[0] + cy2 * b.forward[1] + cz * b.forward[2] - dmin) / dspan;
      const k = 1 - 0.7 * Math.min(1, Math.max(0, t));
      const m = q.tex.mean;
      return { flat: [m[0] * k, m[1] * k, m[2] * k], ...(hl ? { overlay: hl } : {}), mode: "opaque", alpha: 1 };
    }
    return { ...(style === "flat" ? { flat: q.tex.mean } : {}), ...(hl ? { overlay: hl } : {}), mode: q.tex.translucent && style === "textured" ? "blend" : "opaque", alpha: 1 };
  };

  // Opaque pass, collecting blended quads for a sorted second pass.
  const blended: { q: BakedQuad; x: number; y: number; z: number; d: number; look: Look }[] = [];
  const fwd = b.forward;
  for (let i = 0; i < s.baked.length; i++) {
    const blk = s.baked[i]!;
    const x = s.xs[i]!, y = s.ys[i]!, z = s.zs[i]!;
    const flags = s.flags[i]!;
    for (const q of blk.quads) {
      if (q.cull) {
        const d = DIR[q.cull];
        const nb = s.occluderAt(x + d[0], y + d[1], z + d[2]);
        // Hidden by an opaque neighbour, or between two blocks of the same translucent kind (glass, water).
        if (nb && (nb.occludes.has(OPPOSITE[q.cull]) || (nb === blk && blk.translucent))) continue;
      }
      const look = lookOf(flags, q, x, y, z);
      // X-ray shows the far side of the shell through the near side.
      if (!(style === "xray" && look.mode === "blend") && facesAway(q, fwd)) continue;
      if (look.mode === "blend") {
        const c = (q.pos[0]! + q.pos[6]!) / 2 + x, cy2 = (q.pos[1]! + q.pos[7]!) / 2 + y, cz = (q.pos[2]! + q.pos[8]!) / 2 + z;
        blended.push({ q, x, y, z, d: c * fwd[0] + cy2 * fwd[1] + cz * fwd[2], look });
        continue;
      }
      drawQuad(r, q, x, y, z, look);
    }
  }
  blended.sort((a, c) => c.d - a.d);
  for (const e of blended) drawQuad(r, e.q, e.x, e.y, e.z, e.look);

  // Highlighted positions that are air (e.g. blocks a diff removed): orange wire cubes.
  const lw = Math.max(1, Math.round(SS / 2));
  for (const [x, y, z] of s.airHighlights)
    for (const [a, c] of CUBE_EDGES) r.line(r.project(x + a[0], y + a[1], z + a[2]), r.project(x + c[0], y + c[1], z + c[2]), [255, 140, 0], 0.9, lw, true);

  // Storey lines: the footprint outline at each floor level.
  const storeyLabels: Label[] = [];
  for (const st of storeys ?? []) {
    const { min, max } = st.box;
    const yy = st.y + 1;
    const pts: V3[] = [[min[0], yy, min[2]], [max[0], yy, min[2]], [max[0], yy, max[2]], [min[0], yy, max[2]]];
    for (let k = 0; k < 4; k++) r.line(r.project(...pts[k]!), r.project(...pts[(k + 1) % 4]!), STOREY, 0.85, lw + 1);
    storeyLabels.push({ text: `y=${st.y}`, at: [min[0], yy, max[2]] });
  }

  r.downsampleInto(out, ox, oy, SS, thumbnail);
  if (!thumbnail) drawOverlays(out, ox, oy, w, h, r, s.box, kind, v, toward, [...labels, ...storeyLabels]);
  return { scale, cam };
}

const CUBE_EDGES: [V3, V3][] = [
  [[0, 0, 0], [1, 0, 0]], [[0, 0, 1], [1, 0, 1]], [[0, 1, 0], [1, 1, 0]], [[0, 1, 1], [1, 1, 1]],
  [[0, 0, 0], [0, 1, 0]], [[1, 0, 0], [1, 1, 0]], [[0, 0, 1], [0, 1, 1]], [[1, 0, 1], [1, 1, 1]],
  [[0, 0, 0], [0, 0, 1]], [[1, 0, 0], [1, 0, 1]], [[0, 1, 0], [0, 1, 1]], [[1, 1, 0], [1, 1, 1]],
];

function facesAway(q: BakedQuad, fwd: V3): boolean {
  const p = q.pos;
  const ax = p[3]! - p[0]!, ay = p[4]! - p[1]!, az = p[5]! - p[2]!;
  const bx = p[9]! - p[0]!, by = p[10]! - p[1]!, bz = p[11]! - p[2]!;
  // Inward normal (see bake.ts normalOf); the face points away when its outward normal · forward > 0.
  const nx = -(ay * bz - az * by), ny = -(az * bx - ax * bz), nz = -(ax * by - ay * bx);
  return nx * fwd[0] + ny * fwd[1] + nz * fwd[2] > 1e-6;
}

function drawQuad(r: Raster, q: BakedQuad, x: number, y: number, z: number, look: Look): void {
  const p = q.pos;
  const P = [0, 1, 2, 3].map((i) => r.project(p[i * 3]! + x, p[i * 3 + 1]! + y, p[i * 3 + 2]! + z));
  const uv = q.uv;
  r.triangle(P[0]!, P[1]!, P[2]!, [uv[0]!, uv[1]!, uv[2]!, uv[3]!, uv[4]!, uv[5]!], q.tex.img, q.tint, q.shade, look.mode, look.flat, look.overlay, look.alpha);
  r.triangle(P[0]!, P[2]!, P[3]!, [uv[0]!, uv[1]!, uv[4]!, uv[5]!, uv[6]!, uv[7]!], q.tex.img, q.tint, q.shade, look.mode, look.flat, look.overlay, look.alpha);
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

function drawOverlays(out: Image, ox: number, oy: number, w: number, h: number, r: Raster, box: Box, kind: string, v: View, toward: V3, extra: Label[]): void {
  const toPx = (x: number, y: number, z: number): [number, number] => {
    const p = r.project(x, y, z);
    return [ox + p[0] / SS, oy + p[1] / SS];
  };
  const centre = toPx((box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2);
  // Label rectangles already drawn (shared by all edges, so corner labels never overprint).
  const taken: [number, number, number, number][] = [];
  const label = (text: string, at: [number, number], away: [number, number], dist = 11, color: RGBA = INK, backdrop = false): boolean => {
    const len = Math.hypot(away[0], away[1]) || 1;
    const tw = textWidth(text);
    const tx = Math.round(at[0] + (away[0] / len) * dist - tw / 2);
    const ty = Math.round(at[1] + (away[1] / len) * dist - 3);
    if (tx < ox + 1 || ty < oy + 1 || tx + tw > ox + w - 1 || ty + 7 > oy + h - 1) return false;
    if (taken.some(([x, y, ww, hh]) => tx < x + ww + 3 && tx + tw + 3 > x && ty < y + hh + 2 && ty + 7 + 2 > y)) return false;
    taken.push([tx, ty, tw, 7]);
    if (backdrop) out.fillRect(tx - 2, ty - 2, tw + 4, 11, [255, 255, 255, 255]);
    out.text(text, tx, ty, color);
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
  // Component labels and storey levels, with a backdrop so they read over blocks.
  for (const l of extra) label(l.text, toPx(...l.at), [0, -1], 8, l.text.startsWith("y=") ? [200, 40, 60, 255] : INK, true);
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
