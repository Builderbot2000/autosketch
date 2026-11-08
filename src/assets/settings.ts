import { parseList, parseText, setting } from "../core/settings.js";

/**
 * Asset settings (docs/design/02-assets-registry.md). Each keeps the flag and environment
 * variable it had before the settings module (`--mod-order`, `AUTOSKETCH_MOD_ORDER`, …), and also
 * takes `--set <key>=<value>`.
 */

/** Pinned mod order (02, Pack VFS): jar names, name stems or globs; the last entry wins. */
export const MOD_ORDER = setting<string[] | undefined>("modOrder", undefined, "a comma-separated list of jar names, name stems or * globs", parseList, { flag: "mod-order" });

/** Biome for grass/foliage tints (02, Tint). Checked against the known biomes at instance load. */
export const TINT_BIOME = setting<string | undefined>("tintBiome", undefined, "a biome name such as plains, jungle or minecraft:swamp", parseText, { flag: "tint-biome" });
