import type { Face } from "../assets/models.js";
import { Image } from "../palette/image.js";
import type { BakedBlock, BlockBaker, Texture } from "../perception/render/bake.js";

/**
 * Textures and baked models for the viewer's 3D view (docs/design/12-observability.md,
 * `/assets/atlas.png` and `/assets/models.json`). Built at runtime from the user's own instance
 * through the same `BlockBaker` the rasterizer uses (02, *Legal stance*: nothing derived from game
 * assets is stored or committed; this lives in memory and is served to the local page only).
 *
 * The atlas grows as states are baked: textures are packed on shelves into a fixed-width sheet,
 * and an existing texture never moves. `models.json` gives UVs in atlas pixels plus the atlas
 * size and version, so a client re-fetches the PNG when the version changes.
 */

export const FACE_INDEX: Record<Face, number> = { down: 0, up: 1, north: 2, south: 3, west: 4, east: 5 };

export interface QuadJson {
  /** 4 corners (x, y, z) in block units, TL TR BR BL. */
  p: number[];
  /** Matching UVs in atlas pixels. */
  uv: number[];
  /** Tint × face shade, 0..1. */
  c: [number, number, number];
  /** Cull face index (FACE_INDEX), or -1. */
  cull: number;
  /** Drawn in the blended pass. */
  t?: 1;
}

export interface ModelJson {
  q: QuadJson[];
  /** Bit mask of faces (FACE_INDEX) covered by opaque geometry. */
  occ: number;
  /** No usable model (drawn as a placeholder). */
  fb?: 1;
}

export interface ModelsJson {
  atlas: { width: number; height: number; version: number };
  models: Record<string, ModelJson>;
}

export class Atlas {
  readonly width: number;
  height = 0;
  version = 0;
  private readonly rects = new Map<Texture, [number, number]>();
  private shelfX = 0;
  private shelfY = 0;
  private shelfH = 0;
  private placed: { tex: Texture; x: number; y: number }[] = [];
  private png?: { version: number; data: Buffer };

  constructor(width = 1024) {
    this.width = width;
  }

  /** Pixel position of a texture, packing it on first use. */
  add(tex: Texture): [number, number] {
    let r = this.rects.get(tex);
    if (r) return r;
    const w = Math.min(tex.img.width, this.width), h = tex.img.height;
    if (this.shelfX + w > this.width) {
      this.shelfY += this.shelfH;
      this.shelfX = 0;
      this.shelfH = 0;
    }
    r = [this.shelfX, this.shelfY];
    this.shelfX += w;
    this.shelfH = Math.max(this.shelfH, h);
    this.height = Math.max(this.height, this.shelfY + this.shelfH);
    this.rects.set(tex, r);
    this.placed.push({ tex, x: r[0], y: r[1] });
    this.version++;
    return r;
  }

  /** The sheet as PNG (height rounded up to a power of two, at least 16). Cached per version. */
  encode(): Buffer {
    if (this.png?.version === this.version) return this.png.data;
    const img = new Image(this.width, sheetHeight(this.height));
    for (const { tex, x, y } of this.placed) {
      const s = tex.img;
      for (let yy = 0; yy < s.height; yy++) {
        const row = s.data.subarray(yy * s.width * 4, (yy * s.width + Math.min(s.width, this.width - x)) * 4);
        img.data.set(row, ((y + yy) * this.width + x) * 4);
      }
    }
    this.png = { version: this.version, data: img.encodePng() };
    return this.png.data;
  }
}

const sheetHeight = (h: number): number => {
  let p = 16;
  while (p < h) p *= 2;
  return p;
};

/** Bakes each state into the atlas. A state that fails to bake is left out. */
export async function bakeModels(baker: BlockBaker, atlas: Atlas, states: readonly (readonly [number, string])[]): Promise<ModelsJson> {
  const models: Record<string, ModelJson> = {};
  for (const [id, state] of states) {
    if (state === "minecraft:air" || /(^|:)(cave_|void_)?air$/.test(state)) continue;
    const b = await baker.bake(state).catch(() => undefined);
    if (b) models[id] = modelJson(b, atlas);
  }
  return { atlas: { width: atlas.width, height: sheetHeight(atlas.height), version: atlas.version }, models };
}

function modelJson(b: BakedBlock, atlas: Atlas): ModelJson {
  let occ = 0;
  for (const f of b.occludes) occ |= 1 << FACE_INDEX[f];
  const q = b.quads.map((quad): QuadJson => {
    const [ax, ay] = atlas.add(quad.tex);
    const w = quad.tex.img.width, h = quad.tex.img.height;
    const uv: number[] = [];
    for (let i = 0; i < 4; i++) uv.push(round(ax + quad.uv[i * 2]! * w), round(ay + quad.uv[i * 2 + 1]! * h));
    const t = quad.tint ?? [255, 255, 255];
    const c: [number, number, number] = [round((t[0] / 255) * quad.shade), round((t[1] / 255) * quad.shade), round((t[2] / 255) * quad.shade)];
    return { p: Array.from(quad.pos, round), uv, c, cull: quad.cull ? FACE_INDEX[quad.cull] : -1, ...(quad.tex.translucent ? { t: 1 as const } : {}) };
  });
  return { q, occ, ...(b.fallback ? { fb: 1 as const } : {}) };
}

const round = (v: number): number => Math.round(v * 1e4) / 1e4;
