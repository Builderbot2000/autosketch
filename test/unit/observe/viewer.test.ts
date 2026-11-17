import { describe, expect, it } from "vitest";
// The viewer bundle is plain ESM JavaScript (no build step); its pure modules run in Node. The
// session model's tests moved with it to session-model.test.ts (16).
// @ts-expect-error untyped JS module
import { VoxelGrid, decodeVoxels, fallbackModel, meshChunk, STRIDE } from "../../../viewer/js/voxels.js";

const W = (min: number[], max: number[]) => ({ min, max });

describe("viewer voxels and meshing (12, panels 1 and 6)", () => {
  it("decodes the server's voxel payload", () => {
    const json = Buffer.from(JSON.stringify({ v: 1, doc: "base", seq: 9, count: 1, states: { 1: "minecraft:stone" } }));
    const head = Buffer.alloc(8);
    head.write("ASVX", 0, "latin1");
    head.writeUInt32LE(json.length, 4);
    const rec = Buffer.alloc(16);
    rec.writeInt32LE(-3, 0);
    rec.writeInt32LE(2, 4);
    rec.writeInt32LE(7, 8);
    rec.writeUInt32LE(1, 12);
    const buf = Buffer.concat([head, json, rec]);
    const { header, records } = decodeVoxels(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
    expect(header.seq).toBe(9);
    expect([...records]).toEqual([-3, 2, 7, 1]);
  });

  it("culls faces between opaque neighbours, also across chunks and at negative coordinates", () => {
    const g = new VoxelGrid();
    g.applyRecords(new Int32Array([-1, 0, 0, 1, 0, 0, 0, 1]));
    expect(g.get(-1, 0, 0)).toBe(1);
    expect(g.bounds()).toEqual(W([-1, 0, 0], [0, 0, 0]));
    const model = fallbackModel("minecraft:stone");
    const quads = (k: string) => meshChunk(g, k, () => model, [1, 1]).opaque.length / STRIDE / 6;
    // Two cubes side by side in two chunks: 5 visible faces each.
    expect(quads(VoxelGrid.key(-1, 0, 0))).toBe(5);
    expect(quads(VoxelGrid.key(0, 0, 0))).toBe(5);
    g.set(0, 0, 0, 0);
    expect(quads(VoxelGrid.key(-1, 0, 0))).toBe(6);
  });

  it("draws ghosted context blocks in the blended pass, desaturated and translucent", () => {
    const g = new VoxelGrid();
    g.applyRecords(new Int32Array([0, 0, 0, 1, 1, 0, 0, 1]));
    const model = fallbackModel("minecraft:stone");
    const m = meshChunk(g, VoxelGrid.key(0, 0, 0), () => model, [1, 1], (x: number) => x > 0);
    // The work block keeps its face against the ghost, and the ghost keeps its face against the work block.
    expect(m.opaque.length / STRIDE / 6).toBe(6);
    expect(m.blend.length / STRIDE / 6).toBe(6);
    const v = m.blend.subarray(0, STRIDE);
    expect(v[8]).toBeCloseTo(0.3);
    expect(v[5]).toBeCloseTo(v[6]!);
  });
});
