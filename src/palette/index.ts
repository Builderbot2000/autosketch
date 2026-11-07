import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { defaultCacheDir } from "../assets/cache.js";
import type { PackStack } from "../assets/pack.js";
import type { BlockInfo, Registry } from "../assets/registry.js";
import { mapLimit } from "../core/async.js";
import type { AutosketchPlugin, Category } from "../plugins/types.js";
import type { Lab, RGB } from "./color.js";
import { buildFamilies, type Family, type Series } from "./families.js";
import { combineStats, textureStats, TextureLoader, Tinter, type TextureStats } from "./textures.js";

export interface FamilyStats {
  rgb: RGB;
  lab: Lab;
  noise: number;
  translucency: number;
  light: number;
}

export interface PaletteIndexData {
  cacheVersion: number;
  fingerprint: string;
  families: Family[];
  series: Series[];
  stats: Record<string, FamilyStats>;
  looseCount: number;
}

const CACHE_VERSION = 4;

export const CATEGORY_ORDER: readonly Category[] = ["stone", "wood", "metal", "colored", "glass", "earth", "organic", "light", "decor"];

/** Families worth showing on the one-page overview: those a builder can do the most with. */
export function isArchitectural(f: Family): boolean {
  return !!(f.shapes.stairs || f.shapes.slab || f.series || f.variants.length >= 5 || Object.keys(f.extras).length);
}

/** The palette index: material families with colour statistics, plus lookups. */
export class PaletteIndex {
  readonly families: Map<string, Family>;
  readonly series: Map<string, Series>;
  /** Any member block id (base, shape, variant, alias, extra) → family id. */
  private readonly blockToFamily = new Map<string, string>();

  constructor(
    readonly data: PaletteIndexData,
    readonly registry: Registry,
  ) {
    this.families = new Map(data.families.map((f) => [f.id, f]));
    this.series = new Map(data.series.map((s) => [s.id, s]));
    for (const f of data.families) {
      const add = (id: string) => this.blockToFamily.set(id, f.id);
      add(f.base);
      Object.values(f.shapes).forEach(add);
      for (const v of f.variants) (add(v.base), Object.values(v.shapes).forEach(add));
      f.aliases.forEach(add);
      Object.values(f.extras).flat().forEach(add);
    }
  }

  family(id: string): Family | undefined {
    return this.families.get(id);
  }
  familyOfBlock(blockId: string): Family | undefined {
    const f = this.blockToFamily.get(blockId);
    return f ? this.families.get(f) : undefined;
  }
  stats(familyId: string): FamilyStats | undefined {
    return this.data.stats[familyId];
  }
  buildable(): Family[] {
    return this.data.families.filter((f) => f.buildable);
  }
}

export interface PaletteOptions {
  plugins?: readonly AutosketchPlugin[];
  cacheDir?: string | false;
  concurrency?: number;
}

export async function loadPaletteIndex(stack: PackStack, registry: Registry, opts: PaletteOptions = {}): Promise<{ index: PaletteIndex; cached: boolean }> {
  const fingerprint = registry.data.fingerprint;
  const cacheDir = opts.cacheDir === false ? undefined : (opts.cacheDir ?? defaultCacheDir());
  const pluginKey = (opts.plugins ?? []).map((p) => p.id).join(",");
  const file = cacheDir && join(cacheDir, `palette-${fingerprint.slice(0, 16)}-${hashString(pluginKey)}.json.gz`);
  if (file) {
    try {
      const data = JSON.parse(gunzipSync(await readFile(file)).toString("utf8")) as PaletteIndexData;
      if (data.cacheVersion === CACHE_VERSION && data.fingerprint === fingerprint) return { index: new PaletteIndex(data, registry), cached: true };
    } catch {
      /* miss */
    }
  }
  const data = await buildPaletteIndexData(stack, registry, opts);
  if (file) {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, gzipSync(JSON.stringify(data)));
    await rename(tmp, file);
  }
  return { index: new PaletteIndex(data, registry), cached: false };
}

export async function buildPaletteIndexData(stack: PackStack, registry: Registry, opts: PaletteOptions = {}): Promise<PaletteIndexData> {
  const { families, series, looseCount } = buildFamilies(registry, opts.plugins ?? []);
  const textures = new TextureLoader(stack);
  const tinter = new Tinter(textures);
  await tinter.init();

  const stats: Record<string, FamilyStats> = {};
  await mapLimit(
    families.filter((f) => f.buildable),
    opts.concurrency ?? 32,
    async (f) => {
      const b = registry.get(f.base);
      if (!b) return;
      const s = await blockStats(b, textures, tinter);
      if (s) stats[f.id] = { rgb: s.rgb, lab: s.lab.map((v) => Math.round(v * 10) / 10) as Lab, noise: round1(s.noise), translucency: round1(s.translucency), light: b.light ?? 0 };
    },
  );
  return { cacheVersion: CACHE_VERSION, fingerprint: registry.data.fingerprint, families, series, stats, looseCount };
}

/** Colour of a block as seen in a wall: sides weigh twice the top. */
export async function blockStats(b: BlockInfo, textures: TextureLoader, tinter: Tinter): Promise<TextureStats | undefined> {
  const top = b.faceTextures.up;
  const side = b.faceTextures.north ?? b.faceTextures.south ?? b.faceTextures.east ?? top;
  const parts: { stats: TextureStats; weight: number }[] = [];
  const tint = b.tinted ? tinter.tintFor(b.id) : undefined;
  const tintAll = !!tint && !/grass_block|_grass$|turf|sod/.test(b.id); // grass blocks tint only the top
  for (const [tex, weight, isTop] of [[side, 2, false], [top, 1, true]] as const) {
    if (!tex) continue;
    const img = await textures.load(tex);
    if (img) parts.push({ stats: textureStats(img, tint && (isTop || tintAll) ? tint : undefined), weight });
  }
  return parts.length ? combineStats(parts) : undefined;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

function hashString(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}
