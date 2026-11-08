import { fromPublic, type Vec3 } from "../../src/core/region.js";
import { Document } from "../../src/document/document.js";
import { fill, setBlocks, type BlockPlacement } from "../../src/ops/edit.js";
import { gableHouse } from "../helpers/buildings.js";

/**
 * Seed documents for benchmark prompts that start from an existing build (docs/design/10-testing.md,
 * tier 3: "extend the existing wall with a gatehouse"). Original builds, made in code, so nothing
 * derived from game assets is committed (02, *Legal stance*). All face south.
 */

const B = (min: Vec3, max: Vec3) => fromPublic({ min, max });
const newDoc = (name: string) => Document.create({ name, dataVersion: 3955, seed: 7 });

/** A 31-long stone brick curtain wall along x (x 0..30, z 0..1, y 0..5) with a battlement row on top. */
export function curtainWall(name: string): Document {
  const doc = newDoc(name);
  fill(doc, {}, B([0, 0, 0], [30, 5, 1]), "minecraft:stone_bricks");
  const crenels: BlockPlacement[] = [];
  for (let x = 0; x <= 30; x += 2) crenels.push({ pos: [x, 6, 0], block: "minecraft:stone_bricks" }, { pos: [x, 6, 1], block: "minecraft:stone_bricks" });
  setBlocks(doc, {}, crenels);
  return doc;
}

/** The one-storey gable house fixture (9×7, door on the south side), renamed. */
export function cottage(name: string): Document {
  const { doc } = gableHouse();
  doc.meta.name = name;
  return doc;
}

/**
 * A one-storey flat-roofed house: 9×9 (x 0..8, z 0..8), cobblestone floor, oak plank walls y 1..4,
 * oak plank roof deck at y 5, a south door and a window on each side.
 */
export function flatHouse(name: string): Document {
  const doc = newDoc(name);
  fill(doc, {}, B([0, 0, 0], [8, 0, 8]), "minecraft:cobblestone");
  fill(doc, {}, B([0, 1, 0], [8, 4, 8]), "minecraft:oak_planks", { mode: "walls" });
  fill(doc, {}, B([0, 5, 0], [8, 5, 8]), "minecraft:oak_planks");
  setBlocks(doc, {}, [
    { pos: [4, 1, 8], block: "minecraft:oak_door[facing=south,half=lower,hinge=left,open=false,powered=false]" },
    { pos: [4, 2, 8], block: "minecraft:oak_door[facing=south,half=upper,hinge=left,open=false,powered=false]" },
    ...([[4, 2, 0], [0, 2, 4], [8, 2, 4], [2, 2, 8]] as Vec3[]).map((pos) => ({ pos, block: "minecraft:glass_pane" })),
  ]);
  return doc;
}

export const SEEDS = { curtainWall, cottage, flatHouse } as const;
export type SeedName = keyof typeof SEEDS;
