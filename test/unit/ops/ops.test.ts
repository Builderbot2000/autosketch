import { describe, expect, it } from "vitest";
import { fromPublic } from "../../../src/core/region.js";
import { Document } from "../../../src/document/document.js";
import { blockMatcher, clear, fill, replace, setBlocks } from "../../../src/ops/edit.js";
import { compileMaterial, splitTopLevel, type MaterialExpr } from "../../../src/ops/material.js";
import { viewSlice } from "../../../src/perception/slice.js";
import { fakeRegistry, partial } from "../../helpers/registry.js";

const stairs = (id: string) =>
  partial(id, {
    properties: { facing: ["north", "south", "west", "east"], half: ["top", "bottom"] },
    defaults: { facing: "north", half: "bottom" },
    exactProperties: true,
  });
const registry = fakeRegistry([
  { id: "minecraft:stone", tags: ["minecraft:base_stone_overworld"] },
  { id: "minecraft:cobblestone" },
  { id: "minecraft:mossy_cobblestone" },
  { id: "minecraft:oak_planks" },
  { id: "minecraft:glass" },
  stairs("minecraft:oak_stairs"),
  stairs("minecraft:spruce_stairs"),
]);
const env = { registry };
const box = (min: [number, number, number], max: [number, number, number]) => fromPublic({ min, max });
const newDoc = (seed = 7) => Document.create({ name: "t", dataVersion: 3955, seed });

function counts(doc: Document): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, n] of doc.voxels.histogram()) out[doc.states.get(id).replace("minecraft:", "")] = n;
  return out;
}

describe("materials", () => {
  const sample = (expr: MaterialExpr, seed = 1, n = 2000) => {
    const ids: string[] = [];
    const table: string[] = [];
    const m = compileMaterial(expr, { registry, seed, intern: (s) => (table.includes(s) ? table.indexOf(s) : table.push(s) - 1), box: box([0, 0, 0], [9, 9, 9]) });
    for (let i = 0; i < n; i++) ids.push(table[m(i % 10, Math.floor(i / 10) % 10, Math.floor(i / 100))]!);
    return ids;
  };

  it("mixes by weight, deterministically per seed", () => {
    const a = sample("stone 75%, cobblestone 25%");
    const stone = a.filter((s) => s === "minecraft:stone").length / a.length;
    expect(stone).toBeGreaterThan(0.68);
    expect(stone).toBeLessThan(0.82);
    expect(sample("stone 75%, cobblestone 25%")).toEqual(a);
    expect(sample("stone 75%, cobblestone 25%", 2)).not.toEqual(a);
    // A missing weight takes the remainder.
    const b = sample("stone 90%, cobblestone");
    expect(b.filter((s) => s === "minecraft:cobblestone").length / b.length).toBeLessThan(0.16);
  });

  it("splits only on top-level commas, so block states keep theirs", () => {
    expect(splitTopLevel("oak_stairs[facing=east,half=top] 50%, stone")).toEqual(["oak_stairs[facing=east,half=top] 50%", "stone"]);
    expect(new Set(sample("oak_stairs[facing=east,half=top] 50%, stone"))).toEqual(new Set(["minecraft:oak_stairs[facing=east,half=top]", "minecraft:stone"]));
  });

  it("supports gradients, noise and patterns, nested", () => {
    const g = sample({ gradient: ["stone", "oak_planks"], axis: "y", range: [0, 9] }, 1, 1000);
    expect(g.slice(0, 10).every((s) => s === "minecraft:stone")).toBe(true); // y=0
    expect(g.slice(990).every((s) => s === "minecraft:oak_planks")).toBe(true); // y=9
    const checker = sample({ pattern: "checker", blocks: ["stone", "glass"] }, 1, 4);
    expect(checker).toEqual(["minecraft:stone", "minecraft:glass", "minecraft:stone", "minecraft:glass"]);
    const nested = sample({ noise: ["stone", { pattern: "stripes_x", blocks: ["glass", "oak_planks"] }], scale: 3 });
    expect(new Set(nested)).toEqual(new Set(["minecraft:stone", "minecraft:glass", "minecraft:oak_planks"]));
  });

  it("explains bad materials", () => {
    expect(() => sample("stoen")).toThrow(/unknown block "minecraft:stoen"/);
    expect(() => sample("oak_stairs[facing=up]")).toThrow(/valid: north\|south\|west\|east/);
    expect(() => sample({ gradient: [] } as MaterialExpr)).toThrow(/non-empty list/);
    expect(() => sample({ pattern: "dots", blocks: ["stone"] } as unknown as MaterialExpr)).toThrow(/unknown pattern/);
    expect(() => sample("palette:x.wall")).toThrow(/need a loaded instance/);
  });
});

describe("ops", () => {
  it("fills in fill, hollow, outline and walls modes", () => {
    const doc = newDoc();
    const b = box([0, 0, 0], [4, 3, 4]); // 5×4×5
    expect(fill(doc, env, b, "stone").changed).toBe(100);
    expect(fill(doc, env, b, "oak_planks", { mode: "hollow" }).changed).toBe(100); // shell rewritten, 3×2×3 inside cleared
    expect(counts(doc)).toEqual({ oak_planks: 100 - 18 });
    const o = newDoc();
    fill(o, env, b, "stone");
    fill(o, env, b, "glass", { mode: "outline" });
    expect(counts(o)).toEqual({ glass: 82, stone: 18 });
    const w = newDoc();
    fill(w, env, b, "glass", { mode: "walls" });
    expect(counts(w)).toEqual({ glass: 4 * 16 }); // perimeter 16 × height 4
  });

  it("registers components and reports boxes", () => {
    const doc = newDoc();
    const r = fill(doc, env, box([0, 0, 0], [2, 2, 2]), "stone", { as: "core", kind: "block" });
    expect(r.box).toEqual(box([0, 0, 0], [2, 2, 2]));
    expect(doc.componentLocal("core")).toMatchObject({ kind: "block" });
  });

  it("sets single blocks and clears", () => {
    const doc = newDoc();
    setBlocks(doc, env, [
      { pos: [0, 0, 0], block: "oak_stairs[facing=east]" },
      { pos: [1, 0, 0], block: "stone" },
    ]);
    expect(doc.getState(0, 0, 0)).toBe("minecraft:oak_stairs[facing=east,half=bottom]");
    expect(() => setBlocks(doc, env, [{ pos: [0, 0] as never, block: "stone" }])).toThrow(/bad pos/);
    expect(clear(doc, box([0, 0, 0], [5, 5, 5])).changed).toBe(2);
    expect(doc.blockCount()).toBe(0);
  });

  it("replaces by id, state, tag and wildcard, optionally keeping states", () => {
    const doc = newDoc();
    setBlocks(doc, env, [
      { pos: [0, 0, 0], block: "oak_stairs[facing=east,half=top]" },
      { pos: [1, 0, 0], block: "oak_stairs[facing=west]" },
      { pos: [2, 0, 0], block: "stone" },
    ]);
    const all = box([0, 0, 0], [2, 0, 0]);
    replace(doc, env, all, "oak_stairs", "spruce_stairs", { keepStates: true });
    expect(doc.getState(0, 0, 0)).toBe("minecraft:spruce_stairs[facing=east,half=top]");
    expect(doc.getState(1, 0, 0)).toBe("minecraft:spruce_stairs[facing=west,half=bottom]");
    expect(replace(doc, env, all, "spruce_stairs[half=top]", "glass").changed).toBe(1);
    expect(replace(doc, env, all, "#minecraft:base_stone_overworld", "cobblestone").changed).toBe(1);
    expect(replace(doc, env, box([0, 0, 0], [2, 1, 0]), "air", "glass").changed).toBe(3);
    expect(replace(doc, env, all, "*", "oak_planks").changed).toBe(3);
    expect(() => blockMatcher("#nope:none", registry)).toThrow(/no blocks have tag/);
  });

  it("refuses absurd volumes", () => {
    expect(() => fill(newDoc(), env, box([0, 0, 0], [1000, 100, 1000]), "stone")).toThrow(/at most 8,000,000/);
  });
});

describe("view_slice", () => {
  it("draws plans and elevations with a legend", () => {
    const doc = newDoc();
    fill(doc, env, box([0, 0, 0], [4, 0, 2]), "stone");
    fill(doc, env, box([0, 1, 0], [4, 2, 0]), "oak_planks");
    setBlocks(doc, env, [{ pos: [2, 1, 0], block: "glass" }]);
    const plan = viewSlice(doc, registry, { axis: "y", at: 0 });
    expect(plan).toContain("y=0  columns x→ 0..4, rows z↓ 0..2");
    expect(plan).toMatch(/\n0 SSSSS\n1 SSSSS\n2 SSSSS\n/);
    expect(plan).toContain("legend: . air, S stone (15)");
    const front = viewSlice(doc, registry, { axis: "z", at: 0 });
    // rows top-down: y=2, y=1, y=0
    expect(front).toMatch(/\n2 OOOOO\n1 OOGOO\n0 SSSSS\n/);
    expect(viewSlice(doc, registry, { axis: "y", at: 9 })).toMatch(/outside the document/);
    expect(viewSlice(newDoc(), registry, { axis: "y", at: 0 })).toBe("The document is empty.");
  });

  it("marks negative columns in the header", () => {
    const doc = newDoc();
    fill(doc, env, box([-2, 0, 0], [1, 0, 0]), "stone");
    expect(viewSlice(doc, registry, { axis: "y", at: 0 })).toMatch(/\n  --0 \n  2101\n0 SSSS\n/);
  });

  it("crops to 64×64 with a note", () => {
    const doc = newDoc();
    fill(doc, env, box([0, 0, 0], [99, 0, 99]), "stone");
    const s = viewSlice(doc, registry, { axis: "y", at: 0 });
    expect(s.split("\n").filter((l) => /^\s*\d+ S+$/.test(l))).toHaveLength(64);
    expect(s).toMatch(/note: cropped x to 0\.\.63/);
  });
});
