import type { Compound } from "prismarine-nbt";
import type { ModelElement, Props } from "../models.js";
import type { Registry } from "../registry.js";
import { bannerModel, signModel } from "./boards.js";
import { chestModel, shulkerModel } from "./containers.js";
import { bedModel, bellModel } from "./furniture.js";
import { headModel } from "./heads.js";

/**
 * Hand-written fallback models for blocks the game draws in code (docs/design/02-assets-registry.md,
 * "Code-drawn blocks"): chests, signs, beds, banners, heads, shulker boxes and bells. Their JSON
 * models carry only a particle texture. These models are original geometry; they reference the
 * instance's own (entity) textures by id, so nothing from the game is shipped. A texture the
 * instance lacks is replaced by the block's particle texture at bake time.
 */

/** Elements in model units, turned as a whole by a blockstate-style rotation (90° steps). */
export interface CodeModelPart {
  elements: ModelElement[];
  x?: number;
  y?: number;
}

export interface CodeModel {
  parts: CodeModelPart[];
  /** Drawn on top of the block's JSON geometry instead of replacing it (the bell inside its frame). */
  overlay?: boolean;
  /** Block id whose tint applies to tinted faces (a camo block's), instead of the drawn block's. */
  tintFrom?: string;
}

/**
 * What a render hook gets besides the block (09, `render`): the registry, and the JSON model of any
 * block state as code-model parts, so a hook can reshape or re-skin it (e.g. a camo block's look).
 */
export interface RenderContext {
  registry: Registry | undefined;
  jsonModel(state: string): Promise<CodeModelPart[]>;
}

/** A render hook: `pos` and `nbt` are undefined when a state is baked without a placed block. Null/undefined = not handled. */
export type RenderHook = (
  pos: [number, number, number] | undefined,
  state: string,
  nbt: Compound | undefined,
  ctx: RenderContext,
) => CodeModel | null | undefined | Promise<CodeModel | null | undefined>;

/** Which code-drawn kind a block id is, by its path. */
export function codeDrawnKind(id: string): "chest" | "shulker" | "bed" | "sign" | "banner" | "head" | "bell" | undefined {
  const path = id.slice(id.indexOf(":") + 1);
  if (/(^|_)chest$/.test(path)) return "chest";
  if (/(^|_)shulker_box$/.test(path)) return "shulker";
  if (/_bed$/.test(path)) return "bed";
  if (/_sign$/.test(path)) return "sign";
  if (/_banner$/.test(path)) return "banner";
  if (/_(skull|head)$/.test(path)) return "head";
  if (path === "bell") return "bell";
  return undefined;
}

/**
 * The built-in model for a code-drawn block state, or undefined. The baker uses it only when the
 * block's JSON model has no geometry (or, for `overlay` models, on top of it), so resource packs
 * and mods that ship real geometry always win.
 */
export function builtinModel(id: string, props: Props): CodeModel | undefined {
  const i = id.indexOf(":");
  const ns = i < 0 ? "minecraft" : id.slice(0, i);
  const path = id.slice(i + 1);
  switch (codeDrawnKind(id)) {
    case "chest": return chestModel(ns, path, props);
    case "shulker": return shulkerModel(ns, path);
    case "bed": return bedModel(ns, path, props);
    case "sign": return signModel(ns, path, props);
    case "banner": return bannerModel(ns, path, props);
    case "head": return headModel(ns, path, props);
    case "bell": return bellModel(ns, props);
    default: return undefined;
  }
}
