import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Vec3 } from "../../../src/core/region.js";
import { Document } from "../../../src/document/document.js";
import { resolveSelection } from "../../../src/ops/selection.js";
import type { ExpandBy, FillResult } from "../../../src/world/protocol/messages.js";
import { WorldFill, type SelectGrant } from "../../support/fake-select.js";

/**
 * The fill parity fixture (docs/design/18-select.md, piece 3, *Testing*): the fake host's fill and
 * expand answers (`test/support/fake-select.ts`, the reference algorithm) on one blob of blocks across
 * four chunks, recorded in `test/data/select/fill-parity.json`. The mod's JUnit `FillWalkTest` runs its
 * own fill over the same cells and must give the same answers byte for byte; here the fixture is
 * checked against the fake host (so neither side drifts alone) and the complete fills against
 * `{connected}` at 6, 18 and 26. `UPDATE_FILL_PARITY=1` rewrites the fixture.
 */

const FIXTURE = new URL("../../data/select/fill-parity.json", import.meta.url);
const BRICK = "minecraft:stone_bricks";
const MOSSY = "minecraft:mossy_stone_bricks";
const AIR = "minecraft:air";
const SIZE: Vec3 = [24, 12, 24];
const ORIGIN: Vec3 = [-12, 60, 4]; // chunks x -1..0, z 0..1; sections y 3..4

/** The blob: per cell `b` (brick), `m` (mossy) or `.` (air), index x + 24·(z + 24·y). */
function cells(): string {
  let s = "";
  for (let y = 0; y < SIZE[1]; y++)
    for (let z = 0; z < SIZE[2]; z++)
      for (let x = 0; x < SIZE[0]; x++) {
        const h = (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
        const r = ((h >>> 0) % 100) / 100;
        s += r < 0.45 ? "b" : r < 0.55 ? "m" : ".";
      }
  return s;
}

const CELL: Record<string, string> = { b: BRICK, m: MOSSY, ".": AIR };

function stateAt(c: string): (x: number, y: number, z: number) => string {
  return (x, y, z) => {
    const lx = x - ORIGIN[0], ly = y - ORIGIN[1], lz = z - ORIGIN[2];
    if (lx < 0 || ly < 0 || lz < 0 || lx >= SIZE[0] || ly >= SIZE[1] || lz >= SIZE[2]) return AIR;
    return CELL[c[lx + SIZE[0] * (lz + SIZE[2] * ly)]!]!;
  };
}

interface Step {
  /** The first step is the fill; the others expand it. */
  expand?: ExpandBy;
  budget?: number;
}
interface Scenario {
  name: string;
  seed: Vec3;
  match: string[];
  connectivity: 6 | 18 | 26;
  area: number;
  grant: { centre: [number, number]; radius: number };
  missing: [number, number][];
  steps: Step[];
  /** Per step, the answer in the canonical form below. */
  answers?: unknown[];
}

/** An answer as plain JSON: masks base64, frontier sections as `[sx, sy, sz, index[], faces[]]`. */
function canonical(r: FillResult): unknown {
  return {
    count: r.count,
    box: r.box,
    stopped: r.stopped,
    delta: r.delta ?? false,
    missing: r.missing,
    sections: r.sections.map((s) => [...s.section, s.mask === "full" ? "full" : Buffer.from(s.mask).toString("base64")]),
    frontier: r.frontier.map((f) => [...f.section, f.index, f.faces]),
  };
}

function scenarios(c: string): Scenario[] {
  const g = { centre: [0, 0] as [number, number], radius: 8 };
  // The first brick (index order) whose 6-connected brick shape has at least 200 blocks.
  let w: Vec3 = [0, 0, 0];
  for (let i = 0; i < c.length; i++) {
    if (c[i] !== "b") continue;
    w = [(i % 24) + ORIGIN[0], Math.floor(i / 576) + ORIGIN[1], (Math.floor(i / 24) % 24) + ORIGIN[2]];
    const f = new WorldFill(w, [BRICK], 6, { dimension: "", ...g }, new Set(), 2);
    if (f.run(stateAt(c), 1e9).size >= 200) break;
  }
  const base = { seed: w, grant: g, missing: [] as [number, number][] };
  return [
    ...([6, 18, 26] as const).map((connectivity) => ({ ...base, name: `complete-${connectivity}`, match: [BRICK], connectivity, area: 2, steps: [{}] })),
    {
      ...base,
      name: "edge-then-expand",
      match: [BRICK, MOSSY],
      connectivity: 26,
      area: 0,
      steps: [{}, { expand: "frontier" }, { expand: { direction: "east", chunks: 1 } }, { expand: { box: { min: [-40, 0, 20], max: [-20, 0, 40] } } }],
    },
    {
      ...base,
      name: "budget-rounds",
      match: ["solid"],
      connectivity: 6,
      area: 2,
      steps: [{ budget: 300 }, { expand: "frontier", budget: 300 }, { expand: "frontier", budget: 1 }, { expand: "frontier", budget: 100_000 }],
    },
    { ...base, name: "budget-diagonal", match: [BRICK], connectivity: 18, area: 0, steps: [{ budget: 50 }, { expand: "frontier", budget: 2000 }, { expand: "frontier" }] },
    { ...base, name: "ungenerated", match: [BRICK, MOSSY], connectivity: 26, area: 1, missing: [[0, 1], [-2, 0]], steps: [{}, { expand: "frontier" }] },
    {
      ...base,
      name: "grant-edge",
      match: [BRICK],
      connectivity: 26,
      area: 1,
      grant: { centre: [w[0] >> 4, w[2] >> 4], radius: 0 },
      steps: [{}, { expand: { direction: "east", chunks: 2 } }],
    },
    { ...base, name: "no-match", seed: [ORIGIN[0] - 5, 64, ORIGIN[2]], match: [BRICK], connectivity: 26, area: 1, steps: [{}] },
  ];
}

function run(sc: Scenario, c: string): unknown[] {
  const grant: SelectGrant = { dimension: "minecraft:overworld", centre: sc.grant.centre, radius: sc.grant.radius };
  const missing = new Set(sc.missing.map(([x, z]) => `${x},${z}`));
  const f = new WorldFill(sc.seed, sc.match, sc.connectivity, grant, missing, sc.area);
  const at = stateAt(c);
  return sc.steps.map((s, i) => {
    if (i === 0) {
      f.run(at, s.budget ?? 4_194_304);
      return canonical(f.result(i + 1, grant.dimension));
    }
    f.expand(s.expand!);
    const added = f.run(at, s.budget ?? 4_194_304);
    return canonical(f.result(i + 1, grant.dimension, added));
  });
}

describe("fill parity fixture", () => {
  const c = cells();
  const want = scenarios(c).map((sc) => ({ ...sc, answers: run(sc, c) }));

  it("records the fake host's answers (the mod's FillWalkTest replays them)", () => {
    const fixture = { origin: ORIGIN, size: SIZE, minY: -64, maxY: 319, cells: c, scenarios: want };
    if (process.env.UPDATE_FILL_PARITY) writeFileSync(FIXTURE, JSON.stringify(fixture, null, 1) + "\n");
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(JSON.parse(JSON.stringify(fixture)));
  });

  it("covers every stop and a delta, and its complete fills are {connected}'s", () => {
    const stops = new Set(want.flatMap((sc) => sc.answers.map((a) => (a as { stopped: string }).stopped)));
    expect([...stops].sort()).toEqual(["budget", "complete", "edge"]);
    const doc = Document.create({ name: "t", dataVersion: 3955, seed: 1, size: SIZE });
    doc.edit("test", "blob", (tx) => {
      for (let i = 0; i < c.length; i++) if (c[i] !== ".") tx.set(i % 24, Math.floor(i / 576), Math.floor(i / 24) % 24, CELL[c[i]!]!);
    });
    for (const sc of want.filter((s) => s.name.startsWith("complete-"))) {
      const local: Vec3 = [sc.seed[0] - ORIGIN[0], sc.seed[1] - ORIGIN[1], sc.seed[2] - ORIGIN[2]];
      const count = resolveSelection({ connected: { seed: local, connectivity: sc.connectivity } }, { doc }).mask.count();
      const a = sc.answers[0] as { count: number; stopped: string };
      expect(a.stopped).toBe("complete");
      expect(a.count).toBe(count);
    }
  });
});
