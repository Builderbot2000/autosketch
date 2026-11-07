import { describe, expect, it } from "vitest";
import {
  blockstateProperties,
  conditionMatches,
  isFullCube,
  ModelResolver,
  parseBlockstate,
  parseVariantKey,
  selectModels,
} from "../../../src/assets/models.js";
import { memStack, VANILLA_PARENTS } from "../../helpers/stack.js";

describe("blockstates", () => {
  it("parses variant keys", () => {
    expect(parseVariantKey("")).toEqual({});
    expect(parseVariantKey("normal")).toEqual({});
    expect(parseVariantKey("facing=east,half=bottom")).toEqual({ facing: "east", half: "bottom" });
  });

  it("selects variants by matching properties", () => {
    const def = parseBlockstate({
      variants: {
        "axis=x": { model: "block/log_h", x: 90, y: 90 },
        "axis=y": [{ model: "block/log", weight: 3 }, { model: "block/log_alt" }],
      },
    });
    expect(selectModels(def, { axis: "x" })).toEqual([{ model: "minecraft:block/log_h", x: 90, y: 90, uvlock: false, weight: 1 }]);
    expect(selectModels(def, { axis: "y" }).map((r) => r.model)).toEqual(["minecraft:block/log"]);
    expect(selectModels(def, { axis: "z" })).toEqual([]);
    expect(blockstateProperties(def)).toEqual({ axis: ["x", "y"] });
  });

  it("evaluates multipart conditions (OR, AND, pipes, non-string values)", () => {
    const def = parseBlockstate({
      multipart: [
        { apply: { model: "mod:block/post" } },
        { when: { north: "true" }, apply: { model: "mod:block/side" } },
        { when: { OR: [{ east: "low|tall" }, { AND: [{ up: true }, { waterlogged: false }] }] }, apply: { model: "mod:block/extra" } },
      ],
    });
    const models = (s: Record<string, string>) => selectModels(def, s).map((r) => r.model);
    expect(models({ north: "false", east: "none", up: "false" })).toEqual(["mod:block/post"]);
    expect(models({ north: "true", east: "tall", up: "false" })).toEqual(["mod:block/post", "mod:block/side", "mod:block/extra"]);
    expect(models({ north: "false", east: "none", up: "true", waterlogged: "false" })).toEqual(["mod:block/post", "mod:block/extra"]);
    expect(blockstateProperties(def)).toEqual({ north: ["true"], east: ["low", "tall"], up: ["true"], waterlogged: ["false"] });
  });

  it("supports negated conditions some mods use", () => {
    expect(conditionMatches({ facing: "!north|south" }, { facing: "east" })).toBe(true);
    expect(conditionMatches({ facing: "!north|south" }, { facing: "south" })).toBe(false);
  });
});

describe("ModelResolver", () => {
  it("merges parent chains and resolves texture variables", async () => {
    const stack = await memStack([
      ["base", "base", { ...VANILLA_PARENTS, "assets/minecraft/models/block/oak_log.json": { parent: "block/cube_column", textures: { end: "block/oak_log_top", side: "block/oak_log" } } }],
    ]);
    const m = await new ModelResolver(stack).resolve("block/oak_log");
    expect(m.issues).toEqual([]);
    expect(m.elements).toHaveLength(1);
    expect(m.elements[0]!.faces.up!.texture).toBe("minecraft:block/oak_log_top");
    expect(m.elements[0]!.faces.north!.texture).toBe("minecraft:block/oak_log");
    expect(m.particle).toBe("minecraft:block/oak_log");
    expect(isFullCube([m])).toBe(true);
  });

  it("children override parent textures and resource packs override models", async () => {
    const stack = await memStack([
      ["base", "base", { ...VANILLA_PARENTS, "assets/minecraft/models/block/stone.json": { parent: "block/cube_all", textures: { all: "block/stone" } } }],
      ["pack", "resourcepack", { "assets/minecraft/models/block/stone.json": { parent: "block/cube_all", textures: { all: "block/fancy_stone" } } }],
    ]);
    const m = await new ModelResolver(stack).resolve("minecraft:block/stone");
    expect(m.elements[0]!.faces.east!.texture).toBe("minecraft:block/fancy_stone");
  });

  it("flags builtin/entity, missing models, missing parents and cycles", async () => {
    const stack = await memStack([
      [
        "base",
        "base",
        {
          ...VANILLA_PARENTS,
          "assets/minecraft/models/block/chest.json": { parent: "builtin/entity", textures: { particle: "block/oak_planks" } },
          "assets/mod/models/block/orphan.json": { parent: "mod:block/gone" },
          "assets/mod/models/block/a.json": { parent: "mod:block/b" },
          "assets/mod/models/block/b.json": { parent: "mod:block/a" },
          "assets/mod/models/block/untextured.json": { parent: "block/cube" },
        },
      ],
    ]);
    const r = new ModelResolver(stack);
    const chest = await r.resolve("block/chest");
    expect(chest.issues).toContain("builtin-entity");
    expect(chest.particle).toBe("minecraft:block/oak_planks");
    expect((await r.resolve("mod:block/nothing")).issues).toEqual(["missing"]);
    expect((await r.resolve("mod:block/orphan")).issues).toEqual(["missing-parent"]);
    expect((await r.resolve("mod:block/a")).issues).toEqual(["cycle"]);
    const u = await r.resolve("mod:block/untextured");
    expect(u.issues).toEqual(["missing-texture"]);
    expect(u.elements[0]!.faces.up!.texture).toBe("#missing");
  });

  it("merges NeoForge composite children and flags other custom loaders", async () => {
    const stack = await memStack([
      [
        "mod",
        "mod",
        {
          ...VANILLA_PARENTS,
          "assets/mod/models/block/combo.json": {
            loader: "neoforge:composite",
            textures: { particle: "mod:block/p" },
            children: {
              bottom: { parent: "block/slab", textures: { top: "mod:block/t", bottom: "mod:block/b", side: "mod:block/s" } },
              cube: { parent: "block/cube_all", textures: { all: "mod:block/c" } },
            },
          },
          "assets/mod/models/block/obj.json": { loader: "neoforge:obj", model: "mod:models/block/thing.obj" },
        },
      ],
    ]);
    const r = new ModelResolver(stack);
    const combo = await r.resolve("mod:block/combo");
    expect(combo.issues).toEqual([]);
    expect(combo.elements).toHaveLength(2);
    expect(combo.elements.map((e) => e.faces.up!.texture)).toEqual(["mod:block/t", "mod:block/c"]);
    const obj = await r.resolve("mod:block/obj");
    expect(obj.issues).toEqual(["custom-loader"]);
    expect(obj.loader).toBe("neoforge:obj");
  });

  it("isFullCube rejects partial and rotated geometry", async () => {
    const stack = await memStack([["base", "base", { ...VANILLA_PARENTS, "assets/minecraft/models/block/s.json": { parent: "block/slab", textures: { top: "a", bottom: "a", side: "a" } } }]]);
    expect(isFullCube([await new ModelResolver(stack).resolve("block/s")])).toBe(false);
  });
});
