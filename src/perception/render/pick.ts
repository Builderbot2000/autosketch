import { Mask } from "../../core/mask.js";
import { boxVolume, type Vec3 } from "../../core/region.js";
import type { Document } from "../../document/document.js";
import { kept, marchRay, projectToImage, rayThrough, type RenderRecord, type ViewCamera } from "./cameras.js";

/**
 * Render-seeded selections (docs/design/05-operations.md, *Picking*: `view_box`, `view_lasso`): a
 * rectangle or lasso drawn on a stored render (cameras.ts) becomes a set of blocks.
 *
 *   visible  the surface the camera saw: a ray through sample points inside the outline (at least
 *            two per block width) keeps the first non-air block it meets
 *   through  the whole drawn volume behind the outline, air included (x-ray select): every
 *            position of the view's clip whose centre projects inside the outline
 *
 * Pixel coordinates are in the whole returned image (contact sheets included), like `raycast`.
 * An outline may span several cells of a contact sheet; each view picks its own part.
 */

export type PickDepth = "visible" | "through";

export interface PickResult {
  mask: Mask;
  notes: string[];
}

/** Caps: positions scanned for "through", rays cast for "visible". */
export const PICK_MAX_VOLUME = 8_000_000;
export const PICK_MAX_RAYS = 1_000_000;

/** `view_box`: an inclusive pixel rectangle [x0, y0, x1, y1] (corners in any order). */
export function pickRect(doc: Document, rec: RenderRecord, rect: [number, number, number, number], depth: PickDepth): PickResult {
  const [ax, ay, bx, by] = rect;
  const area = { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx) + 1, y1: Math.max(ay, by) + 1 };
  return pick(doc, rec, area, () => true, depth);
}

/** `view_lasso`: a polygon of pixel positions (each vertex at its pixel's centre), at least 3 points. */
export function pickLasso(doc: Document, rec: RenderRecord, points: [number, number][], depth: PickDepth): PickResult {
  if (points.length < 3) throw new Error("view_lasso needs at least 3 [px,py] points");
  const poly = points.map(([x, y]) => [x + 0.5, y + 0.5] as [number, number]);
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  const area = { x0: Math.floor(Math.min(...xs)), y0: Math.floor(Math.min(...ys)), x1: Math.ceil(Math.max(...xs)), y1: Math.ceil(Math.max(...ys)) };
  return pick(doc, rec, area, (fx, fy) => inPoly(fx, fy, poly), depth);
}

interface Area {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function pick(doc: Document, rec: RenderRecord, area: Area, inside: (fx: number, fy: number) => boolean, depth: PickDepth): PickResult {
  const mask = new Mask();
  const notes: string[] = [];
  if (rec.revision !== doc.revision) notes.push(`${rec.id}: the document changed since this render, so the pick follows the old camera over today's blocks`);
  let views = 0;
  for (const v of rec.views) {
    const a = { x0: Math.max(area.x0, v.ox), y0: Math.max(area.y0, v.oy), x1: Math.min(area.x1, v.ox + v.width), y1: Math.min(area.y1, v.oy + v.height) };
    if (a.x0 >= a.x1 || a.y0 >= a.y1) continue;
    views++;
    if (depth === "through") pickThrough(v, a, inside, mask);
    else pickVisible(doc, v, a, inside, mask, notes);
  }
  if (!views) notes.push(`the outline lies outside render ${rec.id} (${rec.width}×${rec.height})`);
  return { mask, notes };
}

function pickThrough(v: ViewCamera, a: Area, inside: (fx: number, fy: number) => boolean, out: Mask): void {
  const test = (x: number, y: number, z: number) => {
    if (v.cut && !kept(v.cut, x, y, z)) return; // removed by the near clip
    // Perspective: only positions in front of the eye.
    const f = projectToImage(v, [x + 0.5, y + 0.5, z + 0.5]);
    if (!f) return;
    const [fx, fy] = f;
    if (fx >= a.x0 && fx < a.x1 && fy >= a.y0 && fy < a.y1 && inside(fx, fy)) out.add(x, y, z);
  };
  if (v.mask) {
    v.mask.forEach((x, y, z) => {
      const b = v.clip;
      if (x >= b.min[0] && x < b.max[0] && y >= b.min[1] && y < b.max[1] && z >= b.min[2] && z < b.max[2]) test(x, y, z);
    });
    return;
  }
  const b = v.clip;
  if (boxVolume(b) > PICK_MAX_VOLUME) throw new Error(`depth "through" would scan ${boxVolume(b).toLocaleString("en-US")} positions; at most ${PICK_MAX_VOLUME.toLocaleString("en-US")}. Render a smaller region first, or use depth "visible".`);
  for (let y = b.min[1]; y < b.max[1]; y++) for (let z = b.min[2]; z < b.max[2]; z++) for (let x = b.min[0]; x < b.max[0]; x++) test(x, y, z);
}

function pickVisible(doc: Document, v: ViewCamera, a: Area, inside: (fx: number, fy: number) => boolean, out: Mask, notes: string[]): void {
  // Perspective blocks shrink with distance: sample twice per pixel.
  const blockPx = v.cam.eye ? 1 : v.cam.scale / v.ss;
  const w = a.x1 - a.x0, h = a.y1 - a.y0;
  let step = Math.min(1, blockPx / 2);
  if ((w / step) * (h / step) > PICK_MAX_RAYS) {
    step = Math.sqrt((w * h) / PICK_MAX_RAYS);
    notes.push(`${v.label}: blocks are under ${Math.max(1, Math.round(step * 2))}px wide here, so the pick sampled every ${step.toFixed(1)}px and may miss small blocks; render a closer view for a finer pick`);
  }
  for (let fy = a.y0 + step / 2; fy < a.y1; fy += step)
    for (let fx = a.x0 + step / 2; fx < a.x1; fx += step) {
      if (!inside(fx, fy)) continue;
      const { origin, dir, tMin } = rayThrough(v, fx, fy);
      let skip = (v.peel ?? 1) - 1; // a peeled view saw the n-th block along the ray
      marchRay(
        v.clip,
        v.mask,
        origin,
        dir,
        (p) => {
          if (v.cut && !kept(v.cut, p[0], p[1], p[2])) return false;
          if (doc.getState(p[0], p[1], p[2]) === "minecraft:air") return false;
          if (skip-- > 0) return false;
          out.add(p[0], p[1], p[2]);
          return true;
        },
        tMin,
      );
    }
}

/** Even-odd point-in-polygon test. */
function inPoly(x: number, y: number, pts: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!, [xj, yj] = pts[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
