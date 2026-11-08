import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoggedEvent } from "../../../src/core/events.js";
import { fromPublic, type Vec3 } from "../../../src/core/region.js";
import { Settings } from "../../../src/core/settings.js";
import { Document } from "../../../src/document/document.js";
import { decodeRecords } from "../../../src/observe/deltas.js";
import { startObserve } from "../../../src/observe/index.js";
import { serveLog } from "../../../src/observe/offline.js";
import { fill } from "../../../src/ops/edit.js";
// @ts-expect-error plain ESM viewer module without types
import { Replayer, activityAt, modelAt, replayPlan } from "../../../viewer/js/replay.js";
// @ts-expect-error plain ESM viewer module without types
import { VoxelGrid } from "../../../viewer/js/voxels.js";

const roots: string[] = [];
const tempWorkspace = () => {
  const d = mkdtempSync(join(tmpdir(), "autosketch-offline-"));
  roots.push(d);
  return d;
};
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

const box = (min: Vec3, max: Vec3) => fromPublic({ min, max });

function get(url: string): Promise<{ status: number; type: string; body: Buffer }> {
  return new Promise((ok, fail) => {
    const req = request(url, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => ok({ status: res.statusCode ?? 0, type: String(res.headers["content-type"]), body: Buffer.concat(chunks) }));
    });
    req.on("error", fail);
    req.end();
  });
}

/** Reads SSE messages until `n` events arrived. */
function events(url: string, n: number): Promise<LoggedEvent[]> {
  return new Promise((ok, fail) => {
    const out: LoggedEvent[] = [];
    let buf = "";
    const req = request(url, (res) => {
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        buf += c;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split("\n").find((l) => l.startsWith("data: "));
          if (data && !/^event: /m.test(block)) out.push(JSON.parse(data.slice(6)));
        }
        if (out.length >= n) {
          req.destroy();
          ok(out);
        }
      });
    });
    req.on("error", (e) => (out.length ? ok(out) : fail(e)));
    req.end();
  });
}

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

describe("autosketch observe <path> (12, phase 5)", () => {
  it("serves a finished log read-only: info, every event, deltas, snapshots and three.js", async () => {
    const { workspace, dir } = await finishedSession();
    mkdirSync(join(dir, "snapshots"));
    writeFileSync(join(dir, "snapshots", "7.png"), "png");
    const v = await serveLog({ path: join(workspace, "keep") });
    try {
      expect(v.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      const logged = v.log.events;
      const info = JSON.parse((await get(v.url + "info")).body.toString());
      expect(info).toMatchObject({ session: "20261108T000000000Z-test", live: false, doc: "keep", seq: logged[logged.length - 1]!.seq, deltas: { on: true, capped: false }, assets: false });

      const streamed = await events(v.url + "events?since=0", logged.length);
      expect(streamed.map((e) => e.seq)).toEqual(logged.map((e) => e.seq));
      const open = streamed.find((e) => e.kind === "session.open") as LoggedEvent & { delta: { offset: number; length: number } };
      expect(open.delta).toEqual({ offset: 0, length: 32 }); // the keyframe: two stone blocks
      const key = decodeRecords((await get(v.url + `log/deltas?offset=0&length=32`)).body);
      expect(key.map(([x, y, z]) => [x, y, z])).toEqual([[0, 0, 0], [1, 0, 0]]);

      expect((await get(v.url + "doc/base/snapshot")).status).toBe(404); // no document: the viewer rebuilds from deltas
      expect((await get(v.url + "log/snapshots/7.png")).body.toString()).toBe("png");
      expect((await get(v.url + "log/snapshots/8.png")).status).toBe(404);
      const three = await get(v.url + "vendor/three/build/three.module.js");
      expect(three.status).toBe(200);
      expect(three.type).toMatch(/javascript/);
      expect(three.body.toString()).toContain("three.core.js");
      expect((await get(v.url + "vendor/three/build/three.core.js")).status).toBe(200);
      expect((await get(v.url + "vendor/three/examples/jsm/controls/OrbitControls.js")).status).toBe(200);
      expect((await get(v.url + "vendor/three/package.json")).status).toBe(404);
      expect((await get(v.url + "vendor/three/examples/jsm/../../package.json")).status).toBe(404);
      expect(existsSync(join(dir, "url"))).toBe(false); // nothing written into the log folder
    } finally {
      await v.close();
    }
  });

  it("replays the base document exactly at the end and at an earlier seq, through an undo", async () => {
    const { doc, dir, afterGlass } = await finishedSession();
    const v = await serveLog({ path: dir });
    await v.close();
    const evs = v.log.events;
    const bin = readFileSync(join(dir, "deltas.bin"));
    const deltas = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
    const states = new Map<number, string>();
    for (const e of evs) if (e.kind === "state.add") states.set(e.id, e.state);
    const grid = new VoxelGrid();
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
    expect(modelAt(evs, last).scopes.get("s1").ops).toBe(1);
    expect(activityAt(evs, afterGlass, deltas).cells.get("0,0")).toBe(1);
  });

  it("moves existing blocks by -shift before a step's records (frame after the step)", () => {
    const grid = new VoxelGrid();
    const r = new Replayer(grid);
    const evs = [
      { seq: 1, doc: "base", kind: "session.open", name: "keep", delta: { offset: 0, length: 16 } },
      { seq: 2, doc: "base", kind: "doc.op", changed: 1, shift: [-2, 0, 0], delta: { offset: 16, length: 16 } },
    ];
    const recs = new Int32Array([0, 0, 0, 1, 0, 1, 0, 2]);
    r.seek(evs, 2, recs.buffer);
    expect(gridBlocks(grid, new Map([[1, "a"], [2, "b"]]))).toEqual([[0, 1, 0, "b"], [2, 0, 0, "a"]]);
  });

  it("falls back to the newest time-lapse snapshot when deltas were off", async () => {
    const { dir } = await finishedSession([]);
    const v = await serveLog({ path: dir });
    expect(JSON.parse((await get(v.url + "info")).body.toString()).deltas).toEqual({ on: false });
    await v.close();
    const evs = [...v.log.events, { v: 1, seq: 999, t: 0, doc: "base", kind: "render.produced", view: "iso_ne", size: [512, 512], source: "snapshot", path: "snapshots/5.png" }];
    const last = v.log.events[v.log.events.length - 1]!.seq;
    const plan = replayPlan(evs, last);
    expect(plan.gap?.kind).toBe("session.open");
    expect(plan.snapshot).toEqual({ seq: 5, path: "snapshots/5.png" });
    expect(replayPlan(evs, 4).snapshot).toBeUndefined();
  });
});

describe("the observe subcommand", () => {
  it("prints the viewer URL for a finished log and serves it, without an instance", async () => {
    const { workspace } = await finishedSession();
    const repo = join(import.meta.dirname, "..", "..", "..");
    const env = { ...process.env };
    delete env.AUTOSKETCH_INSTANCE;
    const loader = pathToFileURL(join(repo, "node_modules", "tsx", "dist", "loader.mjs")).href;
    const child = spawn(process.execPath, ["--import", loader, join(repo, "src", "server", "index.ts"), "observe", join(workspace, "keep")], { env, stdio: ["ignore", "pipe", "pipe"] });
    try {
      const url = await new Promise<string>((ok, fail) => {
        let out = "";
        child.stdout.setEncoding("utf8").on("data", (c: string) => {
          out += c;
          const m = /^(http:\/\/127\.0\.0\.1:\d+\/)$/m.exec(out);
          if (m) ok(m[1]!);
        });
        child.on("exit", (code) => fail(new Error(`exited ${code}`)));
      });
      expect(JSON.parse((await get(url + "info")).body.toString())).toMatchObject({ live: false, doc: "keep" });
    } finally {
      child.kill("SIGINT");
    }
  }, 20_000);
});
