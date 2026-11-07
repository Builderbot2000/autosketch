import { describe, expect, it } from "vitest";
import { Document } from "../../../src/document/document.js";
import { fill, setBlocks } from "../../../src/ops/edit.js";
import { viewSlice } from "../../../src/perception/slice.js";

describe("view_slice run-length mode", () => {
  it("lists each non-empty row as runs and skips empty rows", () => {
    const doc = Document.create({ name: "s", dataVersion: 3955, seed: 1 });
    fill(doc, {}, { min: [0, 0, 0], max: [100, 1, 1] }, "minecraft:stone");
    setBlocks(doc, {}, [{ pos: [5, 0, 40], block: "minecraft:glass" }, { pos: [6, 0, 40], block: "minecraft:glass" }, { pos: [90, 0, 40], block: "minecraft:stone" }]);
    expect(viewSlice(doc, undefined, { axis: "y", at: 0, mode: "runs" })).toBe(
      [
        "y=0  rows z↓ 0..40, columns x 0..99  (top-down, north up) · runs; rows not listed are empty",
        "z0: x0-99 S",
        "z40: x5-6 G, x90 S",
        "legend: . air, S stone (101), G glass (2)",
      ].join("\n"),
    );
    // The grid mode crops at 64 and suggests runs for the sparse layer.
    const grid = viewSlice(doc, undefined, { axis: "y", at: 0 });
    expect(grid).toMatch(/note: cropped x to 0..63 of 0..99/);
    expect(grid).toMatch(/note: sparse layer: mode:"runs" lists it more briefly/);
  });

  it("works on elevations, top row first", () => {
    const doc = Document.create({ name: "s", dataVersion: 3955, seed: 1 });
    fill(doc, {}, { min: [0, 0, 0], max: [3, 2, 1] }, "minecraft:stone");
    setBlocks(doc, {}, [{ pos: [1, 2, 0], block: "minecraft:glass" }]);
    expect(viewSlice(doc, undefined, { axis: "z", at: 0, mode: "runs" }).split("\n").slice(1, 4)).toEqual(["y2: x1 G", "y1: x0-2 S", "y0: x0-2 S"]);
  });
});
