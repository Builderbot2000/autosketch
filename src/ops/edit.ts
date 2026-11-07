import type { Registry } from "../assets/registry.js";
import { canonicalState, parseState, stateId, formatState } from "../core/blockstate.js";
import { boxVolume, formatBox, type Box, type Vec3 } from "../core/region.js";
import type { Document, EditResult, Transaction } from "../document/document.js";
import type { PaletteIndex } from "../palette/index.js";
import { compileMaterial, type MaterialContext, type MaterialExpr } from "./material.js";

/**
 * Basic edit operations (docs/design/05-operations.md, layers L0 and L2 over boxes). Each op is one
 * journal entry. Coordinates are document-local; boxes are half-open here (the server converts).
 */

export interface OpEnv {
  registry?: Registry;
  index?: PaletteIndex;
}

/** Largest box a single op may touch, to keep a typo from writing billions of blocks. */
export const MAX_OP_VOLUME = 8_000_000;

export type FillMode = "fill" | "hollow" | "outline" | "walls";

function materialContext(doc: Document, env: OpEnv, tx: Transaction, box?: Box): MaterialContext {
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
  block: MaterialExpr;
}

export function setBlocks(doc: Document, env: OpEnv, blocks: BlockPlacement[], summary?: string): EditResult {
  if (blocks.length === 0) throw new Error("no blocks given");
  if (blocks.length > 100_000) throw new Error("set_blocks takes at most 100,000 blocks per call; use fill for regions");
  return doc.edit("set_blocks", summary ?? `set_blocks ${blocks.length}`, (tx) => {
    const ctx = materialContext(doc, env, tx);
    const cache = new Map<string, ReturnType<typeof compileMaterial>>();
    for (const b of blocks) {
      if (!Array.isArray(b.pos) || b.pos.length !== 3 || b.pos.some((n) => !Number.isInteger(n))) throw new Error(`bad pos ${JSON.stringify(b.pos)} (expected [x,y,z] integers)`);
      const k = JSON.stringify(b.block);
      let m = cache.get(k);
      if (!m) cache.set(k, (m = compileMaterial(b.block, ctx)));
      tx.set(b.pos[0], b.pos[1], b.pos[2], m(...b.pos));
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

export interface FillOptions {
  mode?: FillMode;
  /** Shell thickness for hollow/outline/walls (default 1). */
  thickness?: number;
  /** Register the box as a component. */
  as?: string;
  kind?: string;
}

/**
 * fill: writes a material over a box. Modes (Axiom-style): fill = every block; hollow = shell of
 * the material with the inside cleared to air; outline = shell only, inside untouched; walls =
 * the four vertical sides only (floor and ceiling untouched).
 */
export function fill(doc: Document, env: OpEnv, box: Box, material: MaterialExpr, opts: FillOptions = {}): EditResult {
  checkVolume(box);
  const mode = opts.mode ?? "fill";
  const t = Math.max(1, Math.floor(opts.thickness ?? 1));
  const summary = `fill${mode === "fill" ? "" : ` ${mode}`} ${formatBox(box)} ${describeMaterial(material)}${opts.as ? ` as ${opts.as}` : ""}`;
  return doc.edit("fill", summary, (tx) => {
    const m = compileMaterial(material, materialContext(doc, env, tx, box));
    for (let y = box.min[1]; y < box.max[1]; y++)
      for (let z = box.min[2]; z < box.max[2]; z++)
        for (let x = box.min[0]; x < box.max[0]; x++) {
          if (inMode(mode, box, x, y, z, t)) tx.set(x, y, z, m(x, y, z));
          else if (mode === "hollow") tx.clear(x, y, z);
        }
    if (opts.as) tx.setComponent({ id: opts.as, box, ...(opts.kind ? { kind: opts.kind } : {}) });
  });
}

export function clear(doc: Document, box: Box): EditResult {
  checkVolume(box);
  return doc.edit("clear", `clear ${formatBox(box)}`, (tx) => {
    for (let y = box.min[1]; y < box.max[1]; y++) for (let z = box.min[2]; z < box.max[2]; z++) for (let x = box.min[0]; x < box.max[0]; x++) tx.clear(x, y, z);
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

export interface ReplaceOptions {
  /** Copy matching properties (facing, half, axis…) from the old block onto the new one. */
  keepStates?: boolean;
}

export function replace(doc: Document, env: OpEnv, box: Box, from: string, to: MaterialExpr, opts: ReplaceOptions = {}): EditResult {
  checkVolume(box);
  const match = blockMatcher(from, env.registry);
  return doc.edit("replace", `replace ${from} → ${describeMaterial(to)} in ${formatBox(box)}`, (tx) => {
    const m = compileMaterial(to, materialContext(doc, env, tx, box));
    const air = from.trim() === "minecraft:air" || from.trim() === "air";
    const visit = (x: number, y: number, z: number, cur: string) => {
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

export function describeMaterial(m: MaterialExpr): string {
  const s = typeof m === "string" ? m : JSON.stringify(m);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}
