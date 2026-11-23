import { Image, type RGBA } from "../../palette/image.js";
import type { SearchResult } from "../protocol/messages.js";
import type { MaterialGroup } from "./materials.js";

/**
 * How a material search's answer is shown to the agent (docs/design/18-select.md, piece 2): a heat
 * map, one cell per chunk, north up, the player marked, ungenerated chunks marked, and a short text
 * list of the clusters with distance, bearing and counts per material. Measurements only: clusters
 * are listed nearest first (the walk's order) and the densest is named, nothing more is ranked or
 * judged (`18`, *Principles*).
 */

/** Clusters listed in the text; the rest are counted (the image shows them all). */
export const LISTED_CLUSTERS = 10;

/** One cluster as the text and the image describe it. */
export interface ClusterSummary {
  /** 1-based, in walk order (nearest first), as numbered in the image. */
  n: number;
  closed: boolean;
  min: [number, number];
  max: [number, number];
  chunks: number;
  blocks: number;
  /** Count-weighted centre of its chunks, in blocks `[x, z]`. */
  centre: [number, number];
  /** Section y range with matches, in blocks (inclusive). */
  y: [number, number];
  /** Matching blocks per material group, in group order. */
  counts: number[];
}

/** Sums a search answer per cluster, the wire's per-material counts folded into the agent's groups. */
export function summarizeClusters(r: SearchResult, groupOf: readonly number[], groups: number): ClusterSummary[] {
  const acc = r.clusters.map((c, i) => ({ c, i, wx: 0, wz: 0, w: 0, ylo: Infinity, yhi: -Infinity, counts: new Array<number>(groups).fill(0) }));
  for (const ch of r.chunks) {
    const a = acc[ch.cluster];
    if (!a) continue;
    const n = ch.counts.reduce((s, v) => s + v, 0);
    a.wx += (ch.chunk[0] * 16 + 8) * n;
    a.wz += (ch.chunk[1] * 16 + 8) * n;
    a.w += n;
    ch.counts.forEach((v, i) => (a.counts[groupOf[i] ?? 0]! += v));
    for (const s of ch.sections) (a.ylo = Math.min(a.ylo, s * 16)), (a.yhi = Math.max(a.yhi, s * 16 + 15));
  }
  return acc.map(({ c, i, wx, wz, w, ylo, yhi, counts }) => {
    const mid: [number, number] = [((c.min[0] + c.max[0] + 1) * 16) / 2, ((c.min[1] + c.max[1] + 1) * 16) / 2];
    return {
      n: i + 1,
      closed: c.closed,
      min: c.min,
      max: c.max,
      chunks: c.chunks,
      blocks: c.blocks,
      centre: w ? [Math.round(wx / w), Math.round(wz / w)] : mid,
      y: Number.isFinite(ylo) ? [ylo, yhi] : [0, 0],
      counts,
    };
  });
}

const BEARINGS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];

/** Distance (blocks, horizontal) and 8-point bearing from `from` to `to`, both `[x, z]`; north is −z. */
export function bearing(from: [number, number], to: [number, number]): { distance: number; bearing: string } {
  const dx = to[0] - from[0], dz = to[1] - from[1];
  const distance = Math.round(Math.hypot(dx, dz));
  if (distance < 8) return { distance, bearing: "here" };
  const deg = (Math.atan2(dx, -dz) * 180) / Math.PI;
  return { distance, bearing: BEARINGS[((Math.round(deg / 45) % 8) + 8) % 8]! };
}

const short = (s: string) => s.replace(/^minecraft:/, "").replace(/^family:minecraft:/, "family:").replace(/^#minecraft:/, "#");

export interface DescribeOptions {
  groups: readonly MaterialGroup[];
  groupOf: readonly number[];
  /** Where distances are measured from, in blocks `[x, z]`: the player, else the centre chunk's middle. */
  from: [number, number];
  /** "the player" or "chunk (cx,cz)". */
  fromName: string;
  /** Whether this answer continued an earlier walk. */
  continued: boolean;
}

/** The search's text: header, materials, one line per listed cluster, and what to do next. */
export function describeSearch(r: SearchResult, o: DescribeOptions): string {
  const cs = summarizeClusters(r, o.groupOf, o.groups.length);
  const closed = cs.filter((c) => c.closed).length;
  const plural = (n: number, w: string) => `${n.toLocaleString("en-US")} ${w}${n === 1 ? "" : "s"}`;
  const lines: string[] = [];
  lines.push(
    `ok · world_search${o.continued ? " (continued)" : ""} · ${plural(cs.length, "cluster")} (${closed} closed, ${cs.length - closed} open) · ` +
      `rings 0–${r.reached} of ${r.radius} walked around chunk (${r.centre[0]},${r.centre[1]}) in ${r.dimension}` +
      (r.missing.length ? ` · ${plural(r.missing.length, "ungenerated chunk")} not read` : ""),
  );
  if (r.clipped) lines.push(`The radius was clipped to ${r.radius} chunks (the mod's selectChunks).`);
  lines.push(`Materials: ${o.groups.map((g, i) => `[${i + 1}] ${short(g.given)}${g.members > 1 ? ` (${g.members} ids)` : ""}`).join(", ")}. Distances from ${o.fromName}.`);
  const densest = cs.reduce<ClusterSummary | undefined>((d, c) => (!d || c.blocks > d.blocks ? c : d), undefined);
  for (const c of cs.slice(0, LISTED_CLUSTERS)) {
    const { distance, bearing: b } = bearing(o.from, c.centre);
    const where = b === "here" ? "here" : `${distance} blocks ${b}`;
    const per = c.counts.map((n, i) => (n ? `[${i + 1}] ${n.toLocaleString("en-US")}` : "")).filter(Boolean).join(", ");
    lines.push(
      `#${c.n} ${c.closed ? "closed" : "open (may reach past the walk)"} · ${where} (centre x ${c.centre[0]} z ${c.centre[1]}) · ` +
        `${plural(c.chunks, "chunk")} x ${c.min[0] * 16}..${c.max[0] * 16 + 15} z ${c.min[1] * 16}..${c.max[1] * 16 + 15}, y ${c.y[0]}..${c.y[1]} · ` +
        `${plural(c.blocks, "block")}${per ? `: ${per}` : ""}${c === densest && cs.length > 1 ? " · densest" : ""}`,
    );
  }
  if (cs.length > LISTED_CLUSTERS) lines.push(`… ${cs.length - LISTED_CLUSTERS} more cluster(s) farther out, unnumbered in the image.`);
  if (!cs.length) lines.push(`No matches within ring ${r.reached}.`);
  lines.push(
    r.reached >= r.radius
      ? "The walk covered the whole radius."
      : `The walk stopped at ring ${r.reached}: world_search({continue:true}) walks on for more clusters (stop:n for several).`,
  );
  return lines.join("\n");
}

// ── heat map ──────────────────────────────────────────────────────────────────────────────────

/** Longest side of the map's grid in pixels (a cell is at least 1 px, at most `MAX_CELL`). */
const MAP_PX = 480;
const MAX_CELL = 24;
const TOP = 12; // room for the "N" above the grid
const BG: RGBA = [18, 18, 22, 255];
const EMPTY: RGBA = [44, 44, 50, 255];
const UNGENERATED: RGBA = [8, 8, 8, 255];
const UNGENERATED_MARK: RGBA = [110, 110, 110, 255];
const LOW: [number, number, number] = [110, 60, 20];
const HIGH: [number, number, number] = [255, 235, 140];
const PLAYER: RGBA = [0, 220, 255, 255];
const CLOSED: RGBA = [255, 255, 255, 255];
const OPEN: RGBA = [255, 80, 200, 255];
const LABEL_BG: RGBA = [0, 0, 0, 200];

/** The density shade of a chunk's count, on a log scale up to the walk's largest count. */
export function shade(n: number, max: number): RGBA {
  const t = max <= 1 ? 1 : Math.log1p(n) / Math.log1p(max);
  return [Math.round(LOW[0] + (HIGH[0] - LOW[0]) * t), Math.round(LOW[1] + (HIGH[1] - LOW[1]) * t), Math.round(LOW[2] + (HIGH[2] - LOW[2]) * t), 255];
}

export interface HeatMap {
  png: Buffer;
  width: number;
  height: number;
  /** Pixels per chunk. */
  cell: number;
  /** The chunks shown: the walked square, `[cx, cz]` min and max. */
  min: [number, number];
  max: [number, number];
  /** The largest chunk count (the brightest shade). */
  peak: number;
  caption: string;
}

/**
 * Draws the walked square of a search answer: one cell per chunk (x east, z south, so north is up),
 * matching chunks shaded by their total count, ungenerated chunks black with a grey cross, the
 * player's chunk ringed in cyan, clusters outlined (closed white, open magenta) and numbered as in
 * the text.
 */
export function heatMap(r: SearchResult, player?: [number, number]): HeatMap {
  const ring = Math.max(0, r.reached);
  const side = 2 * ring + 1;
  const cell = Math.max(1, Math.min(MAX_CELL, Math.floor(MAP_PX / side)));
  const min: [number, number] = [r.centre[0] - ring, r.centre[1] - ring];
  const max: [number, number] = [r.centre[0] + ring, r.centre[1] + ring];
  const w = side * cell, h = side * cell + TOP;
  const img = new Image(w, h);
  img.fillRect(0, 0, w, h, BG);
  const inset = cell >= 6 ? 1 : 0;
  const px = (cx: number) => (cx - min[0]) * cell;
  const py = (cz: number) => (cz - min[1]) * cell + TOP;
  img.fillRect(0, TOP, w, h - TOP, EMPTY);
  if (inset) for (let i = 0; i <= side; i++) (img.fillRect(i * cell, TOP, 1, h - TOP, BG), img.fillRect(0, TOP + i * cell, w, 1, BG));
  const totals = r.chunks.map((c) => c.counts.reduce((s, v) => s + v, 0));
  const peak = totals.reduce((m, v) => Math.max(m, v), 0);
  r.chunks.forEach((c, i) => img.fillRect(px(c.chunk[0]) + inset, py(c.chunk[1]) + inset, cell - inset, cell - inset, shade(totals[i]!, peak)));
  for (const [cx, cz] of r.missing) {
    const x = px(cx) + inset, y = py(cz) + inset, s = cell - inset;
    img.fillRect(x, y, s, s, UNGENERATED);
    if (s >= 3) for (let k = 0; k < s; k++) (img.blend(x + k, y + k, UNGENERATED_MARK), img.blend(x + s - 1 - k, y + k, UNGENERATED_MARK));
  }
  const outline = (x0: number, y0: number, x1: number, y1: number, c: RGBA) => {
    img.fillRect(x0, y0, x1 - x0, 1, c);
    img.fillRect(x0, y1 - 1, x1 - x0, 1, c);
    img.fillRect(x0, y0, 1, y1 - y0, c);
    img.fillRect(x1 - 1, y0, 1, y1 - y0, c);
  };
  r.clusters.forEach((c, i) => {
    const x0 = px(c.min[0]), y0 = py(c.min[1]), x1 = px(c.max[0] + 1), y1 = py(c.max[1] + 1);
    outline(x0, y0, x1, y1, c.closed ? CLOSED : OPEN);
    if (i < LISTED_CLUSTERS) {
      const label = String(i + 1);
      const lw = label.length * 6 + 1;
      const lx = Math.min(Math.max(0, x0), w - lw), ly = y0 - 9 >= TOP ? y0 - 9 : Math.max(TOP, Math.min(y1 + 1, h - 9));
      img.fillRect(lx, ly, lw, 9, LABEL_BG);
      img.text(label, lx + 1, ly + 1, c.closed ? CLOSED : OPEN);
    }
  });
  if (player && player[0] >= min[0] && player[0] <= max[0] && player[1] >= min[1] && player[1] <= max[1]) {
    const x = px(player[0]), y = py(player[1]);
    const s = Math.max(cell, 5);
    const o = Math.floor((s - cell) / 2);
    outline(x - o, y - o, x - o + s, y - o + s, PLAYER);
    if (s >= 7) outline(x - o + 2, y - o + 2, x - o + s - 2, y - o + s - 2, PLAYER);
  }
  img.text("N", Math.floor(w / 2) - 2, 2, [220, 220, 220, 255]);
  const caption =
    `Heat map: ${side}×${side} chunks (${min[0]},${min[1]})–(${max[0]},${max[1]}), ${cell} px per chunk (16×16 blocks), north up. ` +
    `Shade = matching blocks per chunk, log scale, brightest ${peak.toLocaleString("en-US")}; cyan ring = the player's chunk; ` +
    `outlines: white closed cluster, magenta open; numbers as in the list${r.missing.length ? "; black with a grey cross = ungenerated" : ""}.`;
  return { png: img.encodePng(), width: w, height: h, cell, min, max, peak, caption };
}
