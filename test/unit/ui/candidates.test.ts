import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readConfig } from "../../../src/core/config.js";
import { MAX_CANDIDATES } from "../../../src/library/candidates.js";
import { Settings } from "../../../src/core/settings.js";
import { libraryRoots } from "../../../src/library/roots.js";
import { createServer } from "../../../src/server/server.js";
import { Session } from "../../../src/server/session.js";
import { startUi, type UiCore } from "../../../src/ui/index.js";
import { LiveLink } from "../../../src/world/live-link.js";
import { CHANNEL_INSTRUCTIONS, InGameRequests } from "../../../src/world/prompt.js";
import { CANDIDATES_MAX, type ChatMessage, type PlayerRef, type UiGhost, type UiResult, type WireBox } from "../../../src/world/protocol/messages.js";
import { autoSyncHook, syncLink } from "../../../src/world/sync.js";
import { FakeHost } from "../../support/fake-host.js";
import { tempDir } from "../../helpers/fixtures.js";
import { libraryContext } from "../library/fixture.js";
// Every area that declares settings, so the registry is the server's.
import "../../../src/assets/settings.js";
import "../../../src/server/settings.js";
import "../../../src/world/settings.js";

/**
 * `world_reply({candidates})` and `candidates.open` (17, piece 3) against the fake host: the cells
 * the last `prefab_sheet` gave, the clickable reply line, the click's request and the list's
 * lifetime (briefs/components/Q, step Q1).
 */

const WORK: WireBox = { min: [100, 64, -200], max: [115, 79, -185] };
const HOST: PlayerRef = { name: "Dev", uuid: "00000000-0000-4000-8000-000000000001" };

let base: string;
beforeAll(async () => {
  base = await tempDir("autosketch-cand-");
  // The starter library (lamp_post, park_bench, small_oak_tree, village_well) plus an empty user root, all in temp.
  vi.stubEnv("AUTOSKETCH_LIBRARY", join(base, "library"));
  vi.stubEnv("AUTOSKETCH_CACHE", join(base, "cache"));
  vi.stubEnv("AUTOSKETCH_HOME", join(base, "home"));
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(base, { recursive: true, force: true });
});

let host: FakeHost | undefined;
let link: LiveLink | undefined;
let inGame: InGameRequests | undefined;
let ui: UiCore | undefined;
afterEach(async () => {
  ui?.close();
  inGame?.close();
  link?.close();
  await host?.close();
  host = link = inGame = ui = undefined;
});

type Content = { type: string; text?: string }[];
const textOf = (r: { content: unknown }) => (r.content as Content).filter((c) => c.type === "text").map((c) => c.text).join("\n");

/** Channel events the agent received: text and meta. */
type Sent = { content: string; meta: Record<string, string> };

async function setup(opts: { features?: string[]; listening?: () => boolean } = {}) {
  host = await FakeHost.start({ volumes: { work: WORK }, ...(opts.features ? { features: opts.features } : {}) });
  const ctx = await libraryContext(host.instanceDir);
  const workspace = await tempDir("autosketch-cand-ws-");
  const session = new Session(workspace);
  const events: Sent[] = [];
  link = new LiveLink(session, { ackWaitMs: 2000, backoff: { minMs: 20, maxMs: 50 }, features: ["prompt.close", "ui"] });
  link.setSync(syncLink);
  session.world = link;
  session.callHooks.push(autoSyncHook(() => session.world));
  const server = createServer(Promise.resolve(ctx), { session, channel: { instructions: CHANNEL_INSTRUCTIONS } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const g = new InGameRequests(link, {
    promptPlayers: [],
    idleMs: 60_000,
    activityMs: 0,
    subscribe: (fn) => session.subscribe(fn),
    notify: async (content, meta) => void events.push({ content, meta }),
    listening: opts.listening ?? (() => true),
    touch: () => session.touch(),
    componentSet: session.componentSet,
  });
  inGame = g;
  session.inGame = g;
  session.callHooks.push(g.modeRule);
  const configPath = join(await tempDir("autosketch-cand-home-"), "config.toml");
  const settings = Settings.from([], {}, readConfig(configPath));
  ui = startUi({
    bridge: link.bridge,
    subscribe: (fn) => session.subscribe(fn),
    workspace,
    sessionId: "20261118T000000000Z-live",
    settings,
    configPath,
    promptPlayers: () => [],
    library: { roots: () => libraryRoots({ workspace, env: process.env, settings: Settings.from([], {}, readConfig(configPath)) }) },
    candidates: session.candidates,
    baseDoc: () => session.doc,
    scopes: session.scopes,
    linkFrame: () => (link!.volumes ? { dimension: link!.volumes.dimension, origin: link!.volumes.origin } : undefined),
    inGame: () => g,
    intervalMs: 20,
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { ...r, text: textOf(r) };
  };
  expect((await call("doc_open", { world: true })).text).toContain("Linked to the world");
  return { session, host, call, events };
}

const replies = (h: FakeHost) => h.chats.filter((c) => c.kind === "reply");
const ok = (r: UiResult | { local: string }) => {
  if ("local" in r) throw new Error(`not sent: ${r.local}`);
  if (!r.ok) throw new Error(`${r.error}: ${r.message}`);
  return r.result;
};

describe("world_reply candidates (17, piece 3)", () => {
  it("offers at most the protocol's limit", () => expect(MAX_CANDIDATES).toBe(CANDIDATES_MAX));

  it("defaults cells to the last sheet's, adds a clickable line, and the click opens the list with its request and question", async () => {
    const { host, call, session } = await setup();
    await host.playerAsk(HOST, "show me a bench or a well", {}, { mode: "ask" });
    await host.waitFor(() => inGame!.current?.id === 1);
    const sheet = await call("prefab_sheet");
    expect(sheet.text).toContain("A1 lamp_post");
    expect(sheet.text).toContain("D1 village_well");
    const r = await call("world_reply", { lines: ["Two that fit:"], candidates: [{ prefab: "village_well" }, { prefab: "park_bench" }, { prefab: "small_oak_tree", cell: "Z9" }] });
    expect(r.isError).toBeFalsy();
    expect(r.text).toBe("ok · world_reply · 1 line to Dev (request 1) · candidates c1: D1 village_well, B1 park_bench, Z9 small_oak_tree (clickable line added)");
    await host.waitFor(() => replies(host).length === 1);
    const chat = replies(host)[0]!;
    expect(chat).toEqual({ type: "chat", request: 1, player: HOST.uuid, kind: "reply", lines: ["Two that fit:", "[Show candidates (3)]"], action: { line: 1, kind: "candidates.open", args: { id: "c1" } } });

    const opened = ok(await host.playerClick(HOST, chat));
    expect(opened).toMatchObject({ id: "c1", request: 1, question: "show me a bench or a well" });
    const entries = (opened as { entries: Record<string, unknown>[] }).entries;
    expect(entries.map((e) => [e.cell, e.prefab, e.root])).toEqual([
      ["D1", "village_well", "starter"],
      ["B1", "park_bench", "starter"],
      ["Z9", "small_oak_tree", "starter"],
    ]);
    for (const e of entries) {
      expect(e.size).toHaveLength(3);
      expect((e.size as number[]).every((n) => Number.isInteger(n) && n > 0)).toBe(true);
      expect(Array.isArray(e.tags)).toBe(true);
      expect(e.notes === null || typeof e.notes === "string").toBe(true);
    }
    const stored = session.candidates.get("c1")!;
    expect(entries.map((e) => e.size)).toEqual(stored.entries.map((e) => e.size));

    // The list outlives its request: once the player ends the ask, open still serves it, with request null.
    await host.playerDone(HOST);
    await host.waitFor(() => !inGame!.heldRequest);
    expect(ok(await host.playerClick(HOST, chat))).toMatchObject({ id: "c1", request: null, question: "show me a bench or a well" });
    // A later sheet doesn't change a stored list's cells, and a new list gets a new id.
    await call("prefab_sheet", { query: "well" });
    const again = await call("world_reply", { lines: ["And this one."], candidates: [{ prefab: "village_well" }] });
    expect(again.text).toContain("candidates c2: A1 village_well");
    expect((ok(await host.playerClick(HOST, chat)) as { entries: { cell: string }[] }).entries[0]!.cell).toBe("D1");
  });

  it("refuses unknown prefabs, twice-listed prefabs and cells, and sends nothing; a prefab off the sheet gets #n", async () => {
    const { host, call } = await setup();
    const unknown = await call("world_reply", { lines: ["x"], candidates: [{ prefab: "no_such_tower" }] });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/^Nothing was sent: .*no_such_tower/);
    expect((await call("world_reply", { lines: ["x"], candidates: [{ prefab: "park_bench" }, { prefab: "park_bench" }] })).text).toBe("Nothing was sent: candidate park_bench is listed twice.");
    expect((await call("world_reply", { lines: ["x"], candidates: [{ prefab: "park_bench", cell: "A1" }, { prefab: "lamp_post", cell: "A1" }] })).text).toContain("cell A1 names two candidates");
    expect((await call("world_reply", { lines: ["x"], candidates: [{ prefab: "park_bench", cell: "b2" }] })).text).toContain('cell "b2" isn\'t a sheet cell');
    expect(replies(host)).toHaveLength(0);
    // No sheet shown yet, and no open request: cells are list positions and the reply goes to log "all".
    const r = await call("world_reply", { lines: ["Pick one"], candidates: [{ prefab: "lamp_post" }, { prefab: "park_bench" }] });
    expect(r.text).toBe('ok · world_reply · 1 line to players with log "all" (no open request) · candidates c1: #1 lamp_post, #2 park_bench (clickable line added)');
    await host.waitFor(() => replies(host).length === 1);
    expect(ok(await host.playerClick(HOST, replies(host)[0]!))).toMatchObject({ id: "c1", request: null, question: "" });
  });

  it("lists the cells as plain text, with no action, when the mod has no in-game UI", async () => {
    const { host, call } = await setup({ features: ["prompt.close"] });
    await call("prefab_sheet");
    const r = await call("world_reply", { lines: ["Options:"], candidates: [{ prefab: "park_bench" }, { prefab: "lamp_post" }] });
    expect(r.text).toContain("candidates c1: B1 park_bench, A1 lamp_post (listed as plain text: the mod has no in-game UI)");
    await host.waitFor(() => replies(host).length === 1);
    const chat: ChatMessage = replies(host)[0]!;
    expect(chat.lines).toEqual(["Options:", "Candidates: B1 park_bench, A1 lamp_post"]);
    expect(chat.action).toBeUndefined();
  });

  it("choices.pick (18, piece 7) answers bad_request when the UI is started without the session's questions", async () => {
    const { host } = await setup();
    expect(await host.playerUiRequest(HOST, { kind: "choices.pick", args: { id: "q1", index: 0 } })).toMatchObject({ ok: false, error: "bad_request", message: expect.stringContaining("doesn't serve choices.pick") });
  });

  it("candidates.open answers not_found for an unknown id, bad_request without one, and answered after a submit", async () => {
    const { host, call, session } = await setup();
    await call("world_reply", { lines: ["Pick"], candidates: [{ prefab: "park_bench" }] });
    expect(await host.playerUiRequest(HOST, { kind: "candidates.open", args: { id: "c9" } })).toMatchObject({ ok: false, error: "not_found" });
    expect(await host.playerUiRequest(HOST, { kind: "candidates.open", args: {} })).toMatchObject({ ok: false, error: "bad_request" });
    ok(await host.playerUiRequest(HOST, { kind: "candidates.submit", args: { id: "c1", picks: [{ prefab: "park_bench", cell: "#1" }] } }));
    expect(session.candidates.get("c1")!.answered).toBe(true);
    expect(await host.playerUiRequest(HOST, { kind: "candidates.open", args: { id: "c1" } })).toMatchObject({ ok: false, error: "answered" });
  });
});

/** A `ui.ghost`'s blocks by world position ("x,y,z" → state), air left out. */
function ghostBlocks(g: UiGhost): Map<string, string> {
  const out = new Map<string, string>();
  for (const sec of g.sections)
    for (let i = 0; i < 4096; i++) {
      const st = g.palette[sec.states[i]!]!;
      if (st === "minecraft:air") continue;
      const x = i & 15, z = (i >> 4) & 15, y = i >> 8;
      out.set([g.origin[0] + sec.section[0] * 16 + x, g.origin[1] + sec.section[1] * 16 + y, g.origin[2] + sec.section[2] * 16 + z].join(","), st);
    }
  return out;
}

describe("the candidate ghost (17, piece 3; candidates.ghost, candidates.ghost.clear)", () => {
  const ghosts = (h: FakeHost) => h.ui.filter((m) => (m.type === "ui.ghost" || m.type === "ui.ghost.clear") && m.ghost === "candidate");
  const AT = [10, 64, 20];
  const OVERWORLD = "minecraft:overworld";

  it("draws one of the list's prefabs as stamp would place it, replaces it on the next, and clears it", async () => {
    const { host, call } = await setup();
    await call("world_reply", { lines: ["Pick"], candidates: [{ prefab: "lamp_post" }, { prefab: "park_bench" }] });
    expect(ok(await host.playerUiRequest(HOST, { kind: "candidates.ghost", args: { id: "c1", prefab: "lamp_post", dimension: OVERWORLD, at: AT } }))).toEqual({ ghost: "candidate" });
    await host.waitFor(() => ghosts(host).length === 1);
    const first = ghosts(host)[0] as UiGhost;
    expect(first).toMatchObject({ type: "ui.ghost", ghost: "candidate", players: [HOST.uuid], dimension: OVERWORLD, origin: [10, 64, 20], tint: "#ffffff", full: true });
    // lamp_post (starter library): post at (0,0..4,0), arm and lantern at z 1, anchor base (0,0,0).
    const b = ghostBlocks(first);
    expect(b.size).toBe(7);
    expect(b.get("10,64,20")).toBe("minecraft:stone_bricks");
    for (const y of [65, 66, 67]) expect(b.get(`10,${y},20`)).toMatch(/^minecraft:stone_brick_wall/);
    expect(b.get("10,68,20")).toMatch(/^minecraft:stone_brick_slab\[.*type=bottom/);
    expect(b.get("10,68,21")).toMatch(/^minecraft:oak_fence/);
    expect(b.get("10,67,21")).toMatch(/^minecraft:lantern\[.*hanging=true/);

    // Turned 90° clockwise: the arm points west, and the base anchor stays on `at`.
    ok(await host.playerUiRequest(HOST, { kind: "candidates.ghost", args: { id: "c1", prefab: "lamp_post", dimension: OVERWORLD, at: AT, rotate: 90 } }));
    await host.waitFor(() => ghosts(host).length === 2);
    const turned = ghosts(host)[1] as UiGhost;
    expect(turned).toMatchObject({ type: "ui.ghost", ghost: "candidate", origin: [9, 64, 20], full: true });
    const t = ghostBlocks(turned);
    expect(t.size).toBe(7);
    expect(t.get("10,64,20")).toBe("minecraft:stone_bricks");
    expect(t.get("9,68,20")).toMatch(/^minecraft:oak_fence/);
    expect(t.get("9,67,20")).toMatch(/^minecraft:lantern/);

    // Another candidate replaces it: a full ghost under the same id.
    ok(await host.playerUiRequest(HOST, { kind: "candidates.ghost", args: { id: "c1", prefab: "park_bench", dimension: OVERWORLD, at: AT } }));
    await host.waitFor(() => ghosts(host).length === 3);
    const bench = ghosts(host)[2] as UiGhost;
    expect(bench).toMatchObject({ ghost: "candidate", origin: [10, 64, 20], full: true });
    expect([...ghostBlocks(bench)].map(([k, v]) => [k, v.replace(/\[.*/, "")])).toEqual([
      ["10,64,20", "minecraft:oak_trapdoor"],
      ["11,64,20", "minecraft:oak_stairs"],
      ["12,64,20", "minecraft:oak_stairs"],
      ["13,64,20", "minecraft:oak_stairs"],
      ["14,64,20", "minecraft:oak_trapdoor"],
    ]);

    // A resync sends it again, whole.
    ok(await host.playerUiRequest(HOST, { kind: "resync" }));
    await host.waitFor(() => ghosts(host).length === 4);
    expect(ghosts(host)[3]).toMatchObject({ ghost: "candidate", origin: [10, 64, 20], full: true });

    // Clearing sends one ui.ghost.clear; clearing again is {} and sends nothing.
    expect(ok(await host.playerUiRequest(HOST, { kind: "candidates.ghost.clear", args: {} }))).toEqual({});
    await host.waitFor(() => ghosts(host).length === 5);
    expect(ghosts(host)[4]).toEqual({ type: "ui.ghost.clear", players: [HOST.uuid], ghost: "candidate" });
    expect(ok(await host.playerUiRequest(HOST, { kind: "candidates.ghost.clear", args: {} }))).toEqual({});
    ok(await host.playerUiRequest(HOST, { kind: "resync" }));
    expect(ghosts(host)).toHaveLength(5);
  });

  it("refuses an unknown id or a prefab not in the list (not_found) and malformed arguments (bad_request), drawing nothing", async () => {
    const { host, call } = await setup();
    await call("world_reply", { lines: ["Pick"], candidates: [{ prefab: "park_bench" }] });
    const ghost = (args: Record<string, unknown>) => host.playerUiRequest(HOST, { kind: "candidates.ghost", args: { id: "c1", prefab: "park_bench", dimension: OVERWORLD, at: AT, ...args } });
    expect(await ghost({ id: "c9" })).toMatchObject({ ok: false, error: "not_found" });
    expect(await ghost({ prefab: "lamp_post" })).toMatchObject({ ok: false, error: "not_found" });
    expect(await ghost({ at: [1, 2] })).toMatchObject({ ok: false, error: "bad_request" });
    expect(await ghost({ at: [1, 2.5, 3] })).toMatchObject({ ok: false, error: "bad_request" });
    expect(await ghost({ rotate: 45 })).toMatchObject({ ok: false, error: "bad_request" });
    expect(await ghost({ dimension: "" })).toMatchObject({ ok: false, error: "bad_request" });
    expect(ghosts(host)).toHaveLength(0);
  });
});

describe("candidates.submit: picks as text (17, piece 5)", () => {
  const submit = (h: FakeHost, args: Record<string, unknown>) => h.playerUiRequest(HOST, { kind: "candidates.submit", args });
  const clears = (h: FakeHost) => h.ui.filter((m) => m.type === "ui.ghost.clear" && m.ghost === "candidate");
  const PICKS = [
    { prefab: "village_well", cell: "D1", label: "  town well " },
    { prefab: "park_bench", cell: "B1" },
  ];

  it("sends the picks as a channel event on the open request, with the set's reminder line, clears the ghost and marks the list answered", async () => {
    const { host, call, session, events } = await setup();
    await host.playerAsk(HOST, "a well and a bench?", {}, { mode: "ask" });
    await host.waitFor(() => inGame!.current?.id === 1);
    await call("prefab_sheet");
    await call("world_reply", { lines: ["These:"], candidates: [{ prefab: "village_well" }, { prefab: "park_bench" }, { prefab: "lamp_post" }] });
    session.componentSet.add([{ prefab: "small_oak_tree", label: "tree" }]);
    ok(await host.playerUiRequest(HOST, { kind: "candidates.ghost", args: { id: "c1", prefab: "village_well", dimension: "minecraft:overworld", at: [0, 64, 0] } }));
    const before = events.length;

    expect(ok(await submit(host, { id: "c1", picks: PICKS, note: "smaller if possible" }))).toEqual({ request: 1 });
    expect(events.slice(before)).toEqual([
      {
        content: 'Candidates answer from Dev (request 1): picked D1 village_well as "town well", B1 park_bench. Note: smaller if possible.\nset: tree = small_oak_tree',
        meta: { request: "1", player: "Dev" },
      },
    ]);
    await host.waitFor(() => clears(host).length === 1);
    // The request stays the same one, and the MCP never touched the set.
    expect(inGame!.current).toMatchObject({ id: 1, mode: "ask" });
    expect(session.componentSet.entries).toEqual([{ prefab: "small_oak_tree", label: "tree" }]);
    // Answered: open and submit say so, and nothing more is sent.
    expect(await host.playerUiRequest(HOST, { kind: "candidates.open", args: { id: "c1" } })).toMatchObject({ ok: false, error: "answered" });
    expect(await submit(host, { id: "c1", picks: PICKS })).toMatchObject({ ok: false, error: "answered" });
    expect(events).toHaveLength(before + 1);
  });

  it("reopens a closed request in its mode, under the same id, with the picks as its text", async () => {
    const { host, call, events } = await setup();
    await host.playerAsk(HOST, "which bench?", {}, { mode: "ask" });
    await host.waitFor(() => inGame!.current?.id === 1);
    await call("world_reply", { lines: ["One of these"], candidates: [{ prefab: "park_bench" }, { prefab: "lamp_post" }], done: true });
    await host.playerDone(HOST);
    await host.waitFor(() => !inGame!.heldRequest && !inGame!.current);
    const before = events.length;

    expect(ok(await submit(host, { id: "c1", picks: [{ prefab: "lamp_post", cell: "#2", label: "" }] }))).toEqual({ request: 1 });
    expect(events.slice(before)).toEqual([{ content: "Candidates answer from Dev (request 1): picked #2 lamp_post.", meta: { request: "1", player: "Dev" } }]);
    // Open again, in ask mode (held until the player ends it), with the question it answers.
    expect(inGame!.current).toMatchObject({ id: 1, mode: "ask", player: HOST, text: "which bench?" });
    expect(inGame!.heldRequest).toMatchObject({ id: 1, mode: "ask" });
    // The agent's answer goes to it.
    const r = await call("world_reply", { lines: ["Lamp post it is."] });
    expect(r.text).toContain("to Dev (request 1)");
  });

  it("reopens a closed build request as build", async () => {
    const { host, call } = await setup();
    await host.playerAsk(HOST, "a bench here", {});
    await host.waitFor(() => inGame!.current?.id === 1);
    await call("world_reply", { lines: ["Pick"], candidates: [{ prefab: "park_bench" }], done: true });
    expect(inGame!.current).toBeUndefined();
    expect(ok(await submit(host, { id: "c1", picks: [{ prefab: "park_bench", cell: "#1" }] }))).toEqual({ request: 1 });
    expect(inGame!.current).toMatchObject({ id: 1, mode: "build" });
    expect(inGame!.heldRequest).toBeUndefined();
  });

  it("answers a list that went to no request with an event naming none, opening nothing", async () => {
    const { host, call, events } = await setup();
    await call("world_reply", { lines: ["Pick"], candidates: [{ prefab: "park_bench" }] });
    const before = events.length;
    expect(ok(await submit(host, { id: "c1", picks: [{ prefab: "park_bench", cell: "#1" }] }))).toEqual({ request: null });
    expect(events.slice(before)).toEqual([{ content: "Candidates answer from Dev: picked #1 park_bench.", meta: { player: "Dev" } }]);
    expect(inGame!.current).toBeUndefined();
  });

  it("refuses bad picks, an unknown id, and an unreachable agent, sending nothing and leaving the list open", async () => {
    let listening = true;
    const { host, call, session, events } = await setup({ listening: () => listening });
    await call("world_reply", { lines: ["Pick"], candidates: [{ prefab: "park_bench" }, { prefab: "lamp_post" }] });
    const before = events.length;
    expect(await submit(host, { id: "c9", picks: [{ prefab: "park_bench", cell: "#1" }] })).toMatchObject({ ok: false, error: "not_found" });
    expect(await submit(host, { id: "c1", picks: [] })).toMatchObject({ ok: false, error: "bad_request" });
    expect(await submit(host, { id: "c1" })).toMatchObject({ ok: false, error: "bad_request" });
    expect(await submit(host, { id: "c1", picks: [{ prefab: "park_bench" }] })).toMatchObject({ ok: false, error: "bad_request" });
    expect(await submit(host, { id: "c1", picks: [{ prefab: "park_bench", cell: "#1" }, { prefab: "park_bench", cell: "#1" }] })).toMatchObject({ ok: false, error: "bad_request" });
    expect(await submit(host, { id: "c1", picks: [{ prefab: "village_well", cell: "#1" }] })).toMatchObject({ ok: false, error: "not_found" });
    expect(await submit(host, { id: "c1", picks: [{ prefab: "park_bench", cell: "#2" }] })).toMatchObject({ ok: false, error: "not_found" });
    expect(await submit(host, { id: "c1", picks: [{ prefab: "park_bench", cell: "#1" }], note: 3 })).toMatchObject({ ok: false, error: "bad_request" });
    listening = false;
    expect(await submit(host, { id: "c1", picks: [{ prefab: "park_bench", cell: "#1" }] })).toMatchObject({ ok: false, error: "internal" });
    expect(events).toHaveLength(before);
    expect(session.candidates.get("c1")!.answered).toBe(false);
    listening = true;
    expect(ok(await submit(host, { id: "c1", picks: [{ prefab: "park_bench", cell: "#1" }] }))).toEqual({ request: null });
  });
});
