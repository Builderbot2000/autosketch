import { describe, expect, it } from "vitest";
import type { Compound } from "prismarine-nbt";
import { canonicalState } from "../../../src/core/blockstate.js";
import { Mask } from "../../../src/core/mask.js";
import { fromPublic, type Vec3 } from "../../../src/core/region.js";
import { Document } from "../../../src/document/document.js";
import { fill, setBlocks } from "../../../src/ops/edit.js";
import { resolveSelection } from "../../../src/ops/selection.js";
import { copy, mirror, move, rotate } from "../../../src/ops/transform.js";
import { viewSlice } from "../../../src/perception/slice.js";
import { vanillaRegistry } from "../../helpers/vanilla.js";

const registry = vanillaRegistry();
const env = { registry };
const S = (s: string) => canonicalState(s, registry).state;
const B = (min: Vec3, max: Vec3) => fromPublic({ min, max });
const newDoc = () => Document.create({ name: "t", dataVersion: 3955, seed: 1 });
const at = (doc: Document, x: number, y: number, z: number) => doc.getState(x, y, z).replace("minecraft:", "");
const chestNbt: Compound = { type: "compound", value: { id: { type: "string", value: "minecraft:chest" }, Lock: { type: "string", value: "k" } } };

/**
 * A 5×5 house (x 0..4, z 0..4): log corners, plank walls, a south door at (2,1..2,4), a fence post
 * outside, and a gable roof of stairs along x (the north slope faces south, the south slope faces north).
 */
function house(doc: Document): void {
  fill(doc, env, B([0, 0, 0], [4, 0, 4]), "cobblestone", { raw: true });
  fill(doc, env, B([0, 1, 0], [4, 3, 4]), "oak_planks", { mode: "walls", raw: true });
  for (const [x, z] of [[0, 0], [4, 0], [0, 4], [4, 4]]) fill(doc, env, B([x!, 1, z!], [x!, 3, z!]), "oak_log[axis=y]", { raw: true });
  setBlocks(doc, env, [
    { pos: [2, 1, 4], block: "oak_door[facing=south,half=lower,hinge=left]" },
    { pos: [2, 2, 4], block: "oak_door[facing=south,half=upper,hinge=left]" },
    { pos: [1, 2, 0], block: "oak_log[axis=x]" },
    { pos: [6, 1, 2], block: "oak_fence[north=true,east=false,south=false,west=false]" },
    { pos: [3, 1, 1], block: "chest[facing=west,type=single]" },
  ], undefined, { raw: true });
  fill(doc, env, B([0, 4, 0], [4, 4, 1]), "oak_stairs[facing=south,half=bottom]", { raw: true });
  fill(doc, env, B([0, 4, 3], [4, 4, 4]), "oak_stairs[facing=north,half=bottom]", { raw: true });
  fill(doc, env, B([0, 4, 2], [4, 4, 2]), "oak_slab[type=bottom]", { raw: true });
}

describe("transform ops (05 L2)", () => {
  it("rotates a stair-roofed house 90° clockwise with correct stairs, doors, fences and logs", () => {
    const doc = newDoc();
    house(doc);
    const bnbt = doc.edit("nbt", "nbt", (tx) => tx.set(3, 1, 1, S("chest[facing=west]"), chestNbt));
    expect(bnbt.changed).toBe(1);
    // Pivot (2,·,2): the 5×5 footprint rotates in place; the fence at (6,1,2) goes to (2,1,6).
    const r = rotate(doc, env, B([0, 0, 0], [6, 4, 4]), 1, { raw: true, pivot: [2, 0, 2] });
    expect(r.op).toBe("rotate");
    // South door → west door at x=0 (position (2,·,4) → (0,·,2)); hinge unchanged by rotation.
    expect(at(doc, 0, 1, 2)).toBe("oak_door[facing=west,half=lower,hinge=left,open=false,powered=false]");
    expect(at(doc, 0, 2, 2)).toBe("oak_door[facing=west,half=upper,hinge=left,open=false,powered=false]");
    // The north roof slope (z=0, facing south) becomes the east slope (x=4) facing west.
    for (let z = 0; z <= 4; z++) expect(at(doc, 4, 4, z)).toBe("oak_stairs[facing=west,half=bottom,shape=straight,waterlogged=false]");
    for (let z = 0; z <= 4; z++) expect(at(doc, 0, 4, z)).toBe("oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]");
    // Log axis x → z; vertical logs stay vertical.
    expect(at(doc, 4, 2, 1)).toBe("oak_log[axis=z]");
    expect(at(doc, 0, 2, 0)).toBe("oak_log[axis=y]");
    // The fence's north side becomes its east side.
    expect(at(doc, 2, 1, 6)).toBe("oak_fence[east=true,north=false,south=false,waterlogged=false,west=false]");
    expect(at(doc, 6, 1, 2)).toBe("air");
    // The chest keeps its contents and turns west → north.
    expect(at(doc, 3, 1, 3)).toBe("chest[facing=north,type=single,waterlogged=false]");
    expect(doc.getBlockEntity(3, 1, 3)).toBe(chestNbt);
    expect(doc.getBlockEntity(3, 1, 1)).toBeUndefined();
    // Undo restores everything in one step.
    doc.undo();
    expect(at(doc, 2, 1, 4)).toBe("oak_door[facing=south,half=lower,hinge=left,open=false,powered=false]");
    expect(doc.getBlockEntity(3, 1, 1)).toBe(chestNbt);
  });

  it("mirrors the house across z in place: doors face north with swapped hinges, roof slopes swap", () => {
    const doc = newDoc();
    house(doc);
    mirror(doc, env, B([0, 0, 0], [4, 4, 4]), "z", { raw: true });
    expect(at(doc, 2, 1, 0)).toBe("oak_door[facing=north,half=lower,hinge=right,open=false,powered=false]");
    expect(at(doc, 2, 1, 4)).toBe("oak_planks");
    for (let x = 0; x <= 4; x++) {
      expect(at(doc, x, 4, 0)).toBe("oak_stairs[facing=south,half=bottom,shape=straight,waterlogged=false]");
      expect(at(doc, x, 4, 4)).toBe("oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]");
    }
    expect(at(doc, 1, 2, 4)).toBe("oak_log[axis=x]");
    // The plan view shows the door on the north side now.
    const front = viewSlice(doc, registry, { axis: "z", at: 0 });
    expect(front).toMatch(/oak_door/);
  });

  it("moves with overlap, carries air unless skip_air, and moves covered components", () => {
    const doc = newDoc();
    fill(doc, env, B([0, 0, 0], [2, 0, 0]), "stone", { as: "row" });
    fill(doc, env, B([3, 0, 0], [3, 0, 0]), "oak_planks");
    // Overlapping move by +1: the row now spans x 1..3; the plank at x=3 is overwritten.
    move(doc, env, B([0, 0, 0], [2, 0, 0]), [1, 0, 0]);
    expect([0, 1, 2, 3].map((x) => at(doc, x, 0, 0))).toEqual(["air", "stone", "stone", "stone"]);
    expect(doc.componentLocal("row")!.box).toEqual(B([1, 0, 0], [3, 0, 0]));
    // A box including air overwrites the destination; skip_air keeps it.
    fill(doc, env, B([0, 0, 2], [3, 0, 2]), "oak_planks");
    move(doc, env, B([0, 0, 0], [3, 0, 0]), [0, 0, 2]);
    expect(at(doc, 0, 0, 2)).toBe("air");
    fill(doc, env, B([0, 0, 0], [3, 0, 0]), "oak_planks");
    move(doc, env, B([0, 0, 2], [3, 0, 2]), [0, 0, -2], { skipAir: true });
    expect(at(doc, 0, 0, 0)).toBe("oak_planks");
    expect(at(doc, 1, 0, 0)).toBe("stone");
    // A component only partly inside the selection stays put.
    fill(doc, env, B([10, 0, 0], [12, 0, 0]), "stone", { as: "wide" });
    move(doc, env, B([10, 0, 0], [11, 0, 0]), [0, 1, 0]);
    expect(doc.componentLocal("wide")!.box).toEqual(B([10, 0, 0], [12, 0, 0]));
  });

  it("copies, optionally turned, registering the copy with as", () => {
    const doc = newDoc();
    setBlocks(doc, env, [{ pos: [0, 0, 0], block: "oak_stairs[facing=north]" }, { pos: [1, 0, 0], block: "stone" }]);
    const r = copy(doc, env, B([0, 0, 0], [1, 0, 0]), [0, 0, 5], { as: "copy1" });
    expect(r.changed).toBe(2);
    expect(at(doc, 0, 0, 0)).toMatch(/^oak_stairs\[facing=north/);
    expect(at(doc, 0, 0, 5)).toMatch(/^oak_stairs\[facing=north/);
    expect(doc.componentLocal("copy1")!.box).toEqual(B([0, 0, 5], [1, 0, 5]));
    // Turned 90° about its own pivot (0,0,0): x 0..1 becomes z 0..1, then offset by x+5.
    copy(doc, env, B([0, 0, 0], [1, 0, 0]), [5, 0, 0], { turns: 1 });
    expect(at(doc, 5, 0, 0)).toMatch(/^oak_stairs\[facing=east/);
    expect(at(doc, 5, 0, 1)).toBe("stone");
  });

  it("transforms any selection shape and offers sel.rotate / sel.mirror", () => {
    const doc = newDoc();
    setBlocks(doc, env, [{ pos: [0, 0, 0], block: "stone" }, { pos: [1, 0, 0], block: "stone" }, { pos: [2, 0, 0], block: "stone" }, { pos: [0, 0, 1], block: "stone" }]);
    const L = resolveSelection({ filter: "all", block: "stone" }, { doc, registry }).mask;
    const turned = resolveSelection({ rotate: { filter: "all", block: "stone" }, turns: 1 }, { doc, registry }).mask;
    // Pivot (1,0,0): (0,0,0)→(1,0,-1), (2,0,0)→(1,0,1), (0,0,1)→(0,0,-1).
    expect(turned.positions().map((p) => p.join(",")).sort()).toEqual(["0,0,-1", "1,0,-1", "1,0,0", "1,0,1"]);
    const flipped = resolveSelection({ mirror: { filter: "all", block: "stone" }, axis: "x" }, { doc, registry }).mask;
    expect(flipped.positions().map((p) => p.join(",")).sort()).toEqual(["0,0,0", "1,0,0", "2,0,0", "2,0,1"]);
    expect(() => resolveSelection({ mirror: "all", axis: "q" }, { doc })).toThrow(/mirror.axis/);
    rotate(doc, env, L, 1);
    expect(new Mask().isEmpty()).toBe(true);
    expect(at(doc, 1, 0, -1)).toBe("stone");
    expect(at(doc, 0, 0, 1)).toBe("air");
  });

  it("validates arguments", () => {
    const doc = newDoc();
    fill(doc, env, B([0, 0, 0], [1, 0, 0]), "stone");
    expect(() => rotate(doc, env, B([0, 0, 0], [1, 0, 0]), 0.5)).toThrow(/whole number/);
    expect(() => mirror(doc, env, B([0, 0, 0], [1, 0, 0]), "x", { about: 0.3 })).toThrow(/half/);
    expect(() => move(doc, env, B([0, 0, 0], [1, 0, 0]), [0.5, 0, 0] as Vec3)).toThrow(/integers/);
  });
});
