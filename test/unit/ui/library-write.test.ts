import { describe, expect, it } from "vitest";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { libraryRoots, starterRoot } from "../../../src/library/roots.js";
import { uiErrorOf } from "../../../src/ui/errors.js";
import { LibraryRequests } from "../../../src/ui/library.js";
import type { SettingsRows } from "../../../src/ui/settings.js";
import { smallContext } from "../../helpers/context.js";
import { tempDir } from "../../helpers/fixtures.js";

/** The editor write kinds (docs/design/17-reusable-components.md, piece 6; `13`, *Request kinds*). */

async function setup(withIndex: boolean) {
  const dir = await tempDir("autosketch-edit-");
  await cp(join(starterRoot().path, "prefabs", "park_bench"), join(dir, "prefabs", "park_bench"), { recursive: true });
  await mkdir(join(dir, "prefabs", "shed"), { recursive: true });
  await cp(join(starterRoot().path, "prefabs", "park_bench", "prefab.schem"), join(dir, "prefabs", "shed", "prefab.schem"));
  await cp(join(starterRoot().path, "prefabs", "park_bench", "prefab.schem"), join(dir, "prefabs", "loose.schem"));
  await mkdir(join(dir, "palettes"), { recursive: true });
  await writeFile(join(dir, "palettes", "stone.json"), JSON.stringify({ name: "stone", tags: [], roles: { wall: [{ family: "minecraft:stone_bricks", block: "minecraft:stone_bricks", weight: 1, color: "#787878" }] } }));
  await mkdir(join(dir, "procedures"), { recursive: true });
  await writeFile(join(dir, "procedures", "bay.js"), "/** Window bay. */\n");
  await mkdir(join(dir, "knowledge", "kits"), { recursive: true });
  await writeFile(join(dir, "knowledge", "kits", "village.md"), "---\nkind: kit\nsummary: Village parts.\n---\n- park_bench\n");
  const ctx = withIndex ? await smallContext() : undefined;
  const lib = new LibraryRequests({ roots: () => libraryRoots({ workspace: "/ws", env: { AUTOSKETCH_LIBRARY: dir } }), ...(ctx ? { paletteIndex: () => ctx.palette } : {}) }, {} as SettingsRows);
  const hash = async (kind: string, name: string, root = "user") => (await lib.entry({ root, kind, name })).hash as string;
  return { dir, lib, hash };
}

/** The error code the request would answer (as `UiRequests` maps it). */
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => uiErrorOf(e).code);

describe("library.write.* handlers (17, piece 6)", () => {
  it("writes a procedure and a kit with the hash; a stale hash is conflict and keeps the file", async () => {
    const t = await setup(false);
    const h = await t.hash("procedures", "bay");
    const r = await t.lib.writeProcedure({ root: "user", name: "bay", hash: h, text: "/** Bay, deeper. */\n" });
    expect(await readFile(join(t.dir, "procedures/bay.js"), "utf8")).toBe("/** Bay, deeper. */\n");
    expect(r.hash).toBe(await t.hash("procedures", "bay"));
    expect(await code(t.lib.writeProcedure({ root: "user", name: "bay", hash: h, text: "mine" }))).toBe("conflict");
    expect(await readFile(join(t.dir, "procedures/bay.js"), "utf8")).toBe("/** Bay, deeper. */\n");
    const k = await t.hash("knowledge", "kits/village");
    const kit = "---\nkind: kit\nsummary: Village parts.\n---\n- park_bench\n- shed\n";
    await t.lib.writeKnowledge({ root: "user", name: "kits/village", hash: k, text: kit });
    expect(await readFile(join(t.dir, "knowledge/kits/village.md"), "utf8")).toBe(kit);
    expect(await code(t.lib.writeKnowledge({ root: "user", name: "kits/village", hash: k, text: "x" }))).toBe("conflict");
    expect(await code(t.lib.writeKnowledge({ root: "user", name: "kits/village", text: "x" }))).toBe("bad_request");
    expect(await code(t.lib.writeKnowledge({ root: "user", name: "nope", hash: k, text: "x" }))).toBe("not_found");
    expect(await code(t.lib.writeKnowledge({ root: "nope", name: "kits/village", hash: k, text: "x" }))).toBe("not_found");
  });

  it("read-only roots and loose schematic files are bad_request, whatever the hash", async () => {
    const t = await setup(true);
    const roofs = await t.hash("knowledge", "heuristics/roofs", "starter");
    expect(await code(t.lib.writeKnowledge({ root: "starter", name: "heuristics/roofs", hash: roofs, text: "x" }))).toBe("bad_request");
    expect(await code(t.lib.writeKnowledge({ root: "starter", name: "heuristics/roofs", hash: "stale", text: "x" }))).toBe("bad_request");
    const lamp = await t.hash("prefabs", "lamp_post", "starter");
    expect(await code(t.lib.writePrefab({ root: "starter", name: "lamp_post", hash: lamp, meta: { name: "Lamp" } }))).toBe("bad_request");
    expect(await code(t.lib.writePrefab({ root: "starter", name: "lamp_post", hash: "stale", meta: { name: "Lamp" } }))).toBe("bad_request");
    expect(await t.lib.entry({ root: "user", kind: "prefabs", name: "loose" })).toMatchObject({ editable: false, hash: "absent" });
    expect(await code(t.lib.writePrefab({ root: "user", name: "loose", hash: "absent", meta: { name: "Loose" } }))).toBe("bad_request");
  });

  it("edits prefab.json; a folder without one has the hash absent and the write creates it", async () => {
    const t = await setup(false);
    const h = await t.hash("prefabs", "park_bench");
    await t.lib.writePrefab({ root: "user", name: "park_bench", hash: h, meta: { name: "Bench", front: "east", roles: { wood: ["oak_planks"] } } });
    expect(JSON.parse(await readFile(join(t.dir, "prefabs/park_bench/prefab.json"), "utf8"))).toMatchObject({ name: "Bench", front: "east", roles: { wood: ["minecraft:oak_planks"] } });
    expect(await code(t.lib.writePrefab({ root: "user", name: "park_bench", hash: h, meta: { name: "Late" } }))).toBe("conflict");
    const next = await t.hash("prefabs", "park_bench");
    expect(await code(t.lib.writePrefab({ root: "user", name: "park_bench", hash: next, meta: { front: "up" } }))).toBe("bad_request");
    expect(await t.hash("prefabs", "shed")).toBe("absent");
    const r = await t.lib.writePrefab({ root: "user", name: "shed", hash: "absent", meta: { name: "Shed", anchors: { door: [1, 0, 0] } } });
    expect(JSON.parse(await readFile(join(t.dir, "prefabs/shed/prefab.json"), "utf8"))).toEqual({ name: "Shed", anchors: { door: [1, 0, 0] } });
    expect(r.hash).toBe(await t.hash("prefabs", "shed"));
    expect((await t.lib.entry({ root: "user", kind: "prefabs", name: "shed" })).meta).toMatchObject({ name: "Shed" });
  });

  it("palettes: tags and notes without an instance; members through palette_edit's operations and addBlocks with one", async () => {
    const plain = await setup(false);
    let h = await plain.hash("palettes", "stone");
    expect(await code(plain.lib.writePalette({ root: "user", name: "stone", hash: h, edit: { drop: ["wall"] } }))).toBe("bad_request");
    expect(await code(plain.lib.writePalette({ root: "user", name: "stone", hash: h, addBlocks: { wall: ["cobblestone"] } }))).toBe("bad_request");
    expect(await plain.lib.writePalette({ root: "user", name: "stone", hash: h, tags: ["Grey", "castle"], notes: "plain" })).toMatchObject({ warnings: [] });
    expect(JSON.parse(await readFile(join(plain.dir, "palettes/stone.json"), "utf8"))).toMatchObject({ tags: ["grey", "castle"], notes: "plain" });
    expect(await code(plain.lib.writePalette({ root: "user", name: "stone", hash: h, notes: "late" }))).toBe("conflict");

    const t = await setup(true);
    h = await t.hash("palettes", "stone");
    expect(await code(t.lib.writePalette({ root: "user", name: "stone", hash: h, edit: { add: { wall: "A1" } } }))).toBe("bad_request");
    expect(await code(t.lib.writePalette({ root: "user", name: "stone", hash: h, edit: { drop: ["roof"] } }))).toBe("bad_request");
    const r = await t.lib.writePalette({ root: "user", name: "stone", hash: h, addBlocks: { wall: ["cobblestone", "nope:block"] }, edit: { rename: { wall: "walls" } } });
    expect(r.warnings).toEqual(["wall: nope:block is not a building block in this instance; not added"]);
    const saved = JSON.parse(await readFile(join(t.dir, "palettes/stone.json"), "utf8"));
    expect(Object.keys(saved.roles)).toEqual(["walls"]);
    expect(saved.roles.walls.map((m: { block: string; weight: number }) => [m.block, m.weight])).toEqual([["minecraft:stone_bricks", 0.5], ["minecraft:cobblestone", 0.5]]);
    expect(saved.roles.walls[0].color).toBe("#787878");
    expect(r.hash).toBe(await t.hash("palettes", "stone"));
    const w = await t.lib.writePalette({ root: "user", name: "stone", hash: r.hash, edit: { weights: { walls: { stone_bricks: 3, cobblestone: 1 } } } });
    expect(JSON.parse(await readFile(join(t.dir, "palettes/stone.json"), "utf8")).roles.walls.map((m: { weight: number }) => m.weight)).toEqual([0.75, 0.25]);
    await t.lib.writePalette({ root: "user", name: "stone", hash: w.hash, edit: { remove: { walls: ["cobblestone"] } }, addBlocks: { trim: ["oak_planks"] } });
    const last = JSON.parse(await readFile(join(t.dir, "palettes/stone.json"), "utf8"));
    expect(Object.fromEntries(Object.entries(last.roles as Record<string, { block: string; weight: number }[]>).map(([k, ms]) => [k, ms.map((m) => [m.block, m.weight])]))).toEqual({ walls: [["minecraft:stone_bricks", 1]], trim: [["minecraft:oak_planks", 1]] });
    expect(await code(t.lib.writePalette({ root: "user", name: "stone", hash: h, tags: [] }))).toBe("conflict");
  });
});
