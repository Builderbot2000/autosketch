import { buildPaletteIndexData, PaletteIndex } from "../../../src/palette/index.js";
import { PaletteBook } from "../../../src/palette/pick.js";
import { SheetRenderer } from "../../../src/palette/sheet.js";
import type { InstanceContext } from "../../../src/server/context.js";
import { solidPng } from "../../helpers/fixtures.js";
import { fakeRegistry, partial } from "../../helpers/registry.js";
import { memStack } from "../../helpers/stack.js";

const facing = { properties: { facing: ["north", "south", "east", "west"], half: ["bottom", "top"] }, defaults: { facing: "north", half: "bottom" }, exactProperties: true };

/** A tiny instance: andesite and oak planks with stairs, granite (no stairs), oak log and leaves. */
export async function libraryContext(root = "/fixture"): Promise<InstanceContext> {
  const registry = fakeRegistry([
    { id: "minecraft:andesite", tags: ["c:stones"] },
    partial("minecraft:andesite_stairs", facing),
    partial("minecraft:andesite_slab"),
    { id: "minecraft:granite", tags: ["c:stones"] },
    { id: "minecraft:oak_planks", tags: ["minecraft:planks"] },
    partial("minecraft:oak_stairs", facing),
    partial("minecraft:oak_slab"),
    { id: "minecraft:oak_log", properties: { axis: ["x", "y", "z"] }, defaults: { axis: "y" }, tags: ["minecraft:logs"] },
    { id: "minecraft:oak_leaves", tags: ["minecraft:leaves"] },
    { id: "minecraft:chest", properties: { facing: ["north", "south", "east", "west"] }, defaults: { facing: "north" } },
  ]);
  const tex = (n: string, rgb: [number, number, number]) => [`assets/minecraft/textures/block/${n}.png`, solidPng(rgb)] as const;
  const stack = await memStack([
    ["base", "base", Object.fromEntries([
      tex("andesite", [130, 130, 130]),
      tex("granite", [150, 100, 80]),
      tex("oak_planks", [160, 130, 80]),
      tex("oak_log", [100, 80, 50]),
      tex("oak_leaves", [60, 120, 40]),
      tex("chest", [140, 100, 40]),
    ])],
  ]);
  const palette = new PaletteIndex(await buildPaletteIndexData(stack, registry), registry);
  return {
    info: { name: "Fixture", mcVersion: "1.21.1", launcher: "generic", root },
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
