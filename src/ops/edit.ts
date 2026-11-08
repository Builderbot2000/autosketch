import type { Registry } from "../assets/registry.js";
import { canonicalState, parseState, stateId, formatState } from "../core/blockstate.js";
import { Mask, shellOf } from "../core/mask.js";
import { boxVolume, formatBox, type Box, type Vec3 } from "../core/region.js";
import type { Document, EditResult, Transaction } from "../document/document.js";
import type { StateOverride } from "../core/rotate.js";
import type { PaletteIndex } from "../palette/index.js";
import type { AutosketchPlugin } from "../plugins/types.js";
import { connectAfterEdit } from "./connect.js";
import { compilePattern, type PatternContext, type PatternExpr } from "./pattern.js";

/**
 * Basic edit operations (docs/design/05-operations.md, layers L0 and L2 over boxes). Each op is one
 * journal entry. Coordinates are document-local; boxes are half-open here (the server converts).
 */

export interface OpEnv {
  registry?: Registry;
  index?: PaletteIndex;
  /** Active plugins: state-rotation overrides (01) and connection hooks (05). */
  plugins?: readonly AutosketchPlugin[];
}

/** Plugin rotate overrides, in plugin order (09). */
export function stateOverrides(env: OpEnv): StateOverride[] {
  return (env.plugins ?? []).flatMap((p) => (p.rotate ? [p.rotate.bind(p)] : []));
}

/** Options every op shares (05): `raw` skips auto-connection; `as`/`kind` register a component. */
export interface CommonOptions {
  raw?: boolean;
  as?: string;
  kind?: string;
}

/**
 * Runs an op body as one journal entry (05). Unless `raw`, connection properties of the written
 * blocks and their neighbours are then recomputed (05, Auto-connection) in the same entry.
 */
export function opEdit<T>(doc: Document, env: OpEnv, op: string, summary: string, opts: CommonOptions, body: (tx: Transaction) => T): EditResult & { value: T } {
  return doc.edit(op, summary, (tx) => {
    const v = body(tx);
    if (!opts.raw) connectAfterEdit(doc, tx, env);
    return v;
  });
}

/** Registers `opts.as` for a local half-open box (04: ops register what they create). */
export function registerAs(tx: Transaction, opts: CommonOptions, box: Box): void {
  if (opts.as) tx.setComponent({ id: opts.as, box, ...(opts.kind ? { kind: opts.kind } : {}) });
}

/** Bounding box of a region; throws when it is empty. */
export function regionBox(r: Region): Box {
  const b = r instanceof Mask ? r.bbox() : r;
  if (!b || boxVolume(b) === 0) throw new Error("the selection is empty");
  return b;
}

/** Throws when a region is over the per-op volume limit. */
export function checkRegion(r: Region): void {
  if (r instanceof Mask) checkMask(r);
  else checkVolume(r);
}

/** Largest box a single op may touch, to keep a typo from writing billions of blocks. */
export const MAX_OP_VOLUME = 8_000_000;

export type FillMode = "fill" | "hollow" | "outline" | "walls";

/** Where an op works: a box (fast path) or a resolved selection mask. */
export type Region = Box | Mask;

function checkMask(m: Mask): void {
  const n = m.count();
  if (n > MAX_OP_VOLUME) throw new Error(`the selection has ${n.toLocaleString("en-US")} blocks; one op may touch at most ${MAX_OP_VOLUME.toLocaleString("en-US")}. Split it up.`);
}

/** A selection that is exactly a box takes the box path. */
function asBox(r: Region): Box | undefined {
  return r instanceof Mask ? r.isBox() : r;
}

function regionLabel(r: Region, label?: string): string {
  if (label) return label;
  if (r instanceof Mask) {
    const b = r.bbox();
    return `sel ${r.count()} blocks${b ? ` in ${formatBox(b)}` : ""}`;
  }
  return formatBox(r);
}

export function patternContext(doc: Document, env: OpEnv, tx: Transaction, box?: Box): PatternContext {
  return {
    ...(env.registry ? { registry: env.registry } : {}),
    ...(env.index ? { index: env.index } : {}),
    palettes: doc.palettes,
    seed: doc.meta.seed,
    intern: (s) => tx.intern(s),
    ...(box ? { box } : {}),
    warn: (m) => tx.warn(m),
  };
}

function checkVolume(box: Box): void {
  const v = boxVolume(box);
  if (v > MAX_OP_VOLUME) throw new Error(`box ${formatBox(box)} has ${v.toLocaleString("en-US")} blocks; one op may touch at most ${MAX_OP_VOLUME.toLocaleString("en-US")}. Split it up.`);
}

export interface BlockPlacement {
  pos: Vec3;
  block: PatternExpr;
}

export function setBlocks(doc: Document, env: OpEnv, blocks: BlockPlacement[], summary?: string, opts: CommonOptions = {}): EditResult {
  if (blocks.length === 0) throw new Error("no blocks given");
  if (blocks.length > 100_000) throw new Error("set_blocks takes at most 100,000 blocks per call; use fill for regions");
  return opEdit(doc, env, "set_blocks", summary ?? `set_blocks ${blocks.length}${opts.as ? ` as ${opts.as}` : ""}`, opts, (tx) => {
    const ctx = patternContext(doc, env, tx);
    const cache = new Map<string, ReturnType<typeof compilePattern>>();
    for (const b of blocks) {
      if (!Array.isArray(b.pos) || b.pos.length !== 3 || b.pos.some((n) => !Number.isInteger(n))) throw new Error(`bad pos ${JSON.stringify(b.pos)} (expected [x,y,z] integers)`);
      const k = JSON.stringify(b.block);
      let m = cache.get(k);
      if (!m) cache.set(k, (m = compilePattern(b.block, ctx)));
      tx.set(b.pos[0], b.pos[1], b.pos[2], m(...b.pos));
    }
    if (opts.as) {
      const ps = blocks.map((b) => b.pos);
      const lo = [0, 1, 2].map((a) => Math.min(...ps.map((p) => p[a]!))) as Vec3, hi = [0, 1, 2].map((a) => Math.max(...ps.map((p) => p[a]!)) + 1) as Vec3;
      registerAs(tx, opts, { min: lo, max: hi });
    }
  });
}

/** True when (x,y,z) is on the part of `box` that `mode` writes. */
function inMode(mode: FillMode, box: Box, x: number, y: number, z: number, t: number): boolean {
  if (mode === "fill") return true;
  const dx = Math.min(x - box.min[0], box.max[0] - 1 - x);
  const dy = Math.min(y - box.min[1], box.max[1] - 1 - y);
  const dz = Math.min(z - box.min[2], box.max[2] - 1 - z);
  if (mode === "walls") return Math.min(dx, dz) < t;
  return Math.min(dx, dy, dz) < t;
}

export interface FillOptions extends CommonOptions {
  mode?: FillMode;
  /** Shell thickness for hollow/outline/walls (default 1). */
  thickness?: number;
  /** Short description of the region for history (default: the box, or the selection's size). */
  label?: string;
}

/**
 * fill: writes a pattern over a box. Modes (Axiom-style): fill = every block; hollow = shell of
 * the pattern with the inside cleared to air; outline = shell only, inside untouched; walls =
 * the four vertical sides only (floor and ceiling untouched).
 */
export function fill(doc: Document, env: OpEnv, region: Region, pattern: PatternExpr, opts: FillOptions = {}): EditResult {
  const mode = opts.mode ?? "fill";
  const t = Math.max(1, Math.floor(opts.thickness ?? 1));
  const summary = `fill${mode === "fill" ? "" : ` ${mode}`} ${regionLabel(region, opts.label)} ${describePattern(pattern)}${opts.as ? ` as ${opts.as}` : ""}`;
  const box = asBox(region);
  if (box) {
    checkVolume(box);
    return opEdit(doc, env, "fill", summary, opts, (tx) => {
      const m = compilePattern(pattern, patternContext(doc, env, tx, box));
      for (let y = box.min[1]; y < box.max[1]; y++)
        for (let z = box.min[2]; z < box.max[2]; z++)
          for (let x = box.min[0]; x < box.max[0]; x++) {
            if (inMode(mode, box, x, y, z, t)) tx.set(x, y, z, m(x, y, z));
            else if (mode === "hollow") tx.clear(x, y, z);
          }
      registerAs(tx, opts, box);
    });
  }
  const mask = region as Mask;
  checkMask(mask);
  const bb = mask.bbox();
  if (!bb) throw new Error("the selection is empty; nothing to fill");
  return opEdit(doc, env, "fill", summary, opts, (tx) => {
    const m = compilePattern(pattern, patternContext(doc, env, tx, bb));
    const write = mode === "fill" ? mask : shellOf(mask, t, mode === "walls");
    write.forEach((x, y, z) => tx.set(x, y, z, m(x, y, z)));
    if (mode === "hollow") mask.forEach((x, y, z) => !write.has(x, y, z) && tx.clear(x, y, z));
    registerAs(tx, opts, bb);
  });
}

/** clear: sets a region to air. `opts.env` lets auto-connection use the registry (neighbours of the hole update). */
export function clear(doc: Document, region: Region, label?: string, opts: CommonOptions & { env?: OpEnv } = {}): EditResult {
  const env = opts.env ?? {};
  const box = asBox(region);
  const summary = `clear ${regionLabel(region, label)}${opts.as ? ` as ${opts.as}` : ""}`;
  if (box) {
    checkVolume(box);
    return opEdit(doc, env, "clear", summary, opts, (tx) => {
      for (let y = box.min[1]; y < box.max[1]; y++) for (let z = box.min[2]; z < box.max[2]; z++) for (let x = box.min[0]; x < box.max[0]; x++) tx.clear(x, y, z);
      registerAs(tx, opts, box);
    });
  }
  const mask = region as Mask;
  checkMask(mask);
  return opEdit(doc, env, "clear", summary, opts, (tx) => {
    mask.forEach((x, y, z) => tx.clear(x, y, z));
    registerAs(tx, opts, regionBox(mask));
  });
}

/**
 * Matcher for replace: "*" = any non-air block; "#tag" = blocks with that tag; "id" = any state of
 * that block; "id[props]" = states having those property values.
 */
export function blockMatcher(spec: string, registry?: Registry): (state: string) => boolean {
  const s = spec.trim();
  if (s === "*") return (st) => st !== "minecraft:air";
  if (s.startsWith("#")) {
    if (!registry) throw new Error("tag matching needs a loaded instance");
    const ids = new Set(registry.withTag(s).map((b) => b.id));
    if (ids.size === 0) throw new Error(`no blocks have tag ${s}`);
    return (st) => ids.has(stateId(st));
  }
  const { id, props } = parseState(s);
  if (registry && !registry.get(id) && id !== "minecraft:air") throw new Error(`unknown block "${id}"`);
  if (Object.keys(props).length) canonicalState(s, registry); // validates property names/values
  const wanted = Object.entries(props);
  return (st) => {
    if (stateId(st) !== id) return false;
    if (!wanted.length) return true;
    const p = parseState(st).props;
    return wanted.every(([k, v]) => p[k] === v);
  };
}

export interface ReplaceOptions extends CommonOptions {
  /** Copy matching properties (facing, half, axis…) from the old block onto the new one. */
  keepStates?: boolean;
  label?: string;
}

export function replace(doc: Document, env: OpEnv, region: Region, from: string, to: PatternExpr, opts: ReplaceOptions = {}): EditResult {
  const match = blockMatcher(from, env.registry);
  const asB = asBox(region);
  const mask = asB ? undefined : (region as Mask);
  if (asB) checkVolume(asB);
  else checkMask(mask!);
  const box = asB ?? mask!.bbox();
  if (!box) throw new Error("the selection is empty; nothing to replace");
  return opEdit(doc, env, "replace", `replace ${from} → ${describePattern(to)} in ${regionLabel(region, opts.label)}${opts.as ? ` as ${opts.as}` : ""}`, opts, (tx) => {
    registerAs(tx, opts, box);
    const m = compilePattern(to, patternContext(doc, env, tx, box));
    const air = from.trim() === "minecraft:air" || from.trim() === "air";
    const visit = (x: number, y: number, z: number, cur: string) => {
      if (mask && !mask.has(x, y, z)) return;
      if (!match(cur)) return;
      let next = m(x, y, z);
      if (opts.keepStates) next = tx.intern(copyStates(cur, doc.states.get(next), env.registry));
      tx.set(x, y, z, next);
    };
    if (air) {
      for (let y = box.min[1]; y < box.max[1]; y++) for (let z = box.min[2]; z < box.max[2]; z++) for (let x = box.min[0]; x < box.max[0]; x++) visit(x, y, z, tx.get(x, y, z));
    } else {
      // Only non-air blocks can match: walk the store instead of the whole box.
      const hits: [number, number, number, string][] = [];
      doc.voxels.forEachInBox(doc.boxToStore(box), (sx, sy, sz, id) => hits.push([...doc.toLocal(sx, sy, sz), doc.states.get(id)]));
      for (const [x, y, z, st] of hits) visit(x, y, z, st);
    }
  });
}

function copyStates(from: string, to: string, registry?: Registry): string {
  const src = parseState(from).props;
  const dst = parseState(to);
  const allowed = registry?.get(dst.id)?.properties;
  const out = { ...dst.props };
  for (const [k, v] of Object.entries(src)) if (k in out && (!allowed || allowed[k]?.includes(v))) out[k] = v;
  return formatState(dst.id, out);
}

export function describePattern(m: PatternExpr): string {
  const s = typeof m === "string" ? m : JSON.stringify(m);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}
