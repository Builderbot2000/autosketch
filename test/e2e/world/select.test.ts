import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readConfig } from "../../../src/core/config.js";
import { Settings } from "../../../src/core/settings.js";
import { resolveSelection } from "../../../src/ops/selection.js";
import { worldCandidate } from "../../../src/server/world-candidate.js";
import { startUi, type UiCore } from "../../../src/ui/index.js";
import { InGameRequests } from "../../../src/world/prompt.js";
import {
  MCP_FEATURES,
  type ChatMessage,
  type ModMessage,
  type PlayerRef,
  type PromptMessage,
  type UiFlashMessage,
  type UiMcpMessage,
  type UiResult,
  type UiState,
} from "../../../src/world/protocol/messages.js";
import { resolveMaterials } from "../../../src/world/select/materials.js";
import { WorldSelect } from "../../../src/world/select/select.js";
import { WorldView } from "../../../src/world/view.js";
import { ENABLED, instanceContext, rcon, startMcp, until, worldBlocks, type Mcp, type Vec3 } from "./harness.js";
import type { Rcon } from "./rcon.js";
import "../../../src/assets/settings.js";
import "../../../src/server/settings.js";
import "../../../src/world/settings.js";

/**
 * The end-to-end test of select (docs/design/18-select.md, *Testing*, end to end; step Z2): "select
 * the mossy stone brick house" on the flat e2e world, with two candidate houses and a ruin that the
 * test builds itself (original builds, `02` *Legal stance*), through search, choices, fill, expand,
 * the faded render, a trim and the confirmed volumes, against the running server with the mod.
 *
 * The world tier has no player, so the test stands in for the player at the MCP's edge, as `17`'s
 * components test and requests.test.ts do: the `prompt` (mode `select`) and the `prompt.close` of
 * `/autosketch done` are dispatched on the bridge as the mod would deliver them, the clicked choice
 * lines as the `ui.request` `choices.pick` the relay forwards, and the select grant the prompt would
 * fix comes from `/autosketch measure grant` (console/RCON, Z1). Everything the agent does goes
 * through the MCP tools; search, fill, expand, reads and volumes are the real mod's. The expected
 * blocks come from the fixture's own model, checked against the world after it is built.
 */

const X0 = 13008; // chunk-aligned, away from the other files' areas (scenarios 1000–1600, measure 3000–3256, volatile 5000, requests 7008–7160, components 9008)
const Z0 = 1008;
const GROUND = -60; // first air layer of the flat world
const P: PlayerRef = { name: "E2E", uuid: "e2e00000-0000-4000-8000-000000000018" };
const OW = "minecraft:overworld";
const PLAYER: Vec3 = [X0 + 8, GROUND, Z0 + 8];
const GRANT_RADIUS = 16;
const WORDS = "select the mossy stone brick house";

// ── The fixture: three original builds as fill boxes, applied in order (air erases) ────────────

type Op = [min: Vec3, max: Vec3, block: string];
const mc = (id: string) => `minecraft:${id}`;

/** House A, the one meant: mossy stone brick walls, chiseled corners, spruce floor and roof, glass panes, a door, and a stone brick garden wall running east (a leak to trim). */
const A: Vec3 = [X0 + 36, GROUND, Z0 - 38];
const A_SIZE: Vec3 = [11, 7, 9];
function houseA(): Op[] {
  const [x, y, z] = A;
  const [w, , d] = A_SIZE;
  const ops: Op[] = [
    [[x, y, z], [x + w - 1, y, z + d - 1], mc("spruce_planks")],
    [[x, y + 1, z], [x + w - 1, y + 5, z + d - 1], mc("mossy_stone_bricks")],
    [[x + 1, y + 1, z + 1], [x + w - 2, y + 5, z + d - 2], mc("air")],
    [[x + 5, y + 1, z + d - 1], [x + 5, y + 2, z + d - 1], mc("air")],
    [[x, y + 6, z], [x + w - 1, y + 6, z + d - 1], mc("spruce_planks")],
  ];
  for (const [cx, cz] of [[x, z], [x + w - 1, z], [x, z + d - 1], [x + w - 1, z + d - 1]] as const) ops.push([[cx, y + 1, cz], [cx, y + 5, cz], mc("chiseled_stone_bricks")]);
  for (const p of [[x, y + 3, z + 4], [x + w - 1, y + 3, z + 4], [x + 3, y + 3, z], [x + 7, y + 3, z]] as Vec3[]) ops.push([p, p, mc("glass_pane")]);
  return ops;
}
/** The garden wall: from House A's east side 12 blocks east, two high, into the next chunk. */
const GARDEN: Op = [[A[0] + A_SIZE[0], GROUND, A[2] + 4], [A[0] + A_SIZE[0] + 11, GROUND + 1, A[2] + 4], mc("stone_brick_wall")];

/** House B, a plain stone brick house to the south: stone and cracked stone bricks, oak floor and roof. */
const B: Vec3 = [X0 + 2, GROUND, Z0 + 88];
function houseB(): Op[] {
  const [x, y, z] = B;
  const ops: Op[] = [
    [[x, y, z], [x + 8, y, z + 6], mc("oak_planks")],
    [[x, y + 1, z], [x + 8, y + 4, z + 6], mc("stone_bricks")],
    [[x + 1, y + 1, z + 1], [x + 7, y + 4, z + 5], mc("air")],
    [[x + 4, y + 1, z], [x + 4, y + 2, z], mc("air")],
    [[x, y + 5, z], [x + 8, y + 5, z + 6], mc("oak_planks")],
  ];
  for (const [cx, cz] of [[x, z], [x + 8, z], [x, z + 6], [x + 8, z + 6]] as const) ops.push([[cx, y + 1, cz], [cx, y + 4, cz], mc("cracked_stone_bricks")]);
  return ops;
}

/** The ruin, to the west: broken mossy stone brick and mossy cobblestone walls, no roof. */
const R: Vec3 = [X0 - 112, GROUND, Z0 + 2];
function ruin(): Op[] {
  const [x, y, z] = R;
  return [
    [[x, y, z], [x + 8, y + 2, z + 6], mc("mossy_stone_bricks")],
    [[x + 1, y, z + 1], [x + 7, y + 2, z + 5], mc("air")],
    [[x + 3, y + 1, z], [x + 6, y + 2, z], mc("air")],
    [[x + 8, y + 2, z + 2], [x + 8, y + 2, z + 6], mc("air")],
    [[x, y, z + 6], [x + 4, y + 1, z + 6], mc("mossy_cobblestone")],
    [[x + 2, y + 2, z + 6], [x + 4, y + 2, z + 6], mc("air")],
    [[x, y + 3, z], [x, y + 4, z], mc("cracked_stone_bricks")],
  ];
}

const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
/** The non-air blocks a list of ops leaves, by position (ids only: panes and walls take states from their neighbours). */
function model(ops: Op[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const [min, max, b] of ops)
    for (let x = min[0]; x <= max[0]; x++) for (let y = min[1]; y <= max[1]; y++) for (let z = min[2]; z <= max[2]; z++) b === "minecraft:air" ? m.delete(key(x, y, z)) : m.set(key(x, y, z), b);
  return m;
}
const HOUSE_A = model(houseA());
const WITH_GARDEN = model([...houseA(), GARDEN]);
const HOUSE_B = model(houseB());
const RUIN = model(ruin());

/** The inclusive box of a model's blocks. */
function boxOf(m: Map<string, string>): { min: Vec3; max: Vec3 } {
  const ps = [...m.keys()].map((k) => k.split(",").map(Number) as Vec3);
  const min = [0, 1, 2].map((i) => Math.min(...ps.map((p) => p[i]!))) as Vec3;
  const max = [0, 1, 2].map((i) => Math.max(...ps.map((p) => p[i]!))) as Vec3;
  return { min, max };
}

// ── The MCP, wired as server/index.ts wires it for select ─────────────────────────────────────

interface Wired {
  mcp: Mcp;
  inGame: InGameRequests;
  ui: UiCore;
  view: WorldView;
  events: { content: string; meta: Record<string, string> }[];
  sent: (UiMcpMessage | ChatMessage)[];
  /** A message from the mod, delivered as the bridge delivers what it reads off the socket. */
  fromMod(m: ModMessage): void;
  uiRequest(kind: string, args: Record<string, unknown>): Promise<UiResult>;
  close(): Promise<void>;
}

let nextUi = 18_000;

async function wire(): Promise<Wired> {
  const ctx = await instanceContext();
  const mcp = await startMcp({ features: [...MCP_FEATURES] });
  const { session, link } = mcp;
  const bridge = link.bridge;
  const sent: Wired["sent"] = [];
  const send = bridge.send.bind(bridge);
  bridge.send = (m) => {
    sent.push(m as UiMcpMessage | ChatMessage);
    send(m);
  };
  const events: Wired["events"] = [];
  const inGame = new InGameRequests(link, {
    promptPlayers: [P.name],
    idleMs: 600_000,
    activityMs: 0,
    subscribe: (fn) => session.subscribe(fn),
    notify: async (content, meta) => void events.push({ content, meta: meta as Record<string, string> }),
    listening: () => true,
    componentSet: session.componentSet,
    choices: session.choices,
    log: () => {},
  });
  session.inGame = inGame;
  session.callHooks.push(inGame.modeRule);
  const request = () => inGame.heldRequest?.id ?? inGame.current?.id;
  const view = new WorldView({ bridge, request, dimension: () => link.volumes?.dimension, dataVersion: () => bridge.hello?.game.dataVersion ?? 0, palettes: () => ctx.book });
  session.worldView = view;
  session.worldSelect = new WorldSelect({
    bridge,
    request,
    context: () => view.context,
    dimension: () => link.volumes?.dimension,
    view: () => view,
    linked: () => (link.state === "linked" && link.doc && link.volumes ? { doc: link.doc, origin: link.volumes.origin, dimension: link.volumes.dimension, work: link.volumes.work } : undefined),
    subscribe: (fn) => session.subscribe(fn),
    autoLink: false,
  });
  const configPath = `${mcp.workspace}/config.toml`;
  const ui = startUi({
    bridge,
    subscribe: (fn) => session.subscribe(fn),
    workspace: mcp.workspace,
    sessionId: "e2e-select",
    settings: Settings.from([], {}, readConfig(configPath)),
    configPath,
    promptPlayers: () => [P.uuid],
    library: { roots: () => [], thumbnail: async () => undefined, registry: () => ctx.registry, paletteIndex: () => ctx.palette },
    candidates: session.candidates,
    choices: session.choices,
    baseDoc: () => session.doc,
    scopes: session.scopes,
    linkFrame: () => (link.volumes ? { dimension: link.volumes.dimension, origin: link.volumes.origin } : undefined),
    inGame: () => inGame,
    candidate: () => worldCandidate(view),
    log: () => {},
  });
  session.pulseHits = (boxes) => {
    const d = view.dimension;
    return !!d && ui.feed.pulseHits(boxes, d);
  };
  await until(() => bridge.connected && bridge.ui, 30_000, "the bridge with ui in both hellos");
  return {
    mcp,
    inGame,
    ui,
    view,
    events,
    sent,
    fromMod: (m) => (bridge as unknown as { dispatch(m: ModMessage): void }).dispatch(m),
    async uiRequest(kind, args) {
      const req = ++nextUi;
      await ui.requests.handle({ type: "ui.request", request: req, player: P, kind, args });
      const r = sent.find((m): m is UiResult => m.type === "ui.result" && m.request === req);
      if (!r) throw new Error(`no ui.result for ${kind}`);
      return r;
    },
    async close() {
      ui.close();
      inGame.close();
      view.close();
      await mcp.close();
    },
  };
}

/** One search cluster line, parsed (src/world/select/search.ts, `describeSearch`). */
interface Cluster {
  n: number;
  closed: boolean;
  where: string;
  min: [number, number];
  max: [number, number];
  counts: number[];
  blocks: number;
}

function clusters(text: string): Cluster[] {
  const out: Cluster[] = [];
  for (const line of text.split("\n")) {
    const m = /^#(\d+) (closed|open)[^·]*· (.+?) \(centre[^·]*· [\d,]+ chunks? x (-?\d+)\.\.(-?\d+) z (-?\d+)\.\.(-?\d+), y [^·]*· ([\d,]+) blocks?(?:: (.*?))?(?: · densest)?$/.exec(line);
    if (!m) continue;
    const counts: number[] = [];
    for (const c of (m[9] ?? "").matchAll(/\[(\d+)\] ([\d,]+)/g)) counts[Number(c[1]) - 1] = Number(c[2]!.replace(/,/g, ""));
    out.push({ n: Number(m[1]), closed: m[2] === "closed", where: m[3]!, min: [Number(m[4]), Number(m[6])], max: [Number(m[5]), Number(m[7])], counts, blocks: Number(m[8]!.replace(/,/g, "")) });
  }
  return out;
}

const holds = (c: Cluster, m: Map<string, string>) => {
  const b = boxOf(m);
  return c.min[0] <= b.min[0] && b.max[0] <= c.max[0] && c.min[1] <= b.min[2] && b.max[2] <= c.max[1];
};

/** The candidate's positions in the world view, as keys. */
function candidateKeys(view: WorldView): Set<string> {
  return new Set(resolveSelection("candidate", { doc: view.doc }).mask.positions().map((p) => key(...p)));
}

function sameSet(got: Set<string>, want: Iterable<string>): { missing: string[]; extra: string[] } {
  const w = new Set(want);
  return { missing: [...w].filter((k) => !got.has(k)).slice(0, 10), extra: [...got].filter((k) => !w.has(k)).slice(0, 10) };
}

const ok = (r: UiResult) => {
  if (!r.ok) throw new Error(`${r.error}: ${r.message}`);
  return r.result;
};

describe.skipIf(!ENABLED)("e2e world: select (18)", () => {
  let r: Rcon;
  let w: Wired | undefined;

  beforeAll(async () => {
    await instanceContext();
    r = await rcon();
    // Generate and hold the square the search walks (rings 0–10 around the player's chunk), in two halves under forceload's 256-chunk cap.
    const [pcx, pcz] = [PLAYER[0] >> 4, PLAYER[2] >> 4];
    for (const [a, b] of [[pcx - 10, pcx], [pcx + 1, pcx + 10]] as const) {
      const out = await r.command(`forceload add ${a * 16} ${(pcz - 10) * 16} ${b * 16 + 15} ${(pcz + 10) * 16 + 15}`);
      if (/too many|cannot/i.test(out)) throw new Error(`forceload failed: ${out}`);
    }
    // Clear each build's area above the ground (reruns start from the same world), then build.
    const areas: { min: Vec3; max: Vec3 }[] = [boxOf(WITH_GARDEN), boxOf(HOUSE_B), boxOf(RUIN)];
    const run = async (cmd: string) => {
      for (let i = 0; i < 60; i++) {
        const out = await r.command(cmd);
        if (!/not loaded|maximum/i.test(out)) return out;
        if (/maximum/i.test(out)) throw new Error(`${cmd}: ${out}`);
        await new Promise((res) => setTimeout(res, 1000));
      }
      throw new Error(`${cmd}: chunks never loaded`);
    };
    for (const a of areas) await run(`fill ${a.min[0] - 4} ${GROUND} ${a.min[2] - 4} ${a.max[0] + 4} ${GROUND + 12} ${a.max[2] + 4} minecraft:air`);
    for (const [min, max, b] of [...houseA(), GARDEN, ...houseB(), ...ruin()]) await run(`fill ${min.join(" ")} ${max.join(" ")} ${b}`);
  }, 300_000);

  afterAll(async () => {
    await r?.command("autosketch clear").catch(() => {});
    await w?.close();
    const [pcx, pcz] = [PLAYER[0] >> 4, PLAYER[2] >> 4];
    await r?.command(`forceload remove ${(pcx - 10) * 16} ${(pcz - 10) * 16} ${(pcx + 10) * 16 + 15} ${(pcz + 10) * 16 + 15}`).catch(() => {});
    r?.close();
  }, 60_000);

  it("selects the mossy stone brick house: search, choices, fill, expand, faded render, trim, confirmed volumes", async () => {
    const ctx = await instanceContext();
    w = await wire();
    const bridge = w.mcp.link.bridge;
    await r.command("autosketch clear");

    // ── Ask (workflow step 1): the player's /autosketch select, and the grant it fixes. ──
    const grant = await r.command(`autosketch measure grant ${PLAYER[0]} ${PLAYER[2]} ${GRANT_RADIUS}`);
    expect(grant).toContain(`radius ${GRANT_RADIUS}`);
    const prompt: PromptMessage = {
      type: "prompt",
      id: 18_001,
      player: P,
      text: WORDS,
      context: { dimension: OW, position: [PLAYER[0] + 0.5, PLAYER[1], PLAYER[2] + 0.5], eye: [PLAYER[0] + 0.5, PLAYER[1] + 1.62, PLAYER[2] + 0.5], yaw: 0, pitch: 0, facing: "south" },
      mode: "select",
    };
    w.fromMod(prompt);
    await until(() => w!.events.length === 1, 5_000, "the select event");
    expect(w.events[0]!.content).toMatch(new RegExp(`^In-game select request from E2E: ${JSON.stringify(WORDS)}\\. Select mode:`));
    expect(w.events[0]!.content).toContain(`Standing at world (${PLAYER.join(", ")}) in ${OW}`);
    expect(w.events[0]!.meta).toEqual({ request: String(prompt.id), player: "E2E" });
    expect(w.inGame.current?.mode).toBe("select");
    expect(w.sent).toContainEqual({ type: "prompt.result", id: prompt.id, delivered: true });

    // The fixture as built, read back through the select grant: every block as the model says.
    for (const m of [WITH_GARDEN, HOUSE_B, RUIN]) {
      const b = boxOf(m);
      const got = await worldBlocks(w.mcp.link, b.min, b.max);
      const diffs: string[] = [];
      for (const [k, s] of got.states) {
        const id = s.replace(/\[.*$/, "");
        if (id !== (m.get(k) ?? "minecraft:air")) diffs.push(`${k}: ${s} (model ${m.get(k) ?? "air"})`);
      }
      expect(diffs.slice(0, 10)).toEqual([]);
    }

    // ── Find (step 2): mossy stone bricks, and the rest of the stone brick family, around the player. ──
    const materials = ["minecraft:mossy_stone_bricks", "family:minecraft:stone_bricks"];
    const groups = resolveMaterials(materials, { registry: ctx.registry, index: ctx.palette }).groups;
    const countIn = (m: Map<string, string>) => groups.map((g) => [...m.values()].filter((b) => g.wire.includes(b)).length);
    const searched = await w.mcp.client.callTool({ name: "world_search", arguments: { materials, stop: 3 } });
    expect(searched.isError).toBeFalsy();
    const parts = searched.content as { type: string; text?: string }[];
    expect(parts.some((p) => p.type === "image")).toBe(true);
    const text = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
    expect(text).toMatch(/^ok · world_search · 3 clusters \(3 closed, 0 open\)/);
    const found = clusters(text);
    expect(found.length, text).toBe(3);
    const [ca, cb, cr] = [WITH_GARDEN, HOUSE_B, RUIN].map((m) => found.find((c) => holds(c, m)));
    expect(ca && cb && cr, text).toBeTruthy();
    // Exact counts per material group, per build: the mod counted every block, covered ones included.
    expect(ca!.counts).toEqual(countIn(WITH_GARDEN).map((n) => n || undefined));
    expect(cb!.counts).toEqual(countIn(HOUSE_B).map((n) => n || undefined));
    expect(cr!.counts).toEqual(countIn(RUIN).map((n) => n || undefined));
    expect(found.map((c) => c.n)).toEqual([1, 2, 3]);
    expect(found[0]).toBe(ca); // nearest first
    expect(ca!.where).toMatch(/blocks north-east$/);
    expect(cr!.where).toMatch(/blocks west$/);
    expect(cb!.where).toMatch(/blocks south/);

    // ── Propose (step 3): three hits as clickable choices, pulsed in the world; the player picks the first. ──
    const at = (c: Cluster) => ({ min: [c.min[0], GROUND, c.min[1]], max: [c.max[0], GROUND + 15, c.max[1]] });
    const hits = [
      { text: `mossy stone brick house, ${ca!.where}`, at: at(ca!) },
      { text: `stone brick house, ${cb!.where}`, at: at(cb!) },
      { text: `ruin, ${cr!.where}`, at: at(cr!) },
    ];
    const choices = [...hits, "neither, let me describe it"];
    const asked = await w.mcp.call("world_reply", { lines: ["Which one do you mean?"], choices });
    expect(asked).toContain("choices q1: 4 clickable lines");
    const lines = w.sent.filter((m): m is ChatMessage => m.type === "chat" && m.request === prompt.id && !!m.action && m.action.kind === "choices.pick");
    expect(lines.map((m) => m.action!.args)).toEqual([0, 1, 2, 3].map((index) => ({ id: "q1", index })));
    expect(lines[0]!.lines[0]).toContain(hits[0]!.text);
    expect(asked).toContain("3 hits pulsed in the world");
    await until(() => w!.sent.some((m) => m.type === "ui.flash" && m.flashes.some((f) => f.job === "candidate")), 5_000, "the hits pulsed");
    const pulse = w.sent.find((m): m is UiFlashMessage => m.type === "ui.flash" && m.flashes.some((f) => f.job === "candidate"));
    expect(pulse?.flashes.find((f) => f.job === "candidate")).toMatchObject({ dimension: OW, boxes: [0, 1, 2].map((i) => at([ca!, cb!, cr!][i]!)) });
    expect(ok(await w.uiRequest("choices.pick", { id: "q1", index: 0 }))).toEqual({ request: prompt.id });
    expect(w.events.at(-1)!.content).toBe(`Choice answer from E2E (request ${prompt.id}) to "Which one do you mean?": [1] ${JSON.stringify(hits[0]!.text)}.`);

    // ── Grow (step 4): from a wall block, through the stone brick family, the seed's chunk first. ──
    const seed: Vec3 = [A[0], GROUND + 2, A[2] + 2];
    const filled = await w.mcp.call("world_fill", { seed, match: ["family:minecraft:stone_bricks"], area: 0 });
    expect(filled, filled).not.toContain("Complete:");
    let rounds = 0;
    let grown = filled;
    while (!grown.includes("Complete:") && rounds < 4) {
      grown = await w.mcp.call("world_expand", { by: "frontier" });
      rounds++;
    }
    expect(rounds).toBeGreaterThan(0);
    expect(grown, grown).toContain("Complete:"); // the frontier is empty
    // The candidate is every stone brick block of House A and its garden wall, block for block.
    const bricks = [...WITH_GARDEN].filter(([, b]) => groups.some((g) => g.wire.includes(b))).map(([k]) => k);
    expect(sameSet(candidateKeys(w.view), bricks)).toEqual({ missing: [], extra: [] });
    // Drawn in the world as the steady `candidate` fill record (piece 8).
    await until(() => w!.sent.some((m) => m.type === "ui.state" && !!(m as UiState).fills?.some((f) => f.id === "candidate")), 5_000, "the candidate fill record");

    // ── Look and trim (step 5): the candidate solid among faded surroundings, then what touches it but was left out. ──
    const rendered = await w.mcp.client.callTool({ name: "render", arguments: { view: "world", region: { dilate: "candidate", by: 8 }, fade: "candidate" } });
    expect(rendered.isError, JSON.stringify(rendered.content).slice(0, 400)).toBeFalsy();
    expect((rendered.content as { type: string }[]).some((p) => p.type === "image")).toBe(true);
    await w.mcp.call("select", { view: "world", sel: { filter: { subtract: [{ dilate: "candidate", by: 1 }, "candidate"] }, air: false }, name: "left_out" });
    const leftOut = resolveSelection("left_out", { doc: w.view.doc }).mask;
    expect(leftOut.has(A[0] + 5, GROUND + 6, A[2])).toBe(true); // the roof's edge
    expect(leftOut.has(A[0] + 3, GROUND + 3, A[2])).toBe(true); // a window
    // The roof, floor and windows belong: fill again with them, which brings the garden wall back too.
    let refill = await w.mcp.call("world_fill", { seed, match: ["family:minecraft:stone_bricks", "family:minecraft:spruce_planks", "minecraft:glass_pane"] });
    for (let i = 0; !refill.includes("Complete:") && i < 4; i++) refill = await w.mcp.call("world_expand", { by: "frontier" });
    expect(sameSet(candidateKeys(w.view), WITH_GARDEN.keys())).toEqual({ missing: [], extra: [] });
    // The garden wall is a leak: cut it with a box east of the house.
    const east = { min: [A[0] + A_SIZE[0], GROUND - 1, A[2] - 4], max: [A[0] + A_SIZE[0] + 20, GROUND + 10, A[2] + A_SIZE[2] + 4] };
    await w.mcp.call("select", { view: "world", sel: { freeze: { subtract: ["candidate", east] } }, name: "candidate" });
    expect(sameSet(candidateKeys(w.view), HOUSE_A.keys())).toEqual({ missing: [], extra: [] });

    // ── Confirm (step 6): "is this it?", the player says yes, the volumes follow the shape. ──
    await w.mcp.call("world_reply", { lines: ["Is this the house (outlined)?"], choices: ["yes, that's it", "no"] });
    expect(ok(await w.uiRequest("choices.pick", { id: "q2", index: 0 }))).toEqual({ request: prompt.id });
    expect(w.events.at(-1)!.content).toBe(`Choice answer from E2E (request ${prompt.id}) to "Is this the house (outlined)?": [1] "yes, that's it".`);
    const confirmed = await w.mcp.call("world_volumes", { from: "candidate" });
    const box = boxOf(HOUSE_A);
    expect(box).toEqual({ min: A, max: [A[0] + 10, GROUND + 6, A[2] + 8] });
    expect(confirmed).toContain(`from "candidate" (${HOUSE_A.size} blocks, box 11×7×9 at world (${box.min.join(",")})–(${box.max.join(",")})): work 11×7×9`);
    await until(() => bridge.volumes?.work?.min.join() === box.min.join() && bridge.volumes?.work?.max.join() === box.max.join(), 10_000, "the mod's volumes");
    // Context: the box plus the margin (8), clipped at the bottom of the world (-64).
    expect(bridge.volumes).toMatchObject({ dimension: OW, work: box, context: [{ min: [box.min[0] - 8, -64, box.min[2] - 8], max: [box.max[0] + 8, box.max[1] + 8, box.max[2] + 8] }] });
    // The outline stays after confirming (P3) and goes when the player ends the request.
    await w.mcp.call("world_reply", { lines: ["Set the work volume to the house."], done: true });
    expect(w.view.doc.selections.has("candidate")).toBe(true);
    w.fromMod({ type: "prompt.close", player: P });
    await until(() => w!.sent.some((m) => m.type === "ui.state" && !!(m as UiState).fillsRemoved?.includes("candidate")), 5_000, "the candidate fill removed");

    // Select is read-only: the world is as the fixture built it.
    const after = await worldBlocks(w.mcp.link, boxOf(WITH_GARDEN).min, boxOf(WITH_GARDEN).max);
    expect([...after.states].filter(([k, s]) => s.replace(/\[.*$/, "") !== (WITH_GARDEN.get(k) ?? "minecraft:air")).slice(0, 5)).toEqual([]);
  }, 600_000);
});
