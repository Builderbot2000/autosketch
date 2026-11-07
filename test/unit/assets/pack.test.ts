import { describe, expect, it } from "vitest";
import { BufferByteSource } from "../../../src/assets/bytes.js";
import { findBuiltinPack, parseJsonLenient, PackStack, ZipPackSource } from "../../../src/assets/pack.js";
import { ZipArchive } from "../../../src/assets/zip.js";
import { makeZip, type FileTree } from "../../helpers/fixtures.js";

async function zipSource(id: string, files: FileTree, role: "base" | "mod" = "mod"): Promise<ZipPackSource> {
  return new ZipPackSource(id, role, await ZipArchive.open(new BufferByteSource(Buffer.from(makeZip(files))), id));
}

describe("PackStack", () => {
  it("resolves single files from the topmost layer and merges with readAll", async () => {
    const base = await zipSource("base", {
      "assets/minecraft/textures/block/stone.png": "base-stone",
      "assets/minecraft/textures/block/dirt.png": "base-dirt",
      "data/minecraft/tags/block/logs.json": { values: ["minecraft:oak_log"] },
    }, "base");
    const mod = await zipSource("mod", {
      "assets/minecraft/textures/block/stone.png": "mod-stone",
      "assets/coolmod/blockstates/thing.json": "{}",
      "data/minecraft/tags/block/logs.json": { values: ["coolmod:magic_log"] },
    });
    const stack = new PackStack([base, mod]);

    expect((await stack.read("assets/minecraft/textures/block/stone.png"))?.toString()).toBe("mod-stone");
    expect((await stack.read("assets/minecraft/textures/block/dirt.png"))?.toString()).toBe("base-dirt");
    expect(await stack.read("assets/minecraft/textures/block/missing.png")).toBeUndefined();
    expect(stack.resolve("assets/coolmod/blockstates/thing.json")?.id).toBe("mod");

    const tags = await stack.readAll("data/minecraft/tags/block/logs.json");
    expect(tags.map((t) => t.source.id)).toEqual(["base", "mod"]);

    expect(stack.list("assets/minecraft/textures/")).toEqual([
      "assets/minecraft/textures/block/dirt.png",
      "assets/minecraft/textures/block/stone.png",
    ]);
    expect(stack.namespaces()).toEqual(["coolmod", "minecraft"]);
    expect(stack.namespaces("data")).toEqual(["minecraft"]);
  });

  it("scopes sub-folder views (built-in packs, overlays)", async () => {
    const jar = await zipSource("mod", {
      "resourcepacks/fancy/assets/minecraft/textures/block/stone.png": "fancy",
      "overlay_a/data/x/tags/block/t.json": "{}",
      "overlay_a/assets/x/models/block/m.json": "{}",
    });
    const sub = jar.sub("fancy", "builtin", "resourcepacks/fancy");
    expect([...sub.paths()]).toEqual(["assets/minecraft/textures/block/stone.png"]);
    const assetsOnly = jar.sub("ov", "mod", "overlay_a", "assets");
    expect([...assetsOnly.paths()]).toEqual(["assets/x/models/block/m.json"]);
    expect(assetsOnly.has("data/x/tags/block/t.json")).toBe(false);
  });
});

describe("findBuiltinPack", () => {
  it("finds conventional resourcepacks/<name>/ packs", async () => {
    const jar = await zipSource("mod:pneumaticcraft.jar", { "resourcepacks/fusion_integration/pack.mcmeta": "{}" });
    expect(findBuiltinPack("mod/pneumaticcraft:fusion_integration", [jar])).toMatchObject({ dir: "resourcepacks/fusion_integration" });
  });

  it("matches packs registered from arbitrary folders by normalised name", async () => {
    const other = await zipSource("mod:stone_mod.jar", { "Stone/assets/minecraft/x.png": "" });
    const xy = await zipSource("mod:xycraft_override-0.7.53.jar", {
      "OverridesStone/assets/minecraft/textures/block/stone.png": "",
      "OverridesGlass/assets/minecraft/textures/block/glass.png": "",
    });
    expect(findBuiltinPack("add_xycraft_overrides_stone", [other, xy])).toMatchObject({ host: xy, dir: "OverridesStone" });
    expect(findBuiltinPack("add_xycraft_overrides_glass", [other, xy])).toMatchObject({ dir: "OverridesGlass" });
    expect(findBuiltinPack("nonexistent_pack", [other, xy])).toBeUndefined();
  });
});

describe("parseJsonLenient", () => {
  it("accepts BOM, comments and trailing commas like the game does", () => {
    const text = '﻿{ // comment\n "a": [1, 2,], /* block */ "b": "http://x" ,}';
    expect(parseJsonLenient(Buffer.from(text))).toEqual({ a: [1, 2], b: "http://x" });
  });
  it("reports the file on failure", () => {
    expect(() => parseJsonLenient(Buffer.from("{nope"), "x.json")).toThrow(/x\.json/);
  });
});
