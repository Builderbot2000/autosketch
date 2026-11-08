import { stateId } from "../core/blockstate.js";
import { Mask } from "../core/mask.js";
import { boxVolume, intersectBox, isEmptyBox, type Box, type Vec3 } from "../core/region.js";
import type { Document } from "../document/document.js";
import { ANALYZE_MAX_VOLUME } from "./analyze.js";

/**
 * Geometry of the semantic selections (docs/design/05-operations.md, *Semantic*): enclosed air,
 * interior and top surface. These are measurements, not architectural labels (06): no thresholds,
 * no storeys, roofs or openings. Read-only: every function returns a mask of document-local
 * positions. `ops/selection.ts` turns the JSON forms into calls here.
 */

export interface EnclosedRegion {
  mask: Mask;
  volume: number;
  box: Box;
}

/**
 * Enclosed air: air not reachable from outside by 6-connected flood fill; every non-air block
 * bounds it (the same rule `analyze` measures with). Inside `scope`'s bounding box, positions
 * outside the scope count as air, so a shell selection's inside is enclosed. Regions come largest
 * first, the order `analyze` lists them.
 */
export function enclosedAir(doc: Document, scope?: Mask): EnclosedRegion[] {
  const bounds = doc.localBounds();
  const sb = scope ? scope.bbox() : bounds;
  const area = bounds && sb ? intersectBox(bounds, sb) : undefined;
  const regions: EnclosedRegion[] = [];
  if (!area || isEmptyBox(area)) return regions;
  if (boxVolume(area) > ANALYZE_MAX_VOLUME) throw new Error(`the area spans ${boxVolume(area).toLocaleString("en-US")} positions; enclosed and interior take at most ${ANALYZE_MAX_VOLUME.toLocaleString("en-US")}. Limit it with a smaller selection.`);
  const [x0, y0, z0] = area.min;
  const W = area.max[0] - x0 + 2, H = area.max[1] - y0 + 2, D = area.max[2] - z0 + 2;
  const WD = W * D, N = W * H * D;
  // 1 = a non-air block inside the scope; everything else is air.
  const wall = new Uint8Array(N);
  const cache = new Map<number, boolean>();
  doc.voxels.forEachInBox(doc.boxToStore(area), (sx, sy, sz, id) => {
    const [x, y, z] = doc.toLocal(sx, sy, sz);
    if (scope && !scope.has(x, y, z)) return;
    let solid = cache.get(id);
    if (solid === undefined) {
      const sid = stateId(doc.states.get(id));
      cache.set(id, (solid = sid !== "minecraft:air" && sid !== "minecraft:cave_air" && sid !== "minecraft:void_air"));
    }
    if (solid) wall[(y - y0 + 1) * WD + (z - z0 + 1) * W + (x - x0 + 1)] = 1;
  });
  const nbs = (i: number, out: number[]) => {
    const x = i % W, z = Math.floor(i / W) % D, y = Math.floor(i / WD);
    out.length = 0;
    if (x > 0) out.push(i - 1);
    if (x < W - 1) out.push(i + 1);
    if (z > 0) out.push(i - W);
    if (z < D - 1) out.push(i + W);
    if (y > 0) out.push(i - WD);
    if (y < H - 1) out.push(i + WD);
    return out;
  };
  const seen = new Uint8Array(N);
  const buf: number[] = [];
  const stack = [0];
  seen[0] = 1;
  while (stack.length) for (const j of nbs(stack.pop()!, buf)) if (!seen[j] && !wall[j]) (seen[j] = 1), stack.push(j);
  const toLocal = (c: number): Vec3 => [(c % W) - 1 + x0, Math.floor(c / WD) - 1 + y0, (Math.floor(c / W) % D) - 1 + z0];
  for (let i = 0; i < N; i++) {
    if (seen[i] || wall[i]) continue;
    const comp = [i];
    seen[i] = 1;
    for (let k = 0; k < comp.length; k++) for (const j of nbs(comp[k]!, buf)) if (!seen[j] && !wall[j]) (seen[j] = 1), comp.push(j);
    const m = new Mask();
    const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const c of comp) {
      const p = toLocal(c);
      m.add(...p);
      for (let a = 0; a < 3; a++) (min[a] = Math.min(min[a]!, p[a]!)), (max[a] = Math.max(max[a]!, p[a]! + 1));
    }
    regions.push({ mask: m, volume: comp.length, box: { min, max } });
  }
  regions.sort((a, b) => b.volume - a.volume);
  return regions;
}

/** `interior`: all enclosed air inside `scope`, or the whole build. */
export function interiorMask(doc: Document, scope?: Mask): Mask {
  return enclosedAir(doc, scope).reduce((m, r) => m.unionWith(r.mask), new Mask());
}

/** `enclosed`: the enclosed air region holding a seed position, or the n-th largest (1-based, as `analyze` lists them). */
export function enclosedMask(doc: Document, which: Vec3 | number, scope?: Mask): { mask: Mask; note?: string } {
  const regions = enclosedAir(doc, scope);
  if (typeof which === "number") {
    const r = regions[which - 1];
    if (!r) throw new Error(regions.length ? `enclosed ${which} is out of range: ${regions.length} enclosed air region${regions.length === 1 ? "" : "s"} found (1 = the largest)` : "enclosed: no enclosed air found");
    return { mask: r.mask.clone() };
  }
  const r = regions.find((x) => x.mask.has(...which));
  if (r) return { mask: r.mask.clone() };
  const st = doc.getState(...which);
  return { mask: new Mask(), note: `enclosed: ${fmt(which)} ${st === "minecraft:air" ? "is air connected to the outside" : `is ${st.replace(/^minecraft:/, "")}, not air`}; seed it with an enclosed air position` };
}
/** `top`: per (x, z) column of `scope`, its highest non-air block (a heightmap surface). */
export function topMask(doc: Document, scope: Mask): Mask {
  const best = new Map<string, Vec3>();
  scope.forEach((x, y, z) => {
    if (doc.getState(x, y, z) === "minecraft:air") return;
    const k = `${x},${z}`;
    const b = best.get(k);
    if (!b || y > b[1]) best.set(k, [x, y, z]);
  });
  const m = new Mask();
  for (const p of best.values()) m.add(...p);
  return m;
}

function fmt(p: Vec3): string {
  return `(${p.join(",")})`;
}
