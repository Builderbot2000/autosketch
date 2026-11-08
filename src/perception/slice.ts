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
 *
 * In a sandbox (11) rows that hold read-only context are marked: "| ctx" when the whole row is
 * context, "| ctx x-3..-1,8..10" naming the context columns otherwise.
 */

export const SLICE_MAX = 64;
const POOL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789#$%&*+=?@^~<>{}";

export interface SliceOptions {
  axis: "x" | "y" | "z";
  at: number;
  /** Local half-open box limiting the other two axes (defaults to the document bounds). */
  region?: Box;
  /**
   * grid (default): one character per block. runs: each row as runs of the same block
   * ("x0-15 S, x20 G"), empty rows skipped: shorter for sparse layers, so the cap is larger.
   */
  mode?: "grid" | "runs";
}

/** Larger cap for run-length slices, which cost per run instead of per block. */
export const SLICE_RUNS_MAX = 256;

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
  const runs = opts.mode === "runs";
  const cap = runs ? SLICE_RUNS_MAX : SLICE_MAX;
  let c0 = layer.min[ca]!, c1 = layer.max[ca]!, r0 = layer.min[ra]!, r1 = layer.max[ra]!;
  if (size[ca]! > cap) {
    c1 = c0 + cap;
    notes.push(`cropped ${axisName(ca)} to ${c0}..${c1 - 1} of ${layer.min[ca]}..${layer.max[ca]! - 1}; pass region to see the rest`);
  }
  if (size[ra]! > cap) {
    if (rowsDown) r1 = r0 + cap;
    else r0 = r1 - cap;
    notes.push(`cropped ${axisName(ra)} to ${r0}..${r1 - 1} of ${layer.min[ra]}..${layer.max[ra]! - 1}; pass region to see the rest`);
  }

  // Context marks (11): per row, the column ranges that are read-only context.
  const context = doc.context && !doc.context.isEmpty() ? doc.context : undefined;
  const ctxMark = (r: number): string => {
    if (!context) return "";
    const ranges: [number, number][] = [];
    for (let c = c0; c < c1; c++) {
      const p = [0, 0, 0] as [number, number, number];
      p[a] = opts.at;
      p[ca] = c;
      p[ra] = r;
      if (!context.has(p[0], p[1], p[2])) continue;
      const last = ranges[ranges.length - 1];
      if (last && last[1] === c - 1) last[1] = c;
      else ranges.push([c, c]);
    }
    if (!ranges.length) return "";
    if (ranges.length === 1 && ranges[0]![0] === c0 && ranges[0]![1] === c1 - 1) return "  | ctx";
    return `  | ctx ${axisName(ca)}${ranges.map(([x, y]) => (x === y ? `${x}` : `${x}..${y}`)).join(",")}`;
  };
  if (context) notes.push('"| ctx" marks read-only context (the sandbox\'s surroundings; not editable)');

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
  const charOf = (s: string) => (s === "minecraft:air" ? "." : chars.map.get(s) ?? "?");
  const legendLine = () => {
    const legend = [...chars.map].map(([s, ch]) => `${ch} ${shortState(s, registry)} (${counts.get(s)})`);
    return legend.length ? `legend: . air, ${legend.join(", ")}` : "legend: . air (layer is empty)";
  };

  if (runs) {
    const out: string[] = [`${opts.axis}=${opts.at}  rows ${axisName(ra)}${rowsDown ? "↓" : "↑"} ${rowsDown ? `${r0}..${r1 - 1}` : `${r1 - 1}..${r0}`}, columns ${axisName(ca)} ${c0}..${c1 - 1}  (${viewName(a)}) · runs; rows not listed are empty`];
    const cn = axisName(ca), rn = axisName(ra);
    grid.forEach((line, i) => {
      const parts: string[] = [];
      for (let k = 0; k < line.length; ) {
        let e = k;
        while (e + 1 < line.length && line[e + 1] === line[k]) e++;
        if (line[k] !== "minecraft:air") parts.push(`${cn}${c0 + k}${e > k ? `-${c0 + e}` : ""} ${charOf(line[k]!)}`);
        k = e + 1;
      }
      if (parts.length) out.push(`${rn}${rows[i]}: ${parts.join(", ")}${ctxMark(rows[i]!)}`);
    });
    out.push(legendLine());
    for (const n of notes) out.push(`note: ${n}`);
    return out.join("\n");
  }
  const solid = [...counts.values()].reduce((s, v) => s + v, 0);
  const cellsN = rows.length * (c1 - c0);
  if (cellsN > 400 && solid < cellsN * 0.1) notes.push('sparse layer: mode:"runs" lists it more briefly');

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
  grid.forEach((line, i) => out.push(`${String(rows[i]).padStart(width)} ${line.map(charOf).join("")}${ctxMark(rows[i]!)}`));
  out.push(legendLine());
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
