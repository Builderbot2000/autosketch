import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { buildPaletteIndexData, PaletteIndex } from "../../../src/palette/index.js";
import { PaletteBook } from "../../../src/palette/pick.js";
import { SheetRenderer } from "../../../src/palette/sheet.js";
import type { InstanceContext } from "../../../src/server/context.js";
import { createServer } from "../../../src/server/server.js";
import { Session } from "../../../src/server/session.js";
import { LiveLink } from "../../../src/world/live-link.js";
import type { SnapshotRequest, SnapshotResult } from "../../../src/world/protocol/messages.js";
import { autoSyncHook, syncLink } from "../../../src/world/sync.js";
import { BridgeError } from "../../../src/world/bridge.js";
import { WorldView, type WorldViewOptions } from "../../../src/world/view.js";
import { FakeHost } from "../../support/fake-host.js";
import { solidPng } from "../../helpers/fixtures.js";
import { fakeRegistry } from "../../helpers/registry.js";
import { memStack } from "../../helpers/stack.js";

/**
 * The world view (18, piece 5): read-only, beside the open document, with sandboxes open, against
 * the fake host. The host's volumes (work (0,60,0)–(15,72,15), default context +3) grant the reads;
 * the linked document "world" is the open document the view sits beside.
 */

const roots: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "autosketch-view-"));
  roots.push(d);
  return d;
};
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

let host: FakeHost | undefined;
let link: LiveLink | undefined;
let view: WorldView | undefined;
afterEach(async () => {
  view?.close();
  link?.close();
  await host?.close();
  host = link = view = undefined;
});

async function setup(opts: { contextCap?: number } = {}) {
  host = await FakeHost.start({ volumes: { work: { min: [0, 60, 0], max: [15, 72, 15] } } });
  host.set([5, 63, 5], "minecraft:stone");
  host.set([6, 63, 5], "minecraft:andesite");
  for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) host.set([x, 60, z], "minecraft:stone");
  const session = new Session(tempDir());
  link = new LiveLink(session, { ackWaitMs: 2000, backoff: { minMs: 20, maxMs: 50 } });
  link.setSync(syncLink);
  session.world = link;
  session.callHooks.push(autoSyncHook(() => session.world));
  let request: number | undefined;
  view = new WorldView({ bridge: link.bridge, request: () => request, dimension: () => link!.volumes?.dimension, ...opts });
  session.worldView = view;
  const server = createServer(fixtureContext(host.instanceDir), { session });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  link.autoLink({ instanceDir: host.instanceDir, plugins: [], palettes: new PaletteBook() });
  await host.waitFor(() => link!.state === "linked");
  const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  return { session, client, host, call, view, setRequest: (id: number | undefined) => (request = id) };
}

describe("the world view (18, piece 5)", () => {
  it("reads beside the linked document, and the five tools address it with view:\"world\"", async () => {
    const { session, call, host, view } = await setup();
    const base = session.doc!;
    expect(base.meta.name).toBe("world");
    const r = await call("world_view_read", { box: { min: [0, 60, 0], max: [7, 66, 7] } });
    expect(texts(r)[0]).toBe(
      "ok · world_view_read · 448 blocks (66 non-air) at (0,60,0)–(7,66,7) in minecraft:overworld. " +
        'The world view now holds 1 read within (0,60,0)–(7,66,7), in world coordinates; look with view:"world" on render, view_slice, raycast, select and analyze. Nothing in it reaches the world.',
    );
    // Beside, not instead: the linked document is still the open one, and unchanged.
    expect(session.doc).toBe(base);
    expect(view.doc).not.toBe(base);
    // World coordinates, block for block.
    expect(view.doc.getState(5, 63, 5)).toBe("minecraft:stone");
    expect(view.doc.getState(6, 63, 5)).toBe("minecraft:andesite");
    expect(view.doc.getState(5, 64, 5)).toBe("minecraft:air");
    expect(view.doc.getState(0, 60, 0)).toBe("minecraft:stone");
    expect(view.doc.getState(8, 60, 0)).toBe("minecraft:air"); // not read
    expect(view.has([7, 66, 7])).toBe(true);
    expect(view.has([8, 60, 0])).toBe(false);

    const slice = await call("view_slice", { view: "world", axis: "y", at: 63, region: { min: [4, 63, 4], max: [7, 63, 6] } });
    expect(slice.isError).toBeFalsy();
    expect(texts(slice).join("\n")).toMatch(/stone/);
    expect(texts(slice).join("\n")).toMatch(/andesite/);

    const render = await call("render", { view: "world", views: ["top"], size: 128 });
    expect(render.isError).toBeFalsy();
    const caption = texts(render)[0]!;
    expect(caption).toMatch(/\bw1\b/);
    expect(caption).toContain("note: the world view (minecraft:overworld, world coordinates, 1 reads)");
    const ray = await call("raycast", { view: "world", px: 64, py: 64 });
    expect(ray.isError).toBeFalsy();
    expect(texts(ray)[0]).toMatch(/^w1 /);
    expect((await call("raycast", { view: "w1", px: 64, py: 64 })).isError).toBeFalsy();
    // The document's own renders keep their r ids.
    const docRender = await call("render", { views: ["top"], size: 128 });
    expect(texts(docRender)[0]).toMatch(/\br1\b/);

    const an = await call("analyze", { view: "world" });
    expect(an.isError).toBeFalsy();
    expect(texts(an)[0]).toMatch(/stone/);

    // Selections are stored in the view and reused there, never in the document.
    const sel = await call("select", { view: "world", sel: { min: [5, 63, 5], max: [6, 63, 5] }, name: "candidate" });
    expect(sel.isError).toBeFalsy();
    expect(view.doc.selections.has("candidate")).toBe(true);
    expect(base.selections.has("candidate")).toBe(false);
    expect((await call("render", { view: "world", region: "candidate", size: 128 })).isError).toBeFalsy();
    const q = await call("analyze", { view: "world", region: "candidate" });
    expect(texts(q)[0]).toMatch(/^box: \(5,63,5\)–\(6,63,5\), 2×1×1 \(x×y×z\); 2 blocks;/);
    expect(texts(q)[0]).toContain("materials: andesite 1 (50%), stone 1 (50%)");
    // world_view_read by a selection in the view: its bounding box.
    const grow = await call("world_view_read", { sel: { dilate: "candidate", by: 1 } });
    expect(texts(grow)[0]).toMatch(/^ok · world_view_read · 36 blocks .* at \(4,62,4\)–\(7,64,6\)/);
    expect(view.reads).toHaveLength(2);

    // Nothing reached the world.
    expect(host.patchLog).toHaveLength(0);
  });

  it("refuses every edit on the view", async () => {
    const { view, call, host } = await setup();
    await call("world_view_read", { box: { min: [0, 60, 0], max: [3, 61, 3] } });
    expect(() => view.doc.edit("fill", "test", (tx) => tx.set(0, 61, 0, "minecraft:stone"))).toThrow(
      expect.objectContaining({ refusal: "world_view_read_only", message: expect.stringMatching(/^The world view is a read-only look at the world, so fill can't edit it/) }),
    );
    expect(view.doc.getState(0, 61, 0)).toBe("minecraft:air");
    expect(host.patchLog).toHaveLength(0);
  });

  it("works with sandboxes open: view calls need no scope, document edits still do", async () => {
    const { call, view } = await setup();
    const f = await call("scope_fork", { work: { min: [0, 0, 0], max: [7, 7, 7] }, brief: "x" });
    expect(f.isError).toBeFalsy();
    expect(texts(await call("world_view_read", { box: { min: [0, 60, 0], max: [7, 66, 7] } }))[0]).toMatch(/^ok · world_view_read/);
    expect((await call("render", { view: "world", views: ["top"], size: 128 })).isError).toBeFalsy();
    const sel = await call("select", { view: "world", sel: { min: [5, 63, 5], max: [5, 63, 5] }, name: "candidate" });
    expect(sel.isError).toBeFalsy();
    expect(view.doc.selections.has("candidate")).toBe(true);
    // The same select on the base document must name its target, as before.
    expect(texts(await call("select", { sel: { min: [0, 0, 0], max: [0, 0, 0] }, name: "x" }))[0]).toMatch(/must name its target/);
  });

  it("refuses perception calls on an empty view", async () => {
    const { call } = await setup();
    const r = await call("render", { view: "world" });
    expect(r.isError).toBe(true);
    expect(texts(r)[0]).toMatch(/^The world view holds nothing yet/);
  });
});

describe("coarse, fade and surface reads (18, pieces 5, 6, 10)", () => {
  it("reads over contextCap coarse, and a full read replaces the coarse cells there", async () => {
    const { call, view } = await setup({ contextCap: 64 });
    // 256 blocks: over the cap of 64, so one block per 2³ cell (32 cells).
    const r = await call("world_view_read", { box: { min: [0, 60, 0], max: [7, 63, 7] } });
    expect(texts(r)[0]).toBe(
      "ok · world_view_read · 256 blocks over the per-read cap of 64, so read coarse: one block per 2³ cell (the cell's most common non-air block, drawn over the whole cell; 18 non-air cells) at (0,60,0)–(7,63,7) in minecraft:overworld. " +
        "Positions already held at full detail were kept; read a smaller box there to replace coarse cells with full detail. " +
        'The world view now holds 1 read (coarse) within (0,60,0)–(7,63,7), in world coordinates; look with view:"world" on render, view_slice, raycast, select and analyze. Nothing in it reaches the world.',
    );
    // Cells on the world grid, each drawn whole: the y=60 stone layer fills y 60–61; the stone at
    // (5,63,5) fills the cell (4..5, 62..63, 4..5), the andesite at (6,63,5) the cell beside it.
    const d = view.doc;
    expect(d.getState(0, 61, 0)).toBe("minecraft:stone");
    expect(d.getState(4, 62, 4)).toBe("minecraft:stone");
    expect(d.getState(7, 63, 4)).toBe("minecraft:andesite");
    expect(d.getState(2, 62, 2)).toBe("minecraft:air");
    expect(view.isCoarse([4, 62, 4])).toBe(true);
    let render = await call("render", { view: "world", views: ["top"], size: 128 });
    expect(texts(render)[0]).toContain("coarse: (0,60,0)–(7,63,7) at 2³ cells: each cell is drawn whole");
    // Each non-air cell is drawn as one cube (V3), not as its 8 blocks.
    expect(texts(render)[0]).toContain("drew 0 blocks and 18 coarse cells (one cube each)");

    // A full read of a smaller box replaces the coarse cells there, block for block.
    await call("world_view_read", { box: { min: [4, 62, 4], max: [7, 63, 5] } });
    expect(d.getState(4, 62, 4)).toBe("minecraft:air");
    expect(d.getState(5, 63, 5)).toBe("minecraft:stone");
    expect(d.getState(7, 63, 4)).toBe("minecraft:air");
    expect(d.getState(6, 63, 5)).toBe("minecraft:andesite");
    expect(d.getState(0, 61, 0)).toBe("minecraft:stone"); // still coarse outside it
    expect(view.isCoarse([4, 62, 4])).toBe(false);
    expect(view.isCoarse([0, 61, 0])).toBe(true);
    render = await call("render", { view: "world", views: ["top"], size: 128 });
    expect(texts(render)[0]).toContain("coarse: (0,60,0)–(7,63,7) at 2³ cells (partly replaced by full detail)");
    // The two cells the full read met are drawn block by block, the other 16 as cubes.
    expect(view.coarseParts()).toEqual([{ box: { min: [0, 60, 0], max: [8, 64, 8] }, cell: 2, partial: true, except: [{ min: [4, 62, 4], max: [8, 64, 6] }] }]);
    expect(texts(render)[0]).toMatch(/drew [1-9]\d* blocks and 16 coarse cells \(one cube each\)/);

    // A coarse read never overwrites what is held at full detail.
    await call("world_view_read", { box: { min: [0, 60, 0], max: [7, 63, 7] } });
    expect(d.getState(4, 62, 4)).toBe("minecraft:air");
    expect(d.getState(6, 63, 5)).toBe("minecraft:andesite");
    expect(d.getState(7, 63, 4)).toBe("minecraft:air");
  });

  it("fades all but the candidate, and tints its left-out neighbours with the existing algebra", async () => {
    const { call } = await setup();
    await call("world_view_read", { box: { min: [0, 60, 0], max: [7, 66, 7] } });
    expect((await call("select", { view: "world", sel: { min: [5, 63, 5], max: [5, 63, 5] }, name: "candidate" })).isError).toBeFalsy();
    const r = await call("render", {
      view: "world",
      views: ["iso_se"],
      size: 128,
      region: { dilate: "candidate", by: 8 },
      fade: "candidate",
      // 18, piece 6: the solid blocks touching the candidate but not in it.
      highlight: { filter: { subtract: [{ dilate: "candidate", by: 1 }, "candidate"] }, air: false },
    });
    expect(r.isError).toBeFalsy();
    const caption = texts(r)[0]!;
    expect(caption).toContain("faded: 65 blocks outside the fade selection drawn grey and translucent; 1 inside it drawn solid");
    expect(caption).toContain("highlighted 1 position in orange");
    // The highlighted neighbour is the andesite beside the candidate.
    const q = await call("analyze", { view: "world", region: { filter: { subtract: [{ dilate: "candidate", by: 1 }, "candidate"] }, air: false } });
    expect(texts(q)[0]).toMatch(/^box: \(6,63,5\)–\(6,63,5\)/);
  });

  it("reads a surface map for terrain: one block per column, within the box's y range", async () => {
    const { call, view } = await setup();
    const r = await call("world_view_read", { surface: { min: [0, 61, 0], max: [7, 70, 7] } });
    expect(texts(r)[0]).toMatch(
      /^ok · world_view_read · the surface of 64 columns at \(0,61,0\)–\(7,70,7\): 2 top blocks kept, one per column, 62 columns whose top lies outside the box's y range left out \(only the top block of each column is read; nothing below it\) in minecraft:overworld\. The world view now holds 1 read \(surface\)/,
    );
    expect(view.doc.getState(5, 63, 5)).toBe("minecraft:stone");
    expect(view.doc.getState(6, 63, 5)).toBe("minecraft:andesite");
    expect(view.doc.getState(0, 60, 0)).toBe("minecraft:air"); // under the box's y range
    expect(view.has([5, 63, 5])).toBe(false); // a surface read doesn't hold whole columns

    await call("world_view_read", { surface: { min: [0, 0, 0], max: [7, 70, 7] } });
    expect(view.doc.getState(0, 60, 0)).toBe("minecraft:stone");
    expect(view.doc.getState(5, 60, 5)).toBe("minecraft:air"); // below a column's top: not read
    expect((await call("render", { view: "world", views: ["top"], size: 128 })).isError).toBeFalsy();
  });
});

describe("WorldView", () => {
  const stub = (served: SnapshotRequest[]): WorldViewOptions["bridge"] => ({
    connected: true,
    on: () => () => {},
    request: (async (m: SnapshotRequest): Promise<SnapshotResult> => {
      served.push(m);
      const boxes = "boxes" in m ? m.boxes : [];
      return {
        type: "snapshot.result",
        id: 1,
        dimension: m.dimension,
        palette: ["minecraft:air", "minecraft:stone"],
        regions: boxes.map((box) => {
          const n = (box.max[0] - box.min[0] + 1) * (box.max[1] - box.min[1] + 1) * (box.max[2] - box.min[2] + 1);
          return { box, states: new Uint32Array(n).fill(1), blockEntities: [] };
        }),
      };
    }) as never,
  });

  it("empties itself when the request changes, and keeps selections for the request", async () => {
    let request: number | undefined = 1;
    const served: SnapshotRequest[] = [];
    const v = new WorldView({ bridge: stub(served), request: () => request, dimension: () => "minecraft:overworld", contextCap: 1000 });
    await v.read({ boxes: [{ min: [100, -10, -2000], max: [101, -9, -1999] }] });
    expect(served).toEqual([expect.objectContaining({ dimension: "minecraft:overworld", boxes: [{ min: [100, -10, -2000], max: [101, -9, -1999] }] })]);
    expect(v.doc.getState(101, -9, -1999)).toBe("minecraft:stone");
    v.doc.selections.set("candidate", { min: [100, -10, -2000], max: [100, -10, -2000] });
    expect(v.request).toBe(1);
    expect(v.doc.selections.has("candidate")).toBe(true);
    request = 2;
    expect(v.empty).toBe(true);
    expect(v.doc.getState(101, -9, -1999)).toBe("minecraft:air");
    expect(v.doc.selections.has("candidate")).toBe(false);
    // Over the per-read cap even at 4³ cells: refused before anything is sent.
    await expect(v.read({ boxes: [{ min: [0, 0, 0], max: [63, 63, 67] }] })).rejects.toMatchObject({ refusal: "world_view_too_large" });
    expect(served).toHaveLength(1);
    // The new request's view reads as usual; no request at all is another view again.
    await v.read({ boxes: [{ min: [0, 0, 0], max: [0, 0, 0] }] });
    expect(v.reads).toHaveLength(1);
    request = undefined;
    expect(v.empty).toBe(true);
  });
});

describe("WorldView coarse fallback", () => {
  it("goes coarse when the mod answers too_large, and to 4³ cells when 2³ is too large too", async () => {
    const sent: { kind?: string; cell?: number }[] = [];
    const bridge: WorldViewOptions["bridge"] = {
      connected: true,
      on: () => () => {},
      request: (async (m: { kind?: string; cell?: number; boxes: { min: [number, number, number]; max: [number, number, number] }[]; dimension: string }) => {
        sent.push({ ...(m.kind ? { kind: m.kind } : {}), ...(m.cell ? { cell: m.cell } : {}) });
        if (m.kind !== "coarse" || m.cell === 2) throw new BridgeError("too_large", "the read is over contextCap");
        const box = { min: [0, 0, 0] as [number, number, number], max: [7, 3, 3] as [number, number, number] };
        return { type: "snapshot.result", id: 1, dimension: m.dimension, kind: "coarse", cell: 4, palette: ["minecraft:air", "minecraft:stone"], regions: [{ box, states: Uint32Array.from([1, 0]) }] };
      }) as never,
    };
    const v = new WorldView({ bridge, request: () => 1, dimension: () => "minecraft:overworld", contextCap: 1000 });
    const r = await v.read({ boxes: [{ min: [1, 1, 1], max: [6, 2, 2] }] });
    expect(sent).toEqual([{}, { kind: "coarse", cell: 2 }, { kind: "coarse", cell: 4 }]);
    expect(r).toMatchObject({ level: "coarse", cell: 4, solid: 1, boxes: [{ min: [0, 0, 0], max: [8, 4, 4] }] });
    expect(v.doc.getState(0, 0, 0)).toBe("minecraft:stone");
    expect(v.doc.getState(3, 3, 3)).toBe("minecraft:stone");
    expect(v.doc.getState(4, 0, 0)).toBe("minecraft:air");
    expect(v.coarseParts()).toEqual([{ box: { min: [0, 0, 0], max: [8, 4, 4] }, cell: 4, partial: false }]);
  });
});

async function fixtureContext(root: string): Promise<InstanceContext> {
  const registry = fakeRegistry([{ id: "minecraft:andesite", tags: ["c:stones"] }, { id: "minecraft:stone", tags: [] }]);
  const stack = await memStack([["base", "base", { "assets/minecraft/textures/block/andesite.png": solidPng([130, 130, 130]), "assets/minecraft/textures/block/stone.png": solidPng([120, 120, 120]) }]]);
  const palette = new PaletteIndex(await buildPaletteIndexData(stack, registry), registry);
  return { info: { name: "Fixture", mcVersion: "1.21.1", launcher: "generic", root }, stack, registry, palette, plugins: [], sheets: new SheetRenderer(palette, stack), book: new PaletteBook(), warnings: [], timings: {} };
}

function texts(r: Awaited<ReturnType<Client["callTool"]>>): string[] {
  return (r.content as { type: string; text: string }[]).filter((c) => c.type === "text").map((c) => c.text);
}
