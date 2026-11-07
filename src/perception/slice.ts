import type { Registry } from "../assets/registry.js";
import { shortState } from "../core/blockstate.js";
import { boxSize, intersectBox, isEmptyBox, type Box } from "../core/region.js";
import type { Document } from "../document/document.js";

/**
 * view_slice (docs/design/06-perception.md): one layer of the document as a character grid with
 * an automatic legend. Exact and cheap; the agent's main way to check a build before renders.
 *
 *   axis y: looking down, rows = z (north at top), columns = x (west at left)
 *   axis z: looking north at a south-facing elevation, rows = y (top first), columns = x
 *   axis x: looking east at the west face, rows = y (top first), columns = z (north at left)
 */

export const SLICE_MAX = 64;
const POOL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789#$%&*+=?@^~<>{}";

export interface SliceOptions {
  axis: "x" | "y" | "z";
  at: number;
  /** Local half-open box limiting the other two axes (defaults to the document bounds). */
  region?: Box;
}

export function viewSlice(doc: Document, registry: Registry | undefined, opts: SliceOptions): string {
  const bounds = doc.localBounds();
  if (!bounds) return "The document is empty.";
  const a = opts.axis === "x" ? 0 : opts.axis === "y" ? 1 : 2;
  if (!Number.isInteger(opts.at)) throw new Error("at must be an integer");
  const area = opts.region ? intersectBox(opts.region, bounds) : bounds;
  const layer: Box = { min: [...area.min], max: [...area.max] };
  layer.min[a] = opts.at;
  layer.max[a] = opts.at + 1;
  if (opts.at < bounds.min[a]! || opts.at >= bounds.max[a]!) return `${opts.axis}=${opts.at} is outside the document (${opts.axis} ${bounds.min[a]}..${bounds.max[a]! - 1}).`;
  if (isEmptyBox(layer)) return "The region does not overlap the document.";

  // Grid axes: (column axis, row axis, row direction).
  const [ca, ra, rowsDown] = a === 1 ? [0, 2, true] : a === 2 ? [0, 1, false] : [2, 1, false];
  const size = boxSize(layer);
  const notes: string[] = [];
  let c0 = layer.min[ca]!, c1 = layer.max[ca]!, r0 = layer.min[ra]!, r1 = layer.max[ra]!;
  if (size[ca]! > SLICE_MAX) {
    c1 = c0 + SLICE_MAX;
    notes.push(`cropped ${axisName(ca)} to ${c0}..${c1 - 1} of ${layer.min[ca]}..${layer.max[ca]! - 1}; pass region to see the rest`);
  }
  if (size[ra]! > SLICE_MAX) {
    if (rowsDown) r1 = r0 + SLICE_MAX;
    else r0 = r1 - SLICE_MAX;
    notes.push(`cropped ${axisName(ra)} to ${r0}..${r1 - 1} of ${layer.min[ra]}..${layer.max[ra]! - 1}; pass region to see the rest`);
  }

  const rows: number[] = [];
  if (rowsDown) for (let r = r0; r < r1; r++) rows.push(r);
  else for (let r = r1 - 1; r >= r0; r--) rows.push(r);

  // Count states first so the commonest get the most readable characters.
  const grid: string[][] = [];
  const counts = new Map<string, number>();
  for (const r of rows) {
    const line: string[] = [];
    for (let c = c0; c < c1; c++) {
      const p = [0, 0, 0] as [number, number, number];
      p[a] = opts.at;
      p[ca] = c;
      p[ra] = r;
      const st = doc.getState(p[0], p[1], p[2]);
      line.push(st);
      if (st !== "minecraft:air") counts.set(st, (counts.get(st) ?? 0) + 1);
    }
    grid.push(line);
  }
  const chars = assignChars([...counts.keys()].sort((x, y) => counts.get(y)! - counts.get(x)! || (x < y ? -1 : 1)), registry);
  if (chars.overflow) notes.push(`${chars.overflow} rarer states share "?"`);

  const width = String(Math.max(...rows.map((r) => Math.abs(r)), 0)).length + (rows.some((r) => r < 0) ? 1 : 0);
  const pad = " ".repeat(width + 1);
  const cols: number[] = [];
  for (let c = c0; c < c1; c++) cols.push(c);
  // Tens digit at multiples of 10 and the first column; negative columns are marked "-".
  const tens = cols.map((c) => (c < 0 ? "-" : c % 10 === 0 || c === c0 ? String(Math.floor(c / 10) % 10) : " ")).join("");
  const units = cols.map((c) => String(Math.abs(c) % 10)).join("");
  const out: string[] = [];
  out.push(`${opts.axis}=${opts.at}  columns ${axisName(ca)}→ ${c0}..${c1 - 1}, rows ${axisName(ra)}${rowsDown ? "↓" : "↑"} ${rowsDown ? `${r0}..${r1 - 1}` : `${r1 - 1}..${r0}`}  (${viewName(a)})`);
  out.push(`${pad}${tens}`);
  out.push(`${pad}${units}`);
  grid.forEach((line, i) => out.push(`${String(rows[i]).padStart(width)} ${line.map((s) => (s === "minecraft:air" ? "." : chars.map.get(s) ?? "?")).join("")}`));
  const legend = [...chars.map].map(([s, ch]) => `${ch} ${shortState(s, registry)} (${counts.get(s)})`);
  out.push(legend.length ? `legend: . air, ${legend.join(", ")}` : "legend: . air (layer is empty)");
  for (const n of notes) out.push(`note: ${n}`);
  return out.join("\n");
}

function assignChars(states: string[], registry: Registry | undefined): { map: Map<string, string>; overflow: number } {
  const map = new Map<string, string>();
  const used = new Set<string>();
  let overflow = 0;
  for (const s of states) {
    const name = shortState(s, registry).replace(/^[^:]*:/, "");
    // Prefer the initial of the block name, then its other letters, then the pool.
    const prefs = [...new Set([name[0]?.toUpperCase(), name[0]?.toLowerCase(), ...name.replace(/[^a-z]/gi, "").toUpperCase()])].filter(Boolean) as string[];
    const ch = prefs.find((c) => POOL.includes(c) && !used.has(c)) ?? [...POOL].find((c) => !used.has(c));
    if (!ch) {
      overflow++;
      continue;
    }
    used.add(ch);
    map.set(s, ch);
  }
  return { map, overflow };
}

function axisName(i: number): string {
  return i === 0 ? "x" : i === 1 ? "y" : "z";
}

function viewName(a: number): string {
  return a === 1 ? "top-down, north up" : a === 2 ? "elevation looking north" : "elevation looking east";
}
