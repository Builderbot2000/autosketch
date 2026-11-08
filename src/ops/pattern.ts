import type { Registry } from "../assets/registry.js";
import { canonicalState } from "../core/blockstate.js";
import type { Box } from "../core/region.js";
import { hash01, hashString, valueNoise } from "../core/rng.js";
import type { ShapeKind } from "../palette/families.js";
import type { PaletteIndex } from "../palette/index.js";
import type { PaletteBook } from "../palette/pick.js";
import { didYouMean } from "../palette/sheet.js";

/**
 * Patterns (docs/design/01-conventions.md, WorldEdit's term). Anywhere a block is accepted:
 *
 *   "stone_bricks"                                         single block (with optional [states])
 *   "stone_bricks 70%, mossy_stone_bricks 30%"              weighted mix
 *   {"gradient": [...], "axis": "y", "range": [0,12]}       dithered gradient
 *   {"noise": [...], "scale": 6}                            organic patches
 *   {"tile": "checker", "blocks": [...], "size": 1}         tiling
 *   "palette:castle.wall"                                   named palette role (03)
 *
 * Entries nest. Results are a pure function of (seed, position), so re-running an op is stable.
 */

export type PatternExpr =
  | string
  | { gradient: PatternExpr[]; axis?: "x" | "y" | "z"; range?: [number, number] }
  | { noise: PatternExpr[]; scale?: number }
  | { tile: "checker" | "stripes_x" | "stripes_y" | "stripes_z"; blocks: PatternExpr[]; size?: number };

/** Samples a canonical state id at a local position. */
export type PatternFn = (x: number, y: number, z: number) => number;

export interface PatternContext {
  registry?: Registry;
  index?: PaletteIndex;
  palettes?: PaletteBook;
  seed: number;
  intern: (state: string) => number;
  /** The op's local box; gradients without a range span it. */
  box?: Box;
  /** Shape wanted from palette roles ("full" = the cube block). */
  shape?: ShapeKind | "full";
  warn?: (msg: string) => void;
}

const MAX_DEPTH = 8;

export function compilePattern(expr: PatternExpr, ctx: PatternContext): PatternFn {
  return compile(expr, ctx, 0);
}

function compile(expr: PatternExpr, ctx: PatternContext, depth: number): PatternFn {
  if (depth > MAX_DEPTH) throw new Error("pattern nests too deeply (palette roles referring to each other?)");
  if (typeof expr === "string") return compileString(expr, ctx, depth);
  if (expr && typeof expr === "object") {
    if ("gradient" in expr) return compileGradient(expr, ctx, depth);
    if ("noise" in expr) return compileNoise(expr, ctx, depth);
    if ("tile" in expr) return compileTile(expr, ctx, depth);
    if ("pattern" in expr) throw new Error('{"pattern": ...} was renamed {"tile": ...}, e.g. {"tile":"checker","blocks":["a","b"]} (01, Terminology)');
  }
  throw new Error(`bad pattern ${JSON.stringify(expr)}: use a block id, "a 70%, b 30%", "palette:<name>.<role>", or {gradient|noise|tile}`);
}

function compileString(text: string, ctx: PatternContext, depth: number): PatternFn {
  const parts = splitTopLevel(text);
  if (parts.length === 0) throw new Error("empty pattern");
  if (parts.length === 1 && !/%\s*$/.test(parts[0]!)) return single(parts[0]!, ctx, depth);

  const entries: { m: PatternFn; w?: number }[] = parts.map((p) => {
    const m = /^(.*?)\s+(\d+(?:\.\d+)?)\s*%$/.exec(p);
    return m ? { m: single(m[1]!, ctx, depth), w: Number(m[2]) } : { m: single(p, ctx, depth) };
  });
  const given = entries.reduce((s, e) => s + (e.w ?? 0), 0);
  const missing = entries.filter((e) => e.w === undefined).length;
  const rest = missing ? Math.max(0, 100 - given) / missing : 0;
  const weights = entries.map((e) => e.w ?? rest);
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) throw new Error(`pattern "${text}" has no positive weights`);
  if (Math.abs(total - 100) > 0.5 && given > 0 && missing === 0) ctx.warn?.(`weights in "${text}" sum to ${total}%; using them as relative weights`);
  return weighted(entries.map((e) => e.m), weights, ctx.seed, hashString(text));
}

function single(text: string, ctx: PatternContext, depth: number): PatternFn {
  const t = text.trim();
  if (t.startsWith("palette:")) {
    if (!ctx.palettes || !ctx.index) throw new Error(`palette materials need a loaded instance ("${t}")`);
    const r = ctx.palettes.resolveMaterial(ctx.index, t, ctx.shape ?? "full");
    for (const w of r.warnings) ctx.warn?.(w);
    return compile(r.expression, ctx, depth + 1);
  }
  let state: string;
  try {
    const c = canonicalState(t, ctx.registry);
    if (c.unknown) {
      const id = c.state.split("[")[0]!;
      throw new Error(`unknown block "${id}" (not in this instance)${ctx.registry ? didYouMean(id, [...ctx.registry.all()].map((b) => b.id)) : ""}`);
    }
    state = c.state;
  } catch (e) {
    throw new Error((e as Error).message);
  }
  const id = ctx.intern(state);
  return () => id;
}

function weighted(ms: PatternFn[], weights: number[], seed: number, salt: number): PatternFn {
  if (ms.length === 1) return ms[0]!;
  const total = weights.reduce((s, w) => s + w, 0);
  const cum: number[] = [];
  let acc = 0;
  for (const w of weights) cum.push((acc += w / total));
  return (x, y, z) => {
    const r = hash01(seed, salt, x, y, z);
    let i = 0;
    while (i < cum.length - 1 && r >= cum[i]!) i++;
    return ms[i]!(x, y, z);
  };
}

function list(expr: PatternExpr[] | undefined, name: string): PatternExpr[] {
  if (!Array.isArray(expr) || expr.length === 0) throw new Error(`${name} needs a non-empty list of patterns`);
  return expr;
}

function compileGradient(e: Extract<PatternExpr, { gradient: unknown }>, ctx: PatternContext, depth: number): PatternFn {
  const ms = list(e.gradient, "gradient").map((x) => compile(x, ctx, depth + 1));
  const axis = e.axis ?? "y";
  if (!["x", "y", "z"].includes(axis)) throw new Error(`gradient axis must be x, y or z (got "${axis}")`);
  const a = axis === "x" ? 0 : axis === "y" ? 1 : 2;
  const [lo, hi] = e.range ?? (ctx.box ? [ctx.box.min[a]!, ctx.box.max[a]! - 1] : [0, 15]);
  const salt = hashString(JSON.stringify(e));
  if (ms.length === 1) return ms[0]!;
  return (x, y, z) => {
    const c = a === 0 ? x : a === 1 ? y : z;
    const t = hi === lo ? 0 : Math.min(1, Math.max(0, (c - lo) / (hi - lo)));
    const f = t * (ms.length - 1);
    let i = Math.floor(f);
    if (i < ms.length - 1 && hash01(ctx.seed, salt, x, y, z) < f - i) i++;
    return ms[Math.min(i, ms.length - 1)]!(x, y, z);
  };
}

function compileNoise(e: Extract<PatternExpr, { noise: unknown }>, ctx: PatternContext, depth: number): PatternFn {
  const ms = list(e.noise, "noise").map((x) => compile(x, ctx, depth + 1));
  const scale = e.scale ?? 4;
  if (!(scale > 0)) throw new Error("noise scale must be > 0");
  const salt = hashString(JSON.stringify(e));
  return (x, y, z) => ms[Math.min(ms.length - 1, Math.floor(valueNoise(ctx.seed, salt, x, y, z, scale) * ms.length))]!(x, y, z);
}

function compileTile(e: Extract<PatternExpr, { tile: unknown }>, ctx: PatternContext, depth: number): PatternFn {
  const ms = list(e.blocks, "tile").map((x) => compile(x, ctx, depth + 1));
  const size = Math.max(1, Math.floor(e.size ?? 1));
  const cell = (v: number) => Math.floor(v / size);
  const mod = (v: number) => ((v % ms.length) + ms.length) % ms.length;
  const pick: Record<string, (x: number, y: number, z: number) => number> = {
    checker: (x, y, z) => mod(cell(x) + cell(y) + cell(z)),
    stripes_x: (x) => mod(cell(x)),
    stripes_y: (_x, y) => mod(cell(y)),
    stripes_z: (_x, _y, z) => mod(cell(z)),
  };
  const f = pick[e.tile];
  if (!f) throw new Error(`unknown tile "${e.tile}" (one of ${Object.keys(pick).join(", ")})`);
  return (x, y, z) => ms[f(x, y, z)]!(x, y, z);
}

/** Splits on commas outside [...] (block states contain commas). */
export function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of text) {
    if (ch === "[") depth++;
    else if (ch === "]") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}
