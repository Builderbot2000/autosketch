import { describe, expect, it } from "vitest";
import { Mask } from "../../../src/core/mask.js";
import { fromPublic, type Vec3 } from "../../../src/core/region.js";
import { Document } from "../../../src/document/document.js";
import { reconnectPositions } from "../../../src/ops/connect.js";
import { clear, fill, setBlocks } from "../../../src/ops/edit.js";
import type { AutosketchPlugin } from "../../../src/plugins/types.js";
import { vanillaRegistry } from "../../helpers/vanilla.js";

const registry = vanillaRegistry({ "minecraft:oak_fence": ["minecraft:fences", "minecraft:wooden_fences"], "minecraft:spruce_fence": ["minecraft:fences", "minecraft:wooden_fences"], "minecraft:nether_brick_fence": ["minecraft:fences"] });
const env = { registry };
const B = (min: Vec3, max: Vec3) => fromPublic({ min, max });
const newDoc = () => Document.create({ name: "t", dataVersion: 3955, seed: 1 });
const at = (doc: Document, x: number, y: number, z: number) => doc.getState(x, y, z).replace("minecraft:", "");
const sides = (doc: Document, x: number, y: number, z: number) => {
  const m = /\[(.*)\]/.exec(doc.getState(x, y, z))?.[1] ?? "";
  return Object.fromEntries(m.split(",").map((kv) => kv.split("=")).filter(([k]) => ["north", "east", "south", "west", "up", "shape", "type"].includes(k!)));
};

describe("auto-connection (05)", () => {
  it("connects a fence line built up to a solid wall, and raw leaves states exactly as given", () => {
    const doc = newDoc();
    fill(doc, env, B([0, 0, 0], [0, 2, 4]), "oak_planks"); // a plank wall at x=0
    fill(doc, env, B([1, 0, 2], [4, 0, 2]), "oak_fence");
    expect(sides(doc, 1, 0, 2)).toEqual({ north: "false", east: "true", south: "false", west: "true" });
    expect(sides(doc, 2, 0, 2)).toEqual({ north: "false", east: "true", south: "false", west: "true" });
    expect(sides(doc, 4, 0, 2)).toEqual({ north: "false", east: "false", south: "false", west: "true" });
    // Extending the line updates the old end (a neighbour), in the same undo step.
    setBlocks(doc, env, [{ pos: [5, 0, 2], block: "spruce_fence" }]);
    expect(sides(doc, 4, 0, 2).east).toBe("true");
    doc.undo();
    expect(sides(doc, 4, 0, 2).east).toBe("false");
    // Removing the wall disconnects the fence end.
    clear(doc, B([0, 0, 2], [0, 0, 2]), undefined, { env });
    expect(sides(doc, 1, 0, 2).west).toBe("false");
    // raw: true writes states exactly as given and leaves neighbours alone.
    setBlocks(doc, env, [{ pos: [3, 0, 3], block: "oak_fence[north=false,east=true,south=true,west=false]" }], undefined, { raw: true });
    expect(sides(doc, 3, 0, 3)).toEqual({ north: "false", east: "true", south: "true", west: "false" });
    expect(sides(doc, 3, 0, 2).south).toBe("false");
  });

  it("follows vanilla pairing rules: nether brick vs wooden fences, gates, leaves, panes and walls", () => {
    const doc = newDoc();
    setBlocks(doc, env, [
      { pos: [0, 0, 0], block: "oak_fence" },
      { pos: [1, 0, 0], block: "nether_brick_fence" },
      { pos: [0, 0, 1], block: "oak_fence_gate[facing=east]" }, // gate across z: joins a fence to its north
      { pos: [-1, 0, 0], block: "oak_leaves" },
    ]);
    expect(sides(doc, 0, 0, 0)).toEqual({ north: "false", east: "false", south: "true", west: "false" });
    setBlocks(doc, env, [{ pos: [5, 0, 0], block: "glass_pane" }, { pos: [6, 0, 0], block: "cobblestone_wall" }, { pos: [4, 0, 0], block: "oak_fence" }]);
    expect(sides(doc, 5, 0, 0)).toMatchObject({ east: "true", west: "false" });
    // Walls join panes but not fences; a lone wall end keeps its post.
    expect(sides(doc, 6, 0, 0)).toEqual({ north: "none", east: "none", south: "none", west: "low", up: "true" });
  });

  it("raises wall sides under a full block and drops the post on straight runs", () => {
    const doc = newDoc();
    fill(doc, env, B([0, 0, 0], [4, 0, 0]), "cobblestone_wall");
    expect(sides(doc, 2, 0, 0)).toEqual({ north: "none", east: "low", south: "none", west: "low", up: "false" });
    expect(sides(doc, 0, 0, 0).up).toBe("true");
    setBlocks(doc, env, [{ pos: [2, 1, 0], block: "stone" }]);
    expect(sides(doc, 2, 0, 0)).toEqual({ north: "none", east: "tall", south: "none", west: "tall", up: "false" });
    setBlocks(doc, env, [{ pos: [2, 0, 1], block: "cobblestone_wall" }]);
    expect(sides(doc, 2, 0, 0)).toMatchObject({ south: "tall", up: "true" });
  });

  it("shapes stair corners like the game", () => {
    const doc = newDoc();
    // In front (north) of a north stair sits an east-facing stair: outer corner.
    setBlocks(doc, env, [{ pos: [2, 0, 0], block: "oak_stairs[facing=north]" }, { pos: [2, 0, -1], block: "oak_stairs[facing=east]" }]);
    expect(sides(doc, 2, 0, 0).shape).toBe("outer_right");
    // Vanilla canTakeShape: a same-facing stair on the side the corner would turn toward keeps it straight.
    setBlocks(doc, env, [{ pos: [1, 0, 0], block: "oak_stairs[facing=north]" }]);
    expect(sides(doc, 2, 0, 0).shape).toBe("straight");
    // Behind a north stair (south) sits a west-facing stair: inner corner.
    setBlocks(doc, env, [{ pos: [0, 0, 5], block: "oak_stairs[facing=north]" }, { pos: [0, 0, 6], block: "oak_stairs[facing=west]" }]);
    expect(sides(doc, 0, 0, 5).shape).toBe("inner_left");
    // Different halves never join.
    setBlocks(doc, env, [{ pos: [0, 0, 6], block: "oak_stairs[facing=west,half=top]" }]);
    expect(sides(doc, 0, 0, 5).shape).toBe("straight");
  });

  it("routes redstone wire: lines, crosses, steps up, and keeps an isolated dot", () => {
    const doc = newDoc();
    fill(doc, env, B([0, 0, 0], [4, 0, 0]), "stone");
    fill(doc, env, B([0, 1, 0], [2, 1, 0]), "redstone_wire");
    expect(sides(doc, 1, 1, 0)).toEqual({ north: "none", east: "side", south: "none", west: "side" });
    expect(sides(doc, 0, 1, 0)).toEqual({ north: "none", east: "side", south: "none", west: "side" }); // a line end points both ways
    // A lone wire is a cross; with raw it can stay a dot, and a dot stays a dot when nothing joins it.
    setBlocks(doc, env, [{ pos: [4, 1, 0], block: "redstone_wire" }]);
    expect(sides(doc, 4, 1, 0)).toEqual({ north: "side", east: "side", south: "side", west: "side" });
    setBlocks(doc, env, [{ pos: [4, 1, 0], block: "redstone_wire[north=none,east=none,south=none,west=none]" }], undefined, { raw: true });
    setBlocks(doc, env, [{ pos: [4, 2, 0], block: "stone" }]); // a neighbour update
    expect(sides(doc, 4, 1, 0)).toEqual({ north: "none", east: "none", south: "none", west: "none" });
    // Stepping up a block: wire on top of a stone block east of the line.
    setBlocks(doc, env, [{ pos: [3, 1, 0], block: "stone" }, { pos: [3, 2, 0], block: "redstone_wire" }]);
    expect(sides(doc, 2, 1, 0).east).toBe("up");
    expect(sides(doc, 3, 2, 0).west).toBe("side");
  });

  it("pairs chests side by side with the same facing and keeps their contents", () => {
    const doc = newDoc();
    setBlocks(doc, env, [{ pos: [0, 0, 0], block: "chest[facing=north]" }, { pos: [1, 0, 0], block: "chest[facing=north]" }, { pos: [2, 0, 0], block: "chest[facing=south]" }]);
    // Facing north, the partner of a "left" chest is clockwise (east).
    expect(sides(doc, 0, 0, 0).type).toBe("left");
    expect(sides(doc, 1, 0, 0).type).toBe("right");
    expect(sides(doc, 2, 0, 0).type).toBe("single");
    clear(doc, B([1, 0, 0], [1, 0, 0]), undefined, { env });
    expect(sides(doc, 0, 0, 0).type).toBe("single");
  });

  it("recomputes an explicit shell of positions and runs plugin-declared connections", () => {
    const doc = newDoc();
    setBlocks(doc, env, [{ pos: [0, 0, 0], block: "oak_fence" }, { pos: [1, 0, 0], block: "oak_fence" }], undefined, { raw: true });
    expect(sides(doc, 0, 0, 0).east).toBe("false");
    doc.edit("seam", "seam", (tx) => reconnectPositions(doc, tx, Mask.fromBox(B([0, 0, 0], [0, 0, 0])), env));
    expect(sides(doc, 0, 0, 0).east).toBe("true");
    expect(sides(doc, 1, 0, 0).west).toBe("false"); // only the given positions
    const plugin: AutosketchPlugin = {
      id: "pipes",
      namespaces: ["pipes"],
      connection: { handles: (s) => s.startsWith("pipes:pipe"), update: (s, get) => `pipes:pipe[east=${get(1, 0, 0) !== "minecraft:air"}]` },
    };
    setBlocks(doc, { plugins: [plugin] }, [{ pos: [5, 0, 0], block: "pipes:pipe" }, { pos: [6, 0, 0], block: "stone" }]);
    expect(at(doc, 5, 0, 0)).toBe("pipes:pipe[east=true]");
  });
});
