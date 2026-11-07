import type { Face, ModelElement, ModelFace } from "../models.js";

/**
 * Small helpers for writing code-drawn models by hand (docs/design/02-assets-registry.md,
 * "Code-drawn blocks"). Geometry is in model units (0..16) like block model JSON. Textures are
 * referenced by id and read from the user's instance at bake time; nothing here is game data.
 */

export type V3 = [number, number, number];
/** A texture-pixel rectangle [x0, y0, x1, y1]. Reversed corners mirror the image. */
export type Rect = [number, number, number, number];

/** A texture of known pixel size, so pixel rectangles can be turned into model UVs (0..16). */
export interface Sheet {
  id: string;
  w: number;
  h: number;
}

export interface FaceSpec {
  sheet: Sheet;
  rect: Rect;
  rotation?: number;
  /** ARGB vertex colour (e.g. a banner's dye). */
  color?: string;
  /** Face of the block that hides this face when the neighbour there is opaque. */
  cull?: Face;
}

/** Converts a pixel rectangle on a sheet into model UV units. */
export function sheetUv(s: Sheet, r: Rect): [number, number, number, number] {
  return [(r[0] * 16) / s.w, (r[1] * 16) / s.h, (r[2] * 16) / s.w, (r[3] * 16) / s.h];
}

const SHEET_OF = new WeakMap<ModelFace, Sheet>();

/**
 * The sheet a face built by `cuboid` was laid out against. Packs often ship entity textures at
 * another aspect (a 64×32 skeleton redrawn as 64×64 keeps the same layout per pixel row), so the
 * baker rescales V by the real texture's aspect: pixel positions are kept relative to the width.
 */
export function faceSheet(face: ModelFace): Sheet | undefined {
  return SHEET_OF.get(face);
}

/** The face's UV corrected for a texture of the given real size (see faceSheet). */
export function fitUv(face: ModelFace, width: number, height: number): ModelFace {
  const s = SHEET_OF.get(face);
  if (!s || !face.uv || width <= 0 || height <= 0) return face;
  const k = (s.h * width) / (s.w * height);
  if (Math.abs(k - 1) < 1e-6) return face;
  return { ...face, uv: [face.uv[0], face.uv[1] * k, face.uv[2], face.uv[3] * k] };
}

/** One cuboid element. `rotY` turns it about the block centre by any angle (degrees, clockwise from above). */
export function cuboid(from: V3, to: V3, faces: Partial<Record<Face, FaceSpec>>, rotY = 0): ModelElement {
  const out: ModelElement = { from, to, faces: {} };
  for (const [f, spec] of Object.entries(faces) as [Face, FaceSpec][]) {
    const face: ModelFace = { texture: spec.sheet.id, uv: sheetUv(spec.sheet, spec.rect) };
    if (spec.rotation) face.rotation = spec.rotation;
    if (spec.color) face.color = spec.color;
    if (spec.cull) face.cullface = spec.cull;
    SHEET_OF.set(face, spec.sheet);
    out.faces[f] = face;
  }
  // The baker's element rotation turns counter-clockwise for positive angles; blockstate y turns clockwise.
  if (rotY) out.rotation = { origin: [8, 8, 8], axis: "y", angle: -rotY };
  return out;
}

/**
 * The common "box" texture layout used by entity-style models: a w×h×d cuboid unwrapped at pixel
 * offset (u, v) as a cross of six rectangles. Names are the side of the box each rectangle covers
 * when the box is drawn upright with its front to the north.
 */
export function boxUnwrap(u: number, v: number, w: number, h: number, d: number): Record<"top" | "bottom" | "front" | "back" | "left" | "right", Rect> {
  return {
    top: [u + d, v, u + d + w, v + d],
    bottom: [u + d + w, v, u + d + 2 * w, v + d],
    right: [u, v + d, u + d, v + d + h],
    front: [u + d, v + d, u + d + w, v + d + h],
    left: [u + d + w, v + d, u + 2 * d + w, v + d + h],
    back: [u + 2 * d + w, v + d, u + 2 * d + 2 * w, v + d + h],
  };
}

/**
 * Six faces for an upright box facing north, from a box unwrap. `west`/`east` take the unwrap's
 * right/left sides (the box's own right is west when it faces north).
 */
export function boxFaces(sheet: Sheet, uw: ReturnType<typeof boxUnwrap>, extra: Partial<FaceSpec> = {}): Record<Face, FaceSpec> {
  return {
    up: { sheet, rect: uw.top, ...extra },
    down: { sheet, rect: uw.bottom, ...extra },
    north: { sheet, rect: uw.front, ...extra },
    south: { sheet, rect: uw.back, ...extra },
    west: { sheet, rect: uw.right, ...extra },
    east: { sheet, rect: uw.left, ...extra },
  };
}

/** Clockwise degrees (from above) that turn a north-facing model to face `dir`. */
export function facingDegrees(dir: string | undefined): number {
  return dir === "east" ? 90 : dir === "south" ? 180 : dir === "west" ? 270 : 0;
}

/**
 * Splits a free angle into a blockstate-style 90° step and a remainder, so whole-step turns keep
 * exact geometry and cull faces.
 */
export function splitAngle(deg: number): { step: number; rest: number } {
  const d = ((deg % 360) + 360) % 360;
  const step = Math.floor(d / 90) * 90;
  return { step, rest: d - step };
}

/** Floor-standing blocks with `rotation=0..15` (signs, banners, heads): 0 faces south, steps of 22.5° clockwise. */
export function rotationDegrees(rotation: string | undefined): number {
  const r = Number(rotation ?? 0);
  return 180 + (Number.isFinite(r) ? r : 0) * 22.5;
}

export const DYE_COLORS: Record<string, string> = {
  white: "f9fffe", orange: "f9801d", magenta: "c74ebd", light_blue: "3ab3da", yellow: "fed83d", lime: "80c71f",
  pink: "f38baa", gray: "474f52", light_gray: "9d9d97", cyan: "169c9c", purple: "8932b8", blue: "3c44aa",
  brown: "835432", green: "5e7c16", red: "b02e26", black: "1d1d21",
};

/** The dye colour named at the start of a block path ("light_blue_banner" → light_blue), if any. */
export function dyeOf(path: string): string | undefined {
  for (const two of ["light_blue", "light_gray"]) if (path.startsWith(`${two}_`)) return two;
  const first = path.slice(0, path.indexOf("_"));
  return first in DYE_COLORS ? first : undefined;
}
