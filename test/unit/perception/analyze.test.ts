import { describe, expect, it } from "vitest";
import { Mask } from "../../../src/core/mask.js";
import { fromPublic } from "../../../src/core/region.js";
import { clear, setBlocks } from "../../../src/ops/edit.js";
import { analyzeStructure, formatAnalysis } from "../../../src/perception/analyze.js";
import { FIXTURE_BUILDINGS, gableHouse, tower, twoStorey } from "../../helpers/buildings.js";

describe("analyze: structural measurements (06)", () => {
  for (const [name, make] of Object.entries(FIXTURE_BUILDINGS)) {
    it(`${name}: block count, layers, connectivity and enclosed air`, () => {
      const { doc, facts } = make();
      const a = analyzeStructure(doc);
      expect(a.blocks).toBe(facts.blocks);
      expect(a.layers.reduce((s, l) => s + l.blocks, 0)).toBe(facts.blocks);
      expect(a.layers).toHaveLength(a.box.max[1] - a.box.min[1]);
      expect(a.materials.reduce((s, [, n]) => s + n, 0)).toBe(facts.blocks);
      expect(a.groups).toBe(1);
      expect(a.ungrounded).toEqual([]);
      expect(a.enclosed.map((r) => r.volume)).toEqual(facts.enclosed);
      // The text stays compact (06: about 200–400 tokens, ~4 characters per token).
      expect(formatAnalysis(a).length).toBeLessThan(1600);
    });
  }

  it("formats the gable house as measurements only", () => {
    const text = formatAnalysis(analyzeStructure(gableHouse().doc));
    expect(text).toBe(
      [
        "box: (-1,0,-1)–(9,9,7), 11×10×9 (x×y×z); 306 blocks; front=south",
        "layers (blocks, x/z extent, share of extent filled):",
        "  y=0: 63 in x 0..8, z 0..6 (9×7, 100% filled)",
        "  y=1..4: 28 in x 0..8, z 0..6 (9×7, 44% filled)",
        "  y=5: 36 in x -1..9, z -1..7 (11×9, 36% filled)",
        "  y=6: 32 in x -1..9, z 0..6 (11×7, 42% filled)",
        "  y=7: 28 in x -1..9, z 1..5 (11×5, 51% filled)",
        "  y=8: 24 in x -1..9, z 2..4 (11×3, 73% filled)",
        "  y=9: 11 in x -1..9, z 3 (11×1, 100% filled)",
        "materials: oak_planks 146 (48%), oak_stairs 88 (29%), cobblestone 63 (21%), glass_pane 7 (2%), oak_door 2 (1%)",
        "connectivity: 1 group (faces, edges and corners join); all reach the bottom layer (y=0)",
        "enclosed air (not reachable from outside; any block bounds it): 1 region: 252 in (1,1,0)–(7,8,6)",
      ].join("\n"),
    );
  });

  it("names no architectural elements (block ids in materials aside)", () => {
    for (const make of Object.values(FIXTURE_BUILDINGS)) {
      const text = formatAnalysis(analyzeStructure(make().doc)).replace(/^materials:.*$/m, "");
      expect(text).not.toMatch(/storey|floor|wall|roof|window|door|gable|room|facade|footprint|opening/i);
    }
  });

  it("merges only identical consecutive layers", () => {
    const text = formatAnalysis(analyzeStructure(tower().doc));
    expect(text).toMatch(/y=0: 49 [^\n]*\n {2}y=1\.\.4: 24 [^\n]*\n {2}y=5: 49 /);
  });

  it("lists groups that do not reach the bottom layer, and enclosed air opening up", () => {
    const { doc } = gableHouse();
    setBlocks(doc, {}, [{ pos: [4, 12, 3], block: "minecraft:stone" }]);
    clear(doc, fromPublic({ min: [4, 1, 6], max: [4, 2, 6] })); // the door: now an open doorway
    const a = analyzeStructure(doc);
    expect(a.groups).toBe(2);
    expect(a.ungrounded).toEqual([{ count: 1, box: fromPublic({ min: [4, 12, 3], max: [4, 12, 3] }), positions: [[4, 12, 3]] }]);
    expect(a.enclosed).toEqual([]);
    const text = formatAnalysis(a);
    expect(text).toMatch(/2 groups [^\n]*; 1 not reaching the bottom layer \(y=0\): 1 block at \(4,12,3\)/);
    expect(text).toMatch(/enclosed air [^\n]*: none/);
  });

  it("measures only the region given", () => {
    const { doc } = twoStorey();
    const a = analyzeStructure(doc, { region: Mask.fromBox(fromPublic({ min: [-1, 0, -1], max: [11, 7, 9] })) });
    expect(a.box).toEqual(fromPublic({ min: [0, 0, 0], max: [10, 7, 8] }));
    expect(a.enclosed.map((r) => r.volume)).toEqual([189]);
    expect(() => analyzeStructure(doc, { region: fromPublic({ min: [50, 0, 50], max: [52, 2, 52] }) })).toThrow(/Nothing to analyze/);
  });
});
