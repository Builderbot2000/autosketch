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
import { Document } from "../../../src/document/document.js";
import { RequestModeRule } from "../../../src/world/modes.js";
import { CHANNEL_INSTRUCTIONS, CHANNEL_METHOD, handoff, InGameRequests, promptAllowed, selectText } from "../../../src/world/prompt.js";
import type { ChatMessage, PlayerRef, PromptMessage, RequestMode, WireBox } from "../../../src/world/protocol/messages.js";
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

async function setup(opts: { promptPlayers?: string[]; singleplayer?: boolean; activityMs?: number; idleMs?: number; context?: WireBox[]; auto?: boolean } = {}) {
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
    componentSet: session.componentSet,
  });
  session.inGame = inGame;
  session.callHooks.push(inGame.modeRule);
  if (opts.auto) {
    await session.create({ name: "tower", mcVersion: "1.21.1", palettes: new PaletteBook() });
    link.autoLink({ instanceDir: host.instanceDir, plugins: [], palettes: new PaletteBook() });
    await host.waitFor(() => link!.bridge.connected);
    return { session, client, host, events, server };
  }
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
      'In-game build request from Dev: "put a balcony here". Build mode: you may edit the linked document. Work volume 16×16×16, context +3 (scope "base"). ' +
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

  it("ends the event text with the component set's reminder line only while the set has entries (17, piece 1)", async () => {
    const { session, host, events } = await setup();
    await host.playerAsk(HOST, "a tower here", {});
    await host.waitFor(() => events.length === 1);
    expect(events[0]!.content).not.toContain("set:");
    expect(events[0]!.content).not.toContain("\n");
    session.componentSet.add([{ prefab: "gothic_tower_a", label: "corner tower" }, { prefab: "gate_small" }]);
    inGame!.lifecycle.turnEnded(); // the turn ends (19), so the next prompt is delivered, not queued
    await host.playerAsk(HOST, "another one", {});
    await host.waitFor(() => events.length === 2);
    const lines = events[1]!.content.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^In-game build request from Dev: "another one"\..*pass done: true when finished\.$/);
    expect(lines[1]).toBe("set: corner tower = gothic_tower_a, gate_small");
    session.componentSet.clear();
    inGame!.lifecycle.turnEnded(); // the turn ends (19), so the next prompt is delivered, not queued
    await host.playerAsk(HOST, "and a third", {});
    await host.waitFor(() => events.length === 3);
    expect(events[2]!.content).not.toContain("set:");
  });

  it("marks a target in the context volume read-only, reports one outside both volumes without saving it, and drops stale handles", async () => {
    const { session, host, events } = await setup();
    await host.playerAsk(HOST, "match that", { target: { pos: w([-2, 0, 0]), state: "minecraft:stone", face: "east" }, focus: { min: w([14, 0, 0]), max: w([17, 1, 1]) } });
    await host.waitFor(() => events.length === 1);
    expect(events[0]!.content).toContain('Looking at minecraft:stone (east face), saved as "target" (in the context volume, read-only).');
    expect(events[0]!.content).toContain('Focus box 4×2×2, saved as "focus" (partly in the context volume, read-only there).');
    inGame!.lifecycle.turnEnded(); // the turn ends (19), so the next prompt is delivered, not queued
    await host.playerAsk(HOST, "and that", { target: { pos: w([-10, 0, 0]), state: "minecraft:stone", face: "east" } });
    await host.waitFor(() => events.length === 2);
    expect(events[1]!.content).toContain(`Looking at minecraft:stone (east face) at world (90, 64, -200), outside both volumes, so not saved.`);
    expect(events[1]!.content).not.toContain("Focus box");
    expect(session.doc!.selections.has("target")).toBe(false);
    expect(session.doc!.selections.has("focus")).toBe(false);
    inGame!.lifecycle.turnEnded(); // the turn ends (19), so the next prompt is delivered, not queued
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

  it("links on the request with automatic linking, even over another open document", async () => {
    const { host, events, session } = await setup({ auto: true });
    await link!.settle();
    expect(session.doc!.meta.name).toBe("tower"); // not replaced without a request
    expect(await host.playerAsk(HOST, "build a cottage")).toMatchObject({ delivered: true });
    await host.waitFor(() => events.length === 1);
    expect(link!.state).toBe("linked");
    expect(session.doc!.meta.name).toBe("world");
    expect(events[0]!.content).toContain('Work volume 16×16×16, context +3 (scope "base")');
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

describe("request modes, enforced (13, B6)", () => {
  const FILL = { box: { min: [1, 0, 1], max: [2, 1, 2] }, pattern: "stone" };
  const refusalText = (mode: string, id: number, tool: string) =>
    `The open in-game ${mode} request (request ${id} from Dev) allows ${mode === "ask" ? "reading and looking only" : mode === "plan" ? "looking and proposing only" : "looking and setting the volumes only"}, ` +
    `so ${tool} can't edit the linked document. Nothing was written. To have it built, the player sends /autosketch build <text>. ` +
    "Answer with world_reply. Only the player can end this request, in game with /autosketch done or by sending a new request; if the user at the terminal wants this edit, tell them so.";

  it("an ask request opens with its mode; fill is refused with request_mode and nothing reaches the world; looking still works", async () => {
    const { client, host, events, session } = await setup();
    expect(await host.playerAsk(HOST, "what is this?", {}, { mode: "ask" })).toMatchObject({ delivered: true });
    await host.waitFor(() => events.length === 1);
    expect(events[0]!.content.startsWith('In-game ask request from Dev: "what is this?". Ask mode: read and look only; edits, drafts (sandboxes, other documents) and volume changes are refused while this request is open. Work volume 16×16×16')).toBe(true);
    const seq = session.doc!.journal.headSeq;
    const r = await client.callTool({ name: "fill", arguments: FILL });
    expect(r.isError).toBe(true);
    expect(texts(r)[0]).toBe(refusalText("ask", 1, "fill"));
    expect(session.doc!.journal.headSeq).toBe(seq);
    expect(host.get(w([1, 0, 1])).state).toBe("minecraft:air");
    expect(host.patchLog).toHaveLength(0);
    // Looking, and saving selections and cameras, are not edits.
    for (const [name, args] of [
      ["view_slice", { axis: "y", at: 0 }],
      ["select", { sel: { min: [0, 0, 0], max: [3, 3, 3] }, name: "spot" }],
      ["doc_info", {}],
      ["checkpoint", { name: "look" }],
    ] as const)
      expect((await client.callTool({ name, arguments: args })).isError, name).toBeFalsy();
    // The refusal shows in the player's activity as such.
    inGame!.stream.flush();
    await host.waitFor(() => chats(host, "activity").some((c) => c.lines.some((l) => l === "fill refused: request_mode")));
  });

  it("refuses edits made any way, undo and scripts included, in plan mode", async () => {
    const { client, host, session } = await setup();
    expect((await client.callTool({ name: "fill", arguments: FILL })).isError).toBeFalsy(); // terminal work before the request
    await host.playerAsk(HOST, "how would you roof this?", {}, { mode: "plan" });
    await host.waitFor(() => inGame!.current?.id === 1);
    const seq = session.doc!.journal.headSeq;
    const undo = await client.callTool({ name: "undo", arguments: {} });
    expect(texts(undo)[0]).toBe(refusalText("plan", 1, "undo"));
    const script = await client.callTool({ name: "run_script", arguments: { source: 'fill(sel.box([5, 0, 5], [5, 0, 5]), "stone");' } });
    expect(script.isError).toBe(true);
    expect(texts(script).join("\n")).toContain("The open in-game plan request (request 1 from Dev) allows looking and proposing only");
    expect(session.doc!.journal.headSeq).toBe(seq);
    expect(host.get(w([1, 0, 1])).state).toBe("minecraft:stone");
    expect(host.get(w([5, 0, 5])).state).toBe("minecraft:air");
  });

  it("world_reply done answers a read-only request but keeps its mode; only the player's /autosketch done ends it", async () => {
    const { client, host } = await setup();
    await host.playerAsk(HOST, "what is this?", {}, { mode: "ask" });
    await host.waitFor(() => inGame!.current?.id === 1);
    expect((await client.callTool({ name: "fill", arguments: FILL })).isError).toBe(true);
    expect(texts(await client.callTool({ name: "world_volumes", arguments: { work: { min: [0, 0, 0], max: [1, 1, 1] } } }))[0]).toContain("so world_volumes can't change the volumes");
    const reply = await client.callTool({ name: "world_reply", arguments: { lines: ["It's a wall."], done: true } });
    expect(texts(reply)[0]).toBe("ok · world_reply · 1 line to Dev (request 1) · request answered; its ask mode stays in force until the player ends it in game (/autosketch done) or sends a new request");
    await host.waitFor(() => chats(host, "reply").length === 1);
    expect(inGame!.current).toBeUndefined(); // answered: the activity stream closed as before
    // The mode still holds: the agent can't lift it.
    const seq = link!.doc!.journal.headSeq;
    const again = await client.callTool({ name: "fill", arguments: FILL });
    expect(texts(again)[0]).toBe(refusalText("ask", 1, "fill"));
    expect(link!.doc!.journal.headSeq).toBe(seq);
    expect(host.patchLog).toHaveLength(0);
    // The player ends it in game.
    expect(await host.playerDone(HOST)).toEqual({ type: "notice", text: "Autosketch: ask request 1 ended; the agent may edit again.", player: HOST.uuid });
    expect(inGame!.heldRequest).toBeUndefined();
    // A call refused by a hook before it ran (world_volumes in ask) unwinds the link's call count, so later results keep their world: line.
    expect(texts(await client.callTool({ name: "fill", arguments: FILL })).join("\n")).toContain("world: 8 placed"); // terminal work again
    // Nothing left to end.
    expect(await host.playerDone(HOST)).toMatchObject({ text: "Autosketch: no ask, plan or select request is open." });
  });

  it("/autosketch done ends an open read-only request before any reply, and closes its stream", async () => {
    const { client, host } = await setup();
    await host.playerAsk(HOST, "how would you roof this?", {}, { mode: "plan" });
    await host.waitFor(() => inGame!.current?.id === 1);
    expect(await host.playerDone(HOST)).toMatchObject({ text: "Autosketch: plan request 1 ended; the agent may edit again." });
    expect(inGame!.current).toBeUndefined();
    expect((await client.callTool({ name: "fill", arguments: FILL })).isError).toBeFalsy();
  });

  it("/autosketch done: a build request is not ended by it; a player off the allowlist is refused", async () => {
    const { client, host } = await setup({ singleplayer: false, promptPlayers: ["Dev"] });
    await host.playerAsk(HOST, "look", {}, { mode: "ask" });
    await host.waitFor(() => inGame!.current?.id === 1);
    expect(await host.playerDone(KEV)).toEqual({ type: "notice", text: "Autosketch: you aren't allowed to send requests (world.promptPlayers), so you can't end one either.", player: KEV.uuid });
    expect(inGame!.heldRequest?.id).toBe(1);
    inGame!.lifecycle.turnEnded(); // the turn ends (19), so the next prompt is delivered, not queued
    await host.playerAsk(HOST, "build", {}, { mode: "build" });
    await host.waitFor(() => inGame!.current?.id === 2);
    expect(await host.playerDone(HOST)).toMatchObject({ text: "Autosketch: no ask, plan or select request is open." });
    expect(inGame!.current?.id).toBe(2); // the build request's stream stays open
    const r = await client.callTool({ name: "world_reply", arguments: { lines: ["Built."], done: true } });
    expect(texts(r)[0]).toBe("ok · world_reply · 1 line to Dev (request 2) · request closed");
  });

  it("the mod sends /autosketch done only to an MCP that lists prompt.close", async () => {
    const { host } = await setup();
    expect(host.mcpFeatures).toEqual(expect.arrayContaining(["prompt.close", "requests"]));
    host.mcpFeatures = []; // as an MCP from before the feature
    await host.playerAsk(HOST, "look", {}, { mode: "ask" });
    await host.waitFor(() => inGame!.current?.id === 1);
    expect(await host.playerDone(HOST)).toEqual({ local: "mcp_outdated" });
    expect(host.sent.some((m) => m.type === "prompt.close")).toBe(false);
    expect(inGame!.heldRequest?.id).toBe(1);
  });

  it("ends with the next request, after which edits pass again", async () => {
    const { client, host } = await setup();
    await host.playerAsk(HOST, "and this?", {}, { mode: "ask" });
    await host.waitFor(() => inGame!.current?.id === 1);
    expect((await client.callTool({ name: "fill", arguments: FILL })).isError).toBe(true);
    await client.callTool({ name: "world_reply", arguments: { lines: ["Stone."], done: true } });
    expect((await client.callTool({ name: "fill", arguments: FILL })).isError).toBe(true);
    await host.playerAsk(HOST, "now build it", {}, { mode: "build" });
    await host.waitFor(() => inGame!.current?.id === 2);
    expect(inGame!.heldRequest).toBeUndefined();
    expect((await client.callTool({ name: "fill", arguments: FILL })).isError).toBeFalsy();
    const r = await client.callTool({ name: "clear", arguments: { sel: { min: [1, 0, 1], max: [1, 0, 1] } } });
    expect(r.isError).toBeFalsy();
    await host.waitFor(() => host.get(w([1, 0, 1])).state === "minecraft:air");
  });

  it("a read-only request does not close on idle time; a build request does", async () => {
    const { client, host } = await setup({ idleMs: 50 });
    await host.playerAsk(HOST, "look", {}, { mode: "ask" });
    await host.waitFor(() => inGame!.current?.id === 1);
    await sleep(120);
    expect(inGame!.current?.id).toBe(1);
    expect((await client.callTool({ name: "fill", arguments: FILL })).isError).toBe(true);
    await host.playerAsk(HOST, "build", {}, { mode: "build" });
    await host.waitFor(() => inGame!.current?.id === 2);
    await sleep(120);
    expect(inGame!.current).toBeUndefined();
  });

  it("ends when the game disconnects, answered or not", async () => {
    const { client, host } = await setup();
    await host.playerAsk(HOST, "look", {}, { mode: "ask" });
    await host.waitFor(() => inGame!.current?.id === 1);
    await client.callTool({ name: "world_reply", arguments: { lines: ["Grass."], done: true } });
    expect(inGame!.heldRequest?.id).toBe(1);
    host.dropConnection();
    await host.waitFor(() => inGame!.heldRequest === undefined);
    expect(inGame!.current).toBeUndefined();
  });
});

describe("request mode rule (13, B6), unit", () => {
  const doc = () => new Document({ name: "t", front: "south", dataVersion: 3955, seed: 1, createdAt: "" });
  const req = (mode: RequestMode) => ({ id: 7, player: HOST, mode });

  it("volume tools pass in select and build only; select refuses edits", () => {
    let current: ReturnType<typeof req> | undefined = req("ask");
    const d = doc();
    const rule = new RequestModeRule(() => current, () => d);
    expect(() => rule.before({ tool: "world_volumes" })).toThrow(
      "The open in-game ask request (request 7 from Dev) allows reading and looking only, so world_volumes can't change the volumes. Nothing was sent. To have the agent set them, the player sends /autosketch select [text]. " +
        "Answer with world_reply. Only the player can end this request, in game with /autosketch done or by sending a new request; if the user at the terminal wants this edit, tell them so.",
    );
    current = req("plan");
    expect(() => rule.before({ tool: "world_volumes" })).toThrow(expect.objectContaining({ refusal: "request_mode" }) as never);
    current = req("select");
    rule.before({ tool: "world_volumes" });
    rule.before({ tool: "fill" }); // the hook doesn't judge tools; the guard judges edits
    expect(() => d.edit("fill", "fill", (tx) => tx.set(0, 0, 0, "minecraft:stone"))).toThrow(/select request \(request 7 from Dev\) allows finding, reading the world and setting the volumes only, so fill can't edit/);
    current = req("build");
    rule.before({ tool: "world_volumes" });
    expect(d.edit("fill", "fill", (tx) => tx.set(0, 0, 0, "minecraft:stone")).changed).toBe(1);
    current = undefined;
    rule.before({ tool: "world_volumes" });
  });

  it("read-only modes are text only: no sandboxes, no other documents, no edits in an open sandbox", () => {
    let current: ReturnType<typeof req> | undefined = req("plan");
    const rule = new RequestModeRule(() => current, () => undefined);
    expect(() => rule.before({ tool: "scope_fork" })).toThrow(
      "The open in-game plan request (request 7 from Dev) allows looking and proposing only, in words only, so scope_fork can't draft in a sandbox or another document either. Nothing was changed. Describe the idea in world_reply; to have it built, the player sends /autosketch build <text>. " +
        "Answer with world_reply. Only the player can end this request, in game with /autosketch done or by sending a new request; if the user at the terminal wants this edit, tell them so.",
    );
    for (const mode of ["ask", "plan", "select"] as const) {
      current = req(mode);
      for (const tool of ["scope_fork", "doc_new", "doc_open"]) expect(() => rule.before({ tool })).toThrow(expect.objectContaining({ refusal: "request_mode" }) as never);
      expect(() => rule.before({ tool: "fill", scope: "job-1", mutating: true })).toThrow(expect.objectContaining({ refusal: "request_mode" }) as never);
      rule.before({ tool: "render", scope: "job-1", mutating: false }); // looking at a sandbox is fine
      rule.before({ tool: "scope_abandon", scope: "job-1", mutating: false });
      rule.before({ tool: "fill", scope: "base", mutating: true }); // the guard judges base edits
    }
    current = req("build");
    rule.before({ tool: "scope_fork" });
    rule.before({ tool: "fill", scope: "job-1", mutating: true });
    current = undefined;
    rule.before({ tool: "doc_new" });
  });

  it("guards only the linked document, and world syncs pass", () => {
    const linked = doc(), other = doc();
    let now: Document | undefined = linked;
    const rule = new RequestModeRule(() => req("ask"), () => now);
    rule.attach(linked);
    rule.attach(other);
    rule.attach(linked); // idempotent
    expect(linked.guards).toHaveLength(1);
    expect(() => linked.edit("fill", "fill", (tx) => tx.set(0, 0, 0, "minecraft:stone"))).toThrow(/request_mode|ask request/);
    expect(other.edit("fill", "fill", (tx) => tx.set(0, 0, 0, "minecraft:stone")).changed).toBe(1);
    expect(linked.editUnguarded("world_sync", "sync", (tx) => tx.set(0, 0, 0, "minecraft:stone")).changed).toBe(1);
    now = undefined; // unlinked: the old document is no longer the world's
    expect(linked.edit("fill", "fill", (tx) => tx.set(1, 0, 0, "minecraft:stone")).changed).toBe(1);
  });
});

describe("select requests (18, piece 1)", () => {
  // The golden vector's context (prompt-select.json): feet (-41, 68, 23), chunk (-3, 1).
  const AT = { dimension: "minecraft:overworld", position: [-40.5, 68, 23.5] as Vec3, eye: [-40.5, 69.62, 23.5] as Vec3, yaw: -135, pitch: 5.5, facing: "north" as const };
  const TARGET = { pos: [-31, 70, 14] as Vec3, state: "minecraft:mossy_stone_bricks", face: "south" as const };
  const ALLOWS =
    "Select mode: find what the player means in the world, agree on its extent with them, then set the volumes from it with world_volumes; reading the world (world_search, world_fill, world_expand, the world view) is allowed, edits and drafts (sandboxes, other documents) are refused while this request is open.";
  const READS =
    "Reads reach the chunks within 256 of the player's chunk (-3, 1) (256 is the default selectChunks; the mod's config may set less): world x -4144..4063, z -4080..4127, full height, at most contextCap blocks per read. They stay where they are if the player moves.";
  const steps = (crosshair: boolean) =>
    "Steps: 1. Find: world_search({materials}) with the block ids, families (family:<id>) or tags the words name, worked out with palette_sheet and similar:, never by asking the player for ids" +
    (crosshair ? "; or start from the crosshair block" : "") +
    ". 2. Propose: offer the likeliest clusters (nearest, densest) with world_reply({choices}). " +
    '3. Grow: world_fill({seed, match}) from a block of the chosen hit, then world_expand({by:"frontier"}) while its frontier is open. ' +
    '4. Look and trim: render({view:"world", region:{dilate:"candidate",by:8}, fade:"candidate"}), then cut "candidate" with the selection algebra. ' +
    '5. Confirm: ask "is this it?" with world_reply({choices}), then world_volumes({from:"candidate"}). ' +
    "For terrain, read a starter volume with world_view_read and cut it instead of filling.";

  it("is delivered without a link or any read: the words, the context in world coordinates, the read square and the steps; the mode is held", async () => {
    const { host, events, session } = await setup({ auto: true });
    expect(host.mcpModes).toContain("select");
    expect(await host.playerAsk(HOST, "the mossy stone brick house", { ...AT, focus: { min: [-35, 68, 10], max: [-30, 70, 12] } }, { mode: "select" })).toEqual({ type: "prompt.result", id: 1, delivered: true });
    await host.waitFor(() => events.length === 1);
    expect(events[0]!.meta).toEqual({ request: "1", player: "Dev" });
    expect(events[0]!.content).toBe(
      'In-game select request from Dev: "the mossy stone brick house". ' + ALLOWS + " " +
        "Standing at world (-41, 68, 23) in minecraft:overworld, facing north. Not looking at a block within reach. Focus box 6×3×3 at world (-35, 68, 10)–(-30, 70, 12). " +
        READS + " " + steps(false) + " Answer the player with world_reply (request 1); pass done: true when finished.",
    );
    expect(link!.state).not.toBe("linked");
    expect(session.doc!.meta.name).toBe("tower");
    expect(host.received.filter((m) => m.type === "snapshot")).toHaveLength(0);
    expect(inGame!.heldRequest).toEqual({ id: 1, player: HOST, mode: "select" });
    expect(inGame!.current).toMatchObject({ id: 1, mode: "select", text: "the mossy stone brick house" });
  });

  it("with no words, starts from the crosshair block; with neither, asks the player", async () => {
    const { host, events } = await setup({ auto: true });
    await host.playerAsk(HOST, "", { ...AT, pitch: 20, target: TARGET }, { mode: "select" });
    await host.waitFor(() => events.length === 1);
    expect(events[0]!.content).toBe(
      "In-game select request from Dev, with no words: start from the block under the crosshair. " + ALLOWS + " " +
        "Standing at world (-41, 68, 23) in minecraft:overworld, facing north. Looking at minecraft:mossy_stone_bricks (south face) at world (-31, 70, 14). " +
        READS + " " + steps(true) + " Answer the player with world_reply (request 1); pass done: true when finished.",
    );
    inGame!.lifecycle.turnEnded(); // the turn ends (19), so the next prompt is delivered, not queued
    await host.playerAsk(HOST, "  ", AT, { mode: "select" });
    await host.waitFor(() => events.length === 2);
    expect(events[1]!.content.startsWith("In-game select request from Dev, with no words and no block under the crosshair: ask the player what they mean. " + ALLOWS)).toBe(true);
    expect(inGame!.heldRequest).toMatchObject({ id: 2, mode: "select" });
  });

  it("ends with the component set's reminder line while the set has entries", async () => {
    const { host, events, session } = await setup({ auto: true });
    session.componentSet.add([{ prefab: "gate_small" }]);
    await host.playerAsk(HOST, "the castle", AT, { mode: "select" });
    await host.waitFor(() => events.length === 1);
    const lines = events[0]!.content.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^In-game select request from Dev: "the castle"\..*pass done: true when finished\.$/);
    expect(lines[1]).toBe("set: gate_small");
  });

  it("says the select tools are refused when the mod doesn't serve select, instead of the read square and steps", () => {
    const m: PromptMessage = { type: "prompt", id: 4, player: HOST, text: "this hill", context: AT, mode: "select" };
    expect(selectText(m, { served: false })).toBe(
      'In-game select request from Dev: "this hill". ' + ALLOWS + " Standing at world (-41, 68, 23) in minecraft:overworld, facing north. Not looking at a block within reach. " +
        "The mod doesn't serve select reads (its hello doesn't list the select feature), so world_search, world_fill, world_expand and world_view_read are refused: tell the player to update the Autosketch mod. " +
        "Answer the player with world_reply (request 4); pass done: true when finished.",
    );
    expect(selectText(m, { served: true })).toContain(READS);
  });

  it("world_volumes({work}) without a linked document points to from:\"candidate\" or linking", async () => {
    const { client, host, events } = await setup({ auto: true });
    await host.playerAsk(HOST, "the tower", AT, { mode: "select" });
    await host.waitFor(() => events.length === 1);
    expect(link!.state).not.toBe("linked");
    const r = await client.callTool({ name: "world_volumes", arguments: { work: { min: [0, 0, 0], max: [3, 3, 3] } } });
    expect(r.isError).toBe(true);
    expect(texts(r)[0]).toContain(
      'world_volumes({work}) takes a box in the linked document\'s coordinates, and no document is linked. In a select request, confirm the shape with world_volumes({from:"candidate"}) (world coordinates, no link needed); otherwise link with doc_open({world: true}).',
    );
    expect(host.received.some((m) => m.type === "volumes.set")).toBe(false);
  });

  it("refuses edits on a linked document and drafts, allows looking and world_volumes past the mode hook", async () => {
    const { client, host, events, session } = await setup();
    await host.playerAsk(HOST, "the tower", AT, { mode: "select" });
    await host.waitFor(() => events.length === 1);
    const seq = session.doc!.journal.headSeq;
    const r = await client.callTool({ name: "fill", arguments: { box: { min: [1, 0, 1], max: [2, 1, 2] }, pattern: "stone" } });
    expect(r.isError).toBe(true);
    expect(texts(r)[0]).toBe(
      "The open in-game select request (request 1 from Dev) allows finding, reading the world and setting the volumes only, so fill can't edit the linked document. Nothing was written. To have it built, the player sends /autosketch build <text>. " +
        "Answer with world_reply. Only the player can end this request, in game with /autosketch done or by sending a new request; if the user at the terminal wants this edit, tell them so.",
    );
    expect(session.doc!.journal.headSeq).toBe(seq);
    expect(host.patchLog).toHaveLength(0);
    const fork = await client.callTool({ name: "doc_new", arguments: { name: "scratch" } });
    expect(fork.isError).toBe(true);
    expect(texts(fork)[0]).toMatch(/^The open in-game select request \(request 1 from Dev\) allows finding, reading the world and setting the volumes only, in words only, so doc_new can't draft/);
    expect((await client.callTool({ name: "view_slice", arguments: { axis: "y", at: 0 } })).isError).toBeFalsy();
    inGame!.modeRule.before({ tool: "world_volumes" }); // volume changes pass the mode rule
    expect(texts(await client.callTool({ name: "world_volumes", arguments: { work: { min: [0, 0, 0], max: [3, 3, 3] } } }))[0]).toMatch(/^ok · world_volumes · work 4×4×4 at local \(0,0,0\)–\(3,3,3\)/);
    // /autosketch done ends it, after which edits pass again.
    await host.playerDone(HOST);
    await host.waitFor(() => inGame!.heldRequest === undefined);
    expect((await client.callTool({ name: "fill", arguments: { box: { min: [1, 0, 1], max: [2, 1, 2] }, pattern: "stone" } })).isError).toBeFalsy();
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
        s.callHooks.push(g.modeRule);
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
