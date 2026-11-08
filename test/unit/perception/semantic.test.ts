import { describe, expect, it } from "vitest";
import { Mask } from "../../../src/core/mask.js";
import { fromPublic, type Vec3 } from "../../../src/core/region.js";
import { Document } from "../../../src/document/document.js";
import { fill, setBlocks } from "../../../src/ops/edit.js";
import { resolveSelection, type SelExpr } from "../../../src/ops/selection.js";
import { analyzeStructure } from "../../../src/perception/analyze.js";
import { diffSince } from "../../../src/perception/diff.js";
import { recordRender } from "../../../src/perception/render/cameras.js";
import { enclosedAir } from "../../../src/perception/semantic.js";
import { gableHouse, tower, twoStorey } from "../../helpers/buildings.js";

const B = (min: Vec3, max: Vec3) => fromPublic({ min, max });
const sel = (doc: Document, e: SelExpr) => resolveSelection(e, { doc });
const pts = (m: Mask) => m.positions().map((p) => p.join(",")).sort();
const boxPts = (min: Vec3, max: Vec3) => pts(Mask.fromBox(B(min, max)));

describe("semantic selections (05, Semantic)", () => {
  it("face: the wall plane of a facade over the wall rows, air included; depth goes inward", () => {
    const { doc } = gableHouse();
    // Front = south = z 6; walls y 0..4.
    expect(pts(sel(doc, { face: "front" }).mask)).toEqual(boxPts([0, 0, 6], [8, 4, 6]));
    expect(pts(sel(doc, { face: "south" }).mask)).toEqual(boxPts([0, 0, 6], [8, 4, 6]));
    expect(pts(sel(doc, { face: "back" }).mask)).toEqual(boxPts([0, 0, 0], [8, 4, 0]));
    // Right = the viewer's right facing the front (south) = east.
    expect(pts(sel(doc, { face: "right" }).mask)).toEqual(boxPts([8, 0, 0], [8, 4, 6]));
    expect(pts(sel(doc, { face: "left", depth: 2 }).mask)).toEqual(boxPts([0, 0, 0], [1, 4, 6]));
    expect(() => sel(doc, { face: "top" })).toThrow(/front, back/);
  });

  it("storey: the footprint box of storey n, negative from the top", () => {
    const { doc } = twoStorey();
    expect(pts(sel(doc, { storey: 1 }).mask)).toEqual(boxPts([0, 0, 0], [10, 3, 8]));
    expect(pts(sel(doc, { storey: 2 }).mask)).toEqual(boxPts([0, 4, 0], [10, 7, 8]));
    expect(pts(sel(doc, { storey: -1 }).mask)).toEqual(boxPts([0, 4, 0], [10, 7, 8]));
    expect(() => sel(doc, { storey: 3 })).toThrow(/out of range: analysis found 2 storeys/);
    expect(sel(tower().doc, { storey: 3 }).mask.bbox()).toEqual(B([0, 10, 0], [6, 14, 6]));
  });

  it("roof: the blocks above the top storey", () => {
    const { doc } = gableHouse();
    const m = sel(doc, { roof: "all" }).mask;
    // 88 stairs, 32 gable-end planks, 11 ridge planks.
    expect(m.count()).toBe(131);
    expect(m.bbox()).toEqual(B([-1, 5, -1], [9, 9, 7]));
    m.forEach((x, y, z) => expect(doc.getState(x, y, z)).not.toBe("minecraft:air"));
    const flat = sel(tower().doc, { roof: true }).mask;
    expect(flat.bbox()).toEqual(B([0, 15, 0], [6, 16, 6]));
  });

  it("openings: window, door and gap cells, filtered by facade, kind and storey", () => {
    const { doc } = gableHouse();
    expect(pts(sel(doc, { openings: "all", facade: "front" }).mask)).toEqual(["2,2,6", "4,1,6", "4,2,6", "6,2,6"]);
    expect(pts(sel(doc, { openings: "all", facade: "front", kind: "door" }).mask)).toEqual(["4,1,6", "4,2,6"]);
    expect(pts(sel(doc, { openings: "all", facade: "east" }).mask)).toEqual(["8,2,3"]);
    expect(sel(doc, { openings: "all" }).mask.count()).toBe(9);
    const t = twoStorey().doc;
    expect(pts(sel(t, { openings: "all", facade: "front", storey: 2 }).mask)).toEqual(["2,6,8", "5,6,8", "8,6,8"]);
    const none = sel(doc, { openings: "all", kind: "gap" });
    expect(none.mask.isEmpty()).toBe(true);
    expect(none.notes).toEqual(["openings: none match"]);
  });

  it("room and interior: enclosed air, matching analyze's rooms", () => {
    const { doc } = twoStorey();
    const a = analyzeStructure(doc);
    const r1 = sel(doc, { room: 1 }).mask;
    expect(r1.count()).toBe(a.rooms[0]!.volume);
    expect(r1.bbox()).toEqual(a.rooms[0]!.box);
    // Seeded from a position: the ground floor room.
    const ground = sel(doc, { room: [5, 2, 4] }).mask;
    expect(ground.bbox()).toEqual(B([1, 1, 1], [9, 3, 7]));
    expect(ground.count()).toBe(9 * 3 * 7);
    ground.forEach((x, y, z) => expect(doc.getState(x, y, z)).toBe("minecraft:air"));
    const r = enclosedAir(doc);
    expect(r.rooms.length).toBe(a.rooms.length);
    const inside = sel(doc, { interior: "all" }).mask;
    expect(inside.count()).toBe(a.rooms.reduce((s, x) => s + x.volume, 0) + r.pockets.count());
    // A seed on a wall or outside air selects nothing, with a note.
    const wall = sel(doc, { room: [0, 2, 2] });
    expect(wall.mask.isEmpty()).toBe(true);
    expect(wall.notes[0]).toMatch(/is stone_bricks|is mossy_stone_bricks/);
    expect(sel(doc, { room: [-1, 2, 2] }).notes[0]).toMatch(/connected to the outside/);
    expect(() => sel(doc, { room: 9 })).toThrow(/out of range/);
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

  it("top: the highest block of each column", () => {
    const { doc } = gableHouse();
    const m = sel(doc, { top: "all" }).mask;
    expect(m.count()).toBe(11 * 9);
    expect(m.has(4, 9, 3)).toBe(true);
    expect(m.has(4, 5, -1)).toBe(true);
    const box = sel(doc, { top: { min: [0, 0, 0], max: [8, 4, 6] } }).mask;
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

  it("scopes: a selection, or a bare component id, limits the analysis", () => {
    const { doc } = gableHouse();
    // A second building far to the east confuses whole-document analysis.
    fill(doc, {}, B([30, 0, 0], [36, 11, 6]), "minecraft:stone_bricks", { mode: "walls", as: "annex" });
    fill(doc, {}, B([31, 6, 1], [35, 6, 5]), "minecraft:oak_planks");
    const house = { min: [-1, 0, -1], max: [9, 9, 7] };
    expect(pts(sel(doc, { face: "front", of: house }).mask)).toEqual(boxPts([0, 0, 6], [8, 4, 6]));
    expect(sel(doc, { storey: 2, of: "annex" }).mask.bbox()).toEqual(B([30, 6, 0], [36, 11, 6]));
    expect(sel(doc, { roof: house }).mask.count()).toBe(131);
    // A stored selection of the same name wins over the component.
    doc.selections.set("annex", house);
    expect(pts(sel(doc, { face: "front", of: "annex" }).mask)).toEqual(boxPts([0, 0, 6], [8, 4, 6]));
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
