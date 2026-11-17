import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromPublic, type Vec3 } from "../../../src/core/region.js";
import { Settings } from "../../../src/core/settings.js";
import { Document } from "../../../src/document/document.js";
import { startObserve } from "../../../src/observe/index.js";
import { readSessionLog } from "../../../src/observe/reader.js";
import { Replayer, StateGrid, activityAt, modelAt, replayPlan } from "../../../src/observe/replay.js";
import { fill } from "../../../src/ops/edit.js";

/** The replay planner, moved from the viewer (16, *What goes, what stays, what moves*; 12, *Panels*, 7). */

const roots: string[] = [];
const tempWorkspace = () => {
  const d = mkdtempSync(join(tmpdir(), "autosketch-replay-"));
  roots.push(d);
  return d;
};
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

const box = (min: Vec3, max: Vec3) => fromPublic({ min, max });

/** A finished session: a document opened with content, ops, an undo, a fork's sandbox op. */
async function finishedSession(set: string[] = ["observe.deltas=on"]) {
  const workspace = tempWorkspace();
  const doc = Document.create({ name: "keep", dataVersion: 3955 });
  fill(doc, {}, box([0, 0, 0], [1, 0, 0]), "minecraft:stone"); // content before the session opened
  const sandbox = Document.create({ name: "s1", dataVersion: 3955 });
  const obs = startObserve({
    workspace,
    settings: Settings.from(["observe.http=false", ...set].flatMap((s) => ["--set", s]), {}), // no viewer unless a test asks
    sessionId: "20261108T000000000Z-test",
    flushMs: 5,
    getDoc: () => doc,
    getScopeDoc: (id) => (id === "s1" ? sandbox : undefined),
  });
  obs.bus.publish("base", { kind: "session.open", name: "keep" });
  doc.events = obs.sink();
  sandbox.events = obs.sink("s1");
  fill(doc, {}, box([0, 1, 0], [0, 1, 0]), "minecraft:glass");
  const afterGlass = obs.bus.lastSeq;
  fill(doc, {}, box([-1, 0, 0], [-1, 0, 0]), "minecraft:dirt");
  fill(doc, {}, box([0, 2, 0], [0, 2, 0]), "minecraft:oak_planks");
  doc.undo();
  obs.bus.publish("base", { kind: "scope.fork", scope: "s1", parent: "base", depth: 1, brief: "tower", work: { min: [0, 0, 0], max: [3, 3, 3] }, translation: [0, 0, 0] } as never);
  fill(sandbox, {}, box([1, 1, 1], [1, 1, 1]), "minecraft:glass");
  await obs.close();
  return { workspace, doc, afterGlass, dir: join(workspace, "keep", "observe", "20261108T000000000Z-test") };
}

/** The document's blocks as [x, y, z, state] in its local frame. */
function blocks(doc: Document): [number, number, number, string][] {
  const out: [number, number, number, string][] = [];
  const [ox, oy, oz] = doc.toLocal(0, 0, 0);
  doc.voxels.forEach((x, y, z, v) => out.push([x + ox, y + oy, z + oz, doc.states.get(v)]));
  return out.sort();
}

function gridBlocks(grid: { chunks: Map<string, Uint32Array> }, states: Map<number, string>): [number, number, number, string][] {
  const out: [number, number, number, string][] = [];
  for (const [k, c] of grid.chunks) {
    const [cx, cy, cz] = k.split(",").map(Number) as [number, number, number];
    for (let i = 0; i < 4096; i++) if (c[i]) out.push([cx * 16 + (i & 15), cy * 16 + (i >> 8), cz * 16 + ((i >> 4) & 15), states.get(c[i]!)!]);
  }
  return out.sort();
}

describe("replay planner (12, *Panels*, 7)", () => {
  it("replays the base document exactly at the end and at an earlier seq, through an undo", async () => {
    const { doc, dir, afterGlass } = await finishedSession();
    const evs = (await readSessionLog(dir)).events;
    const bin = readFileSync(join(dir, "deltas.bin"));
    const deltas = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
    const states = new Map<number, string>();
    for (const e of evs) if (e.kind === "state.add") states.set(e.id, e.state);
    const grid = new StateGrid();
    const r = new Replayer(grid);
    const last = evs[evs.length - 1]!.seq;

    const end = r.seek(evs, last, deltas);
    expect(end.gap).toBeUndefined();
    expect(gridBlocks(grid, states)).toEqual(blocks(doc));
    expect(blocks(doc)).toEqual([[-1, 0, 0, "minecraft:dirt"], [0, 0, 0, "minecraft:stone"], [0, 1, 0, "minecraft:glass"], [1, 0, 0, "minecraft:stone"]]);

    r.seek(evs, afterGlass, deltas); // backwards: rebuilt from the keyframe
    expect(gridBlocks(grid, states)).toEqual([[0, 0, 0, "minecraft:stone"], [0, 1, 0, "minecraft:glass"], [1, 0, 0, "minecraft:stone"]]);
    r.seek(evs, last, deltas); // forwards again, incrementally
    expect(gridBlocks(grid, states)).toEqual(blocks(doc));

    const m = modelAt(evs, afterGlass);
    expect(m.scopes.has("s1")).toBe(false);
    expect(modelAt(evs, last).scopes.get("s1")!.ops).toBe(1);
    expect(activityAt(evs, afterGlass, deltas).cells.get("0,0")).toBe(1);
  });

  it("moves existing blocks by -shift before a step's records (frame after the step)", () => {
    const grid = new StateGrid();
    const r = new Replayer(grid);
    const evs = [
      { seq: 1, doc: "base", kind: "session.open", name: "keep", delta: { offset: 0, length: 16 } },
      { seq: 2, doc: "base", kind: "doc.op", changed: 1, shift: [-2, 0, 0], delta: { offset: 16, length: 16 } },
    ];
    const recs = new Int32Array([0, 0, 0, 1, 0, 1, 0, 2]);
    r.seek(evs as never, 2, recs.buffer);
    expect(gridBlocks(grid, new Map([[1, "a"], [2, "b"]]))).toEqual([[0, 1, 0, "b"], [2, 0, 0, "a"]]);
  });

  it("falls back to the newest time-lapse snapshot when deltas were off", async () => {
    const { dir } = await finishedSession([]);
    const log = (await readSessionLog(dir)).events;
    const evs = [...log, { v: 1, seq: 999, t: 0, doc: "base", kind: "render.produced", view: "iso_ne", size: [512, 512], source: "snapshot", path: "snapshots/5.png" }];
    const last = log[log.length - 1]!.seq;
    const plan = replayPlan(evs as never, last);
    expect(plan.gap?.kind).toBe("session.open");
    expect(plan.snapshot).toEqual({ seq: 5, path: "snapshots/5.png" });
    expect(replayPlan(evs as never, 4).snapshot).toBeUndefined();
  });
});

