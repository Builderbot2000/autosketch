import type { Registry } from "../assets/registry.js";
import { AIR, formatState, parseState } from "../core/blockstate.js";
import { importState, type Snapshot } from "./snapshot.js";

/**
 * Block renames between DataVersions, applied on import when a file is older than the instance
 * (docs/design/08-formats.md, Import). A small table of vanilla renames since the 1.13 flattening,
 * not a DataFixerUpper port: property changes (wall sides, redstone) are not upgraded.
 */

export interface BlockRename {
  /** First DataVersion with the new name. */
  dataVersion: number;
  from: string;
  /** New id, or a function of the old properties when the rename depends on them. */
  to: string | ((props: Record<string, string>) => { id: string; props: Record<string, string> });
}

export const BLOCK_RENAMES: readonly BlockRename[] = [
  // 1.14 (19w02a): signs gained wood types; the old stone slab became the smooth stone slab.
  { dataVersion: 1952, from: "minecraft:sign", to: "minecraft:oak_sign" },
  { dataVersion: 1952, from: "minecraft:wall_sign", to: "minecraft:oak_wall_sign" },
  { dataVersion: 1952, from: "minecraft:stone_slab", to: "minecraft:smooth_stone_slab" },
  // 1.17: grass paths became dirt paths; filled cauldrons became their own blocks.
  { dataVersion: 2724, from: "minecraft:grass_path", to: "minecraft:dirt_path" },
  {
    dataVersion: 2724,
    from: "minecraft:cauldron",
    to: (props) => {
      const { level, ...rest } = props;
      return level && level !== "0" ? { id: "minecraft:water_cauldron", props: { ...rest, level } } : { id: "minecraft:cauldron", props: rest };
    },
  },
  // 1.20.3: grass became short grass.
  { dataVersion: 3698, from: "minecraft:grass", to: "minecraft:short_grass" },
];

/**
 * Applies every rename that happened after `from` and at or before `to` (DataVersions). Returns
 * the state unchanged when nothing applies, or when either version is unknown (0).
 */
export function renameState(state: string, from: number, to: number, table: readonly BlockRename[] = BLOCK_RENAMES): string {
  if (!from || !to || from >= to) return state;
  let parsed;
  try {
    parsed = parseState(state);
  } catch {
    return state;
  }
  let { id, props } = parsed;
  let changed = false;
  for (const r of table) {
    if (r.dataVersion <= from || r.dataVersion > to || r.from !== id) continue;
    if (typeof r.to === "string") id = r.to;
    else ({ id, props } = r.to(props));
    changed = true;
  }
  return changed ? formatState(id, props) : state;
}

/**
 * Renames a decoded snapshot's palette from its DataVersion to `to`, then canonicalises it
 * against the registry, merging entries that became equal. Decoders run without a registry
 * when this follows, so unknown-block warnings reflect the renamed ids.
 */
export function upgradeSnapshot(s: Snapshot, to: number | undefined, registry: Registry | undefined): { warnings: string[]; renamed: string[] } {
  const warnings = new Set<string>();
  const renamed = new Set<string>();
  const palette = [AIR];
  const byState = new Map([[AIR, 0]]);
  const remap = s.palette.map((raw, i) => {
    if (i === 0) return 0;
    const next = to ? renameState(raw, s.dataVersion, to) : raw;
    if (next !== raw) renamed.add(`${parseState(raw).id} → ${parseState(next).id}`);
    const st = importState(next, registry, warnings);
    let p = byState.get(st);
    if (p === undefined) {
      p = palette.length;
      palette.push(st);
      byState.set(st, p);
    }
    return p;
  });
  if (remap.some((p, i) => p !== i) || palette.length !== s.palette.length) for (let i = 0; i < s.blocks.length; i++) s.blocks[i] = remap[s.blocks[i]!]!;
  s.palette = palette;
  return { warnings: [...warnings], renamed: [...renamed] };
}
