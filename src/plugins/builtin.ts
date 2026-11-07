import { create, createdeco } from "./create.js";
import type { AutosketchPlugin } from "./types.js";

/** Decorative-variant mods: their tags group every pattern under the base block. */
const chipped: AutosketchPlugin = {
  id: "chipped",
  namespaces: ["chipped"],
  variantTagNamespaces: ["chipped"],
  docs: "Chipped adds dozens of decorative patterns per vanilla block, converted with its workbenches. Autosketch groups them as variants of the base material.",
};

const rechiseled: AutosketchPlugin = {
  id: "rechiseled",
  namespaces: ["rechiseled"],
  variantTagNamespaces: ["rechiseled"],
  docs: "Rechiseled adds chiselled patterns (with stairs and slabs) per vanilla block, plus connected-texture copies (`_connecting`). Autosketch groups patterns as variants and folds connecting copies into them.",
};

const chisel: AutosketchPlugin = {
  id: "chisel",
  namespaces: ["chisel"],
  variantTagNamespaces: ["chisel"],
};

/**
 * Camo-shape mods: their blocks take their look from another block stored in NBT, so their own
 * textures are placeholders. They are building *shapes*, exposed through plugin actions, not materials.
 */
const framedblocks: AutosketchPlugin = {
  id: "framedblocks",
  namespaces: ["framedblocks"],
  classify: () => ({ buildable: false }),
};

const copycats: AutosketchPlugin = {
  id: "copycats",
  namespaces: ["copycats"],
  classify: () => ({ buildable: false }),
};

/**
 * Litematica (and its NeoForge stub) registers `*_fallback` blocks that stand in for unknown blocks
 * in its schematic preview. They don't exist on a server, so they are never materials.
 */
const litematica: AutosketchPlugin = {
  id: "litematica",
  namespaces: ["litematica"],
  classify: () => ({ buildable: false }),
};

export const BUILTIN_PLUGINS: readonly AutosketchPlugin[] = [chipped, rechiseled, chisel, framedblocks, copycats, litematica, create, createdeco];
