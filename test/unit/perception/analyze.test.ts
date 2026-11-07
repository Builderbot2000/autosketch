import { describe, expect, it } from "vitest";
import { Mask } from "../../../src/core/mask.js";
import { fromPublic } from "../../../src/core/region.js";
import { clear, setBlocks } from "../../../src/ops/edit.js";
import { analyzeStructure, classifyState, facadeOf, formatAnalysis } from "../../../src/perception/analyze.js";
import { FIXTURE_BUILDINGS, gableHouse, tower, twoStorey } from "../../helpers/buildings.js";

describe("analyze on fixture buildings", () => {
  for (const [name, make] of Object.entries(FIXTURE_BUILDINGS)) {
    it(`${name}: storeys, openings, roof and rooms`, () => {
      const { doc, facts } = make();
      const a = analyzeStructure(doc);
      const fb = a.footprint!.box;
      expect([fb.max[0] - fb.min[0], fb.max[2] - fb.min[2]]).toEqual(facts.footprint);
      expect(a.footprint!.shape).toBe("rectangular");
      expect(a.storeys.map((s) => s.floorY)).toEqual(facts.storeys);
      expect(a.storeys.map((s) => s.height)).toEqual(facts.heights);
      for (const f of ["front", "back", "left", "right"] as const) {
        const os = a.openings.filter((o) => o.facade === f);
        expect({ f, windows: os.filter((o) => o.kind === "window").length, doors: os.filter((o) => o.kind === "door").length }).toEqual({ f, ...facts.openings[f] });
      }
      expect(a.roof.type).toBe(facts.roof);
      if (facts.ridgeAxis) expect(a.roof.ridgeAxis).toBe(facts.ridgeAxis);
      expect(a.roof.ridgeY).toBe(facts.ridgeY);
      expect(a.rooms).toHaveLength(facts.rooms);
      expect(a.issues).toEqual([]);
      expect(a.walls!.thickness).toBe(1);
      // The text stays compact (06: about 200–400 tokens, ~4 characters per token).
      expect(formatAnalysis(a).length).toBeLessThan(1600);
    });
  }

  it("formats the gable house like the example in 06", () => {
    const text = formatAnalysis(analyzeStructure(gableHouse().doc));
    expect(text).toBe(
      [
        "footprint: 9×7 at x 0..8, z 0..6, rectangular, front=south",
        "storeys: 1 (floor y=0; heights 5)",
        "walls: y 0..4, thickness 1, material oak_planks",
        "openings: front 2 windows (rhythm 4), 1 door (center); back 3 windows (rhythm 2); left 1 window; right 1 window",
        "roof: gable, ridge along x at y=9, pitch 1:1, overhang 1",
        "rooms: 1 enclosed (largest 7×5 on storey 1)",
        "issues: none found",
        "proposed components: storey_1 (0,0,0)–(8,4,6), roof (-1,5,-1)–(9,9,7), door_main (4,1,6)–(4,2,6)",
      ].join("\n"),
    );
  });

  it("reports wall mixes, hip pitch and per-storey window counts", () => {
    const text = formatAnalysis(analyzeStructure(twoStorey().doc));
    expect(text).toMatch(/material stone_bricks mix \(stone_bricks \d+%, mossy_stone_bricks \d+%\)/);
    expect(text).toMatch(/front 5 windows \(2\+3 by storey\), 1 door \(center\); back 4 windows \(2 per storey, rhythm 4\)/);
    expect(text).toMatch(/roof: hip, ridge along x at y=13, pitch 1:1, overhang 1/);
    expect(text).toMatch(/proposed components: storey_1 \(0,0,0\)–\(10,3,8\), storey_2 \(0,4,0\)–\(10,7,8\), roof/);
  });

  it("treats a roof deck with battlements as a flat roof, not a storey", () => {
    const a = analyzeStructure(tower().doc);
    expect(a.roof).toMatchObject({ type: "flat", rim: "battlements", deckY: 15 });
    expect(formatAnalysis(a)).toMatch(/roof: flat with battlements, deck at y=15/);
  });

  it("finds floating blocks, roof gaps and an interior open to the outside", () => {
    const { doc } = gableHouse();
    setBlocks(doc, {}, [{ pos: [4, 12, 3], block: "minecraft:stone" }]);
    clear(doc, fromPublic({ min: [3, 8, 2], max: [3, 8, 2] })); // a stair on the north slope
    clear(doc, fromPublic({ min: [4, 1, 6], max: [4, 2, 6] })); // the door: now an open doorway
    const a = analyzeStructure(doc);
    expect(a.issues.find((i) => i.kind === "floating")).toMatchObject({ positions: [[4, 12, 3]], count: 1 });
    expect(a.issues.find((i) => i.kind === "roof_gap")!.positions).toEqual([[3, 8, 2]]);
    expect(a.rooms).toHaveLength(0);
    expect(a.interiorOpen).toBe(true);
    // The doorway (air touching the floor, two high) still reads as a door.
    expect(a.openings.filter((o) => o.facade === "front" && o.kind === "door")).toHaveLength(1);
    const text = formatAnalysis(a);
    expect(text).toMatch(/issues: 1 floating block at \(4,12,3\); roof gap at \(3,8,2\)/);
    expect(text).toMatch(/interior is open to outside air/);
  });

  it("analyses only the region given", () => {
    const { doc } = twoStorey();
    const a = analyzeStructure(doc, { region: Mask.fromBox(fromPublic({ min: [-1, 0, -1], max: [11, 7, 9] })) });
    expect(a.roof.type).toBe("none");
    expect(a.storeys.map((s) => s.floorY)).toEqual([0, 4]);
    expect(() => analyzeStructure(doc, { region: fromPublic({ min: [50, 0, 50], max: [52, 2, 52] }) })).toThrow(/Nothing to analyze/);
  });

  it("names facades through the document's front", () => {
    expect([facadeOf("south", "south"), facadeOf("north", "south"), facadeOf("east", "south"), facadeOf("west", "south")]).toEqual(["front", "back", "right", "left"]);
    expect([facadeOf("east", "east"), facadeOf("north", "east"), facadeOf("south", "east")]).toEqual(["front", "right", "left"]);
    const { doc } = gableHouse();
    doc.meta.front = "north";
    const a = analyzeStructure(doc);
    expect(a.openings.filter((o) => o.facade === "back" && o.kind === "door")).toHaveLength(1);
  });

  it("classifies blocks by role", () => {
    expect(["minecraft:oak_door[half=lower]", "minecraft:glass_pane", "minecraft:iron_bars", "minecraft:oak_stairs", "minecraft:torch", "minecraft:cobblestone_wall", "minecraft:stone", "minecraft:air"].map((s) => classifyState(s))).toEqual([4, 3, 3, 2, 5, 6, 1, 0]);
  });
});
