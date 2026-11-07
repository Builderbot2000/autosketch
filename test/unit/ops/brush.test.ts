import { describe, expect, it } from "vitest";
import { fromPublic, type Vec3 } from "../../../src/core/region.js";
import { Document } from "../../../src/document/document.js";
import { array, extrude, hollow, line, morph, paint, sweep } from "../../../src/ops/brush.js";
import { fill, setBlocks } from "../../../src/ops/edit.js";
import { vanillaRegistry } from "../../helpers/vanilla.js";

const registry = vanillaRegistry();
const env = { registry };
const B = (min: Vec3, max: Vec3) => fromPublic({ min, max });
const newDoc = () => Document.create({ name: "t", dataVersion: 3955, seed: 1 });
const at = (doc: Document, x: number, y: number, z: number) => doc.getState(x, y, z).replace("minecraft:", "");
function counts(doc: Document): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, n] of doc.voxels.histogram()) out[doc.states.get(id).replace("minecraft:", "")] = n;
  return out;
}

describe("brushes (05 L2)", () => {
  it("hollow keeps a shell, optionally rewritten, and registers a component", () => {
    const doc = newDoc();
    fill(doc, env, B([0, 0, 0], [4, 4, 4]), "stone");
    const r = hollow(doc, env, B([0, 0, 0], [4, 4, 4]), 1, undefined, { as: "cube" });
    expect(r.changed).toBe(27);
    expect(counts(doc)).toEqual({ stone: 125 - 27 });
    expect(at(doc, 2, 2, 2)).toBe("air");
    expect(doc.componentLocal("cube")!.box).toEqual(B([0, 0, 0], [4, 4, 4]));
    hollow(doc, env, B([0, 0, 0], [4, 4, 4]), 2, "oak_planks");
    expect(counts(doc)).toEqual({ oak_planks: 125 - 1 });
  });

  it("paint touches only exposed blocks, optionally only some faces", () => {
    const doc = newDoc();
    fill(doc, env, B([0, 0, 0], [2, 2, 2]), "stone");
    paint(doc, env, B([0, 0, 0], [2, 2, 2]), "cobblestone");
    expect(counts(doc)).toEqual({ stone: 1, cobblestone: 26 });
    paint(doc, env, B([0, 0, 0], [2, 2, 2]), "oak_planks", { dirs: ["up"] });
    expect(counts(doc)).toEqual({ stone: 1, cobblestone: 17, oak_planks: 9 });
  });

  it("erode, dilate and smooth clean up shapes", () => {
    const doc = newDoc();
    fill(doc, env, B([0, 0, 0], [4, 0, 4]), "stone");
    setBlocks(doc, env, [{ pos: [2, 1, 2], block: "stone" }]); // a spike
    morph(doc, env, B([-1, 0, -1], [5, 1, 5]), "erode", { threshold: 5 });
    expect(at(doc, 2, 1, 2)).toBe("air"); // 5 air faces
    expect(at(doc, 0, 0, 0)).toBe("stone"); // corners have 4 air faces
    morph(doc, env, B([-1, 0, -1], [5, 1, 5]), "erode", { threshold: 4 });
    expect(at(doc, 0, 0, 0)).toBe("air");
    expect(at(doc, 1, 0, 0)).toBe("stone");
    // Dilate fills the notch back with the neighbouring block.
    morph(doc, env, B([0, 0, 0], [0, 0, 0]), "dilate", { threshold: 2 });
    expect(at(doc, 0, 0, 0)).toBe("stone");
    // Smooth removes a lone block and fills a single-block pit in a solid mass.
    const d2 = newDoc();
    fill(d2, env, B([0, 0, 0], [6, 6, 6]), "stone");
    setBlocks(d2, env, [{ pos: [3, 3, 3], block: "air" }, { pos: [10, 10, 10], block: "stone" }], undefined, { raw: true });
    morph(d2, env, B([2, 2, 2], [4, 4, 4]), "smooth");
    morph(d2, env, B([9, 9, 9], [11, 11, 11]), "smooth");
    expect(at(d2, 3, 3, 3)).toBe("stone");
    expect(at(d2, 10, 10, 10)).toBe("air");
    expect(() => morph(d2, env, B([0, 0, 0], [1, 1, 1]), "erode", { threshold: 7 })).toThrow(/1–6/);
  });

  it("extrudes a face outward along its open side and inward with negative n", () => {
    const doc = newDoc();
    fill(doc, env, B([0, 0, 0], [3, 2, 0]), "oak_planks");
    const r = extrude(doc, env, B([0, 0, 0], [3, 2, 0]), 2, { dir: "south" });
    expect(r.changed).toBe(24);
    expect(at(doc, 1, 1, 2)).toBe("oak_planks");
    expect(at(doc, 1, 1, 3)).toBe("air");
    // Inferred direction: the top layer is open upward the most.
    const r2 = extrude(doc, env, B([0, 2, 0], [3, 2, 2]), 1);
    expect(r2.box).toEqual(B([0, 3, 0], [3, 3, 2]));
    extrude(doc, env, B([0, 3, 0], [3, 3, 2]), -2, { dir: "up" });
    expect(at(doc, 0, 3, 0)).toBe("air");
    // Inward (against dir) clears the face and the layer behind it.
    expect(at(doc, 0, 2, 0)).toBe("air");
    expect(at(doc, 0, 1, 0)).toBe("oak_planks");
    expect(() => extrude(doc, env, B([20, 0, 0], [20, 0, 0]), 1)).toThrow(/no blocks/);
  });

  it("sweeps a profile along a polyline, turning states with each segment", () => {
    const doc = newDoc();
    const profile = [{ u: 0, v: 0, block: "stone" }, { u: 1, v: 0, block: "oak_stairs[facing=north]" }];
    sweep(doc, env, profile, [[0, 0, 0], [0, 0, -3], [3, 0, -3]]);
    // North leg: stairs to the east (u = east), facing north.
    expect(at(doc, 0, 0, -1)).toBe("stone");
    expect(at(doc, 1, 0, -1)).toMatch(/^oak_stairs\[facing=north/);
    // East leg: right of travel is south; stairs turn to face east.
    expect(at(doc, 2, 0, -3)).toBe("stone");
    expect(at(doc, 2, 0, -2)).toMatch(/^oak_stairs\[facing=east/);
    expect(line([0, 0, 0], [2, 1, 4])).toEqual([[0, 0, 0], [1, 0, 1], [1, 1, 2], [2, 1, 3], [2, 1, 4]]);
  });

  it("arrays a selection with a step and count, carrying block entities", () => {
    const doc = newDoc();
    setBlocks(doc, env, [{ pos: [0, 0, 0], block: "stone" }, { pos: [0, 1, 0], block: "oak_planks" }]);
    const r = array(doc, env, B([0, 0, 0], [0, 1, 0]), [3, 0, 0], 4, { as: "columns" });
    expect(r.changed).toBe(6);
    for (const x of [0, 3, 6, 9]) expect([at(doc, x, 0, 0), at(doc, x, 1, 0)]).toEqual(["stone", "oak_planks"]);
    expect(doc.componentLocal("columns")!.box).toEqual(B([0, 0, 0], [9, 1, 0]));
    expect(() => array(doc, env, B([0, 0, 0], [0, 1, 0]), [0, 0, 0], 2)).toThrow(/non-zero/);
  });
});
