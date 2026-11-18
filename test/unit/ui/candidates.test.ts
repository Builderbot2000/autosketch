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
import { CANDIDATES_MAX, type ChatMessage, type PlayerRef, type UiResult, type WireBox } from "../../../src/world/protocol/messages.js";
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

async function setup(opts: { features?: string[] } = {}) {
  host = await FakeHost.start({ volumes: { work: WORK }, ...(opts.features ? { features: opts.features } : {}) });
  const ctx = await libraryContext(host.instanceDir);
  const workspace = await tempDir("autosketch-cand-ws-");
  const session = new Session(workspace);
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
    notify: async () => {},
    listening: () => true,
    touch: () => session.touch(),
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
  return { session, host, call };
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

  it("candidates.open answers not_found for an unknown id, bad_request without one, and answered after a submit", async () => {
    const { host, call, session } = await setup();
    await call("world_reply", { lines: ["Pick"], candidates: [{ prefab: "park_bench" }] });
    expect(await host.playerUiRequest(HOST, { kind: "candidates.open", args: { id: "c9" } })).toMatchObject({ ok: false, error: "not_found" });
    expect(await host.playerUiRequest(HOST, { kind: "candidates.open", args: {} })).toMatchObject({ ok: false, error: "bad_request" });
    session.candidates.get("c1")!.answered = true; // what a submit does (Q3)
    expect(await host.playerUiRequest(HOST, { kind: "candidates.open", args: { id: "c1" } })).toMatchObject({ ok: false, error: "answered" });
  });
});
