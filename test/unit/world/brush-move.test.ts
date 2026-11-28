import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { PublicBox, Vec3 } from "../../../src/core/region.js";
import { buildPaletteIndexData, PaletteIndex } from "../../../src/palette/index.js";
import { PaletteBook } from "../../../src/palette/pick.js";
import { SheetRenderer } from "../../../src/palette/sheet.js";
import type { InstanceContext } from "../../../src/server/context.js";
import { createServer } from "../../../src/server/server.js";
import { Session } from "../../../src/server/session.js";
import { CanvasReads } from "../../../src/world/canvas.js";
import { LiveLink } from "../../../src/world/live-link.js";
import { RequestModeRule } from "../../../src/world/modes.js";
import { InGameRequests } from "../../../src/world/prompt.js";
import type { PatchMessage, PlayerRef, SnapshotRequest, WireBox } from "../../../src/world/protocol/messages.js";
import { autoSyncHook, syncLink } from "../../../src/world/sync.js";
import { WorldView } from "../../../src/world/view.js";
import { FakeHost } from "../../support/fake-host.js";
import { solidPng } from "../../helpers/fixtures.js";
import { fakeRegistry } from "../../helpers/registry.js";
import { memStack } from "../../helpers/stack.js";

/**
 * Brush moves (19, *Placing and moving the brush*; step F2) against the fake host. Canvas: chunks
 * 0..2 on both axes = world (0,-64,0)–(47,319,47), so local = world − (0,-64,0). Brush A (the
 * player's work volume at the start): world (16,60,16)–(31,72,31). Brush B: world (36,60,4)–(43,72,11),
 * 8×13×8. Brush C: world (4,60,30)–(11,72,37). Each with the default context +3, all inside the canvas.
 * P = world (20,61,20) lies in A only.
 */

const STONE = "minecraft:stone";
const ANDESITE = "minecraft:andesite";
const AIR = "minecraft:air";
const HOST: PlayerRef = { name: "Dev", uuid: "00000000-0000-4000-8000-000000000001" };
const A: WireBox = { min: [16, 60, 16], max: [31, 72, 31] };
const B: WireBox = { min: [36, 60, 4], max: [43, 72, 11] };
const C: WireBox = { min: [4, 60, 30], max: [11, 72, 37] };
const O: Vec3 = [0, -64, 0];
const P: Vec3 = [20, 61, 20];
const local = (p: Vec3): Vec3 => [p[0] - O[0], p[1] - O[1], p[2] - O[2]];
const localBox = (b: WireBox): PublicBox => ({ min: local(b.min), max: local(b.max) });

const roots: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "autosketch-brush-"));
  roots.push(d);
  return d;
};
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

let host: FakeHost | undefined;
let link: LiveLink | undefined;
let view: WorldView | undefined;
let inGame: InGameRequests | undefined;
afterEach(async () => {
  inGame?.close();
  view?.close();
  link?.close();
  await host?.close();
  host = link = view = inGame = undefined;
});

async function setup(opts: { ackWaitMs?: number } = {}) {
  host = await FakeHost.start({ volumes: { work: A }, canvas: { box: { min: [0, 0, 0], max: [47, 0, 47] } } });
  host.set([2, 60, 2], ANDESITE);
  const session = new Session(tempDir());
  link = new LiveLink(session, { ackWaitMs: opts.ackWaitMs ?? 2000, backoff: { minMs: 20, maxMs: 50 } });
  link.setSync(syncLink);
  session.world = link;
  session.callHooks.push(autoSyncHook(() => session.world));
  view = new WorldView({ bridge: link.bridge, request: () => undefined, dimension: () => link!.volumes?.dimension });
  session.worldView = view;
  const l = link, v = view;
  session.canvasReads = new CanvasReads({ frame: () => l.canvasFrame(), view: () => v, note: (line) => l.addNote(line) });
  inGame = new InGameRequests(link, { promptPlayers: [], idleMs: 60_000, activityMs: 0, subscribe: (fn) => session.subscribe(fn), notify: async () => {}, listening: () => true, touch: () => session.touch() });
  session.inGame = inGame;
  session.callHooks.push(inGame.modeRule);
  const server = createServer(fixtureContext(host.instanceDir), { session });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  await session.linkWorld({ instanceDir: host.instanceDir, plugins: [], palettes: new PaletteBook() });
  const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  const move = async (w: WireBox) => {
    const r = await call("world_volumes", { work: localBox(w) });
    expect(r.isError, texts(r).join("\n")).toBeFalsy();
    expect(link!.volumes?.work).toEqual(w);
    return texts(r).join("\n");
  };
  return { session, host, link, call, move };
}

const patches = (h: FakeHost) => h.received.filter((m): m is PatchMessage => m.type === "patch");
const snapshots = (h: FakeHost) => h.received.filter((m): m is SnapshotRequest => m.type === "snapshot");

describe("brush moves (19, F2)", () => {
  it("moves the brush three times with world_volumes without changing a coordinate", async () => {
    const { session, host, link, call, move } = await setup();
    await call("set_blocks", { blocks: [{ pos: local(P), block: ANDESITE }] });
    expect(host.get(P).state).toBe(ANDESITE);
    await call("select", { sel: { min: local([18, 60, 18]), max: local([22, 64, 22]) }, name: "spot" });
    const doc = session.doc!;
    const head = doc.journal.headSeq;

    const toB = await move(B);
    expect(toB).toContain("the brush moves inside the canvas, and local (0,0,0) stays where it is");
    expect(toB).toMatch(/The brush moved from local \(16,124,16\)–\(31,136,31\) to local \(36,124,4\)–\(43,136,11\) \(world \(36,60,4\)–\(43,72,11\)\), context 1 box, local \(33,121,1\)–\(46,139,14\); [\d,]+ blocks snapshotted, [\d,]+ dropped from the document \(read through the world view now\), in \d+ ms\. Coordinates, the history, saved selections and cameras are unchanged \(local \(0,0,0\) stays world \(0,-64,0\)\)\./);
    // Same document, same journal, same frame; the old brush is dropped from the document and read through the view.
    expect(session.doc).toBe(doc);
    expect(doc.journal.headSeq).toBe(head);
    expect(link.volumes!.origin).toEqual(O);
    expect(link.toLocal(P)).toEqual(local(P));
    expect(doc.getState(...local(P))).toBe(AIR);
    expect(texts(await call("query_block", { pos: local(P) }))[0]).toMatch(/andesite/);
    expect(doc.localBounds()).toEqual({ min: [33, 121, 1], max: [47, 140, 15] });
    expect(session.scopes.root!.work.bbox()).toEqual({ min: [36, 124, 4], max: [44, 137, 12] });

    await move(C);
    expect(link.volumes!.origin).toEqual(O);
    expect(doc.getState(...local(P))).toBe(AIR);

    const back = await move(A);
    expect(back).toContain("The brush moved from local (4,124,30)–(11,136,37) to local (16,124,16)–(31,136,31)");
    expect(back).not.toContain("hand edits");
    expect(session.doc).toBe(doc);
    expect(doc.journal.headSeq).toBe(head); // nothing changed in the world: no sync entry
    expect(doc.getState(...local(P))).toBe(ANDESITE);
    expect(link.toWorld(local(P))).toEqual(P);
    expect(doc.selections.has("spot")).toBe(true);

    // Patches after the moves carry the mod's current link and land at world = local + canvas minimum.
    await call("set_blocks", { blocks: [{ pos: local([21, 61, 20]), block: STONE }] });
    const last = host.patchLog[host.patchLog.length - 1]!;
    expect(last.patch.link).toBe(link.volumes!.link);
    expect(last.ack).toMatchObject({ applied: 1, rejected: [] });
    expect(host.get([21, 61, 20]).state).toBe(STONE);
  });

  it("follows the player's brush move inside the canvas the same way", async () => {
    const { session, host, link, call } = await setup();
    const doc = session.doc!;
    await call("set_blocks", { blocks: [{ pos: local(P), block: ANDESITE }] });
    const head = doc.journal.headSeq;
    host.setVolumes({ work: B });
    await host.waitFor(() => link.volumes?.work.min[0] === 36);
    expect(session.doc).toBe(doc);
    expect(doc.journal.headSeq).toBe(head);
    expect(link.volumes!.origin).toEqual(O);
    expect(texts(await call("doc_info", {})).join("\n")).toContain("world: The brush moved from local (16,124,16)–(31,136,31) to local (36,124,4)–(43,136,11)");
  });

  it("waits for the brush's patches in flight before moving", async () => {
    const { session, host, link, call, move } = await setup({ ackWaitMs: 20 });
    let release!: () => void;
    host.beforePatch = () => new Promise<void>((r) => (release = r));
    await call("set_blocks", { blocks: [{ pos: local(P), block: ANDESITE }] });
    expect(host.patchLog).toHaveLength(0); // still held: the call returned without the ack

    // An agent move: volumes.set goes behind the held patch, which lands with the old link.
    const moving = move(B);
    await new Promise((r) => setTimeout(r, 50));
    expect(link.volumes!.work).toEqual(A);
    host.beforePatch = undefined;
    release();
    const text = await moving;
    expect(host.patchLog[0]!.ack).toMatchObject({ applied: 1, rejected: [] });
    expect(host.get(P).state).toBe(ANDESITE);
    expect(text).toContain("The brush moved");

    // A player move while a patch is held: the link waits for its ack (and the re-read it brings) before snapshotting.
    await move(A);
    host.beforePatch = () => new Promise<void>((r) => (release = r));
    await call("set_blocks", { blocks: [{ pos: local([22, 61, 22]), block: STONE }] });
    const before = snapshots(host).length;
    host.setVolumes({ work: C });
    await new Promise((r) => setTimeout(r, 50));
    expect(link.volumes!.work).toEqual(A); // not moved while the patch is unacked
    expect(snapshots(host).length).toBe(before);
    host.beforePatch = undefined;
    release();
    await host.waitFor(() => link.volumes?.work.min[0] === 4);
    const info = texts(await call("doc_info", {})).join("\n");
    expect(info).toMatch(/The brush moved from local \(16,124,16\)–\(31,136,31\) to local \(4,124,30\)–\(11,136,37\).* after 1 patch in flight were acked/);
    // The player moved first, so the mod refused the held patch as stale; the cache follows the world.
    expect(host.patchLog[host.patchLog.length - 1]!.ack.rejected).toEqual([{ pos: [22, 61, 22], reason: "stale_link" }]);
    expect(host.get([22, 61, 22]).state).toBe(AIR);
    expect(session.doc!.getState(...local([22, 61, 22]))).toBe(AIR);
    expect(patches(host).every((p) => p.link <= link.volumes!.link)).toBe(true);
  });

  it("refuses undo and redo of an entry outside the brush, naming where it wrote", async () => {
    const { session, host, call, move } = await setup();
    await call("set_blocks", { blocks: [{ pos: local(P), block: ANDESITE }] });
    await move(B);
    const sent = patches(host).length;
    const head = session.doc!.journal.headSeq;
    const r = await call("undo", {});
    expect(r.isError).toBe(true);
    const t = texts(r).join("\n");
    expect(t).toContain("this entry wrote at local (20,125,20)–(20,125,20) (world (20,61,20)–(20,61,20)), outside the brush, local (36,124,4)–(43,136,11)");
    expect(t).toContain("Move the brush there first (world_volumes({work: {min: [20,125,20], max: [20,125,20]}}) or larger, inside the canvas)");
    expect(session.doc!.journal.headSeq).toBe(head);
    expect(patches(host)).toHaveLength(sent);
    expect(host.get(P).state).toBe(ANDESITE);

    // Back over the entry: undo goes through, as one patch.
    await move(A);
    const u = await call("undo", {});
    expect(u.isError, texts(u).join("\n")).toBeFalsy();
    expect(host.get(P).state).toBe(AIR);
    // Redo while away is refused the same way.
    await move(C);
    const rd = await call("redo", {});
    expect(rd.isError).toBe(true);
    expect(texts(rd).join("\n")).toContain("redo of #");
    expect(host.get(P).state).toBe(AIR);
  });

  it("after moving back, a hand edit made while away stops undo at the sync barrier", async () => {
    const { session, host, call, move } = await setup();
    await call("set_blocks", { blocks: [{ pos: local(P), block: ANDESITE }] });
    await move(B);
    host.playerSet(P, STONE); // outside the volumes now: no dirty notice reaches the MCP
    const head = session.doc!.journal.headSeq;
    const back = await move(A);
    expect(back).toContain("1 block your history wrote there changed in the world since (hand edits): synced in as one world_sync entry, so undo stops there.");
    const doc = session.doc!;
    expect(doc.journal.headSeq).toBeGreaterThan(head);
    expect(doc.getState(...local(P))).toBe(STONE);
    const sent = patches(host).length;
    const u = await call("undo", {});
    expect(u.isError).toBe(true);
    expect(texts(u).join("\n")).toMatch(/sync_barrier|step past #\d+ world sync: brush moved/);
    expect(patches(host)).toHaveLength(sent);
    expect(host.get(P).state).toBe(STONE);
  });

  it("allows a brush move inside the canvas in every request mode, and nothing more", async () => {
    const { host, call, link } = await setup();
    expect(await host.playerAsk(HOST, "look around", {}, { mode: "ask" })).toMatchObject({ delivered: true });
    const r = await call("world_volumes", { work: localBox(B) });
    expect(r.isError, texts(r).join("\n")).toBeFalsy();
    expect(link.volumes!.work).toEqual(B);
    // Outside the canvas: the mode rule as before.
    const out = await call("world_volumes", { work: localBox({ min: [60, 60, 60], max: [70, 70, 70] }) });
    expect(out.isError).toBe(true);
    expect(texts(out).join("\n")).toContain("can't change the volumes");
    expect(texts(out).join("\n")).toContain("Moving the brush inside the canvas is allowed in every mode; this work volume isn't inside it.");
    // A confirmed shape is no brush move either.
    const from = await call("world_volumes", { from: "candidate" });
    expect(from.isError).toBe(true);
    expect(texts(from).join("\n")).toContain("can't change the volumes");
    // Edits stay refused in ask mode.
    const e = await call("set_blocks", { blocks: [{ pos: local([38, 61, 6]), block: STONE }] });
    expect(e.isError).toBe(true);
    expect(link.volumes!.work).toEqual(B);
  });

  it("the mode rule lets volume tools through only with a canvas", () => {
    const req = { id: 1, player: HOST, mode: "plan" as const };
    let canvas = false;
    const rule = new RequestModeRule(() => req, () => undefined, () => canvas);
    expect(() => rule.before({ tool: "world_volumes" })).toThrow(/can't change the volumes/);
    canvas = true;
    expect(() => rule.before({ tool: "world_volumes" })).not.toThrow();
    expect(() => rule.checkVolumes("world_volumes", true)).not.toThrow();
    expect(() => rule.checkVolumes("world_volumes", false)).toThrow(/isn't inside it/);
  });

  it("measures the fork ratio against the brush", async () => {
    const { call, move, session } = await setup();
    // In brush A (16×13×16 = 3,328 blocks) a fork of 8×8×8 = 512 blocks is under half.
    const inA = await call("scope_fork", { work: { min: local([16, 60, 16]), max: local([23, 67, 23]) }, brief: "a corner" });
    expect(inA.isError, texts(inA).join("\n")).toBeFalsy();
    const id = session.scopes.list()[0]!.id;
    // The brush can't move while a job is open in it.
    const blocked = await call("world_volumes", { work: localBox(B) });
    expect(blocked.isError).toBe(true);
    expect(texts(blocked).join("\n")).toContain("1 scoped job is open in the brush, so it can't move");
    await call("scope_abandon", { scope: id });
    // In brush B (8×13×8 = 832) the same size is over half of the brush.
    await move(B);
    const inB = await call("scope_fork", { work: { min: local([36, 60, 4]), max: local([43, 67, 11]) }, brief: "a corner" });
    expect(inB.isError).toBe(true);
    expect(texts(inB).join("\n")).toContain("over 50% of the brush (the work volume on the canvas) (832)");
    const outside = await call("scope_fork", { work: { min: local([16, 60, 16]), max: local([23, 67, 23]) }, brief: "a corner" });
    expect(texts(outside).join("\n")).toContain("A child's work volume must lie inside the brush (the work volume on the canvas)");
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
