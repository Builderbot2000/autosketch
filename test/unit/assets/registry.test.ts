import { describe, expect, it } from "vitest";
import { buildRegistryData, guessDefault, loadBlockTags, loadRegistry, parseModsToml, Registry } from "../../../src/assets/registry.js";
import { solidPng, tempDir } from "../../helpers/fixtures.js";
import { memStack, VANILLA_PARENTS } from "../../helpers/stack.js";

async function fixtureStack() {
  return memStack([
    [
      "minecraft:client.jar",
      "base",
      {
        ...VANILLA_PARENTS,
        "assets/minecraft/blockstates/stone.json": { variants: { "": { model: "block/stone" } } },
        "assets/minecraft/models/block/stone.json": { parent: "block/cube_all", textures: { all: "block/stone" } },
        "assets/minecraft/blockstates/oak_log.json": {
          variants: { "axis=x": { model: "block/oak_log", x: 90 }, "axis=y": { model: "block/oak_log" }, "axis=z": { model: "block/oak_log", x: 90, y: 90 } },
        },
        "assets/minecraft/models/block/oak_log.json": { parent: "block/cube_column", textures: { end: "block/oak_log_top", side: "block/oak_log" } },
        "assets/minecraft/blockstates/oak_slab.json": {
          variants: { "type=bottom": { model: "block/oak_slab" }, "type=top": { model: "block/oak_slab" }, "type=double": { model: "block/oak_planks" } },
        },
        "assets/minecraft/models/block/oak_slab.json": { parent: "block/slab", textures: { top: "block/oak_planks", bottom: "block/oak_planks", side: "block/oak_planks" } },
        "assets/minecraft/blockstates/chest.json": { variants: { "": { model: "block/chest" } } },
        "assets/minecraft/models/block/chest.json": { parent: "builtin/entity", textures: { particle: "block/oak_planks" } },
        "assets/minecraft/textures/block/stone.png": solidPng([125, 125, 125]),
        "assets/minecraft/textures/block/oak_log.png": solidPng([110, 85, 50]),
        "assets/minecraft/textures/block/oak_log_top.png": solidPng([160, 130, 80]),
        "assets/minecraft/textures/block/oak_planks.png": solidPng([160, 130, 80]),
        "data/minecraft/tags/block/logs.json": { values: ["#minecraft:oak_logs"] },
        "data/minecraft/tags/block/oak_logs.json": { values: ["minecraft:oak_log"] },
        "data/minecraft/tags/block/slabs.json": { values: ["oak_slab"] },
      },
    ],
    [
      "mod:cool.jar",
      "mod",
      {
        "META-INF/neoforge.mods.toml": 'modLoader="javafml"\n[[mods]]\nmodId="cool"\ndisplayName="Cool Blocks"\n[[dependencies.cool]]\nmodId="minecraft"\n',
        "assets/cool/blockstates/marble_pillar.json": {
          variants: { "axis=x,lit=false": { model: "cool:block/marble" }, "axis=y,lit=false": { model: "cool:block/marble" }, "axis=y,lit=true": { model: "cool:block/marble" } },
        },
        "assets/cool/models/block/marble.json": { parent: "minecraft:block/cube_all", textures: { all: "cool:block/marble" } },
        "assets/cool/textures/block/marble.png": solidPng([235, 235, 230]),
        "data/minecraft/tags/block/logs.json": { values: [{ id: "cool:marble_pillar", required: false }] },
        "data/cool/tags/block/shiny.json": { values: ["minecraft:stone"] },
      },
    ],
    [
      "resourcepack:fancy.zip",
      "resourcepack",
      {
        // Restyles stone; also ships a blockstate for a mod that isn't installed.
        "assets/minecraft/models/block/stone.json": { parent: "block/cube_all", textures: { all: "block/fancy_stone" } },
        "assets/minecraft/textures/block/fancy_stone.png": solidPng([140, 130, 120], 4, [100, 95, 90]),
        "assets/absent/blockstates/ghost.json": { variants: { "": { model: "block/stone" } } },
        "data/cool/tags/block/shiny.json": { replace: true, values: ["minecraft:oak_log"] },
      },
    ],
  ]);
}

describe("registry", () => {
  it("builds blocks from defining layers only, with vanilla data, shapes, textures and tags", async () => {
    const stack = await fixtureStack();
    const reg = new Registry(await buildRegistryData(stack, "fp", { mcVersion: "1.21.1" }));

    expect(reg.has("absent:ghost")).toBe(false);
    expect(reg.has("minecraft:air")).toBe(true); // from vanilla data, no assets

    const stone = reg.get("stone")!;
    expect(stone).toMatchObject({ shape: "full", renderable: "exact", displayName: "Stone", exactProperties: true, source: "minecraft:client.jar" });
    expect(stone.faceTextures.up).toBe("minecraft:block/fancy_stone");

    const log = reg.get("minecraft:oak_log")!;
    expect(log.defaults).toEqual({ axis: "y" });
    expect(log.faceTextures).toMatchObject({ up: "minecraft:block/oak_log_top", north: "minecraft:block/oak_log" });
    expect(log.tags).toEqual(["cool:shiny", "minecraft:logs", "minecraft:oak_logs"]);

    const slab = reg.get("minecraft:oak_slab")!;
    expect(slab.shape).toBe("partial");
    expect(slab.properties).toEqual({ type: ["top", "bottom", "double"], waterlogged: ["true", "false"] }); // full vanilla set
    expect(slab.defaults).toEqual({ type: "bottom", waterlogged: "false" });

    expect(reg.get("minecraft:chest")).toMatchObject({ shape: "none", renderable: "fallback", textures: ["minecraft:block/oak_planks"] });

    const pillar = reg.get("cool:marble_pillar")!;
    expect(pillar.properties).toEqual({ axis: ["x", "y"], lit: ["false", "true"] });
    expect(pillar.defaults).toEqual({ axis: "y", lit: "false" });
    expect(pillar.exactProperties).toBeUndefined();
    expect(pillar.tags).toEqual(["minecraft:logs"]);

    expect(reg.withTag("#minecraft:logs").map((b) => b.id).sort()).toEqual(["cool:marble_pillar", "minecraft:oak_log"]);
    expect(reg.withTag("cool:shiny").map((b) => b.id)).toEqual(["minecraft:oak_log"]); // replace: true
    expect(reg.modName("cool")).toBe("Cool Blocks");
  });

  it("caches by stack fingerprint", async () => {
    const stack = await fixtureStack();
    const cacheDir = await tempDir();
    const a = await loadRegistry(stack, { mcVersion: "1.21.1", cacheDir });
    const b = await loadRegistry(stack, { mcVersion: "1.21.1", cacheDir });
    expect([a.cached, b.cached]).toEqual([false, true]);
    expect(b.registry.size).toBe(a.registry.size);
    expect(b.registry.get("cool:marble_pillar")).toEqual(a.registry.get("cool:marble_pillar"));
  });

  it("expands nested tags without looping on cycles", async () => {
    const stack = await memStack([
      ["d", "mod", { "data/m/tags/block/a.json": { values: ["#m:b", "m:x"] }, "data/m/tags/block/b.json": { values: ["#m:a", "m:y"] } }],
    ]);
    const tags = await loadBlockTags(stack);
    expect([...tags.get("m:a")!].sort()).toEqual(["m:x", "m:y"]);
  });
});

describe("guessDefault", () => {
  it("follows common conventions", () => {
    expect(guessDefault("facing", ["east", "north", "south", "west"])).toBe("north");
    expect(guessDefault("half", ["top", "bottom"])).toBe("bottom");
    expect(guessDefault("powered", ["true", "false"])).toBe("false");
    expect(guessDefault("age", ["3", "1", "0", "2"])).toBe("0");
    expect(guessDefault("color", ["red", "blue"])).toBe("red");
  });
});

describe("parseModsToml", () => {
  it("extracts mod ids and display names", () => {
    const toml = `modLoader="javafml"\n[[mods]]\nmodId="a"\ndisplayName="Mod A"\n[[mods]]\n  modId = 'b'\n[[dependencies.a]]\nmodId="neoforge"\n`;
    expect(parseModsToml(toml)).toEqual([["a", "Mod A"], ["b", "b"]]);
  });
});
