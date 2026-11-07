import { describe, expect, it } from "vitest";
import { canonicalState } from "../../../src/core/blockstate.js";
import { Mask, shellOf } from "../../../src/core/mask.js";
import { fromPublic, type Box, type Vec3 } from "../../../src/core/region.js";
import { Document } from "../../../src/document/document.js";
import { decodeNative, encodeNative } from "../../../src/document/native.js";
import { clear, fill, replace } from "../../../src/ops/edit.js";
import { resolveSelection, summarize, type SelExpr } from "../../../src/ops/selection.js";
import { fakeRegistry } from "../../helpers/registry.js";

const registry = fakeRegistry([{ id: "minecraft:stone" }, { id: "minecraft:oak_planks", tags: ["minecraft:planks"] }, { id: "minecraft:glass" }]);
const env = { registry };
const S = (s: string) => canonicalState(s, registry).state;
const B = (min: Vec3, max: Vec3): Box => fromPublic({ min, max });

const newDoc = () => Document.create({ name: "t", dataVersion: 3955, seed: 1, size: [16, 8, 16] });
const sel = (doc: Document, e: SelExpr) => resolveSelection(e, { doc, registry });
const pts = (m: Mask) => m.positions().map((p) => p.join(",")).sort();
const layerCount = (m: Mask, y: number) => m.positions().filter((p) => p[1] === y).length;

describe("Mask", () => {
  it("stores positions across sections, including negative ones, with set operations", () => {
    const a = new Mask();
    for (const p of [[0, 0, 0], [15, 15, 15], [16, 0, 0], [-1, -1, -1], [-17, 3, 40]] as Vec3[]) a.add(...p);
    expect(a.count()).toBe(5);
    expect(a.has(-1, -1, -1)).toBe(true);
    expect(a.has(-1, -1, 0)).toBe(false);
    expect(a.bbox()).toEqual({ min: [-17, -1, -1], max: [17, 16, 41] });
    const b = Mask.fromBox(B([-1, -1, -1], [0, 0, 0]));
    expect(b.count()).toBe(8);
    expect(a.clone().intersectWith(b).count()).toBe(2);
    expect(a.clone().unionWith(b).count()).toBe(11);
    expect(a.clone().subtract(b).count()).toBe(3);
    expect(a.clone().xorWith(b).count()).toBe(9);
    expect(b.isBox()).toEqual(B([-1, -1, -1], [0, 0, 0]));
    expect(a.isBox()).toBeUndefined();
    a.delete(0, 0, 0);
    expect(a.count()).toBe(4);
    expect(a.translated([1, 0, 0]).has(17, 0, 0)).toBe(true);
  });

  it("shells a box exactly like fill's hollow and walls modes", () => {
    const box = Mask.fromBox(B([0, 0, 0], [4, 3, 4]));
    expect(shellOf(box, 1, false).count()).toBe(5 * 4 * 5 - 3 * 2 * 3);
    expect(shellOf(box, 1, true).count()).toBe((5 * 5 - 3 * 3) * 4);
    expect(shellOf(box, 2, false).count()).toBe(5 * 4 * 5 - 1 * 0 * 1);
  });
});

describe("selection shapes", () => {
  it("box shorthand, box and all", () => {
    const doc = newDoc();
    expect(pts(sel(doc, { min: [1, 1, 1], max: [0, 0, 0] }).mask)).toEqual(pts(Mask.fromBox(B([0, 0, 0], [1, 1, 1]))));
    expect(sel(doc, { box: { min: [0, 0, 0], max: [2, 0, 0] } }).mask.count()).toBe(3);
    expect(sel(doc, "all").mask.count()).toBe(16 * 8 * 16);
  });

  it("cylinders use block-centred radii like WorldEdit", () => {
    const doc = newDoc();
    expect(sel(doc, { cylinder: { center: [5, 0, 5], radius: 0, height: 3 } }).mask.count()).toBe(3);
    expect(layerCount(sel(doc, { cylinder: { center: [5, 0, 5], radius: 1 } }).mask, 0)).toBe(9);
    const r2 = sel(doc, { cylinder: { center: [5, 2, 5], radius: 2, height: 4 } }).mask;
    expect(layerCount(r2, 2)).toBe(21); // 5×5 minus the 4 corners
    expect(r2.bbox()).toEqual({ min: [3, 2, 3], max: [8, 6, 8] });
    const lying = sel(doc, { cylinder: { center: [0, 5, 5], radius: 1, height: 6, axis: "x" } }).mask;
    expect(lying.bbox()).toEqual({ min: [0, 4, 4], max: [6, 7, 7] });
    // Even diameters: centre on a block corner.
    expect(layerCount(sel(doc, { cylinder: { center: [4.5, 0, 4.5], radius: 1.5 } }).mask, 0)).toBe(12);
  });

  it("spheres, ellipsoids, polygons and planes", () => {
    const doc = newDoc();
    expect(sel(doc, { sphere: { center: [5, 5, 5], radius: 1 } }).mask.count()).toBe(19);
    expect(sel(doc, { ellipsoid: { center: [5, 5, 5], radii: [3, 0, 0] } }).mask.count()).toBe(7);
    // An axis-aligned square polygon equals the box over the same corners.
    const sq = sel(doc, { polygon: { points: [[0, 0], [3, 0], [3, 3], [0, 3]], y: [0, 1] } }).mask;
    expect(pts(sq)).toEqual(pts(Mask.fromBox(B([0, 0, 0], [3, 1, 3]))));
    // A right triangle keeps its vertices and edges (closed outline) and its inside.
    const tri = sel(doc, { polygon: { points: [[0, 0], [4, 0], [0, 4]], y: 0 } }).mask;
    for (const p of [[0, 0, 0], [4, 0, 0], [0, 0, 4], [2, 0, 2], [1, 0, 1]] as Vec3[]) expect(tri.has(...p)).toBe(true);
    expect(tri.has(3, 0, 3)).toBe(false);
    expect(sel(doc, { plane: { axis: "y", at: 2 } }).mask.count()).toBe(16 * 16);
    expect(sel(doc, { plane: { axis: "x", at: 0, within: { min: [0, 0, 0], max: [0, 2, 2] } } }).mask.count()).toBe(9);
  });

  it("components and named selections, with clear errors", () => {
    const doc = newDoc();
    fill(doc, env, B([0, 0, 0], [3, 3, 3]), "stone", { as: "core" });
    expect(sel(doc, { component: "core" }).mask.count()).toBe(64);
    expect(() => sel(doc, { component: "nope" })).toThrow(/no component "nope" \(have: core\)/);
    doc.selections.set("a", { component: "core" });
    doc.selections.set("loop1", "loop2");
    doc.selections.set("loop2", "loop1");
    expect(sel(doc, "a").mask.count()).toBe(64);
    expect(() => sel(doc, "loop1")).toThrow(/refers to itself/);
    expect(() => sel(doc, "zzz")).toThrow(/no selection named "zzz"/);
    expect(() => sel(doc, "last")).toThrow(/"last" is undefined/);
    doc.lastSelection = { min: [0, 0, 0], max: [1, 0, 0] };
    expect(sel(doc, "last").mask.count()).toBe(2);
    expect(() => sel(doc, { blob: 1 })).toThrow(/unknown selection.*expected one of: box, cylinder/);
    expect(() => sel(doc, { cylinder: { center: [0, 0, 0], radius: 5000 } })).toThrow(/at most 8,000,000/);
  });
});

describe("picking", () => {
  /** Two stone blobs touching only at a corner, plus a plank on the first. */
  function blobs(): Document {
    const doc = newDoc();
    fill(doc, env, B([0, 0, 0], [2, 1, 2]), "stone");
    fill(doc, env, B([3, 2, 3], [4, 2, 4]), "stone");
    fill(doc, env, B([0, 2, 0], [0, 2, 0]), "oak_planks");
    return doc;
  }

  it("connected flood-fills by block, solid or state, at the chosen connectivity", () => {
    const doc = blobs();
    expect(sel(doc, { connected: { seed: [0, 0, 0] } }).mask.count()).toBe(18);
    expect(sel(doc, { connected: { seed: [0, 0, 0], match: "solid" } }).mask.count()).toBe(19);
    expect(sel(doc, { connected: { seed: [0, 0, 0], connectivity: 26 } }).mask.count()).toBe(18 + 4);
    expect(sel(doc, { connected: { seed: [0, 0, 0], within: { min: [0, 0, 0], max: [0, 1, 1] } } }).mask.count()).toBe(4);
    const air = sel(doc, { connected: { seed: [5, 5, 5], match: "air", within: { min: [5, 5, 5], max: [6, 6, 6] } } });
    expect(air.mask.count()).toBe(8);
    const miss = sel(doc, { connected: { seed: [9, 0, 9], match: "solid" } });
    expect(miss.mask.count()).toBe(0);
    expect(miss.notes[0]).toMatch(/seed \(9,0,9\) is air, which doesn't match "solid"/);
    const airFlood = sel(doc, { connected: { seed: [9, 0, 9] } });
    expect(airFlood.mask.count()).toBeGreaterThan(1000);
    expect(airFlood.notes[0]).toMatch(/is air, so this selects the connected air/);
  });

  it("similar picks everything alike, connected or not", () => {
    const doc = blobs();
    expect(sel(doc, { similar: { seed: [0, 0, 0] } }).mask.count()).toBe(22);
    expect(sel(doc, { similar: { seed: [0, 2, 0], by: "state" } }).mask.count()).toBe(1);
  });
});

describe("booleans and modifiers", () => {
  it("combine and reshape", () => {
    const doc = newDoc();
    const a = { min: [0, 0, 0], max: [3, 0, 3] }, b = { min: [2, 0, 2], max: [5, 0, 5] };
    expect(sel(doc, { union: [a, b] }).mask.count()).toBe(16 + 16 - 4);
    expect(sel(doc, { intersect: [a, b] }).mask.count()).toBe(4);
    expect(sel(doc, { subtract: [a, b] }).mask.count()).toBe(12);
    expect(sel(doc, { xor: [a, b] }).mask.count()).toBe(24);
    expect(sel(doc, { invert: a, within: { min: [0, 0, 0], max: [4, 0, 4] } }).mask.count()).toBe(25 - 16);
    expect(sel(doc, { expand: a, by: 1 }).mask.bbox()).toEqual(B([-1, -1, -1], [4, 1, 4]));
    expect(sel(doc, { expand: a, by: { up: 2 } }).mask.bbox()).toEqual(B([0, 0, 0], [3, 2, 3]));
    expect(sel(doc, { expand: a, by: [1, 0, 0] }).mask.bbox()).toEqual(B([-1, 0, 0], [4, 0, 3]));
    expect(sel(doc, { contract: { min: [0, 0, 0], max: [4, 4, 4] }, by: 1 }).mask.bbox()).toEqual(B([1, 1, 1], [3, 3, 3]));
    expect(sel(doc, { contract: { min: [0, 0, 0], max: [4, 4, 4] }, by: { up: 1, east: 2 } }).mask.bbox()).toEqual(B([0, 0, 0], [2, 3, 4]));
    expect(sel(doc, { offset: a, by: [10, 1, 0] }).mask.bbox()).toEqual(B([10, 1, 0], [13, 1, 3]));
    expect(sel(doc, { shell: { min: [0, 0, 0], max: [4, 3, 4] } }).mask.count()).toBe(100 - 18);
    expect(sel(doc, { layer: { min: [0, 2, 0], max: [1, 5, 1] }, y: "max" }).mask.bbox()).toEqual(B([0, 5, 0], [1, 5, 1]));
    expect(sel(doc, { layer: { min: [0, 2, 0], max: [1, 5, 1] } }).mask.bbox()).toEqual(B([0, 2, 0], [1, 2, 1]));
    expect(sel(doc, { bbox: { union: [{ min: [0, 0, 0], max: [0, 0, 0] }, { min: [3, 3, 3], max: [3, 3, 3] }] } }).mask.count()).toBe(64);
    expect(() => sel(doc, { expand: a, by: { sideways: 1 } })).toThrow(/unknown direction "sideways"/);
  });

  it("surface and filter read the document", () => {
    const doc = newDoc();
    fill(doc, env, B([0, 0, 0], [2, 2, 2]), "stone");
    fill(doc, env, B([0, 3, 0], [0, 3, 0]), "oak_planks");
    expect(sel(doc, { surface: "all" }).mask.count()).toBe(27 - 1 + 1);
    expect(sel(doc, { filter: "all", block: "#minecraft:planks" }).mask.count()).toBe(1);
    expect(sel(doc, { filter: "all", air: false }).mask.count()).toBe(28);
    expect(sel(doc, { filter: { min: [0, 0, 0], max: [3, 0, 0] }, air: true }).mask.count()).toBe(1);
    expect(() => sel(doc, { filter: "all" })).toThrow(/filter needs/);
  });

  it("summarizes what a selection covers", () => {
    const doc = newDoc();
    fill(doc, env, B([0, 0, 0], [1, 0, 1]), "stone", { as: "pad" });
    fill(doc, env, B([5, 0, 5], [5, 0, 5]), "glass", { as: "far" });
    const s = summarize(doc, sel(doc, { min: [0, 0, 0], max: [2, 0, 2] }).mask);
    expect(s).toMatchObject({ count: 9, solid: 4, top: [["minecraft:stone", 4]], components: ["pad"] });
  });
});

describe("ops on selections", () => {
  it("fills a hollow round tower, one undo step", () => {
    const doc = newDoc();
    const cyl = sel(doc, { cylinder: { center: [8, 0, 8], radius: 3, height: 5 } }).mask;
    const r = fill(doc, env, cyl, "stone", { mode: "walls", as: "tower" });
    expect(r.changed).toBeGreaterThan(0);
    expect(doc.getState(8, 2, 8)).toBe("minecraft:air"); // centre stays open
    expect(doc.getState(5, 2, 8)).toBe(S("stone")); // west edge of the ring
    expect(doc.componentLocal("tower")!.box).toEqual(cyl.bbox());
    expect(doc.blockCount()).toBe(shellOf(cyl, 1, true).count());
    doc.undo();
    expect(doc.blockCount()).toBe(0);
  });

  it("hollow on a non-box selection clears its inside; box-shaped selections match the box path", () => {
    const doc = newDoc();
    fill(doc, env, B([0, 0, 0], [6, 4, 6]), "oak_planks");
    const L = sel(doc, { union: [{ min: [0, 0, 0], max: [5, 3, 1] }, { min: [0, 0, 0], max: [1, 3, 5] }] }).mask;
    fill(doc, env, L, "stone", { mode: "hollow" });
    expect(doc.getState(0, 1, 0)).toBe(S("stone"));
    expect(doc.getState(6, 0, 6)).toBe(S("oak_planks")); // outside the selection: untouched

    const a = newDoc(), b = newDoc();
    fill(a, env, B([0, 0, 0], [4, 3, 4]), "stone", { mode: "outline" });
    fill(b, env, Mask.fromBox(B([0, 0, 0], [4, 3, 4])), "stone", { mode: "outline" });
    expect(b.blockCount()).toBe(a.blockCount());
  });

  it("replace and clear stay inside the selection", () => {
    const doc = newDoc();
    fill(doc, env, B([0, 0, 0], [7, 0, 7]), "stone");
    const disc = sel(doc, { cylinder: { center: [3, 0, 3], radius: 2 } }).mask;
    replace(doc, env, disc, "stone", "oak_planks");
    expect(doc.getState(3, 0, 3)).toBe(S("oak_planks"));
    expect(doc.getState(0, 0, 0)).toBe(S("stone"));
    expect(sel(doc, { filter: "all", block: "oak_planks" }).mask.count()).toBe(21);
    clear(doc, sel(doc, { connected: { seed: [3, 0, 3] } }).mask);
    expect(doc.blockCount()).toBe(64 - 21);
    expect(() => fill(doc, env, new Mask(), "stone")).toThrow(/selection is empty/);
  });

  it("named selections are saved with the document", () => {
    const doc = newDoc();
    doc.selections.set("ring", { shell: { cylinder: { center: [4, 0, 4], radius: 3 } }, walls_only: true });
    const back = decodeNative(encodeNative(doc));
    expect(back.selections.get("ring")).toEqual(doc.selections.get("ring"));
  });
});
