import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoggedEvent } from "../../../src/core/events.js";
import { fromPublic, type Vec3 } from "../../../src/core/region.js";
import { Settings } from "../../../src/core/settings.js";
import { Document } from "../../../src/document/document.js";
import { decodeRecords } from "../../../src/observe/deltas.js";
import { startObserve } from "../../../src/observe/index.js";
import { parseBytes, parseHttp } from "../../../src/observe/settings.js";
import { fill } from "../../../src/ops/edit.js";

const roots: string[] = [];
const tempWorkspace = () => {
  const d = mkdtempSync(join(tmpdir(), "autosketch-deltas-"));
  roots.push(d);
  return d;
};
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

const box = (min: Vec3, max: Vec3) => fromPublic({ min, max });
const readLog = (path: string) => readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as LoggedEvent);

function setup(set: string[], scopes: Record<string, Document> = {}) {
  const workspace = tempWorkspace();
  const doc = Document.create({ name: "keep", dataVersion: 3955 });
  const obs = startObserve({
    workspace,
    settings: Settings.from(set.flatMap((s) => ["--set", s]), {}),
    sessionId: "s",
    flushMs: 5,
    getDoc: () => doc,
    getScopeDoc: (id) => scopes[id],
  });
  obs.bus.publish("base", { kind: "session.open", name: "keep" });
  doc.events = obs.sink();
  const dir = join(workspace, "keep", "observe", "s");
  return { workspace, doc, obs, dir };
}

/** Rebuilds the state table from the log and decodes one event's delta into readable records. */
function deltaOf(events: LoggedEvent[], bin: Buffer, e: LoggedEvent): [number, number, number, string][] {
  const table = new Map<number, string>();
  for (const s of events) if (s.kind === "state.add") table.set(s.id, s.state);
  const ref = (e as { delta?: { offset: number; length: number } }).delta!;
  return decodeRecords(bin.subarray(ref.offset, ref.offset + ref.length)).map(([x, y, z, id]) => [x, y, z, table.get(id)!]);
}

describe("deltas.bin and the state.add table (12, phase 4)", () => {
  it("logs the after-state of each op and the before-state of an undo, with state.add first", async () => {
    const { doc, obs, dir } = setup(["observe.deltas=on"]);
    fill(doc, {}, box([0, 0, 0], [1, 0, 0]), "minecraft:stone");
    fill(doc, {}, box([1, 0, 0], [1, 1, 0]), "minecraft:oak_planks");
    doc.undo();
    doc.redo();
    await obs.close();
    const events = readLog(join(dir, "events.ndjson"));
    expect(events.map((e) => e.kind)).toEqual([
      "session.open",
      "state.add", "state.add", "doc.op",
      "state.add", "doc.op",
      "doc.undo", "doc.redo",
    ]);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.filter((e) => e.kind === "state.add").map((e) => [(e as { id: number }).id, (e as { state: string }).state])).toEqual([
      [0, "minecraft:air"], [1, "minecraft:stone"], [2, "minecraft:oak_planks"],
    ]);
    const bin = readFileSync(join(dir, "deltas.bin"));
    expect(bin.length).toBe((2 + 2 + 2 + 2) * 16);
    const [, , , op1, , op2, undo, redo] = events as LoggedEvent[];
    expect((op1 as { delta: unknown }).delta).toEqual({ offset: 0, length: 32 });
    expect(deltaOf(events, bin, op1!).sort()).toEqual([[0, 0, 0, "minecraft:stone"], [1, 0, 0, "minecraft:stone"]]);
    expect(deltaOf(events, bin, op2!).sort()).toEqual([[1, 0, 0, "minecraft:oak_planks"], [1, 1, 0, "minecraft:oak_planks"]]);
    expect(deltaOf(events, bin, undo!).sort()).toEqual([[1, 0, 0, "minecraft:stone"], [1, 1, 0, "minecraft:air"]]);
    expect(deltaOf(events, bin, redo!).sort()).toEqual([[1, 0, 0, "minecraft:oak_planks"], [1, 1, 0, "minecraft:oak_planks"]]);
  });

  it("is off by default without the viewer, and stops adding deltas past observe.maxDeltaBytes", async () => {
    const off = setup([]);
    fill(off.doc, {}, box([0, 0, 0], [1, 0, 0]), "minecraft:stone");
    await off.obs.close();
    expect(off.obs.deltas).toBeUndefined();
    expect(readLog(join(off.dir, "events.ndjson")).map((e) => e.kind)).toEqual(["session.open", "doc.op"]);

    const capped = setup(["observe.deltas=on", "observe.maxDeltaBytes=64"]);
    fill(capped.doc, {}, box([0, 0, 0], [1, 0, 0]), "minecraft:stone"); // 32 bytes
    fill(capped.doc, {}, box([0, 1, 0], [2, 1, 0]), "minecraft:stone"); // 48: over the cap
    fill(capped.doc, {}, box([0, 2, 0], [0, 2, 0]), "minecraft:stone"); // 16: would fit, but capped stays capped
    await capped.obs.close();
    const ops = readLog(join(capped.dir, "events.ndjson")).filter((e) => e.kind === "doc.op");
    expect(ops.map((e) => (e as { delta?: unknown }).delta)).toEqual([{ offset: 0, length: 32 }, undefined, undefined]);
    expect(capped.obs.deltas!.capped).toBe(true);
    expect(readFileSync(join(capped.dir, "deltas.bin")).length).toBe(32);
  });

  it("logs sandbox ops in the sandbox's own frame, tagged with its doc, sharing the table", async () => {
    const sandbox = Document.create({ name: "s1", dataVersion: 3955 });
    const { doc, obs, dir } = setup(["observe.deltas=on"], { s1: sandbox });
    sandbox.events = obs.sink("s1");
    fill(doc, {}, box([10, 0, 10], [10, 0, 10]), "minecraft:stone");
    fill(sandbox, {}, box([0, 0, 0], [0, 0, 1]), "minecraft:stone");
    fill(sandbox, {}, box([1, 0, 0], [1, 0, 0]), "minecraft:glass");
    await obs.close();
    const events = readLog(join(dir, "events.ndjson"));
    const bin = readFileSync(join(dir, "deltas.bin"));
    const ops = events.filter((e) => e.kind === "doc.op");
    expect(ops.map((e) => e.doc)).toEqual(["base", "s1", "s1"]);
    expect(deltaOf(events, bin, ops[1]!).sort()).toEqual([[0, 0, 0, "minecraft:stone"], [0, 0, 1, "minecraft:stone"]]);
    expect(deltaOf(events, bin, ops[2]!)).toEqual([[1, 0, 0, "minecraft:glass"]]);
    // stone was added once, for the base op; the sandbox reused it.
    expect(events.filter((e) => e.kind === "state.add").map((e) => (e as { state: string }).state)).toEqual(["minecraft:air", "minecraft:stone", "minecraft:glass"]);
  });

  it("keeps op latency low with deltas on (measured against the log alone)", async () => {
    const run = (doc: Document) => {
      const t0 = performance.now();
      for (let i = 0; i < 200; i++) fill(doc, {}, box([0, i % 16, 0], [31, i % 16, 31]), i % 2 ? "minecraft:stone" : "minecraft:dirt");
      return performance.now() - t0;
    };
    const measure = async (set: string[]) => {
      const s = setup(set);
      run(Document.create({ name: "warm", dataVersion: 3955 }));
      const ms = run(s.doc);
      await s.obs.close();
      return ms;
    };
    const plain = await measure([]);
    const withDeltas = await measure(["observe.deltas=on"]);
    console.log(`200 fills of 1024 blocks: ${plain.toFixed(1)} ms with the log, ${withDeltas.toFixed(1)} ms with log and deltas`);
    expect(withDeltas).toBeLessThan(plain * 2 + 50);
  });

  it("parses the new settings", () => {
    expect([parseHttp("true"), parseHttp("off"), parseHttp("0"), parseHttp("8123"), parseHttp("70000"), parseHttp("x")]).toEqual([0, false, 0, 8123, undefined, undefined]);
    expect([parseBytes("64"), parseBytes("512M"), parseBytes("1g"), parseBytes("12x")]).toEqual([64, 512 * 1024 ** 2, 1024 ** 3, undefined]);
  });
});
