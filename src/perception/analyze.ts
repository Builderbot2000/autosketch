import type { Registry } from "../assets/registry.js";
import { shortState, stateId } from "../core/blockstate.js";
import { Mask } from "../core/mask.js";
import { boxVolume, formatBox, formatVec, intersectBox, isEmptyBox, type Box, type Vec3 } from "../core/region.js";
import type { Document, Facing } from "../document/document.js";

/**
 * Structural measurements (docs/design/06-perception.md, "Structural measurements"): objective
 * facts about a build, computed from the voxels alone. Nothing here names architectural elements
 * (storeys, walls, roofs, windows, rooms): there are no labelling thresholds, and interpreting the
 * numbers is left to the model.
 *
 *   layers        per y: block count, x/z extent of the blocks, and the share of that extent filled
 *                 (identical consecutive layers merged in the text)
 *   materials     block ids by count
 *   connectivity  groups of blocks joined through faces, edges or corners (26 neighbours); groups
 *                 that do not reach the bottom layer of the measured box are listed
 *   enclosed air  6-connected air not reachable from outside the box; every non-air block bounds it
 */

export const ANALYZE_MAX_VOLUME = 4_000_000;

export interface LayerStats {
  y: number;
  blocks: number;
  /** Local half-open box of the layer's blocks (one layer high); absent for an empty layer. */
  extent?: Box;
}

export interface BlockGroup {
  count: number;
  box: Box;
  /** Up to 64 of the group's positions. */
  positions: Vec3[];
}

export interface AirRegion {
  volume: number;
  box: Box;
}

export interface Analysis {
  /** Local box measured (tight around the content). */
  box: Box;
  front: Facing;
  blocks: number;
  /** One entry per y of `box`, bottom first. */
  layers: LayerStats[];
  /** [block id, count], commonest first. */
  materials: [string, number][];
  /** Number of 26-connected block groups. */
  groups: number;
  /** Groups not reaching the bottom layer of `box`, smallest first. */
  ungrounded: BlockGroup[];
  /** Enclosed air regions, largest first. */
  enclosed: AirRegion[];
}

export interface AnalyzeOptions {
  /** Restrict to this local half-open box or mask (default: the whole document). */
  region?: Box | Mask;
}

const isAirState = (s: string) => {
  const id = stateId(s);
  return id === "minecraft:air" || id === "minecraft:cave_air" || id === "minecraft:void_air";
};

export function analyzeStructure(doc: Document, opts: AnalyzeOptions = {}): Analysis {
  const bounds = doc.localBounds();
  const mask = opts.region instanceof Mask ? opts.region : undefined;
  let area = bounds;
  if (area && opts.region) area = intersectBox(area, mask ? (mask.bbox() ?? { min: [0, 0, 0], max: [0, 0, 0] }) : (opts.region as Box));
  if (!area || isEmptyBox(area)) throw new Error("Nothing to analyze: the document (or the region) is empty.");

  // Tight box around the non-air content inside the area.
  const airCache = new Map<number, boolean>();
  const isAir = (id: number) => {
    let a = airCache.get(id);
    if (a === undefined) airCache.set(id, (a = isAirState(doc.states.get(id))));
    return a;
  };
  const cells: [number, number, number, number][] = [];
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  doc.voxels.forEachInBox(doc.boxToStore(area), (sx, sy, sz, id) => {
    if (isAir(id)) return;
    const [x, y, z] = doc.toLocal(sx, sy, sz);
    if (mask && !mask.has(x, y, z)) return;
    cells.push([x, y, z, id]);
    lo[0] = Math.min(lo[0], x), lo[1] = Math.min(lo[1], y), lo[2] = Math.min(lo[2], z);
    hi[0] = Math.max(hi[0], x + 1), hi[1] = Math.max(hi[1], y + 1), hi[2] = Math.max(hi[2], z + 1);
  });
  if (!cells.length) throw new Error("Nothing to analyze: the region holds only air.");
  const box: Box = { min: lo, max: hi };
  if (boxVolume(box) > ANALYZE_MAX_VOLUME) throw new Error(`the build spans ${boxVolume(box).toLocaleString("en-US")} positions; analyze takes at most ${ANALYZE_MAX_VOLUME.toLocaleString("en-US")}. Pass region or component to measure one part.`);

  // Dense occupancy grid with one layer of air padding on every side.
  const [x0, y0, z0] = box.min;
  const W = hi[0] - x0 + 2, H = hi[1] - y0 + 2, D = hi[2] - z0 + 2, WD = W * D, N = W * H * D;
  const solid = new Uint8Array(N);
  const idx = (x: number, y: number, z: number) => (y - y0 + 1) * WD + (z - z0 + 1) * W + (x - x0 + 1);
  const toLocal = (i: number): Vec3 => [(i % W) - 1 + x0, Math.floor(i / WD) - 1 + y0, (Math.floor(i / W) % D) - 1 + z0];

  // Layers and materials.
  const layers: LayerStats[] = [];
  for (let y = y0; y < hi[1]; y++) layers.push({ y, blocks: 0 });
  const byId = new Map<string, number>();
  for (const [x, y, z, id] of cells) {
    solid[idx(x, y, z)] = 1;
    const l = layers[y - y0]!;
    l.blocks++;
    if (!l.extent) l.extent = { min: [x, y, z], max: [x + 1, y + 1, z + 1] };
    else {
      const e = l.extent;
      e.min[0] = Math.min(e.min[0], x), e.min[2] = Math.min(e.min[2], z);
      e.max[0] = Math.max(e.max[0], x + 1), e.max[2] = Math.max(e.max[2], z + 1);
    }
    const sid = stateId(doc.states.get(id));
    byId.set(sid, (byId.get(sid) ?? 0) + 1);
  }
  const materials = [...byId].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  // Connectivity: 26-neighbour groups; real cells never touch the padding edge, so offsets stay in range.
  const offsets: number[] = [];
  for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (dx || dy || dz) offsets.push(dy * WD + dz * W + dx);
  const seen = new Uint8Array(N);
  let groups = 0;
  const ungrounded: BlockGroup[] = [];
  for (let i = 0; i < N; i++) {
    if (seen[i] || !solid[i]) continue;
    groups++;
    const comp = [i];
    seen[i] = 1;
    let grounded = false;
    for (let k = 0; k < comp.length; k++) {
      const c = comp[k]!;
      if (Math.floor(c / WD) === 1) grounded = true;
      for (const o of offsets) {
        const j = c + o;
        if (!seen[j] && solid[j]) (seen[j] = 1), comp.push(j);
      }
    }
    if (!grounded) ungrounded.push({ count: comp.length, box: boundsOf(comp.map(toLocal)), positions: comp.slice(0, 64).map(toLocal) });
  }
  ungrounded.sort((a, b) => a.count - b.count);

  // Enclosed air: flood the outside from the padding corner (6 neighbours), then group the rest.
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
  const reached = new Uint8Array(N);
  const buf: number[] = [];
  const stack = [0];
  reached[0] = 1;
  while (stack.length) for (const j of nbs(stack.pop()!, buf)) if (!reached[j] && !solid[j]) (reached[j] = 1), stack.push(j);
  const enclosed: AirRegion[] = [];
  for (let i = 0; i < N; i++) {
    if (reached[i] || solid[i]) continue;
    const comp = [i];
    reached[i] = 1;
    for (let k = 0; k < comp.length; k++) for (const j of nbs(comp[k]!, buf)) if (!reached[j] && !solid[j]) (reached[j] = 1), comp.push(j);
    enclosed.push({ volume: comp.length, box: boundsOf(comp.map(toLocal)) });
  }
  enclosed.sort((a, b) => b.volume - a.volume);

  return { box, front: doc.meta.front, blocks: cells.length, layers, materials, groups, ungrounded, enclosed };
}

function boundsOf(pts: Vec3[]): Box {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of pts)
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a]!, p[a]!);
      max[a] = Math.max(max[a]!, p[a]! + 1);
    }
  return { min, max };
}

// ---- text ----------------------------------------------------------------------------------------

const MAX_LAYER_ROWS = 48;
const plural = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;
const range = (a: number, b: number) => (a === b ? String(a) : `${a}..${b}`);
const extentKey = (l: LayerStats) => (l.extent ? `${l.extent.min[0]},${l.extent.min[2]},${l.extent.max[0]},${l.extent.max[2]}` : "");
const pct = (n: number, d: number) => `${Math.round((100 * n) / d)}%`;

/** Compact text of the measurements (about 200–400 tokens for a typical build). */
export function formatAnalysis(a: Analysis, registry?: Registry): string {
  const [sx, sy, sz] = [0, 1, 2].map((k) => a.box.max[k]! - a.box.min[k]!);
  const lines: string[] = [`box: ${formatBox(a.box)}, ${sx}×${sy}×${sz} (x×y×z); ${plural(a.blocks, "block")}; front=${a.front}`];

  // Consecutive layers with the same extent and block count are merged.
  const rows: string[] = [];
  for (let i = 0; i < a.layers.length; ) {
    const l = a.layers[i]!;
    let j = i + 1;
    while (j < a.layers.length && a.layers[j]!.blocks === l.blocks && extentKey(a.layers[j]!) === extentKey(l)) j++;
    const ys = `y=${range(l.y, a.layers[j - 1]!.y)}`;
    if (!l.extent) rows.push(`${ys}: empty`);
    else {
      const e = l.extent;
      const w = e.max[0] - e.min[0], d = e.max[2] - e.min[2];
      rows.push(`${ys}: ${l.blocks} in x ${range(e.min[0], e.max[0] - 1)}, z ${range(e.min[2], e.max[2] - 1)} (${w}×${d}, ${pct(l.blocks, w * d)} filled)`);
    }
    i = j;
  }
  lines.push("layers (blocks, x/z extent, share of extent filled):");
  if (rows.length <= MAX_LAYER_ROWS) lines.push(...rows.map((r) => `  ${r}`));
  else {
    const h = MAX_LAYER_ROWS / 2;
    lines.push(...rows.slice(0, h).map((r) => `  ${r}`), `  … ${rows.length - MAX_LAYER_ROWS} more rows (measure a region, or use view_slice)`, ...rows.slice(-h).map((r) => `  ${r}`));
  }

  const top = a.materials.slice(0, 8).map(([id, n]) => `${shortState(id, registry)} ${n} (${pct(n, a.blocks)})`);
  const rest = a.materials.slice(8);
  lines.push(`materials: ${top.join(", ")}${rest.length ? `, +${rest.length} more ids (${rest.reduce((s, [, n]) => s + n, 0)} blocks)` : ""}`);

  let conn = `connectivity: ${plural(a.groups, "group")} (faces, edges and corners join)`;
  if (!a.ungrounded.length) conn += `; all reach the bottom layer (y=${a.box.min[1]})`;
  else {
    const shown = a.ungrounded.slice(0, 5).map((g) => (g.count === 1 ? `1 block at ${formatVec(g.positions[0]!)}` : `${g.count} blocks in ${formatBox(g.box)}`));
    conn += `; ${a.ungrounded.length} not reaching the bottom layer (y=${a.box.min[1]}): ${shown.join("; ")}${a.ungrounded.length > 5 ? "; …" : ""}`;
  }
  lines.push(conn);

  const e = a.enclosed;
  let air = `enclosed air (not reachable from outside; any block bounds it): ${e.length ? plural(e.length, "region") : "none"}`;
  if (e.length) {
    air += ": " + e.slice(0, 6).map((r) => `${r.volume} in ${formatBox(r.box)}`).join("; ");
    if (e.length > 6) air += `; +${e.length - 6} more (${e.slice(6).reduce((s, r) => s + r.volume, 0)} positions)`;
  }
  lines.push(air);
  return lines.join("\n");
}
