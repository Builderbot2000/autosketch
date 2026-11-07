import { describe, expect, it } from "vitest";
import type { Mask } from "../../../src/core/mask.js";
import { fromPublic, type Vec3 } from "../../../src/core/region.js";
import { Document } from "../../../src/document/document.js";
import { fill, setBlocks } from "../../../src/ops/edit.js";
import { freezeNodes, resolveSelection, type SelExpr } from "../../../src/ops/selection.js";
import { fakeRegistry } from "../../helpers/registry.js";

const registry = fakeRegistry([{ id: "minecraft:stone" }, { id: "minecraft:oak_planks" }, { id: "minecraft:glass" }]);
const env = { registry };
const B = (min: Vec3, max: Vec3) => fromPublic({ min, max });
const newDoc = () => Document.create({ name: "t", dataVersion: 3955, seed: 1, size: [16, 8, 16] });
const sel = (doc: Document, e: SelExpr) => resolveSelection(e, { doc, registry }).mask;
const pts = (m: Mask) => m.positions().map((p) => p.join(",")).sort();
const box = (min: Vec3, max: Vec3) => ({ min, max });

describe("more selections (05 L1)", () => {
  it("hull covers the convex hull of points; tube covers a polyline with a radius", () => {
    const doc = newDoc();
    // A right triangle in the y=0 plane: legs of 4 along x and z.
    const tri = sel(doc, { hull: [[0, 0, 0], [4, 0, 0], [0, 0, 4]] });
    expect(tri.count()).toBe(15); // 5+4+3+2+1
    expect(tri.has(2, 0, 2)).toBe(true);
    expect(tri.has(3, 0, 2)).toBe(false);
    expect(sel(doc, { hull: [[0, 0, 0], [3, 3, 3]] }).count()).toBe(4); // a diagonal line
    // Radius 0 is a one-block line; radius 1 a 3×3 cross-section (distance ≤ r + 0.5, like cylinder).
    expect(sel(doc, { tube: { path: [[0, 0, 0], [5, 0, 0]], radius: 0 } }).count()).toBe(6);
    const t = sel(doc, { tube: { path: [[0, 2, 2], [5, 2, 2], [5, 2, 6]], radius: 1 } });
    expect(t.has(2, 3, 2) && t.has(2, 3, 3) && !t.has(2, 4, 2)).toBe(true);
    expect(t.has(5, 2, 6) && t.has(6, 2, 4)).toBe(true);
  });

  it("grow and shrink follow connected blocks", () => {
    const doc = newDoc();
    fill(doc, env, B([0, 0, 0], [6, 0, 0]), "stone");
    fill(doc, env, B([7, 0, 0], [9, 0, 0]), "oak_planks");
    expect(pts(sel(doc, { grow: box([3, 0, 0], [3, 0, 0]), by: 2 }))).toEqual(["1,0,0", "2,0,0", "3,0,0", "4,0,0", "5,0,0"]);
    expect(sel(doc, { grow: box([3, 0, 0], [3, 0, 0]), by: 10 }).count()).toBe(10);
    expect(sel(doc, { grow: box([3, 0, 0], [3, 0, 0]), by: 10, match: "same" }).count()).toBe(7);
    expect(sel(doc, { grow: box([3, 0, 0], [3, 0, 0]), match: "any" }).count()).toBe(7);
    // Shrink drops ends that touch unselected blocks; a whole island doesn't shrink.
    expect(pts(sel(doc, { shrink: box([2, 0, 0], [5, 0, 0]) }))).toEqual(["3,0,0", "4,0,0"]);
    expect(sel(doc, { shrink: box([0, 0, 0], [9, 0, 0]) }).count()).toBe(10);
  });

  it("checker, random and every thin a selection deterministically", () => {
    const doc = newDoc();
    expect(sel(doc, { checker: box([0, 0, 0], [3, 0, 3]) }).count()).toBe(8);
    expect(sel(doc, { checker: box([0, 0, 0], [3, 0, 3]), size: 2 }).count()).toBe(8);
    expect(sel(doc, { checker: box([0, 0, 0], [3, 0, 3]) }).has(0, 0, 0)).toBe(true);
    const r = sel(doc, { random: box([0, 0, 0], [15, 0, 15]), ratio: 0.25 });
    expect(r.count()).toBeGreaterThan(40);
    expect(r.count()).toBeLessThan(90);
    expect(pts(sel(doc, { random: box([0, 0, 0], [15, 0, 15]), ratio: 0.25 }))).toEqual(pts(r));
    expect(pts(sel(doc, { random: box([0, 0, 0], [15, 0, 15]), ratio: 0.25, seed: 9 }))).not.toEqual(pts(r));
    expect(pts(sel(doc, { every: box([2, 0, 0], [12, 0, 0]), n: 4 }))).toEqual(["10,0,0", "2,0,0", "6,0,0"]);
    expect(pts(sel(doc, { every: box([0, 0, 0], [0, 5, 0]), n: 2, along: "y", offset: 1 }))).toEqual(["0,1,0", "0,3,0", "0,5,0"]);
  });

  it("edges, slab, convex and fill_holes", () => {
    const doc = newDoc();
    expect(sel(doc, { edges: box([0, 0, 0], [3, 3, 3]) }).count()).toBe(4 * 4 * 3 - 8 * 2); // 12 edges of 4, corners shared: 32
    expect(sel(doc, { edges: box([0, 0, 0], [3, 0, 3]) }).count()).toBe(12); // a flat layer: its perimeter
    expect(sel(doc, { slab: box([0, 0, 0], [3, 7, 3]), axis: "y", from: 2, to: 3 }).count()).toBe(32);
    // An L becomes its triangle-ish hull; a ring's hole is filled.
    const L = { union: [box([0, 0, 0], [4, 0, 0]), box([0, 0, 0], [0, 0, 4])] };
    expect(sel(doc, { convex: L }).count()).toBe(15);
    const ring = { subtract: [box([0, 0, 0], [4, 2, 4]), box([1, 0, 1], [3, 2, 3])] };
    expect(sel(doc, { fill_holes: ring }).count()).toBe(sel(doc, ring).count()); // open at top and bottom: not a hole
    const closed = { subtract: [box([0, 0, 0], [4, 4, 4]), box([1, 1, 1], [3, 3, 3])] };
    expect(sel(doc, { fill_holes: closed }).count()).toBe(125);
  });

  it("freeze stores the resolved voxels instead of the expression", () => {
    const doc = newDoc();
    setBlocks(doc, env, [{ pos: [0, 0, 0], block: "stone" }, { pos: [1, 0, 0], block: "stone" }, { pos: [5, 2, 3], block: "stone" }]);
    const live: SelExpr = { filter: "all", block: "stone" };
    const frozen = freezeNodes({ union: [{ freeze: live }, box([9, 0, 0], [9, 0, 0])] }, { doc, registry });
    expect(frozen).toEqual({ union: [{ frozen: [[0, 0, 0, 2], [5, 2, 3, 1]] }, box([9, 0, 0], [9, 0, 0])] });
    setBlocks(doc, env, [{ pos: [3, 0, 0], block: "stone" }]);
    expect(sel(doc, frozen).count()).toBe(4);
    expect(sel(doc, { freeze: live }).count()).toBe(4); // evaluated inline, freeze is a no-op
  });
});
