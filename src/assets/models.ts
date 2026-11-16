import { parseJsonLenient, type PackStack } from "./pack.js";

/**
 * Blockstate → model resolution, following the vanilla resource format:
 *   assets/<ns>/blockstates/<block>.json   variants | multipart
 *   assets/<ns>/models/<path>.json         parent chain, textures, elements
 */

export type Props = Record<string, string>;
export type Face = "down" | "up" | "north" | "south" | "west" | "east";
export const FACES: readonly Face[] = ["down", "up", "north", "south", "west", "east"];

export interface ModelRef {
  model: string; // normalised "ns:path"
  x: number;
  y: number;
  /** Rotation about the z axis in 90° steps, applied after x and y (1.21.11). Absent when 0. */
  z?: number;
  uvlock: boolean;
  weight: number;
}

export type Condition = { OR: Condition[] } | { AND: Condition[] } | Record<string, string>;

export type BlockstateDef =
  | { kind: "variants"; variants: { match: Props; refs: ModelRef[] }[] }
  | { kind: "multipart"; parts: { when?: Condition; refs: ModelRef[] }[] };

// ---------------------------------------------------------------------------------------------
// Resource ids
// ---------------------------------------------------------------------------------------------

/** "block/stone" → "minecraft:block/stone". */
export function normId(id: string): string {
  const i = id.indexOf(":");
  return i < 0 ? `minecraft:${id}` : id;
}

export function modelPath(id: string): string {
  const [ns, p] = splitId(id);
  return `assets/${ns}/models/${p}.json`;
}

export function texturePath(id: string): string {
  const [ns, p] = splitId(id);
  return `assets/${ns}/textures/${p}.png`;
}

export function splitId(id: string): [string, string] {
  const n = normId(id);
  const i = n.indexOf(":");
  return [n.slice(0, i), n.slice(i + 1)];
}

// ---------------------------------------------------------------------------------------------
// Blockstates
// ---------------------------------------------------------------------------------------------

interface RawRef {
  model?: string;
  x?: number;
  y?: number;
  z?: number;
  uvlock?: boolean;
  weight?: number;
}

function toRefs(raw: RawRef | RawRef[] | undefined): ModelRef[] {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list
    .filter((r): r is RawRef & { model: string } => typeof r?.model === "string")
    .map((r) => {
      const ref: ModelRef = { model: normId(r.model), x: r.x ?? 0, y: r.y ?? 0, uvlock: r.uvlock ?? false, weight: r.weight ?? 1 };
      if (r.z) ref.z = r.z;
      return ref;
    });
}

/** Parses "facing=east,half=bottom" (or "" / "normal" for the catch-all variant). */
export function parseVariantKey(key: string): Props {
  const out: Props = {};
  if (key === "" || key === "normal") return out;
  for (const part of key.split(",")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function normCondition(raw: unknown): Condition | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.OR)) return { OR: r.OR.map(normCondition).filter((c): c is Condition => !!c) };
  if (Array.isArray(r.AND)) return { AND: r.AND.map(normCondition).filter((c): c is Condition => !!c) };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(r)) out[k] = String(v); // mods sometimes write booleans/numbers
  return out;
}

export function parseBlockstate(json: unknown): BlockstateDef {
  const j = (json ?? {}) as { variants?: Record<string, RawRef | RawRef[]>; multipart?: { when?: unknown; apply?: RawRef | RawRef[] }[] };
  if (Array.isArray(j.multipart)) {
    return {
      kind: "multipart",
      parts: j.multipart.map((p) => {
        const when = normCondition(p.when);
        return when ? { when, refs: toRefs(p.apply) } : { refs: toRefs(p.apply) };
      }),
    };
  }
  return {
    kind: "variants",
    variants: Object.entries(j.variants ?? {}).map(([key, refs]) => ({ match: parseVariantKey(key), refs: toRefs(refs) })),
  };
}

export function conditionMatches(c: Condition, state: Props): boolean {
  if ("OR" in c && Array.isArray(c.OR)) return c.OR.some((x) => conditionMatches(x, state));
  if ("AND" in c && Array.isArray(c.AND)) return c.AND.every((x) => conditionMatches(x, state));
  for (const [k, v] of Object.entries(c as Record<string, string>)) {
    const actual = state[k];
    const negate = v.startsWith("!"); // not vanilla, but some mods use it
    const allowed = (negate ? v.slice(1) : v).split("|");
    if (negate ? actual !== undefined && allowed.includes(actual) : actual === undefined || !allowed.includes(actual)) return false;
  }
  return true;
}

/** The properties and values a blockstate file mentions (only those that affect the model). */
export function blockstateProperties(def: BlockstateDef): Record<string, string[]> {
  const props = new Map<string, Set<string>>();
  const add = (k: string, v: string) => {
    let s = props.get(k);
    if (!s) props.set(k, (s = new Set()));
    s.add(v);
  };
  const walk = (c: Condition) => {
    if ("OR" in c && Array.isArray(c.OR)) c.OR.forEach(walk);
    else if ("AND" in c && Array.isArray(c.AND)) c.AND.forEach(walk);
    else for (const [k, v] of Object.entries(c as Record<string, string>)) for (const x of v.replace(/^!/, "").split("|")) add(k, x);
  };
  if (def.kind === "variants") for (const v of def.variants) for (const [k, x] of Object.entries(v.match)) add(k, x);
  else for (const p of def.parts) if (p.when) walk(p.when);
  return Object.fromEntries([...props].map(([k, s]) => [k, [...s]]));
}

/**
 * The model refs used to draw a block state. For weighted variant lists the first entry is chosen,
 * which keeps renders deterministic.
 */
export function selectModels(def: BlockstateDef, state: Props): ModelRef[] {
  if (def.kind === "variants") {
    const hit = def.variants.find((v) => Object.entries(v.match).every(([k, x]) => state[k] === x));
    return hit?.refs[0] ? [hit.refs[0]] : [];
  }
  return def.parts.filter((p) => !p.when || conditionMatches(p.when, state)).flatMap((p) => (p.refs[0] ? [p.refs[0]] : []));
}

// ---------------------------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------------------------

export interface ModelFace {
  texture: string; // resolved texture id, or "#missing"
  uv?: [number, number, number, number];
  cullface?: Face;
  rotation?: number;
  tintindex?: number;
  /** NeoForge per-face/element vertex colour (ARGB hex), set in model JSON. */
  color?: string;
  /** The texture entry asked to be treated as translucent (`force_translucent`, 26.1). */
  forceTranslucent?: boolean;
}

/**
 * Element rotation about `origin`. Either one axis (`axis` + `angle`, every version) or several
 * (`angles`, degrees about x then y then z, 1.21.11). Angles are not snapped to 22.5° (1.21.6).
 */
export type ElementRotation =
  | { origin: [number, number, number]; axis: "x" | "y" | "z"; angle: number; rescale?: boolean }
  | { origin: [number, number, number]; angles: [number, number, number]; rescale?: boolean };

/** True when a rotation turns the element at all. */
export function isRotated(r: ElementRotation | undefined): boolean {
  return !!r && ("angles" in r ? r.angles.some((a) => a !== 0) : r.angle !== 0);
}

export interface ModelElement {
  from: [number, number, number];
  to: [number, number, number];
  rotation?: ElementRotation;
  shade?: boolean;
  /** Faces are shaded as if they faced this direction (`shade_direction_override`, 26.3). */
  shadeDirection?: Face;
  faces: Partial<Record<Face, ModelFace>>;
}

export interface ResolvedModel {
  id: string;
  textures: Record<string, string>;
  elements: ModelElement[];
  ambientOcclusion: boolean;
  particle?: string;
  /** Why this model may not render faithfully. */
  issues: ("missing" | "missing-parent" | "builtin-entity" | "custom-loader" | "loader-fallback" | "missing-texture" | "cycle")[];
  loader?: string;
}

/** A `textures` entry: a texture id or `#variable`, or (26.1) an object with a sprite id. */
type RawTexture = string | { sprite?: string; force_translucent?: boolean };

interface RawModel {
  parent?: string;
  textures?: Record<string, RawTexture>;
  elements?: RawElement[];
  ambientocclusion?: boolean;
  loader?: string;
  children?: Record<string, RawModel>;
  parts?: Record<string, RawModel>;
}

interface RawElement {
  from: [number, number, number];
  to: [number, number, number];
  rotation?: RawRotation;
  shade?: boolean;
  shade_direction_override?: string;
  faces?: Partial<Record<Face, { texture?: string; uv?: [number, number, number, number]; cullface?: Face; rotation?: number; tintindex?: number; neoforge_data?: { color?: string } }>>;
  neoforge_data?: { color?: string };
}

/** Both rotation forms as written: `axis` + `angle`, and (1.21.11) per-axis `x`, `y`, `z`. */
interface RawRotation {
  origin?: [number, number, number];
  axis?: string;
  angle?: number;
  x?: number;
  y?: number;
  z?: number;
  rescale?: boolean;
}

const MAX_PARENT_DEPTH = 32;

/** Resolves and caches models from a pack stack. */
export class ModelResolver {
  private readonly cache = new Map<string, Promise<ResolvedModel>>();
  private readonly raw = new Map<string, Promise<RawModel | undefined>>();

  constructor(private readonly stack: PackStack) {}

  resolve(id: string): Promise<ResolvedModel> {
    const key = normId(id);
    let p = this.cache.get(key);
    if (!p) this.cache.set(key, (p = this.doResolve(key)));
    return p;
  }

  get size(): number {
    return this.cache.size;
  }

  private loadRaw(id: string): Promise<RawModel | undefined> {
    let p = this.raw.get(id);
    if (!p) {
      p = this.stack.readJson<RawModel>(modelPath(id)).catch(() => undefined);
      this.raw.set(id, p);
    }
    return p;
  }

  private async doResolve(id: string): Promise<ResolvedModel> {
    const top = await this.resolveFrom(id, await this.loadRaw(id));
    if (top.elements.length > 0 || !top.issues.includes("custom-loader")) return top;
    // A pack replaced this model with a code-driven loader (e.g. connected textures) that has no JSON
    // geometry. Fall back to the highest lower-priority copy of the same model that does.
    const copies = await this.stack.readAll(modelPath(id)).catch(() => []);
    for (let i = copies.length - 2; i >= 0; i--) {
      let raw: RawModel;
      try {
        raw = parseJsonLenient(copies[i]!.data, modelPath(id)) as RawModel;
      } catch {
        continue;
      }
      const lower = await this.resolveFrom(id, raw);
      if (lower.elements.length > 0) return { ...lower, issues: [...new Set([...lower.issues, "loader-fallback" as const])] };
    }
    return top;
  }

  private async resolveFrom(id: string, first: RawModel | undefined): Promise<ResolvedModel> {
    const issues: ResolvedModel["issues"] = [];
    const chain: RawModel[] = [];
    let cur: string | undefined = id;
    let firstRaw = first;
    let builtinEntity = false;
    const seen = new Set<string>();
    while (cur) {
      if (cur === "minecraft:builtin/entity") {
        builtinEntity = true;
        break;
      }
      if (cur === "minecraft:builtin/generated") break;
      if (seen.has(cur) || chain.length > MAX_PARENT_DEPTH) {
        issues.push("cycle");
        break;
      }
      seen.add(cur);
      const raw: RawModel | undefined = chain.length === 0 ? firstRaw : await this.loadRaw(cur);
      firstRaw = undefined;
      if (!raw) {
        issues.push(chain.length === 0 ? "missing" : "missing-parent");
        break;
      }
      chain.push(raw);
      cur = raw.parent ? normId(raw.parent) : undefined;
    }
    if (builtinEntity) issues.push("builtin-entity");
    return this.merge(id, chain, issues);
  }

  /** chain[0] is the model itself, the last entry its root ancestor. */
  private async merge(id: string, chain: RawModel[], issues: ResolvedModel["issues"]): Promise<ResolvedModel> {
    const vars: TextureVars = {};
    for (let i = chain.length - 1; i >= 0; i--) Object.assign(vars, chain[i]!.textures ?? {});
    const rawElements = chain.find((m) => Array.isArray(m.elements))?.elements;
    const ao = chain.find((m) => m.ambientocclusion !== undefined)?.ambientocclusion ?? true;
    const loader = chain.find((m) => m.loader)?.loader;

    const textures: Record<string, string> = {};
    for (const k of Object.keys(vars)) {
      const t = resolveTextureVar(vars, k);
      if (t) textures[k] = t.id;
    }

    let elements = (rawElements ?? []).map((e) => bakeElement(e, vars, issues));

    // NeoForge composite models: merge children's elements (each child resolves its own textures).
    if (loader && /composite$/.test(loader)) {
      const kids = chain.find((m) => m.children || m.parts);
      for (const child of Object.values(kids?.children ?? kids?.parts ?? {})) {
        const childChain: RawModel[] = [child];
        let parent = child.parent ? normId(child.parent) : undefined;
        for (let d = 0; parent && d < MAX_PARENT_DEPTH; d++) {
          const r = await this.loadRaw(parent);
          if (!r) break;
          childChain.push(r);
          parent = r.parent ? normId(r.parent) : undefined;
        }
        const childVars: TextureVars = { ...vars };
        for (let i = childChain.length - 1; i >= 0; i--) Object.assign(childVars, childChain[i]!.textures ?? {});
        const els = childChain.find((m) => Array.isArray(m.elements))?.elements ?? [];
        elements = elements.concat(els.map((e) => bakeElement(e, childVars, issues)));
      }
    } else if (loader && !/separate_transforms$/.test(loader)) {
      issues.push("custom-loader");
    }

    const out: ResolvedModel = { id, textures, elements, ambientOcclusion: ao, issues: [...new Set(issues)] };
    if (textures.particle) out.particle = textures.particle;
    if (loader) out.loader = loader;
    return out;
  }
}

type TextureVars = Record<string, RawTexture>;

/**
 * Follows `#variable` references to a texture id. An object entry (26.1) ends the chain: its
 * `sprite` is always an id, never a variable.
 */
function resolveTextureVar(vars: TextureVars, key: string): { id: string; forceTranslucent: boolean } | undefined {
  let v: RawTexture | undefined = vars[key];
  for (let i = 0; i < 16 && typeof v === "string" && v.startsWith("#"); i++) v = vars[v.slice(1)];
  if (v !== undefined && typeof v === "object") {
    return typeof v.sprite === "string" && !v.sprite.startsWith("#") ? { id: normId(v.sprite), forceTranslucent: v.force_translucent === true } : undefined;
  }
  return v === undefined || v.startsWith("#") ? undefined : { id: normId(v), forceTranslucent: false };
}

const AXES = ["x", "y", "z"] as const;

/**
 * Normalises an element rotation. `axis` + `angle` wins when present, as in the game (1.21.11:
 * "older notation takes precedence"). Per-axis angles with only one non-zero become the one-axis
 * form, so both spellings of the same rotation bake identically.
 */
export function parseElementRotation(r: RawRotation | undefined): ElementRotation | undefined {
  if (!r || typeof r !== "object") return undefined;
  const origin = r.origin ?? [8, 8, 8];
  const rescale = r.rescale === true ? { rescale: true } : {};
  const axis = AXES.find((a) => a === r.axis);
  if (axis && typeof r.angle === "number") return { origin, axis, angle: r.angle, ...rescale };
  const angles: [number, number, number] = [num(r.x), num(r.y), num(r.z)];
  const turned = AXES.filter((_, i) => angles[i] !== 0);
  if (turned.length === 0) return undefined;
  if (turned.length === 1) return { origin, axis: turned[0]!, angle: angles[AXES.indexOf(turned[0]!)]!, ...rescale };
  return { origin, angles, ...rescale };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function bakeElement(e: RawElement, vars: TextureVars, issues: ResolvedModel["issues"]): ModelElement {
  const faces: ModelElement["faces"] = {};
  for (const f of FACES) {
    const rf = e.faces?.[f];
    if (!rf) continue;
    let tex: { id: string; forceTranslucent: boolean } | undefined;
    if (rf.texture) tex = rf.texture.startsWith("#") ? resolveTextureVar(vars, rf.texture.slice(1)) : { id: normId(rf.texture), forceTranslucent: false };
    if (!tex) issues.push("missing-texture");
    const face: ModelFace = { texture: tex?.id ?? "#missing" };
    if (tex?.forceTranslucent) face.forceTranslucent = true;
    if (rf.uv) face.uv = rf.uv;
    if (rf.cullface) face.cullface = rf.cullface;
    if (rf.rotation) face.rotation = rf.rotation;
    if (rf.tintindex !== undefined) face.tintindex = rf.tintindex;
    const color = rf.neoforge_data?.color ?? e.neoforge_data?.color;
    if (color && !/^f*$/i.test(color)) face.color = color;
    faces[f] = face;
  }
  const out: ModelElement = { from: e.from, to: e.to, faces };
  const rotation = parseElementRotation(e.rotation);
  if (rotation) out.rotation = rotation;
  if (e.shade === false) out.shade = false;
  const dir = FACES.find((f) => f === e.shade_direction_override);
  if (dir) out.shadeDirection = dir;
  return out;
}

/** Union bounds of all elements (model units, 0–16), ignoring element rotation. */
export function modelBounds(models: ResolvedModel[]): { from: [number, number, number]; to: [number, number, number] } | undefined {
  let from: [number, number, number] | undefined;
  let to: [number, number, number] | undefined;
  for (const m of models)
    for (const e of m.elements) {
      from = from ? [Math.min(from[0], e.from[0]), Math.min(from[1], e.from[1]), Math.min(from[2], e.from[2])] : [...e.from];
      to = to ? [Math.max(to[0], e.to[0]), Math.max(to[1], e.to[1]), Math.max(to[2], e.to[2])] : [...e.to];
    }
  return from && to ? { from, to } : undefined;
}

const X_STEP: Record<Face, Face> = { up: "north", north: "down", down: "south", south: "up", east: "east", west: "west" };
const Y_STEP: Record<Face, Face> = { north: "east", east: "south", south: "west", west: "north", up: "up", down: "down" };
const Z_STEP: Record<Face, Face> = { up: "east", east: "down", down: "west", west: "up", north: "north", south: "south" };

/** Where a model face ends up after a blockstate rotation (x, then y, then z; 90° steps). */
export function rotateFace(face: Face, x = 0, y = 0, z = 0): Face {
  let f = face;
  for (let i = 0; i < (((x / 90) % 4) + 4) % 4; i++) f = X_STEP[f];
  for (let i = 0; i < (((y / 90) % 4) + 4) % 4; i++) f = Y_STEP[f];
  for (let i = 0; i < (((z / 90) % 4) + 4) % 4; i++) f = Z_STEP[f];
  return f;
}

export interface PlacedModel {
  model: ResolvedModel;
  x?: number;
  y?: number;
  z?: number;
}

/**
 * True when unrotated full-size elements together cover all six faces, after blockstate rotation:
 * one cube element, or one element per face as multipart blocks like mushroom blocks do.
 */
export function isFullCube(parts: PlacedModel[]): boolean {
  const faces = new Set<Face>();
  for (const { model, x, y, z } of parts)
    for (const e of model.elements) {
      if (isRotated(e.rotation) || !e.from.every((v) => v <= 0) || !e.to.every((v) => v >= 16)) continue;
      for (const f of FACES) if (e.faces[f]) faces.add(rotateFace(f, x, y, z));
    }
  return faces.size === 6;
}
