/**
 * Asset pipeline goldens (docs/design/10-testing.md, tier 2; docs/design/02-assets-registry.md,
 * 03-palette.md) against the synthetic instance: VFS layer order, blockstate variants and
 * multipart, parent chains, tags, and the colour index.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYNTHETIC_LAYERS } from "../../scripts/gen-golden-instance.js";
import { expectJsonGolden } from "./harness.js";
import { loadSynthetic, type Synthetic } from "./instance.js";

let syn: Synthetic;
beforeAll(async () => {
  syn = await loadSynthetic();
});
afterAll(() => syn?.dispose());

describe("VFS layering", () => {
  it("orders layers like the game and ignores disabled jars and unselected packs", async () => {
    expect(syn.info).toMatchObject({ launcher: "vanilla", mcVersion: "1.21.1", warnings: [] });
    expect(syn.info.layers.map((l) => l.id)).toEqual([...SYNTHETIC_LAYERS]);
    expect(syn.stackWarnings).toEqual([]);
    // Layer i ships probe k for every k ≥ i, so probe k resolves to layer k.
    for (let k = 0; k < SYNTHETIC_LAYERS.length; k++) {
      expect((await syn.stack.read(`assets/golden/probe/${k}.txt`))?.toString(), `probe ${k}`).toBe(SYNTHETIC_LAYERS[k]);
    }
  });

  it("resolves real overrides from the right layer", () => {
    const from = (p: string) => syn.stack.resolve(p)?.id;
    expect(from("assets/minecraft/textures/block/oak_planks.png")).toBe("mod:a_golden.jar"); // mod over base
    expect(from("assets/golden/textures/block/marble.png")).toBe("mod:b_tweaks.jar"); // later mod over earlier
    expect(from("assets/minecraft/models/block/stone_bricks.json")).toBe("resourcepack:Restyle.zip");
    expect(from("assets/minecraft/textures/block/glass.png")).toBe("openloader:00_top.zip");
    expect(from("assets/kubejs/blockstates/crate.json")).toBe("generated:kubejs");
  });
});

describe("registry", () => {
  it("defines blocks only from defining layers", () => {
    const r = syn.registry;
    expect(r.has("absent:ghost")).toBe(false); // resource pack blockstate for a missing mod
    expect(r.get("kubejs:crate")?.source).toBe("generated:kubejs");
    expect(r.modName("golden")).toBe("Golden Test Blocks");
  });

  it("resolves parent chains, rotated variants, multipart and weighted lists", () => {
    const r = syn.registry;
    // golden:block/marble → polished → template → cube_all → cube, with #stone → #face → #all.
    expect(r.get("golden:marble")).toMatchObject({ shape: "full", renderable: "exact" });
    expect(Object.values(r.get("golden:marble")!.faceTextures)).toEqual(Array(6).fill("golden:block/marble"));
    // Resource pack restyle reaches the registry.
    expect(r.get("minecraft:stone_bricks")!.faceTextures.up).toBe("minecraft:block/restyled_bricks");
    // Default axis=y: ends up and down.
    expect(r.get("minecraft:oak_log")!.faceTextures).toMatchObject({ up: "minecraft:block/oak_log_top", north: "minecraft:block/oak_log" });
    // Multipart: vanilla properties from game data; mod properties from the conditions.
    expect(r.get("minecraft:stone_brick_wall")).toMatchObject({ shape: "partial", defaults: { up: "true", north: "none" } });
    expect(r.get("golden:marble_brick_wall")!.properties).toEqual({ up: ["true"], north: ["low", "tall"], east: ["low", "tall"], south: ["low", "tall"], west: ["low", "tall"] });
    expect(r.get("golden:lamp")).toMatchObject({ properties: { lit: ["false", "true"] }, defaults: { lit: "false" } });
    expect(r.get("golden:rubble")!.faceTextures.up).toBe("golden:block/rubble"); // first weighted entry
    expect(r.get("minecraft:grass_block")).toMatchObject({ tinted: true });
    expect(r.get("minecraft:chest")).toMatchObject({ shape: "none", renderable: "fallback" });
  });

  it("merges tags across layers with replace", () => {
    const ids = (t: string) => syn.registry.withTag(t).map((b) => b.id).sort();
    expect(ids("minecraft:logs")).toEqual(["golden:marble_pillar", "kubejs:crate", "minecraft:oak_log"]);
    expect(ids("golden:polished")).toEqual(["golden:marble", "golden:marble_bricks"]);
  });

  it("bakes switched and rotated states", async () => {
    const mean = async (s: string) => (await syn.baker.bake(s)).quads[0]!.tex.mean;
    expect((await mean("golden:lamp[lit=true]"))[0]).toBeGreaterThan((await mean("golden:lamp[lit=false]"))[0] + 100);
    const x = await syn.baker.bake("minecraft:oak_log[axis=x]");
    const endFaces = x.quads.filter((q) => q.tex.mean[0] > 140).map((q) => q.cull).sort(); // end grain is lighter than bark
    expect(endFaces).toEqual(["east", "west"]);
  });

  it("matches the registry golden", async () => {
    const blocks = [...syn.registry.all()]
      .filter((b) => b.source !== "vanilla-data")
      .map((b) => ({ id: b.id, source: b.source, shape: b.shape, renderable: b.renderable, defaults: b.defaults, faces: b.faceTextures, tags: b.tags, tinted: b.tinted || undefined }));
    await expectJsonGolden("assets/registry", { warnings: syn.registry.data.warnings, blocks });
  });
});

describe("colour index", () => {
  it("measures families from their textures", () => {
    const p = syn.palette;
    const stats = (id: string) => p.stats(id)!;
    expect(stats("minecraft:glass").translucency).toBeGreaterThan(0.5);
    expect(stats("minecraft:stone").translucency).toBe(0);
    expect(stats("minecraft:glowstone").light).toBe(15);
    expect(stats("minecraft:grass_block").lab[1]).toBeLessThan(0); // grey top tinted green by our colormap
    expect(stats("golden:marble").lab[2]).toBeLessThan(0); // b_tweaks' lilac marble, not a_golden's
    expect(p.series.get("minecraft:*_wool")?.members).toHaveLength(16);
    expect(p.family("minecraft:stone_bricks")).toMatchObject({ shapes: { stairs: "minecraft:stone_brick_stairs", slab: "minecraft:stone_brick_slab", wall: "minecraft:stone_brick_wall" } });
    expect(p.family("golden:marble")!.variants.map((v) => v.base)).toEqual(["golden:chiseled_marble"]);
  });

  it("matches the palette golden", async () => {
    const families = syn.palette.buildable().map((f) => ({
      id: f.id,
      shapes: f.shapes,
      variants: f.variants.map((v) => v.base),
      series: f.series,
      stats: syn.palette.stats(f.id),
    }));
    await expectJsonGolden("assets/palette", { families, series: [...syn.palette.series.values()] });
  });
});
