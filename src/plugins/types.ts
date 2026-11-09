import type { BlockInfo, Registry } from "../assets/registry.js";
import type { RenderHook } from "../assets/builtin-models/index.js";
import type { Box } from "../core/region.js";
import type { Mask } from "../core/mask.js";
import type { Document, EditResult, Transaction } from "../document/document.js";
import type { Compound } from "prismarine-nbt";
import type { z } from "zod";
import type { StateOverride } from "../core/rotate.js";

export type Category = "stone" | "wood" | "earth" | "organic" | "metal" | "colored" | "glass" | "light" | "decor";

/**
 * A family declared by a plugin (09, `families`; 03, "Group into families"). Applied after the
 * generic grouping: the base heads a family even when it is a partial block (Create girders), and
 * the listed blocks move into it. Unknown ids are ignored, so hints can be written for every
 * version of a mod.
 */
export interface FamilyHint {
  /** Head of the family. */
  base: string;
  /** Shape kind (03: stairs, slab, wall, fence, fence_gate, door, trapdoor, pane, button, pressure_plate, vertical_slab) → block id. */
  shapes?: Record<string, string>;
  /** Decorative variants: blocks (or the bases of other families) that join this family. */
  variants?: string[];
  category?: Category;
  buildable?: boolean;
}

/** A shape group as plugin actions see it (structurally a palette `ShapeGroup`, 03). */
export interface VariantGroupView {
  base: string;
  shapes: Partial<Record<string, string>>;
}

/** A material family as plugin actions see it (structurally a palette `Family`, 03). */
export interface FamilyView extends VariantGroupView {
  id: string;
  variants: VariantGroupView[];
}

/**
 * What a plugin action runs against (05: ops go through the document API, so they are journaled
 * and undoable). Built by `ops/plugin-actions.ts`, which owns selection resolution and the op
 * pipeline, so plugins never import `ops/` (ARCHITECTURE, dependency rules).
 */
export interface PluginActionContext {
  doc: Document;
  registry?: Registry;
  /** Active plugins. */
  plugins: readonly AutosketchPlugin[];
  /** Resolves a selection expression (05) to the region it covers. */
  region(sel: unknown): Box | Mask;
  /**
   * Runs the action's writes as one journal entry named after the op, with auto-connection unless
   * the caller passed `raw` (05). A script runner may substitute its own transaction (silo C).
   */
  edit<T>(summary: string, body: (tx: Transaction) => T): EditResult;
  /** A block matcher as `replace` uses it: "*", "#tag", "id" or "id[props]". */
  matcher(spec: string): (state: string) => boolean;
  /** The palette family a block belongs to, when a palette is loaded. */
  family?(blockId: string): FamilyView | undefined;
  /** Tag namespaces that group decorative variants (plugin-declared plus detected, 03). */
  variantNamespaces: readonly string[];
}

/** An agent-facing op registered as "<plugin id>.<name>" (09, `actions`; 05, `ops_list`). */
export interface PluginAction {
  /** Shown in ops_list; includes token cost and side effects. */
  description: string;
  params: z.ZodType;
  /** Must edit through `doc.edit(...)`, so the action is one journal entry. */
  run(ctx: PluginActionContext, args: unknown): EditResult | Promise<EditResult>;
}

/**
 * Mod-compatibility plugin (docs/design/09-mod-compat.md). Every field but `id` and `namespaces`
 * is optional: a plugin only answers for what generic data can't express.
 */
export interface AutosketchPlugin {
  id: string;
  /** Active when any of these namespaces has blocks in the registry. */
  namespaces: string[];
  /** Mod versions (semver range) the plugin's hard-coded knowledge was written against. */
  modVersions?: string;
  /**
   * Part of the palette cache key besides `id`. Set by the third-party loader to a hash of the
   * plugin file, so editing a plugin invalidates cached palettes.
   */
  cacheKey?: string;
  /**
   * Tag namespaces whose tags name a base block and list its decorative variants
   * (e.g. `chipped:andesite` → every Chipped andesite pattern, grouped under minecraft:andesite).
   */
  variantTagNamespaces?: string[];
  /** Overrides for palette classification. Return undefined to leave a block to the generic rules. */
  classify?(block: BlockInfo): { category?: Category; buildable?: boolean } | undefined;
  /** Families the generic grouping can't find (03), read from the instance's registry. */
  families?(registry: Registry): FamilyHint[];
  /**
   * Draws a block whose look comes from code or NBT (02, 06). Called with `pos`/`nbt` undefined
   * when a state is baked on its own. Return null to leave the block to its JSON model.
   */
  render?: RenderHook;
  /**
   * Items needed to place a block in survival (08: Create material list), e.g. a framed block plus
   * its camo item. Return undefined to leave the block to the vanilla rules.
   */
  items?(state: string, nbt: Compound | undefined): { item: string; count: number }[] | undefined;
  /** Warnings about a block entity's NBT (e.g. a camo block that doesn't exist in this instance). */
  validateNbt?(state: string, nbt: Compound | undefined): string[];
  /** Agent actions, registered as "<opNamespace>.<name>" ops. */
  actions?: Record<string, PluginAction>;
  /** Prefix of this plugin's op names (09: `framed.shape` for the `framedblocks` plugin). Default: `id`. */
  opNamespace?: string;
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
  /**
   * Multi-block structures this plugin declares (11, Whole blocks only): the offsets of the other
   * positions a state belongs with (e.g. [[0,1,0]] for the lower half of a two-block machine), or
   * undefined when the state is a single block. Sandbox forks extend volumes over them.
   */
  multiBlock?: { partners(state: string): [number, number, number][] | undefined };
  /**
   * Block-entity NBT that changes on its own while the game runs (13, *Hashing*, volatile keys):
   * block-entity type id (or "*") → key paths to ignore when the live link compares NBT ("/"
   * between nested compound keys), or "state_only" to never compare that type's NBT. Merged with
   * the built-in list as a union per type and sent to the mod in the bridge hello.
   */
  volatileKeys?: Record<string, string[] | "state_only">;
  /** Markdown explaining the mod's building concepts (exposed as a knowledge resource). */
  docs?: string;
}

export function activePlugins(all: readonly AutosketchPlugin[], registry: Registry): AutosketchPlugin[] {
  const present = registry.namespaces();
  return all.filter((p) => p.namespaces.some((ns) => present.has(ns)));
}

/** Warnings from every plugin that checks this block's NBT, prefixed with the plugin id. */
export function validateNbt(plugins: readonly AutosketchPlugin[], state: string, nbt: Compound | undefined): string[] {
  const out: string[] = [];
  for (const p of plugins) {
    if (!p.validateNbt) continue;
    try {
      for (const w of p.validateNbt(state, nbt)) out.push(`${p.id}: ${w}`);
    } catch (e) {
      out.push(`${p.id}: validateNbt failed (${(e as Error).message})`);
    }
  }
  return out;
}

/**
 * `validateNbt` over every block entity of a document (09), condensed: at most `limit` distinct
 * warnings plus a count of the rest. Called on import and export, where NBT enters or leaves.
 */
export function documentNbtWarnings(plugins: readonly AutosketchPlugin[], doc: Document, limit = 5): string[] {
  if (!doc.blockEntities.size || !plugins.some((p) => p.validateNbt)) return [];
  const seen = new Map<string, number>();
  for (const [key, nbt] of doc.blockEntities) {
    const [sx, sy, sz] = key.split(",").map(Number) as [number, number, number];
    const state = doc.states.get(doc.voxels.get(sx, sy, sz));
    for (const w of validateNbt(plugins, state, nbt)) seen.set(w, (seen.get(w) ?? 0) + 1);
  }
  const all = [...seen];
  const out = all.slice(0, limit).map(([w, n]) => (n > 1 ? `${w} (${n} blocks)` : w));
  if (all.length > limit) out.push(`… ${all.length - limit} more block-entity warnings`);
  return out;
}
