import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Vec3 } from "../../../src/core/region.js";
import { buildPaletteIndexData, PaletteIndex } from "../../../src/palette/index.js";
import { PaletteBook } from "../../../src/palette/pick.js";
import { SheetRenderer } from "../../../src/palette/sheet.js";
import type { InstanceContext } from "../../../src/server/context.js";
import { createServer } from "../../../src/server/server.js";
import { Session } from "../../../src/server/session.js";
import { CanvasReads } from "../../../src/world/canvas.js";
import { LiveLink } from "../../../src/world/live-link.js";
import { canvasFacts, handoff } from "../../../src/world/prompt.js";
import type { PatchMessage, SnapshotRequest, WireBox } from "../../../src/world/protocol/messages.js";
import { autoSyncHook, syncLink } from "../../../src/world/sync.js";
import { WorldView } from "../../../src/world/view.js";
import { FakeHost } from "../../support/fake-host.js";
import { solidPng } from "../../helpers/fixtures.js";
import { fakeRegistry } from "../../helpers/registry.js";
import { memStack } from "../../helpers/stack.js";

/**
 * The canvas frame (19, *The frame doesn't move with the brush*; step F1) against the fake host.
 * Canvas: chunks 0..2 on both axes, widened to world (0,-64,0)–(47,319,47), so local (0,0,0) is
 * world (0,-64,0). Brush (work volume): world (16,60,16)–(31,72,31) = local (16,124,16)–(31,136,31),
 * with the default context +3.
 */

const STONE = "minecraft:stone";
const ANDESITE = "minecraft:andesite";
const AIR = "minecraft:air";
const CANVAS: WireBox = { min: [0, -64, 0], max: [47, 319, 47] };
const WORK: WireBox = { min: [16, 60, 16], max: [31, 72, 31] };
const O: Vec3 = [0, -64, 0];
const local = (p: Vec3): Vec3 => [p[0] - O[0], p[1] - O[1], p[2] - O[2]];

const roots: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "autosketch-canvas-"));
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

async function setup(opts: { canvas?: WireBox | null; stone?: Vec3[] } = {}) {
  host = await FakeHost.start({ volumes: { work: WORK }, canvas: opts.canvas === null ? null : { box: opts.canvas ?? { min: [0, 0, 0], max: [47, 0, 47] } } });
  host.set([20, 60, 20], STONE); // in the brush
  host.set([2, 60, 2], ANDESITE); // in the canvas, outside the brush and context
  host.set([40, 70, 5], ANDESITE);
  for (const p of opts.stone ?? []) host.set(p, STONE);
  const session = new Session(tempDir());
  link = new LiveLink(session, { ackWaitMs: 2000, backoff: { minMs: 20, maxMs: 50 } });
  link.setSync(syncLink);
  session.world = link;
  session.callHooks.push(autoSyncHook(() => session.world));
  view = new WorldView({ bridge: link.bridge, request: () => undefined, dimension: () => link!.volumes?.dimension });
  session.worldView = view;
  const l = link, v = view;
  session.canvasReads = new CanvasReads({ frame: () => l.canvasFrame(), view: () => v, note: (line) => l.addNote(line) });
  const server = createServer(fixtureContext(host.instanceDir), { session });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const opened = await session.linkWorld({ instanceDir: host.instanceDir, plugins: [], palettes: new PaletteBook() });
  const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  return { session, host, link, view, call, report: opened.report };
}

const snapshots = (h: FakeHost) => h.received.filter((m): m is SnapshotRequest => m.type === "snapshot");
const patches = (h: FakeHost) => h.received.filter((m): m is PatchMessage => m.type === "patch");

describe("canvas frame (19, F1)", () => {
  it("puts local (0,0,0) at the canvas's minimum corner and keeps the document sparse", async () => {
    const { session, link, report, call } = await setup();
    expect(link.volumes).toMatchObject({ work: WORK, origin: O, canvas: CANVAS });
    expect(link.toWorld([16, 124, 16])).toEqual([16, 60, 16]);
    expect(link.toLocal([47, 319, 47])).toEqual([47, 383, 47]);
    const doc = session.doc!;
    expect(doc.getState(...local([20, 60, 20]))).toBe(STONE);
    // Sparse: only the brush's and context's sections are held; the canvas elsewhere is not in the document.
    expect(doc.localBounds()).toEqual({ min: [13, 121, 13], max: [35, 140, 35] });
    expect(doc.getState(...local([2, 60, 2]))).toBe(AIR);
    for (const s of doc.voxels.allSections()) {
      expect(s.sx * 16 + 16).toBeGreaterThan(13);
      expect(s.sx * 16).toBeLessThan(35);
    }
    expect(report).toContain("work volume 16×13×16 at world (16,60,16), local (16,124,16)–(31,136,31)");
    expect(report).toContain("Canvas 3×3 chunks (48×384×48), local (0,0,0)–(47,383,47) = world (0,-64,0)–(47,319,47): local (0,0,0) is its minimum corner");
    const info = (await call("doc_info", {})) as { content: { text: string }[] };
    expect(info.content[0]!.text).toContain(
      "World frame: canvas 3×3 chunks, local (0,0,0)–(47,383,47) = world (0,-64,0)–(47,319,47); local (0,0,0) = world (0,-64,0), the canvas's minimum corner; brush (work volume) local (16,124,16)–(31,136,31), context local (13,121,13)–(34,139,34).",
    );
  });

  it("without a canvas, keeps 13's frame", async () => {
    const { link, report, session, call } = await setup({ canvas: null });
    expect(link.volumes?.origin).toEqual(WORK.min);
    expect(link.volumes?.canvas).toBeUndefined();
    expect(report).not.toContain("Canvas");
    expect(session.doc!.getState(4, 0, 4)).toBe(STONE);
    const info = (await call("doc_info", {})) as { content: { text: string }[] };
    expect(info.content[0]!.text).toContain("World frame: local (0,0,0) = world (16,60,16), the work volume's minimum corner (no canvas)");
    // Reads outside the mirror stay plain document reads (air), as before.
    const q = await call("query_block", { pos: [-10, 0, -10] });
    expect(texts(q)[0]).toMatch(/air/);
    expect(texts(q).join("\n")).not.toMatch(/world view/);
  });

  it("reads canvas positions outside the mirror through the world view, read-only", async () => {
    const { session, host, call, view } = await setup();
    const before = snapshots(host).length;
    // Inside the brush: the document itself, no read.
    const inBrush = await call("query_block", { pos: local([20, 60, 20]) });
    expect(texts(inBrush)[0]).toMatch(/stone/);
    expect(texts(inBrush).join("\n")).not.toMatch(/world view/);
    expect(snapshots(host).length).toBe(before);

    // Outside: never air; one snapshot of that block, and the result says how it was read.
    const out = await call("query_block", { pos: local([2, 60, 2]) });
    expect(out.isError).toBeFalsy();
    expect(texts(out)[0]).toMatch(/andesite/);
    expect(texts(out).join("\n")).toContain("world: read 1 blocks outside the brush and context through the world view ((2,124,2)–(2,124,2), local): read-only, and as of this call.");
    expect(snapshots(host).slice(before)).toEqual([expect.objectContaining({ boxes: [{ min: [2, 60, 2], max: [2, 60, 2] }] })]);
    expect(view.has([2, 60, 2])).toBe(true);
    // The linked document itself is unchanged: the read went beside it.
    expect(session.doc!.getState(...local([2, 60, 2]))).toBe(AIR);
    expect(session.doc!.journal.headSeq).toBe(0);

    // Read again: served from the view, no new snapshot, marked possibly stale.
    const n = snapshots(host).length;
    const again = await call("query_block", { pos: local([2, 60, 2]) });
    expect(texts(again)[0]).toMatch(/andesite/);
    expect(texts(again).join("\n")).toMatch(/read earlier in this request: read-only, possibly stale/);
    expect(snapshots(host).length).toBe(n);

    // A slice and a region across the brush edge see both sides.
    const slice = await call("view_slice", { axis: "y", at: 124, region: { min: [0, 124, 0], max: [24, 124, 24] } });
    expect(slice.isError).toBeFalsy();
    const grid = texts(slice).join("\n");
    expect(grid).toMatch(/andesite/);
    expect(grid).toMatch(/stone/);
    const region = await call("query_region", { sel: { min: [0, 124, 0], max: [24, 124, 24] } });
    expect(texts(region).join("\n")).toMatch(/andesite/);
    expect(texts(region).join("\n")).toMatch(/stone/);
    const column = await call("query_column", { x: 40, z: 5 });
    expect(texts(column)[0]).toContain("y134 andesite");

    // A render reaching outside the brush gets a "c" id, and raycast finds it.
    const render = await call("render", { views: ["top"], size: 128, region: { min: [0, 124, 0], max: [24, 124, 24] } });
    expect(render.isError).toBeFalsy();
    expect(texts(render)[0]).toMatch(/\bc1\b/);
    expect((await call("raycast", { view: "c1", px: 10, py: 10 })).isError).toBeFalsy();
    expect(texts(await call("render", { views: ["top"], size: 128 }))[0]).toMatch(/\br1\b/);

    // Analyze over a region outside the brush measures what the world holds there.
    const an = await call("analyze", { region: { min: [0, 124, 0], max: [4, 124, 4] } });
    expect(texts(an).join("\n")).toMatch(/andesite/);
  });

  it("widens a selection that reads blocks past the mirror through the view", async () => {
    // A stone run from the brush (x 20) out past the context (x 13) to x 6, on z 20.
    const run: Vec3[] = [];
    for (let x = 6; x <= 19; x++) run.push([x, 60, 20]);
    const { call } = await setup({ stone: run });
    const sel = { connected: { seed: local([20, 60, 20]), within: { min: [0, 100, 0], max: [47, 150, 47] } } };
    const r = await call("query_region", { sel });
    expect(r.isError).toBeFalsy();
    expect(texts(r).join("\n")).toMatch(/15 blocks/);
    expect(texts(r).join("\n")).toMatch(/\(6,124,20\)/);
    const s = await call("select", { sel, name: "run" });
    expect(texts(s).join("\n")).toMatch(/15 blocks/);
  });

  it("never reads air outside the mirror: refused when the world can't be read, or outside the canvas", async () => {
    const { host, call } = await setup();
    const outside = await call("query_block", { pos: [60, 124, 0] });
    expect(outside.isError).toBe(true);
    expect(texts(outside)[0]).toContain("(60,124,0)–(60,124,0) (local) lies outside the canvas, local (0,0,0)–(47,383,47)");
    // The context reaches past nothing here, but a mirror position is always readable.
    expect((await call("query_block", { pos: local([14, 59, 14]) })).isError).toBeFalsy();
    await host.close();
    await new Promise((r) => setTimeout(r, 50));
    const down = await call("query_block", { pos: local([2, 60, 2]) });
    expect(down.isError).toBe(true);
    expect(texts(down)[0]).toMatch(/No game is connected/);
  });

  it("refuses writes outside the brush, and writes inside it at world = local + canvas minimum", async () => {
    const { host, call, session } = await setup();
    const refused = await call("set_blocks", { blocks: [{ pos: local([2, 60, 2]), block: STONE }] });
    expect(refused.isError).toBe(true);
    expect(texts(refused)[0]).toMatch(/outside the work volume/);
    const ok = await call("set_blocks", { blocks: [{ pos: local([21, 61, 21]), block: STONE }] });
    expect(ok.isError).toBeFalsy();
    await link!.settle();
    expect(patches(host)).toHaveLength(1);
    expect(patches(host)[0]!.blocks.map((b) => b.pos)).toEqual([[21, 61, 21]]);
    expect(host.get([21, 61, 21]).state).toBe(STONE);
    // A canvas read document refuses edits too: it is never what an edit addresses.
    expect(session.doc!.getState(...local([21, 61, 21]))).toBe(STONE);
  });

  it("changes the frame only when the canvas is set or cleared, and says so", async () => {
    const { host, link, call, session } = await setup();
    // The player marks a new brush inside the canvas: a relink, but no coordinate moves.
    host.setVolumes({ work: { min: [24, 60, 24], max: [39, 72, 39] } });
    await host.waitFor(() => link.volumes?.work.min[0] === 24);
    expect(link.volumes?.origin).toEqual(O);
    expect(link.toLocal([24, 60, 24])).toEqual([24, 124, 24]);
    // The old brush's block is now outside the mirror: read through the world view at the same coordinates.
    expect(session.doc!.getState(...local([20, 60, 20]))).toBe(AIR);
    expect(texts(await call("query_block", { pos: local([20, 60, 20]) }))[0]).toMatch(/stone/);

    host.setCanvas(null);
    await host.waitFor(() => link.volumes !== undefined && link.volumes.canvas === undefined);
    expect(link.volumes!.origin).toEqual([24, 60, 24]);
    const r1 = await call("doc_info", {});
    expect(texts(r1).join("\n")).toContain("world: The frame changed: the canvas was cleared, so local (0,0,0) is now world (24,60,24) (the work volume's minimum corner; it was world (0,-64,0)).");

    host.setCanvas({ box: { min: [0, 0, 0], max: [47, 0, 47] } });
    await host.waitFor(() => link.volumes?.canvas !== undefined);
    expect(link.volumes!.origin).toEqual(O);
    const r2 = await call("doc_info", {});
    expect(texts(r2).join("\n")).toContain("world: The frame changed: a canvas was set, so local (0,0,0) is now world (0,-64,0) (the canvas's minimum corner; it was world (24,60,24)).");

    // Grown: no relink, the frame and the history stay, even when the minimum corner moves.
    await call("set_blocks", { blocks: [{ pos: local([25, 61, 25]), block: STONE }] });
    const seq = session.doc!.journal.headSeq;
    const doc = session.doc;
    host.setCanvas({ box: { min: [-16, 0, 0], max: [63, 0, 63] } });
    await host.waitFor(() => link.volumes?.canvas?.max[0] === 63);
    expect(link.volumes!.origin).toEqual(O);
    expect(session.doc).toBe(doc);
    expect(session.doc!.journal.headSeq).toBe(seq);
    const grown = texts(await call("doc_info", {})).join("\n");
    expect(grown).toContain("world: the canvas grew to 5×4 chunks, local (-16,0,0)–(63,383,63) = world (-16,-64,0)–(63,319,63); the frame is unchanged (local (0,0,0) stays world (0,-64,0)).");
    expect(grown).toContain("local (0,0,0) = world (0,-64,0), the canvas's minimum corner when it was set");
    expect(grown).not.toContain("The frame changed");
    // A new brush in the grown canvas keeps the frame too.
    host.setVolumes({ work: { min: [-10, 60, 24], max: [5, 72, 39] } });
    await host.waitFor(() => link.volumes?.work.min[0] === -10);
    expect(link.volumes!.origin).toEqual(O);

    // A canvas that doesn't contain the brush (or is in another dimension) doesn't anchor the frame.
    host.setCanvas({ box: { min: [200, 0, 200], max: [210, 0, 210] } });
    await host.waitFor(() => link.volumes !== undefined && link.volumes.canvas === undefined);
    expect(link.volumes!.origin).toEqual([-10, 60, 24]);
  });

  it("names the canvas, the brush and the frame in the request event", () => {
    const v = { link: 1, dimension: "minecraft:overworld", work: WORK, extended: WORK, context: [{ min: [13, 57, 13] as Vec3, max: [34, 75, 34] as Vec3 }], origin: O, canvas: CANVAS };
    expect(handoff(v)).toBe('Work volume 16×13×16, context +3 (scope "base").');
    expect(canvasFacts(v)).toBe(
      "Canvas 3×3 chunks: local (0, 0, 0)–(47, 383, 47) = world (0, -64, 0)–(47, 319, 47), so local (0,0,0) is its minimum corner and stays there when the brush moves. " +
        "Brush (work volume) local (16, 124, 16)–(31, 136, 31). Read anywhere in the canvas (outside the brush and context through the world view: read-only, possibly stale); write only in the brush.",
    );
    expect(canvasFacts({ ...v, canvas: undefined, origin: WORK.min })).toBeUndefined();
  });
});

async function fixtureContext(root: string): Promise<InstanceContext> {
  const registry = fakeRegistry([{ id: "minecraft:andesite", tags: [] }, { id: "minecraft:stone", tags: [] }]);
  const stack = await memStack([["base", "base", { "assets/minecraft/textures/block/andesite.png": solidPng([130, 130, 130]), "assets/minecraft/textures/block/stone.png": solidPng([120, 120, 120]) }]]);
  const palette = new PaletteIndex(await buildPaletteIndexData(stack, registry), registry);
  return { info: { name: "Fixture", mcVersion: "1.21.1", launcher: "generic", root }, stack, registry, palette, plugins: [], sheets: new SheetRenderer(palette, stack), book: new PaletteBook(), warnings: [], timings: {} };
}

function texts(r: Awaited<ReturnType<Client["callTool"]>>): string[] {
  return (r.content as { type: string; text: string }[]).filter((c) => c.type === "text").map((c) => c.text);
}
