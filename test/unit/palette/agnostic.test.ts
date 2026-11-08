/**
 * Instance-agnostic ingestion: every rule here runs without plugins, on data shaped like what
 * real modpacks ship (Chipped/Rechiseled-style variant tags, camo mods, reinforced copies,
 * extra-dye mods, behaviour-only glass variants, oversized packs).
 */
import { describe, expect, it } from "vitest";
import { buildFamilies, detectPlaceholderTextures, detectVariantTagNamespaces } from "../../../src/palette/families.js";
import { PaletteIndex, type FamilyStats } from "../../../src/palette/index.js";
import { layoutSheet, MAX_COLUMNS, ROWS_PER_PAGE } from "../../../src/palette/sheet.js";
import { fakeRegistry, partial } from "../../helpers/registry.js";

const DYES = ["white", "light_gray", "gray", "black", "brown", "red", "orange", "yellow", "lime", "green", "cyan", "light_blue", "blue", "purple", "magenta", "pink"];

describe("variant-tag detection (no plugins)", () => {
  const bases = ["andesite", "granite", "diorite", "stone", "cobblestone", "oak_planks"];
  const reg = fakeRegistry([
    ...bases.map((b) => ({ id: `minecraft:${b}` })),
    // A decorative mod tags its patterns by the vanilla base block.
    ...bases.flatMap((b) => ["fancy", "carved", "tiled", "rough"].map((p) => ({ id: `decomod:${p}_${b}`, tags: [`decomod:${b}`] }))),
    // A tech mod's tags that merely mention vanilla names must not count.
    { id: "techmod:machine_a", tags: ["techmod:stone"] },
    { id: "minecraft:dirt", tags: ["techmod:stone"] },
  ]);

  it("finds namespaces whose tags group their own blocks under another mod's base", () => {
    expect(detectVariantTagNamespaces(reg)).toEqual(["decomod"]);
  });

  it("groups those variants without any plugin", () => {
    const { families } = buildFamilies(reg, []);
    const andesite = families.find((f) => f.id === "minecraft:andesite")!;
    expect(andesite.variants.map((v) => v.base).sort()).toEqual(["decomod:carved_andesite", "decomod:fancy_andesite", "decomod:rough_andesite", "decomod:tiled_andesite"]);
    expect(families.some((f) => f.id.startsWith("decomod:"))).toBe(false);
  });
});

describe("variant tags with no block of their name", () => {
  // A decorative mod's tag "fancy_bricks" names no block, but lists the vanilla bricks it carves
  // from besides its own patterns; the same bricks are also in its "bricks" tag.
  const bases = ["andesite", "granite", "diorite", "stone", "bricks"];
  const reg = fakeRegistry([
    ...bases.map((b) => ({ id: `minecraft:${b}`, tags: [`decomod:${b}`, ...(b === "bricks" ? ["decomod:fancy_bricks"] : [])] })),
    ...bases.flatMap((b) => ["carved", "tiled", "rough", "worn"].map((p) => ({ id: `decomod:${p}_${b}`, tags: [`decomod:${b}`] }))),
    ...["angry", "plain", "split"].map((p) => ({ id: `decomod:${p}_fancy_bricks`, tags: ["decomod:fancy_bricks"] })),
    { id: "othermod:loose_a", tags: ["decomod:loose"] },
    { id: "decomod:loose_b", tags: ["decomod:loose"] },
    { id: "decomod:loose_c", tags: ["decomod:loose"] },
  ]);
  const { families } = buildFamilies(reg, []);

  it("keeps the vanilla block at the head, with the mod-only patterns as its variants", () => {
    const bricks = families.find((f) => f.id === "minecraft:bricks");
    expect(bricks).toBeDefined();
    expect(families.some((f) => f.variants.some((v) => v.base === "minecraft:bricks"))).toBe(false);
    expect(bricks!.variants.map((v) => v.base)).toEqual(expect.arrayContaining(["decomod:angry_fancy_bricks", "decomod:carved_bricks"]));
  });
  it("heads a group of only the tagging mod's blocks with its first member, unless another mod's block is in it", () => {
    expect(families.find((f) => f.id === "othermod:loose_a")?.variants.map((v) => v.base).sort()).toEqual(["decomod:loose_b", "decomod:loose_c"]);
  });
});

describe("placeholder textures (camo/frame mods)", () => {
  const shapes = ["slope", "corner", "panel", "pillar", "post", "rail_slope", "prism", "pyramid", "half_stairs", "slab_edge", "ladder", "sign", "flower_pot", "lever", "chest"];
  const frame = "framemod:block/frame";
  const reg = fakeRegistry([
    { id: "framemod:frame_cube", faceTextures: { north: frame, up: frame }, textures: [frame] },
    ...shapes.map((s) => partial(`framemod:frame_${s}`, { faceTextures: { north: frame }, textures: [frame] })),
    { id: "minecraft:stone" },
  ]);
  it("detects a texture shared by many unrelated partial blocks of one mod", () => {
    expect([...detectPlaceholderTextures(reg)]).toEqual([frame]);
  });
  it("excludes families skinned with it", () => {
    const { families } = buildFamilies(reg, []);
    expect(families.find((f) => f.id === "framemod:frame_cube")).toMatchObject({ buildable: false, excludedBy: "placeholder-texture" });
    expect(families.find((f) => f.id === "minecraft:stone")!.buildable).toBe(true);
  });
});

describe("visual duplicates", () => {
  const granite = "minecraft:block/granite";
  const plastic = "plasticmod:block/plastic";
  const reg = fakeRegistry([
    { id: "minecraft:granite" },
    partial("minecraft:granite_stairs"),
    // Reinforced copy: same textures, tinted in code by another mod.
    { id: "secmod:reinforced_granite", tinted: true, faceTextures: { up: granite, down: granite, north: granite, south: granite, east: granite, west: granite } },
    // Code-dyed set sharing one texture inside one mod: must stay apart.
    ...DYES.map((d) => ({ id: `plasticmod:${d}_plastic`, tinted: true, faceTextures: { up: plastic, down: plastic, north: plastic, south: plastic, east: plastic, west: plastic } })),
  ]);
  const { families, series } = buildFamilies(reg, []);

  it("folds tinted copies into an untinted twin from another mod", () => {
    expect(families.find((f) => f.id === "secmod:reinforced_granite")).toBeUndefined();
    expect(families.find((f) => f.id === "minecraft:granite")!.aliases).toContain("secmod:reinforced_granite");
  });
  it("keeps code-dyed sets that share a texture", () => {
    expect(families.filter((f) => f.id.startsWith("plasticmod:"))).toHaveLength(16);
    expect(series.find((s) => s.id === "plasticmod:*_plastic")?.members).toHaveLength(16);
  });
});

describe("dye series", () => {
  const extraDyes = ["peach", "aquamarine", "fluorescent", "amber", "rose", "mint", "maroon", "navy", "bubblegum", "lavender"];
  const glass = (variant: string, d: string) => `minecraft:block/${d}_stained_glass`;
  const reg = fakeRegistry([
    ...DYES.map((d) => ({ id: `minecraft:${d}_wool` })),
    // Extra-dye mod: unknown colour words, known series suffix.
    ...extraDyes.map((d) => ({ id: `dyemod:${d}_wool` })),
    // Behaviour-only variants of code-tinted glass (like EnderIO's fused glass): three series, identical looks.
    ...["", "glow_", "dark_"].flatMap((v) =>
      DYES.map((d) => {
        const t = "glassmod:block/clear_glass";
        return { id: `glassmod:${v}${d}_glass`, tinted: true, faceTextures: { up: t, down: t, north: t, south: t, east: t, west: t } };
      }),
    ),
    // The same, untinted: folded already at family level.
    ...["", "dark_"].flatMap((v) =>
      DYES.map((d) => {
        const t = glass(v, d);
        return { id: `plainglass:${v}${d}_pane_block`, faceTextures: { up: t, down: t, north: t, south: t, east: t, west: t } };
      }),
    ),
  ]);
  const { families, series } = buildFamilies(reg, []);

  it("does not turn other mods' colour sets into suffix magnets", () => {
    const reg2 = fakeRegistry([
      ...DYES.map((d) => ({ id: `minecraft:${d}_wool` })),
      // A mod with dye-coloured planks forms its own series…
      ...DYES.map((d) => ({ id: `colormod:${d}_planks` })),
      // …but vanilla and other woods must stay ordinary families.
      ...["oak", "spruce", "birch", "jungle", "acacia", "dark_oak", "mangrove", "cherry"].map((w) => ({ id: `minecraft:${w}_planks`, tags: ["minecraft:planks"] })),
      ...["fir", "maple", "willow", "palm", "redwood", "ebony", "cypress", "aspen"].map((w) => ({ id: `woodmod:${w}_planks`, tags: ["minecraft:planks"] })),
    ]);
    const r = buildFamilies(reg2, []);
    expect(r.series.map((s) => s.id).sort()).toEqual(["colormod:*_planks", "minecraft:*_wool"]);
    expect(r.families.find((f) => f.id === "minecraft:oak_planks")).toMatchObject({ category: "wood" });
    expect(r.families.find((f) => f.id === "minecraft:oak_planks")!.series).toBeUndefined();
    expect(r.families.find((f) => f.id === "woodmod:fir_planks")!.series).toBeUndefined();
  });

  it("adds extra-dye mods as a series by suffix", () => {
    expect(series.find((s) => s.id === "dyemod:*_wool")?.members).toHaveLength(10);
    expect(families.find((f) => f.id === "dyemod:peach_wool")!.category).toBe("colored");
  });

  it("folds series that look identical", () => {
    const kept = series.filter((s) => s.id.startsWith("glassmod:"));
    const primary = kept.find((s) => s.duplicates?.length)!;
    expect(primary.duplicates).toHaveLength(2);
    const dupMembers = families.filter((f) => f.excludedBy?.startsWith("duplicate-of:"));
    expect(dupMembers).toHaveLength(32);
    // Untinted look-alikes fold per family before series form.
    expect(families.filter((f) => f.id.startsWith("plainglass:"))).toHaveLength(16);
  });
});

describe("one-page overview budget", () => {
  it("folds near-identical families when a pack overflows the page", () => {
    // 1600 wood families with stairs, in tight colour clusters — more than one page can hold.
    const specs = [];
    for (let i = 0; i < 1600; i++) specs.push({ id: `woodmod:wood${i}_planks`, tags: ["minecraft:planks"] }, partial(`woodmod:wood${i}_stairs`));
    const reg = fakeRegistry(specs);
    const built = buildFamilies(reg, []);
    const stats: Record<string, FamilyStats> = {};
    built.families.forEach((f, i) => {
      const cluster = i % 60; // 60 distinct looks, ~27 near-copies each
      stats[f.id] = { rgb: [0, 0, 0], lab: [30 + (cluster % 10) * 6, (cluster % 6) * 8, 20 + (i % 3) * 0.5], noise: 5, translucency: 0, light: 0 };
    });
    const index = new PaletteIndex({ cacheVersion: "t", fingerprint: "t", families: built.families, series: built.series, stats, looseCount: 0 }, reg);
    const l = layoutSheet(index, { sheet: "overview" });
    expect(l.pages).toBe(1);
    expect(l.rows).toBeLessThanOrEqual(ROWS_PER_PAGE);
    expect(l.columns).toBeLessThanOrEqual(MAX_COLUMNS);
    const folded = l.cells.flat().reduce((n, c) => n + (c?.kind === "family" ? (c.similar?.length ?? 0) : 0), 0);
    expect(folded + l.total).toBe(1600);

    const withSimilar = l.cells.flat().find((c) => c?.kind === "family" && c.similar?.length)!;
    const sim = layoutSheet(index, { sheet: `similar:${(withSimilar as { id: string }).id}` });
    expect(sim.total).toBe(1 + (withSimilar as { similar: string[] }).similar.length);
  });
});
