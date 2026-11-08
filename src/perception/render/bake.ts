import type { Compound } from "prismarine-nbt";
import { fitUv } from "../../assets/builtin-models/geometry.js";
import { builtinModel, type CodeModel, type CodeModelPart, type RenderContext, type RenderHook } from "../../assets/builtin-models/index.js";
import type { PackStack } from "../../assets/pack.js";
import type { Registry } from "../../assets/registry.js";
import { FACES, parseBlockstate, rotateFace, selectModels, splitId, type BlockstateDef, type Face, type ModelElement, type ModelRef, type ResolvedModel, ModelResolver } from "../../assets/models.js";
import { parseState } from "../../core/blockstate.js";
import type { RGB } from "../../palette/color.js";
import { Image } from "../../palette/image.js";
import type { TextureLoader, Tinter } from "../../palette/textures.js";

/**
 * Bakes block states into textured quads in block space (0..1), the way the game does
 * (docs/design/06-perception.md "Renders"): blockstate → models → elements → faces, with element
 * rotation, blockstate x/y rotation, tints and directional face shading. Cached per state.
 */

export interface BakedQuad {
  /** 4 corners (x,y,z) in block units: TL, TR, BR, BL as seen from outside. */
  pos: Float32Array;
  /** Matching texture coordinates in 0..1. */
  uv: Float32Array;
  tex: Texture;
  tint?: RGB;
  /** Brightness factor from the face direction (game-style: up 1, sides 0.8/0.6, down 0.5). */
  shade: number;
  /** Face of the block this quad is culled by (rotated), when the neighbour there is opaque. */
  cull?: Face;
}

export interface Texture {
  img: Image;
  /** Some pixels are partly transparent (stained glass, ice): drawn in the blended pass. */
  translucent: boolean;
  /** Every pixel is fully opaque. */
  opaque: boolean;
  /** Mean colour, for the flat style. */
  mean: RGB;
}

export interface BakedBlock {
  quads: BakedQuad[];
  /** Faces fully covered by opaque geometry: a neighbour's face against them is hidden. */
  occludes: Set<Face>;
  /** No usable model: drawn as a placeholder. */
  fallback: boolean;
  /** Has translucent quads. */
  translucent: boolean;
}

const SHADE: Record<Face, number> = { up: 1, down: 0.5, north: 0.8, south: 0.8, east: 0.6, west: 0.6 };

export class BlockBaker {
  private readonly cache = new Map<string, Promise<BakedBlock>>();
  private readonly defs = new Map<string, Promise<BlockstateDef | undefined>>();
  private readonly textures = new Map<string, Promise<Texture | undefined>>();
  private readonly resolver: ModelResolver;
  private placeholder?: Texture;

  constructor(
    private readonly stack: PackStack,
    private readonly loader: TextureLoader,
    private readonly tinter: Tinter | undefined,
    private readonly registry?: Registry,
    /** Plugin render hooks (09), tried in order before the block's own model. */
    private readonly hooks: readonly { render?: RenderHook }[] = [],
  ) {
    this.resolver = new ModelResolver(stack);
  }

  /**
   * Bakes the block at a position with its block-entity NBT, for blocks whose look depends on it
   * (09: a plugin `render` hook, e.g. a framed block drawn with its camo). Without a hook that
   * answers, this is `bake(state)`. Not cached: NBT varies per block.
   */
  async bakeAt(pos: [number, number, number], state: string, nbt: Compound | undefined): Promise<BakedBlock> {
    const hooked = this.hooks.length ? await this.hookModel(pos, state, nbt).catch(() => undefined) : undefined;
    if (!hooked) return this.bake(state);
    const quads = hooked.overlay ? [...(await this.bake(state)).quads] : [];
    await this.bakeCode(hooked, quads, this.tinter?.tintFor(hooked.tintFrom ?? parseState(state).id), undefined);
    return this.finish(quads);
  }

  /** True when plugin render hooks may draw a block differently with its NBT (render.ts calls `bakeAt` then). */
  get hasRenderHooks(): boolean {
    return this.hooks.some((h) => h.render);
  }

  private async hookModel(pos: [number, number, number] | undefined, state: string, nbt: Compound | undefined): Promise<CodeModel | undefined> {
    const ctx: RenderContext = { registry: this.registry, jsonModel: (s) => this.jsonModel(s) };
    for (const h of this.hooks) {
      const m = await h.render?.(pos, state, nbt, ctx);
      if (m) return m;
    }
    return undefined;
  }

  /** A state's JSON model as code-model parts (for render hooks that reshape or re-skin it). */
  private async jsonModel(state: string): Promise<CodeModelPart[]> {
    const { id, props } = parseState(state);
    const def = await this.def(id);
    if (!def) return [];
    return Promise.all(selectModels(def, props).map(async (ref) => ({ elements: (await this.resolver.resolve(ref.model)).elements, x: ref.x, y: ref.y })));
  }

  private async bakeCode(model: CodeModel, out: BakedQuad[], tint: RGB | undefined, fallbackTex: Texture | undefined): Promise<void> {
    for (const part of model.parts) {
      const ref: ModelRef = { model: "", x: part.x ?? 0, y: part.y ?? 0, uvlock: false, weight: 1 };
      for (const el of part.elements) await this.bakeElement(el, ref, out, tint, fallbackTex);
    }
  }

  private finish(quads: BakedQuad[]): BakedBlock {
    const occludes = new Set<Face>();
    for (const q of quads) if (q.cull && q.tex.opaque && coversFace(q)) occludes.add(q.cull);
    return { quads, occludes, fallback: false, translucent: quads.some((q) => q.tex.translucent) };
  }

  bake(state: string): Promise<BakedBlock> {
    let p = this.cache.get(state);
    if (!p) this.cache.set(state, (p = this.doBake(state).catch(() => this.fallbackBlock())));
    return p;
  }

  private def(id: string): Promise<BlockstateDef | undefined> {
    let p = this.defs.get(id);
    if (!p) {
      const [ns, path] = splitId(id);
      p = this.stack
        .readJson(`assets/${ns}/blockstates/${path}.json`)
        .then((j) => parseBlockstate(j))
        .catch(() => undefined);
      this.defs.set(id, p);
    }
    return p;
  }

  private texture(id: string): Promise<Texture | undefined> {
    let p = this.textures.get(id);
    if (!p) {
      p = this.loader.load(id).then((img) => (img ? describeTexture(img) : undefined));
      this.textures.set(id, p);
    }
    return p;
  }

  private placeholderTexture(): Texture {
    if (!this.placeholder) {
      const img = new Image(16, 16);
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) img.fillRect(x, y, 1, 1, ((x >> 3) + (y >> 3)) % 2 ? [20, 20, 20, 255] : [230, 40, 220, 255]);
      this.placeholder = describeTexture(img);
    }
    return this.placeholder;
  }

  private fallbackBlock(): BakedBlock {
    const tex = this.placeholderTexture();
    const quads = FACES.map((f) => quadFor(f, [0, 0, 0], [16, 16, 16], undefined, tex, undefined, true));
    return { quads, occludes: new Set(), fallback: true, translucent: false };
  }

  private async doBake(state: string): Promise<BakedBlock> {
    const hooked = this.hooks.length ? await this.hookModel(undefined, state, undefined).catch(() => undefined) : undefined;
    const { id, props } = parseState(state);
    const tint = this.tinter?.tintFor(id);
    if (hooked && !hooked.overlay) {
      const quads: BakedQuad[] = [];
      await this.bakeCode(hooked, quads, tint, undefined);
      return this.finish(quads);
    }
    const base = await this.bakeJson(id, props, tint);
    if (!hooked) return base;
    const quads = [...base.quads];
    await this.bakeCode(hooked, quads, tint, undefined);
    return this.finish(quads);
  }

  /**
   * The block's own model. Code-drawn blocks (no JSON geometry) use the hand-written models in
   * assets/builtin-models (02); other geometry-less models fall back to a particle-texture cube.
   */
  private async bakeJson(id: string, props: Record<string, string>, tint: RGB | undefined): Promise<BakedBlock> {
    const def = await this.def(id);
    if (!def) return this.fallbackBlock();
    const refs = selectModels(def, props);
    if (refs.length === 0) return this.fallbackBlock();
    const quads: BakedQuad[] = [];
    let anyElements = false;
    const empty: ResolvedModel[] = [];
    for (const ref of refs) {
      const model = await this.resolver.resolve(ref.model);
      if (model.elements.length) anyElements = true;
      for (const el of model.elements) await this.bakeElement(el, ref, quads, tint);
      if (!model.elements.length) empty.push(model);
    }
    const code = builtinModel(id, props);
    if (code && (code.overlay || !anyElements)) {
      const particle = empty[0]?.particle ?? (await this.resolver.resolve(refs[0]!.model)).particle;
      const fallbackTex = particle ? await this.texture(particle) : undefined;
      await this.bakeCode(code, quads, tint, fallbackTex);
    } else for (const model of empty) await this.particleCube(model, quads, id, tint);
    if (!anyElements && quads.length === 0) return this.fallbackBlock();
    return this.finish(quads);
  }

  /**
   * Models without geometry are drawn by game code: fluids, and code-drawn blocks without a
   * built-in model (chests, signs, beds… have one in assets/builtin-models). Approximate them
   * with a cube of the particle texture: fluids fill the block (surface at 14/16), tinted and
   * translucent; everything else is slightly inset.
   */
  private async particleCube(model: ResolvedModel, quads: BakedQuad[], id: string, tint: RGB | undefined): Promise<void> {
    const t = model.particle ? await this.texture(model.particle) : undefined;
    let tex = t ?? this.placeholderTexture();
    const fluid = /(^|:)(water|lava)$/.test(id);
    if (fluid && /water/.test(id)) tex = { ...tex, translucent: true, opaque: false };
    const [from, to]: [V3, V3] = fluid ? [[0, 0, 0], [16, 14, 16]] : [[1, 0, 1], [15, 14, 15]];
    for (const f of FACES) {
      const q = quadFor(f, from, to, undefined, tex, fluid ? tint : undefined, true);
      if (!fluid || f === "up") delete q.cull; // only full-size fluid sides can be hidden by neighbours
      quads.push(q);
    }
  }

  private async bakeElement(el: ModelElement, ref: ModelRef, out: BakedQuad[], tint: RGB | undefined, fallbackTex?: Texture): Promise<void> {
    for (const f of FACES) {
      const face = el.faces[f];
      if (!face) continue;
      const tex = face.texture === "#missing" ? this.placeholderTexture() : ((await this.texture(face.texture)) ?? fallbackTex ?? this.placeholderTexture());
      const faceTint = face.tintindex !== undefined && face.tintindex >= 0 ? tint : face.color ? argbToRgb(face.color) : undefined;
      const uv = fitUv(face, tex.img.width, tex.img.height).uv; // code-drawn faces: match the real texture's aspect
      const q = quadFor(f, el.from, el.to, uv, tex, faceTint, el.shade !== false, face.rotation ?? 0);
      if (el.rotation?.angle) rotateElement(q.pos, el.rotation);
      if (ref.x || ref.y) {
        rotateBlock(q.pos, ref.x, ref.y);
        if (q.cull) q.cull = rotateFace(q.cull, ref.x, ref.y);
      }
      if (face.cullface) q.cull = rotateFace(face.cullface, ref.x, ref.y);
      else delete q.cull;
      q.shade = el.shade === false ? 1 : shadeOf(q.pos);
      out.push(q);
    }
  }
}

export function describeTexture(img: Image): Texture {
  let partial = 0, transparent = 0, r = 0, g = 0, b = 0, n = 0;
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3]!;
    if (a < 255) transparent++;
    if (a > 8 && a < 247) partial++;
    if (a > 8) {
      r += d[i]!;
      g += d[i + 1]!;
      b += d[i + 2]!;
      n++;
    }
  }
  const px = d.length / 4;
  return {
    img,
    translucent: partial > px * 0.05,
    opaque: transparent === 0,
    mean: n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : [128, 128, 128],
  };
}

function argbToRgb(hex: string): RGB | undefined {
  const v = parseInt(hex.replace(/^0x|^#/i, ""), 16);
  if (!Number.isFinite(v)) return undefined;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

type V3 = [number, number, number];

/** Corner order TL, TR, BR, BL as seen from outside, in model units (0..16). */
function corners(f: Face, a: V3, b: V3): V3[] {
  const [x0, y0, z0] = a, [x1, y1, z1] = b;
  switch (f) {
    case "north": return [[x1, y1, z0], [x0, y1, z0], [x0, y0, z0], [x1, y0, z0]];
    case "south": return [[x0, y1, z1], [x1, y1, z1], [x1, y0, z1], [x0, y0, z1]];
    case "west": return [[x0, y1, z0], [x0, y1, z1], [x0, y0, z1], [x0, y0, z0]];
    case "east": return [[x1, y1, z1], [x1, y1, z0], [x1, y0, z0], [x1, y0, z1]];
    case "up": return [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]];
    case "down": return [[x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0]];
  }
}

/** The game's default UV rectangle for a face, from the element's extent. */
function defaultUv(f: Face, a: V3, b: V3): [number, number, number, number] {
  const [x0, y0, z0] = a, [x1, y1, z1] = b;
  switch (f) {
    case "north": return [16 - x1, 16 - y1, 16 - x0, 16 - y0];
    case "south": return [x0, 16 - y1, x1, 16 - y0];
    case "west": return [z0, 16 - y1, z1, 16 - y0];
    case "east": return [16 - z1, 16 - y1, 16 - z0, 16 - y0];
    case "up": return [x0, z0, x1, z1];
    case "down": return [x0, 16 - z1, x1, 16 - z0];
  }
}

function quadFor(f: Face, from: V3, to: V3, uv: [number, number, number, number] | undefined, tex: Texture, tint: RGB | undefined, shade: boolean, rotation = 0): BakedQuad {
  const c = corners(f, from, to);
  const pos = new Float32Array(12);
  c.forEach((p, i) => pos.set([p[0] / 16, p[1] / 16, p[2] / 16], i * 3));
  const [u0, v0, u1, v1] = uv ?? defaultUv(f, from, to);
  const base: [number, number][] = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
  const steps = (((rotation / 90) % 4) + 4) % 4;
  const uvs = new Float32Array(8);
  for (let i = 0; i < 4; i++) {
    const [u, v] = base[(i - steps + 4) % 4]!;
    uvs[i * 2] = u / 16;
    uvs[i * 2 + 1] = v / 16;
  }
  const q: BakedQuad = { pos, uv: uvs, tex, shade: shade ? SHADE[f] : 1, cull: f };
  if (tint) q.tint = tint;
  return q;
}

function rotateElement(pos: Float32Array, r: NonNullable<ModelElement["rotation"]>): void {
  const a = (r.angle * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const o = r.origin.map((v) => v / 16);
  const scale = r.rescale ? 1 / Math.cos(Math.abs(a)) : 1;
  for (let i = 0; i < 12; i += 3) {
    let x = pos[i]! - o[0]!, y = pos[i + 1]! - o[1]!, z = pos[i + 2]! - o[2]!;
    if (r.axis === "x") [y, z] = [y * c - z * s, y * s + z * c];
    else if (r.axis === "y") [x, z] = [x * c + z * s, -x * s + z * c];
    else [x, y] = [x * c - y * s, x * s + y * c];
    if (scale !== 1) {
      if (r.axis !== "x") x *= scale;
      if (r.axis !== "y") y *= scale;
      if (r.axis !== "z") z *= scale;
    }
    pos[i] = x + o[0]!;
    pos[i + 1] = y + o[1]!;
    pos[i + 2] = z + o[2]!;
  }
}

/** Blockstate rotation: x first, then y, in 90° steps about the block centre (matches rotateFace). */
function rotateBlock(pos: Float32Array, rx = 0, ry = 0): void {
  const sx = (((rx / 90) % 4) + 4) % 4, sy = (((ry / 90) % 4) + 4) % 4;
  for (let i = 0; i < 12; i += 3) {
    let x = pos[i]! - 0.5, y = pos[i + 1]! - 0.5, z = pos[i + 2]! - 0.5;
    for (let k = 0; k < sx; k++) [y, z] = [z, -y]; // up → north
    for (let k = 0; k < sy; k++) [x, z] = [-z, x]; // north → east
    pos[i] = x + 0.5;
    pos[i + 1] = y + 0.5;
    pos[i + 2] = z + 0.5;
  }
}

function normalOf(p: Float32Array): V3 {
  const ax = p[3]! - p[0]!, ay = p[4]! - p[1]!, az = p[5]! - p[2]!;
  const bx = p[9]! - p[0]!, by = p[10]! - p[1]!, bz = p[11]! - p[2]!;
  // TL→TR × TL→BL points into the block for this winding; flip for outward.
  let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= -len;
  ny /= -len;
  nz /= -len;
  return [nx, ny, nz];
}

export function shadeOf(p: Float32Array): number {
  const [nx, ny, nz] = normalOf(p);
  return Math.abs(nx) * 0.6 + Math.abs(nz) * 0.8 + (ny > 0 ? ny : -ny * 0.5);
}

/** True when the quad lies on a block face and spans the full 1×1 square. */
function coversFace(q: BakedQuad): boolean {
  const xs = [q.pos[0]!, q.pos[3]!, q.pos[6]!, q.pos[9]!];
  const ys = [q.pos[1]!, q.pos[4]!, q.pos[7]!, q.pos[10]!];
  const zs = [q.pos[2]!, q.pos[5]!, q.pos[8]!, q.pos[11]!];
  const span = (v: number[]) => Math.max(...v) - Math.min(...v);
  const flat = (v: number[]) => span(v) < 1e-4;
  const full = (v: number[]) => Math.min(...v) <= 1e-4 && Math.max(...v) >= 1 - 1e-4;
  if (flat(xs)) return full(ys) && full(zs);
  if (flat(ys)) return full(xs) && full(zs);
  if (flat(zs)) return full(xs) && full(ys);
  return false;
}
