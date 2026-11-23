import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readConfig } from "../../../src/core/config.js";
import { Settings } from "../../../src/core/settings.js";
import { libraryRoots } from "../../../src/library/roots.js";
import { createServer } from "../../../src/server/server.js";
import { Session } from "../../../src/server/session.js";
import { startUi, type UiCore } from "../../../src/ui/index.js";
import { LiveLink } from "../../../src/world/live-link.js";
import { CHANNEL_INSTRUCTIONS, InGameRequests } from "../../../src/world/prompt.js";
import type { ChatMessage, PlayerRef, UiResult, WireBox } from "../../../src/world/protocol/messages.js";
import { autoSyncHook, syncLink } from "../../../src/world/sync.js";
import { FakeHost } from "../../support/fake-host.js";
import { tempDir } from "../../helpers/fixtures.js";
import { libraryContext } from "../library/fixture.js";
// Every area that declares settings, so the registry is the server's.
import "../../../src/assets/settings.js";
import "../../../src/server/settings.js";
import "../../../src/world/settings.js";

/**
 * `world_reply({choices})` and `choices.pick` (18, piece 7) against the fake host: one chat message
 * per clickable choice line, numbered plain lines without the UI, the click and a typed number as
 * the player's answer in text, and the question's single answer (briefs/select/P, step P2).
 */

const WORK: WireBox = { min: [100, 64, -200], max: [115, 79, -185] };
const HOST: PlayerRef = { name: "Dev", uuid: "00000000-0000-4000-8000-000000000001" };

let base: string;
beforeAll(async () => {
  base = await tempDir("autosketch-choice-");
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
  const workspace = await tempDir("autosketch-choice-ws-");
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
    choices: session.choices,
  });
  inGame = g;
  session.inGame = g;
  session.callHooks.push(g.modeRule);
  const configPath = join(await tempDir("autosketch-choice-home-"), "config.toml");
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
    choices: session.choices,
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
const pick = (h: FakeHost, args: Record<string, unknown>) => h.playerUiRequest(HOST, { kind: "choices.pick", args });

describe("world_reply choices (18, piece 7)", () => {
  it("sends the question, then one clickable message per choice, then the free-text line", async () => {
    const { host, call, session } = await setup();
    await host.playerAsk(HOST, "find my house", {}, { mode: "select" });
    await host.waitFor(() => inGame!.current?.id === 1);
    const r = await call("world_reply", { lines: ["Which one?"], choices: ["mossy house, 40 blocks north-east", "ruin 180 blocks west"] });
    expect(r.text).toBe("ok · world_reply · 1 line to Dev (request 1) · choices q1: 2 clickable lines; the answer comes back as an event");
    await host.waitFor(() => replies(host).length === 4);
    expect(replies(host).map((c) => ({ request: c.request, player: c.player, lines: c.lines, action: c.action }))).toEqual([
      { request: 1, player: HOST.uuid, lines: ["Which one?"], action: undefined },
      { request: 1, player: HOST.uuid, lines: ["[1] mossy house, 40 blocks north-east"], action: { line: 0, kind: "choices.pick", args: { id: "q1", index: 0 } } },
      { request: 1, player: HOST.uuid, lines: ["[2] ruin 180 blocks west"], action: { line: 0, kind: "choices.pick", args: { id: "q1", index: 1 } } },
      { request: 1, player: HOST.uuid, lines: ["or type your own answer"], action: undefined },
    ]);
    expect(session.choices.get("q1")).toMatchObject({ request: 1, mode: "select", question: "Which one?", choices: ["mossy house, 40 blocks north-east", "ruin 180 blocks west"], answered: false });
  });

  it("numbers the choices as plain lines in one message when the mod has no in-game UI", async () => {
    const { host, call } = await setup({ features: ["modes", "select"] });
    await host.playerAsk(HOST, "which?", {}, { mode: "ask" });
    await host.waitFor(() => inGame!.current?.id === 1);
    const r = await call("world_reply", { lines: ["Which one?"], choices: ["a", "b", "c"] });
    expect(r.text).toContain("choices q1: 3 numbered plain lines (the mod has no in-game UI; the player types the number)");
    await host.waitFor(() => replies(host).length === 1);
    expect(replies(host)[0]!.lines).toEqual(["Which one?", "[1] a", "[2] b", "[3] c", "Answer with the number (/autosketch ask 2), or type your own answer."]);
    expect(replies(host)[0]!.action).toBeUndefined();
  });

  it("closes the request only after the last choice message when done", async () => {
    const { host, call } = await setup();
    await host.playerAsk(HOST, "which?", {}, { mode: "ask" });
    await host.waitFor(() => inGame!.current?.id === 1);
    const r = await call("world_reply", { lines: ["Which?"], choices: ["a", "b"], done: true });
    expect(r.text).toContain("request answered; its ask mode stays in force");
    await host.waitFor(() => replies(host).length === 4);
    expect(replies(host).every((c) => c.request === 1 && c.player === HOST.uuid)).toBe(true);
    expect(inGame!.current).toBeUndefined();
  });

  it("refuses more than the protocol's choices", async () => {
    const { call } = await setup();
    const r = await call("world_reply", { lines: ["?"], choices: Array.from({ length: 10 }, (_, i) => `c${i}`) });
    expect(r.isError).toBe(true);
  });
});

describe("choices.pick and typed numbers (18, piece 7)", () => {
  it("sends the clicked choice's text on the open request with the set's reminder line, then answers answered", async () => {
    const { host, call, session, events } = await setup();
    await host.playerAsk(HOST, "find my house", {}, { mode: "select" });
    await host.waitFor(() => inGame!.current?.id === 1);
    await call("world_reply", { lines: ["Which house?"], choices: ["mossy house", "ruin 180 blocks west"] });
    await host.waitFor(() => replies(host).length === 4);
    session.componentSet.add([{ prefab: "small_oak_tree", label: "tree" }]);
    const before = events.length;

    expect(ok(await host.playerClick(HOST, replies(host)[2]!))).toEqual({ request: 1 });
    expect(events.slice(before)).toEqual([{ content: 'Choice answer from Dev (request 1) to "Which house?": [2] "ruin 180 blocks west".\nset: tree = small_oak_tree', meta: { request: "1", player: "Dev" } }]);
    expect(inGame!.current).toMatchObject({ id: 1, mode: "select" });
    expect(session.choices.get("q1")!.answered).toBe(true);
    expect(await pick(host, { id: "q1", index: 0 })).toMatchObject({ ok: false, error: "answered" });
    expect(events).toHaveLength(before + 1);
  });

  it("reopens a closed request in its mode under the same id", async () => {
    const { host, call, events } = await setup();
    await host.playerAsk(HOST, "which tower?", {}, { mode: "ask" });
    await host.waitFor(() => inGame!.current?.id === 1);
    await call("world_reply", { lines: ["Which?"], choices: ["north", "south"], done: true });
    await host.playerDone(HOST);
    await host.waitFor(() => !inGame!.heldRequest && !inGame!.current);
    const before = events.length;
    expect(ok(await pick(host, { id: "q1", index: 0 }))).toEqual({ request: 1 });
    expect(events.slice(before)).toEqual([{ content: 'Choice answer from Dev (request 1) to "Which?": [1] "north".', meta: { request: "1", player: "Dev" } }]);
    expect(inGame!.current).toMatchObject({ id: 1, mode: "ask", text: "Which?" });
    expect(inGame!.heldRequest).toMatchObject({ id: 1, mode: "ask" });
  });

  it("answers not_found for an unknown id or index, bad_request for a malformed one, and stays unanswered when delivery fails", async () => {
    let listening = true;
    const { host, call, session } = await setup({ listening: () => listening });
    await call("world_reply", { lines: ["?"], choices: ["a", "b"] });
    expect(await pick(host, { id: "q9", index: 0 })).toMatchObject({ ok: false, error: "not_found" });
    expect(await pick(host, { id: "q1", index: 2 })).toMatchObject({ ok: false, error: "not_found" });
    expect(await pick(host, { id: "q1", index: -1 })).toMatchObject({ ok: false, error: "bad_request" });
    expect(await pick(host, { id: "q1", index: 0.5 })).toMatchObject({ ok: false, error: "bad_request" });
    expect(await pick(host, { index: 0 })).toMatchObject({ ok: false, error: "bad_request" });
    listening = false;
    expect(await pick(host, { id: "q1", index: 0 })).toMatchObject({ ok: false, error: "internal" });
    expect(session.choices.get("q1")!.answered).toBe(false);
  });

  it("answers a question that went to no request with an event naming none", async () => {
    const { host, call, events } = await setup();
    await call("world_reply", { lines: ["?"], choices: ["a"] });
    const before = events.length;
    expect(ok(await pick(host, { id: "q1", index: 0 }))).toEqual({ request: null });
    expect(events.slice(before)).toEqual([{ content: 'Choice answer from Dev to "?": [1] "a".', meta: { player: "Dev" } }]);
    expect(inGame!.current).toBeUndefined();
  });

  it("takes a typed number as the choice on the open question, keeping the request and its held mode", async () => {
    const { host, call, session, events } = await setup({ features: ["modes", "select"] });
    await host.playerAsk(HOST, "find my house", {}, { mode: "ask" });
    await host.waitFor(() => inGame!.current?.id === 1);
    await call("world_reply", { lines: ["Which house?"], choices: ["mossy house", "ruin"] });
    const before = events.length;
    expect(await host.playerAsk(HOST, " 2 ", {}, { mode: "ask" })).toMatchObject({ delivered: true, id: 2 });
    expect(events.slice(before)).toEqual([{ content: 'Choice answer from Dev (request 1) to "Which house?": [2] "ruin".', meta: { request: "1", player: "Dev" } }]);
    expect(inGame!.current).toMatchObject({ id: 1 });
    expect(inGame!.heldRequest).toMatchObject({ id: 1, mode: "ask" });
    expect(session.choices.get("q1")!.answered).toBe(true);
    // Answered: the next digit is a request of its own.
    await host.playerAsk(HOST, "1", {}, { mode: "ask" });
    expect(events.at(-1)!.content).not.toContain("Choice answer");
    expect(inGame!.current).toMatchObject({ id: 3 });
  });

  it("leaves a typed number past the choices, or with no open question, as a request", async () => {
    const { host, call, events } = await setup();
    await host.playerAsk(HOST, "which?", {}, { mode: "ask" });
    await host.waitFor(() => inGame!.current?.id === 1);
    await call("world_reply", { lines: ["Which?"], choices: ["a", "b"] });
    await host.playerAsk(HOST, "3", {}, { mode: "ask" });
    expect(events.at(-1)!.content).not.toContain("Choice answer");
    expect(inGame!.current).toMatchObject({ id: 2 });
  });
});
