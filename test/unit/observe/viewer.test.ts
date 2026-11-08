import { describe, expect, it } from "vitest";
// The viewer bundle is plain ESM JavaScript (no build step); its pure modules run in Node.
// @ts-expect-error untyped JS module
import { Activity, SessionModel, filterEvents, toLocal } from "../../../viewer/js/model.js";
// @ts-expect-error untyped JS module
import { VoxelGrid, decodeVoxels, fallbackModel, meshChunk, STRIDE } from "../../../viewer/js/voxels.js";

const W = (min: number[], max: number[]) => ({ min, max });
let seq = 0;
const ev = (doc: string, kind: string, t: number, rest: Record<string, unknown> = {}) => ({ v: 1, seq: ++seq, t, doc, kind, ...rest });

/** A synthetic scoped session: a refused fork (lock wait), two forks, a nested fork, a merge, an abandon. */
function session() {
  seq = 0;
  return [
    ev("base", "session.open", 1000, { name: "castle", bounds: W([0, 0, 0], [31, 15, 31]) }),
    ev("base", "scope.fork", 2000, { scope: "s1", parent: "base", depth: 1, work: W([0, 0, 0], [15, 15, 15]), context: W([0, 0, 0], [17, 15, 17]), translation: [0, 0, 0], brief: "west tower" }),
    ev("base", "call.start", 2500, { call: 3, tool: "scope_fork" }),
    ev("base", "call.refused", 2501, { call: 3, tool: "scope_fork", code: "lock_overlap", message: "overlaps s1" }),
    ev("base", "scope.fork", 4000, { scope: "s2", parent: "base", depth: 1, work: W([16, 0, 0], [31, 15, 15]), context: W([14, 0, 0], [31, 15, 17]), translation: [16, 0, 0], brief: "east tower" }),
    ev("s1", "call.start", 4100, { call: 5, tool: "fill", scope: "s1" }),
    ev("s1", "doc.op", 4101, { jseq: 1, op: "fill", summary: "", changed: 4, counts: { placed: {}, removed: 0 } }),
    ev("base", "scope.fork", 4200, { scope: "s1a", parent: "s1", depth: 2, work: W([2, 8, 2], [5, 15, 5]), context: W([1, 7, 1], [6, 15, 6]), translation: [2, 8, 2], brief: "roof" }),
    ev("base", "scope.merge", 5000, { scope: "s1a", report: "roof done", jseq: 2 }),
    ev("base", "scope.abandon", 6000, { scope: "s2", reason: "restart" }),
  ];
}

describe("viewer session model (12, panels 2–5)", () => {
  it("builds the scope tree, statuses, op counts, lock waits and refusals from events", () => {
    const m = new SessionModel();
    for (const e of session()) expect(m.apply(e)).toBe(true);
    expect(m.apply({ ...session()[3]!, seq: 2 })).toBe(false); // already seen
    const tree = m.tree();
    const flat = (n: { scope: { id: string; status: string }; children: unknown[] }): string[] => [`${n.scope.id}:${n.scope.status}`, ...(n.children as never[]).flatMap(flat)];
    expect(flat(tree)).toEqual(["base:open", "s1:open", "s1a:merged", "s2:lost"]);
    expect(m.openScopes().map((s: { id: string }) => s.id)).toEqual(["s1"]);
    expect(m.scopes.get("s1").ops).toBe(1);
    expect(m.scopes.get("s1").lastTool).toBe("fill");
    expect(m.scopes.get("s1a").report).toBe("roof done");
    expect(m.lockWaits).toEqual([{ parent: "base", scope: "s2", fromT: 2501, toT: 4000, fromSeq: 4, toSeq: 5 }]);
    expect(m.refusals.map((r: { code: string }) => r.code)).toEqual(["lock_overlap"]);
    const rows = m.timelineRows();
    expect(rows.map((r: { scope: { id: string }; start: number; end: number }) => [r.scope.id, r.start, r.end])).toEqual([
      ["base", 1000, 6000], ["s1", 2000, 6000], ["s1a", 4200, 5000], ["s2", 4000, 6000],
    ]);
    expect(toLocal(m.scopes.get("s1a").work, m.scopes.get("s1a").translation)).toEqual(W([0, 0, 0], [3, 7, 3]));
  });

  it("filters the feed by document, kind, tool and refusals", () => {
    const events = session();
    expect(filterEvents(events, { refusals: true }).map((e: { seq: number }) => e.seq)).toEqual([4]);
    expect(filterEvents(events, { doc: "s1" }).map((e: { kind: string }) => e.kind)).toEqual(["call.start", "doc.op"]);
    expect(filterEvents(events, { kind: "scope" })).toHaveLength(5);
    expect(filterEvents(events, { tool: "fill" })).toHaveLength(1);
  });

  it("accumulates activity from delta records and from op boxes", () => {
    const a = new Activity();
    a.addRecords(new Int32Array([1, 0, 2, 5, 1, 1, 2, 5, 3, 0, 3, 7]));
    a.addBox(W([0, 0, 0], [1, 3, 0]), 4);
    expect(Object.fromEntries(a.cells)).toEqual({ "1,2": 2, "3,3": 1, "0,0": 2, "1,0": 2 });
    expect([a.min, a.maxXZ, a.max]).toEqual([[0, 0], [3, 3], 2]);
  });
});

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
