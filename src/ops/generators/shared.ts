import { canonicalState, formatState, parseState, stateId } from "../../core/blockstate.js";
import { Mask } from "../../core/mask.js";
import { formatBox, type Box, type Vec3 } from "../../core/region.js";
import type { Document, EditResult, Transaction } from "../../document/document.js";
import type { ShapeKind } from "../../palette/families.js";
import { resolveAnchor, type AtSpec } from "../anchors.js";
import { materialContext, type OpEnv } from "../edit.js";
import { compileMaterial, type Material, type MaterialExpr } from "../material.js";

/**
 * Shared plumbing for the generators (docs/design/05-operations.md, L3). Generators are
 * conveniences, not a style system: every parameter is open and the agent can always fall back to
 * L1/L2 ops. Each one is a single journal entry (through `opEdit`, so stairs, panes and fences
 * auto-connect) and registers a component.
 */

export interface GenOptions {
  /** Component id (default: the generator's kind, numbered when taken). */
  as?: string;
  /** Component kind (default: the generator's name). */
  kind?: string;
  /** Skip auto-connection (05). */
  raw?: boolean;
  /** Parent component of the registered one. */
  parent?: string;
}

export interface GenResult extends EditResult {
  component: string;
  /** Resolved positions and choices, echoed in results (05: anchors always echo coordinates). */
  notes: string[];
}

export const DIRS: Record<"north" | "south" | "east" | "west", Vec3> = { north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0] };
export type Dir = keyof typeof DIRS;

export function dirOf(v: Vec3): Dir {
  return v[0] > 0 ? "east" : v[0] < 0 ? "west" : v[2] > 0 ? "south" : "north";
}

export function uniqueId(doc: Document, base: string): string {
  if (!doc.components.has(base)) return base;
  for (let i = 2; ; i++) if (!doc.components.has(`${base}_${i}`)) return `${base}_${i}`;
}

/** Component id for a generator run. */
export function componentId(doc: Document, opts: GenOptions, kind: string): string {
  return opts.as ?? uniqueId(doc, kind);
}

export function at(doc: Document, env: OpEnv, spec: AtSpec, notes: string[], what = "at"): Vec3 {
  const r = resolveAnchor(doc, spec, env);
  if (!Array.isArray(spec)) notes.push(`${what}: ${r.desc}`);
  return r.pos;
}

/** Grows a half-open box over a block. */
export function growBox(b: Box | undefined, p: Vec3): Box {
  if (!b) return { min: [...p], max: [p[0] + 1, p[1] + 1, p[2] + 1] };
  return { min: [Math.min(b.min[0], p[0]), Math.min(b.min[1], p[1]), Math.min(b.min[2], p[2])], max: [Math.max(b.max[0], p[0] + 1), Math.max(b.max[1], p[1] + 1), Math.max(b.max[2], p[2] + 1)] };
}

/** Records written positions so the generator can register its bounding box. */
export class Writer {
  box?: Box;
  readonly mats = new Map<string, Material>();
  constructor(
    readonly doc: Document,
    readonly env: OpEnv,
    readonly tx: Transaction,
  ) {}
  /** Writes a state id (or a material sample) at p. */
  set(p: Vec3, id: number): void {
    this.tx.set(p[0], p[1], p[2], id);
    this.box = growBox(this.box, p);
  }
  clear(p: Vec3): void {
    this.tx.clear(p[0], p[1], p[2]);
    this.box = growBox(this.box, p);
  }
  /** A compiled material; `shape` makes palette roles resolve that shape (03). Cached per expression. */
  material(expr: MaterialExpr, shape: ShapeKind | "full" = "full"): Material {
    const k = `${shape}|${JSON.stringify(expr)}`;
    let m = this.mats.get(k);
    if (!m) this.mats.set(k, (m = compileMaterial(expr, { ...materialContext(this.doc, this.env, this.tx), shape })));
    return m;
  }
  /** A material sampled at p with extra block-state properties (facing, half…) the block supports. */
  shaped(m: Material, p: Vec3, props: Record<string, string>): number {
    const id = m(p[0], p[1], p[2]);
    const st = this.doc.states.get(id);
    const parsed = parseState(st);
    const info = this.env.registry?.get(parsed.id);
    const merged = { ...parsed.props };
    for (const [k, v] of Object.entries(props)) if (!info || info.properties[k]?.includes(v)) merged[k] = v;
    return this.tx.intern(canonicalState(formatState(parsed.id, merged), this.env.registry).state);
  }
  register(id: string, kind: string, opts: GenOptions, anchors: Record<string, Vec3> = {}, fallback?: Box): void {
    const box = this.box ?? fallback;
    if (!box) throw new Error(`${kind} placed nothing`);
    this.tx.setComponent({ id, kind: opts.kind ?? kind, box, anchors, ...(opts.parent ? { parent: opts.parent } : {}) });
  }
}

/**
 * Shaped materials for generators: the full block, plus stairs and slabs derived from it (03:
 * shape-aware resolution). A palette role resolves each shape through its families; a block id
 * goes through its family (or the usual `_stairs`/`_slab` names). Explicit `stairs`/`slab` win.
 * A missing shape is reported once, and the generator falls back to full blocks.
 */
export interface ShapeSet {
  full: MaterialExpr;
  stairs?: MaterialExpr;
  slab?: MaterialExpr;
  warnings: string[];
}

export function shapeSet(doc: Document, env: OpEnv, material: MaterialExpr, explicit: { stairs?: MaterialExpr; slab?: MaterialExpr } = {}, what = "material"): ShapeSet {
  const warnings: string[] = [];
  const out: ShapeSet = { full: material, warnings };
  for (const shape of ["stairs", "slab"] as const) {
    const given = explicit[shape];
    if (given !== undefined) {
      out[shape] = given;
      continue;
    }
    const derived = deriveShape(doc, env, material, shape);
    if (derived.expr !== undefined) out[shape] = derived.expr;
    warnings.push(...derived.warnings);
    if (derived.expr === undefined) warnings.push(`${what} ${describe(material)} has no ${shape}${shape === "stairs" ? "; using full blocks (a stepped roof)" : "; using full blocks"}. Pass ${shape}: "<block>" to choose one`);
  }
  return out;
}

function describe(m: MaterialExpr): string {
  const s = typeof m === "string" ? m : JSON.stringify(m);
  return s.length > 40 ? `${s.slice(0, 37)}…` : s;
}

function deriveShape(doc: Document, env: OpEnv, material: MaterialExpr, shape: "stairs" | "slab"): { expr?: MaterialExpr; warnings: string[] } {
  if (typeof material !== "string") return { warnings: [] };
  const t = material.trim();
  if (t.startsWith("palette:")) {
    if (!env.index) return { warnings: [] };
    try {
      const r = doc.palettes.resolveMaterial(env.index, t, shape);
      // A role whose families all lack the shape throws; a partial one warns and keeps the rest.
      return { expr: t, warnings: r.warnings };
    } catch {
      return { warnings: [] };
    }
  }
  if (t.includes(",") || t.includes("%")) return { warnings: [] };
  const id = stateId(canonicalState(t, env.registry).state);
  const fam = env.index?.familyOfBlock(id);
  if (fam) {
    const group = id === fam.base ? fam : fam.variants.find((v) => v.base === id) ?? fam;
    const b = group.shapes[shape] ?? fam.shapes[shape];
    if (b) return { expr: b, warnings: [] };
    if (env.index) return { warnings: [] };
  }
  const reg = env.registry;
  if (!reg) return { warnings: [] };
  const name = id.slice(id.indexOf(":") + 1), ns = id.slice(0, id.indexOf(":"));
  const stems = [name, name.replace(/_planks$/, ""), name.replace(/_bricks$/, "_brick"), name.replace(/_tiles$/, "_tile"), name.replace(/s$/, ""), name.replace(/_block$/, "")];
  for (const s of stems) if (reg.get(`${ns}:${s}_${shape}`)) return { expr: `${ns}:${s}_${shape}`, warnings: [] };
  return { warnings: [] };
}

/** A 2D footprint (x, z cells) from a mask's projection. */
export function footprintOf(m: Mask): { cells: Set<string>; box: Box } {
  const cells = new Set<string>();
  m.forEach((x, _y, z) => cells.add(`${x},${z}`));
  const box = m.bbox();
  if (!box) throw new Error("the footprint is empty");
  return { cells, box };
}

export function label(b: Box): string {
  return formatBox(b);
}

export function checkInt(x: unknown, what: string, min?: number, max?: number): number {
  if (typeof x !== "number" || !Number.isInteger(x)) throw new Error(`${what} must be a whole number (got ${JSON.stringify(x)})`);
  if (min !== undefined && x < min) throw new Error(`${what} must be ≥ ${min}`);
  if (max !== undefined && x > max) throw new Error(`${what} must be ≤ ${max}`);
  return x;
}
