import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_EVENTS, type LoggedEvent } from "../../../src/core/events.js";
import { fromPublic } from "../../../src/core/region.js";
import { Settings } from "../../../src/core/settings.js";
import { Document } from "../../../src/document/document.js";
import { EventBus } from "../../../src/observe/bus.js";
import { startObserve } from "../../../src/observe/index.js";
import { EventLog } from "../../../src/observe/log.js";
import { clear, fill } from "../../../src/ops/edit.js";
import { PaletteBook } from "../../../src/palette/pick.js";
import { Session } from "../../../src/server/session.js";

const roots: string[] = [];
const tempWorkspace = () => {
  const d = mkdtempSync(join(tmpdir(), "autosketch-obs-"));
  roots.push(d);
  return d;
};
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

const box = (min: [number, number, number], max: [number, number, number]) => fromPublic({ min, max });
const readLog = (path: string) =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as LoggedEvent & Record<string, unknown>);
// Drops the envelope's time so payloads compare exactly.
const strip = ({ t: _t, ...rest }: Record<string, unknown>) => rest;

describe("event log (12, phase 1)", () => {
  it("writes ops, checkpoint, undo and redo in seq order with the kinds-table payloads", async () => {
    const workspace = tempWorkspace();
    const obs = startObserve({ workspace, settings: Settings.from([], {}), version: "9.9.9", sessionId: "s1", flushMs: 5 });
    const session = new Session(workspace);
    session.events = obs.sink("base");

    const doc = await session.create({ name: "house", mcVersion: "1.21.1", palettes: new PaletteBook() });
    fill(doc, {}, box([0, 0, 0], [2, 0, 2]), "minecraft:stone");
    doc.checkpoint("floor");
    clear(doc, box([0, 0, 0], [0, 0, 0]));
    doc.undo();
    doc.redo();
    await session.close();
    await obs.close();

    const events = readLog(join(workspace, "house", "observe", "s1", "events.ndjson"));
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(events.every((e) => e.v === 1 && e.doc === "base" && typeof e.t === "number")).toBe(true);
    expect(events.map(strip)).toEqual([
      { v: 1, seq: 1, doc: "base", kind: "session.open", name: "house", version: "9.9.9" },
      { v: 1, seq: 2, doc: "base", kind: "doc.op", jseq: 1, op: "fill", summary: doc.journal.entries[0]!.summary, changed: 9, box: { min: [0, 0, 0], max: [2, 0, 2] }, counts: { placed: { "minecraft:stone": 9 }, removed: 0 } },
      { v: 1, seq: 3, doc: "base", kind: "doc.checkpoint", name: "floor", jseq: 1 },
      { v: 1, seq: 4, doc: "base", kind: "doc.op", jseq: 2, op: "clear", summary: doc.journal.entries[1]!.summary, changed: 1, box: { min: [0, 0, 0], max: [0, 0, 0] }, counts: { placed: {}, removed: 1 } },
      { v: 1, seq: 5, doc: "base", kind: "doc.undo", jseq: 2, op: "clear", changed: 1, box: { min: [0, 0, 0], max: [0, 0, 0] } },
      { v: 1, seq: 6, doc: "base", kind: "doc.redo", jseq: 2, op: "clear", changed: 1, box: { min: [0, 0, 0], max: [0, 0, 0] } },
      { v: 1, seq: 7, doc: "base", kind: "session.close", name: "house" },
    ]);
  });

  it("puts events from before a document opened into that document's log, and logs nothing when off", async () => {
    const workspace = tempWorkspace();
    const obs = startObserve({ workspace, settings: Settings.from([], {}), sessionId: "s2", flushMs: 5 });
    const session = new Session(workspace);
    session.events = obs.sink();
    session.events.emit({ kind: "call.start", call: 1, tool: "doc_new" });
    await session.create({ name: "a", mcVersion: "1.21.1", palettes: new PaletteBook() });
    session.events.emit({ kind: "call.end", call: 1, tool: "doc_new", ms: 1, ok: true, chars: 10, images: 0, pixels: 0 });
    await obs.close();
    const kinds = readLog(join(workspace, "a", "observe", "s2", "events.ndjson")).map((e) => `${e.seq} ${e.kind}`);
    expect(kinds).toEqual(["1 call.start", "2 session.open", "3 call.end"]);

    const off = startObserve({ workspace, settings: Settings.from(["--set", "observe.log=false"], {}), sessionId: "s3" });
    expect(off.sink()).toBe(NO_EVENTS);
    const s2 = new Session(workspace);
    s2.events = off.sink();
    const doc = await s2.create({ name: "b", mcVersion: "1.21.1", palettes: new PaletteBook() });
    expect(doc.events).toBe(NO_EVENTS);
    fill(doc, {}, box([0, 0, 0], [1, 1, 1]), "minecraft:stone");
    await off.close();
    expect(existsSync(join(workspace, "b", "observe"))).toBe(false);
  });

  it("prunes older session folders down to observe.retainSessions", async () => {
    const workspace = tempWorkspace();
    for (const id of ["20260101T000000000Z-aaaa", "20260102T000000000Z-bbbb", "20260103T000000000Z-cccc"]) mkdirSync(join(workspace, "p", "observe", id), { recursive: true });
    const obs = startObserve({ workspace, settings: Settings.from(["--set", "observe.retainSessions=2"], {}), sessionId: "20260104T000000000Z-dddd", flushMs: 5 });
    const session = new Session(workspace);
    session.events = obs.sink();
    await session.create({ name: "p", mcVersion: "1.21.1", palettes: new PaletteBook() });
    await obs.close();
    expect(readdirSync(join(workspace, "p", "observe")).sort()).toEqual(["20260103T000000000Z-cccc", "20260104T000000000Z-dddd"]);
  });

  it("never blocks on a stalled disk: drops past the backlog cap, then marks the gap", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const written: string[] = [];
    const fs = {
      mkdir: async () => undefined,
      readdir: async () => [],
      rm: async () => undefined,
      appendFile: async (_p: unknown, data: unknown) => {
        await gate;
        written.push(String(data));
      },
    } as unknown as ConstructorParameters<typeof EventLog>[0]["fs"];
    const log = new EventLog({ workspace: "/nowhere", sessionId: "s", retain: 5, maxPendingBytes: 2000, flushMs: 1, ...(fs ? { fs } : {}) });
    const bus = new EventBus();
    bus.subscribe(log.onEvent);
    const sink = bus.sink();
    sink.emit({ kind: "session.open", name: "d" });

    const t0 = performance.now();
    for (let i = 0; i < 200; i++) {
      sink.emit({ kind: "doc.checkpoint", name: `c${i}`, jseq: i });
      if (i % 20 === 0) void log.flush(); // writes start and stall behind the gate
    }
    expect(performance.now() - t0).toBeLessThan(200);
    expect(log.dropped).toBeGreaterThan(100);
    const dropped = log.dropped;

    release();
    await log.flush();
    sink.emit({ kind: "session.close", name: "d" });
    await log.flush();
    const lines = written.join("").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.filter((l) => l.kind === "observe.dropped")).toEqual([expect.objectContaining({ count: dropped })]);
    expect(lines.at(-1)).toMatchObject({ kind: "session.close", seq: 202 });
    expect(lines.filter((l) => l.kind === "doc.checkpoint").length).toBe(200 - dropped);
  });

  it("adds little latency to ops (measured with and without the log)", async () => {
    const workspace = tempWorkspace();
    const run = (doc: Document) => {
      const t0 = performance.now();
      for (let i = 0; i < 300; i++) fill(doc, {}, box([0, i % 16, 0], [15, i % 16, 15]), Math.floor(i / 16) % 2 ? "minecraft:stone" : "minecraft:dirt");
      return performance.now() - t0;
    };
    run(Document.create({ name: "warm", dataVersion: 3955 }));
    const plain = run(Document.create({ name: "plain", dataVersion: 3955 }));

    const obs = startObserve({ workspace, settings: Settings.from([], {}), sessionId: "lat", flushMs: 50 });
    const doc = Document.create({ name: "logged", dataVersion: 3955 });
    obs.bus.publish("base", { kind: "session.open", name: "logged" });
    doc.events = obs.sink();
    const logged = run(doc);
    await obs.close();
    console.log(`300 fills of 256 blocks: ${plain.toFixed(1)} ms without the log, ${logged.toFixed(1)} ms with it`);
    expect(readLog(join(workspace, "logged", "observe", "lat", "events.ndjson"))).toHaveLength(301);
    expect(logged).toBeLessThan(plain * 2 + 50);
  });
});
