import { describe, expect, it } from "vitest";
import { buildFamilies, categorize, exclusionReason } from "../../../src/palette/families.js";
import { BUILTIN_PLUGINS } from "../../../src/plugins/builtin.js";
import { fakeRegistry, partial } from "../../helpers/registry.js";

const DYES = ["white", "light_gray", "gray", "black", "brown", "red", "orange", "yellow", "lime", "green", "cyan", "light_blue", "blue", "purple", "magenta", "pink"];

function sample() {
  return fakeRegistry([
    { id: "minecraft:andesite", tags: ["c:stones"] },
    partial("minecraft:andesite_stairs"),
    partial("minecraft:andesite_slab"),
    partial("minecraft:andesite_wall"),
    { id: "minecraft:polished_andesite" },
    { id: "minecraft:stone_bricks" },
    partial("minecraft:stone_brick_stairs"),
    { id: "minecraft:cracked_stone_bricks" },
    { id: "minecraft:mossy_stone_bricks" },
    partial("minecraft:mossy_stone_brick_stairs"),
    { id: "minecraft:oak_planks", tags: ["minecraft:planks"] },
    partial("minecraft:oak_stairs"),
    partial("minecraft:oak_door"),
    { id: "minecraft:oak_log", tags: ["minecraft:logs"] },
    { id: "minecraft:stripped_oak_log", tags: ["minecraft:logs"] },
    { id: "minecraft:oak_wood", tags: ["minecraft:logs"] },
    { id: "minecraft:copper_block" },
    { id: "minecraft:waxed_copper_block" },
    { id: "minecraft:exposed_copper" },
    // Chipped: variants tagged by base; Rechiseled: patterns with own shapes + connecting copies.
    { id: "chipped:andesite_bricks", tags: ["chipped:andesite"] },
    { id: "chipped:angry_andesite", tags: ["chipped:andesite"] },
    { id: "rechiseled:andesite_paving", tags: ["rechiseled:andesite"] },
    { id: "rechiseled:andesite_paving_connecting", tags: ["rechiseled:andesite"] },
    partial("rechiseled:andesite_paving_stairs", { tags: ["rechiseled:andesite", "rechiseled:andesite_stairs"] }),
    // A roof mod reusing the planks texture → extra shape.
    partial("mcwroofs:oak_roof", { faceTextures: { north: "minecraft:block/oak_planks" }, textures: ["minecraft:block/oak_planks"] }),
    partial("decor:table"),
    // Numbered variants.
    ...[0, 1, 2, 3].map((n) => ({ id: `xtones:zane_block_${n}` })),
    // Dye series.
    ...DYES.map((d) => ({ id: `minecraft:${d}_wool`, tags: ["minecraft:wool"] })),
    // Exclusions.
    { id: "minecraft:iron_ore", tags: ["c:ores"] },
    { id: "minecraft:furnace", faceTextures: { up: "minecraft:block/furnace_top", north: "minecraft:block/furnace_front", south: "minecraft:block/furnace_side", east: "minecraft:block/furnace_side", west: "minecraft:block/furnace_side" } },
    { id: "framedblocks:framed_cube" },
  ]);
}

describe("buildFamilies", () => {
  const reg = sample();
  const plugins = BUILTIN_PLUGINS.filter((p) => ["chipped", "rechiseled", "framedblocks"].includes(p.id));
  const { families, series, looseCount } = buildFamilies(reg, plugins);
  const fam = (id: string) => families.find((f) => f.id === id);

  it("groups shapes by suffix, including plural and planks bases", () => {
    expect(fam("minecraft:andesite")!.shapes).toEqual({
      stairs: "minecraft:andesite_stairs",
      slab: "minecraft:andesite_slab",
      wall: "minecraft:andesite_wall",
    });
    expect(fam("minecraft:stone_bricks")!.shapes.stairs).toBe("minecraft:stone_brick_stairs");
    expect(fam("minecraft:oak_planks")!.shapes).toMatchObject({ stairs: "minecraft:oak_stairs", door: "minecraft:oak_door" });
  });

  it("attaches variants from plugin tags, prefixes, wood forms and numbering", () => {
    const andesite = fam("minecraft:andesite")!;
    expect(andesite.variants.map((v) => v.base).sort()).toEqual(["chipped:andesite_bricks", "chipped:angry_andesite", "rechiseled:andesite_paving"]);
    expect(andesite.variants.find((v) => v.base === "rechiseled:andesite_paving")!.shapes.stairs).toBe("rechiseled:andesite_paving_stairs");
    expect(andesite.aliases).toContain("rechiseled:andesite_paving_connecting");

    const bricks = fam("minecraft:stone_bricks")!;
    expect(bricks.variants.map((v) => v.base).sort()).toEqual(["minecraft:cracked_stone_bricks", "minecraft:mossy_stone_bricks"]);
    expect(bricks.variants.find((v) => v.base === "minecraft:mossy_stone_bricks")!.shapes.stairs).toBe("minecraft:mossy_stone_brick_stairs");

    expect(fam("minecraft:oak_log")!.variants.map((v) => v.base).sort()).toEqual(["minecraft:oak_wood", "minecraft:stripped_oak_log"]);
    expect(fam("minecraft:copper_block")).toBeDefined();
    expect(fam("minecraft:copper_block")!.aliases).toContain("minecraft:waxed_copper_block");
    expect(fam("xtones:zane_block_0")!.variants).toHaveLength(3);

    // polished_andesite is a distinct material, not a variant.
    expect(fam("minecraft:polished_andesite")).toBeDefined();
  });

  it("links texture-sharing shapes from other mods as extras", () => {
    expect(fam("minecraft:oak_planks")!.extras).toEqual({ mcwroofs: ["mcwroofs:oak_roof"] });
    expect(looseCount).toBe(1); // decor:table
  });

  it("collapses dye colours into a series in dye order", () => {
    const wool = series.find((s) => s.id === "minecraft:*_wool")!;
    expect(wool.members).toHaveLength(16);
    expect(wool.members.slice(0, 4)).toEqual(["minecraft:white_wool", "minecraft:light_gray_wool", "minecraft:gray_wool", "minecraft:black_wool"]);
    expect(fam("minecraft:red_wool")!.series).toBe("minecraft:*_wool");
  });

  it("classifies and excludes non-building blocks", () => {
    expect(fam("minecraft:andesite")!.category).toBe("stone");
    expect(fam("minecraft:oak_planks")!.category).toBe("wood");
    expect(fam("minecraft:white_wool")!.category).toBe("colored");
    expect(fam("minecraft:iron_ore")).toMatchObject({ buildable: false, excludedBy: "ore" });
    expect(fam("minecraft:furnace")).toMatchObject({ buildable: false });
    expect(fam("framedblocks:framed_cube")).toMatchObject({ buildable: false, excludedBy: "plugin:framedblocks" });
  });

  it("is deterministic", () => {
    expect(buildFamilies(reg, plugins)).toEqual(buildFamilies(reg, plugins));
  });
});

describe("classification helpers", () => {
  const b = (id: string, extra = {}) => fakeRegistry([{ id, ...extra }]).get(id)!;
  it("categorizes by tags and name tokens", () => {
    expect(categorize(b("mod:sea_lantern_block", { light: 15 }))).toBe("light");
    expect(categorize(b("mod:tinted_glass"))).toBe("glass");
    expect(categorize(b("mod:steel_casing"))).toBe("metal");
    expect(categorize(b("mod:limestone_bricks"))).toBe("stone");
    expect(categorize(b("mod:thing"))).toBe("decor");
  });
  it("flags functional and directional blocks", () => {
    expect(exclusionReason(b("mod:crusher"))).toBe("functional");
    expect(exclusionReason(b("mod:marble"))).toBeUndefined();
    expect(exclusionReason(b("mod:chest_thing", { renderable: "fallback" }))).toBe("no-model");
  });
});
