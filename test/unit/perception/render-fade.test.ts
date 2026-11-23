import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { Mask } from "../../../src/core/mask.js";
import { Document } from "../../../src/document/document.js";
import { setBlocks } from "../../../src/ops/edit.js";
import { TextureLoader } from "../../../src/palette/textures.js";
import { BlockBaker } from "../../../src/perception/render/bake.js";
import { renderDocument } from "../../../src/perception/render/render.js";
import { solidPng } from "../../helpers/fixtures.js";
import { memStack, VANILLA_PARENTS } from "../../helpers/stack.js";

/** `render({fade})` (18, piece 6): everything outside the selection drawn in the ghost style, on any document. */

async function baker() {
  const stack = await memStack([["base", "base", {
    ...VANILLA_PARENTS,
    "assets/test/blockstates/red.json": { variants: { "": { model: "test:block/red" } } },
    "assets/test/models/block/red.json": { parent: "block/cube_all", textures: { all: "test:block/red" } },
    "assets/test/textures/block/red.png": solidPng([200, 30, 30]),
    "assets/test/blockstates/blue.json": { variants: { "": { model: "test:block/blue" } } },
    "assets/test/models/block/blue.json": { parent: "block/cube_all", textures: { all: "test:block/blue" } },
    "assets/test/textures/block/blue.png": solidPng([30, 30, 200]),
  }]]);
  return new BlockBaker(stack, new TextureLoader(stack), undefined);
}

function count(png: Buffer, test: (r: number, g: number, b: number) => boolean): number {
  const p = PNG.sync.read(png);
  let n = 0;
  for (let i = 0; i < p.data.length; i += 4) if (test(p.data[i]!, p.data[i + 1]!, p.data[i + 2]!)) n++;
  return n;
}
const red = (r: number, g: number, b: number) => r > 140 && g < 110 && b < 110;
const blue = (r: number, g: number, b: number) => b > 140 && r < 110 && g < 110;

describe("render fade (18, piece 6)", () => {
  it("draws the selection solid and everything else ghosted, without hiding the selection", async () => {
    const b = await baker();
    const doc = Document.create({ name: "t", dataVersion: 3955, seed: 1 });
    // A red block (the selection) under a blue block, and a blue block beside it, seen from the top.
    setBlocks(doc, {}, [
      { pos: [0, 0, 0], block: "test:red" },
      { pos: [0, 1, 0], block: "test:blue" },
      { pos: [2, 0, 0], block: "test:blue" },
    ]);
    const opts = { views: ["top" as const], size: 128, style: "flat" as const };
    const plain = await renderDocument(doc, b, opts);
    const faded = await renderDocument(doc, b, { ...opts, fade: Mask.fromBox({ min: [0, 0, 0], max: [1, 1, 1] }) });
    // Plain: the blue block on top hides the red one.
    expect(count(plain.png, red)).toBeLessThan(50); // only the red N of the compass
    expect(count(plain.png, blue)).toBeGreaterThan(200);
    // Faded: the red block shows through its ghosted neighbour, and no blue is drawn at full strength.
    expect(count(faded.png, red)).toBeGreaterThan(100);
    expect(count(faded.png, blue)).toBe(0);
    expect(faded.caption).toContain("faded: 2 blocks outside the fade selection drawn grey and translucent; 1 inside it drawn solid");
    expect(plain.caption).not.toContain("faded");
  });

  it("names the coarse parts that meet the drawn box", async () => {
    const b = await baker();
    const doc = Document.create({ name: "t", dataVersion: 3955, seed: 1 });
    setBlocks(doc, {}, [{ pos: [0, 0, 0], block: "test:red" }]);
    const r = await renderDocument(doc, b, {
      views: ["top"],
      size: 128,
      coarse: [
        { box: { min: [0, 0, 0], max: [4, 4, 4] }, cell: 2, partial: true },
        { box: { min: [100, 0, 0], max: [104, 4, 4] }, cell: 4 },
      ],
    });
    expect(r.caption).toContain(
      "coarse: (0,0,0)–(3,3,3) at 2³ cells (partly replaced by full detail): each cell is drawn whole as its most common non-air block, so edges and openings there are approximate; everything else is full detail",
    );
    expect(r.caption).not.toContain("(100,0,0)");
  });
});
