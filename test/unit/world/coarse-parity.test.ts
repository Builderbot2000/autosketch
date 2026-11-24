import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Vec3 } from "../../../src/core/region.js";
import type { WireBox } from "../../../src/world/protocol/messages.js";
import { coarseRegion, missingIn } from "../../support/fake-select.js";

/**
 * The coarse parity fixture (docs/design/18-select.md, piece 5; `13`, *Message schemas*, `snapshot`
 * kind `coarse`): the fake host's coarse answers (`coarseRegion`, the reference) on one blob of blocks
 * across four chunks, recorded in `test/data/select/coarse-parity.json`. The mod's JUnit
 * `CoarseCellsTest` reduces the same cells section by section, as the mod reads them, and must give
 * the same palette and cells. `UPDATE_COARSE_PARITY=1` rewrites the fixture.
 */

const FIXTURE = new URL("../../data/select/coarse-parity.json", import.meta.url);
const AIR = "minecraft:air";
const CELL: Record<string, string> = { b: "minecraft:stone_bricks", m: "minecraft:mossy_stone_bricks", s: "minecraft:stone", ".": AIR };
const SIZE: Vec3 = [20, 12, 20];
const ORIGIN: Vec3 = [-10, 58, -6]; // chunks x -1..0, z -1..0; sections y 3..4

/** The blob: per cell `b`, `m`, `s` or `.`, index x + 20·(z + 20·y); sparse enough for ties and all-air cells. */
function cells(): string {
  let s = "";
  for (let y = 0; y < SIZE[1]; y++)
    for (let z = 0; z < SIZE[2]; z++)
      for (let x = 0; x < SIZE[0]; x++) {
        const h = (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
        const r = ((h >>> 0) % 100) / 100;
        s += r < 0.12 ? "b" : r < 0.19 ? "m" : r < 0.25 ? "s" : ".";
      }
  return s;
}

interface Case {
  name: string;
  cell: 2 | 4;
  boxes: WireBox[];
  missing: [number, number][];
  /** The answer: aligned regions with their cells as palette indices, the palette, the missing chunks touched. */
  answer?: { palette: string[]; regions: { box: WireBox; states: number[] }[]; missing: [number, number][] };
}

const cases: Case[] = [
  { name: "whole-blob-2", cell: 2, boxes: [{ min: [-10, 58, -6], max: [9, 69, 13] }], missing: [] },
  { name: "whole-blob-4", cell: 4, boxes: [{ min: [-10, 58, -6], max: [9, 69, 13] }], missing: [] },
  {
    name: "unaligned-overlapping",
    cell: 4,
    boxes: [
      { min: [-3, 61, -1], max: [5, 66, 2] },
      { min: [1, 59, 1], max: [2, 59, 2] },
      { min: [-12, 70, -8], max: [-9, 73, -5] },
    ],
    missing: [],
  },
  { name: "ungenerated", cell: 2, boxes: [{ min: [-6, 60, -4], max: [7, 65, 5] }], missing: [[-1, 0], [0, -1]] },
];

function answer(c: string, k: Case): NonNullable<Case["answer"]> {
  const missing = new Set(k.missing.map(([x, z]) => `${x},${z}`));
  const at = (x: number, y: number, z: number): string => {
    if (missing.has(`${x >> 4},${z >> 4}`)) return AIR;
    const lx = x - ORIGIN[0], ly = y - ORIGIN[1], lz = z - ORIGIN[2];
    if (lx < 0 || ly < 0 || lz < 0 || lx >= SIZE[0] || ly >= SIZE[1] || lz >= SIZE[2]) return AIR;
    return CELL[c[lx + SIZE[0] * (lz + SIZE[2] * ly)]!]!;
  };
  const palette: string[] = [];
  const index = new Map<string, number>();
  const regions = k.boxes.map((b) => coarseRegion(b, k.cell, at, palette, index));
  return { palette, regions: regions.map((r) => ({ box: r.box, states: [...r.states] })), missing: missingIn(regions.map((r) => r.box), missing) };
}

describe("coarse parity fixture", () => {
  const c = cells();
  const want = cases.map((k) => ({ ...k, answer: answer(c, k) }));

  it("records the fake host's answers (the mod's CoarseCellsTest replays them)", () => {
    const fixture = { origin: ORIGIN, size: SIZE, cells: c, legend: CELL, cases: want };
    if (process.env.UPDATE_COARSE_PARITY) writeFileSync(FIXTURE, JSON.stringify(fixture, null, 1) + "\n");
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(JSON.parse(JSON.stringify(fixture)));
  });

  it("covers majorities, ties, all-air cells and ungenerated chunks", () => {
    const blob = want[0]!.answer;
    expect(blob.palette).toContain(AIR);
    expect(new Set(blob.palette).size).toBe(4);
    expect(want[3]!.answer.missing).toEqual([[0, -1], [-1, 0]]);
    // At least one cell of 2³ is a tie, so the first-met rule is exercised.
    const at = (x: number, y: number, z: number): string => CELL[c[x + SIZE[0] * (z + SIZE[2] * y)]!]!;
    let ties = 0;
    for (let y = 0; y + 1 < SIZE[1]; y += 2)
      for (let z = 0; z < SIZE[2]; z += 2)
        for (let x = 0; x < SIZE[0]; x += 2) {
          const n = new Map<string, number>();
          for (let i = 0; i < 8; i++) {
            const s = at(x + (i & 1), y + ((i >> 2) & 1), z + ((i >> 1) & 1));
            if (s !== AIR) n.set(s, (n.get(s) ?? 0) + 1);
          }
          const counts = [...n.values()].sort((a, b) => b - a);
          if (counts.length > 1 && counts[0] === counts[1]) ties++;
        }
    expect(ties).toBeGreaterThan(0);
  });
});
