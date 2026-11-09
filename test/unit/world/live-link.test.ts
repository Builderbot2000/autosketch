import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { refusalCode, type ObserveEvent } from "../../../src/core/events.js";
import { Mask } from "../../../src/core/mask.js";
import { fromPublic, type Vec3 } from "../../../src/core/region.js";
import type { Document } from "../../../src/document/document.js";
import { fill } from "../../../src/ops/edit.js";
import { buildPaletteIndexData, PaletteIndex } from "../../../src/palette/index.js";
import { PaletteBook } from "../../../src/palette/pick.js";
import { SheetRenderer } from "../../../src/palette/sheet.js";
import type { AutosketchPlugin } from "../../../src/plugins/types.js";
import { runScript } from "../../../src/script/run.js";
import type { InstanceContext } from "../../../src/server/context.js";
import { createServer } from "../../../src/server/server.js";
import { Session } from "../../../src/server/session.js";
import { LiveLink } from "../../../src/world/live-link.js";
import type { PatchMessage, WireBox } from "../../../src/world/protocol/messages.js";
import { parseSnbt } from "../../../src/world/protocol/snbt.js";
import { applyWorldState, autoSyncHook, syncLink } from "../../../src/world/sync.js";
import { FakeHost, type FakeHostOptions } from "../../support/fake-host.js";
import { solidPng } from "../../helpers/fixtures.js";
import { fakeRegistry } from "../../helpers/registry.js";
import { memStack } from "../../helpers/stack.js";
import { vanillaRegistry } from "../../helpers/vanilla.js";

/** The world link against the fake host (13, W2–W4, W8; briefs/world/P, *Done when*). */

const env = { registry: vanillaRegistry() };
const B = (min: Vec3, max: Vec3) => fromPublic({ min, max });
const STONE = "minecraft:stone";
const AIR = "minecraft:air";
const CHEST = "minecraft:chest[facing=north,type=single,waterlogged=false]";
const FURNACE = "minecraft:furnace[facing=north,lit=false]";
const WORK: WireBox = { min: [100, 64, -200], max: [115, 79, -185] }; // 16³, local (0,0,0)–(15,15,15)
const O: Vec3 = [100, 64, -200];
const w = (p: Vec3): Vec3 => [p[0] + O[0], p[1] + O[1], p[2] + O[2]];

const roots: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "autosketch-live-"));
  roots.push(d);
  return d;
};
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

let host: FakeHost | undefined;
let link: LiveLink | undefined;
afterEach(async () => {
  link?.close();
  await host?.close();
  host = link = undefined;
});

async function setup(opts: { work?: WireBox; plugins?: AutosketchPlugin[]; events?: ObserveEvent[]; normalizeNbt?: FakeHostOptions["normalizeNbt"] } = {}) {
  host = await FakeHost.start({ volumes: { work: opts.work ?? WORK }, ...(opts.normalizeNbt ? { normalizeNbt: opts.normalizeNbt } : {}) });
  const session = new Session(tempDir());
  if (opts.events) {
    const seen = opts.events;
    session.events = { enabled: true, emit: (e) => void seen.push(e) };
  }
  link = new LiveLink(session, { ackWaitMs: 2000, backoff: { minMs: 20, maxMs: 50 } });
  link.setSync(syncLink);
  session.world = link;
  session.callHooks.push(autoSyncHook(() => session.world));
  const open = () => session.linkWorld({ instanceDir: host!.instanceDir, plugins: opts.plugins ?? [], palettes: new PaletteBook() });
  return { session, link, host, open };
}

const patches = (h: FakeHost): PatchMessage[] => h.received.filter((m): m is PatchMessage => m.type === "patch");

/** The cache matches the fake world at every position of a world box. */
function expectCacheMatchesWorld(doc: Document, h: FakeHost, box: WireBox): void {
  const diffs: string[] = [];
  for (let y = box.min[1]; y <= box.max[1]; y++)
    for (let z = box.min[2]; z <= box.max[2]; z++)
      for (let x = box.min[0]; x <= box.max[0]; x++) {
        const want = h.get([x, y, z]).state;
        const have = doc.getState(x - O[0], y - O[1], z - O[2]);
        if (want !== have) diffs.push(`(${x},${y},${z}) world ${want} cache ${have}`);
      }
  expect(diffs.slice(0, 5)).toEqual([]);
}

describe("root scope (13, Model, W2)", () => {
  it("links the player's volumes as the base document, re-origined, with the context read-only", async () => {
    const events: ObserveEvent[] = [];
    const { session, open, host } = await setup({ events });
    host.set(w([0, 0, 0]), STONE);
    host.set(w([-2, 0, 0]), "minecraft:oak_planks"); // in the default context (work grown by 3)
    host.set(w([-5, 0, 0]), "minecraft:gold_block"); // outside both volumes
    const { doc, report } = await open();
    expect(session.doc).toBe(doc);
    expect(link!.state).toBe("linked");
    expect(link!.volumes).toMatchObject({ dimension: "minecraft:overworld", work: WORK, extended: WORK, origin: O });
    expect(doc.getState(0, 0, 0)).toBe(STONE);
    expect(doc.getState(-2, 0, 0)).toBe("minecraft:oak_planks");
    expect(doc.getState(-5, 0, 0)).toBe(AIR);
    expect(doc.localBounds()).toEqual(B([-3, -3, -3], [18, 18, 18]));
    expect(doc.context?.has(-2, 0, 0)).toBe(true);
    expect(doc.context?.has(0, 0, 0)).toBe(false);
    expect(report).toContain("work volume 16×16×16 at world (100,64,-200), local (0,0,0)–(15,15,15)");
    expect(doc.journal.headSeq).toBe(0); // linking adds no history
    let err: unknown;
    try {
      fill(doc, env, B([14, 0, 0], [16, 0, 0]), STONE);
    } catch (e) {
      err = e;
    }
    expect(refusalCode(err)).toBe("outside_work_volume");
    expect(patches(host)).toHaveLength(0);
    expect(events.find((e) => e.kind === "world.link" && e.state === "linked")).toMatchObject({ kind: "world.link", state: "linked", dimension: "minecraft:overworld" });
  });

  it("extends a work volume that cuts a door to whole blocks, and declares it before any patch", async () => {
    const { open, host } = await setup();
    host.set(w([5, 15, 5]), "minecraft:oak_door[facing=north,half=lower,hinge=left,open=false,powered=false]");
    host.set(w([5, 16, 5]), "minecraft:oak_door[facing=north,half=upper,hinge=left,open=false,powered=false]");
    const { doc, report } = await open();
    const extended = { min: WORK.min, max: [115, 80, -185] as Vec3 };
    expect(link!.volumes?.extended).toEqual(extended);
    expect(host.extended).toEqual(extended);
    expect(report).toContain("Work volume extended by 1 block");
    fill(doc, env, B([5, 15, 5], [5, 16, 5]), AIR); // the whole door, including the upper half past the box
    await link!.settle();
    const sent = host.received.filter((m) => m.type === "volumes.extend" || m.type === "patch").map((m) => m.type);
    expect(sent).toEqual(["volumes.extend", "patch"]);
    expect(host.patchLog[0]!.ack).toMatchObject({ applied: 2, rejected: [] });
    expect(host.get(w([5, 16, 5])).state).toBe(AIR);
  });

  it("relinks with a fresh journal when the player sets a new work volume, and syncs a context-only change", async () => {
    const events: ObserveEvent[] = [];
    const { open, host, session } = await setup({ events });
    const { doc } = await open();
    fill(doc, env, B([0, 0, 0], [1, 0, 0]), STONE);
    await link!.settle();
    host.set([90, 64, -200], "minecraft:gold_block"); // will be in the added context box
    host.setVolumes({ work: WORK, context: [{ min: [97, 61, -203], max: [118, 82, -182] }, { min: [90, 64, -200], max: [91, 65, -199] }] });
    await host.waitFor(() => link!.volumes?.context.length === 2);
    await link!.settle();
    expect(session.doc).toBe(doc); // same document, same journal
    expect(doc.getState(-10, 0, 0)).toBe("minecraft:gold_block");
    expect(doc.journal.entries.at(-1)!.op).toBe("world_sync");
    expect(patches(host)).toHaveLength(1);
    const moved = { min: [200, 64, -200] as Vec3, max: [215, 79, -185] as Vec3 };
    host.setVolumes({ work: moved });
    await host.waitFor(() => session.doc !== doc && link!.state === "linked" && link!.volumes?.origin[0] === 200);
    expect(session.doc!.journal.headSeq).toBe(0);
    expect(events.some((e) => e.kind === "world.link" && e.state === "relinked")).toBe(true);
  });
});

describe("patches (13, Agent → world, W3)", () => {
  it("sends a fill as one patch whose expected states are its before-states, and the world matches the cache", async () => {
    const { open, host } = await setup();
    host.set(w([1, 0, 0]), "minecraft:dirt");
    const { doc } = await open();
    fill(doc, env, B([0, 0, 0], [2, 0, 2]), STONE);
    await link!.settle();
    const p = patches(host);
    expect(p).toHaveLength(1);
    expect(p[0]!.blocks).toHaveLength(9);
    expect(p[0]!.blocks.find((b) => b.pos.join() === w([1, 0, 0]).join())).toMatchObject({ expected: "minecraft:dirt", state: STONE });
    expect(p[0]!.blocks.filter((b) => b.expected === AIR)).toHaveLength(8);
    expect(p[0]!.link).toBe(host.link);
    expectCacheMatchesWorld(doc, host, { min: w([-1, -1, -1]), max: w([3, 1, 3]) });
  });

  it("keeps a block the player placed, brings it into the cache from the ack, and reports it in the tool result", async () => {
    const { session, host } = await setup();
    const client = await connect(session, host.instanceDir);
    const opened = await client.callTool({ name: "doc_open", arguments: { world: true } });
    expect(texts(opened)[0]).toContain("Linked to the world");
    // The player places a block without the MCP hearing about it (as if the dirty notice were lost).
    host.set(w([1, 0, 1]), "minecraft:oak_planks");
    const r = await client.callTool({ name: "fill", arguments: { box: { min: [0, 0, 0], max: [2, 0, 2] }, pattern: "stone" } });
    expect(texts(r).at(-1)).toBe("world: 8 placed, 1 skipped (hand-edited), 0 rejected");
    expect(host.get(w([1, 0, 1])).state).toBe("minecraft:oak_planks");
    await link!.settle();
    const doc = session.doc!;
    expect(doc.getState(1, 0, 1)).toBe("minecraft:oak_planks");
    expect(doc.journal.entries.map((e) => e.op)).toEqual(["fill", "world_sync"]);
    expectCacheMatchesWorld(doc, host, { min: w([0, 0, 0]), max: w([2, 0, 2]) });
    // A hand edit the mod reports (dirty) is synced before the next call, and never sent back.
    host.playerSet(w([4, 0, 4]), "minecraft:glass");
    await host.waitFor(() => link!.isDirty());
    await client.callTool({ name: "doc_info", arguments: {} });
    expect(doc.getState(4, 0, 4)).toBe("minecraft:glass");
    expect(patches(host)).toHaveLength(1);
  });

  it("sends a restore across five ops as exactly one patch", async () => {
    const { open, host } = await setup();
    const { doc } = await open();
    doc.checkpoint("start");
    for (let i = 0; i < 5; i++) fill(doc, env, B([i, 0, 0], [i, 1, 0]), STONE);
    await link!.settle();
    expect(patches(host)).toHaveLength(5);
    doc.restore("start");
    await link!.settle();
    const p = patches(host);
    expect(p).toHaveLength(6);
    expect(p[5]!.blocks).toHaveLength(10);
    expect(p[5]!.blocks.every((b) => b.expected === STONE && b.state === AIR)).toBe(true);
    expect(host.get(w([4, 1, 0])).state).toBe(AIR);
  });

  it("keeps a chest whose contents the player changed, and takes its NBT from the ack; a ticking furnace isn't a hand edit", async () => {
    const { open, host } = await setup();
    const chest = parseSnbt('{id:"minecraft:chest",Items:[]}');
    const furnace = parseSnbt('{id:"minecraft:furnace",BurnTime:0s,Items:[]}');
    host.set(w([0, 0, 0]), CHEST, chest);
    host.set(w([2, 0, 0]), FURNACE, furnace);
    const { doc } = await open();
    const edited = parseSnbt('{id:"minecraft:chest",Items:[{Slot:0b,id:"minecraft:diamond",count:3}]}');
    host.playerSetNbt(w([0, 0, 0]), edited); // contents only: no dirty notice
    host.tick(w([2, 0, 0]), parseSnbt("{BurnTime:120s}"));
    fill(doc, env, B([0, 0, 0], [2, 0, 0]), STONE);
    await link!.settle();
    const ack = host.patchLog[0]!.ack;
    expect(ack.skipped.map((s) => s.pos)).toEqual([w([0, 0, 0])]);
    expect(host.get(w([0, 0, 0])).state).toBe(CHEST);
    expect(host.get(w([2, 0, 0])).state).toBe(STONE); // the furnace's burn time is volatile
    expect(doc.getState(0, 0, 0)).toBe(CHEST);
    expect(doc.getBlockEntity(0, 0, 0)).toEqual(edited);
  });

  it("takes the game's normalized NBT into the cache without a journal entry", async () => {
    const normalized = parseSnbt('{id:"minecraft:chest",Items:[],components:{}}');
    const { open, host } = await setup({ normalizeNbt: (_p, _s, nbt) => (nbt ? normalized : nbt) });
    const { doc } = await open();
    doc.edit("set", "chest", (tx) => tx.set(0, 0, 0, CHEST, parseSnbt('{id:"minecraft:chest",Items:[]}')));
    await link!.settle();
    expect(host.patchLog.at(-1)!.ack.normalized.map((n) => n.pos)).toEqual([w([0, 0, 0])]);
    expect(doc.getBlockEntity(0, 0, 0)).toEqual(normalized);
    expect(doc.journal.entries.map((e) => e.op)).toEqual(["set"]); // no world_sync entry
  });

  it("sends a script and a scope merge as exactly one patch each, and never a world_sync entry", async () => {
    const { session, open, host } = await setup();
    const { doc } = await open();
    await runScript(doc, env, { source: 'fill(sel.box([0,0,0],[3,0,0]), "stone"); fill(sel.box([0,1,0],[3,1,0]), "dirt");' });
    await link!.settle();
    expect(patches(host)).toHaveLength(1);
    const f = session.scopes.fork("base", { work: Mask.fromBox(B([0, 2, 0], [7, 9, 7])), brief: "a block", env });
    fill(f.scope.doc, env, B([0, 0, 0], [7, 0, 7]), STONE);
    await link!.settle();
    expect(patches(host)).toHaveLength(1); // sandboxes never patch
    session.scopes.merge(f.scope.id, "done", env);
    await link!.settle();
    expect(patches(host)).toHaveLength(2);
    expect(host.get(w([7, 2, 7])).state).toBe(STONE);
    applyWorldState(doc, { blocks: [{ pos: w([9, 9, 9]), state: "minecraft:glass" }] }, { origin: O });
    await link!.settle();
    expect(patches(host)).toHaveLength(2);
  });

  it("reads rejected positions back from the world instead of keeping the cache's guess", async () => {
    const { open, host } = await setup();
    host.knownStates = new Set([AIR, STONE]);
    const { doc } = await open();
    doc.edit("set", "unknown block", (tx) => {
      tx.set(0, 0, 0, "minecraft:not_a_block");
      tx.set(1, 0, 0, STONE);
    });
    await link!.settle();
    expect(host.patchLog[0]!.ack.rejected).toEqual([{ pos: w([0, 0, 0]), reason: "unknown_state" }]);
    expect(doc.getState(0, 0, 0)).toBe(AIR);
    expect(doc.getState(1, 0, 0)).toBe(STONE);
  });
});

describe("history and merges over the link (13, World undo and restore; with silo Q)", () => {
  it("forces the world with undo({overwriteHandEdits}) and sends a forced restore as one forced patch", async () => {
    const { open, host } = await setup();
    const { doc } = await open();
    doc.checkpoint("empty");
    fill(doc, env, B([0, 0, 0], [1, 0, 0]), STONE);
    fill(doc, env, B([0, 1, 0], [1, 1, 0]), STONE);
    await link!.settle();
    host.set(w([0, 1, 0]), "minecraft:glass"); // a hand edit the cache doesn't know about
    doc.undo({ overwriteHandEdits: true });
    await link!.settle();
    expect(patches(host).at(-1)!.force).toBe(true);
    expect(host.get(w([0, 1, 0])).state).toBe(AIR);
    expect(host.patchLog.at(-1)!.ack.overwritten).toBe(1);
    host.set(w([1, 0, 0]), "minecraft:glass");
    const before = patches(host).length;
    doc.restore("empty", { overwriteHandEdits: true });
    await link!.settle();
    expect(patches(host)).toHaveLength(before + 1);
    expect(patches(host).at(-1)).toMatchObject({ force: true });
    expect(host.get(w([1, 0, 0])).state).toBe(AIR);
  });

  it("leaves a world-synced position inside a locked job alone when the merge patch goes out", async () => {
    const { session, open, host } = await setup();
    const { doc } = await open();
    const f = session.scopes.fork("base", { work: Mask.fromBox(B([0, 0, 0], [7, 7, 7])), brief: "a block", env });
    host.playerSet(w([3, 0, 3]), "minecraft:glass");
    await host.waitFor(() => link!.isDirty());
    await link!.syncNow("dirty");
    expect(doc.getState(3, 0, 3)).toBe("minecraft:glass");
    fill(f.scope.doc, env, B([0, 0, 0], [7, 0, 7]), STONE);
    session.scopes.merge(f.scope.id, "done", env);
    await link!.settle();
    expect(host.get(w([3, 0, 3])).state).toBe("minecraft:glass");
    expect(host.get(w([4, 0, 4])).state).toBe(STONE);
    expect(doc.getState(3, 0, 3)).toBe("minecraft:glass"); // the skip came back into the cache
  });
});

describe("connection (13, Lifecycle, W1)", () => {
  it("discards edits made while disconnected and syncs the cache back to the world on reconnect", async () => {
    const { open, host } = await setup();
    const { doc } = await open();
    host.dropConnection();
    await host.waitFor(() => link!.state === "disconnected");
    fill(doc, env, B([0, 0, 0], [1, 0, 0]), STONE);
    expect(doc.getState(0, 0, 0)).toBe(STONE);
    await host.waitFor(() => link!.bridge.connected, 3000);
    await host.waitFor(() => doc.getState(0, 0, 0) === AIR, 3000);
    await link!.settle();
    expect(patches(host)).toHaveLength(0); // nothing replayed
    expect(doc.journal.entries.at(-1)!.op).toBe("world_sync");
  });
});

describe("plugins and events (13, Hashing, W8)", () => {
  it("sends plugin volatile keys in hello and publishes world.patch with ack counts", async () => {
    const events: ObserveEvent[] = [];
    const plugin = { id: "kinetics", namespaces: ["create"], volatileKeys: { "create:shaft": ["Speed"] } } as AutosketchPlugin;
    const { open, host } = await setup({ plugins: [plugin], events });
    const { doc } = await open();
    expect(host.volatile["create:shaft"]).toEqual(["Speed"]);
    expect(host.volatile["minecraft:furnace"]).toBeDefined();
    fill(doc, env, B([0, 0, 0], [0, 0, 0]), STONE);
    await link!.settle();
    expect(events.find((e) => e.kind === "world.patch")).toMatchObject({ kind: "world.patch", blocks: 1, applied: 1, skipped: 0, rejected: 0 });
  });

  it("leaves tool results unchanged while the link is wired in but no document is linked", async () => {
    const plain = new Session(tempDir());
    const wired = new Session(tempDir());
    link = new LiveLink(wired, {});
    link.setSync(syncLink);
    wired.world = link;
    wired.callHooks.push(autoSyncHook(() => wired.world));
    const run = async (s: Session) => {
      const c = await connect(s, "/fixture");
      const out = [];
      for (const [name, args] of [
        ["doc_new", { name: "t", seed: 1 }],
        ["fill", { box: { min: [0, 0, 0], max: [2, 2, 2] }, pattern: "andesite" }],
        ["undo", {}],
        ["history", {}],
      ] as const)
        out.push(await c.callTool({ name, arguments: args }));
      const r = JSON.stringify(out).replaceAll(s.workspace, "<ws>");
      await s.close();
      return r;
    };
    expect(await run(wired)).toBe(await run(plain));
  });
});

// -- server helpers -------------------------------------------------------------------------------

async function fixtureContext(root: string): Promise<InstanceContext> {
  const registry = fakeRegistry([{ id: "minecraft:andesite", tags: ["c:stones"] }, { id: "minecraft:stone", tags: [] }]);
  const stack = await memStack([["base", "base", { "assets/minecraft/textures/block/andesite.png": solidPng([130, 130, 130]) }]]);
  const palette = new PaletteIndex(await buildPaletteIndexData(stack, registry), registry);
  return { info: { name: "Fixture", mcVersion: "1.21.1", launcher: "generic", root }, stack, registry, palette, plugins: [], sheets: new SheetRenderer(palette, stack), book: new PaletteBook(), warnings: [], timings: {} };
}

async function connect(session: Session, root: string) {
  const server = createServer(fixtureContext(root), { session });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

function texts(r: Awaited<ReturnType<Client["callTool"]>>): string[] {
  return (r.content as { type: string; text: string }[]).filter((c) => c.type === "text").map((c) => c.text);
}
