/**
 * Builds the starter prefabs in library/prefabs/ from the original designs below (07: starter
 * library, original content only). Run with `npx tsx library/build-starter.ts`. Thumbnails are
 * not committed: they are rendered from the user's own instance textures on first use.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Vec3 } from "../src/core/region.js";
import { Document } from "../src/document/document.js";
import { snapshotOf } from "../src/formats/snapshot.js";
import { encodeSponge } from "../src/formats/sponge.js";
import type { PrefabMeta } from "../src/library/prefabs.js";
import { setBlocks } from "../src/ops/edit.js";

type Put = (x: number, y: number, z: number, block: string) => void;

interface Design {
  id: string;
  meta: Omit<PrefabMeta, "footprint" | "height" | "requires" | "front">;
  build: (put: Put) => void;
}

const DESIGNS: Design[] = [
  {
    id: "lamp_post",
    meta: {
      name: "Lamp post",
      tags: ["street", "light", "small"],
      anchors: { base: [0, 0, 0] },
      roles: { post: ["minecraft:stone_bricks"], light: ["minecraft:lantern"] },
      notes: "Street light: a wall-post with a hanging lantern on a short arm. Space every 6-8 blocks along a road.",
    },
    build: (put) => {
      put(0, 0, 0, "minecraft:stone_bricks");
      for (let y = 1; y <= 3; y++) put(0, y, 0, "minecraft:stone_brick_wall");
      put(0, 4, 0, "minecraft:stone_brick_slab[type=bottom]");
      put(0, 4, 1, "minecraft:oak_fence");
      put(0, 3, 1, "minecraft:lantern[hanging=true]");
    },
  },
  {
    id: "small_oak_tree",
    meta: {
      name: "Small oak tree",
      tags: ["tree", "nature", "oak", "small"],
      anchors: { base: [2, 0, 2] },
      roles: { log: ["minecraft:oak_log"], leaves: ["minecraft:oak_leaves"] },
      notes: "Compact garden tree, 5×5 crown. Remap log/leaves for other species.",
    },
    build: (put) => {
      for (let y = 0; y <= 3; y++) put(2, y, 2, "minecraft:oak_log[axis=y]");
      for (let y = 3; y <= 5; y++)
        for (let x = 0; x < 5; x++)
          for (let z = 0; z < 5; z++) {
            const edge = (x === 0 || x === 4) && (z === 0 || z === 4);
            const r = y === 5 ? Math.abs(x - 2) + Math.abs(z - 2) > 1 : edge;
            if (r || (x === 2 && z === 2 && y < 5)) continue;
            put(x, y, z, "minecraft:oak_leaves[persistent=true]");
          }
      put(2, 6, 2, "minecraft:oak_leaves[persistent=true]");
    },
  },
  {
    id: "village_well",
    meta: {
      name: "Village well",
      tags: ["well", "plaza", "water", "centrepiece"],
      anchors: { base: [2, 0, 2] },
      roles: { rim: ["minecraft:cobblestone"], frame: ["minecraft:spruce_planks"], roof: ["minecraft:spruce_planks"] },
      notes: "5×5 well with a little gabled roof; a plaza centrepiece.",
    },
    build: (put) => {
      for (let x = 0; x < 5; x++)
        for (let z = 0; z < 5; z++) {
          const ring = x === 0 || x === 4 || z === 0 || z === 4;
          put(x, 0, z, ring ? "minecraft:cobblestone" : "minecraft:water");
          if (ring) put(x, 1, z, x % 4 === 0 && z % 4 === 0 ? "minecraft:cobblestone" : "minecraft:cobblestone_wall");
        }
      for (const [x, z] of [[0, 2], [4, 2]] as const) for (let y = 2; y <= 3; y++) put(x, y, z, "minecraft:spruce_fence");
      for (let z = 0; z < 5; z++) {
        put(0, 4, z, "minecraft:spruce_stairs[facing=east,half=bottom]");
        put(4, 4, z, "minecraft:spruce_stairs[facing=west,half=bottom]");
        put(1, 5, z, "minecraft:spruce_stairs[facing=east,half=bottom]");
        put(3, 5, z, "minecraft:spruce_stairs[facing=west,half=bottom]");
        put(2, 5, z, "minecraft:spruce_planks");
        put(2, 6, z, "minecraft:spruce_slab[type=bottom]");
      }
      put(2, 4, 2, "minecraft:spruce_fence");
      put(2, 3, 2, "minecraft:chain");
    },
  },
  {
    id: "park_bench",
    meta: {
      name: "Park bench",
      tags: ["furniture", "street", "small"],
      anchors: { base: [0, 0, 0] },
      roles: { seat: ["minecraft:oak_planks"], arms: ["minecraft:oak_planks"] },
      notes: "3-wide bench facing south (sit on the stairs), with trapdoor arm rests.",
    },
    build: (put) => {
      put(0, 0, 0, "minecraft:oak_trapdoor[facing=east,half=bottom,open=true]");
      for (let x = 1; x <= 3; x++) put(x, 0, 0, "minecraft:oak_stairs[facing=north,half=bottom]");
      put(4, 0, 0, "minecraft:oak_trapdoor[facing=west,half=bottom,open=true]");
    },
  },
];

const here = dirname(fileURLToPath(import.meta.url));

for (const d of DESIGNS) {
  const doc = Document.create({ name: d.id, dataVersion: 3955, seed: 1 });
  const blocks: { pos: Vec3; block: string }[] = [];
  d.build((x, y, z, block) => blocks.push({ pos: [x, y, z], block }));
  setBlocks(doc, {}, blocks);
  const snap = snapshotOf(doc);
  const meta: PrefabMeta = { ...d.meta, front: "south", footprint: [snap.size[0], snap.size[2]], height: snap.size[1], requires: ["minecraft"] };
  const dir = join(here, "prefabs", d.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "prefab.schem"), encodeSponge({ ...snap, name: d.id }, { date: 0 }));
  await writeFile(join(dir, "prefab.json"), JSON.stringify(meta, null, 2) + "\n");
  console.log(`${d.id}: ${snap.size.join("×")}`);
}
