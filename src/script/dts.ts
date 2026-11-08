import { SCRIPT_OPS, type ScriptOp } from "./ops.js";

/**
 * The script API reference as TypeScript declarations, generated from the op registry
 * (docs/design/05-operations.md, Scripting; resolves the open question on the API surface). Served
 * as the MCP resource `autosketch://script/api.d.ts`.
 */

const HEADER = `// Autosketch script API (docs/design/05-operations.md, Scripting L4).
// A script is a function body: \`args\` holds the arguments, \`return\` gives the result (JSON).
// The whole run is one undo step; if it throws or hits a limit (64 MB, 10 s), nothing changes.
// Coordinates are document-local; boxes are inclusive, as in the tools.
// Plugin ops (ops_list) are functions too: framed.shape({ sel, shape, … }) takes op_run's args
// and returns an EditSummary.

type Vec3 = [number, number, number];
type Box = { min: Vec3; max: Vec3 };
/** A block, "a 70%, b 30%", "palette:<name>.<role>", or {gradient|noise|pattern}. */
type Pattern = string | Record<string, unknown>;
/** A selection: a Sel, a stored name, "all", "last", or a JSON tree as the tools take. */
type SelLike = Sel | string | Record<string, unknown>;
type Direction = "up" | "down" | "north" | "south" | "east" | "west";
/** [x,y,z] · "comp.anchor" · {anchor, offset} · {face:"comp.front", u, v}. */
type At = Vec3 | string | { anchor: string; offset?: Vec3 } | { face: string; u?: number | string; v?: number | string; offset?: Vec3 };
/** raw skips auto-connection; as/kind register the affected box as a component. */
type OpOpts = { raw?: boolean; as?: string; kind?: string };
type StampOpts = { at: At; anchor?: string; palette_remap?: Record<string, string>; include_air?: boolean; as?: string; rotate?: 0 | 90 | 180 | 270; mirror?: "x" | "z" };
interface EditSummary { op: string; changed: number; box?: Box; warnings: string[]; component?: string; notes?: string[] }
interface SelectionInfo { count: number; solid: number; bbox?: Box; components: string[] }
interface RegionInfo { volume: number; solid: number; bbox?: Box; families: [string, number][]; inside: string[]; touching: string[] }
interface ComponentInfo { id: string; kind?: string; box: Box; tags: string[]; anchors: Record<string, Vec3>; parent?: string; region: Sel; anchor(name: string): Vec3 }
interface PaletteInfo { name: string; roles: Record<string, { block: string; weight: number }[]> }

/** A selection expression; compiles to the same JSON tree the tools take (JSON.stringify shows it). */
declare class Sel {
  readonly tree: string | Record<string, unknown>;
  fill(pattern: Pattern, opts?: OpOpts & { mode?: "fill" | "hollow" | "outline" | "walls"; thickness?: number }): EditSummary;
  clear(opts?: OpOpts): EditSummary;
  replace(from: string, to: Pattern, opts?: OpOpts & { keep_states?: boolean }): EditSummary;
  hollow(opts?: OpOpts & { thickness?: number; pattern?: Pattern }): EditSummary;
  paint(pattern: Pattern, opts?: OpOpts & { dirs?: Direction[] }): EditSummary;
  move(by: Vec3, opts?: OpOpts): EditSummary;
  copy(by: Vec3, opts?: OpOpts & { turns?: number; mirror?: "x" | "y" | "z" }): EditSummary;
  rotate(turns: number, opts?: OpOpts & { pivot?: Vec3 }): EditSummary;
  mirror(axis: "x" | "y" | "z", opts?: OpOpts & { about?: number }): EditSummary;
  union(...b: SelLike[]): Sel; subtract(...b: SelLike[]): Sel; intersect(...b: SelLike[]): Sel;
  dilate(by?: number | Vec3 | Partial<Record<Direction, number>>): Sel; erode(by?: number | Vec3 | Partial<Record<Direction, number>>): Sel;
  offset(dx: number | Vec3, dy?: number, dz?: number): Sel; shell(thickness?: number, opts?: { walls_only?: boolean }): Sel;
  layer(y: number | "min" | "max"): Sel; filter(f: string | { block?: string; air?: boolean }): Sel;
  every(n: number, opts?: { along?: "x" | "y" | "z"; offset?: number }): Sel; perimeter(): Sel;
  info(): SelectionInfo; count(): number; positions(): Vec3[];
}

/** tag: "#ns:tag" (by "tag"); palette, role (by "role"); tolerance: CIELAB ΔE (by "colour", default 10). */
type MatchOpts = { tag?: string; palette?: string; role?: string; tolerance?: number };
type Match = "block" | "state" | "family" | "solid" | "air" | "tag" | "role" | "colour" | \`prop:\${string}\`;

declare const sel: {
  box(min: Vec3, max?: Vec3): Sel; readonly all: Sel; readonly last: Sel; named(name: string): Sel; component(id: string): Sel; kind(kind: string): Sel; tagged(tag: string): Sel;
  cylinder(center: Vec3, radius: number, height?: number, axis?: "x" | "y" | "z"): Sel; sphere(center: Vec3, radius: number): Sel; ellipsoid(center: Vec3, radii: Vec3): Sel;
  polygon(points: [number, number][], y0: number, y1?: number): Sel; plane(axis: "x" | "y" | "z", at: number, within?: SelLike): Sel;
  hull(points: Vec3[]): Sel; tube(path: Vec3[], radius: number): Sel;
  connected(seed: Vec3, opts?: { match?: Match; connectivity?: 6 | 18 | 26; within?: SelLike } & MatchOpts): Sel;
  similar(seed: Vec3, opts?: { by?: Match; within?: SelLike } & MatchOpts): Sel;
  union(...a: SelLike[]): Sel; intersect(...a: SelLike[]): Sel; subtract(...a: SelLike[]): Sel; xor(a: SelLike, b: SelLike): Sel; invert(a: SelLike, within?: SelLike): Sel;
  dilate(a: SelLike, by?: number | Vec3 | Partial<Record<Direction, number>>): Sel; erode(a: SelLike, by?: number | Vec3 | Partial<Record<Direction, number>>): Sel;
  offset(a: SelLike, dx: number | Vec3, dy?: number, dz?: number): Sel; shell(a: SelLike, thickness?: number, opts?: { walls_only?: boolean }): Sel;
  layer(a: SelLike, y: number | "min" | "max"): Sel; surface(a: SelLike, opts?: { dirs?: Direction[] }): Sel; bbox(a: SelLike): Sel;
  filter(a: SelLike, f: string | { block?: string; air?: boolean }): Sel; rotate(a: SelLike, turns: number, pivot?: Vec3): Sel; mirror(a: SelLike, axis: "x" | "y" | "z", about?: number): Sel;
  grow(a: SelLike, by?: number, match?: "solid" | "same" | "any"): Sel; shrink(a: SelLike, by?: number): Sel; edges(a: SelLike): Sel;
  slab(a: SelLike, axis: "x" | "y" | "z", from: number, to: number): Sel; convex(a: SelLike): Sel; fill_holes(a: SelLike): Sel;
  checker(a: SelLike, opts?: { size?: number; odd?: boolean }): Sel; random(a: SelLike, ratio: number, seed?: number): Sel;
  every(a: SelLike, n: number, opts?: { along?: "x" | "y" | "z"; offset?: number }): Sel; freeze(a: SelLike): Sel;
  /** The outer ring of a layer (crenellations, parapets): shell with walls_only. */
  perimeter(a: SelLike): Sel;
  /** Wraps any JSON selection tree (including those the tools document). */
  from(tree: string | Record<string, unknown>): Sel;
};

/** Arguments passed to run_script / run_procedure. */
declare const args: Record<string, any>;
/** Appends a line to the run's log (capped at about 2 KB). */
declare function log(...values: unknown[]): void;
/** Seeded random number in [0, 1); Math.random is the same generator. */
declare function rand(): number;
/** array with { along, every } returns a selection of template copies along a path. */
declare function array(template: SelLike, opts: { along: SelLike; every?: number; offset?: number }): Sel;
`;

export function scriptApiDts(extra: readonly ScriptOp[] = []): string {
  const lines = [HEADER];
  const spaces = new Map<string, string[]>();
  for (const op of [...SCRIPT_OPS, ...extra]) {
    const dot = op.name.lastIndexOf(".");
    const decl = `/** ${op.doc} */\n`;
    if (dot < 0) {
      if (op.name === "component") lines.push(`${decl}declare function component(id: string): ComponentInfo | null;`);
      else lines.push(`${decl}declare function ${op.name}(${op.params}): ${op.returns};`);
      continue;
    }
    const ns = op.name.slice(0, dot);
    const list = spaces.get(ns) ?? [];
    list.push(`  /** ${op.doc} */\n  function ${op.name.slice(dot + 1)}(${op.params}): ${op.returns};`);
    spaces.set(ns, list);
  }
  for (const [ns, fns] of spaces) lines.push(`declare namespace ${ns} {\n${fns.join("\n")}\n}`);
  return `${lines.join("\n")}\n`;
}
