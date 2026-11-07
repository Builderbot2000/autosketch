import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { Document } from "../../../src/document/document.js";
import { clear, fill, setBlocks } from "../../../src/ops/edit.js";
import { TextureLoader } from "../../../src/palette/textures.js";
import { BlockBaker } from "../../../src/perception/render/bake.js";
import { renderDocument } from "../../../src/perception/render/render.js";
import { getRender, raycast } from "../../../src/perception/render/cameras.js";
import { renderEditPreview } from "../../../src/perception/render/preview.js";
import { Mask } from "../../../src/core/mask.js";
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

describe("render extras", () => {
  const cube = () => {
    const doc = Document.create({ name: "x", dataVersion: 3955, seed: 1 });
    fill(doc, {}, { min: [0, 0, 0], max: [4, 4, 4] }, "test:red", { as: "cube" });
    return doc;
  };

  it("tints highlighted blocks and outlines highlighted air", async () => {
    const { baker } = await fixture();
    const doc = cube();
    clear(doc, { min: [0, 3, 0], max: [1, 4, 1] }); // a removed corner block
    const hl = Mask.fromBox({ min: [0, 3, 0], max: [4, 4, 4] });
    hl.add(9, 9, 9); // outside the document: ignored
    const r = await renderDocument(doc, baker, { views: ["top"], size: 200, highlight: hl });
    const c = pixel(r.png, 100, 100);
    expect(c[1]).toBeGreaterThan(60); // red mixed with orange
    expect(c[0]).toBeGreaterThan(180);
    expect(r.caption).toMatch(/highlighted 16 positions in orange \(1 now air, outlined\)/);
  });

  it("draws depth and xray styles", async () => {
    const { baker } = await fixture();
    const doc = cube();
    const flat = pixel((await renderDocument(doc, baker, { views: ["top"], size: 200, style: "flat" })).png, 100, 100);
    const depth = pixel((await renderDocument(doc, baker, { views: ["top"], size: 200, style: "depth" })).png, 100, 100);
    expect(depth[0]).toBeLessThanOrEqual(flat[0]);
    // X-ray: the top face is translucent, so the background shows through (bluish, not pure red).
    const xray = pixel((await renderDocument(doc, baker, { views: ["top"], size: 200, style: "xray" })).png, 100, 100);
    expect(xray[2]).toBeGreaterThan(60);
    const solid = pixel((await renderDocument(doc, baker, { views: ["top"], size: 200, style: "xray", highlight: Mask.fromBox({ min: [0, 0, 0], max: [4, 4, 4] }) })).png, 100, 100);
    expect(solid[2]).toBeLessThan(40); // highlighted blocks stay solid
  });

  it("takes mask regions, plane cutaways, component views and custom cameras", async () => {
    const { baker } = await fixture();
    const doc = cube();
    setBlocks(doc, {}, [{ pos: [10, 0, 10], block: "test:red" }]);
    const m = Mask.fromBox({ min: [0, 0, 0], max: [4, 1, 4] });
    m.delete(0, 0, 0);
    const masked = await renderDocument(doc, baker, { views: ["top"], region: m });
    expect(masked.caption).toMatch(/drew 15 blocks in \(0,0,0\)–\(3,0,3\) \(selection\)/);
    const cut = await renderDocument(doc, baker, { views: ["front"], cutaway: { plane: "x", at: 1, keep: "west" } });
    expect(cut.caption).toMatch(/drew 32 blocks in \(0,0,0\)–\(1,3,3\) \(cutaway: kept west of x=1\)/);
    const east = await renderDocument(doc, baker, { views: ["front"], cutaway: { plane: "z", at: 2, keep: "south" } });
    expect(east.caption).toMatch(/drew 33 blocks/);
    await expect(renderDocument(doc, baker, { cutaway: { plane: "x", at: 1, keep: "up" } })).rejects.toThrow(/keeps "west" or "east"/);
    const comp = await renderDocument(doc, baker, { views: ["component:cube", "top"], size: 400 });
    expect(comp.caption).toMatch(/component:cube \d+\.\d px\/block · top/);
    await expect(renderDocument(doc, baker, { views: ["component:nope"] })).rejects.toThrow(/no component "nope" \(have: cube\)/);
    const near = await renderDocument(doc, baker, { views: [{ yaw: 0, pitch: 89, distance: 1, target: [10, 0, 10] }], size: 200 });
    expect(near.caption).toMatch(/yaw 0 pitch 89 dist 1 \d+\.\d px\/block/);
    // Zoomed onto the lone block: the centre pixel is red.
    expect(pixel(near.png, 100, 100)[0]).toBeGreaterThan(150);
  });

  it("draws overlays and records cameras that raycast back to blocks", async () => {
    const { baker } = await fixture();
    const doc = cube();
    const r = await renderDocument(doc, baker, { views: ["iso_se", "top"], size: 400, overlays: { components: true, storeys: true } });
    expect(r.id).toMatch(/^r\d+$/);
    expect(getRender(doc)!.id).toBe(r.id);
    // Project known block centres through the stored cameras and cast back.
    for (const view of r.views) {
      for (const p of [[3, 3, 3], [0, 3, 0], [2, 3, 1]] as const) {
        const c = view.cam;
        const q = [p[0] + 0.5, p[1] + 1, p[2] + 0.5]; // middle of the top face
        const sx = q[0]! * c.right[0] + q[1]! * c.right[1] + q[2]! * c.right[2];
        const sy = q[0]! * c.up[0] + q[1]! * c.up[1] + q[2]! * c.up[2];
        const px = Math.floor(view.ox + ((sx - c.cx) * c.scale + c.width / 2) / view.ss);
        const py = Math.floor(view.oy + (-(sy - c.cy) * c.scale + c.height / 2) / view.ss);
        const hit = raycast(doc, getRender(doc, r.id)!, px, py)!;
        expect(hit.view.label).toBe(view.label);
        expect(hit.pos).toEqual([...p]);
        expect(hit.face).toBe("up");
      }
    }
    // Off the build: nothing under the pixel.
    expect(raycast(doc, getRender(doc)!, 2, 190)!.pos).toBeUndefined();
    const thumb = await renderDocument(doc, baker, { views: ["iso_se"], size: 64, thumbnail: true });
    expect(thumb.id).toBeUndefined();
  });

  it("renders an edit preview of the changed region", async () => {
    const { baker } = await fixture();
    const doc = cube();
    const e = setBlocks(doc, {}, [{ pos: [1, 4, 1], block: "test:red" }]);
    const p = (await renderEditPreview(doc, baker, e.seq))!;
    expect(p.caption).toMatch(/render 512×512 · iso_se[\s\S]*drew \d+ blocks in \(0,2,0\)–\(3,4,3\)[\s\S]*highlighted 1 position in orange/);
    expect(await renderEditPreview(doc, baker, 999)).toBeUndefined();
  });
});
