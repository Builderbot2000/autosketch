import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readConfig } from "../../../src/core/config.js";
import { Settings } from "../../../src/core/settings.js";
import { libraryFor, rootsFor } from "../../../src/server/tools/library-context.js";
import { startUi, type UiCore } from "../../../src/ui/index.js";
import { InGameRequests } from "../../../src/world/prompt.js";
import {
  MCP_FEATURES,
  type ChatMessage,
  type PlayerRef,
  type PromptMessage,
  type RequestMode,
  type UiFlashMessage,
  type UiGhost,
  type UiGhostClear,
  type UiMcpMessage,
  type UiResult,
} from "../../../src/world/protocol/messages.js";
import { ENABLED, instanceContext, rcon, setVolumes, startMcp, until, worldBlocks, type Mcp, type Vec3 } from "./harness.js";
import type { Rcon } from "./rcon.js";
// Every area that declares settings, so the settings rows are the server's.
import "../../../src/assets/settings.js";
import "../../../src/server/settings.js";
import "../../../src/world/settings.js";

/**
 * The end-to-end test of reusable components (docs/design/17, *The workflow* and *Testing*, end to
 * end; docs/briefs/components/Z-end-to-end.md, step Z1) against the running server with the mod.
 *
 * The world tier has a server and no game client, and the mod's relay forwards a client's request
 * only from a connected player whose client registered `autosketch:ui` (`UiRelay.clientRequest`),
 * so a headless server can't originate one. The test therefore stands in for the client and the
 * relay at the MCP's edge, as requests.test.ts does for `prompt`: it hands the MCP the `ui.request`
 * the relay would forward (the player set from the connection, the args the clicked line's action
 * names) and reads the `ui.result`, `chat`, `ui.flash` and `ui.ghost*` the MCP sends over the real
 * bridge to the real mod. Everything the agent does goes through the MCP tools, and the blocks are
 * read back from the world. The client half (the line's click, the screen) is the client harness's
 * `candidates` suite (`17`, *Testing*, mod).
 */

const X0 = 9008; // chunk-aligned, away from the other files' areas (scenarios 1000–1600, measure 3000–3256, volatile 5000, requests 7008–7160)
const Z0 = 1008;
const WORK = { min: [X0, -61, Z0] as Vec3, max: [X0 + 15, -50, Z0 + 15] as Vec3 };
const P: PlayerRef = { name: "E2E", uuid: "e2e00000-0000-4000-8000-000000000017" };
const OW = "minecraft:overworld";
const NAME = "e2e_corner_tower";

/** The MCP wired as `server/index.ts` wires it for in-game requests and the in-game UI, with everything it sends recorded. */
interface Wired {
  mcp: Mcp;
  inGame: InGameRequests;
  ui: UiCore;
  /** Channel events the agent received. */
  events: { content: string; meta: Record<string, string> }[];
  /** Messages the MCP sent to the mod. */
  sent: (UiMcpMessage | ChatMessage)[];
  prompt(mode: RequestMode, text: string): Promise<{ id: number; text: string }>;
  /** A player's `ui.request` as the relay forwards it; resolves with the `ui.result` sent back. */
  uiRequest(kind: string, args: Record<string, unknown>): Promise<UiResult>;
  close(): Promise<void>;
}

let nextPrompt = 17_000;
let nextUi = 17_000;

async function wire(): Promise<Wired> {
  const ctx = await instanceContext();
  const mcp = await startMcp({ features: [...MCP_FEATURES] });
  const sent: (UiMcpMessage | ChatMessage)[] = [];
  const bridge = mcp.link.bridge;
  const send = bridge.send.bind(bridge);
  bridge.send = (m) => {
    sent.push(m as UiMcpMessage | ChatMessage);
    send(m);
  };
  const events: Wired["events"] = [];
  const inGame = new InGameRequests(mcp.link, {
    promptPlayers: [P.name],
    idleMs: 600_000,
    activityMs: 0,
    subscribe: (fn) => mcp.session.subscribe(fn),
    notify: async (content, meta) => void events.push({ content, meta: meta as Record<string, string> }),
    listening: () => true,
    host: mcp.session,
    palettes: () => ctx.book,
    componentSet: mcp.session.componentSet,
    log: () => {},
  });
  mcp.session.inGame = inGame;
  mcp.session.callHooks.push(inGame.modeRule);
  const configPath = join(mcp.workspace, "config.toml");
  const ui = startUi({
    bridge,
    subscribe: (fn) => mcp.session.subscribe(fn),
    workspace: mcp.workspace,
    sessionId: "e2e-components",
    settings: Settings.from([], {}, readConfig(configPath)),
    configPath,
    // A UUID entry, so the overlay set holds the player before any request of theirs (13, *In-game UI*, Players).
    promptPlayers: () => [P.uuid],
    library: {
      roots: () => rootsFor(mcp.session, ctx),
      thumbnail: (p) => libraryFor(ctx, mcp.session).thumbnail(p),
      registry: () => ctx.registry,
      paletteIndex: () => ctx.palette,
    },
    candidates: mcp.session.candidates,
    stateOverrides: () => ctx.plugins.flatMap((pl) => (pl.rotate ? [pl.rotate.bind(pl)] : [])),
    baseDoc: () => mcp.session.doc,
    scopes: mcp.session.scopes,
    linkFrame: () => (mcp.link.volumes ? { dimension: mcp.link.volumes.dimension, origin: mcp.link.volumes.origin } : undefined),
    inGame: () => inGame,
    log: () => {},
  });
  mcp.session.saveFlash = (box, doc) => ui.feed.saveFlash(box, doc);
  await until(() => bridge.connected && bridge.ui, 30_000, "the bridge with ui in both hellos");
  return {
    mcp,
    inGame,
    ui,
    events,
    sent,
    async prompt(mode, text) {
      const at = [X0 + 8, -60, Z0 + 8];
      const m: PromptMessage = {
        type: "prompt",
        id: ++nextPrompt,
        player: P,
        text,
        context: { dimension: OW, position: [at[0]! + 0.5, at[1]!, at[2]! + 0.5], eye: [at[0]! + 0.5, at[1]! + 1.62, at[2]! + 0.5], yaw: 0, pitch: 30, facing: "south" },
        mode,
      };
      const n = events.length;
      await inGame.onPrompt(m);
      expect(events.length).toBe(n + 1);
      return { id: m.id, text: events.at(-1)!.content };
    },
    async uiRequest(kind, args) {
      const request = ++nextUi;
      await ui.requests.handle({ type: "ui.request", request, player: P, kind, args });
      const r = sent.find((m): m is UiResult => m.type === "ui.result" && m.request === request);
      if (!r) throw new Error(`no ui.result for ${kind}`);
      return r;
    },
    async close() {
      ui.close();
      inGame.close();
      await mcp.close();
    },
  };
}

const ok = (r: UiResult) => {
  if (!r.ok) throw new Error(`${r.error}: ${r.message}`);
  return r.result;
};

describe.skipIf(!ENABLED)("e2e world: reusable components (17)", () => {
  let r: Rcon;
  let library: string;
  let w: Wired | undefined;

  beforeAll(async () => {
    await instanceContext();
    // One user library for both sessions, as a player's library outlives a session.
    library = mkdtempSync(join(tmpdir(), "autosketch-e2e-library-"));
    vi.stubEnv("AUTOSKETCH_LIBRARY", library);
    r = await rcon();
    await r.command(`forceload add ${X0 - 16} ${Z0 - 16} ${X0 + 32} ${Z0 + 32}`);
    const out = await r.command(`fill ${X0 - 4} -60 ${Z0 - 4} ${X0 + 20} -40 ${Z0 + 20} minecraft:air`);
    if (/maximum|not loaded/i.test(out)) throw new Error(`clearing failed: ${out}`);
  }, 300_000);

  afterAll(async () => {
    await r?.command("autosketch clear").catch(() => {});
    await w?.close();
    r?.close();
    vi.unstubAllEnvs();
    rmSync(library, { recursive: true, force: true });
  }, 60_000);

  it("saves a component with a flash, finds it in a fresh session, picks it through the candidates requests, and stamps it by label with one undo", async () => {
    // ── Session 1: build and save (workflow steps 1 and 2). ──
    w = await wire();
    await setVolumes(r, WORK, undefined, w.mcp.link);
    expect(await w.mcp.call("doc_open", { world: true })).toContain("Linked to the world");
    await w.mcp.call("fill", { box: { min: [2, 1, 2], max: [4, 4, 4] }, pattern: "minecraft:stone_bricks" });
    await w.mcp.call("set_blocks", { blocks: [{ pos: [3, 5, 3], block: "minecraft:gold_block" }, { pos: [3, 4, 1], block: "minecraft:stone_brick_stairs[facing=south]" }] });
    const tower = await worldBlocks(w.mcp.link, [X0 + 2, -60, Z0 + 1], [X0 + 4, -56, Z0 + 4]);
    expect(tower.states.get(`${X0 + 3},-56,${Z0 + 3}`)).toBe("minecraft:gold_block");
    const saved = await w.mcp.call("prefab_save", { name: NAME, box: { min: [2, 1, 1], max: [4, 5, 4] }, tags: ["tower", "corner"], notes: "a small stone tower" });
    expect(saved).toContain(`saved prefab "${NAME}"`);
    // The flash on save (piece 8): the saved box, in world coordinates, white, under the job "save".
    await until(() => w!.sent.some((m) => m.type === "ui.flash" && m.flashes.some((f) => f.job === "save")), 5_000, "the save flash");
    const flash = (w.sent.find((m) => m.type === "ui.flash" && m.flashes.some((f) => f.job === "save")) as UiFlashMessage).flashes.find((f) => f.job === "save")!;
    expect(flash).toEqual({ job: "save", colour: "#ffffff", dimension: OW, boxes: [{ min: [X0 + 2, -60, Z0 + 1], max: [X0 + 4, -56, Z0 + 4] }] });
    expect((w.sent.find((m) => m.type === "ui.flash") as UiFlashMessage).players).toEqual([P.uuid]);
    await w.close();
    w = undefined;

    // ── Session 2, fresh: search and offer (step 3). ──
    w = await wire();
    await setVolumes(r, WORK, undefined, w.mcp.link);
    expect(await w.mcp.call("doc_open", { world: true })).toContain("Linked to the world");
    expect(w.mcp.session.componentSet.entries.length).toBe(0);
    const ask = await w.prompt("ask", "show me a tower");
    expect(ask.text).toMatch(/^In-game ask request from E2E: "show me a tower"/);
    expect(ask.text).not.toContain("set:");
    const found = await w.mcp.call("prefab_search", { query: "tower" });
    expect(found).toContain(NAME);
    const sheet = await w.mcp.call("prefab_sheet", { query: "tower" });
    const cell = new RegExp(`\\b([A-Z]\\d+) ${NAME}\\b`).exec(sheet)?.[1];
    expect(cell, sheet).toBeDefined();
    const reply = await w.mcp.call("world_reply", { lines: ["One tower in your library fits."], candidates: [{ prefab: NAME }], done: true });
    expect(reply).toContain(`candidates c1: ${cell} ${NAME} (clickable line added)`);
    const chat = w.sent.find((m): m is ChatMessage => m.type === "chat" && m.kind === "reply" && m.lines.includes("One tower in your library fits."));
    expect(chat).toMatchObject({ request: ask.id, player: P.uuid, lines: ["One tower in your library fits.", "[Show candidates (1)]"], action: { line: 1, kind: "candidates.open", args: { id: "c1" } } });

    // ── The player clicks the line, previews, picks, labels and submits (step 4). ──
    const opened = ok(await w.uiRequest(chat!.action!.kind, chat!.action!.args));
    expect(opened).toEqual({ id: "c1", request: ask.id, question: "show me a tower", entries: [{ cell, prefab: NAME, root: "user", size: [3, 4, 5], tags: ["tower", "corner"], notes: "a small stone tower" }] });
    // Preview here: the candidate ghost at the block the player looks at.
    const look: Vec3 = [X0 + 10, -60, Z0 + 10];
    ok(await w.uiRequest("candidates.ghost", { id: "c1", prefab: NAME, dimension: OW, at: look }));
    await until(() => w!.sent.some((m) => m.type === "ui.ghost" && m.ghost === "candidate"), 5_000, "the candidate ghost");
    expect(w.sent.find((m): m is UiGhost => m.type === "ui.ghost" && m.ghost === "candidate")).toMatchObject({ players: [P.uuid], dimension: OW, origin: look, full: true });
    const before = w.events.length;
    const submitted = ok(await w.uiRequest("candidates.submit", { id: "c1", picks: [{ prefab: NAME, cell, label: "corner tower" }] }));
    expect(submitted).toEqual({ request: ask.id });
    await until(() => w!.sent.some((m): m is UiGhostClear => m.type === "ui.ghost.clear" && m.ghost === "candidate"), 5_000, "the ghost cleared on submit");

    // ── The agent receives exactly piece 5's text (step 4, end). ──
    expect(w.events.slice(before)).toEqual([{ content: `Candidates answer from E2E (request ${ask.id}): picked ${cell} ${NAME} as "corner tower".`, meta: { request: String(ask.id), player: "E2E" } }]);
    expect(w.mcp.session.componentSet.entries.length).toBe(0); // the screen never writes the set
    expect(await w.uiRequest("candidates.open", { id: "c1" })).toMatchObject({ ok: false, error: "answered" });

    // ── Use (step 5): the agent records the pick, the player asks for it, the agent stamps it by label. ──
    expect(await w.mcp.call("component_set", { add: [{ prefab: NAME, label: "corner tower" }] })).toContain("corner tower");
    const build = await w.prompt("build", "put the corner tower here");
    expect(build.text.split("\n").at(-1)).toBe(`set: corner tower = ${NAME}`);
    const at: Vec3 = [10, 1, 10];
    const stamped = await w.mcp.call("stamp", { prefab: "corner tower", at });
    expect(stamped).toContain(`prefab ${NAME} at`);
    expect(stamped).toMatch(/world: \d+ placed, 0 skipped \(hand-edited\), 0 rejected/);
    // Block for block: the stamp in the world is the saved tower, moved by (8, 0, 9).
    const dx = 8, dz = 9;
    const placed = await worldBlocks(w.mcp.link, [X0 + 10, -60, Z0 + 10], [X0 + 12, -56, Z0 + 13]);
    const diffs: string[] = [];
    for (const [k, s] of tower.states) {
      const [x, y, z] = k.split(",").map(Number) as Vec3;
      const got = placed.states.get(`${x + dx},${y},${z + dz}`);
      if (got !== s) diffs.push(`${x + dx},${y},${z + dz}: ${got} (saved ${s})`);
    }
    expect(diffs).toEqual([]);
    expect([...placed.states.values()].filter((s) => s !== "minecraft:air").length).toBe(3 * 4 * 3 + 2);

    // ── One undo removes it. ──
    await w.mcp.call("undo");
    const after = await worldBlocks(w.mcp.link, [X0 + 10, -60, Z0 + 10], [X0 + 12, -56, Z0 + 13]);
    expect([...after.states.values()].every((s) => s === "minecraft:air")).toBe(true);
    // The saved original is untouched.
    expect((await worldBlocks(w.mcp.link, [X0 + 3, -56, Z0 + 3], [X0 + 3, -56, Z0 + 3])).states.get(`${X0 + 3},-56,${Z0 + 3}`)).toBe("minecraft:gold_block");
    await w.mcp.call("world_reply", { lines: ["Placed the corner tower."], done: true });
  }, 300_000);
});
