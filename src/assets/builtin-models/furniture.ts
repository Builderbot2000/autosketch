import type { Props } from "../models.js";
import { boxUnwrap, cuboid, facingDegrees, type Rect, type Sheet } from "./geometry.js";
import type { CodeModel } from "./index.js";

/** Beds and bells (02, "Code-drawn blocks"). Hand-written geometry over the instance's own textures. */

/**
 * A bed half: a mattress slab on two legs. `facing` points from foot to head, so the head half
 * has its legs and pillow end on the facing side.
 */
export function bedModel(ns: string, path: string, props: Props): CodeModel {
  const sheet: Sheet = { id: `${ns}:entity/bed/${path.replace(/_bed$/, "")}`, w: 64, h: 64 };
  const head = props.part === "head";
  // Each half's texture is a 16×16×6 box lying on its back: its "front" is the mattress top.
  const uw = boxUnwrap(0, head ? 0 : 22, 16, 16, 6);
  const end = head ? uw.top : uw.bottom;
  const side = (r: Rect, rotation: number) => ({ sheet, rect: r, rotation });
  const mattress = cuboid([0, 3, 0], [16, 9, 16], {
    up: { sheet, rect: uw.front },
    down: { sheet, rect: uw.back },
    west: side(uw.right, 90),
    east: side(uw.left, 270),
    ...(head ? { north: { sheet, rect: end } } : { south: { sheet, rect: end } }),
  });
  // Legs: 3×3×3, at the two outer corners of this half.
  const lz = head ? 0 : 13;
  const legUv = boxUnwrap(50, head ? 0 : 12, 3, 3, 3);
  const leg = (x: number) => cuboid([x, 0, lz], [x + 3, 3, lz + 3], { north: { sheet, rect: legUv.front }, south: { sheet, rect: legUv.back }, west: { sheet, rect: legUv.right }, east: { sheet, rect: legUv.left } });
  return { parts: [{ elements: [mattress, leg(0), leg(13)], y: facingDegrees(props.facing) }] };
}

/**
 * The bell itself (the frame comes from the block's JSON model, so this is drawn on top of it).
 * Floor and ceiling bells hang in the middle; wall bells hang a little off the wall.
 */
export function bellModel(ns: string, props: Props): CodeModel {
  const sheet: Sheet = { id: `${ns}:entity/bell/bell_body`, w: 32, h: 32 };
  const body = boxUnwrap(0, 0, 6, 7, 6);
  const lip = boxUnwrap(0, 13, 8, 2, 8);
  const faces = (uw: ReturnType<typeof boxUnwrap>) => ({
    up: { sheet, rect: uw.top }, down: { sheet, rect: uw.bottom },
    north: { sheet, rect: uw.front }, south: { sheet, rect: uw.back }, west: { sheet, rect: uw.right }, east: { sheet, rect: uw.left },
  });
  const top = props.attachment === "floor" ? 13 : 12;
  return {
    parts: [{ elements: [cuboid([5, top - 7, 5], [11, top, 11], faces(body)), cuboid([4, top - 9, 4], [12, top - 7, 12], faces(lip))], y: facingDegrees(props.facing) }],
    overlay: true,
  };
}
