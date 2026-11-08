/**
 * Analysis goldens (docs/design/10-testing.md, tier 2 "Analysis"): `analyze` measurements of the
 * fixture buildings with known geometry, pinned as JSON. Measurements only (06, "measure, don't
 * interpret"): layers, materials, connectivity and enclosed air, plus the compact text the tool
 * returns. Boxes are written in the public inclusive form so the goldens read like tool output.
 */
import { describe, expect, it } from "vitest";
import { toPublic } from "../../src/core/region.js";
import type { Document } from "../../src/document/document.js";
import { analyzeStructure, formatAnalysis, type Analysis } from "../../src/perception/analyze.js";
import { gableHouse, tower, twoStorey } from "../helpers/buildings.js";
import { cottage } from "./builds.js";
import { expectJsonGolden, UPDATE } from "./harness.js";

const CASES: [string, () => Document][] = [
  ["gable-house", () => gableHouse().doc],
  ["two-storey", () => twoStorey().doc],
  ["tower", () => tower().doc],
  ["cottage", () => cottage()],
];

/** The analysis as reviewable JSON: inclusive boxes, layer extents as x/z ranges, the tool text by line. */
function analysisGolden(a: Analysis): unknown {
  return {
    box: toPublic(a.box),
    front: a.front,
    blocks: a.blocks,
    layers: a.layers.map((l) => (l.extent ? { y: l.y, blocks: l.blocks, x: [l.extent.min[0], l.extent.max[0] - 1], z: [l.extent.min[2], l.extent.max[2] - 1] } : { y: l.y, blocks: 0 })),
    materials: a.materials,
    groups: a.groups,
    ungrounded: a.ungrounded.map((g) => ({ count: g.count, box: toPublic(g.box), positions: g.positions })),
    enclosed: a.enclosed.map((r) => ({ volume: r.volume, box: toPublic(r.box) })),
    text: formatAnalysis(a).split("\n"),
  };
}

describe("analysis goldens", () => {
  for (const [name, build] of CASES) {
    it(`${name} measurements match their golden`, async () => {
      await expectJsonGolden(`analysis/${name}`, analysisGolden(analyzeStructure(build())));
    });
  }

  it("is deterministic across independent builds", () => {
    for (const [, build] of CASES) expect(analysisGolden(analyzeStructure(build()))).toEqual(analysisGolden(analyzeStructure(build())));
  });

  it.skipIf(UPDATE)("fails when one block changes", async () => {
    // A floating block above the cottage: one more group, one ungrounded block, one more layer.
    const changed = cottage();
    changed.edit("test", "one block", (tx) => tx.set(5, 11, 5, "minecraft:stone"));
    await expect(expectJsonGolden("analysis/cottage", analysisGolden(analyzeStructure(changed)))).rejects.toThrow();
  });
});
