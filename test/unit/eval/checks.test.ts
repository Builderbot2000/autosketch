import { describe, expect, it } from "vitest";
import { fromPublic } from "../../../src/core/region.js";
import { Document } from "../../../src/document/document.js";
import { clear, fill } from "../../../src/ops/edit.js";
import { runChecks, type CheckSpec } from "../../eval/checks.js";
import { PROMPTS } from "../../eval/prompts.js";
import { SEEDS } from "../../eval/seeds.js";
import { gableHouse, tower } from "../../helpers/buildings.js";

const byKind = (doc: Document, specs: CheckSpec[], seed?: Document) => Object.fromEntries(runChecks(doc, specs, seed ? { seed } : {}).map((r, i) => [`${i}:${r.kind}`, r]));

describe("eval checks (10, tier 3 Scoring)", () => {
  it("pass on the gable house fixture for what it is", () => {
    const { doc } = gableHouse();
    const r = runChecks(doc, [
      { kind: "storeys", min: 1 },
      { kind: "door", side: "south" },
      { kind: "windows", min: 4 },
      { kind: "roofType", types: ["gable"] },
      { kind: "roofWatertight" },
      { kind: "noFloating" },
      { kind: "material", where: "walls", ids: ["oak"], minShare: 0.8 },
      { kind: "material", where: "roof", ids: ["oak_stairs", "oak_planks"], minShare: 0.9 },
      { kind: "withinBox", box: { min: [-1, 0, -1], max: [9, 9, 7] } },
      { kind: "minBlocks", n: 100 },
    ]);
    expect(r.filter((c) => !c.pass)).toEqual([]);
    expect(r[0]).toMatchObject({ value: 1, detail: "1 storeys (want 1)" });
    expect(r[1]!.detail).toBe("doors on south (want south)");
  });

  it("fail with a reason when the build doesn't match", () => {
    const { doc } = gableHouse();
    const r = byKind(doc, [
      { kind: "storeys", min: 2 },
      { kind: "door", side: "east" },
      { kind: "roofType", types: ["flat"] },
      { kind: "material", where: "walls", ids: ["stone_brick"], minShare: 0.5 },
      { kind: "withinBox", box: { min: [0, 0, 0], max: [8, 8, 6] } },
      { kind: "minBlocks", n: 100000 },
    ]);
    expect(Object.values(r).every((c) => !c.pass)).toBe(true);
    expect(r["1:door"]!.detail).toBe("doors on south (want east)");
    expect(r["3:material"]!.value).toBe(0);
    expect(r["4:withinBox"]!.detail).toMatch(/^bounds .* vs allowed/);
  });

  it("detect floating blocks and roof gaps", () => {
    const { doc } = gableHouse();
    fill(doc, {}, fromPublic({ min: [20, 6, 20], max: [21, 6, 21] }), "minecraft:stone");
    clear(doc, fromPublic({ min: [3, 7, 1], max: [3, 7, 1] }));
    clear(doc, fromPublic({ min: [3, 6, 0], max: [3, 6, 0] }));
    const r = runChecks(doc, [{ kind: "noFloating" }]);
    expect(r[0]).toMatchObject({ pass: false, value: 4 });
    const t = tower().doc;
    expect(runChecks(t, [{ kind: "roofWatertight" }, { kind: "storeys", min: 3 }]).map((c) => c.pass)).toEqual([true, true]);
  });

  it("measure seed preservation", () => {
    const seed = SEEDS.curtainWall("w");
    const doc = SEEDS.curtainWall("w");
    const spec: CheckSpec = { kind: "preserved", box: { min: [0, 0, 0], max: [9, 5, 1] }, minShare: 0.95 };
    expect(runChecks(doc, [spec], { seed })[0]).toMatchObject({ pass: true, value: 1 });
    clear(doc, fromPublic({ min: [0, 0, 0], max: [4, 5, 1] }));
    expect(runChecks(doc, [spec], { seed })[0]).toMatchObject({ pass: false, value: 0.5, detail: "60/120 seed blocks kept (50%, need ≥ 95%)" });
    expect(runChecks(doc, [spec])[0]).toMatchObject({ pass: false, detail: "no seed document" });
  });

  it("score cross-part consistency", () => {
    const doc = Document.create({ name: "c", dataVersion: 3955 });
    const towerAt = (x: number, top: number, mat: string) => fill(doc, {}, fromPublic({ min: [x, 0, 0], max: [x + 2, top, 2] }), mat, { mode: "walls" });
    towerAt(0, 5, "minecraft:stone_bricks");
    towerAt(10, 5, "minecraft:stone_bricks");
    towerAt(20, 7, "minecraft:cobblestone");
    const parts = [0, 10, 20].map((x) => ({ min: [x, 0, 0] as [number, number, number], max: [x + 2, 10, 2] as [number, number, number] }));
    const same = runChecks(doc, [{ kind: "consistency", parts: parts.slice(0, 2), minJaccard: 0.9, maxHeightSpread: 0 }])[0]!;
    expect(same).toMatchObject({ pass: true, value: 1 });
    const all = runChecks(doc, [{ kind: "consistency", parts, minJaccard: 0.5, maxHeightSpread: 1 }])[0]!;
    expect(all.pass).toBe(false);
    expect(all.value).toBeCloseTo(1 / 3);
    expect(all.detail).toBe("palette Jaccard 0.33 (need ≥ 0.5), heights 6/6/8 (spread ≤ 1)");
    const empty = runChecks(doc, [{ kind: "consistency", parts: [parts[0]!, { min: [50, 0, 50], max: [52, 5, 52] }], minJaccard: 0.5, maxHeightSpread: 1 }])[0]!;
    expect(empty).toMatchObject({ pass: false, detail: "1 of 2 parts empty" });
  });

  it("fail analysis checks cleanly on an empty document", () => {
    const doc = Document.create({ name: "e", dataVersion: 3955 });
    const r = runChecks(doc, [{ kind: "door", side: "south" }, { kind: "minBlocks", n: 1 }]);
    expect(r[0]).toMatchObject({ pass: false });
    expect(r[0]!.detail).toMatch(/^analyze failed: Nothing to analyze/);
    expect(r[1]).toMatchObject({ pass: false, value: 0 });
  });
});

describe("benchmark set (10, tier 3)", () => {
  it("has 15–25 prompts with unique ids, a reduced suite of three, and large prompts for the scoped comparison", () => {
    expect(PROMPTS.length).toBeGreaterThanOrEqual(15);
    expect(PROMPTS.length).toBeLessThanOrEqual(25);
    expect(new Set(PROMPTS.map((p) => p.id)).size).toBe(PROMPTS.length);
    expect(PROMPTS.filter((p) => p.reduced).map((p) => p.id)).toEqual(["s-hut", "m-cottage", "m-porch"]);
    for (const p of PROMPTS) {
      expect(p.text).toContain(`"${p.doc}"`);
      expect(p.checks.length).toBeGreaterThan(0);
      expect(p.checks.some((c) => c.kind === "consistency")).toBe(p.size === "large");
    }
  });

  it("seed prompts: the untouched seed keeps everything the prompt protects, and still fails the 'add something' checks", () => {
    for (const p of PROMPTS.filter((q) => q.seed)) {
      const seed = SEEDS[p.seed!](p.doc);
      const r = runChecks(seed, p.checks, { seed });
      for (const c of r.filter((x) => x.kind === "preserved")) expect(c.pass, `${p.id}: ${c.detail}`).toBe(true);
      expect(r.every((c) => c.pass), `${p.id} passes without any work`).toBe(false);
    }
  });
});
