import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PNG } from "pngjs";
import { buildPaletteIndexData, PaletteIndex } from "../../../src/palette/index.js";
import { PaletteBook } from "../../../src/palette/pick.js";
import { layoutSheet, columnLabel, SheetRenderer } from "../../../src/palette/sheet.js";
import type { InstanceContext } from "../../../src/server/context.js";
import { configFromEnv } from "../../../src/server/context.js";
import { createServer } from "../../../src/server/server.js";
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

async function connect(ctx: Promise<InstanceContext>) {
  const server = createServer(ctx);
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
    expect(tools).toEqual(["block_info", "instance_info", "palette_pick", "palette_sheet", "palette_show"]);
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
  });
});
