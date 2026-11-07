import { describe, expect, it } from "vitest";
import { Mask } from "../../../src/core/mask.js";
import { fromPublic } from "../../../src/core/region.js";
import { Document } from "../../../src/document/document.js";
import { fill, setBlocks } from "../../../src/ops/edit.js";
import { formatRegionSummary, queryBlock, queryColumn, regionSummary } from "../../../src/perception/query.js";
import { fakeRegistry } from "../../helpers/registry.js";

const registry = fakeRegistry([{ id: "minecraft:stone" }, { id: "minecraft:oak_planks" }, { id: "minecraft:chest", properties: { facing: ["north", "south"] }, defaults: { facing: "north" } }]);
const B = (min: [number, number, number], max: [number, number, number]) => fromPublic({ min, max });

function doc() {
  const d = Document.create({ name: "q", dataVersion: 3955, seed: 1 });
  fill(d, {}, B([0, 0, 0], [3, 0, 3]), "minecraft:stone", { as: "base" });
  fill(d, {}, B([0, 1, 0], [0, 3, 0]), "minecraft:oak_planks", { as: "post" });
  setBlocks(d, {}, [{ pos: [2, 1, 2], block: "minecraft:chest[facing=south]" }]);
  d.edit("nbt", "nbt", (tx) =>
    tx.set(2, 1, 2, "minecraft:chest[facing=south]", { type: "compound", name: "", value: { id: { type: "string", value: "minecraft:chest" }, Items: { type: "list", value: { type: "compound", value: [{}, {}] } } } } as never),
  );
  setBlocks(d, {}, [{ pos: [1, 5, 1], block: "mod:mystery" }]);
  return d;
}

describe("queries", () => {
  it("query_block: state, NBT summary, components and unknown blocks", () => {
    const d = doc();
    expect(queryBlock(d, registry, [0, 2, 0])).toBe("(0,2,0) oak_planks · in: post");
    expect(queryBlock(d, registry, [0, 0, 0])).toBe("(0,0,0) stone · in: base");
    expect(queryBlock(d, registry, [2, 1, 2])).toBe('(2,1,2) chest[facing=south] · nbt: minecraft:chest {Items[2]}');
    expect(queryBlock(d, registry, [1, 5, 1])).toBe("(1,5,1) mod:mystery · (unknown block: kept verbatim)");
    expect(queryBlock(d, registry, [9, 9, 9])).toBe("(9,9,9) air · (outside the document bounds)");
  });

  it("query_column: bottom-to-top runs", () => {
    const d = doc();
    expect(queryColumn(d, registry, 0, 0)).toBe("column (0,0) bottom→top: y0 stone, y1-3 oak_planks, y4-5 air");
    expect(queryColumn(d, registry, 1, 1)).toBe("column (1,1) bottom→top: y0 stone, y1-4 air, y5 mod:mystery");
    expect(queryColumn(d, registry, 20, 20)).toBe("column (20,20) y 0..5: all air (outside the document bounds)");
    expect(queryColumn(Document.create({ name: "e", dataVersion: 1 }), registry, 0, 0)).toBe("The document is empty.");
  });

  it("query_region: counts by family and role, bbox and components", () => {
    const d = doc();
    d.palettes.set({ name: "p", roles: { floor: [{ family: "minecraft:stone", block: "minecraft:stone", weight: 1 }] }, source: { sheet: "overview" } as never });
    const s = regionSummary(d, Mask.fromBox(B([0, 0, 0], [3, 1, 3])), { registry });
    expect(s.solid).toBe(16 + 1 + 1);
    expect(s.families).toEqual([["minecraft:stone", 16], ["minecraft:chest", 1], ["minecraft:oak_planks", 1]]);
    expect(s.roles).toEqual([["p.floor", 16]]);
    expect(s.inside).toEqual(["base"]);
    expect(s.touching).toEqual(["post"]);
    expect(formatRegionSummary(s, registry)).toBe(
      [
        "region: 32 positions, 18 blocks (56% solid) · blocks in (0,0,0)–(3,1,3) = 4×2×4",
        "by family: stone 16, chest 1, oak_planks 1",
        "by role: p.floor 16",
        "components inside: base",
        "components partly inside: post",
      ].join("\n"),
    );
    expect(formatRegionSummary(regionSummary(d, Mask.fromBox(B([5, 5, 5], [6, 6, 6]))))).toBe("region: 8 positions, all air");
  });
});
