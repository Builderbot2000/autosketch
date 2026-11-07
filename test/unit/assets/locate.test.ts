import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { locateInstance } from "../../../src/assets/locate.js";
import { openStack } from "../../../src/assets/pack.js";
import { makeZip, tempDir, writeTree } from "../../helpers/fixtures.js";

const tex = (s: string) => s;

/** A miniature CurseForge layout: <cf>/minecraft/{Install,Instances/Test}. */
async function makeCurseForge(): Promise<string> {
  const cf = await tempDir();
  const inst = join(cf, "minecraft/Instances/Test");
  const pack = (extra: Record<string, unknown> = {}) => ({ "pack.mcmeta": { pack: { pack_format: 34, description: "" }, ...extra } });
  await writeTree(cf, {
    "minecraft/Install/versions/1.21.1/1.21.1.jar": makeZip({
      "version.json": { id: "1.21.1" },
      "assets/minecraft/textures/block/stone.png": tex("vanilla"),
      "assets/minecraft/textures/block/dirt.png": tex("vanilla"),
      "assets/minecraft/textures/block/glass.png": tex("vanilla"),
    }),
    "minecraft/Install/libraries/net/neoforged/neoforge/21.1.262/neoforge-21.1.262-universal.jar": makeZip({
      "assets/neoforge/lang/en_us.json": "{}",
    }),
  });
  await writeTree(inst, {
    "minecraftinstance.json": { name: "Test", gameVersion: "1.21.1", baseModLoader: { name: "neoforge-21.1.262" } },
    "mods/b_mod.jar": makeZip({
      "assets/minecraft/textures/block/stone.png": tex("b_mod"),
      "resourcepacks/shiny/pack.mcmeta": "{}",
      "resourcepacks/shiny/assets/minecraft/textures/block/dirt.png": tex("shiny"),
      "META-INF/jarjar/lib.jar": makeZip({ "assets/libmod/models/block/x.json": "{}" }),
    }),
    "mods/a_mod.jar": makeZip({
      ...pack({ overlays: { entries: [{ formats: [34, 40], directory: "new" }, { formats: 15, directory: "old" }] } }),
      "assets/amod/blockstates/a.json": "{}",
      "new/assets/amod/blockstates/a.json": '"overlay-new"',
      "old/assets/amod/blockstates/a.json": '"overlay-old"',
    }),
    "mods/disabled.jar.disabled": makeZip({ "assets/minecraft/textures/block/stone.png": tex("disabled") }),
    "kubejs/assets/kubejs/textures/block/k.png": tex("kubejs"),
    "kubejs/data/minecraft/tags/block/logs.json": { values: ["kubejs:log"] },
    "resourcepacks/User Pack.zip": makeZip({ "assets/minecraft/textures/block/glass.png": tex("user") }),
    "config/openloader/packs/00_force.zip": makeZip({ ...pack(), "assets/minecraft/textures/block/glass.png": tex("openloader") }),
    "options.txt": 'version:3955\nresourcePacks:["vanilla","mod_resources","shiny","file/User Pack.zip","fabric"]\nlang:en_us\n',
  });
  return inst;
}

describe("locateInstance (CurseForge)", () => {
  it("detects version, loader and orders layers like the game", async () => {
    const inst = await makeCurseForge();
    const info = await locateInstance(inst);
    expect(info).toMatchObject({ launcher: "curseforge", name: "Test", mcVersion: "1.21.1", loader: { name: "neoforge", version: "21.1.262" } });
    expect(info.warnings).toEqual([]);
    expect(info.layers.map((l) => l.id)).toEqual([
      "minecraft:1.21.1.jar",
      "loader:neoforge-21.1.262-universal.jar",
      "mod:a_mod.jar",
      "mod:b_mod.jar",
      "generated:kubejs",
      "builtin:shiny",
      "resourcepack:User Pack.zip",
      "openloader:00_force.zip",
    ]);
  });

  it("opens a stack that resolves overrides, built-in packs, overlays and nested jars", async () => {
    const { stack, warnings } = await openStack(await locateInstance(await makeCurseForge()));
    expect(warnings).toEqual([]);
    const text = async (p: string) => (await stack.read(p))?.toString();
    expect(await text("assets/minecraft/textures/block/stone.png")).toBe("b_mod");
    expect(await text("assets/minecraft/textures/block/dirt.png")).toBe("shiny");
    expect(await text("assets/minecraft/textures/block/glass.png")).toBe("openloader");
    expect(await text("assets/amod/blockstates/a.json")).toBe('"overlay-new"');
    expect(stack.has("assets/libmod/models/block/x.json")).toBe(true);
    expect(stack.has("assets/kubejs/textures/block/k.png")).toBe(true);
    expect((await stack.readAll("data/minecraft/tags/block/logs.json")).map((t) => t.source.id)).toEqual(["generated:kubejs"]);
  });

  it("warns when a selected pack is missing", async () => {
    const inst = await makeCurseForge();
    await writeTree(inst, { "options.txt": 'resourcePacks:["vanilla","mod_resources","file/Gone.zip","nope"]\n' });
    const info = await locateInstance(inst);
    expect(info.warnings.join("\n")).toMatch(/Gone\.zip/);
    const { warnings } = await openStack(info);
    expect(warnings.join("\n")).toMatch(/built-in pack "nope" not found/);
  });
});

describe("locateInstance (vanilla / generic)", () => {
  it("requires a version when several are installed", async () => {
    const mc = await tempDir();
    await writeTree(mc, {
      "versions/1.21.1/1.21.1.jar": makeZip({ "version.json": { id: "1.21.1" } }),
      "versions/1.21.4/1.21.4.jar": makeZip({ "version.json": { id: "1.21.4" } }),
    });
    await expect(locateInstance(mc)).rejects.toThrow(/1\.21\.1, 1\.21\.4|1\.21\.4, 1\.21\.1/);
    const info = await locateInstance(mc, { version: "1.21.4" });
    expect(info).toMatchObject({ launcher: "vanilla", mcVersion: "1.21.4" });
    expect(info.layers[0]).toMatchObject({ role: "base" });
  });

  it("reads the version from the jar for generic instances", async () => {
    const dir = await tempDir();
    await writeTree(dir, { "client.jar": makeZip({ "version.json": { id: "1.21.1" } }), "inst/mods/m.jar": makeZip({ "assets/m/x.json": "{}" }) });
    const info = await locateInstance(join(dir, "inst"), { baseJar: join(dir, "client.jar") });
    expect(info).toMatchObject({ launcher: "generic", mcVersion: "1.21.1" });
    expect(info.layers.map((l) => l.role)).toEqual(["base", "mod"]);
  });

  it("rejects unrecognised folders", async () => {
    await expect(locateInstance(await tempDir())).rejects.toThrow(/could not recognise/);
  });
});

describe("locateInstance (Prism / MultiMC)", () => {
  async function makePrism(gameDir: "minecraft" | ".minecraft"): Promise<{ data: string; inst: string }> {
    const data = await tempDir();
    const inst = join(data, "instances/My Pack");
    await writeTree(data, {
      "libraries/com/mojang/minecraft/1.21.1/minecraft-1.21.1-client.jar": makeZip({ "version.json": { id: "1.21.1" }, "assets/minecraft/textures/block/stone.png": "vanilla" }),
      "libraries/net/neoforged/neoforge/21.1.262/neoforge-21.1.262-universal.jar": makeZip({ "assets/neoforge/lang/en_us.json": "{}" }),
    });
    await writeTree(inst, {
      "instance.cfg": "[General]\nInstanceType=OneSix\nname=My Pack\n",
      "mmc-pack.json": {
        formatVersion: 1,
        components: [
          { uid: "org.lwjgl3", version: "3.3.3" },
          { uid: "net.minecraft", version: "1.21.1" },
          { uid: "net.neoforged", version: "21.1.262" },
        ],
      },
      [gameDir + "/mods/z_mod.jar"]: makeZip({ "assets/minecraft/textures/block/stone.png": "z" }),
      [gameDir + "/options.txt"]: 'resourcePacks:["vanilla","mod_resources"]\n',
    });
    return { data, inst };
  }

  it("reads instance.cfg and mmc-pack.json, and takes jars from the libraries cache", async () => {
    const { data, inst } = await makePrism("minecraft");
    const info = await locateInstance(inst);
    expect(info).toMatchObject({ launcher: "prism", name: "My Pack", mcVersion: "1.21.1", loader: { name: "neoforge", version: "21.1.262" }, root: join(inst, "minecraft") });
    expect(info.warnings).toEqual([]);
    expect(info.layers).toEqual([
      { kind: "archive", id: "minecraft:minecraft-1.21.1-client.jar", role: "base", path: join(data, "libraries/com/mojang/minecraft/1.21.1/minecraft-1.21.1-client.jar") },
      { kind: "archive", id: "loader:neoforge-21.1.262-universal.jar", role: "loader", path: join(data, "libraries/net/neoforged/neoforge/21.1.262/neoforge-21.1.262-universal.jar") },
      { kind: "archive", id: "mod:z_mod.jar", role: "mod", path: join(inst, "minecraft/mods/z_mod.jar") },
    ]);
    const { stack } = await openStack(info, { indexCache: false });
    expect((await stack.read("assets/minecraft/textures/block/stone.png"))?.toString()).toBe("z");
  });

  it("accepts MultiMC's .minecraft folder, pointed at directly", async () => {
    const { inst } = await makePrism(".minecraft");
    const info = await locateInstance(join(inst, ".minecraft"));
    expect(info).toMatchObject({ launcher: "prism", root: join(inst, ".minecraft") });
    expect(info.layers.map((l) => l.id)).toContain("mod:z_mod.jar");
  });
});
