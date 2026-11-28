import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Document } from "../../../src/document/document.js";
import { buildPaletteIndexData, PaletteIndex } from "../../../src/palette/index.js";
import { PaletteBook } from "../../../src/palette/pick.js";
import { SheetRenderer } from "../../../src/palette/sheet.js";
import { runScript, ScriptError } from "../../../src/script/run.js";
import type { InstanceContext } from "../../../src/server/context.js";
import { createServer } from "../../../src/server/server.js";
import { Session } from "../../../src/server/session.js";
import { LiveLink } from "../../../src/world/live-link.js";
import { CHANNEL_INSTRUCTIONS, CHANNEL_METHOD, InGameRequests } from "../../../src/world/prompt.js";
import { MOD_FEATURES, QUEUE_MAX, type PlayerRef, type StatusMessage, type WireBox } from "../../../src/world/protocol/messages.js";
import { elapsed, STOPPED_TEXT, stoppableReads, statusLine } from "../../../src/world/requests.js";
import { autoSyncHook, syncLink } from "../../../src/world/sync.js";
import { requestUndoer } from "../../../src/world/request-undo.js";
import { FakeHost } from "../../support/fake-host.js";
import { solidPng } from "../../helpers/fixtures.js";
import { fakeRegistry } from "../../helpers/registry.js";
import { memStack } from "../../helpers/stack.js";
import { vanillaRegistry } from "../../helpers/vanilla.js";

/** The in-game request lifecycle against the fake host (docs/design/19-canvas-and-requests.md, Part A; step Q1). */

const WORK: WireBox = { min: [100, 64, -200], max: [115, 79, -185] };
const HOST: PlayerRef = { name: "Dev", uuid: "00000000-0000-4000-8000-000000000001" };
const KEV: PlayerRef = { name: "Kev", uuid: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" };
const FILL = { box: { min: [1, 0, 1], max: [2, 1, 2] }, pattern: "stone" };

const roots: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "autosketch-requests-"));
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

async function setup(opts: { features?: string[]; idleMs?: number; undo?: boolean } = {}) {
  host = await FakeHost.start({ volumes: { work: WORK }, singleplayer: false, host: null, ...(opts.features ? { features: opts.features } : {}) });
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
  // A synthetic `turn.end` source, as the observe bus is in the entry point.
  const turnFns: (() => void)[] = [];
  inGame = new InGameRequests(link, {
    promptPlayers: ["Dev", "Kev"],
    idleMs: opts.idleMs ?? 60_000,
    activityMs: 0,
    statusMs: 20,
    subscribe: (fn) => session.subscribe(fn),
    notify: (content, meta) => server.server.notification({ method: CHANNEL_METHOD, params: { content, meta } } as never),
    listening: () => server.server.getClientCapabilities() !== undefined,
    touch: () => session.touch(),
    turnEnds: (fn) => {
      turnFns.push(fn);
      return () => turnFns.splice(turnFns.indexOf(fn), 1);
    },
    // As the entry point wires [Undo request] (step Q2).
    ...(opts.undo ? { baseDoc: () => session.doc, undo: requestUndoer(session, (line) => link!.addNote(line)) } : {}),
  });
  session.inGame = inGame;
  session.callHooks.unshift(inGame.lifecycle.callHook);
  session.callHooks.push(inGame.modeRule);
  const opened = await client.callTool({ name: "doc_open", arguments: { world: true } });
  expect(texts(opened)[0]).toContain("Linked to the world");
  const turnEnd = () => turnFns.forEach((f) => f());
  return { session, client, host, events, turnEnd };
}

const states = (h: FakeHost, request: number) => h.statuses.filter((s) => s.request === request).map((s) => s.state);
const statusIs = (h: FakeHost, request: number, state: StatusMessage["state"]) => h.waitFor(() => h.statusOf(request)?.state === state);

describe("statusLine", () => {
  it("writes each state's plain line with measured counts only", () => {
    expect(statusLine({ state: "working", calls: 14 }, "build a gatehouse", 42_000, undefined)).toBe('⏳ Working · "build a gatehouse" · 14 calls · 0:42');
    expect(statusLine({ state: "done", calls: 1 }, "x", 130_000, undefined)).toBe('✔ Done · "x" · 1 call · 2:10');
    expect(statusLine({ state: "done", calls: 31, noTurnSignal: true }, "x", 130_000, undefined)).toBe('✔ Done (no turn signal) · "x" · 31 calls · 2:10');
    expect(statusLine({ state: "stopping", calls: 9 }, "x", 25_000, undefined)).toBe('■ Stopping… · "x" · 9 calls · 0:25');
    expect(statusLine({ state: "stopped", calls: 9 }, "x", 25_000, undefined)).toBe('■ Stopped · "x" · 9 calls · 0:25');
    expect(statusLine({ state: "queued", calls: 0 }, "make the roof steeper", 0, 2)).toBe('⧗ Queued 2 · "make the roof steeper"');
    expect(statusLine({ state: "stopped", calls: 0, never: "cancelled" }, "x", 0, undefined)).toBe('■ Cancelled · "x"');
    expect(elapsed(3_723_000)).toBe("1:02:03");
  });
});

describe("request lifecycle (19, Part A)", () => {
  it("working with a Stop button, counts calls, and turns done on turn.end", async () => {
    const { client, host, events, turnEnd } = await setup();
    expect(await host.playerAsk(HOST, "build a gatehouse")).toEqual({ type: "prompt.result", id: 1, delivered: true });
    await statusIs(host, 1, "working");
    expect(host.statusOf(1)).toMatchObject({ player: HOST.uuid, text: "build a gatehouse", calls: 0, actions: [{ label: "Stop", kind: "request.stop", args: { request: 1 } }] });
    expect(events).toHaveLength(1);
    await client.callTool({ name: "fill", arguments: FILL });
    await client.callTool({ name: "doc_info", arguments: {} });
    await host.waitFor(() => host.statusOf(1)!.calls === 2); // the 20 ms tick reports the moved count
    turnEnd();
    await statusIs(host, 1, "done");
    const done = host.statusOf(1)!;
    expect(done).toMatchObject({ calls: 2, actions: [] });
    expect(done.noTurnSignal).toBeUndefined();
    expect(done.lines[0]).toMatch(/^✔ Done · "build a gatehouse" · 2 calls · 0:0\d$/);
    expect(inGame!.lifecycle.running).toEqual([]);
  });

  it("queues prompts sent while a turn runs, delivers them first in first out on each turn end, and numbers them per player", async () => {
    const { host, events, turnEnd } = await setup();
    await host.playerAsk(HOST, "first");
    expect(await host.playerAsk(HOST, "second")).toEqual({ type: "prompt.result", id: 2, delivered: false, queued: true, request: 1, position: 1 });
    expect(await host.playerAsk(KEV, "kev's")).toEqual({ type: "prompt.result", id: 3, delivered: false, queued: true, request: 1, position: 1 });
    expect(await host.playerAsk(HOST, "third")).toEqual({ type: "prompt.result", id: 4, delivered: false, queued: true, request: 1, position: 2 });
    await host.waitFor(() => host.statusOf(4)?.state === "queued");
    expect(host.statusOf(2)).toMatchObject({ state: "queued", queuePos: 1, lines: ['⧗ Queued 1 · "second"'], actions: [{ label: "Send now", kind: "queue.send" }, { label: "Cancel", kind: "queue.cancel" }] });
    expect(host.statusOf(4)).toMatchObject({ queuePos: 2 });
    expect(events).toHaveLength(1); // never delivered into the running turn
    turnEnd();
    await host.waitFor(() => events.length === 2);
    expect(events[1]!.meta).toEqual({ request: "2", player: "Dev" });
    expect(events[1]!.content).toContain('"second"');
    await statusIs(host, 2, "working");
    await host.waitFor(() => host.statusOf(4)?.queuePos === 1); // renumbered
    expect(states(host, 1)).toEqual(["working", "done"]);
    await new Promise((r) => setTimeout(r, 30));
    expect(events).toHaveLength(2); // one at a time: the rest wait for this turn's end
    turnEnd();
    await host.waitFor(() => events.length === 3);
    expect(events[2]!.meta.request).toBe("3");
    turnEnd();
    await host.waitFor(() => events.length === 4);
    expect(events[3]!.meta.request).toBe("4");
    turnEnd();
    await statusIs(host, 4, "done");
    expect(inGame!.lifecycle.queued).toEqual([]);
  });

  it(`refuses busy past ${QUEUE_MAX} queued prompts of one player; another player still queues`, async () => {
    const { host } = await setup();
    await host.playerAsk(HOST, "running");
    for (let i = 1; i <= QUEUE_MAX; i++) expect(await host.playerAsk(HOST, `q${i}`)).toMatchObject({ queued: true, position: i });
    expect(await host.playerAsk(HOST, "one too many")).toEqual({ type: "prompt.result", id: QUEUE_MAX + 2, delivered: false, reason: "busy" });
    expect(await host.playerAsk(KEV, "mine")).toMatchObject({ queued: true, position: 1 });
  });

  it("Send now delivers a queued prompt into the running turn; both end with it", async () => {
    const { host, events, turnEnd } = await setup();
    await host.playerAsk(HOST, "build");
    await host.playerAsk(HOST, "make it taller");
    expect(await inGame!.requestControl("queue.send", { request: 2 })).toEqual({ ok: true, result: { request: 2, into: 1 } });
    await host.waitFor(() => events.length === 2);
    await statusIs(host, 2, "working");
    expect(inGame!.lifecycle.running.map((e) => e.id)).toEqual([1, 2]);
    expect(await inGame!.requestControl("queue.send", { request: 2 })).toMatchObject({ ok: false, error: "answered" });
    turnEnd();
    await statusIs(host, 1, "done");
    await statusIs(host, 2, "done");
  });

  it("cancels a queued prompt by button or by /autosketch queue cancel <n>, and lists the queue", async () => {
    const { host, events, turnEnd } = await setup();
    await host.playerAsk(HOST, "build");
    await host.playerAsk(HOST, "a");
    await host.playerAsk(HOST, "b");
    await host.playerAsk(HOST, "c");
    expect(await host.playerControl(HOST, "queue")).toMatchObject({ type: "chat", kind: "reply", request: null, lines: ["Queue: 3 prompts behind request 1.", '1. "a"', '2. "b"', '3. "c"'] });
    expect(await host.playerControl(HOST, "queue.cancel", 2)).toEqual({ type: "notice", player: HOST.uuid, text: 'Autosketch: cancelled queued prompt 2 ("b").' });
    await host.waitFor(() => host.statusOf(3)?.lines[0] === '■ Cancelled · "b"');
    expect(host.statusOf(3)).toMatchObject({ state: "stopped", actions: [] });
    await host.waitFor(() => host.statusOf(4)?.queuePos === 2);
    expect(await inGame!.requestControl("queue.cancel", { request: 2 })).toEqual({ ok: true, result: { request: 2 } });
    expect(await host.playerControl(HOST, "queue.cancel", 5)).toMatchObject({ text: "Autosketch: no queued prompt 5; /autosketch queue lists yours." });
    expect(await host.playerControl(KEV, "queue")).toMatchObject({ lines: ["Queue: empty."] });
    turnEnd();
    await host.waitFor(() => events.length === 2);
    expect(events[1]!.meta.request).toBe("4");
  });

  it("stop: stopping at once, patch.drop to the mod, every tool call refused stopped until turn.end; then stopped and the next queued prompt", async () => {
    const { client, host, events, session, turnEnd } = await setup();
    await host.playerAsk(HOST, "build a wall");
    await client.callTool({ name: "fill", arguments: FILL });
    await host.playerAsk(HOST, "no, a fence");
    expect(await host.playerControl(HOST, "stop")).toEqual({ type: "notice", player: HOST.uuid, text: "Autosketch: stopping request 1; the agent ends its turn at its next tool call." });
    await statusIs(host, 1, "stopping");
    expect(host.statusOf(1)!.lines[0]).toMatch(/^■ Stopping… · "build a wall" · 1 call · /);
    await host.waitFor(() => host.received.some((m) => m.type === "patch.drop"));
    const seq = session.doc!.journal.headSeq;
    for (const [name, args] of [["fill", FILL], ["doc_info", {}], ["world_reply", { lines: ["ok"] }]] as const) {
      const r = await client.callTool({ name, arguments: args });
      expect(r.isError, name).toBe(true);
      expect(texts(r)[0], name).toContain(STOPPED_TEXT);
    }
    expect(session.doc!.journal.headSeq).toBe(seq);
    expect(await host.playerControl(KEV, "stop")).toMatchObject({ text: "Autosketch: request 1 is already stopping; the agent ends its turn at its next tool call." });
    expect(await inGame!.requestControl("request.stop", { request: 1 })).toEqual({ ok: true, result: { request: 1, state: "stopping" } });
    expect(host.statusOf(2)?.state).toBe("queued"); // stop keeps the queue
    turnEnd();
    await statusIs(host, 1, "stopped");
    expect(host.statusOf(1)!.lines[0]).toMatch(/^■ Stopped · "build a wall" · /);
    await host.waitFor(() => events.length === 2);
    expect(events[1]!.meta.request).toBe("2");
    expect((await client.callTool({ name: "doc_info", arguments: {} })).isError).toBeFalsy(); // lifted
    expect(await inGame!.requestControl("request.stop", { request: 1 })).toMatchObject({ ok: false, error: "answered" });
    expect(await host.playerControl(HOST, "stop")).toMatchObject({ text: "Autosketch: stopping request 2; the agent ends its turn at its next tool call." });
  });

  it("answers the request-control buttons: not_found, refused for a queued stop, bad_request for request.undo without an undoer", async () => {
    const { host } = await setup();
    await host.playerAsk(HOST, "build");
    await host.playerAsk(HOST, "later");
    expect(await inGame!.requestControl("request.stop", { request: 99 })).toMatchObject({ ok: false, error: "not_found" });
    expect(await inGame!.requestControl("request.stop", { request: 2 })).toMatchObject({ ok: false, error: "refused" });
    expect(await inGame!.requestControl("request.undo", { request: 1 })).toMatchObject({ ok: false, error: "bad_request" });
    expect(await inGame!.requestControl("queue.cancel", {})).toMatchObject({ ok: false, error: "bad_request" });
    expect(await host.playerControl(HOST, "stop")).toMatchObject({ text: expect.stringContaining("stopping request 1") });
    expect(await inGame!.requestControl("queue.send", { request: 2 })).toMatchObject({ ok: false, error: "refused" });
  });

  it("a stop with nothing running says so", async () => {
    const { host } = await setup();
    expect(await host.playerControl(HOST, "stop")).toEqual({ type: "notice", player: HOST.uuid, text: "Autosketch: no request is running." });
  });

  it("fallbacks with no turn signal: world_reply done, then idleMs; the status says noTurnSignal", async () => {
    const { client, host, events, turnEnd } = await setup({ idleMs: 150 });
    await host.playerAsk(HOST, "one");
    await host.playerAsk(HOST, "two");
    await client.callTool({ name: "world_reply", arguments: { lines: ["Built."], done: true } });
    await statusIs(host, 1, "done");
    expect(host.statusOf(1)).toMatchObject({ noTurnSignal: true });
    expect(host.statusOf(1)!.lines[0]).toContain("✔ Done (no turn signal)");
    await host.waitFor(() => events.length === 2);
    // No reply at all: the idle fallback ends the turn.
    await statusIs(host, 2, "done");
    expect(host.statusOf(2)).toMatchObject({ noTurnSignal: true });
    // Once a turn.end has been seen, world_reply done no longer ends a turn, and the hook's end carries no flag.
    await host.playerAsk(HOST, "three");
    turnEnd();
    await statusIs(host, 3, "done");
    expect(host.statusOf(3)!.noTurnSignal).toBeUndefined();
    expect(await host.playerAsk(HOST, "four")).toMatchObject({ delivered: true });
    await statusIs(host, 4, "working");
    await client.callTool({ name: "world_reply", arguments: { lines: ["Done."], done: true } });
    await new Promise((r) => setTimeout(r, 40));
    expect(host.statusOf(4)!.state).toBe("working");
  });

  it("the idle fallback waits for a call in flight", async () => {
    const { client, host } = await setup({ idleMs: 60 });
    await host.playerAsk(HOST, "slow");
    let release!: () => void;
    host.beforePatch = () => new Promise<void>((r) => (release = r));
    const call = client.callTool({ name: "fill", arguments: FILL });
    await host.waitFor(() => release !== undefined);
    await new Promise((r) => setTimeout(r, 150));
    expect(host.statusOf(1)!.state).toBe("working");
    host.beforePatch = undefined;
    release();
    await call;
    await statusIs(host, 1, "done");
  });

  it("drops the queue on disconnect; the running turn goes on", async () => {
    const { host } = await setup();
    await host.playerAsk(HOST, "build");
    await host.playerAsk(HOST, "queued");
    host.dropConnection();
    await host.waitFor(() => !link!.bridge.connected);
    expect(inGame!.lifecycle.queued).toEqual([]);
    expect(inGame!.lifecycle.running.map((e) => e.id)).toEqual([1]);
  });

  it("a mod without requests gets no queueing: prompts are delivered as before, with plain status lines", async () => {
    const { host, events, turnEnd } = await setup({ features: MOD_FEATURES.filter((f) => f !== "requests") });
    expect(link!.bridge.requests).toBe(false);
    expect(await host.playerAsk(HOST, "one")).toMatchObject({ delivered: true });
    expect(await host.playerAsk(HOST, "two")).toMatchObject({ delivered: true });
    await host.waitFor(() => events.length === 2);
    turnEnd();
    await host.waitFor(() => host.chats.filter((c) => c.kind === "activity" && c.lines[0]!.startsWith("✔ Done")).length === 2);
    const plain = host.chats.filter((c) => c.kind === "activity").map((c) => c.lines[0]!.replace(/ · \d+:\d\d$/, ""));
    expect(plain).toEqual(['⏳ Working · "one" · 0 calls', '⏳ Working · "two" · 0 calls', '✔ Done · "one" · 0 calls', '✔ Done · "two" · 0 calls']);
    expect(host.statuses).toEqual([]);
    expect(host.requestsUngated).toEqual([]);
  });
});

describe("[Undo request] (19, Stop, step 5; step Q2)", () => {
  // Local (0,0,0) is the work volume's min corner, (100,64,-200).
  const W = (x: number, y: number, z: number): [number, number, number] => [100 + x, 64 + y, -200 + z];
  const FILL2 = { box: { min: [5, 0, 5], max: [5, 2, 5] }, pattern: "andesite" };
  const patches = (h: FakeHost) => h.received.filter((m) => m.type === "patch").length;

  it("undoes a stopped request's entries as one step and one patch; the line loses the button; a second click is answered", async () => {
    const { client, host, session, turnEnd } = await setup({ undo: true });
    await client.callTool({ name: "fill", arguments: { ...FILL, pattern: "andesite" } }); // before any request: stays
    await host.playerAsk(HOST, "build a wall");
    await client.callTool({ name: "fill", arguments: FILL });
    await client.callTool({ name: "fill", arguments: FILL2 });
    await host.waitFor(() => host.get(W(5, 2, 5)).state === "minecraft:andesite");
    await host.playerControl(HOST, "stop");
    turnEnd();
    await statusIs(host, 1, "stopped");
    expect(host.statusOf(1)!.actions).toEqual([{ label: "Undo request", kind: "request.undo", args: { request: 1 } }]);
    const head = session.doc!.journal.headSeq;
    const sent = patches(host);
    expect(await inGame!.requestControl("request.undo", { request: 1 })).toEqual({ ok: true, result: { request: 1, entries: 2 } });
    expect(session.doc!.journal.headSeq).toBe(head - 2);
    expect(patches(host)).toBe(sent + 1);
    await host.waitFor(() => host.get(W(5, 2, 5)).state === "minecraft:air");
    for (const p of [W(1, 0, 1), W(2, 1, 2)]) expect(host.get(p).state).toBe("minecraft:andesite");
    for (const y of [0, 1, 2]) expect(host.get(W(5, y, 5)).state).toBe("minecraft:air");
    await host.waitFor(() => host.statusOf(1)!.lines[0]!.includes("undone"));
    expect(host.statusOf(1)).toMatchObject({ state: "stopped", actions: [] });
    expect(host.statusOf(1)!.lines[0]).toMatch(/^■ Stopped · "build a wall" · 2 calls · \d+:\d\d · undone \(2 entries\)$/);
    expect(await inGame!.requestControl("request.undo", { request: 1 })).toEqual({ ok: false, error: "answered", message: "Request 1 was already undone (2 entries)." });
    // The agent hears of it on its next linked call, and can redo it.
    expect(texts(await client.callTool({ name: "doc_info", arguments: {} })).join("\n")).toContain("The player undid request 1: 2 entries (#2–#3) in one step.");
    expect(texts(await client.callTool({ name: "redo", arguments: { steps: 2 } }))[0]).toMatch(/^redid 2: #2 /);
  });

  it("a done request can be undone too (no button on its line); one that made no edits, or never ran, is answered", async () => {
    const { client, host, session, turnEnd } = await setup({ undo: true });
    await host.playerAsk(HOST, "look around");
    await client.callTool({ name: "doc_info", arguments: {} });
    turnEnd();
    await statusIs(host, 1, "done");
    expect(await inGame!.requestControl("request.undo", { request: 1 })).toEqual({ ok: false, error: "answered", message: "Request 1 made no edits." });
    await host.playerAsk(HOST, "build");
    await client.callTool({ name: "fill", arguments: FILL });
    await host.playerAsk(HOST, "queued then cancelled");
    await inGame!.requestControl("queue.cancel", { request: 3 });
    turnEnd();
    await statusIs(host, 2, "done");
    expect(host.statusOf(2)!.actions).toEqual([]);
    expect(await inGame!.requestControl("request.undo", { request: 3 })).toMatchObject({ ok: false, error: "answered", message: "Request 3 never ran, so it made no edits." });
    expect(await inGame!.requestControl("request.undo", { request: 2 })).toEqual({ ok: true, result: { request: 2, entries: 1 } });
    expect(session.doc!.journal.headSeq).toBe(0);
    await host.waitFor(() => host.get(W(1, 0, 1)).state === "minecraft:air");
  });

  it("refused while it or another request runs, or while queued; refused after a later edit, naming it", async () => {
    const { client, host, session, turnEnd } = await setup({ undo: true });
    await host.playerAsk(HOST, "build");
    await client.callTool({ name: "fill", arguments: FILL });
    await host.playerAsk(HOST, "then this");
    expect(await inGame!.requestControl("request.undo", { request: 1 })).toEqual({ ok: false, error: "refused", message: "Request 1 is still working; it can be undone once its turn ends." });
    expect(await inGame!.requestControl("request.undo", { request: 2 })).toEqual({ ok: false, error: "refused", message: "Request 2 is queued and hasn't run, so it has no edits to undo." });
    turnEnd();
    await statusIs(host, 2, "working");
    expect(await inGame!.requestControl("request.undo", { request: 1 })).toEqual({ ok: false, error: "refused", message: "Request 2 is running; request 1 can be undone once its turn ends." });
    await client.callTool({ name: "fill", arguments: FILL2 });
    turnEnd();
    await statusIs(host, 2, "done");
    const head = session.doc!.journal.headSeq;
    expect(await inGame!.requestControl("request.undo", { request: 1 })).toEqual({
      ok: false,
      error: "refused",
      message: "Request 1 can't be undone: 1 later entry came after its last one (#1): #2 fill (5,0,5)–(5,2,5) andesite.",
    });
    expect(session.doc!.journal.headSeq).toBe(head);
    expect(await inGame!.requestControl("request.undo", { request: 2 })).toMatchObject({ ok: true, result: { request: 2, entries: 1 } });
    expect(await inGame!.requestControl("request.undo", { request: 1 })).toMatchObject({ ok: true, result: { request: 1, entries: 1 } });
    expect(session.doc!.journal.headSeq).toBe(0);
  });

  it("goes the usual undo's way: hand edits since are synced first and refuse it; a world_sync between its entries refuses it (the sync barrier)", async () => {
    const { client, host, session, turnEnd } = await setup({ undo: true });
    await host.playerAsk(HOST, "build");
    await client.callTool({ name: "fill", arguments: FILL });
    turnEnd();
    await statusIs(host, 1, "done");
    host.playerSet(W(8, 0, 8), "minecraft:glass");
    await host.waitFor(() => link!.isDirty());
    const r = await inGame!.requestControl("request.undo", { request: 1 });
    expect(r).toMatchObject({ ok: false, error: "refused" });
    expect((r as { message: string }).message).toMatch(/^Request 1 can't be undone: 1 later entry came after its last one \(#1\): #2 world_sync \(1 block changed in the world\)\.$/);
    expect(host.get(W(1, 0, 1)).state).toBe("minecraft:stone");

    await host.playerAsk(HOST, "more");
    await client.callTool({ name: "fill", arguments: FILL2 });
    host.playerSet(W(9, 0, 9), "minecraft:glass");
    await host.waitFor(() => link!.isDirty());
    await client.callTool({ name: "fill", arguments: { box: { min: [12, 0, 12], max: [12, 0, 12] }, pattern: "stone" } }); // synced first: #4 world_sync, then #5
    turnEnd();
    await statusIs(host, 2, "done");
    const head = session.doc!.journal.headSeq;
    expect(await inGame!.requestControl("request.undo", { request: 2 })).toEqual({
      ok: false,
      error: "refused",
      message: "Request 2 can't be undone: #4 world_sync (1 block changed in the world) lies between its entries; undoing past it would overwrite those blocks in the world.",
    });
    expect(session.doc!.journal.headSeq).toBe(head);
  });

  it("Send now: each request undoes its own entries; the first's include those made after the second joined", async () => {
    const { client, host, session, turnEnd } = await setup({ undo: true });
    await host.playerAsk(HOST, "build");
    await client.callTool({ name: "fill", arguments: FILL });
    await host.playerAsk(HOST, "and a post");
    await inGame!.requestControl("queue.send", { request: 2 });
    await statusIs(host, 2, "working");
    await client.callTool({ name: "fill", arguments: FILL2 });
    turnEnd();
    await statusIs(host, 2, "done");
    expect(await inGame!.requestControl("request.undo", { request: 2 })).toEqual({ ok: true, result: { request: 2, entries: 1 } });
    expect(session.doc!.journal.headSeq).toBe(1);
    expect(await inGame!.requestControl("request.undo", { request: 1 })).toEqual({ ok: true, result: { request: 1, entries: 1 } });
    expect(session.doc!.journal.headSeq).toBe(0);
  });

  it("a scope merge made during the request is one of its entries", async () => {
    const { client, host, session, turnEnd } = await setup({ undo: true });
    await host.playerAsk(HOST, "build a keep");
    await client.callTool({ name: "fill", arguments: FILL });
    const f = await client.callTool({ name: "scope_fork", arguments: { work: { min: [8, 0, 8], max: [15, 7, 15] }, brief: "the keep", scope: "base" } });
    expect(f.isError, texts(f)[0]).toBeFalsy();
    const sf = await client.callTool({ name: "fill", arguments: { box: { min: [0, 0, 0], max: [1, 1, 1] }, pattern: "andesite", scope: "s1" } });
    expect(sf.isError, texts(sf)[0]).toBeFalsy();
    const m = await client.callTool({ name: "scope_merge", arguments: { scope: "s1", report: "keep base" } });
    expect(m.isError, texts(m)[0]).toBeFalsy();
    await host.waitFor(() => host.get(W(9, 1, 9)).state === "minecraft:andesite");
    turnEnd();
    await statusIs(host, 1, "done");
    expect(await inGame!.requestControl("request.undo", { request: 1 })).toEqual({ ok: true, result: { request: 1, entries: 2 } });
    expect(session.doc!.journal.headSeq).toBe(0);
    await host.waitFor(() => host.get(W(9, 1, 9)).state === "minecraft:air");
    expect(host.get(W(1, 0, 1)).state).toBe("minecraft:air");
  });
});

describe("cancelling work in flight (19, Stop, step 2)", () => {
  it("the mod drops patches it hasn't started and finishes the one in progress", async () => {
    const { host: h } = await setup();
    let release!: () => void;
    h.beforePatch = () => new Promise<void>((r) => (release = r));
    const patch = (x: number) => ({ type: "patch" as const, link: h.link, dimension: "minecraft:overworld", blocks: [{ pos: [100 + x, 64, -200] as [number, number, number], expected: "minecraft:air", state: "minecraft:stone" }] });
    const first = link!.bridge.request(patch(0));
    await h.waitFor(() => release !== undefined);
    const second = link!.bridge.request(patch(1)).catch((e: Error & { refusal?: string }) => e);
    await h.waitFor(() => h.received.filter((m) => m.type === "patch").length === 2);
    const ids = h.received.flatMap((m) => (m.type === "patch" ? [m.id] : []));
    link!.bridge.send({ type: "patch.drop" });
    await h.waitFor(() => h.received.some((m) => m.type === "patch.drop"));
    h.beforePatch = undefined;
    release();
    expect(await first).toMatchObject({ type: "patch.ack", applied: 1 });
    expect(await second).toMatchObject({ refusal: "dropped" });
    expect(h.droppedPatches).toEqual([ids[1]]);
    expect(h.get([100, 64, -200]).state).toBe("minecraft:stone");
    expect(h.get([101, 64, -200]).state).toBe("minecraft:air");
  });

  it("stoppableReads rejects a world read in flight at once on a stop, refuses one sent while stopping, and passes the rest", async () => {
    let ctl: AbortController | undefined = new AbortController();
    const sent: string[] = [];
    const bridge = {
      connected: true,
      request: (m: { type: string }) => {
        sent.push(m.type);
        return new Promise(() => {});
      },
    };
    const reads = stoppableReads(bridge as never, () => ctl?.signal);
    const search = (reads.request as (m: unknown) => Promise<unknown>)({ type: "search" }).catch((e: Error & { refusal?: string }) => e);
    const vol = (reads.request as (m: unknown) => Promise<unknown>)({ type: "volumes.set" });
    let volDone = false;
    void vol.then(() => (volDone = true));
    ctl.abort(Object.assign(new Error(STOPPED_TEXT), { refusal: "stopped" }));
    expect(await search).toMatchObject({ refusal: "stopped", message: STOPPED_TEXT });
    await expect((reads.request as (m: unknown) => Promise<unknown>)({ type: "fill" })).rejects.toMatchObject({ refusal: "stopped" });
    expect(sent).toEqual(["search", "volumes.set"]);
    expect(volDone).toBe(false); // still awaited
    expect(reads.connected).toBe(true);
    ctl = undefined; // no turn: reads pass
    void (reads.request as (m: unknown) => Promise<unknown>)({ type: "snapshot" });
    expect(sent).toEqual(["search", "volumes.set", "snapshot"]);
  });

  it("run_script aborts between steps when stopped, rolled back, as a stopped ScriptError", async () => {
    const doc = Document.create({ name: "s", dataVersion: 3955, seed: 7 });
    const env = { registry: vanillaRegistry() };
    const pos = doc.journal.position;
    let steps = 0;
    const err = await runScript(doc, env, {
      source: 'for (let i = 0; i < 10; i++) fill(sel.box([i, 0, 0], [i, 0, 0]), "stone");',
      abort: () => ++steps > 4,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScriptError);
    expect((err as ScriptError).kind).toBe("stopped");
    expect((err as ScriptError).message).toContain(STOPPED_TEXT);
    expect(doc.journal.position).toBe(pos);
    for (let x = 0; x < 10; x++) expect(doc.getState(x, 0, 0)).toBe("minecraft:air");
    // Already stopped: never starts.
    await expect(runScript(doc, env, { source: "1", abort: () => true })).rejects.toMatchObject({ kind: "stopped" });
  });
});

async function fixtureContext(root: string): Promise<InstanceContext> {
  const registry = fakeRegistry([{ id: "minecraft:andesite", tags: ["c:stones"] }, { id: "minecraft:stone", tags: [] }]);
  const stack = await memStack([["base", "base", { "assets/minecraft/textures/block/andesite.png": solidPng([130, 130, 130]) }]]);
  const palette = new PaletteIndex(await buildPaletteIndexData(stack, registry), registry);
  return { info: { name: "Fixture", mcVersion: "1.21.1", launcher: "generic", root }, stack, registry, palette, plugins: [], sheets: new SheetRenderer(palette, stack), book: new PaletteBook(), warnings: [], timings: {} };
}

function texts(r: Awaited<ReturnType<Client["callTool"]>>): string[] {
  return (r.content as { type: string; text: string }[]).filter((c) => c.type === "text").map((c) => c.text);
}
