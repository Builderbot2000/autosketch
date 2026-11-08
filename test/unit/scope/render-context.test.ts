import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { Mask } from "../../../src/core/mask.js";
import { Document } from "../../../src/document/document.js";
import { setBlocks } from "../../../src/ops/edit.js";
import { TextureLoader } from "../../../src/palette/textures.js";
import { BlockBaker } from "../../../src/perception/render/bake.js";
import { renderDocument } from "../../../src/perception/render/render.js";
import { viewSlice } from "../../../src/perception/slice.js";
import { solidPng } from "../../helpers/fixtures.js";
import { memStack, VANILLA_PARENTS } from "../../helpers/stack.js";

async function baker() {
  const stack = await memStack([["base", "base", {
    ...VANILLA_PARENTS,
    "assets/test/blockstates/red.json": { variants: { "": { model: "test:block/red" } } },
    "assets/test/models/block/red.json": { parent: "block/cube_all", textures: { all: "test:block/red" } },
    "assets/test/textures/block/red.png": solidPng([200, 30, 30]),
    "assets/test/blockstates/grey.json": { variants: { "": { model: "test:block/grey" } } },
    "assets/test/models/block/grey.json": { parent: "block/cube_all", textures: { all: "test:block/grey" } },
    "assets/test/textures/block/grey.png": solidPng([120, 120, 120]),
  }]]);
  return new BlockBaker(stack, new TextureLoader(stack), undefined);
}

/** Pixels where red clearly dominates. */
function redPixels(png: Buffer): number {
  const p = PNG.sync.read(png);
  let n = 0;
  for (let i = 0; i < p.data.length; i += 4) if (p.data[i]! > 140 && p.data[i + 1]! < 110 && p.data[i + 2]! < 110) n++;
  return n;
}

describe("context volume in perception (11, 06)", () => {
  it("ghosts context so it never hides editable blocks, or draws it normally, or hides it", async () => {
    const b = await baker();
    const doc = Document.create({ name: "t", dataVersion: 3955, seed: 1 });
    // A red work block under a grey context block, seen from the top.
    setBlocks(doc, {}, [{ pos: [0, 0, 0], block: "test:red" }, { pos: [0, 1, 0], block: "test:grey" }]);
    doc.context = Mask.fromBox({ min: [0, 1, 0], max: [1, 2, 1] });
    const opts = { views: ["top" as const], size: 128, style: "flat" as const };
    const normal = await renderDocument(doc, b, { ...opts, context: "normal" });
    const ghost = await renderDocument(doc, b, opts);
    const hidden = await renderDocument(doc, b, { ...opts, context: "hide" });
    expect(redPixels(normal.png)).toBeLessThan(50); // only the red N of the compass
    expect(redPixels(ghost.png)).toBeGreaterThan(100);
    expect(redPixels(hidden.png)).toBeGreaterThan(100);
    expect(ghost.caption).toMatch(/1 read-only context blocks ghosted/);
    expect(hidden.caption).toMatch(/drew 1 blocks .*\ncontext hidden/);
  });

  it("marks context rows in slices", () => {
    const doc = Document.create({ name: "t", dataVersion: 3955, seed: 1 });
    setBlocks(doc, {}, [{ pos: [0, 0, 0], block: "stone" }, { pos: [4, 0, 2], block: "stone" }]);
    const ctx = Mask.fromBox({ min: [0, 0, 0], max: [5, 1, 1] });
    ctx.add(4, 0, 2);
    ctx.add(3, 0, 2);
    doc.context = ctx;
    const s = viewSlice(doc, undefined, { axis: "y", at: 0 });
    expect(s.split("\n").filter((l) => /^\s*\d [.A-Z]/.test(l))).toEqual(["0 S....  | ctx", "1 .....", "2 ....S  | ctx x3..4"]);
    expect(s).toMatch(/"\| ctx" marks read-only context/);
  });
});
