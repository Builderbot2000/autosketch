import type { BlockInfo, Registry } from "../assets/registry.js";
import type { Compound } from "prismarine-nbt";
import type { StateOverride } from "../core/rotate.js";

export type Category = "stone" | "wood" | "earth" | "organic" | "metal" | "colored" | "glass" | "light" | "decor";

/**
 * Mod-compatibility plugin (docs/design/09-mod-compat.md). This is the subset used by palette
 * ingestion; render hooks and agent actions are added with the components that use them.
 */
export interface AutosketchPlugin {
  id: string;
  /** Active when any of these namespaces has blocks in the registry. */
  namespaces: string[];
  /**
   * Tag namespaces whose tags name a base block and list its decorative variants
   * (e.g. `chipped:andesite` → every Chipped andesite pattern, grouped under minecraft:andesite).
   */
  variantTagNamespaces?: string[];
  /** Overrides for palette classification. Return undefined to leave a block to the generic rules. */
  classify?(block: BlockInfo): { category?: Category; buildable?: boolean } | undefined;
  /**
   * Items needed to place a block in survival (08: Create material list), e.g. a framed block plus
   * its camo item. Return undefined to leave the block to the vanilla rules.
   */
  items?(state: string, nbt: Compound | undefined): { item: string; count: number }[] | undefined;
  /**
   * State remapping override for rotate/mirror (01, Orientation). Called once per elementary step
   * (a rotation or a mirror); return the transformed state, or undefined for the generic rules.
   */
  rotate?: StateOverride;
  /**
   * Connecting blocks this plugin declares (05, Auto-connection): `handles` picks the states, and
   * `update` derives the connection properties from neighbours (`at(dx,dy,dz)` reads a state
   * relative to the block). Called after every non-raw op for written blocks and their neighbours.
   */
  connection?: {
    handles(state: string): boolean;
    update(state: string, at: (dx: number, dy: number, dz: number) => string): string;
  };
  /** Markdown explaining the mod's building concepts (exposed as a knowledge resource). */
  docs?: string;
}

export function activePlugins(all: readonly AutosketchPlugin[], registry: Registry): AutosketchPlugin[] {
  const present = registry.namespaces();
  return all.filter((p) => p.namespaces.some((ns) => present.has(ns)));
}
