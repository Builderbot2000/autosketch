import { describe, expect, it } from "vitest";
import { Mask } from "../../../src/core/mask.js";
import { fromPublic, type Vec3 } from "../../../src/core/region.js";
import { Document } from "../../../src/document/document.js";
import { fill, setBlocks } from "../../../src/ops/edit.js";
import { resolveSelection, type SelExpr } from "../../../src/ops/selection.js";
import { analyzeStructure } from "../../../src/perception/analyze.js";
import { diffSince } from "../../../src/perception/diff.js";
import { recordRender } from "../../../src/perception/render/cameras.js";
import { enclosedAir } from "../../../src/perception/morphology.js";
import { gableHouse, twoStorey } from "../../helpers/buildings.js";

const B = (min: Vec3, max: Vec3) => fromPublic({ min, max });
const sel = (doc: Document, e: SelExpr) => resolveSelection(e, { doc });
const pts = (m: Mask) => m.positions().map((p) => p.join(",")).sort();
const boxPts = (min: Vec3, max: Vec3) => pts(Mask.fromBox(B(min, max)));

describe("morphological selections (05, Morphological)", () => {
  it("offers no architectural selections: face, storey, roof and openings are gone", () => {
    const { doc } = gableHouse();
    for (const e of [{ face: "front" }, { storey: 1 }, { roof: "all" }, { openings: "all" }, { room: 1 }]) expect(() => sel(doc, e)).toThrow();
  });

  it("enclosed and interior: enclosed air, matching analyze", () => {
    const { doc } = twoStorey();
    const a = analyzeStructure(doc);
    const r1 = sel(doc, { enclosed: 1 }).mask;
    expect(r1.count()).toBe(a.enclosed[0]!.volume);
    expect(r1.bbox()).toEqual(a.enclosed[0]!.box);
    // Seeded from a position: the air between y=0 and y=4.
    const ground = sel(doc, { enclosed: [5, 2, 4] }).mask;
    expect(ground.bbox()).toEqual(B([1, 1, 1], [9, 3, 7]));
    expect(ground.count()).toBe(9 * 3 * 7);
    ground.forEach((x, y, z) => expect(doc.getState(x, y, z)).toBe("minecraft:air"));
    expect(enclosedAir(doc).map((r) => r.volume)).toEqual(a.enclosed.map((r) => r.volume));
    expect(sel(doc, { interior: "all" }).mask.count()).toBe(a.enclosed.reduce((s, x) => s + x.volume, 0));
    // A seed on a block or outside air selects nothing, with a note.
    const wall = sel(doc, { enclosed: [0, 2, 2] });
    expect(wall.mask.isEmpty()).toBe(true);
    expect(wall.notes[0]).toMatch(/is stone_bricks|is mossy_stone_bricks/);
    expect(sel(doc, { enclosed: [-1, 2, 2] }).notes[0]).toMatch(/connected to the outside/);
    expect(() => sel(doc, { enclosed: 9 })).toThrow(/out of range/);
  });

  it("interior of a shell selection: positions outside the scope count as air", () => {
    const doc = Document.create({ name: "s", dataVersion: 3955, seed: 1 });
    fill(doc, {}, B([0, 0, 0], [4, 4, 4]), "minecraft:stone");
    // The doc is solid, but a shell scope encloses its own inside.
    const m = sel(doc, { interior: { shell: { min: [0, 0, 0], max: [4, 4, 4] } } }).mask;
    expect(pts(m)).toEqual(boxPts([1, 1, 1], [3, 3, 3]));
    const none = sel(doc, { interior: "all" });
    expect(none.mask.isEmpty()).toBe(true);
    expect(none.notes[0]).toMatch(/no enclosed air/);
  });

  it("heightmap: the highest block of each column", () => {
    const { doc } = gableHouse();
    const m = sel(doc, { heightmap: "all" }).mask;
    expect(m.count()).toBe(11 * 9);
    expect(m.has(4, 9, 3)).toBe(true);
    expect(m.has(4, 5, -1)).toBe(true);
    const box = sel(doc, { heightmap: { min: [0, 0, 0], max: [8, 4, 6] } }).mask;
    expect(box.count()).toBe(9 * 7);
    expect(box.has(4, 4, 0) && box.has(4, 0, 3)).toBe(true);
  });

  it("changed: the positions a diff reports", () => {
    const { doc } = gableHouse();
    doc.checkpoint("a");
    fill(doc, {}, B([2, 1, 2], [3, 1, 3]), "minecraft:oak_planks");
    expect(pts(sel(doc, { changed: "op:-1" }).mask)).toEqual(boxPts([2, 1, 2], [3, 1, 3]));
    expect(pts(sel(doc, { changed: "checkpoint:a" }).mask)).toEqual(pts(diffSince(doc, "checkpoint:a").mask));
    expect(() => sel(doc, { changed: 3 })).toThrow(/op:-n/);
  });

  it("scopes: a selection, or a bare component id, limits the measurement", () => {
    const { doc } = gableHouse();
    fill(doc, {}, B([30, 0, 0], [36, 11, 6]), "minecraft:stone_bricks", { mode: "walls", as: "annex" });
    fill(doc, {}, B([31, 6, 1], [35, 6, 5]), "minecraft:oak_planks");
    // The annex's walls are open at the top and bottom, so nothing in it is enclosed.
    expect(sel(doc, { interior: "annex" }).mask.isEmpty()).toBe(true);
    // Scoped to the house's box, the annex no longer matters.
    expect(sel(doc, { enclosed: 1, of: { min: [-1, 0, -1], max: [9, 9, 7] } }).mask.count()).toBe(252);
    // A stored selection of the same name wins over the component.
    doc.selections.set("annex", { min: [-1, 0, -1], max: [9, 9, 7] });
    expect(sel(doc, { enclosed: 1, of: "annex" }).mask.count()).toBe(252);
  });
});

describe("render-seeded selections (05, Picking)", () => {
  /** A 10×10 stone floor at y 0 with a 2×2 pillar (x 2..3, z 2..3) up to y 4, and a top camera at 10 px per block. */
  const scene = () => {
    const doc = Document.create({ name: "p", dataVersion: 3955, seed: 1 });
    fill(doc, {}, B([0, 0, 0], [9, 0, 9]), "minecraft:stone");
    fill(doc, {}, B([2, 1, 2], [3, 4, 3]), "minecraft:stone");
    // Top view: screen x = 10·x, screen y = 10·z; the ray looks down.
    const cam = { right: [1, 0, 0] as Vec3, up: [0, 0, -1] as Vec3, forward: [0, -1, 0] as Vec3, scale: 10, cx: 5, cy: -5, width: 100, height: 100 };
    const id = recordRender(doc, { revision: doc.revision, width: 200, height: 100, views: [
      { label: "top", ox: 0, oy: 0, width: 100, height: 100, ss: 1, cam, clip: { min: [0, 0, 0], max: [10, 5, 10] } },
      // The same camera again in the right half of a contact sheet.
      { label: "top2", ox: 100, oy: 0, width: 100, height: 100, ss: 1, cam, clip: { min: [0, 0, 0], max: [10, 5, 10] } },
    ] });
    return { doc, id };
  };

  it("view_box visible: the first block under each pixel", () => {
    const { doc, id } = scene();
    expect(pts(sel(doc, { view_box: { render: id, rect: [20, 20, 39, 39] } }).mask)).toEqual(boxPts([2, 4, 2], [3, 4, 3]));
    // Corners in any order; default render = the latest.
    expect(pts(sel(doc, { view_box: { rect: [59, 69, 50, 60] } }).mask)).toEqual(["5,0,6"]);
    // The same rectangle in the second cell of the sheet.
    expect(pts(sel(doc, { view_box: { rect: [120, 20, 139, 39] } }).mask)).toEqual(boxPts([2, 4, 2], [3, 4, 3]));
  });

  it("view_box through: the whole drawn volume behind the outline, air included", () => {
    const { doc } = scene();
    expect(pts(sel(doc, { view_box: { rect: [20, 20, 39, 39], depth: "through" } }).mask)).toEqual(boxPts([2, 0, 2], [3, 4, 3]));
    const air = sel(doc, { view_box: { rect: [50, 50, 69, 69], depth: "through" } }).mask;
    expect(pts(air)).toEqual(boxPts([5, 0, 5], [6, 4, 6]));
  });

  it("view_lasso: a polygon outline", () => {
    const { doc } = scene();
    expect(pts(sel(doc, { view_lasso: { points: [[21, 21], [38, 21], [38, 38], [21, 38]] } }).mask)).toEqual(boxPts([2, 4, 2], [3, 4, 3]));
    // A triangle in the corner: columns whose centre lies inside x + z < 30 px.
    const tri = sel(doc, { view_lasso: { points: [[0, 0], [29, 0], [0, 29]], depth: "through" } }).mask;
    expect(tri.has(0, 0, 0) && tri.has(1, 0, 0) && tri.has(0, 4, 1)).toBe(true);
    expect(tri.has(2, 0, 1) || tri.has(2, 0, 2)).toBe(false);
  });

  it("notes stale renders and errors on unknown ones", () => {
    const { doc, id } = scene();
    setBlocks(doc, {}, [{ pos: [9, 1, 9], block: "minecraft:stone" }]);
    const r = sel(doc, { view_box: { render: id, rect: [0, 0, 5, 5] } });
    expect(r.notes[0]).toMatch(/changed since this render/);
    expect(() => sel(doc, { view_box: { render: "r99", rect: [0, 0, 1, 1] } })).toThrow(/no recent render "r99"/);
    expect(() => sel(doc, { view_box: { rect: [0, 0, 1, 1], depth: "deep" } })).toThrow(/visible/);
    expect(sel(doc, { view_box: { rect: [500, 500, 510, 510] } }).notes.at(-1)).toMatch(/outside render/);
  });
});
