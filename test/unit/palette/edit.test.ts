import { describe, expect, it } from "vitest";
import { editPalette, pickPalette } from "../../../src/palette/pick.js";
import { libraryContext } from "../library/fixture.js";

describe("palette_edit", () => {
  it("adds and removes cells, reweights, swaps, renames and drops roles", async () => {
    const c = await libraryContext();
    const base = pickPalette(c.palette, { name: "p", sheet: "family:minecraft:andesite", roles: { wall: "A1", roof: "A1" } }).palette;
    expect(base.roles.wall).toEqual([{ family: "minecraft:andesite", block: "minecraft:andesite", weight: 1 }]);

    // add a cell from another sheet: it joins at the weight of one existing member
    const granite = editPalette(c.palette, base, { sheet: "family:minecraft:granite", add: { wall: "A1" } });
    expect(granite.palette.roles.wall!.map((m) => [m.block, m.weight])).toEqual([["minecraft:andesite", 0.5], ["minecraft:granite", 0.5]]);
    expect(base.roles.wall!.length).toBe(1); // the input is not mutated

    const weighted = editPalette(c.palette, granite.palette, { weights: { wall: { granite: 3, andesite: 1 } } });
    expect(weighted.palette.roles.wall!.map((m) => [m.block, m.weight])).toEqual([["minecraft:andesite", 0.25], ["minecraft:granite", 0.75]]);

    const removed = editPalette(c.palette, weighted.palette, { remove: { wall: ["andesite", "oak_planks"] } });
    expect(removed.palette.roles.wall).toEqual([{ family: "minecraft:granite", block: "minecraft:granite", weight: 1 }]);
    expect(removed.warnings).toEqual(["wall: oak_planks is not in the role"]);

    const swapped = editPalette(c.palette, base, { sheet: "family:minecraft:oak_planks", swap: { roof: "A1" }, rename: { wall: "walls" } });
    expect(swapped.palette.roles).toEqual({
      walls: [{ family: "minecraft:andesite", block: "minecraft:andesite", weight: 1 }],
      roof: [{ family: "minecraft:oak_planks", block: "minecraft:oak_planks", weight: 1 }],
    });

    const dropped = editPalette(c.palette, base, { drop: ["roof"] });
    expect(Object.keys(dropped.palette.roles)).toEqual(["wall"]);
    expect(() => editPalette(c.palette, base, { drop: ["glass"] })).toThrow(/no role "glass"/);
    // removing every member deletes the role, with a warning
    expect(editPalette(c.palette, base, { remove: { roof: "A1" } }).warnings).toEqual(["roof: every member removed; role deleted"]);
  });
});
