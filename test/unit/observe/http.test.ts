import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import type { LoggedEvent } from "../../../src/core/events.js";
import { fromPublic, type Vec3 } from "../../../src/core/region.js";
import { Settings } from "../../../src/core/settings.js";
import { Document } from "../../../src/document/document.js";
import type { ModelsJson } from "../../../src/observe/atlas.js";
import { EventBus } from "../../../src/observe/bus.js";
import { decodeRecords } from "../../../src/observe/deltas.js";
import { ObserveHttp } from "../../../src/observe/http.js";
import { startObserve } from "../../../src/observe/index.js";
import { LogTables } from "../../../src/observe/states.js";
import { decodeVoxels } from "../../../src/observe/voxels.js";
import { fill } from "../../../src/ops/edit.js";
import { TextureLoader } from "../../../src/palette/textures.js";
import { BlockBaker } from "../../../src/perception/render/bake.js";
import { solidPng } from "../../helpers/fixtures.js";
import { memStack, VANILLA_PARENTS } from "../../helpers/stack.js";

const roots: string[] = [];
const tempWorkspace = () => {
  const d = mkdtempSync(join(tmpdir(), "autosketch-http-"));
  roots.push(d);
  return d;
};
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

const box = (min: Vec3, max: Vec3) => fromPublic({ min, max });

function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; type: string; body: Buffer }> {
  return new Promise((ok, fail) => {
    const req = request(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => ok({ status: res.statusCode ?? 0, type: String(res.headers["content-type"]), body: Buffer.concat(chunks) }));
    });
    req.on("error", fail);
    req.end();
  });
}

/** Opens an SSE stream and collects parsed messages until `until` returns true. */
function sse(url: string, until: (msgs: { event: string; data: unknown }[]) => boolean): Promise<{ event: string; data: unknown }[]> {
  return new Promise((ok, fail) => {
    const msgs: { event: string; data: unknown }[] = [];
    let buf = "";
    const req = request(url, (res) => {
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        buf += c;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
          if (!data) continue;
          const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
          msgs.push({ event, data: JSON.parse(data) });
        }
        if (until(msgs)) {
          req.destroy();
          ok(msgs);
        }
      });
    });
    req.on("error", (e) => (msgs.length ? ok(msgs) : fail(e)));
    req.end();
  });
}

async function setup() {
  const workspace = tempWorkspace();
  const stack = await memStack([
    ["base", "base", {
      ...VANILLA_PARENTS,
      "assets/test/blockstates/red.json": { variants: { "": { model: "test:block/red" } } },
      "assets/test/models/block/red.json": { parent: "block/cube_all", textures: { all: "test:block/red" } },
      "assets/test/textures/block/red.png": solidPng([200, 30, 30]),
    }],
  ]);
  const baker = new BlockBaker(stack, new TextureLoader(stack), undefined);
  const doc = Document.create({ name: "keep", dataVersion: 3955 });
  const sandbox = Document.create({ name: "s1", dataVersion: 3955 });
  const obs = startObserve({
    workspace,
    settings: Settings.from(["--set", "observe.http=true"], {}),
    sessionId: "s",
    flushMs: 5,
    getDoc: () => doc,
    getScopeDoc: (id) => (id === "s1" ? sandbox : undefined),
    getBaker: async () => baker,
  });
  const url = (await obs.ready)!;
  obs.bus.publish("base", { kind: "session.open", name: "keep" });
  doc.events = obs.sink();
  sandbox.events = obs.sink("s1");
  return { workspace, doc, sandbox, obs, url };
}

describe("viewer HTTP server (12, phase 3)", () => {
  it("binds loopback, writes the url file, and serves info, voxels, deltas and assets", async () => {
    const { workspace, doc, sandbox, obs, url } = await setup();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    fill(doc, {}, box([0, 0, 0], [1, 0, 0]), "test:red");
    fill(doc, {}, box([0, 1, 0], [0, 1, 0]), "minecraft:stone");
    fill(sandbox, {}, box([0, 0, 0], [0, 0, 0]), "minecraft:glass");

    const info = JSON.parse((await get(url + "info")).body.toString());
    expect(info).toMatchObject({ session: "s", doc: "keep", deltas: { on: true, capped: false, bytes: 64 }, assets: true });
    // deltas default to "auto": on with the viewer.
    expect(obs.deltas).toBeDefined();

    const snap = decodeVoxels((await get(url + "doc/base/snapshot")).body);
    expect(snap.header).toMatchObject({ v: 1, doc: "base", count: 3, bounds: { min: [0, 0, 0], max: [1, 1, 0] } });
    const named = (recs: Buffer, states: Record<string, string>) => decodeRecords(recs).map(([x, y, z, id]) => [x, y, z, states[id]]).sort();
    expect(named(snap.records, snap.header.states)).toEqual([[0, 0, 0, "test:red"], [0, 1, 0, "minecraft:stone"], [1, 0, 0, "test:red"]]);

    const region = decodeVoxels((await get(url + "doc/base/region?box=1,0,0,1,1,0")).body);
    expect(named(region.records, region.header.states)).toEqual([[1, 0, 0, "test:red"]]);
    expect((await get(url + "doc/base/region?box=1,2")).status).toBe(400);
    const scoped = decodeVoxels((await get(url + "doc/s1/snapshot")).body);
    expect(named(scoped.records, scoped.header.states)).toEqual([[0, 0, 0, "minecraft:glass"]]);
    expect((await get(url + "doc/nope/snapshot")).status).toBe(404);

    const deltas = await get(url + "log/deltas?offset=32&length=16");
    expect(decodeRecords(deltas.body)).toEqual([[0, 1, 0, 2]]);
    expect((await get(url + "log/deltas?offset=3&length=16")).status).toBe(400);

    const models = JSON.parse((await get(url + "assets/models.json")).body.toString()) as ModelsJson;
    const redId = Object.entries(snap.header.states).find(([, s]) => s === "test:red")![0];
    const red = models.models[redId]!;
    expect(red.q).toHaveLength(6);
    expect(red.occ).toBe(63);
    expect(red.q.find((q) => q.cull === 1)!.c).toEqual([1, 1, 1]);
    const atlas = PNG.sync.read((await get(url + "assets/atlas.png")).body);
    expect(atlas.width).toBe(models.atlas.width);
    const [u, v] = red.q[0]!.uv as [number, number];
    const px = (Math.floor(v) * atlas.width + Math.floor(u)) * 4;
    expect([...atlas.data.subarray(px, px + 3)]).toEqual([200, 30, 30]);

    expect((await get(url + "info", { host: "evil.example:80" })).status).toBe(403);
    expect((await get(url + "../package.json")).status).toBe(404);
    await obs.close();
    expect(readFileSync(join(workspace, "keep", "observe", "s", "url"), "utf8")).toBe(url + "\n");
  });

  it("streams events over SSE from `since`, then live", async () => {
    const { doc, obs, url } = await setup();
    fill(doc, {}, box([0, 0, 0], [0, 0, 0]), "minecraft:stone");
    const last = obs.bus.lastSeq;
    const live = sse(url + `events?since=${last - 1}`, (m) => m.some((x) => (x.data as LoggedEvent).kind === "doc.checkpoint"));
    await new Promise((r) => setTimeout(r, 50));
    doc.checkpoint("cp");
    const msgs = await live;
    expect(msgs.map((m) => (m.data as LoggedEvent).seq)).toEqual([last, last + 1]);
    expect((msgs[0]!.data as LoggedEvent).kind).toBe("doc.op");
    expect((msgs[0]!.data as { delta: unknown }).delta).toEqual({ offset: 0, length: 16 });
    await obs.close();
  });

  it("sends resync when a client asks for events older than the buffer", async () => {
    const bus = new EventBus();
    const tables = new LogTables((e) => bus.publish("base", e));
    const http = new ObserveHttp({ bus, tables, sessionId: "s", dirFor: () => tempWorkspace(), docFor: () => undefined, port: 0, bufferEvents: 4 });
    bus.subscribe(http.onEvent);
    const url = await http.start();
    for (let i = 0; i < 10; i++) bus.publish("base", { kind: "doc.checkpoint", name: `c${i}`, jseq: i });
    const msgs = await sse(url + "events?since=0", (m) => m.length >= 2);
    expect(msgs[0]).toEqual({ event: "resync", data: { seq: 10, from: expect.any(Number) } });
    expect((msgs[1]!.data as LoggedEvent).seq).toBe((msgs[0]!.data as { from: number }).from);
    await http.close();
  });

  it("is off by default", async () => {
    const obs = startObserve({ workspace: tempWorkspace(), settings: Settings.from([], {}), sessionId: "s", getDoc: () => undefined });
    expect(obs.http).toBeUndefined();
    expect(await obs.ready).toBeUndefined();
    await obs.close();
  });
});
