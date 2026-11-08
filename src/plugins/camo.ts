import type { Compound } from "prismarine-nbt";
import { z } from "zod";
import type { CodeModel, CodeModelPart, RenderContext } from "../assets/builtin-models/index.js";
import { FACES, rotateFace, type Face, type ModelElement, type ModelFace } from "../assets/models.js";
import type { Registry } from "../assets/registry.js";
import { canonicalState, formatState, isAir, parseState, stateId } from "../core/blockstate.js";
import { Mask } from "../core/mask.js";
import type { Box } from "../core/region.js";
import type { AutosketchPlugin, PluginAction, PluginActionContext } from "./types.js";

/**
 * Shared machinery for camo mods (09: FramedBlocks, Copycats): blocks whose look is another block
 * ("camo") stored in block-entity NBT. Each mod supplies a `CamoMod`: which blocks it owns, how
 * shape names map to ids, and its NBT layout (one read and one write function per mod, both
 * unverified against in-game saves; see 09). Everything else (rendering with the camo's textures,
 * frame + camo items, NBT warnings and the shape/camo actions) is common.
 */

type Tag = Compound["value"][string];

export const nbtStr = (value: string) => ({ type: "string" as const, value });
export const nbtInt = (value: number) => ({ type: "int" as const, value });
export const nbtComp = (value: Compound["value"]): Compound => ({ type: "compound", value });
export const asComp = (t: Tag | undefined): Compound | undefined => (t && t.type === "compound" ? (t as Compound) : undefined);

/** A block state as the game writes it in NBT (`NbtUtils.writeBlockState`): {Name, Properties}. */
export function stateToNbt(state: string): Compound {
  const { id, props } = parseState(state);
  const v: Compound["value"] = { Name: nbtStr(id) };
  if (Object.keys(props).length) v.Properties = nbtComp(Object.fromEntries(Object.entries(props).map(([k, p]) => [k, nbtStr(p)])));
  return nbtComp(v);
}

/** The state in a {Name, Properties} compound, or undefined. */
export function stateFromNbt(t: Tag | undefined): string | undefined {
  const c = asComp(t);
  const name = c?.value.Name;
  if (!c || !name || name.type !== "string" || !name.value) return undefined;
  const props: Record<string, string> = {};
  const p = asComp(c.value.Properties);
  for (const [k, v] of Object.entries(p?.value ?? {})) if (v?.type === "string") props[k] = v.value;
  try {
    return formatState(parseState(name.value).id, props);
  } catch {
    return undefined;
  }
}

export interface CamoMod {
  pluginId: string;
  /** Op prefix (09: `framed`, `copycat`). */
  prefix: string;
  /** "framed block", "copycat". */
  label: string;
  owns(id: string): boolean;
  /** Candidate ids for a short shape name ("slope"), most likely first. */
  shapeCandidates(shape: string): string[];
  /** Short shape name of an owned id. */
  shapeName(id: string): string;
  /** Texture drawn when a block has no camo. */
  placeholder: string;
  /** The block's own JSON model draws an empty frame well enough (FramedBlocks: a framed cube). */
  jsonModelForEmpty: boolean;
  /** Camo state from block-entity NBT. Layout unverified (09). */
  readCamo(nbt: Compound): string | undefined;
  /** Block-entity NBT carrying `camo`, keeping the other keys of `prev`. Layout unverified (09). */
  writeCamo(blockId: string, camo: string | undefined, prev: Compound | undefined): Compound;
  /** NBT keys that mean "a camo is stored here" (to warn when it can't be read). */
  camoKeys: string[];
}

// ---- geometry -----------------------------------------------------------------------------------

type V3 = [number, number, number];
const FACING_Y: Record<string, number> = { north: 0, east: 90, south: 180, west: 270 };

/** A cuboid with all six faces, culled where it touches the block boundary. Textures are set later. */
function cuboid(from: V3, to: V3): ModelElement {
  const faces: Partial<Record<Face, ModelFace>> = {};
  const edge: Record<Face, boolean> = { down: from[1] === 0, up: to[1] === 16, north: from[2] === 0, south: to[2] === 16, west: from[0] === 0, east: to[0] === 16 };
  for (const f of FACES) faces[f] = { texture: "#missing", ...(edge[f] ? { cullface: f } : {}) };
  return { from, to, faces };
}

const flipY = (els: ModelElement[]): ModelElement[] => els.map((e) => cuboid([e.from[0], 16 - e.to[1], e.from[2]], [e.to[0], 16 - e.from[1], e.to[2]]));

/** Elements on the axis: a centred square column `w` wide. */
function column(axis: string | undefined, lo: number, hi: number): ModelElement {
  if (axis === "x") return cuboid([0, lo, lo], [16, hi, hi]);
  if (axis === "z") return cuboid([lo, lo, 0], [hi, hi, 16]);
  return cuboid([lo, 0, lo], [hi, 16, hi]);
}

/**
 * Hand-written geometry for the common camo shapes, facing north before the part's y rotation.
 * Slopes are drawn as four steps (models are cuboids). Property names follow the mods' public
 * source and vanilla conventions (`facing`, `half`, `type`, `top`, `axis`, `layers`); unknown
 * shapes return undefined and are drawn as a full block.
 */
export function shapeGeometry(path: string, props: Record<string, string>): CodeModelPart | undefined {
  const y = FACING_Y[props.facing ?? "north"] ?? 0;
  const top = props.top === "true" || props.type === "top" || props.half === "top";
  const is = (re: RegExp) => re.test(path);
  if (is(/(_cube|copycat_block)$/)) return { elements: [cuboid([0, 0, 0], [16, 16, 16])] };
  if (is(/_slab$/) && !is(/slope_slab|_slab_edge/)) {
    if (props.type === "double") return { elements: [cuboid([0, 0, 0], [16, 16, 16])] };
    return { elements: top ? [cuboid([0, 8, 0], [16, 16, 16])] : [cuboid([0, 0, 0], [16, 8, 16])] };
  }
  if (is(/_panel$/) && !is(/slope_panel|half_panel|byte_panel/)) {
    const t = is(/^copycat_panel$/) ? 3 : 8;
    return { elements: [cuboid([0, 0, 0], [16, 16, t])], y };
  }
  if (is(/_stairs$/) && !is(/vertical_stairs|half_stairs|sloped_stairs|double_stairs/)) {
    const els = [cuboid([0, 0, 0], [16, 8, 16]), cuboid([0, 8, 0], [16, 16, 8])];
    return { elements: top ? flipY(els) : els, y };
  }
  if (is(/_slope$/) && !is(/vertical_slope|corner_slope/)) {
    const els = [0, 1, 2, 3].map((i) => cuboid([0, 4 * i, 0], [16, 4 * i + 4, 16 - 4 * i]));
    return { elements: top ? flipY(els) : els, y };
  }
  if (is(/_step$/)) {
    const els = [cuboid([0, 0, 0], [16, 8, 8])];
    return { elements: top ? flipY(els) : els, y };
  }
  if (is(/(^|_)layer$/) && !is(/half_layer|slope_layer/)) {
    const n = Math.max(1, Math.min(8, Number(props.layers ?? 1) || 1));
    return { elements: [cuboid([0, 0, 0], [16, 2 * n, 16])] };
  }
  if (is(/_pillar$/) && !is(/corner_pillar/)) return { elements: [column(props.axis, 4, 12)] };
  if (is(/_post$/)) return { elements: [column(props.axis, 6, 10)] };
  return undefined;
}

// ---- rendering ----------------------------------------------------------------------------------

/** The camo's face textures by world direction, from its JSON model (full-block elements first). */
export async function camoFaces(camo: string, ctx: RenderContext): Promise<Partial<Record<Face, ModelFace>> | undefined> {
  const parts = await ctx.jsonModel(camo);
  const out: Partial<Record<Face, ModelFace>> = {};
  const full = (e: ModelElement) => e.from.every((v) => v === 0) && e.to.every((v) => v === 16);
  for (const pass of [true, false])
    for (const part of parts)
      for (const el of part.elements) {
        if (full(el) !== pass) continue;
        for (const f of FACES) {
          const face = el.faces[f];
          const w = rotateFace(f, part.x ?? 0, part.y ?? 0);
          if (face && face.texture !== "#missing" && !out[w]) out[w] = face;
        }
      }
  return Object.keys(out).length ? out : undefined;
}

/** Re-skins elements turned by `y`: each face takes the camo texture of the direction it ends up facing. */
function skin(els: ModelElement[], y: number, faces: Partial<Record<Face, ModelFace>> | undefined, placeholder: string): ModelElement[] {
  const any = faces ? Object.values(faces)[0] : undefined;
  return els.map((el) => {
    const out: Partial<Record<Face, ModelFace>> = {};
    for (const [f, face] of Object.entries(el.faces) as [Face, ModelFace][]) {
      const src = faces?.[rotateFace(f, 0, y)] ?? any;
      out[f] = { ...(face.cullface ? { cullface: face.cullface } : {}), texture: src?.texture ?? placeholder, ...(src?.tintindex !== undefined ? { tintindex: src.tintindex } : {}) };
    }
    return { ...el, faces: out };
  });
}

/** The render hook (09 `render`): the shape drawn with the camo's textures. */
export function camoRender(mod: CamoMod): NonNullable<AutosketchPlugin["render"]> {
  return async (_pos, state, nbt, ctx): Promise<CodeModel | null> => {
    const { id, props } = parseState(state);
    if (!mod.owns(id)) return null;
    const camo = nbt ? mod.readCamo(nbt) : undefined;
    const geo = shapeGeometry(id.slice(id.indexOf(":") + 1), props);
    if (!geo && !camo && mod.jsonModelForEmpty) return null;
    const part = geo ?? { elements: [cuboid([0, 0, 0], [16, 16, 16])] };
    const faces = camo ? await camoFaces(camo, ctx) : undefined;
    const elements = skin(part.elements, part.y ?? 0, faces, mod.placeholder);
    return { parts: [{ elements, ...(part.y ? { y: part.y } : {}) }], ...(camo ? { tintFrom: stateId(camo) } : {}) };
  };
}

// ---- items and NBT checks -------------------------------------------------------------------------

/** 08 material list: the frame plus its camo item. */
export function camoItems(mod: CamoMod): NonNullable<AutosketchPlugin["items"]> {
  return (state, nbt) => {
    const id = stateId(state);
    if (!mod.owns(id)) return undefined;
    const camo = nbt ? mod.readCamo(nbt) : undefined;
    return [{ item: id, count: 1 }, ...(camo ? [{ item: stateId(camo), count: 1 }] : [])];
  };
}

export function camoValidate(mod: CamoMod): NonNullable<AutosketchPlugin["validateNbt"]> {
  return (state, nbt) => {
    if (!nbt || !mod.owns(stateId(state))) return [];
    if (mod.camoKeys.some((k) => k in nbt.value) && !mod.readCamo(nbt)) return [`${stateId(state)}: camo NBT not understood (its layout is unverified, 09)`];
    return [];
  };
}

// ---- actions ------------------------------------------------------------------------------------

const MAX_BLOCKS = 1_000_000;

export function forEachIn(r: Box | Mask, fn: (x: number, y: number, z: number) => void): number {
  if (r instanceof Mask) {
    const n = r.count();
    if (n > MAX_BLOCKS) throw new Error(`the selection has ${n} blocks; one op here takes at most ${MAX_BLOCKS}`);
    r.forEach(fn);
    return n;
  }
  const n = (r.max[0] - r.min[0]) * (r.max[1] - r.min[1]) * (r.max[2] - r.min[2]);
  if (n > MAX_BLOCKS) throw new Error(`the selection has ${n} blocks; one op here takes at most ${MAX_BLOCKS}`);
  for (let y = r.min[1]; y < r.max[1]; y++) for (let z = r.min[2]; z < r.max[2]; z++) for (let x = r.min[0]; x < r.max[0]; x++) fn(x, y, z);
  return n;
}

/** Resolves a shape name to an owned block id, or throws listing what the instance has. */
export function resolveShape(mod: CamoMod, shape: string, registry: Registry | undefined): string {
  const s = shape.trim().toLowerCase();
  const cands = s.includes(":") ? [s] : mod.shapeCandidates(s);
  const hit = registry ? cands.find((c) => registry.has(c) && mod.owns(c)) : cands.find((c) => mod.owns(c));
  if (hit) return hit;
  const have = registry ? [...new Set([...registry.all()].filter((b) => mod.owns(b.id)).map((b) => mod.shapeName(b.id)))].sort() : [];
  throw new Error(`no ${mod.label} shape "${shape}"${have.length ? `; shapes: ${have.slice(0, 40).join(", ")}${have.length > 40 ? ` … (${have.length})` : ""}` : ""}`);
}

/** Canonical camo state; warns (kept) when the instance doesn't know the block. */
export function resolveCamo(mod: CamoMod, camo: string, registry: Registry | undefined, warn: (m: string) => void): string {
  const c = canonicalState(camo, registry);
  if (isAir(c.state)) throw new Error("a camo can't be air");
  if (mod.owns(stateId(c.state))) throw new Error(`a ${mod.label} can't be the camo of another`);
  if (c.unknown) warn(`camo ${stateId(c.state)} is not a block in this instance (kept)`);
  return c.state;
}

/** The shape block with `state` properties ("facing=east,type=top"), validated when the registry knows them. */
export function shapeState(id: string, state: string | undefined, registry: Registry | undefined): string {
  const inner = (state ?? "").trim().replace(/^\[/, "").replace(/\]$/, "");
  const text = inner ? `${id}[${inner}]` : id;
  const known = registry?.get(id);
  if (known && Object.keys(known.properties).length) return canonicalState(text, registry).state;
  const p = parseState(text);
  return formatState(p.id, p.props);
}

/** `<prefix>.shape` and `<prefix>.camo` (09). `camoParam` is the camo argument's name ("camo", "material"). */
export function camoActions(mod: CamoMod, camoParam: "camo" | "material"): Record<string, PluginAction> {
  const sel = z.unknown().describe("Selection (any sel expression or box)");
  const shapeParams = z.object({
    sel,
    shape: z.string().describe(`Shape name, e.g. "slope", "stairs", "slab", "panel", or a full ${mod.pluginId} id`),
    [camoParam]: z.string().optional().describe('Camo block, e.g. "stone" or "oak_planks"'),
    state: z.string().optional().describe('Shape properties, e.g. "facing=east,type=top" (written as given; unknown to the registry)'),
  });
  const camoParams = z.object({ sel, [camoParam]: z.string().describe('Camo block, e.g. "stone_bricks"') });
  return {
    shape: {
      description: `Places ${mod.label} shapes over the selection, each with the camo block in its NBT (renders and lists as that block). One undo step. Text.`,
      params: shapeParams,
      run(ctx: PluginActionContext, raw: unknown) {
        const a = raw as Record<string, string | undefined> & { sel: unknown };
        const warns: string[] = [];
        const id = resolveShape(mod, a.shape!, ctx.registry);
        const camoArg = a[camoParam];
        const camo = camoArg ? resolveCamo(mod, camoArg, ctx.registry, (m) => warns.push(m)) : undefined;
        const state = shapeState(id, a.state, ctx.registry);
        const region = ctx.region(a.sel);
        return ctx.edit(`${mod.prefix}.shape ${mod.shapeName(id)}${camo ? ` camo ${camo}` : ""}`, (tx) => {
          const sid = tx.intern(state);
          forEachIn(region, (x, y, z) => tx.set(x, y, z, sid, mod.writeCamo(id, camo, undefined)));
          if (!camo) warns.push(`no ${camoParam} given: the ${mod.label}s are empty frames`);
          for (const w of warns) tx.warn(w);
        });
      },
    },
    camo: {
      description: `Re-skins existing ${mod.label}s in the selection with a camo block; other blocks are left alone. One undo step. Text.`,
      params: camoParams,
      run(ctx: PluginActionContext, raw: unknown) {
        const a = raw as Record<string, string> & { sel: unknown };
        const warns: string[] = [];
        const camo = resolveCamo(mod, a[camoParam]!, ctx.registry, (m) => warns.push(m));
        const region = ctx.region(a.sel);
        return ctx.edit(`${mod.prefix}.camo ${camo}`, (tx) => {
          let hit = 0;
          forEachIn(region, (x, y, z) => {
            const st = tx.get(x, y, z);
            const id = stateId(st);
            if (!mod.owns(id)) return;
            tx.set(x, y, z, st, mod.writeCamo(id, camo, ctx.doc.getBlockEntity(x, y, z)));
            hit++;
          });
          if (!hit) warns.push(`no ${mod.label}s in the selection; nothing re-skinned`);
          for (const w of warns) tx.warn(w);
        });
      },
    },
  };
}

/** The knowledge and action fields every camo plugin shares. */
export function camoPlugin(mod: CamoMod, camoParam: "camo" | "material"): Pick<AutosketchPlugin, "render" | "items" | "validateNbt" | "actions" | "opNamespace"> {
  return { render: camoRender(mod), items: camoItems(mod), validateNbt: camoValidate(mod), actions: camoActions(mod, camoParam), opNamespace: mod.prefix };
}
