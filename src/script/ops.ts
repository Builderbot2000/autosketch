import { toPublic, type Vec3 } from "../core/region.js";
import type { Document, EditResult } from "../document/document.js";
import { componentAnchors, resolveAnchor, type AtSpec } from "../ops/anchors.js";
import { array, extrude, hollow, morph, paint, sweep, type MorphMode, type PathCurve, type ProfileCell } from "../ops/brush.js";
import { clear, fill, replace, setBlocks, type CommonOptions, type FillMode, type OpEnv, type Region } from "../ops/edit.js";
import type { MaterialExpr } from "../ops/material.js";
import { checkSelectionName, freezeNodes, resolveSelection, summarize, type SelExpr } from "../ops/selection.js";
import { copy, mirror, move, rotate } from "../ops/transform.js";
import { stampPrefab, type StampOptions } from "../ops/stamp.js";
import { regionSummary } from "../perception/query.js";
import { MAX_ARRAY_ALONG, arrayAlong } from "./along.js";
import type { PreloadedPrefabs } from "./prefabs.js";

/**
 * The script op registry (docs/design/05-operations.md, Scripting L4): every function a script can
 * call besides the `sel.*` builders, with its TypeScript signature. The sandbox prelude binds one
 * global per entry, and `scriptApiDts()` generates the API reference from the same list, so the
 * docs can't drift from what runs.
 *
 * Plugin hook (09, `actions`; silo E): pass extra entries to `runScript({ ops })`, named
 * "<plugin>.<action>" — the prelude makes dotted names into namespace objects (`framed.camo(…)`).
 * Entries run synchronously inside the script's journal entry, so they must edit through
 * `doc.edit` (which joins the script's group) and not await.
 */

export interface ScriptHost {
  doc: Document;
  env: OpEnv;
  /** Ops that changed something, for the run's diff summary. */
  edits: number;
  /** Prefabs loaded before the run, for `stamp` (see `prefabs.ts`). */
  prefabs?: PreloadedPrefabs;
}

function stampOp(h: ScriptHost, ref: unknown, x: unknown): EditSummary {
  if (typeof ref !== "string" || !ref) throw new Error('stamp takes a prefab name, e.g. stamp("hut", { at: [0, 0, 0] })');
  const got = h.prefabs?.get(ref);
  if (!got) throw new Error(`prefab "${ref}" wasn't loaded before the run: write its name as a string literal in stamp("…"), or list it in run_script's prefabs`);
  if (got instanceof Error) throw got;
  const a = o(x);
  if (a.at === undefined) throw new Error("stamp needs at");
  const opts: StampOptions = {
    at: a.at as AtSpec,
    ...(typeof a.anchor === "string" ? { anchor: a.anchor } : {}),
    ...(a.palette_remap ? { remap: a.palette_remap as Record<string, string> } : {}),
    ...(a.include_air ? { includeAir: true } : {}),
    ...(typeof a.as === "string" ? { as: a.as } : {}),
    ...(a.rotate !== undefined ? { rotate: a.rotate as number } : {}),
    ...(a.mirror !== undefined ? { mirror: a.mirror as "x" | "z" } : {}),
  };
  return summary(h, stampPrefab(h.doc, h.env, got.prefab, got.loaded, opts));
}

export interface ScriptOp {
  /** Global name, or "<namespace>.<name>". */
  name: string;
  /** TypeScript parameter list, e.g. "sel: SelLike, material: Material, opts?: OpOpts". */
  params: string;
  /** TypeScript return type. */
  returns: string;
  /** One-line description for the generated .d.ts. */
  doc: string;
  /** The prelude wraps the result in a `Sel` (for ops returning selections). */
  returnsSel?: boolean;
  /** Arguments arrive JSON-decoded (`Sel` values as expression trees). The result must be JSON-able. */
  run(h: ScriptHost, args: unknown[]): unknown;
}

/** What every editing op returns inside a script. */
export interface EditSummary {
  op: string;
  changed: number;
  box?: { min: Vec3; max: Vec3 };
  warnings: string[];
  component?: string;
  notes?: string[];
}

function summary(h: ScriptHost, r: EditResult & { component?: string; notes?: string[] }): EditSummary {
  if (r.changed) h.edits++;
  return {
    op: r.op,
    changed: r.changed,
    ...(r.box ? { box: toPublic(r.box) } : {}),
    warnings: r.warnings,
    ...(r.component ? { component: r.component } : {}),
    ...(r.notes?.length ? { notes: r.notes } : {}),
  };
}

function region(h: ScriptHost, x: unknown): Region {
  if (x === undefined || x === null) throw new Error("expected a selection (sel.box(...), a name, or a tree)");
  const expr = x as SelExpr;
  const r = resolveSelection(expr, { doc: h.doc, ...(h.env.registry ? { registry: h.env.registry } : {}), ...(h.env.index ? { index: h.env.index } : {}) });
  if (expr !== "last") h.doc.lastSelection = expr;
  if (r.mask.isEmpty()) throw new Error(["the selection is empty", ...r.notes].join("; "));
  return r.mask;
}

type Opts = Record<string, unknown>;
const o = (x: unknown): Opts => (x && typeof x === "object" && !Array.isArray(x) ? (x as Opts) : {});
const common = (x: Opts): CommonOptions => ({ ...(x.raw ? { raw: true } : {}), ...(typeof x.as === "string" ? { as: x.as } : {}), ...(typeof x.kind === "string" ? { kind: x.kind } : {}) });
const pick = (x: Opts, keys: string[]): Opts => Object.fromEntries(keys.filter((k) => x[k] !== undefined).map((k) => [k, x[k]]));
const GEN = ["as", "kind", "raw"];

export const SCRIPT_OPS: readonly ScriptOp[] = [
  // -- edits (L0/L2) --
  {
    name: "fill",
    params: 'sel: SelLike, material: Material, opts?: OpOpts & { mode?: "fill" | "hollow" | "outline" | "walls"; thickness?: number }',
    returns: "EditSummary",
    doc: "Fills a selection with a material (modes as the fill tool).",
    run: (h, [s, m, x]) => summary(h, fill(h.doc, h.env, region(h, s), m as MaterialExpr, { ...common(o(x)), ...(o(x).mode ? { mode: o(x).mode as FillMode } : {}), ...(o(x).thickness ? { thickness: o(x).thickness as number } : {}) })),
  },
  { name: "clear", params: "sel: SelLike, opts?: OpOpts", returns: "EditSummary", doc: "Sets a selection to air.", run: (h, [s, x]) => summary(h, clear(h.doc, region(h, s), undefined, { ...common(o(x)), env: h.env })) },
  {
    name: "replace",
    params: "sel: SelLike, from: string, to: Material, opts?: OpOpts & { keep_states?: boolean }",
    returns: "EditSummary",
    doc: 'Replaces matching blocks ("oak_planks", "#minecraft:logs", "*", "air") inside a selection.',
    run: (h, [s, f, t, x]) => summary(h, replace(h.doc, h.env, region(h, s), String(f), t as MaterialExpr, { ...common(o(x)), ...(o(x).keep_states ? { keepStates: true } : {}) })),
  },
  {
    name: "set_blocks",
    params: "blocks: { pos: Vec3; block: Material }[], opts?: OpOpts",
    returns: "EditSummary",
    doc: "Places individual blocks.",
    run: (h, [b, x]) => summary(h, setBlocks(h.doc, h.env, b as { pos: Vec3; block: MaterialExpr }[], undefined, common(o(x)))),
  },
  {
    name: "hollow",
    params: "sel: SelLike, opts?: OpOpts & { thickness?: number; material?: Material }",
    returns: "EditSummary",
    doc: "Keeps a shell and clears the inside.",
    run: (h, [s, x]) => summary(h, hollow(h.doc, h.env, region(h, s), (o(x).thickness as number) ?? 1, o(x).material as MaterialExpr | undefined, common(o(x)))),
  },
  {
    name: "paint",
    params: "sel: SelLike, material: Material, opts?: OpOpts & { dirs?: Direction[] }",
    returns: "EditSummary",
    doc: "Rewrites exposed blocks only.",
    run: (h, [s, m, x]) => summary(h, paint(h.doc, h.env, region(h, s), m as MaterialExpr, { ...common(o(x)), ...(o(x).dirs ? { dirs: o(x).dirs as string[] } : {}) })),
  },
  {
    name: "smooth",
    params: 'sel: SelLike, opts?: OpOpts & { mode?: "smooth" | "erode" | "dilate"; threshold?: number; iterations?: number; material?: Material }',
    returns: "EditSummary",
    doc: "Morphological cleanup.",
    run: (h, [s, x]) => summary(h, morph(h.doc, h.env, region(h, s), ((o(x).mode as MorphMode) ?? "smooth"), { ...common(o(x)), ...(pick(o(x), ["threshold", "iterations", "material"]) as object) })),
  },
  {
    name: "extrude",
    params: "sel: SelLike, n: number, opts?: OpOpts & { dir?: Direction }",
    returns: "EditSummary",
    doc: "Pushes a face out by n (copying blocks) or in by -n.",
    run: (h, [s, n, x]) => summary(h, extrude(h.doc, h.env, region(h, s), n as number, { ...common(o(x)), ...(o(x).dir ? { dir: o(x).dir as string } : {}) })),
  },
  {
    name: "sweep",
    params: 'profile: { u: number; v: number; block: Material }[], path: Vec3[], opts?: OpOpts & { curve?: "polyline" | "smooth" | "bezier" }',
    returns: "EditSummary",
    doc: "Places a cross-section along a path: a polyline, or a smooth (through the points) or bezier (controlled by them) curve (profile authored for travel north, u = east).",
    run: (h, [p, path, x]) => summary(h, sweep(h.doc, h.env, p as ProfileCell[], path as Vec3[], { ...common(o(x)), ...(o(x).curve ? { curve: o(x).curve as PathCurve } : {}) })),
  },
  {
    name: "array",
    params: "sel: SelLike, opts: { step: Vec3; count: number; skip_air?: boolean } & OpOpts",
    returns: "EditSummary",
    doc: "Repeats a selection's blocks count times (the original included), step apart. With { along, every } it returns a selection instead: see arrayAlong.",
    run: (h, [s, x]) => {
      const p = o(x);
      if (p.along !== undefined) return arrayAlong(h, s, p);
      return summary(h, array(h.doc, h.env, region(h, s), p.step as Vec3, p.count as number, { ...common(p), ...(p.skip_air ? { skipAir: true } : {}) }));
    },
  },
  {
    name: "arrayAlong",
    params: "template: SelLike, opts: { along: SelLike; every?: number; offset?: number }",
    returns: "Sel",
    returnsSel: true,
    doc: `Copies of a template selection (authored around [0,0,0]) at every n-th block along a path selection, walked in order from its lowest corner (e.g. sel.perimeter(top) for crenellations). At most ${MAX_ARRAY_ALONG} copies.`,
    run: (h, [s, x]) => arrayAlong(h, s, o(x)),
  },
  { name: "move", params: "sel: SelLike, by: Vec3, opts?: OpOpts & { skip_air?: boolean }", returns: "EditSummary", doc: "Moves blocks by an offset.", run: (h, [s, by, x]) => summary(h, move(h.doc, h.env, region(h, s), by as Vec3, { ...common(o(x)), ...(o(x).skip_air ? { skipAir: true } : {}) })) },
  {
    name: "copy",
    params: 'sel: SelLike, by: Vec3, opts?: OpOpts & { skip_air?: boolean; turns?: number; mirror?: "x" | "y" | "z" }',
    returns: "EditSummary",
    doc: "Copies blocks to an offset, optionally turned or mirrored first.",
    run: (h, [s, by, x]) => summary(h, copy(h.doc, h.env, region(h, s), by as Vec3, { ...common(o(x)), ...(o(x).skip_air ? { skipAir: true } : {}), ...(pick(o(x), ["turns", "mirror"]) as object) })),
  },
  { name: "rotate", params: "sel: SelLike, turns: number, opts?: OpOpts & { pivot?: Vec3 }", returns: "EditSummary", doc: "Rotates in place, clockwise from above.", run: (h, [s, t, x]) => summary(h, rotate(h.doc, h.env, region(h, s), t as number, { ...common(o(x)), ...(o(x).pivot ? { pivot: o(x).pivot as Vec3 } : {}) })) },
  { name: "mirror", params: 'sel: SelLike, axis: "x" | "y" | "z", opts?: OpOpts & { about?: number }', returns: "EditSummary", doc: "Mirrors across a plane.", run: (h, [s, a, x]) => summary(h, mirror(h.doc, h.env, region(h, s), a as "x", { ...common(o(x)), ...(o(x).about !== undefined ? { about: o(x).about as number } : {}) })) },

  {
    name: "stamp",
    params: "prefab: string, opts: StampOpts",
    returns: "EditSummary",
    doc: "Places a library prefab (as the stamp tool). The run loads prefabs first: write the name as a string literal, or list computed names in run_script's prefabs.",
    run: (h, [p, x]) => stampOp(h, p, x),
  },

  // -- reads --
  { name: "anchor", params: "at: At", returns: "Vec3", doc: "Resolves an at: form to a position.", run: (h, [a]) => resolveAnchor(h.doc, a as AtSpec, h.env).pos },
  {
    name: "component",
    params: "id: string",
    returns: "ComponentInfo | null",
    doc: "A component's box (inclusive), kind, tags and anchors, plus .region (a Sel) and .anchor(name); null when missing.",
    run: (h, [id]) => {
      const c = h.doc.componentLocal(String(id));
      if (!c) return null;
      return { id: c.id, ...(c.kind ? { kind: c.kind } : {}), box: toPublic(c.box), tags: c.tags, anchors: componentAnchors(h.doc, c.id), ...(c.parent ? { parent: c.parent } : {}) };
    },
  },
  { name: "components", params: "", returns: "string[]", doc: "Ids of every component.", run: (h) => [...h.doc.components.keys()] },
  {
    name: "palette",
    params: "name?: string",
    returns: "PaletteInfo | string[]",
    doc: "A named palette's roles and members, or the palette names without an argument.",
    run: (h, [name]) => {
      if (name === undefined) return h.doc.palettes.list().map((p) => p.name);
      const p = h.doc.palettes.get(String(name));
      if (!p) throw new Error(`no palette "${name}" (have: ${h.doc.palettes.list().map((x) => x.name).join(", ") || "none"})`);
      return { name: p.name, roles: Object.fromEntries(Object.entries(p.roles).map(([r, ms]) => [r, ms.map((m) => ({ block: m.block, weight: m.weight }))])) };
    },
  },
  {
    name: "query",
    params: "at: Vec3 | SelLike",
    returns: "string | RegionInfo",
    doc: "Read-only: the block state at a position, or a summary of a selection (counts by family, bbox, components).",
    run: (h, [a]) => {
      if (Array.isArray(a) && a.length === 3 && a.every((n) => typeof n === "number")) return h.doc.getState(...(a as Vec3));
      const m = region(h, a);
      const s = regionSummary(h.doc, m as never, { ...(h.env.registry ? { registry: h.env.registry } : {}), ...(h.env.index ? { index: h.env.index } : {}) });
      return { volume: s.volume, solid: s.solid, ...(s.bbox ? { bbox: toPublic(s.bbox) } : {}), families: s.families.slice(0, 10), inside: s.inside, touching: s.touching };
    },
  },
  {
    name: "select",
    params: "sel: SelLike, name?: string",
    returns: "SelectionInfo",
    doc: "Resolves a selection: count, solid, bbox (inclusive). With name, stores it for later tool calls.",
    run: (h, [s, name]) => {
      const ctx = { doc: h.doc, ...(h.env.registry ? { registry: h.env.registry } : {}), ...(h.env.index ? { index: h.env.index } : {}) };
      const r = resolveSelection(s as SelExpr, ctx);
      if (typeof name === "string") {
        checkSelectionName(name);
        h.doc.selections.set(name, freezeNodes(s as SelExpr, ctx));
        h.doc.revision++;
      }
      const sm = summarize(h.doc, r.mask);
      return { count: sm.count, solid: sm.solid, ...(sm.bbox ? { bbox: toPublic(sm.bbox) } : {}), components: sm.components };
    },
  },
  {
    name: "positions",
    params: "sel: SelLike",
    returns: "Vec3[]",
    doc: "Every position in a selection (at most 100,000), sorted by y, z, x.",
    run: (h, [s]) => {
      const r = resolveSelection(s as SelExpr, { doc: h.doc, ...(h.env.registry ? { registry: h.env.registry } : {}) });
      if (r.mask.count() > 100_000) throw new Error(`the selection has ${r.mask.count()} positions; positions() returns at most 100,000`);
      return r.mask.positions().sort((p, q) => p[1] - q[1] || p[2] - q[2] || p[0] - q[0]);
    },
  },
];
