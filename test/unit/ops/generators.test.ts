import { describe, expect, it } from "vitest";
import { fromPublic, type Vec3 } from "../../../src/core/region.js";
import { Document } from "../../../src/document/document.js";
import { fill } from "../../../src/ops/edit.js";
import { arch, column, door, roof, staircase, tower, towerFootprint, wallRun, window } from "../../../src/ops/generators/index.js";
import { pickPalette } from "../../../src/palette/pick.js";
import { vanillaRegistry } from "../../helpers/vanilla.js";
import { libraryContext } from "../library/fixture.js";

const registry = vanillaRegistry();
const env = { registry };
const B = (min: Vec3, max: Vec3) => fromPublic({ min, max });
const newDoc = () => Document.create({ name: "t", dataVersion: 3955, seed: 1 });
const at = (doc: Document, x: number, y: number, z: number) => doc.getState(x, y, z).replace(/minecraft:/g, "");
/** One xz layer as rows (z) of single-letter codes. */
function layer(doc: Document, y: number, x0: number, x1: number, z0: number, z1: number, code: (s: string) => string): string[] {
  const rows: string[] = [];
  for (let z = z0; z <= z1; z++) {
    let r = "";
    for (let x = x0; x <= x1; x++) r += code(at(doc, x, y, z));
    rows.push(r);
  }
  return rows;
}
const stairCode = (s: string) => (s === "air" ? "." : s.includes("stairs") ? { north: "^", south: "v", east: ">", west: "<" }[/facing=(\w+)/.exec(s)![1]!]! : s.includes("slab") ? "_" : "#");

describe("roof (05 Generators)", () => {
  it("gable: stairs face up the slope, a full ridge, filled gable ends, one undo step", () => {
    const doc = newDoc();
    fill(doc, env, B([0, 0, 0], [4, 2, 4]), "stone_bricks", { mode: "walls" });
    const pos = doc.journal.position;
    const r = roof(doc, env, B([0, 0, 0], [4, 2, 4]), "oak_planks", { style: "gable", gables: false });
    expect(r.component).toBe("roof");
    expect(r.warnings).toEqual([]);
    // ridge along x (equal sides pick x); z = 0 and 4 are eaves, z = 2 the ridge
    expect(layer(doc, 3, 0, 4, 0, 4, stairCode)).toEqual(["vvvvv", ".....", ".....", ".....", "^^^^^"]);
    expect(layer(doc, 4, 0, 4, 0, 4, stairCode)).toEqual([".....", "vvvvv", ".....", "^^^^^", "....."]);
    expect(layer(doc, 5, 0, 4, 0, 4, stairCode)).toEqual([".....", ".....", "#####", ".....", "....."]);
    expect(at(doc, 2, 5, 2)).toBe("oak_planks");
    expect(doc.journal.position).toBe(pos + 1);
    doc.undo();
    expect(at(doc, 2, 5, 2)).toBe("air");
  });

  it("gable ends are filled under the roof by default", () => {
    const doc = newDoc();
    roof(doc, env, B([0, 0, 0], [4, 2, 4]), "oak_planks", { style: "gable" });
    expect(at(doc, 0, 3, 2)).toBe("oak_planks"); // gable end below the ridge (y 3, 4)
    expect(at(doc, 0, 4, 2)).toBe("oak_planks");
    expect(at(doc, 2, 3, 2)).toBe("air"); // inside stays open
  });

  it("hip: auto-connection shapes the corners; overhang lowers the eaves", () => {
    const doc = newDoc();
    roof(doc, env, B([0, 0, 0], [4, 0, 4]), "oak_planks", { style: "hip" });
    expect(layer(doc, 1, 0, 4, 0, 4, stairCode)).toEqual(["vvvvv", ">...<", ">...<", ">...<", "^^^^^"]);
    expect(at(doc, 0, 1, 0)).toMatch(/shape=outer/);
    expect(at(doc, 2, 3, 2)).toBe("oak_planks"); // the peak

    const d2 = newDoc();
    const r = roof(d2, env, B([0, 0, 0], [2, 0, 2]), "oak_planks", { style: "hip", overhang: 1 });
    expect(r.notes[0]).toMatch(/eaves at y=0, overhang 1/);
    expect(at(d2, -1, 0, -1)).toMatch(/oak_stairs/);
    expect(at(d2, 0, 1, 0)).toMatch(/oak_stairs/); // meets the wall line one higher
  });

  it("pitch 0.5 uses slabs; flat is one slab layer", () => {
    const doc = newDoc();
    roof(doc, env, B([0, 0, 0], [0, 0, 4]), "oak_planks", { style: "gable", axis: "x", pitch: 0.5, gables: false });
    expect([0, 1, 2, 3, 4].map((z) => [0, 1, 2].map((y) => at(doc, 0, y + 1, z)).find((s) => s !== "air"))).toEqual([
      "oak_slab[type=bottom,waterlogged=false]",
      "oak_slab[type=top,waterlogged=false]",
      "oak_slab[type=bottom,waterlogged=false]",
      "oak_slab[type=top,waterlogged=false]",
      "oak_slab[type=bottom,waterlogged=false]",
    ]);
    expect(at(doc, 0, 2, 2)).toBe("oak_slab[type=bottom,waterlogged=false]");
    const f = newDoc();
    roof(f, env, B([0, 0, 0], [2, 0, 2]), "oak_planks", { style: "flat" });
    expect(layer(f, 1, 0, 2, 0, 2, stairCode)).toEqual(["___", "___", "___"]);
  });

  it("a palette whose roof role has no stairs warns and falls back to full blocks (03)", async () => {
    const c = await libraryContext();
    const doc = newDoc();
    doc.palettes.set(pickPalette(c.palette, { name: "p", sheet: "family:minecraft:granite", roles: { roof: "A1" } }).palette);
    const r = roof(doc, { registry: c.registry, index: c.palette }, B([0, 0, 0], [2, 0, 2]), "palette:p.roof", { style: "gable", gables: false });
    expect(r.warnings.join("\n")).toMatch(/roof material palette:p\.roof has no stairs; using full blocks \(a stepped roof\)/);
    expect(at(doc, 0, 1, 0)).toBe("granite");
    expect(at(doc, 0, 2, 1)).toBe("granite");
    // with stairs available through the role, they are used
    doc.palettes.set(pickPalette(c.palette, { name: "q", sheet: "family:minecraft:andesite", roles: { roof: "A1" } }).palette);
    const r2 = roof(doc, { registry: c.registry, index: c.palette }, B([10, 0, 0], [12, 0, 2]), "palette:q.roof", { style: "gable", gables: false });
    expect(r2.warnings.some((w) => /stairs/.test(w))).toBe(false);
    expect(at(doc, 10, 1, 0)).toMatch(/^andesite_stairs\[facing=south,half=bottom/);
  });

  it("covers a round footprint (a cone) and rejects bad styles", () => {
    const doc = newDoc();
    const fp = towerFootprint([0, 0, 0], "round", 2);
    roof(doc, env, fp, "oak_planks", { style: "hip" });
    expect(at(doc, 0, 2, 0)).toBe("oak_planks"); // the peak
    expect(at(doc, 2, 1, 0)).toMatch(/oak_stairs\[facing=west/);
    expect(() => roof(doc, env, fp, "oak_planks", { style: "spire" as never })).toThrow(/unknown roof style/);
  });
});

describe("arch, staircase, column (05 Generators)", () => {
  it("round arch: ring above the springing line, opening cleared", () => {
    const doc = newDoc();
    fill(doc, env, B([-3, 0, 0], [3, 5, 0]), "stone");
    const r = arch(doc, env, "stone_bricks", { at: [0, 0, 0], width: 3, height: 3 });
    const rows: string[] = [];
    for (let y = 5; y >= 0; y--) {
      let s = "";
      for (let x = -3; x <= 3; x++) s += { air: ".", stone: "s", stone_bricks: "B" }[at(doc, x, y, 0)] ?? "?";
      rows.push(s);
    }
    // springing at y=1: the ring wraps the opening from there; below it the jambs stay as they were
    expect(rows).toEqual(["sssssss", "sssssss", "sBBBBBs", "sB...Bs", "sB...Bs", "ss...ss"]);
    expect(r.component).toBe("arch");
    expect(doc.componentLocal("arch")!.anchors.crown).toEqual([0, 3, 0]);
  });

  it("staircase: stairs climbing a direction with solid support; to: must be 45°", () => {
    const doc = newDoc();
    staircase(doc, env, "oak_planks", { from: [0, 0, 0], dir: "north", height: 3, width: 2 });
    expect(at(doc, 0, 0, 0)).toMatch(/^oak_stairs\[facing=north,half=bottom/);
    expect(at(doc, 1, 0, 0)).toMatch(/^oak_stairs\[facing=north/);
    expect(at(doc, 0, 2, -2)).toMatch(/^oak_stairs\[facing=north/);
    expect(at(doc, 0, 1, -2)).toBe("oak_planks");
    expect(at(doc, 0, 0, -2)).toBe("oak_planks");
    expect(doc.componentLocal("staircase")!.anchors.landing).toEqual([0, 3, -3]);
    expect(() => staircase(doc, env, "oak_planks", { from: [0, 0, 0], to: [3, 2, 0] })).toThrow(/45°/);
    const s = staircase(doc, env, "oak_planks", { from: [5, 0, 0], to: [8, 3, 0] });
    expect(s.notes[0]).toBe("4 steps climbing east, 1 wide");
  });

  it("staircase spiral: one sector per step around a newel post, stairs facing the climb", () => {
    const doc = newDoc();
    const pos = doc.journal.position;
    const r = staircase(doc, env, "oak_planks", { from: [0, 0, 0], shape: "spiral", radius: 1, height: 9 });
    expect(doc.journal.position).toBe(pos + 1);
    expect(r.notes[0]).toBe("spiral of 9 steps turning cw from the north side, radius 1, 8 steps per turn");
    // clockwise from above starting north: N, NE, E, SE, S, SW, W, NW, then N one turn up
    const cells: [number, number, string][] = [[0, -1, "east"], [1, -1, "east"], [1, 0, "south"], [1, 1, "south"], [0, 1, "west"], [-1, 1, "west"], [-1, 0, "north"], [-1, -1, "north"], [0, -1, "east"]];
    cells.forEach(([x, z, f], y) => {
      expect(at(doc, x, y, z)).toMatch(new RegExp(`^oak_stairs\\[facing=${f},half=bottom`));
      // each step is alone on its layer, apart from the post
      if (y < 8) expect(at(doc, x, y + 1, z)).toBe("air");
    });
    for (let y = 0; y < 9; y++) expect(at(doc, 0, y, 0)).toBe("oak_planks");
    expect(at(doc, 0, 9, 0)).toBe("air");
    expect(doc.blockCount()).toBe(18);
    expect(doc.componentLocal("staircase")!.anchors).toMatchObject({ bottom: [0, 0, 0], top: [0, 8, 0], landing: [1, 9, -1] });
  });

  it("staircase spiral: ccw, radius 2 sectors cover the ring, support none drops the post", () => {
    const doc = newDoc();
    staircase(doc, env, "oak_planks", { from: [0, 0, 0], shape: "spiral", dir: "east", turn: "ccw", height: 8, support: "none" });
    expect(at(doc, 2, 0, 0)).toMatch(/^oak_stairs\[facing=north/); // ccw from east climbs north
    expect(at(doc, 1, 0, 0)).toMatch(/^oak_stairs\[facing=north/);
    expect(at(doc, 0, 2, -2)).toMatch(/^oak_stairs\[facing=west/); // two steps on: the north side
    expect(at(doc, 0, 0, 0)).toBe("air");
    // one full turn: every ring cell (20 within radius 2.5, minus the post) holds exactly one step
    let n = 0;
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) for (let y = 0; y < 8; y++) if (at(doc, x, y, z) !== "air") n++;
    expect(n).toBe(20);
    expect(() => staircase(doc, env, "oak_planks", { from: [9, 0, 9], shape: "spiral", radius: 1, height: 4, steps_per_turn: 12 })).toThrow(/too many/);
    expect(() => staircase(doc, env, "oak_planks", { from: [9, 0, 9], shape: "spiral", height: 4, width: 2 })).toThrow(/radius, not width/);
  });

  it("column: shaft with base and capital at an anchor", () => {
    const doc = newDoc();
    fill(doc, env, B([0, 0, 0], [4, 0, 4]), "stone", { as: "plinth" });
    const r = column(doc, env, "quartz_pillar", { at: "plinth.top", height: 4, base: "chiseled_quartz_block", capital: "chiseled_quartz_block" });
    expect(r.notes).toEqual(["at: plinth.top = (2,1,2)"]);
    expect([1, 2, 3, 4].map((y) => at(doc, 2, y, 2))).toEqual(["chiseled_quartz_block", "quartz_pillar[axis=y]", "quartz_pillar[axis=y]", "chiseled_quartz_block"]);
  });
});

describe("window, door (05 Generators)", () => {
  const house = () => {
    const doc = newDoc();
    fill(doc, env, B([0, 0, 0], [6, 4, 6]), "stone_bricks", { mode: "walls", as: "house" });
    return doc;
  };

  it("window on a face, centred, with a frame and a sill", () => {
    const doc = house();
    const r = window(doc, env, { on: "house.front", w: 1, h: 2, frame: "spruce_planks", sill: "spruce_stairs" });
    expect(r.notes[0]).toBe("on house.front (south face), bottom centre 3,1,6");
    expect(at(doc, 3, 1, 6)).toMatch(/^glass_pane/);
    expect(at(doc, 3, 2, 6)).toMatch(/^glass_pane/);
    expect(at(doc, 2, 1, 6)).toBe("spruce_planks");
    expect(at(doc, 3, 3, 6)).toBe("spruce_planks");
    expect(at(doc, 3, 0, 7)).toMatch(/^spruce_stairs\[facing=north,half=top/);
    expect(doc.componentLocal("window")!.kind).toBe("window");
  });

  it("door places both halves facing out, clears above, double doors hinge outward", () => {
    const doc = house();
    door(doc, env, { on: "house.front", h: 3 });
    expect(at(doc, 3, 0, 6)).toBe("oak_door[facing=south,half=lower,hinge=left,open=false,powered=false]");
    expect(at(doc, 3, 1, 6)).toBe("oak_door[facing=south,half=upper,hinge=left,open=false,powered=false]");
    expect(at(doc, 3, 2, 6)).toBe("air");
    door(doc, env, { on: "house.back", w: 2, block: "spruce_door" });
    // back = north face; seen from outside u runs east→west
    expect(at(doc, 3, 0, 0)).toMatch(/hinge=right/);
    expect(at(doc, 2, 0, 0)).toMatch(/hinge=left/);
    expect(() => door(doc, env, { on: "house.left", block: "stone" })).toThrow(/not a door/);
  });
});

describe("wall_run and tower (05 Generators)", () => {
  it("wall_run with merlons every 2 and buttresses", () => {
    const doc = newDoc();
    wallRun(doc, env, "cobblestone", { path: [[0, 0, 0], [6, 0, 0]], height: 3, crenellation: true, buttresses: { every: 3, side: "left" } });
    expect([0, 1, 2, 3, 4, 5, 6].map((x) => at(doc, x, 3, 0) === "cobblestone" ? "M" : ".").join("")).toBe("M.M.M.M");
    expect(at(doc, 0, 0, -1)).toBe("cobblestone"); // buttress on the left of eastward travel (north)
    expect(at(doc, 1, 0, -1)).toBe("air");
    expect(at(doc, 3, 1, -1)).toBe("cobblestone");
    expect(at(doc, 3, 2, -1)).toBe("air");
  });

  it("wall_run curve: bezier and smooth paths are gap-free and pass where the curve does", () => {
    const run = (path: Vec3[], curve: "smooth" | "bezier") => {
      const doc = newDoc();
      wallRun(doc, env, "cobblestone", { path, height: 1, curve });
      const cells: Vec3[] = [];
      for (let x = -2; x <= 10; x++) for (let z = -2; z <= 10; z++) if (at(doc, x, 0, z) !== "air") cells.push([x, 0, z]);
      return { doc, cells };
    };
    const bz = run([[0, 0, 0], [4, 0, 8], [8, 0, 0]], "bezier");
    expect(at(bz.doc, 0, 0, 0)).toBe("cobblestone");
    expect(at(bz.doc, 8, 0, 0)).toBe("cobblestone");
    expect(at(bz.doc, 4, 0, 4)).toBe("cobblestone"); // B(½) = (4, 4): control point pulls the apex halfway
    expect(at(bz.doc, 4, 0, 8)).toBe("air"); // the curve does not reach its control point
    // symmetric about x = 4, and every block touches another (no gaps)
    for (const [x, , z] of bz.cells) expect(at(bz.doc, 8 - x, 0, z)).toBe("cobblestone");
    for (const c of bz.cells) expect(bz.cells.some((d) => d !== c && Math.max(Math.abs(d[0] - c[0]), Math.abs(d[2] - c[2])) === 1)).toBe(true);
    const sm = run([[0, 0, 0], [4, 0, 4], [8, 0, 0]], "smooth");
    expect(at(sm.doc, 4, 0, 4)).toBe("cobblestone"); // passes through every point
    expect(at(sm.doc, 4, 0, 5)).toBe("air");
    for (const [x, , z] of sm.cells) expect(at(sm.doc, 8 - x, 0, z)).toBe("cobblestone");
    expect(() => run([[0, 0, 0], [4, 0, 4]], "spline" as never)).toThrow(/unknown curve/);
  });

  it("tower: hollow round walls plus a roof as one journal entry with a child roof component", () => {
    const doc = newDoc();
    const pos = doc.journal.position;
    const r = tower(doc, env, "stone_bricks", { at: [0, 0, 0], radius: 2, height: 4, roof: { style: "hip", material: "oak_planks" } });
    expect(doc.journal.position).toBe(pos + 1);
    expect(at(doc, 2, 0, 0)).toBe("stone_bricks");
    expect(at(doc, 0, 0, 0)).toBe("air");
    expect(at(doc, 0, 5, 0)).toBe("oak_planks");
    expect(doc.componentLocal("tower_roof")!.parent).toBe("tower");
    expect(doc.componentLocal("tower")!.box).toEqual({ min: [-2, 0, -2], max: [3, 6, 3] });
    expect(r.notes[0]).toBe("round tower r=2, 4 high, hip roof (component tower_roof)");
    doc.undo();
    expect(doc.blockCount()).toBe(0);
    expect(doc.components.size).toBe(0);
  });
});
