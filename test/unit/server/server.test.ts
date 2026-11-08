import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PNG } from "pngjs";
import { buildPaletteIndexData, PaletteIndex } from "../../../src/palette/index.js";
import { PaletteBook } from "../../../src/palette/pick.js";
import { layoutSheet, columnLabel, SheetRenderer } from "../../../src/palette/sheet.js";
import type { InstanceContext } from "../../../src/server/context.js";
import { configFromEnv } from "../../../src/server/context.js";
import { createServer } from "../../../src/server/server.js";
import { Session } from "../../../src/server/session.js";

const workspace = mkdtempSync(join(tmpdir(), "autosketch-ws-"));
afterAll(() => rmSync(workspace, { recursive: true, force: true }));
import { solidPng } from "../../helpers/fixtures.js";
import { fakeRegistry, partial } from "../../helpers/registry.js";
import { memStack } from "../../helpers/stack.js";

async function fixtureContext(): Promise<InstanceContext> {
  const registry = fakeRegistry([
    { id: "minecraft:andesite", displayName: "Andesite", tags: ["c:stones"] },
    partial("minecraft:andesite_stairs", { properties: { facing: ["north", "south", "east", "west"] }, defaults: { facing: "north" }, exactProperties: true }),
    partial("minecraft:andesite_slab"),
    { id: "minecraft:oak_planks", tags: ["minecraft:planks"] },
    partial("minecraft:oak_stairs"),
  ]);
  const stack = await memStack([
    ["base", "base", {
      "assets/minecraft/textures/block/andesite.png": solidPng([130, 130, 130]),
      "assets/minecraft/textures/block/oak_planks.png": solidPng([160, 130, 80]),
    }],
  ]);
  const palette = new PaletteIndex(await buildPaletteIndexData(stack, registry), registry);
  return {
    info: { name: "Fixture", mcVersion: "1.21.1", launcher: "generic", root: "/fixture" },
    stack,
    registry,
    palette,
    plugins: [],
    sheets: new SheetRenderer(palette, stack),
    book: new PaletteBook(),
    warnings: [],
    timings: {},
  };
}

async function connect(ctx: Promise<InstanceContext>, session = new Session(workspace)) {
  const server = createServer(ctx, { session });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

type Content = { type: string; text?: string; data?: string; mimeType?: string }[];
const textOf = (r: { content: unknown }) => (r.content as Content).filter((c) => c.type === "text").map((c) => c.text).join("\n");

describe("MCP server", () => {
  it("advertises tools and instructions", async () => {
    const client = await connect(fixtureContext());
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual([
      "analyze", "anchor", "array", "block_info", "checkpoint", "clear", "copy", "diff", "doc_info", "doc_list", "doc_new", "doc_open", "export",
      "extrude", "fill", "history", "hollow", "instance_info", "knowledge_list", "knowledge_read", "mirror", "move", "op_run", "ops_list", "paint", "palette_edit",
      "palette_list", "palette_load", "palette_pick", "palette_save", "palette_sheet", "palette_show", "prefab_save", "prefab_search", "prefab_sheet", "procedure_list", "query_block", "query_column",
      "query_region", "raycast", "redo", "render", "replace", "restore", "rotate", "run_procedure", "run_script", "scope_abandon", "scope_fork", "scope_list", "scope_merge", "select", "set_blocks", "smooth", "stamp",
      "sweep", "undo", "view_slice",
    ]);
    expect(client.getInstructions()).toMatch(/palette:<name>\.<role>/);
  });

  it("lists plugin ops (none without plugins)", async () => {
    const client = await connect(fixtureContext());
    const r = await client.callTool({ name: "ops_list", arguments: { namespace: "framedblocks" } });
    expect(textOf(r)).toBe('No plugin ops for "framedblocks" (active plugins: none).');
  });

  it("serves a sheet image with caption, then picks and shows a palette", async () => {
    const ctx = await fixtureContext();
    const client = await connect(Promise.resolve(ctx));

    const sheet = await client.callTool({ name: "palette_sheet", arguments: {} });
    const content = sheet.content as Content;
    expect(content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
    const png = PNG.sync.read(Buffer.from(content[0]!.data!, "base64"));
    expect(png.width).toBeGreaterThan(30);
    expect(textOf(sheet)).toMatch(/sheet overview/);

    // An empty sheet answers in text instead of sending a blank image.
    const empty = await client.callTool({ name: "palette_sheet", arguments: { sheet: "filter:text:nothingmatches" } });
    expect((empty.content as Content).map((c) => c.type)).toEqual(["text"]);
    expect(textOf(empty)).toMatch(/No materials match/);

    // Find the andesite cell from the same deterministic layout.
    const l = layoutSheet(ctx.palette, { sheet: "overview" });
    let ref = "";
    l.cells.forEach((row, r) => row.forEach((c, i) => c?.kind === "family" && c.id === "minecraft:andesite" && (ref = `${columnLabel(i)}${r + l.rowOffset}`)));

    const pick = await client.callTool({ name: "palette_pick", arguments: { name: "keep", roles: { wall: ref } } });
    expect(pick.isError).toBeFalsy();
    expect(textOf(pick)).toMatch(/wall: minecraft:andesite \(grey\) — shapes: stairs,slab/);

    expect(textOf(await client.callTool({ name: "palette_show", arguments: {} }))).toMatch(/keep: roles wall/);
    expect(textOf(await client.callTool({ name: "palette_show", arguments: { name: "keep" } }))).toMatch(/palette:keep/);
    const missing = await client.callTool({ name: "palette_show", arguments: { name: "nope" } });
    expect(missing.isError).toBe(true);
  });

  it("looks up and searches blocks", async () => {
    const client = await connect(fixtureContext());
    const info = textOf(await client.callTool({ name: "block_info", arguments: { query: "minecraft:andesite_stairs" } }));
    expect(info).toMatch(/facing=north\|south\|east\|west \(default north\)/);
    expect(info).toMatch(/family: minecraft:andesite/);
    expect(textOf(await client.callTool({ name: "block_info", arguments: { query: "stairs" } }))).toMatch(/2 matches: minecraft:oak_stairs, minecraft:andesite_stairs/);
    expect((await client.callTool({ name: "block_info", arguments: { query: "zzz" } })).isError).toBe(true);
  });

  it("reports tool errors and instance load failures as tool errors, not crashes", async () => {
    const client = await connect(fixtureContext());
    const bad = await client.callTool({ name: "palette_sheet", arguments: { sheet: "category:nonsense" } });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/unknown category/);

    const failing = Promise.reject(new Error("no such folder"));
    failing.catch(() => {});
    const broken = await connect(failing);
    const r = await broken.callTool({ name: "instance_info", arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/failed to load: no such folder/);
  });

  it("reads config from args and env", () => {
    expect(configFromEnv(["--instance", "/x", "--version", "1.21.1"], {})).toEqual({ instance: "/x", version: "1.21.1" });
    expect(configFromEnv([], { AUTOSKETCH_INSTANCE: "/y" })).toEqual({ instance: "/y" });
    expect(configFromEnv([], {})).toBeUndefined();
    expect(configFromEnv(["--instance", "/x", "--workspace", "/w"], {})).toEqual({ instance: "/x", workspace: "/w" });
    // modOrder / tintBiome are settings: the old flags and env vars still work, and --set does too.
    expect(configFromEnv(["--instance", "/x", "--mod-order", "a, b", "--tint-biome", "jungle"], {})).toEqual({ instance: "/x", modOrder: ["a", "b"], tintBiome: "jungle" });
    expect(configFromEnv(["--instance", "/x"], { AUTOSKETCH_MOD_ORDER: "c", AUTOSKETCH_TINT_BIOME: "swamp" })).toEqual({ instance: "/x", modOrder: ["c"], tintBiome: "swamp" });
    expect(configFromEnv(["--instance", "/x", "--set", "tintBiome=desert", "--set=modOrder=d"], { AUTOSKETCH_TINT_BIOME: "swamp" })).toEqual({ instance: "/x", modOrder: ["d"], tintBiome: "desert" });
  });

  it("builds, checks, undoes, checkpoints and reopens a document", async () => {
    const ctx = await fixtureContext();
    const session = new Session(workspace);
    const client = await connect(Promise.resolve(ctx), session);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: args });
      return { text: textOf(r), error: !!r.isError };
    };

    expect((await call("fill", { box: { min: [0, 0, 0], max: [1, 1, 1] }, pattern: "andesite" })).text).toMatch(/No document is open/);
    expect((await call("doc_new", { name: "hut", size: [5, 4, 5], seed: 3 })).text).toMatch(/created "hut"[\s\S]*doc 5×4×5/);
    expect((await call("doc_new", { name: "hut" })).text).toMatch(/already exists/);

    const walls = await call("fill", { box: { min: [0, 0, 0], max: [4, 3, 4] }, pattern: "andesite", mode: "hollow", as: "hut" });
    expect(walls.text).toMatch(/^ok · fill · 82 blocks changed · box \(0,0,0\)–\(4,3,4\)\ncomponent: hut/);
    expect((await call("checkpoint", { name: "shell" })).text).toMatch(/checkpoint "shell" at op #1/);
    await call("set_blocks", { blocks: [{ pos: [2, 1, 0], block: "andesite_stairs[facing=south]" }] });
    expect((await call("replace", { from: "andesite", to: "oak_planks 50%, andesite 50%" })).error).toBe(false);
    const bad = await call("set_blocks", { blocks: [{ pos: [0, 0, 0], block: "andesite_stairs[facing=up]" }] });
    expect(bad).toEqual({ error: true, text: "facing=up is invalid for minecraft:andesite_stairs; valid: north|south|east|west" });

    const slice = (await call("view_slice", { axis: "z", at: 0 })).text;
    expect(slice).toMatch(/elevation looking north/);
    expect(slice).toMatch(/andesite_stairs\[facing=south\] \(1\)/);

    const pic = await client.callTool({ name: "render", arguments: { views: ["iso_se"], size: 256 } });
    expect((pic.content as Content)[0]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(textOf(pic)).toMatch(/render 256×256 · iso_se/);

    const grow = await call("set_blocks", { blocks: [{ pos: [-2, 0, 0], block: "oak_planks" }] });
    expect(grow.text).toMatch(/doc 7×4×5 \(x×y×z\), 83 blocks · bounds \(-2,0,0\)–\(4,3,4\)/);
    expect((await call("undo")).text).toMatch(/undid 1: #4 set_blocks 1\ndoc 5×4×5/);
    expect((await call("history")).text).toMatch(/#1 fill hollow[\s\S]*◆ checkpoint shell[\s\S]*↷ #4/);
    expect((await call("restore", { name: "shell" })).text).toMatch(/restored "shell" \(undid 2 ops\)/);
    const info = (await call("doc_info")).text;
    expect(info).toMatch(/bounds \(0,0,0\)–\(4,3,4\) = 5×4×5 \(x×y×z\) · 82 blocks/);
    expect(info).toMatch(/components: hut \(0,0,0\)–\(4,3,4\)/);

    // Saved on close, reopened with the same content.
    await session.close();
    expect((await call("doc_list")).text).toMatch(/^hut · /);
    expect((await call("doc_open", { name: "hut" })).text).toMatch(/82 blocks[\s\S]*components: hut/);
    expect((await call("doc_open", { name: "nope" })).text).toMatch(/no document "nope"[\s\S]*have: hut/);
  });

  it("answers queries, analysis, diffs, raycasts and previews", async () => {
    const ctx = await fixtureContext();
    const session = new Session(workspace);
    const client = await connect(Promise.resolve(ctx), session);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: args });
      return { text: textOf(r), error: !!r.isError, images: (r.content as Content).filter((c) => c.type === "image").length };
    };
    await call("doc_new", { name: "perceive", seed: 1, overwrite: true });
    await call("fill", { box: { min: [0, 0, 0], max: [4, 0, 4] }, pattern: "andesite", as: "base" });
    await call("checkpoint", { name: "a" });
    const filled = await call("fill", { box: { min: [0, 1, 0], max: [4, 3, 4] }, pattern: "oak_planks", mode: "walls", preview: true });
    expect(filled.images).toBe(1);
    expect(filled.text).toMatch(/preview: render 512×512 · iso_se[\s\S]*highlighted 48 positions/);

    expect((await call("query_block", { pos: [0, 0, 0] })).text).toBe("(0,0,0) andesite · in: base");
    expect((await call("query_column", { x: 0, z: 0 })).text).toBe("column (0,0) bottom→top: y0 andesite, y1-3 oak_planks");
    expect((await call("query_region", { sel: { min: [0, 0, 0], max: [4, 0, 4] } })).text).toMatch(/^region: 25 positions, 25 blocks \(100% solid\)[\s\S]*by family: andesite 25\ncomponents inside: base/);
    expect((await call("analyze")).text).toMatch(/^box: \(0,0,0\)–\(4,3,4\)[\s\S]*y=0: 25 in x 0\.\.4, z 0\.\.4 \(5×5, 100% filled\)\n {2}y=1\.\.3: 16 in[\s\S]*enclosed air [^\n]*: none/);
    expect((await call("analyze", { component: "base" })).text).toMatch(/^box: \(0,0,0\)–\(4,0,4\), 5×1×5/);
    expect((await call("analyze", { component: "nope" })).text).toMatch(/no component "nope" \(have: base\)/);

    const diff = await call("diff", { since: "checkpoint:a", render: true });
    expect(diff.text).toMatch(/^diff since checkpoint "a" \(1 op\): 48 positions changed[\s\S]*added: oak_planks 48/);
    expect(diff.images).toBe(2);

    const pic = await call("render", { views: ["top"], size: 256, region: { subtract: [{ min: [0, 0, 0], max: [4, 3, 4] }, { min: [3, 0, 3], max: [4, 3, 4] }] }, highlight: { since: "op:-1" }, style: "xray" });
    expect(pic.text).toMatch(/id r\d+[\s\S]*\(selection\)[\s\S]*style xray/);
    const id = /id (r\d+)/.exec(pic.text)![1];
    const hit = await call("raycast", { view: id, px: 128, py: 128 });
    // The middle of the plan looks down through the hollow walls onto the floor.
    expect(hit.text).toBe(`${id} top (128,128) → (2,0,2) andesite, up face`);
    expect((await call("raycast", { px: 5000, py: 5 })).text).toMatch(/outside render/);
    expect((await call("render", { views: ["component:base", "front"], size: 256, cutaway: { plane: "x", at: 1, keep: "west" }, overlays: { components: true } })).text).toMatch(
      /cutaway: kept west of x=1/,
    );
    expect((await call("view_slice", { axis: "y", at: 1, mode: "runs" })).text).toMatch(/z0: x0-4 O/);
  });

  it("exports to the workspace, the instance and a path, and imports the file back", async () => {
    const ctx = await fixtureContext();
    ctx.info.root = join(workspace, "instance");
    const session = new Session(workspace);
    const client = await connect(Promise.resolve(ctx), session);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: args });
      return { text: textOf(r), error: !!r.isError };
    };
    expect((await call("export")).text).toMatch(/No document is open/);
    await call("doc_new", { name: "shed", seed: 1 });
    await call("fill", { box: { min: [0, 0, 0], max: [3, 2, 3] }, pattern: "andesite", mode: "hollow" });
    await call("set_blocks", { blocks: [{ pos: [-1, 0, 1], block: "oak_planks" }] });

    const ws = await call("export");
    expect(ws.text).toMatch(new RegExp(`exported schem → ${join(workspace, "shed", "exports", "shed.schem").replace(/[.]/g, "\\.")}`));
    expect(ws.text).toMatch(/size 5×3×4 \(x×y×z\) · 45 blocks · file \(0,0,0\) = document \(-1,0,0\)/);

    const create = await call("export", { target: "create" });
    expect(create.text).toMatch(/exported nbt → .*instance\/schematics\/shed\.nbt \(\d+ KB of 256 KB limit\)/);
    expect(create.text).toMatch(/Schematic Table[\s\S]*materials: 45 items, 2 kinds\n  44 andesite\n  1 oak_planks/);
    expect((await call("export", { target: "create" })).text).toMatch(/already exists; pass overwrite:true/);

    const file = join(workspace, "out", "shed-v2.schem");
    expect((await call("export", { target: "path", path: file, schem_version: 2 })).error).toBe(false);
    const imp = await call("doc_open", { path: file });
    expect(imp.text).toMatch(/imported .*shed-v2\.schem \(schem\)/);
    expect(imp.text).toMatch(/45 blocks/);
    expect(session.doc!.meta.name).toBe("shed-v2");
    expect((await call("doc_open", { path: file })).text).toMatch(/"shed-v2" already exists/);
    expect((await call("doc_open", {})).text).toMatch(/Give name/);
  });

  it("selects, stores and reuses selections in ops", async () => {
    const ctx = await fixtureContext();
    const session = new Session(workspace);
    const client = await connect(Promise.resolve(ctx), session);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: args });
      return { text: textOf(r), error: !!r.isError };
    };
    await call("doc_new", { name: "tower", seed: 1, overwrite: true });
    const ring = { shell: { cylinder: { center: [5, 0, 5], radius: 3, height: 6 } }, walls_only: true };
    const s = await call("select", { sel: ring, name: "ring" });
    expect(s.text).toMatch(/^stored "ring" · \d+ blocks \(0 solid, \d+ air\) · bbox \(2,0,2\)–\(8,5,8\) = 7×6×7/);
    const f = await call("fill", { sel: "ring", pattern: "andesite", as: "tower" });
    expect(f.text).toMatch(/ok · fill · \d+ blocks changed[\s\S]*component: tower/);
    expect((await call("history")).text).toMatch(/fill sel "ring" andesite as tower/);
    expect((await call("select", { name: "ring" })).text).toMatch(/\d+ solid, 0 air[\s\S]*top: andesite[\s\S]*components: tower/);

    // Flood fill from the wall picks the whole connected tower; replace inside a selection.
    const wallPos = [2, 0, 5];
    expect((await call("replace", { from: "andesite", to: "oak_planks", sel: { layer: { connected: { seed: wallPos } }, y: "max" } })).text).toMatch(/ok · replace/);
    expect((await call("select", { sel: { filter: "all", block: "oak_planks" } })).text).toMatch(/top: oak_planks/);
    expect((await call("clear", { sel: "last" })).text).toMatch(/ok · clear/);
    expect((await call("select", { sel: { filter: "all", block: "oak_planks" } })).text).toBe("selection is empty");

    expect((await call("select")).text).toMatch(/^ring: \{"shell"[\s\S]*last: /);
    expect((await call("doc_info")).text).toMatch(/selections: ring/);
    expect((await call("fill", { sel: "ring", box: { min: [0, 0, 0], max: [0, 0, 0] }, pattern: "andesite" })).text).toBe("give sel or box, not both");
    expect((await call("fill", { sel: { connected: { seed: [0, 7, 0], match: "solid" } }, pattern: "andesite" })).text).toMatch(/selection is empty; connected: the seed/);
    expect((await call("select", { name: "ring", delete: true })).text).toBe('deleted selection "ring"');
    expect((await call("select", { sel: "all", name: "all" })).text).toMatch(/"all" is reserved/);
  });

  it("transforms and brushes through the tools, with as: on any op", async () => {
    const session = new Session(workspace);
    const client = await connect(fixtureContext(), session);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: args });
      return { text: textOf(r), error: !!r.isError };
    };
    await call("doc_new", { name: "xf", seed: 1, overwrite: true });
    await call("set_blocks", { blocks: [{ pos: [0, 0, 0], block: "andesite_stairs[facing=north]" }], as: "step" });
    expect((await call("rotate", { box: { min: [0, 0, 0], max: [0, 0, 0] }, turns: 1 })).text).toMatch(/^ok · rotate · 1 block changed/);
    expect(session.require().getState(0, 0, 0)).toBe("minecraft:andesite_stairs[facing=east]");
    expect((await call("move", { sel: { component: "step" }, by: [2, 0, 0] })).text).toMatch(/^ok · move · 2 blocks changed · box \(0,0,0\)–\(2,0,0\)/);
    expect(session.require().componentLocal("step")!.box.min).toEqual([2, 0, 0]);
    expect((await call("array", { box: { min: [2, 0, 0], max: [2, 0, 0] }, step: [0, 0, 2], count: 3, as: "row" })).text).toMatch(/2 blocks changed[\s\S]*component: row/);
    expect((await call("mirror", { box: { min: [0, 0, 0], max: [4, 0, 4] }, axis: "x", raw: true })).text).toMatch(/^ok · mirror/);
    expect(session.require().getState(2, 0, 4)).toBe("minecraft:andesite_stairs[facing=west]");
    expect((await call("hollow", { box: { min: [0, 0, 0], max: [0, 0, 0] } })).text).toMatch(/nothing changed/);
    expect((await call("clear", { box: { min: [0, 0, 0], max: [4, 0, 4] }, as: "lot" })).text).toMatch(/component: lot/);
  });

  it("returns a preview render from transform and brush tools when asked", async () => {
    const session = new Session(workspace);
    const client = await connect(fixtureContext(), session);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: args });
      return { text: textOf(r), error: !!r.isError, images: (r.content as Content).filter((c) => c.type === "image").length };
    };
    await call("doc_new", { name: "pv", seed: 1, overwrite: true });
    await call("fill", { box: { min: [0, 0, 0], max: [2, 0, 2] }, pattern: "andesite" });
    const moved = await call("move", { box: { min: [0, 0, 0], max: [2, 0, 2] }, by: [0, 1, 0], preview: true });
    expect(moved.images).toBe(1);
    expect(moved.text).toMatch(/^ok · move[\s\S]*preview: render 512×512[\s\S]*highlighted 18 positions/);
    const arr = await call("array", { box: { min: [0, 1, 0], max: [2, 1, 2] }, step: [4, 0, 0], count: 2, preview: true });
    expect(arr.images).toBe(1);
    expect(arr.text).toMatch(/^ok · array[\s\S]*highlighted 9 positions/);
    const swept = await call("sweep", { profile: [{ u: 0, v: 0, block: "oak_planks" }], path: [[0, 3, 0], [0, 3, -3]], preview: true });
    expect(swept.images).toBe(1);
    // Without preview: text only, as before.
    const rot = await call("rotate", { box: { min: [0, 1, 0], max: [2, 1, 2] }, turns: 1 });
    expect(rot.images).toBe(0);
  });
});
