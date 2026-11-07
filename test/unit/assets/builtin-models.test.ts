import { describe, expect, it } from "vitest";
import { builtinModel, codeDrawnKind } from "../../../src/assets/builtin-models/index.js";
import { boxUnwrap, fitUv, rotationDegrees, splitAngle } from "../../../src/assets/builtin-models/geometry.js";
import { TextureLoader } from "../../../src/palette/textures.js";
import { BlockBaker } from "../../../src/perception/render/bake.js";
import { solidPng } from "../../helpers/fixtures.js";
import { memStack } from "../../helpers/stack.js";

const BROWN: [number, number, number] = [150, 100, 40];
const PLANK: [number, number, number] = [180, 140, 90];
const RED: [number, number, number] = [200, 30, 30];

/** Vanilla-shaped code-drawn blocks: blockstates whose models carry only a particle texture. */
async function fixture() {
  const stack = await memStack([
    [
      "base",
      "base",
      {
        "assets/minecraft/blockstates/chest.json": { variants: { "": { model: "minecraft:block/chest" } } },
        "assets/minecraft/models/block/chest.json": { textures: { particle: "minecraft:block/oak_planks" } },
        "assets/minecraft/textures/entity/chest/normal.png": solidPng(BROWN),
        "assets/minecraft/textures/block/oak_planks.png": solidPng(PLANK),
        "assets/minecraft/blockstates/red_bed.json": { variants: { "": { model: "minecraft:block/bed" } } },
        "assets/minecraft/models/block/bed.json": { textures: { particle: "minecraft:block/oak_planks" } },
        "assets/minecraft/textures/entity/bed/red.png": solidPng(RED),
        // No entity texture for the sign: the particle texture stands in.
        "assets/minecraft/blockstates/oak_sign.json": { variants: { "": { model: "minecraft:block/oak_sign" } } },
        "assets/minecraft/models/block/oak_sign.json": { textures: { particle: "minecraft:block/oak_planks" } },
        "assets/minecraft/blockstates/odd_widget.json": { variants: { "": { model: "minecraft:block/odd_widget" } } },
        "assets/minecraft/models/block/odd_widget.json": { textures: { particle: "minecraft:block/oak_planks" } },
      },
    ],
  ]);
  return new BlockBaker(stack, new TextureLoader(stack), undefined);
}

const bounds = (quads: { pos: Float32Array }[]) => {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const q of quads)
    for (let i = 0; i < 12; i++) {
      min[i % 3] = Math.min(min[i % 3]!, q.pos[i]!);
      max[i % 3] = Math.max(max[i % 3]!, q.pos[i]!);
    }
  return { min: min.map((v) => Math.round(v * 16)), max: max.map((v) => Math.round(v * 16)) };
};

describe("code-drawn kinds", () => {
  it("recognises vanilla and modded code-drawn blocks by name", () => {
    expect(codeDrawnKind("minecraft:trapped_chest")).toBe("chest");
    expect(codeDrawnKind("ironchest:diamond_chest")).toBe("chest");
    expect(codeDrawnKind("minecraft:light_blue_shulker_box")).toBe("shulker");
    expect(codeDrawnKind("minecraft:cherry_wall_hanging_sign")).toBe("sign");
    expect(codeDrawnKind("minecraft:red_wall_banner")).toBe("banner");
    expect(codeDrawnKind("minecraft:creeper_wall_head")).toBe("head");
    expect(codeDrawnKind("minecraft:bell")).toBe("bell");
    expect(codeDrawnKind("minecraft:stone")).toBeUndefined();
  });

  it("references the instance's own entity textures", () => {
    const tex = (id: string, props = {}) => new Set(builtinModel(id, props)!.parts.flatMap((p) => p.elements.flatMap((e) => Object.values(e.faces).map((f) => f!.texture))));
    expect([...tex("minecraft:chest")]).toEqual(["minecraft:entity/chest/normal"]);
    expect([...tex("minecraft:ender_chest")]).toEqual(["minecraft:entity/chest/ender"]);
    expect([...tex("minecraft:red_bed", { part: "head" })]).toEqual(["minecraft:entity/bed/red"]);
    expect([...tex("minecraft:spruce_wall_sign", { facing: "north" })]).toEqual(["minecraft:entity/signs/spruce"]);
    expect([...tex("minecraft:oak_hanging_sign", { rotation: "0" })]).toEqual(["minecraft:entity/signs/hanging/oak"]);
    expect([...tex("minecraft:zombie_head", { rotation: "0" })]).toEqual(["minecraft:entity/zombie/zombie"]);
    expect([...tex("minecraft:red_shulker_box")]).toEqual(["minecraft:block/red_shulker_box"]);
    expect(builtinModel("minecraft:bell", { attachment: "floor", facing: "north" })!.overlay).toBe(true);
  });

  it("tints banner cloth with its dye colour, not the pole", () => {
    const m = builtinModel("minecraft:blue_banner", { rotation: "0" })!;
    const colors = m.parts[0]!.elements.map((e) => e.faces.north?.color);
    expect(colors).toEqual([undefined, undefined, "ff3c44aa"]);
  });
});

describe("geometry helpers", () => {
  it("unwraps a box like the entity texture layout", () => {
    expect(boxUnwrap(0, 0, 8, 8, 8)).toEqual({
      top: [8, 0, 16, 8], bottom: [16, 0, 24, 8], right: [0, 8, 8, 16], front: [8, 8, 16, 16], left: [16, 8, 24, 16], back: [24, 8, 32, 16],
    });
  });
  it("turns rotation=0..15 into whole steps plus a remainder", () => {
    expect(rotationDegrees("0")).toBe(180);
    expect(splitAngle(rotationDegrees("2"))).toEqual({ step: 180, rest: 45 });
    expect(splitAngle(rotationDegrees("8"))).toEqual({ step: 0, rest: 0 });
  });
  it("rescales V for a texture drawn at another aspect", () => {
    const head = builtinModel("minecraft:skeleton_skull", { rotation: "0" })!.parts[0]!.elements[0]!;
    const front = head.faces.north!;
    expect(front.uv).toEqual([2, 4, 4, 8]); // 64×32 layout: (8,8)-(16,16)
    expect(fitUv(front, 64, 64).uv).toEqual([2, 2, 4, 4]); // same pixels on a 64×64 redraw
    expect(fitUv(front, 64, 32)).toBe(front);
  });
});

describe("baking code-drawn blocks", () => {
  it("draws a chest as a chest, not a particle cube", async () => {
    const baker = await fixture();
    const chest = await baker.bake("minecraft:chest[facing=north,type=single]");
    expect(chest.fallback).toBe(false);
    expect(chest.quads).toHaveLength(18); // base, lid, latch
    expect(bounds(chest.quads)).toEqual({ min: [1, 0, 0], max: [15, 14, 15] });
    expect(chest.quads.every((q) => q.tex.mean[0] === BROWN[0])).toBe(true);
    // Facing south turns the latch to the south side.
    const south = await baker.bake("minecraft:chest[facing=south,type=single]");
    expect(bounds(south.quads)).toEqual({ min: [1, 0, 1], max: [15, 14, 16] });
    // A double chest's half reaches its partner's side: left joins clockwise of facing (east for north).
    expect(bounds((await baker.bake("minecraft:chest[facing=north,type=left]")).quads).max[0]).toBe(16);
    expect(bounds((await baker.bake("minecraft:chest[facing=north,type=right]")).quads).min[0]).toBe(0);
  });

  it("draws a bed half as a mattress on legs", async () => {
    const baker = await fixture();
    const head = await baker.bake("minecraft:red_bed[facing=north,part=head,occupied=false]");
    expect(bounds(head.quads)).toEqual({ min: [0, 0, 0], max: [16, 9, 16] });
    expect(head.quads.every((q) => q.tex.mean[0] === RED[0])).toBe(true);
    expect(head.occludes.size).toBe(0);
  });

  it("draws a sign with the particle texture when the entity texture is missing", async () => {
    const baker = await fixture();
    const sign = await baker.bake("minecraft:oak_sign[rotation=8,waterlogged=false]");
    expect(sign.fallback).toBe(false);
    expect(bounds(sign.quads)).toEqual({ min: [0, 0, 7], max: [16, 16, 9] });
    expect(sign.quads.every((q) => q.tex.mean[0] === PLANK[0])).toBe(true);
  });

  it("keeps the particle cube for geometry-less blocks it doesn't know", async () => {
    const baker = await fixture();
    const odd = await baker.bake("minecraft:odd_widget");
    expect(bounds(odd.quads)).toEqual({ min: [1, 0, 1], max: [15, 14, 15] });
  });

  it("lets a render hook replace or overlay a block's model", async () => {
    const stack = await memStack([["base", "base", { "assets/minecraft/textures/block/oak_planks.png": solidPng(PLANK) }]]);
    const calls: unknown[] = [];
    const hook = {
      render: (pos: unknown, state: string, nbt: unknown) => {
        calls.push([pos, state, nbt]);
        if (!state.startsWith("test:framed")) return null;
        return { parts: [{ elements: [{ from: [0, 0, 0] as [number, number, number], to: [16, 8, 16] as [number, number, number], faces: { up: { texture: "minecraft:block/oak_planks" } } }] }] };
      },
    };
    const baker = new BlockBaker(stack, new TextureLoader(stack), undefined, undefined, [hook]);
    const framed = await baker.bake("test:framed_slab");
    expect(framed.quads).toHaveLength(1);
    expect(framed.quads[0]!.tex.mean[0]).toBe(PLANK[0]);
    expect((await baker.bake("test:other")).fallback).toBe(true);
    const at = await baker.bakeAt([1, 2, 3], "test:framed_slab", { type: "compound", name: "", value: {} });
    expect(at.quads).toHaveLength(1);
    expect(calls.at(-1)).toEqual([[1, 2, 3], "test:framed_slab", { type: "compound", name: "", value: {} }]);
  });
});
