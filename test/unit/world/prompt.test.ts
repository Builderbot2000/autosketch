import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Vec3 } from "../../../src/core/region.js";
import { getCamera } from "../../../src/document/cameras.js";
import { resolveSelection } from "../../../src/ops/selection.js";
import { buildPaletteIndexData, PaletteIndex } from "../../../src/palette/index.js";
import { PaletteBook } from "../../../src/palette/pick.js";
import { SheetRenderer } from "../../../src/palette/sheet.js";
import type { InstanceContext } from "../../../src/server/context.js";
import { createServer } from "../../../src/server/server.js";
import { Session } from "../../../src/server/session.js";
import { LiveLink } from "../../../src/world/live-link.js";
import { CHANNEL_INSTRUCTIONS, CHANNEL_METHOD, handoff, InGameRequests, promptAllowed } from "../../../src/world/prompt.js";
import type { ChatMessage, PlayerRef, WireBox } from "../../../src/world/protocol/messages.js";
import { autoSyncHook, syncLink } from "../../../src/world/sync.js";
import { FakeHost } from "../../support/fake-host.js";
import { solidPng } from "../../helpers/fixtures.js";
import { fakeRegistry } from "../../helpers/registry.js";
import { memStack } from "../../helpers/stack.js";

/** In-game requests against the fake host (13, *Prompting from the game*, W11; briefs/world/S, *Done when*). */

const WORK: WireBox = { min: [100, 64, -200], max: [115, 79, -185] }; // 16³, local (0,0,0)–(15,15,15)
const O: Vec3 = [100, 64, -200];
const w = (p: Vec3): Vec3 => [p[0] + O[0], p[1] + O[1], p[2] + O[2]];
const HOST: PlayerRef = { name: "Dev", uuid: "00000000-0000-4000-8000-000000000001" };
const KEV: PlayerRef = { name: "Kev", uuid: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" };

const roots: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "autosketch-prompt-"));
  roots.push(d);
  return d;
};
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

let host: FakeHost | undefined;
let link: LiveLink | undefined;
let inGame: InGameRequests | undefined;
afterEach(async () => {
  inGame?.close();
  link?.close();
  await host?.close();
  host = link = inGame = undefined;
});

const ChannelNote = z.object({ method: z.literal(CHANNEL_METHOD), params: z.object({ content: z.string(), meta: z.record(z.string()) }) });

async function setup(opts: { promptPlayers?: string[]; singleplayer?: boolean; activityMs?: number; idleMs?: number; context?: WireBox[] } = {}) {
  host = await FakeHost.start({ volumes: { work: WORK, ...(opts.context ? { context: opts.context } : {}) }, ...(opts.singleplayer === false ? { singleplayer: false, host: null } : {}) });
  const session = new Session(tempDir());
  link = new LiveLink(session, { ackWaitMs: 2000, backoff: { minMs: 20, maxMs: 50 } });
  link.setSync(syncLink);
  session.world = link;
  session.callHooks.push(autoSyncHook(() => session.world));
  const server = createServer(fixtureContext(host.instanceDir), { session, channel: { instructions: CHANNEL_INSTRUCTIONS } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  const events: { content: string; meta: Record<string, string> }[] = [];
  client.setNotificationHandler(ChannelNote, (n) => void events.push(n.params));
  await Promise.all([server.connect(a), client.connect(b)]);
  inGame = new InGameRequests(link, {
    promptPlayers: opts.promptPlayers ?? [],
    idleMs: opts.idleMs ?? 60_000,
    activityMs: opts.activityMs ?? 0,
    subscribe: (fn) => session.subscribe(fn),
    notify: (content, meta) => server.server.notification({ method: CHANNEL_METHOD, params: { content, meta } } as never),
    listening: () => server.server.getClientCapabilities() !== undefined,
    touch: () => session.touch(),
  });
  session.inGame = inGame;
  const opened = await client.callTool({ name: "doc_open", arguments: { world: true } });
  expect(texts(opened)[0]).toContain("Linked to the world");
  return { session, client, host, events, server };
}

const chats = (h: FakeHost, kind?: ChatMessage["kind"]) => h.chats.filter((c) => !kind || c.kind === kind);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("allowlist (13, Allowed players)", () => {
  const sp = { type: "hello", protocol: 1, mod: { version: "1" }, game: { version: "1.21.1", dataVersion: 3955, loader: "neoforge", loaderVersion: "21.1.249" }, singleplayer: true, host: HOST } as const;
  it("allows the singleplayer host and listed players by UUID or name (any case), nobody else", () => {
    expect(promptAllowed(HOST, [], sp)).toBe(true);
    expect(promptAllowed(KEV, [], sp)).toBe(false);
    expect(promptAllowed(KEV, ["kev"], sp)).toBe(true);
    expect(promptAllowed(KEV, [KEV.uuid.toUpperCase()], sp)).toBe(true);
    expect(promptAllowed(KEV, ["Kevin"], sp)).toBe(false);
    const dedicated = { ...sp, singleplayer: false, host: null };
    expect(promptAllowed(HOST, [], dedicated)).toBe(false);
    expect(promptAllowed(KEV, [], dedicated)).toBe(false);
    expect(promptAllowed(KEV, ["Kev"], dedicated)).toBe(true);
    expect(promptAllowed(HOST, [], undefined)).toBe(false);
  });
});

describe("handoff facts", () => {
  it("names the default context growth and reference boxes, and a whole-block extension", () => {
    const v = { link: 1, dimension: "minecraft:overworld", work: WORK, extended: WORK, origin: O, context: [{ min: [97, 61, -203], max: [118, 82, -182] }] } as const;
    expect(handoff({ ...v, context: [...v.context] })).toBe('Work volume 16×16×16, context +3 (scope "base").');
    expect(handoff({ ...v, context: [...v.context, { min: [0, 0, 0], max: [4, 4, 4] }] })).toBe('Work volume 16×16×16, context +3 and 1 reference box (scope "base").');
    expect(handoff({ ...v, extended: { min: [100, 64, -200], max: [115, 80, -185] }, context: [{ min: [0, 0, 0], max: [4, 4, 4] }] })).toBe('Work volume 16×17×16 (your 16×16×16 extended to whole blocks), context 1 reference box (scope "base").');
  });
});

describe("delivery (W11)", () => {
  it("delivers an allowed request as one channel event with the fixed text, saving focus, target and the player camera", async () => {
    const { session, host, events } = await setup();
    host.set(w([3, 2, 4]), "minecraft:oak_planks");
    const r = await host.playerAsk(HOST, "put a balcony here", {
      position: [w([10, 5, 8])[0] + 0.3, O[1] + 5, w([10, 5, 8])[2] + 0.7],
      eye: [O[0] + 10.3, O[1] + 6.62, O[2] + 8.7],
      yaw: 180,
      pitch: 30,
      facing: "north",
      target: { pos: w([3, 2, 4]), state: "minecraft:oak_planks", face: "south" },
      focus: { min: w([2, 0, 1]), max: w([6, 2, 2]) },
    });
    expect(r).toEqual({ type: "prompt.result", id: 1, delivered: true });
    await host.waitFor(() => events.length === 1);
    expect(events[0]!.meta).toEqual({ request: "1", player: "Dev" });
    expect(events[0]!.content).toBe(
      'In-game request from Dev: "put a balcony here". Work volume 16×16×16, context +3 (scope "base"). ' +
        'Looking at minecraft:oak_planks (south face), saved as "target". Focus box 5×3×2, saved as "focus". ' +
        'Standing at (10, 5, 8) facing north; your view is saved as camera "player". ' +
        "Answer the player with world_reply (request 1); pass done: true when finished.",
    );
    const doc = session.doc!;
    const sel = (name: string) => [...resolveSelection(name, { doc } as never).mask.positions()].map((p) => p.join(","));
    expect(sel("target")).toEqual(["3,2,4"]);
    expect(sel("focus")).toHaveLength(5 * 3 * 2);
    expect(sel("focus")).toContain("2,0,1");
    expect(sel("focus")).toContain("6,2,2");
    const cam = getCamera(doc, "player")!;
    expect(cam.fov).toBe(70);
    expect(cam.eye.map((c) => +c.toFixed(6))).toEqual([9.8, 6.12, 8.2]);
    // Yaw 180 faces north (−Z), pitch 30 looks down.
    const d = cam.target.map((c, i) => c - cam.eye[i]!);
    expect(d[0]).toBeCloseTo(0, 6);
    expect(d[1]).toBeCloseTo(-16 * Math.sin(Math.PI / 6), 6);
    expect(d[2]).toBeCloseTo(-16 * Math.cos(Math.PI / 6), 6);
  });

  it("marks a target in the context volume read-only, reports one outside both volumes without saving it, and drops stale handles", async () => {
    const { session, host, events } = await setup();
    await host.playerAsk(HOST, "match that", { target: { pos: w([-2, 0, 0]), state: "minecraft:stone", face: "east" }, focus: { min: w([14, 0, 0]), max: w([17, 1, 1]) } });
    await host.waitFor(() => events.length === 1);
    expect(events[0]!.content).toContain('Looking at minecraft:stone (east face), saved as "target" (in the context volume, read-only).');
    expect(events[0]!.content).toContain('Focus box 4×2×2, saved as "focus" (partly in the context volume, read-only there).');
    await host.playerAsk(HOST, "and that", { target: { pos: w([-10, 0, 0]), state: "minecraft:stone", face: "east" } });
    await host.waitFor(() => events.length === 2);
    expect(events[1]!.content).toContain(`Looking at minecraft:stone (east face) at world (90, 64, -200), outside both volumes, so not saved.`);
    expect(events[1]!.content).not.toContain("Focus box");
    expect(session.doc!.selections.has("target")).toBe(false);
    expect(session.doc!.selections.has("focus")).toBe(false);
    await host.playerAsk(HOST, "from the nether", { dimension: "minecraft:the_nether" });
    await host.waitFor(() => events.length === 3);
    expect(events[2]!.content).toContain("Not looking at a block within reach.");
    expect(events[2]!.content).toContain("Standing in minecraft:the_nether, not the linked minecraft:overworld, so the view is not saved.");
    expect(getCamera(session.doc!, "player")).toBeUndefined();
  });

  it("refuses a player not on the list with not_allowed and pushes nothing; the list admits them on a dedicated server", async () => {
    const { host, events } = await setup({ singleplayer: false, promptPlayers: ["Kev"] });
    expect(await host.playerAsk(HOST, "let me in")).toEqual({ type: "prompt.result", id: 1, delivered: false, reason: "not_allowed" });
    expect(await host.playerAsk({ name: "Mallory", uuid: "11111111-1111-4111-8111-111111111111" }, "rm -rf")).toMatchObject({ delivered: false, reason: "not_allowed" });
    await sleep(30);
    expect(events).toHaveLength(0);
    expect(await host.playerAsk(KEV, "hello")).toMatchObject({ delivered: true });
    await host.waitFor(() => events.length === 1);
  });

  it("refuses no_link while no document is linked", async () => {
    const { host, events, session } = await setup();
    host.setVolumes(null); // the player clears the work volume: unlinks
    await host.waitFor(() => link!.state !== "linked");
    expect(await host.playerAsk(HOST, "hi")).toMatchObject({ delivered: false, reason: "no_link" });
    expect(events).toHaveLength(0);
    expect(session.doc?.selections.has("target") ?? false).toBe(false);
  });

  it("refuses no_listener when no agent session can receive the event", async () => {
    const { host, events } = await setup();
    inGame!.close();
    inGame = new InGameRequests(link!, { promptPlayers: [], idleMs: 1000, activityMs: 0, subscribe: () => () => {}, notify: async () => {}, listening: () => false });
    expect(await host.playerAsk(HOST, "anyone?")).toMatchObject({ delivered: false, reason: "no_listener" });
    expect(events).toHaveLength(0);
  });
});

describe("streams back (W11)", () => {
  it("sends the following tool calls as coalesced activity, and a world_reply with done as reply, closing the stream", async () => {
    const { client, host } = await setup({ activityMs: 5000 });
    await host.playerAsk(HOST, "build a wall");
    for (let i = 0; i < 3; i++) await client.callTool({ name: "fill", arguments: { box: { min: [i, 0, 0], max: [i, 1, 0] }, pattern: "stone" } });
    await client.callTool({ name: "fill", arguments: { box: { min: [0, 0, 0], max: [0, 0, 0] }, pattern: "no_such_block_xyz" } });
    const r = await client.callTool({ name: "world_reply", arguments: { lines: ["Built a 3-block wall.", "Anything else?"], done: true } });
    expect(texts(r)[0]).toBe("ok · world_reply · 2 lines to Dev (request 1) · request closed");
    await host.waitFor(() => chats(host, "reply").length === 1);
    // The first call's line goes out at once; the rest wait out the interval, and the reply flushes them first.
    const activity = chats(host, "activity");
    expect(activity.map((c) => c.lines)).toEqual([["fill: 2 blocks, world: 2 placed"], ["fill ×2: 4 blocks, world: 4 placed", "fill: failed"]]);
    expect(activity.every((c) => c.request === 1 && c.player === HOST.uuid)).toBe(true);
    const reply = chats(host, "reply");
    expect(reply).toEqual([{ type: "chat", request: 1, player: HOST.uuid, kind: "reply", lines: ["Built a 3-block wall.", "Anything else?"] }]);
    expect(host.chats.at(-1)!.kind).toBe("reply"); // activity flushed before the reply
    // Closed: later activity is for players with log "all".
    await client.callTool({ name: "fill", arguments: { box: { min: [5, 0, 0], max: [5, 0, 0] }, pattern: "stone" } });
    inGame!.stream.flush();
    await host.waitFor(() => chats(host).length > activity.length + 1);
    expect(host.chats.at(-1)).toMatchObject({ kind: "activity", request: null, player: null, lines: ["fill: 1 block, world: 1 placed"] });
  });

  it("shows a script making many edits as one line", async () => {
    const { client, host } = await setup({ activityMs: 0 });
    await host.playerAsk(HOST, "lots");
    const source = 'for (let x = 0; x < 10; x++) for (let z = 0; z < 10; z++) fill(sel.box([x, 0, z], [x, 0, z]), "stone");';
    const r = await client.callTool({ name: "run_script", arguments: { source } });
    expect(r.isError).toBeFalsy();
    await host.waitFor(() => chats(host, "activity").length >= 1);
    expect(chats(host, "activity").map((c) => c.lines)).toEqual([["run_script: 100 blocks, world: 100 placed"]]);
  });

  it("closes a request stream after the idle time", async () => {
    const { client, host } = await setup({ idleMs: 60 });
    await host.playerAsk(HOST, "hi");
    expect(inGame!.current?.id).toBe(1);
    await sleep(120);
    expect(inGame!.current).toBeUndefined();
    const r = await client.callTool({ name: "world_reply", arguments: { lines: ["late answer"], request: 1 } });
    expect(texts(r)[0]).toBe("ok · world_reply · 1 line to Dev (request 1, already closed)");
    await host.waitFor(() => chats(host, "reply").length === 1);
    expect(chats(host, "reply").at(-1)).toMatchObject({ request: 1, player: HOST.uuid, lines: ["late answer"] });
  });

  it("world_reply fails clearly without a game", async () => {
    const session = new Session(tempDir());
    const server = createServer(fixtureContext("/fixture"), { session });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const r = await client.callTool({ name: "world_reply", arguments: { lines: ["hi"] } });
    expect(r.isError).toBe(true);
    expect(texts(r)[0]).toContain("No game is connected");
  });
});

describe("no change without requests", () => {
  it("leaves tool results unchanged with in-game requests wired in and no document linked", async () => {
    const run = async (wire: boolean) => {
      const s = new Session(tempDir());
      let l: LiveLink | undefined, g: InGameRequests | undefined;
      if (wire) {
        l = new LiveLink(s, {});
        l.setSync(syncLink);
        s.world = l;
        s.callHooks.push(autoSyncHook(() => s.world));
        g = new InGameRequests(l, { promptPlayers: [], idleMs: 1000, activityMs: 0, subscribe: (fn) => s.subscribe(fn), notify: async () => {}, listening: () => true });
        s.inGame = g;
      }
      const server = createServer(fixtureContext("/fixture"), { session: s, ...(wire ? { channel: { instructions: CHANNEL_INSTRUCTIONS } } : {}) });
      const [a, b] = InMemoryTransport.createLinkedPair();
      const c = new Client({ name: "test", version: "0" });
      await Promise.all([server.connect(a), c.connect(b)]);
      const out = [];
      for (const [name, args] of [
        ["doc_new", { name: "t", seed: 1 }],
        ["fill", { box: { min: [0, 0, 0], max: [2, 2, 2] }, pattern: "andesite" }],
        ["undo", {}],
        ["history", {}],
      ] as const)
        out.push(await c.callTool({ name, arguments: args }));
      const r = JSON.stringify(out).replaceAll(s.workspace, "<ws>");
      g?.close();
      l?.close();
      await s.close();
      return r;
    };
    expect(await run(true)).toBe(await run(false));
  });
});

describe("channel declaration", () => {
  it("declares claude/channel and appends the channel instructions only when asked", async () => {
    const caps = async (channel: boolean) => {
      const server = createServer(fixtureContext("/fixture"), { session: new Session(tempDir()), ...(channel ? { channel: { instructions: CHANNEL_INSTRUCTIONS } } : {}) });
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test", version: "0" });
      await Promise.all([server.connect(a), client.connect(b)]);
      return { caps: client.getServerCapabilities(), instructions: client.getInstructions() ?? "" };
    };
    const on = await caps(true), off = await caps(false);
    expect(on.caps?.experimental).toEqual({ "claude/channel": {} });
    expect(on.instructions.endsWith(CHANNEL_INSTRUCTIONS)).toBe(true);
    expect(off.caps?.experimental).toBeUndefined();
    expect(off.instructions).not.toContain("world_reply");
  });
});

// -- helpers ------------------------------------------------------------------------------------

async function fixtureContext(root: string): Promise<InstanceContext> {
  const registry = fakeRegistry([{ id: "minecraft:andesite", tags: ["c:stones"] }, { id: "minecraft:stone", tags: [] }]);
  const stack = await memStack([["base", "base", { "assets/minecraft/textures/block/andesite.png": solidPng([130, 130, 130]) }]]);
  const palette = new PaletteIndex(await buildPaletteIndexData(stack, registry), registry);
  return { info: { name: "Fixture", mcVersion: "1.21.1", launcher: "generic", root }, stack, registry, palette, plugins: [], sheets: new SheetRenderer(palette, stack), book: new PaletteBook(), warnings: [], timings: {} };
}

function texts(r: Awaited<ReturnType<Client["callTool"]>>): string[] {
  return (r.content as { type: string; text: string }[]).filter((c) => c.type === "text").map((c) => c.text);
}
