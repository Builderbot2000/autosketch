import { describe, expect, it } from "vitest";
import { fromPublic, type Vec3 } from "../../../src/core/region.js";
import { Document } from "../../../src/document/document.js";
import { componentAnchors, facadeDir, resolveAnchor, resolveFace } from "../../../src/ops/anchors.js";
import { fill } from "../../../src/ops/edit.js";
import { vanillaRegistry } from "../../helpers/vanilla.js";

const registry = vanillaRegistry();
const env = { registry };
const B = (min: Vec3, max: Vec3) => fromPublic({ min, max });

function keepDoc(front: "south" | "east" = "south"): Document {
  const doc = Document.create({ name: "t", dataVersion: 3955, seed: 1, front });
  fill(doc, env, B([0, 0, 0], [8, 5, 6]), "stone", { as: "keep" });
  return doc;
}

describe("anchors (05)", () => {
  it("resolves facades through the document front", () => {
    expect(facadeDir("front", "south")).toBe("south");
    expect(facadeDir("right", "south")).toBe("east");
    expect(facadeDir("left", "south")).toBe("west");
    expect(facadeDir("back", "east")).toBe("west");
    expect(facadeDir("right", "east")).toBe("north");
  });

  it("exposes implicit anchors and echoes absolute coordinates", () => {
    const doc = keepDoc();
    const a = componentAnchors(doc, "keep");
    expect(a).toMatchObject({ min: [0, 0, 0], max: [8, 5, 6], center: [4, 2, 3], bottom: [4, 0, 3], top: [4, 6, 3], front: [4, 2, 6], back: [4, 2, 0], right: [8, 2, 3], left: [0, 2, 3] });
    expect(resolveAnchor(doc, "keep.top")).toEqual({ pos: [4, 6, 3], desc: "keep.top = (4,6,3)" });
    expect(resolveAnchor(doc, { anchor: "keep.front", offset: [0, 0, 3] }).pos).toEqual([4, 2, 9]);
    expect(resolveAnchor(doc, "keep").pos).toEqual([4, 0, 3]); // bare id: base, else bottom
    expect(() => resolveAnchor(doc, "keep.door")).toThrow(/no anchor "door"/);
    expect(() => resolveAnchor(doc, "gate.top")).toThrow(/no component "gate"/);
  });

  it("named anchors win, and component ids with dots resolve", () => {
    const doc = keepDoc();
    doc.edit("t", "t", (tx) => tx.setComponent({ id: "keep.annex", box: B([0, 0, 0], [1, 1, 1]), anchors: { top: [9, 9, 9] } }));
    expect(resolveAnchor(doc, "keep.annex.top").pos).toEqual([9, 9, 9]);
    expect(resolveAnchor(doc, "keep.annex").pos).toEqual([0, 0, 0]);
  });

  it("resolves face coordinates: fractions, block offsets, counting from the end", () => {
    const doc = keepDoc();
    const f = resolveFace(doc, "keep.front"); // south face, u runs west→east
    expect(f).toMatchObject({ dir: "south", origin: [0, 0, 6], u: [1, 0, 0], width: 9, height: 6 });
    expect(resolveAnchor(doc, { face: "keep.front", u: 0.5, v: 0 }).pos).toEqual([4, 0, 6]);
    expect(resolveAnchor(doc, { face: "keep.front", u: 1, v: 1 }).pos).toEqual([8, 5, 6]);
    expect(resolveAnchor(doc, { face: "keep.front", u: 2, v: "3" }).pos).toEqual([2, 3, 6]);
    expect(resolveAnchor(doc, { face: "keep.front", u: -1, v: 0 }).pos).toEqual([8, 0, 6]);
    // The right facade (east) runs south→north for a viewer facing it.
    expect(resolveAnchor(doc, { face: "keep.right", u: 0, v: 0 }).pos).toEqual([8, 0, 6]);
    expect(resolveAnchor(doc, { face: "keep.top", u: 0, v: 1 }).pos).toEqual([0, 5, 6]);
  });

  it("follows the front: a door on the front of an east-facing keep", () => {
    const doc = keepDoc("east");
    expect(resolveFace(doc, "keep.front")).toMatchObject({ dir: "east", origin: [8, 0, 6], u: [0, 0, -1] });
  });

  it("resolves storey:n from named anchors, else from analysis", () => {
    const doc = keepDoc();
    doc.edit("t", "t", (tx) => tx.setComponent({ id: "keep", box: B([0, 0, 0], [8, 5, 6]), anchors: { "storey:2": [0, 4, 0] } }));
    expect(resolveAnchor(doc, { face: "keep.front", u: 0.5, v: "storey:2" }).pos).toEqual([4, 4, 6]);
    expect(resolveAnchor(doc, "keep.storey:2").pos).toEqual([0, 4, 0]); // the named anchor itself
    expect(resolveAnchor(doc, { anchor: "keep.storey_2", offset: [0, 0, 0] }).pos).toEqual([4, 4, 3]); // implicit: footprint centre

    // A hollow two-storey house: analysis finds the floors.
    const h = Document.create({ name: "h", dataVersion: 3955, seed: 1 });
    fill(h, env, B([0, 0, 0], [8, 9, 8]), "stone_bricks", { mode: "walls", as: "house" });
    fill(h, env, B([0, 0, 0], [8, 0, 8]), "oak_planks");
    fill(h, env, B([0, 4, 0], [8, 4, 8]), "oak_planks");
    fill(h, env, B([0, 9, 0], [8, 9, 8]), "oak_planks");
    expect(resolveAnchor(h, { face: "house.front", u: 0.5, v: "storey:1" }, env).pos[1]).toBe(1);
    expect(resolveAnchor(h, { face: "house.front", u: 0.5, v: "storey:2" }, env).pos[1]).toBe(5);
    expect(() => resolveAnchor(h, "house.storey:5", env)).toThrow(/has 2 storeys by analysis/);
  });
});

describe("Document.group (05: one journal entry)", () => {
  it("joins nested edits into one entry and undoes in one step", () => {
    const doc = Document.create({ name: "g", dataVersion: 3955, seed: 1 });
    const before = doc.journal.position;
    const r = doc.group("script", "script", () => {
      fill(doc, env, B([0, 0, 0], [2, 0, 0]), "stone", { as: "a" });
      fill(doc, env, B([1, 0, 0], [3, 0, 0]), "oak_planks");
    });
    expect(doc.journal.position).toBe(before + 1);
    expect(r.changed).toBe(4);
    expect(doc.getState(0, 0, 0)).toBe("minecraft:stone");
    expect(doc.getState(3, 0, 0)).toBe("minecraft:oak_planks");
    doc.undo();
    expect(doc.blockCount()).toBe(0);
    expect(doc.components.size).toBe(0);
    doc.redo();
    expect(doc.blockCount()).toBe(4);
  });

  it("rolls back everything when the body throws, and a caught nested failure keeps earlier writes", () => {
    const doc = Document.create({ name: "g", dataVersion: 3955, seed: 1 });
    fill(doc, env, B([0, 0, 0], [0, 0, 0]), "dirt");
    expect(() =>
      doc.group("script", "script", () => {
        fill(doc, env, B([0, 0, 0], [3, 0, 0]), "stone", { as: "x" });
        throw new Error("halfway");
      }),
    ).toThrow("halfway");
    expect(doc.getState(0, 0, 0)).toBe("minecraft:dirt");
    expect(doc.blockCount()).toBe(1);
    expect(doc.components.size).toBe(0);

    doc.group("script", "script", () => {
      fill(doc, env, B([5, 0, 0], [5, 0, 0]), "stone");
      try {
        doc.edit("bad", "bad", (tx) => {
          tx.set(6, 0, 0, "minecraft:stone");
          throw new Error("inner");
        });
      } catch {
        /* caught by the script */
      }
    });
    expect(doc.getState(5, 0, 0)).toBe("minecraft:stone");
    expect(doc.getState(6, 0, 0)).toBe("minecraft:air");
  });
});
