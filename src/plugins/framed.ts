import type { Compound } from "prismarine-nbt";
import { stateId } from "../core/blockstate.js";
import { asComp, camoPlugin, nbtComp, nbtInt, nbtStr, stateFromNbt, stateToNbt, type CamoMod } from "./camo.js";
import type { AutosketchPlugin } from "./types.js";

/**
 * FramedBlocks and Copycats (09, "Built-in plugins"): shapes whose look is a camo block stored in
 * block-entity NBT. Neither mod documents its NBT, and no in-game samples are planned, so each
 * layout below is the best reading of the mod's public source, kept in one read and one write
 * function per mod and marked unverified in 09.
 */

// ---- FramedBlocks (layout unverified) ------------------------------------------------------------

/**
 * FramedBlocks 10.x (1.21): `FramedBlockEntity` saves its camo container under `camo` as
 * `{type: <camo container factory id>, state: <block state>}`; a block camo uses the factory
 * `framedblocks:block`. Double blocks keep a second camo under `camo_two`. The block-entity id is
 * `framedblocks:framed_tile`. Unverified (09).
 */
export function writeFramedCamo(_blockId: string, camo: string | undefined, prev: Compound | undefined): Compound {
  const v: Compound["value"] = { ...(prev?.value ?? {}) };
  if (!v.id) v.id = nbtStr("framedblocks:framed_tile");
  if (camo) v.camo = nbtComp({ type: nbtStr("framedblocks:block"), state: stateToNbt(camo) });
  else delete v.camo;
  return nbtComp(v);
}

/** Reads the camo written by `writeFramedCamo`, tolerating a bare state compound or `camo_state`. */
export function readFramedCamo(nbt: Compound): string | undefined {
  const c = asComp(nbt.value.camo);
  return stateFromNbt(c?.value.state) ?? stateFromNbt(c) ?? stateFromNbt(nbt.value.camo_state);
}

const framedMod: CamoMod = {
  pluginId: "framedblocks",
  prefix: "framed",
  label: "framed block",
  owns: (id) => id.startsWith("framedblocks:framed_"),
  shapeCandidates: (s) => [`framedblocks:${s.startsWith("framed_") ? s : `framed_${s}`}`, `framedblocks:${s}`],
  shapeName: (id) => id.slice(id.indexOf(":") + 1).replace(/^framed_/, ""),
  placeholder: "framedblocks:block/framed_block",
  jsonModelForEmpty: true,
  readCamo: readFramedCamo,
  writeCamo: writeFramedCamo,
  camoKeys: ["camo", "camo_state"],
};

export const framedblocks: AutosketchPlugin = {
  id: "framedblocks",
  namespaces: ["framedblocks"],
  modVersions: ">=10.0.0",
  classify: () => ({ buildable: false }),
  ...camoPlugin(framedMod, "camo"),
  docs:
    "FramedBlocks shapes (slopes, corners, panels, pillars, stairs…) take their look from a camo block stored in NBT, so one shape works with any material. " +
    'Place them with framed.shape({sel, shape:"slope", camo:"stone_bricks", state:"facing=east"}) and re-skin with framed.camo. ' +
    "A Create material list counts each as the frame plus its camo block.",
};

// ---- Copycats+ and Create copycats (layout unverified) -------------------------------------------

/**
 * Create's `CopycatBlockEntity` saves `Material` (a block state) and `Item` (the consumed item
 * stack, 1.21 form `{id, count}`); Copycats+ single-material blocks extend it. Copycats+
 * multi-state blocks keep per-part data under `material_data.<part>.material`: read, but not
 * written. Block-entity ids `create:copycat` and `copycats:copycat` are guesses. Unverified (09).
 */
export function writeCopycatCamo(blockId: string, camo: string | undefined, prev: Compound | undefined): Compound {
  const v: Compound["value"] = { ...(prev?.value ?? {}) };
  if (!v.id) v.id = nbtStr(blockId.startsWith("create:") ? "create:copycat" : "copycats:copycat");
  if (camo) {
    v.Material = stateToNbt(camo);
    v.Item = nbtComp({ id: nbtStr(stateId(camo)), count: nbtInt(1) });
  } else {
    delete v.Material;
    delete v.Item;
  }
  return nbtComp(v);
}

export function readCopycatCamo(nbt: Compound): string | undefined {
  const direct = stateFromNbt(nbt.value.Material);
  if (direct) return direct;
  for (const part of Object.values(asComp(nbt.value.material_data)?.value ?? {})) {
    const s = stateFromNbt(asComp(part)?.value.material);
    if (s && s !== "minecraft:air") return s;
  }
  return undefined;
}

const copycatMod: CamoMod = {
  pluginId: "copycats",
  prefix: "copycat",
  label: "copycat",
  owns: (id) => /^(copycats|create):copycat_/.test(id) && !id.endsWith("_base"),
  shapeCandidates: (s) => {
    const p = s.startsWith("copycat_") ? s : `copycat_${s}`;
    return [`copycats:${p}`, `create:${p}`];
  },
  shapeName: (id) => id.slice(id.indexOf(":") + 1).replace(/^copycat_/, ""),
  placeholder: "create:block/copycat_base",
  jsonModelForEmpty: false,
  readCamo: readCopycatCamo,
  writeCamo: writeCopycatCamo,
  camoKeys: ["Material", "material_data"],
};

export const copycats: AutosketchPlugin = {
  id: "copycats",
  namespaces: ["copycats"],
  modVersions: ">=3.0.0",
  classify: () => ({ buildable: false }),
  ...camoPlugin(copycatMod, "material"),
  docs:
    "Copycats+ (and Create's copycat panel and step) are shapes that copy a material block stored in NBT. " +
    'Place them with copycat.shape({sel, shape:"slope", material:"oak_planks"}) and re-skin with copycat.camo. Multi-part copycats (byte, layer stacks) keep one material per part in game; Autosketch writes a single material.',
};
