import type { Registry } from "../assets/registry.js";
import { formatState, parseState } from "./blockstate.js";
import type { Box, Vec3 } from "./region.js";

/**
 * Block-state rotation and mirroring (docs/design/01-conventions.md, Orientation).
 *
 * Rotation is in 90° turns, clockwise seen from above (Minecraft `Rotation.CLOCKWISE_90`); mirror is
 * across an axis plane (`x` flips east↔west, `z` flips north↔south, `y` flips up↔down). States are
 * remapped by property name, so the rules derive from each block's own property set and apply to
 * modded blocks that follow vanilla naming. A remapped value the registry doesn't allow for that
 * block is left unchanged. Plugins (09) may override any state through `StateOverride`.
 *
 * Properties: facing · axis · rotation (0–15) · hinge · shape (stairs handedness, rail directions)
 * · half / type / face / attachment / hanging / vertical_direction (y mirror only) · orientation
 * (jigsaw, crafter) · chest type (left/right) · side flags north|east|south|west (fences, walls,
 * panes, redstone, vines, mushroom blocks…), plus up|down under a y mirror.
 */

export type MirrorAxis = "x" | "y" | "z";

/** One transform: mirror first (if any), then `turns` clockwise quarter turns. */
export interface StateTransform {
  turns?: number;
  mirror?: MirrorAxis;
}

/** A plugin override: returns the transformed state, or undefined to use the generic rules. */
export type StateOverride = (state: string, t: { turns: number } | { mirror: MirrorAxis }) => string | undefined;

const H = ["north", "east", "south", "west"] as const;
const OPP: Record<string, string> = { north: "south", south: "north", east: "west", west: "east", up: "down", down: "up" };

export function rotateDir(d: string, turns: number): string {
  const i = (H as readonly string[]).indexOf(d);
  return i < 0 ? d : H[(i + turns) & 3]!;
}

export function mirrorDir(d: string, axis: MirrorAxis): string {
  if (axis === "x") return d === "east" || d === "west" ? OPP[d]! : d;
  if (axis === "z") return d === "north" || d === "south" ? OPP[d]! : d;
  return d === "up" || d === "down" ? OPP[d]! : d;
}

const swap = (v: string, a: string, b: string) => (v === a ? b : v === b ? a : v);
const swapLR = (v: string) => v.replace(/left|right/, (m) => (m === "left" ? "right" : "left"));

/** Rail shapes: "north_south", "ascending_east", "south_west" ↔ direction lists, normalised. */
function railShape(v: string, map: (d: string) => string): string {
  if (v.startsWith("ascending_")) return `ascending_${map(v.slice(10))}`;
  const parts = v.split("_");
  if (parts.length !== 2 || parts.some((p) => !(H as readonly string[]).includes(p))) return v;
  const [a, b] = parts.map(map) as [string, string];
  const axisZ = (d: string) => d === "north" || d === "south";
  if (axisZ(a) && axisZ(b)) return "north_south";
  if (!axisZ(a) && !axisZ(b)) return "east_west";
  return axisZ(a) ? `${a}_${b}` : `${b}_${a}`;
}

const SIDES = new Set(["north", "east", "south", "west"]);

/** Generic remap of one elementary step (a rotation or a mirror), by property name. */
function step(props: Record<string, string>, t: { turns: number } | { mirror: MirrorAxis }): Record<string, string> {
  const turns = "turns" in t ? t.turns & 3 : 0;
  const mirror = "mirror" in t ? t.mirror : undefined;
  const dir = (d: string) => (mirror ? mirrorDir(d, mirror) : rotateDir(d, turns));
  const out: Record<string, string> = {};
  // up/down are side flags only when a block has both (mushroom blocks, glow lichen); a wall's `up` is its post.
  const vertical = mirror === "y" && "up" in props && "down" in props;
  for (const [k, v] of Object.entries(props)) {
    if (SIDES.has(k) || ((k === "up" || k === "down") && vertical)) {
      out[dir(k)] = v; // side flags move with the side they describe
      continue;
    }
    out[k] = value(k, v, props, mirror, turns, dir);
  }
  return out;
}

function value(k: string, v: string, props: Record<string, string>, mirror: MirrorAxis | undefined, turns: number, dir: (d: string) => string): string {
  const vertical = mirror === "y";
  switch (k) {
    case "facing":
    case "vertical_direction":
      return dir(v);
    case "axis":
      return !mirror && turns % 2 === 1 ? swap(v, "x", "z") : v;
    case "rotation": {
      const r = Number(v);
      if (!Number.isInteger(r)) return v;
      // 0 = south, 4 = west, 8 = north, 12 = east.
      if (mirror === "x") return String((16 - r) & 15);
      if (mirror === "z") return String((8 - r) & 15);
      if (mirror === "y") return v;
      return String((r + 4 * turns) & 15);
    }
    case "hinge":
      return mirror && !vertical ? swap(v, "left", "right") : v;
    case "shape":
      if (/^(straight|inner_left|inner_right|outer_left|outer_right)$/.test(v)) return mirror && !vertical ? swapLR(v) : v;
      return vertical ? v : railShape(v, dir);
    case "type":
      if (v === "left" || v === "right") return mirror && !vertical ? swapLR(v) : v; // chests
      return vertical ? swap(v, "top", "bottom") : v; // slabs
    case "half":
      return vertical ? swap(swap(v, "top", "bottom"), "upper", "lower") : v;
    case "face":
    case "attachment":
      return vertical ? swap(v, "floor", "ceiling") : v;
    case "hanging":
      return vertical ? swap(v, "true", "false") : v;
    case "orientation":
      return v.split("_").map(dir).join("_");
    default:
      return v;
  }
}

/**
 * Transforms one block state: mirror (if any), then rotation. Unknown blocks and properties keep
 * their values; a remapped value the registry rejects for that block is left as it was.
 */
export function transformState(state: string, t: StateTransform, opts: { registry?: Registry; overrides?: readonly StateOverride[] } = {}): string {
  let s = state;
  const steps: ({ turns: number } | { mirror: MirrorAxis })[] = [];
  if (t.mirror) steps.push({ mirror: t.mirror });
  const turns = ((t.turns ?? 0) % 4 + 4) % 4;
  if (turns) steps.push({ turns });
  for (const st of steps) {
    const o = opts.overrides?.map((f) => f(s, st)).find((r) => r !== undefined);
    if (o !== undefined) {
      s = o;
      continue;
    }
    if (!s.includes("[")) continue;
    const { id, props } = parseState(s);
    const next = step(props, st);
    const allowed = opts.registry?.get(id)?.properties;
    if (allowed) for (const [k, v] of Object.entries(next)) if (allowed[k] && !allowed[k].includes(v)) next[k] = props[k] ?? v;
    s = formatState(id, next);
  }
  return s;
}

/** A memoising state transformer for one op (the same state recurs thousands of times). */
export function stateTransformer(t: StateTransform, opts: { registry?: Registry; overrides?: readonly StateOverride[] } = {}): (state: string) => string {
  const cache = new Map<string, string>();
  return (state) => {
    let r = cache.get(state);
    if (r === undefined) cache.set(state, (r = transformState(state, t, opts)));
    return r;
  };
}

// -- positions ------------------------------------------------------------------------------------

/** Rotates a block position clockwise (seen from above) about the centre of the pivot block. */
export function rotatePos(p: Vec3, turns: number, pivot: Vec3): Vec3 {
  let dx = p[0] - pivot[0], dz = p[2] - pivot[2];
  for (let i = 0; i < (((turns % 4) + 4) % 4); i++) [dx, dz] = [-dz, dx];
  return [pivot[0] + dx, p[1], pivot[2] + dz];
}

/** Mirrors a block position across the plane through `about` on `axis` (may be a half coordinate). */
export function mirrorPos(p: Vec3, axis: MirrorAxis, about: number): Vec3 {
  const a = "xyz".indexOf(axis);
  const q: Vec3 = [...p];
  q[a] = 2 * about - p[a]!;
  return q;
}

/** Half-open box after transforming its corner blocks. */
export function transformBox(b: Box, f: (p: Vec3) => Vec3): Box {
  const a = f(b.min), c = f([b.max[0] - 1, b.max[1] - 1, b.max[2] - 1]);
  return {
    min: [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.min(a[2], c[2])],
    max: [Math.max(a[0], c[0]) + 1, Math.max(a[1], c[1]) + 1, Math.max(a[2], c[2]) + 1],
  };
}

/** Default rotation pivot: the box centre rounded toward the minimum corner (01). */
export function defaultPivot(b: Box): Vec3 {
  return [Math.floor((b.min[0] + b.max[0] - 1) / 2), Math.floor((b.min[1] + b.max[1] - 1) / 2), Math.floor((b.min[2] + b.max[2] - 1) / 2)];
}
