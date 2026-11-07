import { BufferByteSource } from "../../src/assets/bytes.js";
import type { LayerRole } from "../../src/assets/locate.js";
import { PackStack, ZipPackSource } from "../../src/assets/pack.js";
import { ZipArchive } from "../../src/assets/zip.js";
import { makeZip, type FileTree } from "./fixtures.js";

/** Builds an in-memory pack stack from [id, role, files] layers, lowest priority first. */
export async function memStack(layers: [string, LayerRole, FileTree][]): Promise<PackStack> {
  const sources = await Promise.all(
    layers.map(async ([id, role, files]) => new ZipPackSource(id, role, await ZipArchive.open(new BufferByteSource(Buffer.from(makeZip(files))), id))),
  );
  return new PackStack(sources);
}

/** The vanilla model parents most block models build on, enough for tests. */
export const VANILLA_PARENTS: FileTree = {
  "assets/minecraft/models/block/block.json": { textures: { particle: "#all" } },
  "assets/minecraft/models/block/cube.json": {
    parent: "block/block",
    elements: [
      {
        from: [0, 0, 0],
        to: [16, 16, 16],
        faces: {
          down: { texture: "#down", cullface: "down" },
          up: { texture: "#up", cullface: "up" },
          north: { texture: "#north", cullface: "north" },
          south: { texture: "#south", cullface: "south" },
          west: { texture: "#west", cullface: "west" },
          east: { texture: "#east", cullface: "east" },
        },
      },
    ],
  },
  "assets/minecraft/models/block/cube_all.json": {
    parent: "block/cube",
    textures: { particle: "#all", down: "#all", up: "#all", north: "#all", south: "#all", west: "#all", east: "#all" },
  },
  "assets/minecraft/models/block/cube_column.json": {
    parent: "block/cube",
    textures: { particle: "#side", down: "#end", up: "#end", north: "#side", south: "#side", west: "#side", east: "#side" },
  },
  "assets/minecraft/models/block/slab.json": {
    parent: "block/block",
    elements: [{ from: [0, 0, 0], to: [16, 8, 16], faces: { up: { texture: "#top" }, down: { texture: "#bottom" }, north: { texture: "#side" } } }],
  },
};
