import type { RGB } from "../../palette/color.js";
import { textWidth } from "../../palette/font.js";
import { Image, type RGBA } from "../../palette/image.js";
import { Mask } from "../../core/mask.js";
import { formatBox, intersectBox, isEmptyBox, type Box, type Vec3 } from "../../core/region.js";
import type { Facing } from "../../document/document.js";
import type { Document } from "../../document/document.js";
import { DEFAULT_FOV, getCamera } from "../../document/cameras.js";
import type { BakedBlock, BakedQuad, BlockBaker } from "./bake.js";
import { kept, recordRender, type Cut, type ViewCamera } from "./cameras.js";
import { basis, NEAR, Raster, type Camera, type V3 } from "./raster.js";
import type { Face } from "../../assets/models.js";

/**
 * render (docs/design/06-perception.md): textured orthographic views of the document with axis
 * ticks, a ground grid and a compass, so pixels map back to block coordinates, and perspective
 * views from an eye (06, *Cameras*), captioned with eye, target and fov instead of ticks. Several
 * views go into one contact sheet. Each render's cameras are kept per document (cameras.ts) for
 * raycast.
 *
 * Styles: textured, flat (mean colours), depth (flat colours darkened with distance) and xray
 * (translucent shell; highlighted blocks stay solid). Per-block flags (HIGHLIGHT, and CONTEXT for
 * a sandbox's read-only context volume, 11) change how a block is drawn in any style.
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
/**
 * Perspective camera (06, *Cameras*): eye and target in local block units, where an integer is the
 * block's centre (as saved cameras, document/cameras.ts); `fov` is vertical, in degrees (default
 * 70). `frame` is a local half-open box to fit: without `fov`, the fov is chosen so it fills the
 * view (a selection target is framed). `label` names the view in the caption.
 */
export type PerspectiveView = { eye: Vec3; target: Vec3; fov?: number; frame?: Box; label?: string };
/** A camera saved on the document (`camera` tool, document/cameras.ts). */
export type SavedCameraView = { camera: string };
export type View = ViewName | ComponentView | CustomView | PerspectiveView | SavedCameraView;
type OrthoView = ViewName | ComponentView | CustomView;
export type RenderStyle = "textured" | "flat" | "depth" | "xray";
export type ContextMode = "ghost" | "normal" | "hide";

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
  overlays?: { components?: boolean };
  /**
   * How a sandbox's context volume (`doc.context`, 11) is drawn: ghost (default: desaturated and
   * translucent, never hiding editable blocks), normal, or hide. Ignored outside a sandbox.
   */
  context?: ContextMode;
  /**
   * Near clip (06, *Cameras*): blocks whose centre is nearer than this many blocks are not drawn
   * and hide nothing, so cut faces draw closed. Perspective: measured from the eye along the view;
   * orthographic: from the front of the drawn box.
   */
  near?: number;
  /** Section box (06, *Cameras*): only blocks inside it are drawn, like `region`, composing with it and with `cutaway`. */
  section?: Box | Mask;
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
/** A sandbox's read-only context volume (11): drawn ghosted. */
export const CONTEXT = 2;

const SS = 2; // supersampling factor
const BG_TOP: RGB = [205, 221, 236];
const BG_BOTTOM: RGB = [176, 194, 212];
const INK: RGBA = [32, 40, 52, 255];
const GRID: RGB = [70, 90, 110];
const HL: [number, number, number, number] = [255, 140, 0, 0.5];

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
  /** Ghosted context positions: they never hide the faces of editable blocks. */
  ghost?: Mask;
  /** Context blocks drawn. */
  contextBlocks: number;
}

interface Label {
  text: string;
  at: V3;
}

export const isPerspective = (v: View): v is PerspectiveView => typeof v === "object" && "eye" in v;

/** Replaces `{camera: name}` views with the saved camera (document/cameras.ts). */
function resolveSaved(doc: Document, v: View): OrthoView | PerspectiveView {
  if (typeof v !== "object" || !("camera" in v)) return v;
  const c = getCamera(doc, v.camera);
  if (!c) throw new Error(`no saved camera "${v.camera}"${doc.cameras.size ? ` (have: ${[...doc.cameras.keys()].sort().join(", ")})` : "; save one with the camera tool"}`);
  return { ...c, label: `camera ${v.camera}` };
}

export async function renderDocument(doc: Document, baker: BlockBaker, opts: RenderOptions = {}): Promise<RenderResult> {
  const views = (opts.views?.length ? opts.views : DEFAULT_VIEWS).map((v) => resolveSaved(doc, v));
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
    const r = isPerspective(v)
      ? drawPerspective(out, ox, oy, cellW, cellH, v, scene, style, labels, opts.near)
      : drawView(out, ox, oy, cellW, cellH, v, scene, doc.meta.front, style, opts.thumbnail ?? false, labels, opts.near);
    cams.push({ label: viewLabel(v), ox, oy, width: cellW, height: cellH, ss: SS, cam: r.cam, clip: scene.clip, ...(scene.mask ? { mask: scene.mask } : {}), ...(r.cut ? { cut: r.cut } : {}) });
    notes.push(isPerspective(v) ? perspectiveText(v, r.fov!) : `${viewLabel(v)} ${r.scale.toFixed(1)} px/block`);
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
    `drew ${n.toLocaleString("en-US")} blocks in ${formatBox(main.box)}${main.mask ? " (selection)" : ""}${cutawayText(opts.cutaway)}${style !== "textured" ? ` · style ${style}` : ""} · front=${doc.meta.front}` +
      (opts.section ? ` · section ${opts.section instanceof Mask ? `selection in ${formatBox(opts.section.bbox() ?? { min: [0, 0, 0], max: [0, 0, 0] })}` : formatBox(opts.section)}` : "") +
      (opts.near ? ` · near clip ${opts.near} (blocks nearer are not drawn)` : ""),
    opts.highlight ? `highlighted ${highlighted.toLocaleString("en-US")} position${highlighted === 1 ? "" : "s"} in orange${main.airHighlights.length ? ` (${main.airHighlights.length} now air, outlined)` : ""}` : "",
    main.contextBlocks ? `${main.contextBlocks.toLocaleString("en-US")} read-only context blocks${opts.context === "normal" ? " drawn normally" : " ghosted (grey, translucent)"}` : "",
    doc.context && opts.context === "hide" ? "context hidden" : "",
    views.every(isPerspective) ? "Perspective views carry no ticks: the caption gives eye, target and fov." : "Ticks label block coordinates along the bottom edges; N marks north.",
    id ? `raycast({view:"${id}", px, py}) names the block under a pixel.` : "",
    fallback.size ? `no model for ${[...fallback].slice(0, 5).join(", ")}${fallback.size > 5 ? " …" : ""} (drawn as magenta checker)` : "",
  ].filter(Boolean);
  return { png: out.encodePng(), width: out.width, height: out.height, caption: caption.join("\n"), ...(id ? { id } : {}), views: cams };
}

/** Context blocks: desaturated toward a light grey (11, ghosted context). */
function ghostColour(m: RGB): RGB {
  const g = 0.3 * m[0] + 0.59 * m[1] + 0.11 * m[2];
  return [g * 0.5 + 200 * 0.5, g * 0.5 + 205 * 0.5, g * 0.5 + 215 * 0.5];
}

function cutawayText(c: Cutaway | undefined): string {
  if (!c) return "";
  if ("maxY" in c) return ` (cutaway above y=${c.maxY})`;
  return ` (cutaway: kept ${c.keep} of ${c.plane}=${c.at})`;
}

/** Two regions' intersection (either may be a box or a mask; no first region = everything). */
function intersectRegion(a: Box | Mask | undefined, b: Box | Mask): Box | Mask {
  if (!a) return b;
  if (!(a instanceof Mask) && !(b instanceof Mask)) return intersectBox(a, b);
  const m = a instanceof Mask ? a.clone() : Mask.fromBox(a);
  return m.intersectWith(b instanceof Mask ? b : Mask.fromBox(b));
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
  if (opts.section) regionIn = intersectRegion(regionIn, opts.section);
  const mask = regionIn instanceof Mask ? regionIn : undefined;
  const regionBox = mask ? mask.bbox() : (regionIn as Box | undefined);
  if (mask && !regionBox) return undefined;
  const clip = applyCutaway(regionBox ? intersectBox(regionBox, bounds) : bounds, opts.cutaway);
  if (isEmptyBox(clip)) return undefined;
  const ctxMode = opts.context ?? "ghost";
  const context = doc.context && !doc.context.isEmpty() ? doc.context : undefined;
  const hidden = ctxMode === "hide" ? context : undefined;
  const inClip = (x: number, y: number, z: number) =>
    x >= clip.min[0] && x < clip.max[0] && y >= clip.min[1] && y < clip.max[1] && z >= clip.min[2] && z < clip.max[2] && (!mask || mask.has(x, y, z)) && !hidden?.has(x, y, z);

  const xs: number[] = [], ys: number[] = [], zs: number[] = [], ids: number[] = [], flags: number[] = [];
  let contextBlocks = 0;
  doc.voxels.forEachInBox(doc.boxToStore(clip), (sx, sy, sz, id) => {
    const [x, y, z] = doc.toLocal(sx, sy, sz);
    if (mask && !mask.has(x, y, z)) return;
    const inContext = context?.has(x, y, z) ?? false;
    if (inContext && hidden) return;
    if (inContext) contextBlocks++;
    xs.push(x);
    ys.push(y);
    zs.push(z);
    ids.push(id);
    flags.push((opts.highlight?.has(x, y, z) ? HIGHLIGHT : 0) | (inContext && ctxMode === "ghost" ? CONTEXT : 0));
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
    ...(context && ctxMode === "ghost" ? { ghost: context } : {}),
    contextBlocks,
    occluderAt: (x, y, z) => {
      if (!inClip(x, y, z)) return undefined;
      const [sx, sy, sz] = doc.toStore(x, y, z);
      const id = doc.voxels.get(sx, sy, sz);
      return id ? bakedById.get(id) : undefined;
    },
  };
}

function cameraFor(v: OrthoView, front: Facing): { toward: V3; upHint: V3; kind: "iso" | "elevation" | "top" } {
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

/** Caption text of a perspective view: eye, target and fov (block units, integer = block centre). */
function perspectiveText(v: PerspectiveView, fov: number): string {
  const f = (p: Vec3) => `(${p.map((n) => +n.toFixed(2)).join(",")})`;
  return `${viewLabel(v)}: eye ${f(v.eye)} target ${f(v.target)} fov ${+fov.toFixed(1)}°`;
}

function viewLabel(v: View): string {
  if (typeof v === "object" && "camera" in v) return `camera ${v.camera}`;
  if (isPerspective(v)) return v.label ?? "perspective";
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
  out: Image, ox: number, oy: number, w: number, h: number, v: OrthoView, s: Scene, front: Facing, style: RenderStyle, thumbnail: boolean,
  labels: Label[], near?: number,
): { scale: number; cam: Camera; fov?: number; cut?: Cut } {
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
  const fwd = b.forward;
  const depthOf = (c: number, cy2: number, cz: number) => c * fwd[0] + cy2 * fwd[1] + cz * fwd[2];
  // Near clip: measured from the front of the drawn box.
  const cut: Cut | undefined = near ? { normal: [...fwd], d: dmin + near } : undefined;
  drawBlocks(
    s, style, (c, cy2, cz) => (c * b.forward[0] + cy2 * b.forward[1] + cz * b.forward[2] - dmin) / dspan, (q) => facesAway(q, fwd), depthOf,
    (q, x, y, z, look) => drawQuad(r, q, x, y, z, look), cut,
  );

  // Highlighted positions that are air (e.g. blocks a diff removed): orange wire cubes.
  const lw = Math.max(1, Math.round(SS / 2));
  for (const [x, y, z] of s.airHighlights) {
    if (cut && !kept(cut, x, y, z)) continue;
    for (const [a, c] of CUBE_EDGES) r.line(r.project(x + a[0], y + a[1], z + a[2]), r.project(x + c[0], y + c[1], z + c[2]), [255, 140, 0], 0.9, lw, true);
  }

  r.downsampleInto(out, ox, oy, SS, thumbnail);
  if (!thumbnail) drawOverlays(out, ox, oy, w, h, r, s.box, kind, v, toward, labels);
  return { scale, cam, ...(cut ? { cut } : {}) };
}


/** How a quad looks in a style, given its flags; `depthT` maps a world point to 0 (near) .. 1 (far) for the depth style. */
function lookFor(style: RenderStyle, depthT: (x: number, y: number, z: number) => number) {
  return (flags: number, q: BakedQuad, x: number, y: number, z: number): Look => {
    const hl = flags & HIGHLIGHT ? HL : undefined;
    if (flags & CONTEXT) return { flat: ghostColour(q.tex.mean), ...(hl ? { overlay: hl } : {}), mode: "blend", alpha: 0.3 };
    if (style === "xray") return hl ? { flat: q.tex.mean, overlay: hl, mode: "opaque", alpha: 1 } : { flat: q.tex.mean, mode: "blend", alpha: 0.28 };
    if (style === "depth") {
      const c = (q.pos[0]! + q.pos[6]!) / 2 + x, cy2 = (q.pos[1]! + q.pos[7]!) / 2 + y, cz = (q.pos[2]! + q.pos[8]!) / 2 + z;
      const t = depthT(c, cy2, cz);
      const k = 1 - 0.7 * Math.min(1, Math.max(0, t));
      const m = q.tex.mean;
      return { flat: [m[0] * k, m[1] * k, m[2] * k], ...(hl ? { overlay: hl } : {}), mode: "opaque", alpha: 1 };
    }
    return { ...(style === "flat" ? { flat: q.tex.mean } : {}), ...(hl ? { overlay: hl } : {}), mode: q.tex.translucent && style === "textured" ? "blend" : "opaque", alpha: 1 };
  };
}

/**
 * Draws the scene's blocks: culls faces against neighbours (block-level occlusion) and faces turned
 * away from the camera (`away`), draws opaque quads, then blended quads sorted far to near by
 * `depthOf` (a world point's distance along the view).
 */
function drawBlocks(
  s: Scene, style: RenderStyle, depthT: (x: number, y: number, z: number) => number, away: (q: BakedQuad, x: number, y: number, z: number) => boolean,
  depthOf: (x: number, y: number, z: number) => number, draw: (q: BakedQuad, x: number, y: number, z: number, look: Look) => void, cut?: Cut,
): void {
  const lookOf = lookFor(style, depthT);
  // Opaque pass, collecting blended quads for a sorted second pass.
  const blended: { q: BakedQuad; x: number; y: number; z: number; d: number; look: Look }[] = [];
  for (let i = 0; i < s.baked.length; i++) {
    const blk = s.baked[i]!;
    const x = s.xs[i]!, y = s.ys[i]!, z = s.zs[i]!;
    // Near clip: dropped blocks are not drawn and hide nothing (cut faces draw closed).
    if (cut && !kept(cut, x, y, z)) continue;
    const flags = s.flags[i]!;
    for (const q of blk.quads) {
      if (q.cull) {
        const d = DIR[q.cull];
        const nb = cut && !kept(cut, x + d[0], y + d[1], z + d[2]) ? undefined : s.occluderAt(x + d[0], y + d[1], z + d[2]);
        // A ghosted context block never hides an editable block's face (11).
        const seeThrough = s.ghost && !(flags & CONTEXT) && s.ghost.has(x + d[0], y + d[1], z + d[2]);
        // Hidden by an opaque neighbour, or between two blocks of the same translucent kind (glass, water).
        if (nb && !seeThrough && (nb.occludes.has(OPPOSITE[q.cull]) || (nb === blk && blk.translucent))) continue;
      }
      const look = lookOf(flags, q, x, y, z);
      // X-ray shows the far side of the shell through the near side.
      if (!(style === "xray" && look.mode === "blend") && away(q, x, y, z)) continue;
      if (look.mode === "blend") {
        const c = (q.pos[0]! + q.pos[6]!) / 2 + x, cy2 = (q.pos[1]! + q.pos[7]!) / 2 + y, cz = (q.pos[2]! + q.pos[8]!) / 2 + z;
        blended.push({ q, x, y, z, d: depthOf(c, cy2, cz), look });
        continue;
      }
      draw(q, x, y, z, look);
    }
  }
  blended.sort((a, c) => c.d - a.d);
  for (const e of blended) draw(e.q, e.x, e.y, e.z, e.look);
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
  // Perspective lines are clipped to the near plane first.
  const line = (a: V3, b: V3, alpha: number) => (r.persp ? segment(r, a, b, GRID, alpha, lw, false) : r.line(r.project(...a), r.project(...b), GRID, alpha, lw));
  for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) line([x, y, z0], [x, y, z1], x % 16 === 0 ? 0.35 : 0.18);
  for (let z = Math.ceil(z0 / step) * step; z <= z1; z += step) line([x0, y, z], [x1, y, z], z % 16 === 0 ? 0.35 : 0.18);
}

// ---- perspective (06, *Cameras*) ------------------------------------------------------------------

/** Block units (integer = block centre) → world point. */
const centre = (p: Vec3): V3 => [p[0] + 0.5, p[1] + 0.5, p[2] + 0.5];

/**
 * The vertical fov that fits a box seen from the eye along `b.forward` (with a 6% margin), or
 * undefined when the eye is inside or beside the box (nothing to fit).
 */
function fitFov(box: Box, eye: V3, b: { right: V3; up: V3; forward: V3 }, aspect: number): number | undefined {
  let t = 0;
  for (const x of [box.min[0], box.max[0]])
    for (const y of [box.min[1], box.max[1]])
      for (const z of [box.min[2], box.max[2]]) {
        const d: V3 = [x - eye[0], y - eye[1], z - eye[2]];
        const vz = d[0] * b.forward[0] + d[1] * b.forward[1] + d[2] * b.forward[2];
        if (vz <= NEAR) return undefined;
        const vx = d[0] * b.right[0] + d[1] * b.right[1] + d[2] * b.right[2], vy = d[0] * b.up[0] + d[1] * b.up[1] + d[2] * b.up[2];
        t = Math.max(t, Math.abs(vy) / vz, Math.abs(vx) / vz / aspect);
      }
  return Math.min(120, Math.max(5, (2 * Math.atan(t * 1.06) * 180) / Math.PI));
}

/** A perspective view's basis, eye and fov (degrees) for a w×h cell. */
export function perspectiveSetup(v: PerspectiveView, w: number, h: number): { b: { right: V3; up: V3; forward: V3 }; eye: V3; fov: number } {
  const eye = centre(v.eye), t = centre(v.target);
  const toward: V3 = [eye[0] - t[0], eye[1] - t[1], eye[2] - t[2]];
  if (Math.hypot(...toward) < 1e-9) throw new Error("perspective camera: target must differ from eye");
  const b = basis(toward);
  const fov = v.fov ?? (v.frame && fitFov(v.frame, eye, b, w / h)) ?? DEFAULT_FOV;
  if (!(fov > 0 && fov < 180)) throw new Error(`perspective camera: fov must be between 0 and 180 degrees (got ${fov})`);
  return { b, eye, fov };
}

function drawPerspective(
  out: Image, ox: number, oy: number, w: number, h: number, v: PerspectiveView, s: Scene, style: RenderStyle, labels: Label[], near?: number,
): { scale: number; cam: Camera; fov: number; cut?: Cut } {
  const { b, eye, fov } = perspectiveSetup(v, w, h);
  const focal = (h * SS) / 2 / Math.tan((fov * Math.PI) / 360);
  const cam: Camera = { ...b, scale: focal, cx: 0, cy: 0, width: w * SS, height: h * SS, eye };
  const r = new Raster(w * SS, h * SS, cam);
  r.fillBackground(BG_TOP, BG_BOTTOM);
  const fwd = b.forward;
  const depthOf = (x: number, y: number, z: number) => (x - eye[0]) * fwd[0] + (y - eye[1]) * fwd[1] + (z - eye[2]) * fwd[2];
  const ds: number[] = [];
  for (const x of [s.box.min[0], s.box.max[0]]) for (const y of [s.box.min[1], s.box.max[1]]) for (const z of [s.box.min[2], s.box.max[2]]) ds.push(depthOf(x, y, z));
  const dmin = Math.max(0, Math.min(...ds)), dspan = Math.max(1e-6, Math.max(...ds) - dmin);
  // Grid density from the size of a block at the target.
  const t = centre(v.target);
  drawGrid(r, s.box, focal / SS / Math.max(1, depthOf(...t)));
  // Near clip: measured from the eye along the view.
  const cut: Cut | undefined = near ? { normal: [...fwd], d: eye[0] * fwd[0] + eye[1] * fwd[1] + eye[2] * fwd[2] + near } : undefined;
  drawBlocks(s, style, (x, y, z) => (depthOf(x, y, z) - dmin) / dspan, (q, x, y, z) => facesAwayFrom(q, x, y, z, eye), depthOf, (q, x, y, z, look) => drawQuadClipped(r, q, x, y, z, look), cut);
  const lw = Math.max(1, Math.round(SS / 2));
  for (const [x, y, z] of s.airHighlights) if (!cut || kept(cut, x, y, z)) for (const [a, c] of CUBE_EDGES) segment(r, [x + a[0], y + a[1], z + a[2]], [x + c[0], y + c[1], z + c[2]], [255, 140, 0], 0.9, lw, true);
  r.downsampleInto(out, ox, oy, SS);
  drawPerspectiveOverlays(out, ox, oy, w, h, r, v, labels);
  return { scale: focal / SS, cam, fov, ...(cut ? { cut } : {}) };
}

/** True when a quad (at block x,y,z) turns its outward face away from the eye. */
function facesAwayFrom(q: BakedQuad, x: number, y: number, z: number, eye: V3): boolean {
  const p = q.pos;
  const ax = p[3]! - p[0]!, ay = p[4]! - p[1]!, az = p[5]! - p[2]!;
  const bx = p[9]! - p[0]!, by = p[10]! - p[1]!, bz = p[11]! - p[2]!;
  const nx = -(ay * bz - az * by), ny = -(az * bx - ax * bz), nz = -(ax * by - ay * bx);
  return nx * (p[0]! + x - eye[0]) + ny * (p[1]! + y - eye[1]) + nz * (p[2]! + z - eye[2]) > 1e-9;
}

/**
 * Draws a quad through a perspective camera, clipped against the near plane (Sutherland–Hodgman,
 * texture coordinates interpolated along the cut edges), so an eye inside a room or right against
 * a wall never sees inverted or smeared geometry.
 */
function drawQuadClipped(r: Raster, q: BakedQuad, x: number, y: number, z: number, look: Look): void {
  const p = q.pos, uv = q.uv;
  const V = [0, 1, 2, 3].map((i) => r.viewSpace(p[i * 3]! + x, p[i * 3 + 1]! + y, p[i * 3 + 2]! + z));
  let inside = 0;
  for (const v of V) if (v[2] >= NEAR) inside++;
  if (inside === 0) return;
  const pts: { v: V3; u: number; w: number }[] = [];
  for (let i = 0; i < 4; i++) {
    const a = V[i]!, b = V[(i + 1) % 4]!;
    const ua = uv[i * 2]!, wa = uv[i * 2 + 1]!, ub = uv[((i + 1) % 4) * 2]!, wb = uv[((i + 1) % 4) * 2 + 1]!;
    const ina = a[2] >= NEAR, inb = b[2] >= NEAR;
    if (ina) pts.push({ v: a, u: ua, w: wa });
    if (ina !== inb) {
      const t = (NEAR - a[2]) / (b[2] - a[2]);
      pts.push({ v: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR], u: ua + (ub - ua) * t, w: wa + (wb - wa) * t });
    }
  }
  const P = pts.map((e) => r.projectView(e.v[0], e.v[1], e.v[2]));
  for (let i = 1; i + 1 < pts.length; i++) {
    const a = pts[0]!, b = pts[i]!, c = pts[i + 1]!;
    r.triangle(P[0]!, P[i]!, P[i + 1]!, [a.u, a.w, b.u, b.w, c.u, c.w], q.tex.img, q.tint, q.shade, look.mode, look.flat, look.overlay, look.alpha);
  }
}

/** A world-space line through a perspective camera, clipped to the near plane. */
function segment(r: Raster, a: V3, b: V3, rgb: RGB, alpha: number, width: number, depthTest: boolean): void {
  let va = r.viewSpace(...a), vb = r.viewSpace(...b);
  if (va[2] < NEAR && vb[2] < NEAR) return;
  if (va[2] < NEAR || vb[2] < NEAR) {
    const t = (NEAR - va[2]) / (vb[2] - va[2]);
    const cut: V3 = [va[0] + (vb[0] - va[0]) * t, va[1] + (vb[1] - va[1]) * t, NEAR];
    if (va[2] < NEAR) va = cut;
    else vb = cut;
  }
  r.line(r.projectView(...va), r.projectView(...vb), rgb, alpha, width, depthTest);
}

/** Perspective cells: the view name and which way the camera looks (no ticks: they wouldn't be uniform). */
function drawPerspectiveOverlays(out: Image, ox: number, oy: number, w: number, h: number, r: Raster, v: PerspectiveView, extra: Label[]): void {
  out.text((v.label ?? "perspective").replace(/_/g, " "), ox + 6, oy + 6, INK);
  for (const l of extra) {
    const vs = r.viewSpace(...l.at);
    if (vs[2] < NEAR) continue;
    const p = r.projectView(...vs);
    const tw = textWidth(l.text), tx = Math.round(ox + p[0] / SS - tw / 2), ty = Math.round(oy + p[1] / SS - 11);
    if (tx < ox + 1 || ty < oy + 1 || tx + tw > ox + w - 1 || ty + 7 > oy + h - 1) continue;
    out.fillRect(tx - 2, ty - 2, tw + 4, 11, [255, 255, 255, 255]);
    out.text(l.text, tx, ty, INK);
  }
  const f = r.cam.forward;
  let dir: string;
  if (Math.abs(f[1]) > 0.92) dir = f[1] < 0 ? "DOWN" : "UP";
  else {
    // Compass bearing of the view direction, 8 ways.
    const deg = ((Math.atan2(f[0], -f[2]) * 180) / Math.PI + 360) % 360;
    dir = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8]!;
    if (f[1] < -0.4) dir += " DOWN";
    else if (f[1] > 0.4) dir += " UP";
  }
  const t = `LOOKING ${dir}`;
  out.text(t, ox + w - 6 - textWidth(t), oy + 6, INK);
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
  // Component labels, with a backdrop so they read over blocks.
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
