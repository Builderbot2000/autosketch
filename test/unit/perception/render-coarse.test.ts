import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { Mask } from "../../../src/core/mask.js";
import type { Box } from "../../../src/core/region.js";
import { Document } from "../../../src/document/document.js";
import { TextureLoader } from "../../../src/palette/textures.js";
import { BlockBaker } from "../../../src/perception/render/bake.js";
import { renderDocument } from "../../../src/perception/render/render.js";
import { solidPng } from "../../helpers/fixtures.js";
import { memStack, VANILLA_PARENTS } from "../../helpers/stack.js";

/**
 * Coarse parts drawn one cube per cell (18, piece 5 and *Measured*: rendering is the cost). The
 * world view writes a coarse cell's block over the whole cell; the renderer draws a whole cell as
 * one cube, and a cell met by another read, or cut by a mask, block by block as before.
 */

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

/** A document holding a coarse read: each 4³ cell of `box` written whole, red, with a blue cell every third. */
function coarseDoc(box: Box, c = 4): Document {
  const doc = Document.create({ name: "t", dataVersion: 3955, seed: 1 });
  const red = doc.states.intern("test:red"), blue = doc.states.intern("test:blue");
  for (let y = box.min[1]; y < box.max[1]; y++)
    for (let z = box.min[2]; z < box.max[2]; z++)
      for (let x = box.min[0]; x < box.max[0]; x++) {
        const cell = Math.floor(x / c) + Math.floor(y / c) + Math.floor(z / c);
        doc.voxels.set(x, y, z, cell % 3 === 0 ? blue : red);
      }
  doc.bounds = box;
  return doc;
}

function diff(a: Buffer, b: Buffer): number {
  const p = PNG.sync.read(a), q = PNG.sync.read(b);
  let n = 0;
  for (let i = 0; i < p.data.length; i += 4) if (Math.max(Math.abs(p.data[i]! - q.data[i]!), Math.abs(p.data[i + 1]! - q.data[i + 1]!), Math.abs(p.data[i + 2]! - q.data[i + 2]!)) > 40) n++;
  return n;
}

const box: Box = { min: [0, 0, 0], max: [8, 4, 8] };

describe("render coarse parts one cube per cell (18, V3)", () => {
  it("draws each whole cell as one cube and looks as the per-block render does", async () => {
    const b = await baker();
    const doc = coarseDoc(box);
    for (const style of ["flat", "textured"] as const)
      for (const views of [["iso_se"], ["top"], [{ eye: [-6, 9, 14], target: [4, 2, 4] }]] as const) {
        const opts = { views: [...views], size: 256, style };
        const blocks = await renderDocument(doc, b, opts);
        const cubes = await renderDocument(doc, b, { ...opts, coarse: [{ box, cell: 4 }] });
        expect(blocks.caption).toContain("drew 256 blocks in (0,0,0)–(7,3,7)");
        expect(cubes.caption).toContain("drew 0 blocks and 4 coarse cells (one cube each) in (0,0,0)–(7,3,7)");
        expect(cubes.caption).toContain("coarse: (0,0,0)–(7,3,7) at 4³ cells: each cell is drawn whole, as one cube of its most common non-air block");
        // Same picture: only edge pixels along the cube seams may differ.
        expect(diff(blocks.png, cubes.png)).toBeLessThan(40);
      }
  });

  it("draws the cells another read met, and cells a mask cuts, block by block", async () => {
    const b = await baker();
    const doc = coarseDoc(box);
    // A full read replaced the cell at (4..8, 0..4, 0..4): it is drawn per block.
    const met = await renderDocument(doc, b, { views: ["top"], size: 128, coarse: [{ box, cell: 4, except: [{ min: [5, 1, 1], max: [6, 2, 2] }] }] });
    expect(met.caption).toContain("drew 64 blocks and 3 coarse cells (one cube each)");
    // A region mask cutting one cell, and a fade covering half of another.
    const region = Mask.fromBox(box);
    region.delete(0, 0, 0);
    const cut = await renderDocument(doc, b, { views: ["top"], size: 128, region, fade: Mask.fromBox({ min: [4, 0, 4], max: [6, 4, 8] }), coarse: [{ box, cell: 4 }] });
    expect(cut.caption).toContain("drew 127 blocks and 2 coarse cells (one cube each)");
    // A fade or highlight covering whole cells keeps them cubes, and counts their blocks.
    const whole = await renderDocument(doc, b, {
      views: ["top"], size: 128, fade: Mask.fromBox({ min: [0, 0, 0], max: [4, 4, 8] }), highlight: Mask.fromBox({ min: [4, 0, 0], max: [8, 4, 4] }), coarse: [{ box, cell: 4 }],
    });
    expect(whole.caption).toContain("drew 0 blocks and 4 coarse cells (one cube each)");
    expect(whole.caption).toContain("highlighted 64 positions in orange");
    expect(whole.caption).toContain("faded: 128 blocks outside the fade selection drawn grey and translucent; 128 inside it drawn solid");
  });

  it("pins the cost: a 768-block square read at 4³ draws one cube per cell, in seconds", async () => {
    const b = await baker();
    const big: Box = { min: [0, 0, 0], max: [768, 32, 768] };
    const doc = Document.create({ name: "big", dataVersion: 3955, seed: 1 });
    const red = doc.states.intern("test:red");
    // 18.9 M positions, written section by section (as the view holds a coarse read: every position).
    for (let sy = 0; sy < 2; sy++)
      for (let sz = 0; sz < 48; sz++)
        for (let sx = 0; sx < 48; sx++) doc.voxels.putSection({ sx, sy, sz, ids: new Uint16Array(4096).fill(red), count: 4096 });
    doc.bounds = big;
    const t = performance.now();
    const r = await renderDocument(doc, b, { views: ["iso_se"], size: 512, style: "flat", coarse: [{ box: big, cell: 4 }] });
    const ms = performance.now() - t;
    // 192 × 8 × 192 cells, each one cube; no block visited one by one (the per-block path drew all 18.9 M).
    expect(r.caption).toContain("drew 0 blocks and 294,912 coarse cells (one cube each) in (0,0,0)–(767,31,767)");
    // Loose bound (about 1 s when idle; the per-block render of the same square takes minutes).
    expect(ms).toBeLessThan(15_000);
  }, 60_000);
});
