import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { Document } from "../../../src/document/document.js";
import { fill, setBlocks } from "../../../src/ops/edit.js";
import { TextureLoader } from "../../../src/palette/textures.js";
import { BlockBaker } from "../../../src/perception/render/bake.js";
import { renderDocument } from "../../../src/perception/render/render.js";
import { solidPng } from "../../helpers/fixtures.js";
import { memStack, VANILLA_PARENTS } from "../../helpers/stack.js";

const RED: [number, number, number] = [200, 30, 30];
const GREEN: [number, number, number] = [30, 200, 30];
const GREY: [number, number, number] = [120, 120, 120];

async function fixture() {
  const stack = await memStack([
    [
      "base",
      "base",
      {
        ...VANILLA_PARENTS,
        "assets/test/blockstates/red.json": { variants: { "": { model: "test:block/red" } } },
        "assets/test/models/block/red.json": { parent: "block/cube_all", textures: { all: "test:block/red" } },
        "assets/test/textures/block/red.png": solidPng(RED),
        // A "pillar" whose east face is green; facing=south rotates it y=90, so green ends up south.
        "assets/test/blockstates/marker.json": { variants: { "facing=east": { model: "test:block/marker" }, "facing=south": { model: "test:block/marker", y: 90 } } },
        "assets/test/models/block/marker.json": {
          parent: "block/cube",
          textures: { down: "test:block/grey", up: "test:block/grey", north: "test:block/grey", south: "test:block/grey", west: "test:block/grey", east: "test:block/green", particle: "test:block/grey" },
        },
        "assets/test/textures/block/grey.png": solidPng(GREY),
        "assets/test/textures/block/green.png": solidPng(GREEN),
        "assets/test/blockstates/half.json": { variants: { "": { model: "test:block/half" } } },
        "assets/test/models/block/half.json": {
          elements: [{ from: [0, 0, 0], to: [16, 8, 16], faces: { down: { texture: "#t", cullface: "down" }, up: { texture: "#t" }, north: { texture: "#t", cullface: "north" } } }],
          textures: { t: "test:block/grey" },
        },
      },
    ],
  ]);
  const baker = new BlockBaker(stack, new TextureLoader(stack), undefined);
  return { stack, baker };
}

const pixel = (png: Buffer, x: number, y: number) => {
  const p = PNG.sync.read(png);
  const i = (y * p.width + x) * 4;
  return [p.data[i]!, p.data[i + 1]!, p.data[i + 2]!];
};

describe("block baking", () => {
  it("bakes cubes with game-style shading and occlusion faces", async () => {
    const { baker } = await fixture();
    const red = await baker.bake("test:red");
    expect(red.fallback).toBe(false);
    expect(red.quads).toHaveLength(6);
    expect([...red.occludes].sort()).toEqual(["down", "east", "north", "south", "up", "west"]);
    const up = red.quads.find((q) => q.cull === "up")!;
    expect(up.shade).toBeCloseTo(1);
    expect(red.quads.find((q) => q.cull === "down")!.shade).toBeCloseTo(0.5);
    expect(red.quads.find((q) => q.cull === "east")!.shade).toBeCloseTo(0.6);
    // A half block only hides what is against its full bottom face (its north face is half height).
    expect([...(await baker.bake("test:half")).occludes]).toEqual(["down"]);
  });

  it("applies blockstate rotation to geometry and cull faces", async () => {
    const { baker } = await fixture();
    const east = await baker.bake("test:marker[facing=east]");
    const south = await baker.bake("test:marker[facing=south]");
    const green = (b: typeof east) => b.quads.find((q) => q.tex.mean[1] > 150)!;
    expect(green(east).cull).toBe("east");
    expect(green(south).cull).toBe("south");
    // All four corners of the rotated green face lie on the south plane z = 1.
    const zs = [2, 5, 8, 11].map((i) => green(south).pos[i]!);
    expect(zs.every((z) => Math.abs(z - 1) < 1e-6)).toBe(true);
    expect(green(south).shade).toBeCloseTo(0.8);
  });

  it("falls back to a placeholder for blocks without a model", async () => {
    const { baker } = await fixture();
    expect((await baker.bake("test:nothing")).fallback).toBe(true);
  });
});

describe("render", () => {
  it("draws views with textures, shading and a caption", async () => {
    const { baker } = await fixture();
    const doc = Document.create({ name: "r", dataVersion: 3955, seed: 1 });
    fill(doc, {}, { min: [0, 0, 0], max: [3, 3, 3] }, "test:red");
    const top = await renderDocument(doc, baker, { views: ["top"], size: 200 });
    expect([top.width, top.height]).toEqual([200, 200]);
    const c = pixel(top.png, 100, 100);
    expect(c[0]).toBeGreaterThan(180); // lit top face: full red
    expect(c[1]).toBeLessThan(60);
    const front = await renderDocument(doc, baker, { views: ["front"], size: 200 });
    const f = pixel(front.png, 100, 100);
    expect(f[0]).toBeGreaterThan(140); // south face: 0.8 shade
    expect(f[0]).toBeLessThan(c[0]);
    expect(front.caption).toMatch(/render 200×200 · front \d+\.\d px\/block/);
    expect(front.caption).toMatch(/drew 27 blocks in \(0,0,0\)–\(2,2,2\)/);
  });

  it("lays out several views, honours cutaway and reports missing models", async () => {
    const { baker } = await fixture();
    const doc = Document.create({ name: "r", dataVersion: 3955, seed: 1 });
    fill(doc, {}, { min: [0, 0, 0], max: [4, 4, 4] }, "test:red");
    setBlocks(doc, {}, [{ pos: [0, 4, 0], block: "test:nothing" }]);
    const sheet = await renderDocument(doc, baker, { views: ["iso_se", "iso_nw", "front", "top"], size: 400 });
    expect([sheet.width, sheet.height]).toEqual([400, 400]);
    expect(sheet.caption).toMatch(/no model for test:nothing/);
    const pair = await renderDocument(doc, baker, { views: ["iso_se", "front"], size: 400 });
    expect([pair.width, pair.height]).toEqual([400, 200]);
    const cut = await renderDocument(doc, baker, { views: ["top"], cutaway: { maxY: 1 } });
    expect(cut.caption).toMatch(/drew 32 blocks in \(0,0,0\)–\(3,1,3\) \(cutaway above y=1\)/);
    const empty = await renderDocument(Document.create({ name: "e", dataVersion: 1 }), baker);
    expect(empty.caption).toMatch(/Nothing to draw/);
    await expect(renderDocument(doc, baker, { views: ["top", "top", "top", "top", "top"] })).rejects.toThrow(/at most 4 views/);
  });
});
