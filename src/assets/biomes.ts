/**
 * Biome climate for colormapped blocks (docs/design/02-assets-registry.md, Model resolution:
 * "tintindex faces use the grass/foliage colormaps at a configurable default biome (plains)").
 * Temperature and downfall of the vanilla 1.21 overworld biomes, plus the biomes whose grass or
 * foliage colour is fixed or modified in code. Values are game facts, not assets.
 */

export interface BiomeClimate {
  temperature: number;
  downfall: number;
  /** Fixed colours that replace the colormap lookup. */
  grass?: [number, number, number];
  foliage?: [number, number, number];
  /** Dark forest: grass is averaged with this colour. */
  grassBlend?: [number, number, number];
}

export const DEFAULT_TINT_BIOME = "plains";

const c = (temperature: number, downfall: number, extra: Partial<BiomeClimate> = {}): BiomeClimate => ({ temperature, downfall, ...extra });
const BADLANDS = { grass: [0x90, 0x81, 0x4d], foliage: [0x9e, 0x81, 0x4d] } satisfies Partial<BiomeClimate>;
// Swamp grass alternates between two colours by noise in game; we take the drier one.
const SWAMP = { grass: [0x6a, 0x70, 0x39] as [number, number, number], foliage: [0x6a, 0x70, 0x39] as [number, number, number] };

export const BIOME_CLIMATES: Record<string, BiomeClimate> = {
  plains: c(0.8, 0.4),
  sunflower_plains: c(0.8, 0.4),
  snowy_plains: c(0, 0.5),
  ice_spikes: c(0, 0.5),
  desert: c(2, 0),
  swamp: c(0.8, 0.9, SWAMP),
  mangrove_swamp: c(0.8, 0.9, { grass: SWAMP.grass, foliage: [0x8d, 0xb1, 0x27] }),
  forest: c(0.7, 0.8),
  flower_forest: c(0.7, 0.8),
  birch_forest: c(0.6, 0.6),
  old_growth_birch_forest: c(0.6, 0.6),
  dark_forest: c(0.7, 0.8, { grassBlend: [0x28, 0x34, 0x0a] }),
  taiga: c(0.25, 0.8),
  snowy_taiga: c(-0.5, 0.4),
  old_growth_pine_taiga: c(0.3, 0.8),
  old_growth_spruce_taiga: c(0.25, 0.8),
  savanna: c(2, 0),
  savanna_plateau: c(2, 0),
  windswept_hills: c(0.2, 0.3),
  windswept_forest: c(0.2, 0.3),
  windswept_gravelly_hills: c(0.2, 0.3),
  windswept_savanna: c(2, 0),
  jungle: c(0.95, 0.9),
  sparse_jungle: c(0.95, 0.8),
  bamboo_jungle: c(0.95, 0.9),
  badlands: c(2, 0, BADLANDS),
  eroded_badlands: c(2, 0, BADLANDS),
  wooded_badlands: c(2, 0, BADLANDS),
  meadow: c(0.5, 0.8),
  cherry_grove: c(0.5, 0.8),
  grove: c(-0.2, 0.8),
  snowy_slopes: c(-0.3, 0.9),
  frozen_peaks: c(-0.7, 0.9),
  jagged_peaks: c(-0.7, 0.9),
  stony_peaks: c(1, 0.3),
  river: c(0.5, 0.5),
  frozen_river: c(0, 0.5),
  beach: c(0.8, 0.4),
  snowy_beach: c(0.05, 0.3),
  stony_shore: c(0.2, 0.3),
  ocean: c(0.5, 0.5),
  deep_ocean: c(0.5, 0.5),
  warm_ocean: c(0.5, 0.5),
  lukewarm_ocean: c(0.5, 0.5),
  deep_lukewarm_ocean: c(0.5, 0.5),
  cold_ocean: c(0.5, 0.5),
  deep_cold_ocean: c(0.5, 0.5),
  frozen_ocean: c(0, 0.5),
  deep_frozen_ocean: c(0, 0.5),
  mushroom_fields: c(0.9, 1),
  dripstone_caves: c(0.8, 0.4),
  lush_caves: c(0.5, 0.5),
  deep_dark: c(0.8, 0.4),
};

/** Looks up a biome by name (`plains` or `minecraft:plains`); throws listing the known ones. */
export function biomeClimate(name: string = DEFAULT_TINT_BIOME): BiomeClimate {
  const key = name.trim().toLowerCase().replace(/^minecraft:/, "");
  const b = BIOME_CLIMATES[key];
  if (!b) throw new Error(`unknown tint biome "${name}" (known: ${Object.keys(BIOME_CLIMATES).join(", ")})`);
  return b;
}

/**
 * Pixel of a 256×256-style colormap for a climate, as the game computes it: temperature and
 * downfall clamped to 0..1, downfall scaled by temperature, x = (1 − t)·(w − 1), y = (1 − d)·(h − 1).
 */
export function colormapPixel(b: BiomeClimate, width: number, height: number): [number, number] {
  const t = Math.min(1, Math.max(0, b.temperature));
  const d = Math.min(1, Math.max(0, b.downfall)) * t;
  return [Math.min(width - 1, Math.round((1 - t) * (width - 1))), Math.min(height - 1, Math.round((1 - d) * (height - 1)))];
}
