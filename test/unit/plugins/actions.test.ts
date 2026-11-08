import { describe, expect, it } from "vitest";
import type { Compound } from "prismarine-nbt";
import { Document } from "../../../src/document/document.js";
import { materialList } from "../../../src/formats/materials.js";
import { snapshotOf } from "../../../src/formats/snapshot.js";
import { runPluginAction } from "../../../src/ops/plugin-actions.js";
import { buildFamilies } from "../../../src/palette/families.js";
import { PaletteIndex } from "../../../src/palette/index.js";
import { TextureLoader } from "../../../src/palette/textures.js";
import { BlockBaker } from "../../../src/perception/render/bake.js";
import { renderDocument } from "../../../src/perception/render/render.js";
import { formatActionList } from "../../../src/plugins/actions.js";
import { BUILTIN_PLUGINS } from "../../../src/plugins/builtin.js";
import { patternName } from "../../../src/plugins/chisel.js";
import { readCopycatCamo, readFramedCamo, writeCopycatCamo } from "../../../src/plugins/framed.js";
import { activePlugins, documentNbtWarnings, validateNbt } from "../../../src/plugins/types.js";
import { solidPng } from "../../helpers/fixtures.js";
import { fakeRegistry, partial } from "../../helpers/registry.js";
import { memStack, VANILLA_PARENTS } from "../../helpers/stack.js";

const stairs = (id: string, tags: string[] = []) =>
  partial(id, { properties: { facing: ["north", "south", "west", "east"], half: ["top", "bottom"] }, defaults: { facing: "north", half: "bottom" }, tags });

/** Synthetic registry named like FramedBlocks, Copycats+, Chipped and Rechiseled (no assets). */
const registry = fakeRegistry([
  { id: "minecraft:stone" },
  { id: "minecraft:andesite", tags: ["chipped:andesite"] },
  { id: "minecraft:granite", tags: ["chipped:granite"] },
  ...["andesite", "granite"].flatMap((b) => ["carved", "tiled"].map((p) => ({ id: `chipped:${p}_${b}`, tags: [`chipped:${b}`] }))),
  { id: "chipped:andesite_bricks", tags: ["chipped:andesite"] },
  stairs("minecraft:andesite_stairs", ["rechiseled:andesite_stairs"]),
  stairs("rechiseled:andesite_bricks_stairs", ["rechiseled:andesite_stairs"]),
  { id: "minecraft:stone_bricks" },
  { id: "minecraft:mossy_stone_bricks" },
  { id: "minecraft:cracked_stone_bricks" },
  partial("framedblocks:framed_slope"),
  partial("framedblocks:framed_slab"),
  { id: "framedblocks:framed_cube" },
  partial("copycats:copycat_slope"),
  partial("create:copycat_step"),
  { id: "chisel:marker" },
]);
const plugins = activePlugins(BUILTIN_PLUGINS, registry);
const families = buildFamilies(registry, plugins);
const index = new PaletteIndex({ cacheVersion: "t", fingerprint: "t", families: families.families, series: families.series, stats: {}, looseCount: 0 }, registry);
const env = { registry, index, plugins };
const newDoc = () => Document.create({ name: "t", dataVersion: 3955, seed: 3 });
const sel = (min: number[], max: number[]) => ({ min, max });
const camoState = (nbt: Compound | undefined) => (nbt ? readFramedCamo(nbt) : undefined);

describe("plugin ops registry", () => {
  it("lists framed, copycat and chisel ops under their op prefixes", () => {
    const t = formatActionList(plugins);
    for (const op of ["framed.shape", "framed.camo", "copycat.shape", "copycat.camo", "chisel.pattern", "chisel.randomize"]) expect(t).toContain(`${op}(`);
    expect(formatActionList(plugins, "framed")).toContain("2 plugin ops for framed");
    expect(formatActionList(plugins, "framedblocks")).toContain("framed.shape(sel");
  });

  it("rejects unknown ops and bad arguments without touching the document", async () => {
    const doc = newDoc();
    await expect(runPluginAction(doc, env, "framed.nope", {})).rejects.toThrow(/no plugin op "framed.nope"; available: .*framed.shape/);
    await expect(runPluginAction(doc, env, "framed.shape", { sel: "all" })).rejects.toThrow(/bad arguments for framed.shape: shape/);
    expect(doc.journal.headSeq).toBe(0);
  });
});

describe("framed blocks", () => {
  it("places framed shapes with the camo in NBT as one undoable entry", async () => {
    const doc = newDoc();
    const r = await runPluginAction(doc, env, "framed.shape", { sel: sel([0, 0, 0], [2, 0, 0]), shape: "slope", camo: "stone", state: "facing=east,type=top" });
    expect(r.changed).toBe(3);
    expect(r.op).toBe("framed.shape");
    for (const x of [0, 1, 2]) {
      expect(doc.getState(x, 0, 0)).toBe("framedblocks:framed_slope[facing=east,type=top]");
      const nbt = doc.getBlockEntity(x, 0, 0)!;
      expect(nbt.value.id).toEqual({ type: "string", value: "framedblocks:framed_tile" });
      expect(nbt.value.camo).toEqual({
        type: "compound",
        value: { type: { type: "string", value: "framedblocks:block" }, state: { type: "compound", value: { Name: { type: "string", value: "minecraft:stone" } } } },
      });
    }
    doc.undo();
    expect(doc.getState(0, 0, 0)).toBe("minecraft:air");
    expect(doc.getBlockEntity(0, 0, 0)).toBeUndefined();
  });

  it("re-skins only framed blocks and lists unknown shapes", async () => {
    const doc = newDoc();
    await runPluginAction(doc, env, "framed.shape", { sel: sel([0, 0, 0], [0, 0, 0]), shape: "framed_cube" });
    doc.edit("set", "stone", (tx) => tx.set(1, 0, 0, "minecraft:stone"));
    const r = await runPluginAction(doc, env, "framed.camo", { sel: sel([0, 0, 0], [1, 0, 0]), camo: "andesite" });
    expect(r.changed).toBe(1);
    expect(camoState(doc.getBlockEntity(0, 0, 0))).toBe("minecraft:andesite");
    expect(doc.getState(1, 0, 0)).toBe("minecraft:stone");
    await expect(runPluginAction(doc, env, "framed.shape", { sel: "all", shape: "pyramid" })).rejects.toThrow(/no framed block shape "pyramid"; shapes: cube, slab, slope/);
    const w = await runPluginAction(doc, env, "framed.camo", { sel: sel([0, 0, 0], [0, 0, 0]), camo: "mystery:block" });
    expect(w.warnings).toContain("camo mystery:block is not a block in this instance (kept)");
  });

  it("lists frame plus camo in the material list", async () => {
    const doc = newDoc();
    await runPluginAction(doc, env, "framed.shape", { sel: sel([0, 0, 0], [1, 0, 0]), shape: "slab", camo: "stone_bricks" });
    await runPluginAction(doc, env, "copycat.shape", { sel: sel([0, 1, 0], [0, 1, 0]), shape: "slope", material: "andesite" });
    const m = materialList(snapshotOf(doc), plugins);
    expect(m.items).toEqual(
      expect.arrayContaining([
        { item: "framedblocks:framed_slab", count: 2 },
        { item: "minecraft:stone_bricks", count: 2 },
        { item: "copycats:copycat_slope", count: 1 },
        { item: "minecraft:andesite", count: 1 },
      ]),
    );
  });

  it("warns about camo NBT it can't read, on import and export", () => {
    const doc = newDoc();
    const odd: Compound = { type: "compound", name: "", value: { camo: { type: "string", value: "??" } } };
    doc.edit("set", "odd", (tx) => tx.set(0, 0, 0, "framedblocks:framed_cube", odd));
    expect(validateNbt(plugins, "framedblocks:framed_cube", odd)).toEqual(["framedblocks: framedblocks:framed_cube: camo NBT not understood (its layout is unverified, 09)"]);
    expect(documentNbtWarnings(plugins, doc)).toHaveLength(1);
  });
});

describe("copycats", () => {
  it("writes Create's Material and Item layout and reads multi-part data", async () => {
    const doc = newDoc();
    await runPluginAction(doc, env, "copycat.shape", { sel: sel([0, 0, 0], [0, 0, 0]), shape: "step", material: "granite" });
    expect(doc.getState(0, 0, 0)).toBe("create:copycat_step");
    const nbt = doc.getBlockEntity(0, 0, 0)!;
    expect(nbt.value).toEqual({
      id: { type: "string", value: "create:copycat" },
      Material: { type: "compound", value: { Name: { type: "string", value: "minecraft:granite" } } },
      Item: { type: "compound", value: { id: { type: "string", value: "minecraft:granite" }, count: { type: "int", value: 1 } } },
    });
    const multi: Compound = {
      type: "compound",
      value: { material_data: { type: "compound", value: { part_a: { type: "compound", value: { material: { type: "compound", value: { Name: { type: "string", value: "minecraft:stone" } } } } } } } },
    };
    expect(readCopycatCamo(multi)).toBe("minecraft:stone");
  });

  it("writes the material into every part of an imported multi-part copycat", async () => {
    const s = (value: string) => ({ type: "string" as const, value });
    const state = (name: string) => ({ type: "compound" as const, value: { Name: s(name) } });
    const imported: Compound = {
      type: "compound",
      value: {
        id: s("copycats:copycat"),
        material_data: {
          type: "compound",
          value: {
            top: { type: "compound", value: { material: state("minecraft:stone"), enable_ct: { type: "byte", value: 1 } } },
            bottom: { type: "compound", value: { material: state("minecraft:air") } },
          },
        },
      },
    };
    const doc = newDoc();
    doc.edit("set", "imported", (tx) => tx.set(0, 0, 0, "copycats:copycat_slope", imported));
    await runPluginAction(doc, env, "copycat.camo", { sel: sel([0, 0, 0], [0, 0, 0]), material: "granite" });
    const granite = { material: state("minecraft:granite"), item: { type: "compound", value: { id: s("minecraft:granite"), count: { type: "int", value: 1 } } } };
    const nbt = doc.getBlockEntity(0, 0, 0)!;
    expect(nbt.value).toEqual({
      id: s("copycats:copycat"),
      material_data: { type: "compound", value: { top: { type: "compound", value: { ...granite, enable_ct: { type: "byte", value: 1 } } }, bottom: { type: "compound", value: granite } } },
    });
    expect(readCopycatCamo(nbt)).toBe("minecraft:granite");
    // Clearing keeps the parts and their other keys.
    const cleared = writeCopycatCamo("copycats:copycat_slope", undefined, nbt);
    expect(cleared.value.material_data).toEqual({ type: "compound", value: { top: { type: "compound", value: { enable_ct: { type: "byte", value: 1 } } }, bottom: { type: "compound", value: {} } } });
    expect(readCopycatCamo(cleared)).toBeUndefined();
    // An empty material_data is not multi-part: the single-material layout is written.
    const fresh = writeCopycatCamo("copycats:copycat_slope", "minecraft:stone", { type: "compound", value: { material_data: { type: "compound", value: {} } } });
    expect(fresh.value.Material).toEqual(state("minecraft:stone"));
  });
});

describe("camo rendering", () => {
  const STONE: [number, number, number] = [120, 120, 120];
  const FRAME: [number, number, number] = [200, 150, 60];
  async function baker() {
    const stack = await memStack([
      [
        "base",
        "base",
        {
          ...VANILLA_PARENTS,
          "assets/minecraft/blockstates/stone.json": { variants: { "": { model: "minecraft:block/stone" } } },
          "assets/minecraft/models/block/stone.json": { parent: "block/cube_all", textures: { all: "minecraft:block/stone" } },
          "assets/minecraft/textures/block/stone.png": solidPng(STONE),
          "assets/framedblocks/textures/block/framed_block.png": solidPng(FRAME),
        },
      ],
    ]);
    return new BlockBaker(stack, new TextureLoader(stack), undefined, registry, plugins);
  }
  const camo = (state: string): Compound => ({
    type: "compound",
    value: { camo: { type: "compound", value: { type: { type: "string", value: "framedblocks:block" }, state: { type: "compound", value: { Name: { type: "string", value: state } } } } } },
  });

  it("draws a framed slope as stepped geometry with the camo's texture", async () => {
    const b = await baker();
    const at = await b.bakeAt([0, 0, 0], "framedblocks:framed_slope[facing=north,type=bottom]", camo("minecraft:stone"));
    expect(at.fallback).toBe(false);
    expect(at.quads).toHaveLength(24);
    expect(new Set(at.quads.map((q) => q.tex.mean.join(",")))).toEqual(new Set([STONE.join(",")]));
    const tops = at.quads.map((q) => Math.max(q.pos[1]!, q.pos[4]!, q.pos[7]!, q.pos[10]!));
    expect(Math.max(...tops)).toBe(1);
    // Without NBT the shape keeps its placeholder frame texture.
    const empty = await b.bake("framedblocks:framed_slope[facing=north,type=bottom]");
    expect(new Set(empty.quads.map((q) => q.tex.mean.join(",")))).toEqual(new Set([FRAME.join(",")]));
  });

  it("renders block entities through bakeAt", async () => {
    const b = await baker();
    const doc = newDoc();
    await runPluginAction(doc, env, "framed.shape", { sel: sel([0, 0, 0], [1, 0, 1]), shape: "cube", camo: "stone" });
    const r = await renderDocument(doc, b, { views: ["top"], size: 128 });
    expect(r.caption).not.toContain("no model");
    const { PNG } = await import("pngjs");
    const p = PNG.sync.read(r.png);
    const i = (Math.floor(p.height / 2) * p.width + Math.floor(p.width / 2)) * 4;
    expect([p.data[i], p.data[i + 1], p.data[i + 2]]).toEqual(STONE);
  });
});

describe("chisel ops", () => {
  it("names patterns relative to their group", () => {
    expect(patternName("chipped:carved_andesite", "andesite")).toBe("carved");
    expect(patternName("rechiseled:andesite_bricks_stairs", "andesite_stairs")).toBe("bricks");
    expect(patternName("minecraft:andesite", "andesite")).toBe("base");
  });

  it("converts each block within its own tag group, keeping states, and back to base", async () => {
    const doc = newDoc();
    doc.edit("set", "setup", (tx) => {
      tx.set(0, 0, 0, "minecraft:andesite");
      tx.set(1, 0, 0, "minecraft:granite");
      tx.set(2, 0, 0, "minecraft:stone");
      tx.set(3, 0, 0, "minecraft:andesite_stairs[facing=east,half=top]");
    });
    const r = await runPluginAction(doc, env, "chisel.pattern", { sel: sel([0, 0, 0], [2, 0, 0]), pattern: "carved" });
    expect([0, 1, 2].map((x) => doc.getState(x, 0, 0))).toEqual(["chipped:carved_andesite", "chipped:carved_granite", "minecraft:stone"]);
    expect(r.warnings).toEqual(["1 block is in no variant group (left as is)"]);
    await runPluginAction(doc, env, "chisel.pattern", { sel: sel([3, 0, 0], [3, 0, 0]), pattern: "bricks" });
    expect(doc.getState(3, 0, 0)).toBe("rechiseled:andesite_bricks_stairs[facing=east,half=top]");
    await runPluginAction(doc, env, "chisel.pattern", { sel: "all", pattern: "base", from: "chipped:carved_granite" });
    expect([0, 1].map((x) => doc.getState(x, 0, 0))).toEqual(["chipped:carved_andesite", "minecraft:granite"]);
    await expect(runPluginAction(doc, env, "chisel.pattern", { sel: "all", pattern: "fluted" })).rejects.toThrow('no block in the selection has pattern "fluted"; e.g. chipped:carved_andesite has base, bricks, carved, tiled');
  });

  it("falls back to palette family variants for blocks in no tag group", async () => {
    const doc = newDoc();
    doc.edit("set", "setup", (tx) => tx.set(0, 0, 0, "minecraft:stone_bricks"));
    await runPluginAction(doc, env, "chisel.pattern", { sel: "all", pattern: "mossy" });
    expect(doc.getState(0, 0, 0)).toBe("minecraft:mossy_stone_bricks");
  });

  it("randomizes among the patterns a group has, repeatably", async () => {
    const run = async () => {
      const doc = newDoc();
      doc.edit("set", "setup", (tx) => {
        for (let x = 0; x < 40; x++) tx.set(x, 0, 0, "minecraft:andesite");
      });
      await runPluginAction(doc, env, "chisel.randomize", { sel: "all", patterns: ["base", "carved", "tiled", "nope"], seed: 5 });
      return Array.from({ length: 40 }, (_, x) => doc.getState(x, 0, 0));
    };
    const a = await run();
    expect(new Set(a)).toEqual(new Set(["minecraft:andesite", "chipped:carved_andesite", "chipped:tiled_andesite"]));
    expect(await run()).toEqual(a);
  });
});
