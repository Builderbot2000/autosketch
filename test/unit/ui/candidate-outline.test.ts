import { describe, expect, it } from "vitest";
import { Mask } from "../../../src/core/mask.js";
import { CANDIDATE_ALPHA, CANDIDATE_COLOUR, candidateFill, shellFaces } from "../../../src/ui/candidate-outline.js";
import { jobColour } from "../../../src/ui/colours.js";
import { CANDIDATE_FILL, UI_FILL_SPANS, type UiSpan } from "../../../src/world/protocol/messages.js";

/**
 * The candidate's steady fill record (18, piece 8; 13, *In-game UI*, Fill): the sections' shell
 * merged into rectangles with no face doubled, and the mask's outline edges merged into segments
 * (briefs/select/P, step P3).
 */

const D = "minecraft:overworld";
const mask = (...ps: [number, number, number][]) => {
  const m = new Mask();
  for (const p of ps) m.add(...p);
  return m;
};
/** The shell of a set of sections (section coordinates), through a mask with one block in each. */
const shellOf = (...ss: [number, number, number][]) => candidateFill(mask(...ss.map(([x, y, z]) => [x * 16 + 3, y * 16 + 3, z * 16 + 3] as [number, number, number])), D).faces;

/** Unit squares a face covers, as keys, to find doubles. */
function cells(f: UiSpan): string[] {
  const axis = [0, 1, 2].find((a) => f[a] === f[a + 3])!;
  const [u, v] = [0, 1, 2].filter((a) => a !== axis) as [number, number];
  const out: string[] = [];
  for (let i = f[u]!; i < f[u + 3]!; i += 16) for (let j = f[v]!; j < f[v + 3]!; j += 16) out.push(`${axis}:${f[axis]}:${i}:${j}`);
  return out;
}
const noDoubles = (faces: UiSpan[]) => {
  const all = faces.flatMap(cells);
  expect(new Set(all).size).toBe(all.length);
};

describe("candidate shell faces (18, piece 8)", () => {
  it("draws one section as its six faces, in world corner coordinates", () => {
    const f = candidateFill(mask([5, 70, -3]), D);
    expect(f).toMatchObject({ id: CANDIDATE_FILL, colour: CANDIDATE_COLOUR, alpha: CANDIDATE_ALPHA, dimension: D });
    expect(f.faces).toEqual([
      [0, 64, -16, 0, 80, 0],
      [0, 64, -16, 16, 64, 0],
      [0, 64, -16, 16, 80, -16],
      [0, 64, 0, 16, 80, 0],
      [0, 80, -16, 16, 80, 0],
      [16, 64, -16, 16, 80, 0],
    ]);
  });

  it("skips the face between two occupied sections and merges the rest into rectangles", () => {
    const faces = shellOf([0, 0, 0], [1, 0, 0]);
    expect(faces).toEqual([
      [0, 0, 0, 0, 16, 16],
      [0, 0, 0, 32, 0, 16],
      [0, 0, 0, 32, 16, 0],
      [0, 0, 16, 32, 16, 16],
      [0, 16, 0, 32, 16, 16],
      [32, 0, 0, 32, 16, 16],
    ]);
    expect(faces.some((f) => f[0] === 16 && f[3] === 16)).toBe(false); // the shared plane x = 16
  });

  it("never doubles a face: an L of sections, a hollow ring and a 4×4×4 block", () => {
    const l = shellOf([0, 0, 0], [1, 0, 0], [0, 1, 0]);
    noDoubles(l);
    // Outer area of the L: 3 sections × 6 − 2 shared pairs × 2 = 14 unit faces.
    expect(l.flatMap(cells)).toHaveLength(14);
    const ring: [number, number, number][] = [];
    for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) if (x !== 1 || z !== 1) ring.push([x, 0, z]);
    const r = shellOf(...ring);
    noDoubles(r);
    // 8 sections × 6 − 8 shared pairs × 2 = 32 unit faces (the inner hole's 4 walls included).
    expect(r.flatMap(cells)).toHaveLength(32);
    const cube: [number, number, number][] = [];
    for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) for (let z = 0; z < 4; z++) cube.push([x, y, z]);
    expect(shellOf(...cube)).toHaveLength(6); // one rectangle per side
  });

  it("merges by the same rule from section keys alone", () => {
    expect(shellFaces([])).toEqual([]);
  });
});

describe("candidate outline edges (18, piece 8)", () => {
  it("draws a block's twelve edges", () => {
    const e = candidateFill(mask([5, 70, -3]), D).edges;
    expect(e).toHaveLength(12);
    expect(e).toContainEqual([5, 70, -3, 6, 70, -3]);
    expect(e).toContainEqual([6, 70, -2, 6, 71, -2]);
    expect(e).toContainEqual([5, 71, -3, 5, 71, -2]);
  });

  it("merges edges along a line across a section boundary, and draws none on a flat surface", () => {
    // A 4×1×1 bar from x 14 to 17 crosses x = 16.
    const e = candidateFill(mask([14, 0, 0], [15, 0, 0], [16, 0, 0], [17, 0, 0]), D).edges;
    expect(e).toEqual([
      [14, 0, 0, 14, 0, 1],
      [14, 0, 0, 14, 1, 0],
      [14, 0, 0, 18, 0, 0],
      [14, 0, 1, 14, 1, 1],
      [14, 0, 1, 18, 0, 1],
      [14, 1, 0, 14, 1, 1],
      [14, 1, 0, 18, 1, 0],
      [14, 1, 1, 18, 1, 1],
      [18, 0, 0, 18, 0, 1],
      [18, 0, 0, 18, 1, 0],
      [18, 0, 1, 18, 1, 1],
      [18, 1, 0, 18, 1, 1],
    ]);
  });

  it("draws an inner corner and a diagonal touch", () => {
    // An L of three blocks: the inner corner's vertical edge at (1, 1) is drawn (three of four around it).
    const l = candidateFill(mask([0, 0, 0], [1, 0, 0], [0, 0, 1]), D).edges;
    expect(l).toContainEqual([1, 0, 1, 1, 1, 1]);
    // Two blocks touching along one edge: that edge is drawn once.
    const d = candidateFill(mask([0, 0, 0], [1, 1, 0]), D).edges;
    expect(d.filter((s) => s[0] === 1 && s[1] === 1 && s[3] === 1 && s[4] === 1)).toEqual([[1, 1, 0, 1, 1, 1]]);
    // 24 edges: the shared one counted once, and the four lines through the touching edge (two along x, two along y) each merged into one segment.
    expect(d).toHaveLength(19);
  });

  it("leaves the edges out whole past the record's span limit, keeping the shell", () => {
    // A checkerboard layer: every block's edges are separate lines.
    const m = new Mask();
    for (let x = 0; x < 200; x++) for (let z = 0; z < 200; z++) if ((x + z) % 2) m.add(x, 0, z);
    const f = candidateFill(m, D);
    expect(f.edges).toEqual([]);
    expect(f.faces.length).toBeGreaterThan(0);
    expect(f.faces.length + f.edges.length).toBeLessThanOrEqual(UI_FILL_SPANS);
  });

  it("is a colour no job has", () => {
    for (const id of ["base", "j1", "j2", "west-tower", "candidate"]) expect(jobColour(id)).not.toBe(CANDIDATE_COLOUR);
  });
});
