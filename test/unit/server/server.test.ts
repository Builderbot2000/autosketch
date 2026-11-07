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
      "block_info", "checkpoint", "clear", "doc_info", "doc_list", "doc_new", "doc_open", "fill", "history", "instance_info",
      "palette_pick", "palette_sheet", "palette_show", "redo", "render", "replace", "restore", "set_blocks", "undo", "view_slice",
    ]);
    expect(client.getInstructions()).toMatch(/palette:<name>\.<role>/);
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
  });

  it("builds, checks, undoes, checkpoints and reopens a document", async () => {
    const ctx = await fixtureContext();
    const session = new Session(workspace);
    const client = await connect(Promise.resolve(ctx), session);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: args });
      return { text: textOf(r), error: !!r.isError };
    };

    expect((await call("fill", { box: { min: [0, 0, 0], max: [1, 1, 1] }, material: "andesite" })).text).toMatch(/No document is open/);
    expect((await call("doc_new", { name: "hut", size: [5, 4, 5], seed: 3 })).text).toMatch(/created "hut"[\s\S]*doc 5×4×5/);
    expect((await call("doc_new", { name: "hut" })).text).toMatch(/already exists/);

    const walls = await call("fill", { box: { min: [0, 0, 0], max: [4, 3, 4] }, material: "andesite", mode: "hollow", as: "hut" });
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
});
