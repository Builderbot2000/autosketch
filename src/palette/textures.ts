import { texturePath } from "../assets/models.js";
import type { PackStack } from "../assets/pack.js";
import { rgbToLab, type Lab, type RGB } from "./color.js";
import { Image } from "./image.js";

/** Per-texture statistics used for colour indexing and sorting. */
export interface TextureStats {
  /** Mean colour of opaque-ish pixels (alpha-weighted), in sRGB and CIELAB. */
  rgb: RGB;
  lab: Lab;
  /** Fraction of pixels with alpha > 0. */
  coverage: number;
  /** Fraction of pixels that are partially transparent (glass, ice). */
  translucency: number;
  /** Mean absolute lightness difference between neighbouring pixels (0 = flat, ~20+ = busy). */
  noise: number;
}

/** Loads block textures from the stack: first animation frame only, cached per texture id. */
export class TextureLoader {
  private readonly cache = new Map<string, Promise<Image | undefined>>();
  constructor(private readonly stack: PackStack) {}

  load(id: string): Promise<Image | undefined> {
    let p = this.cache.get(id);
    if (!p) {
      p = this.doLoad(id).catch(() => undefined);
      this.cache.set(id, p);
    }
    return p;
  }

  private async doLoad(id: string): Promise<Image | undefined> {
    const path = texturePath(id);
    const buf = await this.stack.read(path);
    if (!buf) return undefined;
    const img = Image.decodePng(buf);
    // Animated textures stack frames vertically; keep the first square frame.
    if (img.height > img.width && img.height % img.width === 0) return img.crop(0, 0, img.width, img.width);
    return img;
  }
}

export function textureStats(img: Image, tint?: RGB): TextureStats {
  const { width: w, height: h, data } = img;
  let r = 0, g = 0, b = 0, wsum = 0, covered = 0, partial = 0;
  const L = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = data[i * 4 + 3]! / 255;
    let pr = data[i * 4]!, pg = data[i * 4 + 1]!, pb = data[i * 4 + 2]!;
    if (tint) {
      pr = (pr * tint[0]) / 255;
      pg = (pg * tint[1]) / 255;
      pb = (pb * tint[2]) / 255;
    }
    if (a > 0) covered++;
    if (a > 0 && a < 0.95) partial++;
    r += pr * a;
    g += pg * a;
    b += pb * a;
    wsum += a;
    L[i] = a > 0 ? 0.2126 * pr + 0.7152 * pg + 0.0722 * pb : NaN;
  }
  const rgb: RGB = wsum > 0 ? [Math.round(r / wsum), Math.round(g / wsum), Math.round(b / wsum)] : [0, 0, 0];

  // Local contrast in lightness (perceptual-ish 0–100 scale).
  let diff = 0, n = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = L[y * w + x]!;
      if (Number.isNaN(v)) continue;
      if (x + 1 < w && !Number.isNaN(L[y * w + x + 1]!)) (diff += Math.abs(v - L[y * w + x + 1]!)), n++;
      if (y + 1 < h && !Number.isNaN(L[(y + 1) * w + x]!)) (diff += Math.abs(v - L[(y + 1) * w + x]!)), n++;
    }
  return {
    rgb,
    lab: rgbToLab(rgb),
    coverage: covered / (w * h),
    translucency: covered ? partial / covered : 0,
    noise: n ? ((diff / n) * 100) / 255 : 0,
  };
}

/** Combines face stats (e.g. top + side) by weight, averaging in linear-ish RGB space. */
export function combineStats(parts: { stats: TextureStats; weight: number }[]): TextureStats {
  const total = parts.reduce((s, p) => s + p.weight, 0) || 1;
  const avg = (fn: (s: TextureStats) => number) => parts.reduce((s, p) => s + fn(p.stats) * p.weight, 0) / total;
  const rgb: RGB = [Math.round(avg((s) => s.rgb[0])), Math.round(avg((s) => s.rgb[1])), Math.round(avg((s) => s.rgb[2]))];
  return { rgb, lab: rgbToLab(rgb), coverage: avg((s) => s.coverage), translucency: avg((s) => s.translucency), noise: avg((s) => s.noise) };
}

// ---------------------------------------------------------------------------------------------
// Tinting
// ---------------------------------------------------------------------------------------------

const FIXED_TINTS: [RegExp, RGB][] = [
  [/(^|:)spruce_leaves$/, [0x61, 0x99, 0x61]],
  [/(^|:)birch_leaves$/, [0x80, 0xa7, 0x55]],
  [/water/, [0x3f, 0x76, 0xe4]],
  [/(^|:)lily_pad$/, [0x20, 0x80, 0x30]],
];

/** Minecraft's dye colours (DyeColor texture diffuse colours). Two-word names first. */
export const DYE_COLORS: [string, RGB][] = [
  ["light_blue", [0x3a, 0xb3, 0xda]], ["light_gray", [0x9d, 0x9d, 0x97]],
  ["white", [0xf9, 0xff, 0xfe]], ["orange", [0xf9, 0x80, 0x1d]], ["magenta", [0xc7, 0x4e, 0xbd]],
  ["yellow", [0xfe, 0xd8, 0x3d]], ["lime", [0x80, 0xc7, 0x1f]], ["pink", [0xf3, 0x8b, 0xaa]],
  ["gray", [0x47, 0x4f, 0x52]], ["cyan", [0x16, 0x9c, 0x9c]], ["purple", [0x89, 0x32, 0xb8]],
  ["blue", [0x3c, 0x44, 0xaa]], ["brown", [0x83, 0x54, 0x32]], ["green", [0x5e, 0x7c, 0x16]],
  ["red", [0xb0, 0x2e, 0x26]], ["black", [0x1d, 0x1d, 0x21]],
];

/**
 * Tint for a block's tinted faces at a default biome (plains). Reads the instance's own colormaps,
 * so resource packs that recolour grass/foliage are respected.
 */
export class Tinter {
  private grass?: RGB;
  private foliage?: RGB;
  constructor(private readonly textures: TextureLoader) {}

  async init(): Promise<void> {
    // Plains: temperature 0.8, downfall 0.4 → colormap coordinates.
    const sample = async (id: string, fallback: RGB): Promise<RGB> => {
      const img = await this.textures.load(id);
      if (!img) return fallback;
      const t = 0.8, d = 0.4 * t;
      const x = Math.min(img.width - 1, Math.round((1 - t) * (img.width - 1)));
      const y = Math.min(img.height - 1, Math.round((1 - d) * (img.height - 1)));
      const [r, g, b] = img.get(x, y);
      return [r, g, b];
    };
    this.grass = await sample("minecraft:colormap/grass", [0x91, 0xbd, 0x59]);
    this.foliage = await sample("minecraft:colormap/foliage", [0x77, 0xab, 0x2f]);
  }

  /**
   * Tint for a block's tinted faces, or undefined when we can't know it (mods often tint in code).
   * Plants use the biome colormaps; dye-named blocks use the dye colour.
   */
  tintFor(blockId: string): RGB | undefined {
    for (const [re, c] of FIXED_TINTS) if (re.test(blockId)) return c;
    if (/leaves|vine|foliage/.test(blockId)) return this.foliage ?? [0x77, 0xab, 0x2f];
    if (/grass|fern|moss|lily|sugar_cane|hedge|bush|turf|sod/.test(blockId)) return this.grass ?? [0x91, 0xbd, 0x59];
    const path = blockId.slice(blockId.indexOf(":") + 1);
    for (const [dye, c] of DYE_COLORS) if (new RegExp(`(^|_)${dye}($|_)`).test(path)) return c;
    return undefined;
  }
}
