import type { Compound } from "prismarine-nbt";
import type { Registry } from "../assets/registry.js";
import { canonicalState, formatState, parseState, stateId } from "../core/blockstate.js";
import type { Box, Vec3 } from "../core/region.js";
import { hash01, hashString } from "../core/rng.js";
import { mirrorPos, rotatePos, stateTransformer, transformBox, type StateTransform } from "../core/rotate.js";
import type { Document, EditResult } from "../document/document.js";
import { checkComponentId } from "../document/components.js";
import type { Family, ShapeGroup, ShapeKind } from "../palette/families.js";
import type { PaletteIndex } from "../palette/index.js";
import type { RoleMember } from "../palette/pick.js";
import type { AutosketchPlugin } from "../plugins/types.js";
import type { LoadedPrefab, Prefab } from "../library/prefabs.js";
import { resolveAnchor, type AtSpec } from "./anchors.js";

/**
 * stamp (docs/design/07-library.md, 05 Generators): places a library prefab into the document as
 * one journal entry and registers it as a component. `palette_remap` recolours prefab roles
 * through families, so a stair stays a stair (with its facing) in the new material.
 */

/** Where to stamp: a local position, "component.anchor", {anchor, offset} or {face, u, v} (05). */
export type StampAt = AtSpec;

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
  /** Degrees clockwise seen from above (a multiple of 90), applied after `mirror`. */
  rotate?: number;
  /** Flip the prefab across its own centre plane: "x" east↔west, "z" north↔south. */
  mirror?: "x" | "z";
}

export interface StampEnv {
  registry?: Registry;
  index?: PaletteIndex;
  /** Plugin state-rotation overrides (09), used when stamping rotated or mirrored. */
  plugins?: readonly AutosketchPlugin[];
}

export interface StampResult extends EditResult {
  component: string;
  /** Local position of the prefab's (0,0,0). */
  origin: Vec3;
  /** Resolved local position of `at`. */
  at: Vec3;
}

export function stampPrefab(doc: Document, env: StampEnv, prefab: Prefab, loaded: LoadedPrefab, opts: StampOptions): StampResult {
  const snap = loaded.snapshot;
  const frame = prefabFrame(snap.size, opts, env);
  const palette = frame.state ? snap.palette.map(frame.state) : snap.palette;
  const at = resolveAt(doc, opts.at, env);
  const anchorName = opts.anchor ?? (prefab.meta.anchors.base ? "base" : undefined);
  const a: Vec3 = anchorName ? frame.place(prefab.meta.anchors[anchorName] ?? fail(`prefab "${prefab.id}" has no anchor "${anchorName}" (anchors: ${Object.keys(prefab.meta.anchors).join(", ") || "none"})`)) : [0, 0, 0];
  const origin: Vec3 = [at[0] - a[0], at[1] - a[1], at[2] - a[2]];
  const size = frame.size;
  const box: Box = { min: origin, max: [origin[0] + size[0], origin[1] + size[1], origin[2] + size[2]] };
  const id = opts.as ?? uniqueComponentId(doc, prefab.id.replace(/^axiom\//, "").replace(/[^a-z0-9_.-]+/gi, "_").toLowerCase() || "prefab");
  checkComponentId(id);

  const remap = compileRemap(doc, env, prefab, palette, opts.remap ?? {});
  const warnings = [...loaded.warnings, ...remap.warnings, ...namespaceWarnings(prefab, snap.palette, env.registry)];
  const beAt = new Map(snap.blockEntities.map((b) => [`${b.pos[0]},${b.pos[1]},${b.pos[2]}`, b.nbt]));
  let droppedNbt = 0;

  const [w, h, l] = snap.size;
  const ents = snap.entities.length;
  const r = doc.edit("stamp", `stamp ${prefab.id} at ${at.join(",")} as ${id}${frame.label}${ents ? ` + ${ents} entit${ents > 1 ? "ies" : "y"}` : ""}`, (tx) => {
    const ids = palette.map((s) => tx.intern(s));
    for (let y = 0; y < h; y++)
      for (let z = 0; z < l; z++)
        for (let x = 0; x < w; x++) {
          const p = snap.blocks[x + z * w + y * w * l]!;
          if (p === 0 && !opts.includeAir) continue;
          const q = frame.place([x, y, z]);
          const dx = origin[0] + q[0], dy = origin[1] + q[1], dz = origin[2] + q[2];
          const nbt = beAt.get(`${x},${y},${z}`);
          const mapped = p === 0 ? undefined : remap.map(p, dx, dy, dz);
          if (mapped === undefined) {
            tx.set(dx, dy, dz, ids[p]!, nbt ? structuredClone(nbt) : null);
            continue;
          }
          if (nbt && stateId(mapped) !== stateId(palette[p]!)) droppedNbt++;
          tx.set(dx, dy, dz, mapped, nbt && stateId(mapped) === stateId(palette[p]!) ? structuredClone(nbt) : null);
        }
    const anchors: Record<string, Vec3> = {};
    for (const [k, v] of Object.entries(prefab.meta.anchors)) {
      const q = frame.place(v);
      anchors[k] = [origin[0] + q[0], origin[1] + q[1], origin[2] + q[2]];
    }
    tx.setComponent({ id, kind: `prefab:${prefab.id}`, box, anchors, tags: prefab.meta.tags });
    for (const wn of warnings) tx.warn(wn);
    if (droppedNbt) tx.warn(`${droppedNbt} block entities dropped where remap changed the block`);
    for (const e of snap.entities) {
      const placed = placeEntity(e.pos, e.nbt, frame);
      const v = placed.nbt.value;
      // Tile coordinates live in the same (store) frame as Pos.
      if (v.TileX?.type === "int" && v.TileY?.type === "int" && v.TileZ?.type === "int") {
        v.TileX.value += origin[0] + doc.origin[0];
        v.TileY.value += origin[1] + doc.origin[1];
        v.TileZ.value += origin[2] + doc.origin[2];
      }
      tx.addEntity([origin[0] + placed.pos[0], origin[1] + placed.pos[1], origin[2] + placed.pos[2]], placed.nbt);
    }
  });
  return { ...r, component: id, origin, at };
}

// -- orientation -----------------------------------------------------------------------------------

interface Frame {
  /** Prefab-local position → position in the rotated/mirrored prefab (its min corner at 0,0,0). */
  place: (p: Vec3) => Vec3;
  /** Block-state remap, when the stamp is rotated or mirrored. */
  state?: (s: string) => string;
  size: Vec3;
  label: string;
  /** Clockwise quarter turns, applied after `mirror`. */
  turns: number;
  mirror?: "x" | "z";
}

/**
 * The prefab's own frame after `mirror` (across its centre plane), then `rotate` clockwise turns
 * (01, Orientation): positions, anchors and block states all go through it, so the rotated prefab
 * still occupies [0, size) and its anchors stay on the same blocks.
 */
export function prefabFrame(size: Vec3, opts: Pick<StampOptions, "rotate" | "mirror">, env: StampEnv = {}): Frame {
  const deg = opts.rotate ?? 0;
  if (!Number.isInteger(deg) || deg % 90 !== 0) throw new Error(`rotate must be a multiple of 90 degrees (got ${deg})`);
  const turns = (((deg / 90) % 4) + 4) % 4;
  const axis = opts.mirror;
  if (axis !== undefined && axis !== "x" && axis !== "z") throw new Error('mirror must be "x" (east↔west) or "z" (north↔south)');
  if (!turns && !axis) return { place: (p) => p, size, label: "", turns: 0 };
  const a = axis === "x" ? 0 : 2;
  const raw = (p: Vec3): Vec3 => rotatePos(axis ? mirrorPos(p, axis, (size[a]! - 1) / 2) : p, turns, [0, 0, 0]);
  const bb = transformBox({ min: [0, 0, 0], max: size }, raw);
  const place = (p: Vec3): Vec3 => {
    const q = raw(p);
    return [q[0] - bb.min[0], q[1] - bb.min[1], q[2] - bb.min[2]];
  };
  const t: StateTransform = { turns, ...(axis ? { mirror: axis } : {}) };
  const overrides = (env.plugins ?? []).flatMap((pl) => (pl.rotate ? [pl.rotate.bind(pl)] : []));
  const state = stateTransformer(t, { ...(env.registry ? { registry: env.registry } : {}), overrides });
  const label = `${axis ? ` mirror ${axis}` : ""}${turns ? ` rotate ${turns * 90}°` : ""}`;
  return { place, state, size: [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]], label, turns, ...(axis ? { mirror: axis } : {}) };
}

// -- entities --------------------------------------------------------------------------------------

const DIR3 = ["down", "up", "north", "south", "west", "east"];
const DIR2 = ["south", "west", "north", "east"];
const CW: Record<string, string> = { north: "east", east: "south", south: "west", west: "north" };

function turnDir(d: string, frame: Pick<Frame, "turns" | "mirror">): string {
  if (frame.mirror === "x" && (d === "east" || d === "west")) d = d === "east" ? "west" : "east";
  if (frame.mirror === "z" && (d === "north" || d === "south")) d = d === "north" ? "south" : "north";
  for (let i = 0; i < frame.turns && CW[d]; i++) d = CW[d]!;
  return d;
}

/**
 * An entity of a prefab in the oriented prefab's frame (07, stamp). `pos` is in block units from
 * the prefab's minimum corner (a block at b spans b..b+1), so it goes through the same mirror and
 * rotation as block positions, measured at block centres. The yaw in `Rotation` turns with it
 * (0 = south, 90 = west; a clockwise turn adds 90), and so does a hanging entity's facing
 * (`Facing`: 3D for item frames, 2D otherwise; `facing`: 2D, as paintings use it). `TileX/Y/Z`
 * become the block holding the new position (prefab frame; the caller moves them). `UUID` is dropped so every stamped copy is its own
 * entity; the game assigns a new one, as it does when placing a structure template.
 */
export function placeEntity(pos: Vec3, nbt: Compound, frame: Pick<Frame, "place" | "turns" | "mirror">): { pos: Vec3; nbt: Compound } {
  const q = frame.place([pos[0] - 0.5, pos[1] - 0.5, pos[2] - 0.5]);
  const p: Vec3 = [q[0] + 0.5, q[1] + 0.5, q[2] + 0.5];
  const v: Compound["value"] = structuredClone(nbt.value);
  delete v.UUID;
  delete v.UUIDMost;
  delete v.UUIDLeast;
  delete v.Pos;
  const rot = v.Rotation;
  if (rot?.type === "list" && (rot.value.type === "float" || rot.value.type === "double") && Array.isArray(rot.value.value) && typeof rot.value.value[0] === "number") {
    let yaw = rot.value.value[0] as number;
    if (frame.mirror === "x") yaw = -yaw;
    if (frame.mirror === "z") yaw = 180 - yaw;
    yaw = (((yaw + 90 * frame.turns) % 360) + 360) % 360;
    (rot.value.value as number[])[0] = yaw;
  }
  const id = v.id?.type === "string" ? String(v.id.value) : "";
  for (const key of ["Facing", "facing"] as const) {
    const t = v[key];
    if (t?.type !== "byte" || typeof t.value !== "number") continue;
    const table = key === "Facing" && /item_frame/.test(id) ? DIR3 : DIR2;
    const d = table[t.value];
    if (d !== undefined) t.value = table.indexOf(turnDir(d, frame));
  }
  if (v.TileX?.type === "int" && v.TileY?.type === "int" && v.TileZ?.type === "int") {
    v.TileX.value = Math.floor(p[0]);
    v.TileY.value = Math.floor(p[1]);
    v.TileZ.value = Math.floor(p[2]);
  }
  return { pos: p, nbt: { type: "compound", value: v } };
}

// -- placement ---------------------------------------------------------------------------------------

/**
 * Resolves `at` to a local position through the shared anchor resolver (05, `ops/anchors.ts`):
 * named and implicit anchors, `{anchor, offset}` and `{face, u, v}`.
 */
export function resolveAt(doc: Document, at: StampAt, env: StampEnv = {}): Vec3 {
  return resolveAnchor(doc, at, env).pos;
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
