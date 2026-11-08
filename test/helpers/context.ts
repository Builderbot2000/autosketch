import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildPaletteIndexData, PaletteIndex } from "../../src/palette/index.js";
import { PaletteBook } from "../../src/palette/pick.js";
import { SheetRenderer } from "../../src/palette/sheet.js";
import type { InstanceContext } from "../../src/server/context.js";
import { createServer, type ServerOptions } from "../../src/server/server.js";
import { solidPng } from "./fixtures.js";
import { fakeRegistry, partial } from "./registry.js";
import { memStack } from "./stack.js";

/** A tiny instance context (a few vanilla-named blocks, solid textures) for in-process server tests. */
export async function smallContext(): Promise<InstanceContext> {
  const registry = fakeRegistry([
    { id: "minecraft:stone_bricks", tags: ["minecraft:stone_bricks"] },
    { id: "minecraft:cobblestone" },
    { id: "minecraft:oak_planks", tags: ["minecraft:planks"] },
    partial("minecraft:oak_stairs", { properties: { facing: ["north", "south", "east", "west"], half: ["top", "bottom"] }, defaults: { facing: "north", half: "bottom" } }),
    partial("minecraft:oak_door", { properties: { facing: ["north", "south", "east", "west"], half: ["upper", "lower"] }, defaults: { facing: "north", half: "lower" } }),
    partial("minecraft:glass_pane"),
  ]);
  const stack = await memStack([
    ["base", "base", {
      "assets/minecraft/textures/block/stone_bricks.png": solidPng([120, 120, 120]),
      "assets/minecraft/textures/block/cobblestone.png": solidPng([100, 100, 100]),
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

/** An MCP client connected in-process to a fresh server. */
export async function connectServer(ctx: Promise<InstanceContext>, opts: ServerOptions = {}): Promise<Client> {
  const server = createServer(ctx, opts);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
