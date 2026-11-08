import { Mask } from "../core/mask.js";
import type { Vec3 } from "../core/region.js";
import { resolveSelection, type SelExpr } from "../ops/selection.js";
import type { ScriptHost } from "./ops.js";

/**
 * `array(template, { along, every })` (docs/design/05-operations.md, the crenellation example):
 * copies of a template selection placed at every n-th block of a path selection. The path is
 * walked in order from its lowest corner, stepping to the nearest unvisited neighbour (face
 * neighbours first, then edges and corners), so a ring is visited around its circumference.
 * The result is a frozen selection (`{"frozen": runs}`), since it's used right away.
 */

export const MAX_ARRAY_ALONG = 10_000;

const NEIGHBOURS: Vec3[] = (() => {
  const out: Vec3[] = [];
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) if (dx || dy || dz) out.push([dx, dy, dz]);
  return out.sort((a, b) => a.reduce((s, v) => s + Math.abs(v), 0) - b.reduce((s, v) => s + Math.abs(v), 0));
})();

/** Orders a path's positions by walking it from its lowest corner. */
export function walkOrder(m: Mask): Vec3[] {
  const left = new Set<string>();
  const pts = m.positions().sort((p, q) => p[1] - q[1] || p[2] - q[2] || p[0] - q[0]);
  for (const p of pts) left.add(p.join());
  const out: Vec3[] = [];
  let i = 0;
  while (left.size) {
    while (i < pts.length && !left.has(pts[i]!.join())) i++;
    let cur: Vec3 | undefined = pts[i];
    while (cur) {
      left.delete(cur.join());
      out.push(cur);
      const c: Vec3 = cur;
      cur = undefined;
      for (const d of NEIGHBOURS) {
        const n: Vec3 = [c[0] + d[0], c[1] + d[1], c[2] + d[2]];
        if (left.has(n.join())) {
          cur = n;
          break;
        }
      }
    }
  }
  return out;
}

export function arrayAlong(h: ScriptHost, template: unknown, opts: Record<string, unknown>): { frozen: number[][] } {
  const ctx = { doc: h.doc, ...(h.env.registry ? { registry: h.env.registry } : {}), ...(h.env.index ? { index: h.env.index } : {}) };
  const every = opts.every ?? 1;
  const offset = opts.offset ?? 0;
  if (typeof every !== "number" || !Number.isInteger(every) || every < 1) throw new Error("every must be a whole number ≥ 1");
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) throw new Error("offset must be a whole number ≥ 0");
  const path = walkOrder(resolveSelection(opts.along as SelExpr, ctx).mask);
  const tpl = resolveSelection(template as SelExpr, ctx).mask.positions();
  if (!path.length) throw new Error("the along selection is empty");
  const picked = path.filter((_, i) => i >= offset && (i - offset) % every === 0);
  if (picked.length > MAX_ARRAY_ALONG) throw new Error(`array along would place ${picked.length} copies; at most ${MAX_ARRAY_ALONG}`);
  const out = new Mask();
  for (const p of picked) for (const t of tpl) out.add(p[0] + t[0], p[1] + t[1], p[2] + t[2]);
  const runs: number[][] = [];
  for (const q of out.positions().sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[0] - b[0])) {
    const last = runs[runs.length - 1];
    if (last && last[1] === q[1] && last[2] === q[2] && last[0]! + last[3]! === q[0]) last[3]!++;
    else runs.push([q[0], q[1], q[2], 1]);
  }
  return { frozen: runs };
}
