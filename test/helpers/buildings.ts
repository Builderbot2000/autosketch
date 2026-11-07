import type { Vec3 } from "../../src/core/region.js";
import { fromPublic } from "../../src/core/region.js";
import { Document } from "../../src/document/document.js";
import { fill, setBlocks, type BlockPlacement } from "../../src/ops/edit.js";

/**
 * Three small original fixture buildings with known structure, for `analyze` tests and the golden
 * tier (docs/design/10-testing.md, "Analysis"). Each comes with the facts analysis must find.
 * Vanilla ids only and no registry needed, so any test can build them. All face south (front).
 */

const B = (min: Vec3, max: Vec3) => fromPublic({ min, max });
const door = (x: number, y: number, z: number, facing = "south"): BlockPlacement[] => [
  { pos: [x, y, z], block: `minecraft:oak_door[facing=${facing},half=lower,hinge=left,open=false,powered=false]` },
  { pos: [x, y + 1, z], block: `minecraft:oak_door[facing=${facing},half=upper,hinge=left,open=false,powered=false]` },
];
const panes = (ps: Vec3[], block = "minecraft:glass_pane"): BlockPlacement[] => ps.map((pos) => ({ pos, block }));
const newDoc = (name: string) => Document.create({ name, dataVersion: 3955, seed: 11 });

export interface FixtureFacts {
  footprint: [number, number];
  storeys: number[];
  heights: number[];
  roof: string;
  ridgeAxis?: "x" | "z";
  ridgeY: number;
  /** Windows and doors per facade. */
  openings: Record<"front" | "back" | "left" | "right", { windows: number; doors: number }>;
  rooms: number;
}

/**
 * A one-storey gable house: 9×7 footprint (x 0..8, z 0..6), cobblestone floor at y=0, oak plank
 * walls y=1..4, a door in the middle of the front, glass panes, and an oak stair gable roof
 * (ridge along x at y=9, pitch 1:1, overhang 1) with plank gable ends.
 */
export function gableHouse(): { doc: Document; facts: FixtureFacts } {
  const doc = newDoc("gable_house");
  fill(doc, {}, B([0, 0, 0], [8, 0, 6]), "minecraft:cobblestone");
  fill(doc, {}, B([0, 1, 0], [8, 4, 6]), "minecraft:oak_planks", { mode: "walls" });
  const blocks: BlockPlacement[] = [
    ...door(4, 1, 6),
    ...panes([[2, 2, 6], [6, 2, 6], [2, 2, 0], [4, 2, 0], [6, 2, 0], [8, 2, 3], [0, 2, 3]]),
  ];
  for (let k = 0; k <= 3; k++) {
    for (let x = -1; x <= 9; x++) {
      blocks.push({ pos: [x, 5 + k, -1 + k], block: "minecraft:oak_stairs[facing=south,half=bottom,shape=straight,waterlogged=false]" });
      blocks.push({ pos: [x, 5 + k, 7 - k], block: "minecraft:oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]" });
    }
    // Gable ends fill the triangle under the stairs.
    for (let z = k; z <= 6 - k; z++) for (const x of [0, 8]) blocks.push({ pos: [x, 5 + k, z], block: "minecraft:oak_planks" });
  }
  for (let x = -1; x <= 9; x++) blocks.push({ pos: [x, 9, 3], block: "minecraft:oak_planks" });
  setBlocks(doc, {}, blocks);
  return {
    doc,
    facts: {
      footprint: [9, 7],
      storeys: [0],
      heights: [5],
      roof: "gable",
      ridgeAxis: "x",
      ridgeY: 9,
      openings: { front: { windows: 2, doors: 1 }, back: { windows: 3, doors: 0 }, left: { windows: 1, doors: 0 }, right: { windows: 1, doors: 0 } },
      rooms: 1,
    },
  };
}

/**
 * A two-storey house: 11×9 footprint (x 0..10, z 0..8), stone brick walls with some mossy bricks
 * (y=1..7), floors at y=0 (stone bricks) and y=4 (oak planks), two-high windows on the ground
 * storey, single panes upstairs (three across the front, rhythm 3), and a spruce stair hip roof
 * (ridge along x at y=13, pitch 1:1, overhang 1).
 */
export function twoStorey(): { doc: Document; facts: FixtureFacts } {
  const doc = newDoc("two_storey");
  fill(doc, {}, B([0, 0, 0], [10, 0, 8]), "minecraft:stone_bricks");
  fill(doc, {}, B([0, 1, 0], [10, 7, 8]), "minecraft:stone_bricks 75%, minecraft:mossy_stone_bricks 25%", { mode: "walls" });
  fill(doc, {}, B([1, 4, 1], [9, 4, 7]), "minecraft:oak_planks");
  const blocks: BlockPlacement[] = [
    ...door(5, 1, 8),
    ...panes([[2, 2, 8], [2, 3, 8], [8, 2, 8], [8, 3, 8]], "minecraft:glass"),
    ...panes([[2, 6, 8], [5, 6, 8], [8, 6, 8]]),
    ...panes([[3, 2, 0], [3, 3, 0], [7, 2, 0], [7, 3, 0]], "minecraft:glass"),
    ...panes([[3, 6, 0], [7, 6, 0]]),
    ...panes([[0, 2, 4], [0, 3, 4], [10, 2, 4], [10, 3, 4]], "minecraft:glass"),
    ...panes([[0, 6, 4], [10, 6, 4]]),
  ];
  // Hip roof: rings of stairs stepping in by one per layer, closed by a plank ridge.
  for (let k = 0; ; k++) {
    const xa = -1 + k, xb = 11 - k, za = -1 + k, zb = 9 - k;
    if (za === zb) {
      for (let x = xa; x <= xb; x++) blocks.push({ pos: [x, 8 + k, za], block: "minecraft:spruce_planks" });
      break;
    }
    for (let x = xa; x <= xb; x++)
      for (let z = za; z <= zb; z++) {
        if (x !== xa && x !== xb && z !== za && z !== zb) continue;
        const facing = z === za ? "south" : z === zb ? "north" : x === xa ? "east" : "west";
        blocks.push({ pos: [x, 8 + k, z], block: `minecraft:spruce_stairs[facing=${facing},half=bottom,shape=straight,waterlogged=false]` });
      }
  }
  setBlocks(doc, {}, blocks);
  return {
    doc,
    facts: {
      footprint: [11, 9],
      storeys: [0, 4],
      heights: [4, 4],
      roof: "hip",
      ridgeAxis: "x",
      ridgeY: 13,
      openings: { front: { windows: 5, doors: 1 }, back: { windows: 4, doors: 0 }, left: { windows: 2, doors: 0 }, right: { windows: 2, doors: 0 } },
      rooms: 2,
    },
  };
}

/**
 * A three-storey tower: 7×7 footprint (x 0..6, z 0..6), stone brick walls, floors at y=0, 5 and 10,
 * a flat cobblestone roof deck at y=15 with battlements at y=16, a front door, and windows on the
 * upper storeys.
 */
export function tower(): { doc: Document; facts: FixtureFacts } {
  const doc = newDoc("tower");
  fill(doc, {}, B([0, 0, 0], [6, 0, 6]), "minecraft:stone");
  fill(doc, {}, B([0, 1, 0], [6, 14, 6]), "minecraft:stone_bricks", { mode: "walls" });
  fill(doc, {}, B([1, 5, 1], [5, 5, 5]), "minecraft:oak_planks");
  fill(doc, {}, B([1, 10, 1], [5, 10, 5]), "minecraft:oak_planks");
  fill(doc, {}, B([0, 15, 0], [6, 15, 6]), "minecraft:cobblestone");
  const blocks: BlockPlacement[] = [
    ...door(3, 1, 6),
    ...panes([[3, 7, 6], [3, 12, 6], [3, 2, 0], [3, 7, 0], [3, 12, 0], [0, 7, 3], [0, 12, 3], [6, 7, 3], [6, 12, 3]]),
  ];
  for (let x = 0; x <= 6; x++)
    for (let z = 0; z <= 6; z++) {
      const edge = x === 0 || x === 6 || z === 0 || z === 6;
      if (edge && (x + z) % 2 === 0) blocks.push({ pos: [x, 16, z], block: "minecraft:stone_bricks" });
    }
  setBlocks(doc, {}, blocks);
  return {
    doc,
    facts: {
      footprint: [7, 7],
      storeys: [0, 5, 10],
      heights: [5, 5, 5],
      roof: "flat",
      ridgeY: 16,
      openings: { front: { windows: 2, doors: 1 }, back: { windows: 3, doors: 0 }, left: { windows: 2, doors: 0 }, right: { windows: 2, doors: 0 } },
      rooms: 3,
    },
  };
}

export const FIXTURE_BUILDINGS = { gableHouse, twoStorey, tower } as const;
