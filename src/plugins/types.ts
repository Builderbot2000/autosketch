import type { BlockInfo, Registry } from "../assets/registry.js";

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
  /** Markdown explaining the mod's building concepts (exposed as a knowledge resource). */
  docs?: string;
}

export function activePlugins(all: readonly AutosketchPlugin[], registry: Registry): AutosketchPlugin[] {
  const present = registry.namespaces();
  return all.filter((p) => p.namespaces.some((ns) => present.has(ns)));
}
