import type { Registry } from "../assets/registry.js";
import { canonicalState, formatState, parseState, stateId } from "../core/blockstate.js";
import type { Box, Vec3 } from "../core/region.js";
import { hash01, hashString } from "../core/rng.js";
import type { Document, EditResult } from "../document/document.js";
import { checkComponentId } from "../document/components.js";
import type { Family, ShapeGroup, ShapeKind } from "../palette/families.js";
import type { PaletteIndex } from "../palette/index.js";
import type { RoleMember } from "../palette/pick.js";
import type { LoadedPrefab, Prefab } from "./prefabs.js";

/**
 * stamp (docs/design/07-library.md, 05 Generators): places a library prefab into the document as
 * one journal entry and registers it as a component. `palette_remap` recolours prefab roles
 * through families, so a stair stays a stair (with its facing) in the new material.
 */

/** Where to stamp: a local position, "component.anchor", or {anchor, offset}. */
export type StampAt = Vec3 | string | { anchor: string; offset?: Vec3 };

export interface StampOptions {
  at: StampAt;
  /** Prefab anchor placed at `at` (default "base" when the prefab has one, else its minimum corner). */
  anchor?: string;
  /** Prefab role (or block/family in it) → "palette:<name>.<role>" or a block/family id. */
  remap?: Record<string, string>;
  /** Also write the prefab's air, clearing what's there (default: air leaves the document as is). */
  includeAir?: boolean;
  /** Component id (default: the prefab id, numbered when taken). */
  as?: string;
  /** Quarter turns clockwise seen from above; needs block-state transforms (silo A). */
  rotate?: number;
  mirror?: "x" | "z";
}

export interface StampEnv {
  registry?: Registry;
  index?: PaletteIndex;
}

export interface StampResult extends EditResult {
  component: string;
  /** Local position of the prefab's (0,0,0). */
  origin: Vec3;
  /** Resolved local position of `at`. */
  at: Vec3;
}

export function stampPrefab(doc: Document, env: StampEnv, prefab: Prefab, loaded: LoadedPrefab, opts: StampOptions): StampResult {
  // TODO(silo A): rotate/mirror the snapshot with the block-state transform tables once they merge.
  if ((opts.rotate ?? 0) % 360 !== 0 || opts.mirror) throw new Error("stamp rotate/mirror needs the block-state transforms (silo A), which aren't merged yet; stamp unrotated for now");

  const snap = loaded.snapshot;
  const at = resolveAt(doc, opts.at);
  const anchorName = opts.anchor ?? (prefab.meta.anchors.base ? "base" : undefined);
  const a: Vec3 = anchorName ? prefab.meta.anchors[anchorName] ?? fail(`prefab "${prefab.id}" has no anchor "${anchorName}" (anchors: ${Object.keys(prefab.meta.anchors).join(", ") || "none"})`) : [0, 0, 0];
  const origin: Vec3 = [at[0] - a[0], at[1] - a[1], at[2] - a[2]];
  const box: Box = { min: origin, max: [origin[0] + snap.size[0], origin[1] + snap.size[1], origin[2] + snap.size[2]] };
  const id = opts.as ?? uniqueComponentId(doc, prefab.id.replace(/^axiom\//, "").replace(/[^a-z0-9_.-]+/gi, "_").toLowerCase() || "prefab");
  checkComponentId(id);

  const remap = compileRemap(doc, env, prefab, snap.palette, opts.remap ?? {});
  const warnings = [...loaded.warnings, ...remap.warnings, ...namespaceWarnings(prefab, snap.palette, env.registry)];
  const beAt = new Map(snap.blockEntities.map((b) => [`${b.pos[0]},${b.pos[1]},${b.pos[2]}`, b.nbt]));
  let droppedNbt = 0;

  const [w, h, l] = snap.size;
  const r = doc.edit("stamp", `stamp ${prefab.id} at ${at.join(",")} as ${id}`, (tx) => {
    const ids = snap.palette.map((s) => tx.intern(s));
    for (let y = 0; y < h; y++)
      for (let z = 0; z < l; z++)
        for (let x = 0; x < w; x++) {
          const p = snap.blocks[x + z * w + y * w * l]!;
          if (p === 0 && !opts.includeAir) continue;
          const dx = origin[0] + x, dy = origin[1] + y, dz = origin[2] + z;
          const nbt = beAt.get(`${x},${y},${z}`);
          const mapped = p === 0 ? undefined : remap.map(p, dx, dy, dz);
          if (mapped === undefined) {
            tx.set(dx, dy, dz, ids[p]!, nbt ? structuredClone(nbt) : null);
            continue;
          }
          if (nbt && stateId(mapped) !== stateId(snap.palette[p]!)) droppedNbt++;
          tx.set(dx, dy, dz, mapped, nbt && stateId(mapped) === stateId(snap.palette[p]!) ? structuredClone(nbt) : null);
        }
    const anchors: Record<string, Vec3> = {};
    for (const [k, v] of Object.entries(prefab.meta.anchors)) anchors[k] = [origin[0] + v[0], origin[1] + v[1], origin[2] + v[2]];
    tx.setComponent({ id, kind: `prefab:${prefab.id}`, box, anchors, tags: prefab.meta.tags });
    for (const wn of warnings) tx.warn(wn);
    if (droppedNbt) tx.warn(`${droppedNbt} block entities dropped where remap changed the block`);
    if (snap.entities.length) tx.warn(`${snap.entities.length} entities in the prefab were not placed (entities aren't edited yet)`);
  });
  return { ...r, component: id, origin, at };
}

// -- placement ---------------------------------------------------------------------------------------

/**
 * Resolves `at` to a local position. Components expose their named anchors plus min, max, center
 * (centre of the box), bottom (centre of the floor layer) and top (centre, one above the box).
 * TODO(silo C): use the shared anchor resolver in ops/anchors.ts (05) once it lands.
 */
export function resolveAt(doc: Document, at: StampAt): Vec3 {
  if (Array.isArray(at)) {
    if (at.length !== 3 || at.some((n) => !Number.isInteger(n))) throw new Error(`at must be [x,y,z] integers (got ${JSON.stringify(at)})`);
    return [at[0], at[1], at[2]];
  }
  if (typeof at === "object" && at && typeof at.anchor === "string") {
    const p = resolveAt(doc, at.anchor);
    const o = at.offset ?? [0, 0, 0];
    return [p[0] + o[0], p[1] + o[1], p[2] + o[2]];
  }
  if (typeof at !== "string") throw new Error('at must be [x,y,z], "component.anchor" or {anchor, offset}');
  const dot = at.lastIndexOf(".");
  const compId = dot > 0 ? at.slice(0, dot) : at;
  const name = dot > 0 ? at.slice(dot + 1) : "base";
  const c = doc.componentLocal(compId);
  if (!c) throw new Error(`no component "${compId}" (have: ${[...doc.components.keys()].join(", ") || "none"})`);
  if (c.anchors[name]) return c.anchors[name]!;
  const { min, max } = c.box;
  const cx = Math.floor((min[0] + max[0] - 1) / 2), cz = Math.floor((min[2] + max[2] - 1) / 2);
  const implicit: Record<string, Vec3> = {
    min: [...min],
    max: [max[0] - 1, max[1] - 1, max[2] - 1],
    center: [cx, Math.floor((min[1] + max[1] - 1) / 2), cz],
    bottom: [cx, min[1], cz],
    top: [cx, max[1], cz],
  };
  const p = implicit[name];
  if (!p) throw new Error(`component "${compId}" has no anchor "${name}" (named: ${Object.keys(c.anchors).join(", ") || "none"}; implicit: ${Object.keys(implicit).join(", ")})`);
  return p;
}

export function uniqueComponentId(doc: Document, base: string): string {
  if (!doc.components.has(base)) return base;
  for (let i = 2; ; i++) if (!doc.components.has(`${base}_${i}`)) return `${base}_${i}`;
}

// -- palette remap ---------------------------------------------------------------------------------

/** Where a block sits in its family: the family, the shape group (base or variant) and the shape. */
function placeInFamily(index: PaletteIndex | undefined, id: string): { family: Family; group: ShapeGroup; shape: ShapeKind | "full" } | undefined {
  const family = index?.familyOfBlock(id);
  if (!family) return undefined;
  for (const g of [family, ...family.variants]) {
    if (g.base === id) return { family, group: g, shape: "full" };
    for (const [k, v] of Object.entries(g.shapes)) if (v === id) return { family, group: g, shape: k as ShapeKind };
  }
  if (family.aliases.includes(id)) return { family, group: family, shape: "full" };
  return undefined; // an extra (another mod's shape): no counterpart in other families
}

interface Remap {
  /** New canonical state for palette index `p` at a destination position, or undefined to keep it. */
  map: (p: number, x: number, y: number, z: number) => string | undefined;
  warnings: string[];
}

function compileRemap(doc: Document, env: StampEnv, prefab: Prefab, palette: readonly string[], spec: Record<string, string>): Remap {
  const warnings: string[] = [];
  const entries = Object.entries(spec);
  if (!entries.length) return { map: () => undefined, warnings };
  const index = env.index;
  if (!index) throw new Error("palette_remap needs a loaded instance");
  const famOf = (id: string) => index.familyOfBlock(id)?.id ?? id;
  const full = (id: string) => (id.includes(":") ? id : `minecraft:${id}`);

  // Source family → target members.
  const bySource = new Map<string, { key: string; members: RoleMember[] }>();
  for (const [key, target] of entries) {
    const role = prefab.meta.roles[key];
    let sources: string[];
    if (role) sources = role.map((b) => famOf(full(b)));
    else if (index.familyOfBlock(full(key)) || env.registry?.get(full(key))) sources = [famOf(full(key))];
    else throw new Error(`prefab "${prefab.id}" has no role "${key}" (roles: ${Object.keys(prefab.meta.roles).join(", ") || "none"}; a block or family id in the prefab also works)`);
    const members = targetMembers(doc, index, target, env.registry);
    for (const s of sources) bySource.set(s, { key, members });
  }

  // Per palette entry: the candidate states, one per target member (undefined = keep).
  const per: ({ states: (string | undefined)[]; cum: number[]; salt: number } | undefined)[] = palette.map((state, p) => {
    if (p === 0) return undefined;
    const id = stateId(state);
    const src = placeInFamily(index, id);
    const hit = bySource.get(src?.family.id ?? id);
    if (!hit) return undefined;
    if (!src) {
      warnings.push(`${hit.key}: ${id} has no counterpart in other families; kept`);
      return undefined;
    }
    const states = hit.members.map((m) => {
      const tf = index.family(m.family) ?? index.familyOfBlock(m.block);
      const group: ShapeGroup | undefined = tf && (m.block === tf.base ? tf : tf.variants.find((v) => v.base === m.block)) ;
      const block = src.shape === "full" ? m.block : group?.shapes[src.shape] ?? tf?.shapes[src.shape];
      if (!block) {
        warnings.push(`${hit.key}: ${m.family} has no ${src.shape}; kept ${id} there`);
        return undefined;
      }
      return withStates(block, state, env.registry);
    });
    let acc = 0;
    const total = hit.members.reduce((s, m) => s + m.weight, 0) || 1;
    return { states, cum: hit.members.map((m) => (acc += m.weight / total)), salt: hashString(`${prefab.id}:${hit.key}`) };
  });

  const seed = doc.meta.seed;
  return {
    warnings: [...new Set(warnings)],
    map: (p, x, y, z) => {
      const e = per[p];
      if (!e) return undefined;
      if (e.states.length === 1) return e.states[0];
      const r = hash01(seed, e.salt, x, y, z);
      let i = 0;
      while (i < e.cum.length - 1 && r >= e.cum[i]!) i++;
      return e.states[i];
    },
  };
}

/** Members for a remap target: a palette role of the document, or one block/family id. */
function targetMembers(doc: Document, index: PaletteIndex, target: string, registry?: Registry): RoleMember[] {
  const t = target.trim();
  const m = /^palette:([^.]+)\.(.+)$/.exec(t);
  if (m) {
    const p = doc.palettes.get(m[1]!);
    if (!p) throw new Error(`no palette "${m[1]}" (have: ${doc.palettes.list().map((x) => x.name).join(", ") || "none"}; palette_load brings one from the library)`);
    const ms = p.roles[m[2]!];
    if (!ms) throw new Error(`palette "${p.name}" has no role "${m[2]}" (roles: ${Object.keys(p.roles).join(", ")})`);
    return ms;
  }
  const id = stateId(t.includes(":") ? t : `minecraft:${t}`);
  if (registry && !registry.get(id)) throw new Error(`unknown block "${id}" in palette_remap`);
  const fam = index.familyOfBlock(id);
  return [{ family: fam?.id ?? id, block: id, weight: 1 }];
}

/** `block` with the properties of `from` that it supports (facing, half, axis, waterlogged…). */
function withStates(block: string, from: string, registry?: Registry): string {
  const src = parseState(from).props;
  const info = registry?.get(block);
  const props: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) if (!info || info.properties[k]?.includes(v)) props[k] = v;
  return canonicalState(formatState(block, props), registry).state;
}

function namespaceWarnings(prefab: Prefab, palette: readonly string[], registry?: Registry): string[] {
  if (!registry) return [];
  const have = registry.namespaces();
  const out: string[] = [];
  const missingNs = prefab.meta.requires.filter((ns) => !have.has(ns));
  if (missingNs.length) out.push(`prefab requires ${missingNs.join(", ")}, not in this instance`);
  // Namespaces of blocks actually used, for prefabs without (or with incomplete) `requires`.
  const used = [...new Set(palette.slice(1).map((s) => stateId(s).split(":")[0]!))].filter((ns) => !have.has(ns) && !missingNs.includes(ns));
  if (used.length) out.push(`prefab uses blocks from ${used.join(", ")}, not in this instance (kept as-is)`);
  return out;
}

function fail(msg: string): never {
  throw new Error(msg);
}
