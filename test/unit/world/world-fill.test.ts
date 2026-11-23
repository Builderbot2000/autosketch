import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Vec3 } from "../../../src/core/region.js";
import { resolveSelection } from "../../../src/ops/selection.js";
import type { Family } from "../../../src/palette/families.js";
import { PaletteIndex } from "../../../src/palette/index.js";
import { PaletteBook } from "../../../src/palette/pick.js";
import { SheetRenderer } from "../../../src/palette/sheet.js";
import type { InstanceContext } from "../../../src/server/context.js";
import { createServer } from "../../../src/server/server.js";
import { Session } from "../../../src/server/session.js";
import { Bridge } from "../../../src/world/bridge.js";
import { DEFAULT_VOLATILE } from "../../../src/world/protocol/hash.js";
import { REQUEST_MODES, type FillResult, type GameContext, type MaskSection, type PlayerRef } from "../../../src/world/protocol/messages.js";
import { candidateMask, describeBy, describeFill, frontierFaces, frozenRuns } from "../../../src/world/select/fill.js";
import { WorldSelect } from "../../../src/world/select/select.js";
import { WorldView } from "../../../src/world/view.js";
import { FakeHost } from "../../support/fake-host.js";
import { fakeRegistry } from "../../helpers/registry.js";
import { memStack } from "../../helpers/stack.js";

/**
 * world_fill and world_expand (docs/design/18-select.md, pieces 3 and 4; step T2): the candidate's
 * mask, runs and text, and both tools against the fake host, cut off by the area's edge and by the
 * budget and resumed, with the candidate named in the world view and its margin read there.
 */

const OW = "minecraft:overworld";
const KEV: PlayerRef = { name: "Kev", uuid: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" };
const BRICK = "minecraft:stone_bricks";
const MOSSY = "minecraft:mossy_stone_bricks";
const STAIRS = "minecraft:stone_brick_stairs";
const STONE = "minecraft:stone";

const registry = fakeRegistry([
  { id: BRICK, tags: ["minecraft:stone_bricks"] },
  { id: MOSSY, tags: ["minecraft:stone_bricks"] },
  { id: STAIRS, properties: { facing: ["north", "south", "west", "east"], half: ["top", "bottom"] }, defaults: { facing: "north", half: "bottom" } },
  { id: STONE },
]);
const family = (base: string, extra: Partial<Family> = {}): Family => ({ id: base, base, namespace: "minecraft", category: "stone", buildable: true, shapes: {}, variants: [], extras: {}, aliases: [], ...extra });
const index = new PaletteIndex(
  {
    cacheVersion: "test",
    fingerprint: "test",
    families: [family(BRICK, { shapes: { stairs: STAIRS }, variants: [{ base: MOSSY, shapes: {} }] }), family(STONE)],
    series: [],
    stats: {},
    looseCount: 0,
  },
  registry,
);

/** A mask section with the given positions (section-local) set. */
function section(s: Vec3, local: Vec3[]): MaskSection {
  const mask = new Uint8Array(512);
  for (const [x, y, z] of local) {
    const i = x + 16 * (z + 16 * y);
    mask[i >> 3]! |= 1 << (i & 7);
  }
  return { section: s, mask };
}

describe("the candidate's shape (18, piece 3)", () => {
  it("turns mask sections into world positions and {frozen} runs along x, never across a section edge", () => {
    const a = section([0, 4, 0], [[14, 0, 8], [15, 0, 8], [3, 2, 1]]);
    const b = section([1, 4, 0], [[0, 0, 8], [1, 0, 8]]);
    expect(frozenRuns([a, b])).toEqual([
      [14, 64, 8, 2],
      [3, 66, 1, 1],
      [16, 64, 8, 2],
    ]);
    const m = candidateMask([a, b]);
    expect(m.count()).toBe(5);
    for (const p of [[14, 64, 8], [15, 64, 8], [16, 64, 8], [17, 64, 8], [3, 66, 1]] as Vec3[]) expect(m.has(...p)).toBe(true);
    expect(m.has(13, 64, 8)).toBe(false);
    // "full" is every position of the section.
    expect(frozenRuns([{ section: [0, 0, 0], mask: "full" }])).toHaveLength(256);
    expect(candidateMask([{ section: [-1, 0, 0], mask: "full" }]).count()).toBe(4096);
  });

  it("counts frontier faces bit by bit, and words how an expand grew", () => {
    expect(frontierFaces([{ section: [0, 4, 0], index: [1, 2], faces: [0b100000, 0b110100] }])).toBe(4);
    expect(describeBy("frontier")).toBe("by the frontier");
    expect(describeBy({ direction: "east", chunks: 1 })).toBe("1 chunk east");
    expect(describeBy({ box: { min: [0, 0, 0], max: [31, 70, 15] } })).toBe("by the chunks of (0,0,0)–(31,70,15)");
  });

  it("says when nothing matched and names nothing", () => {
    const r: FillResult = { type: "fill.result", id: 1, dimension: OW, seed: [1, 2, 3], count: 0, box: null, stopped: "complete", missing: [], sections: [], frontier: [] };
    expect(describeFill({ tool: "world_fill", result: r, sections: 0, match: BRICK, connectivity: 26 }).split("\n")).toEqual([
      `ok · world_fill · nothing filled: the seed (1,2,3) doesn't match ${BRICK}.`,
      "Nothing was named candidate. Pick a seed on a block of the build (view_slice or raycast on the world view, or the search's sections), or match its material.",
    ]);
  });
});

// ── the tools against the fake host ─────────────────────────────────────────────────────────

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));
let host: FakeHost | undefined;
let bridge: Bridge | undefined;
let view: WorldView | undefined;
afterEach(async () => {
  view?.close();
  bridge?.close();
  await host?.close();
  host = bridge = view = undefined;
});

async function setup(opts: Parameters<typeof FakeHost.start>[0] = {}, contextCap?: number) {
  host = await FakeHost.start({ selectChunks: 8, ...opts });
  bridge = new Bridge({ instanceDir: host.instanceDir, volatile: DEFAULT_VOLATILE, reconnect: false, modes: [...REQUEST_MODES] });
  let request: number | undefined;
  let context: GameContext | undefined;
  bridge.on("prompt", (m) => ((request = m.id), (context = m.context)));
  await bridge.connect();
  const dir = mkdtempSync(join(tmpdir(), "autosketch-fill-"));
  roots.push(dir);
  const session = new Session(dir);
  const v = (view = new WorldView({ bridge, request: () => request, dimension: () => OW, ...(contextCap ? { contextCap } : {}) }));
  session.worldView = v;
  session.worldSelect = new WorldSelect({ bridge, request: () => request, context: () => context, dimension: () => OW, view: () => v });
  const server = createServer(fixtureContext(dir), { session });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const position: Vec3 = [8.5, 64, 8.5] as unknown as Vec3;
  void host.playerAsk(KEV, "the stone brick wall", { position, eye: [8.5, 65.62, 8.5] }, { mode: "select" });
  await host.waitFor(() => context);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    return { error: !!r.isError, lines: (r.content as { text: string }[])[0]!.text.split("\n") };
  };
  return { host, call, session, view: v, newRequest: () => (request = (request ?? 0) + 1000) };
}

/** A wall of stone bricks along x from 10 to 40 at z 8, y 64..66 (three chunks), the first column mossy. */
function wall(h: FakeHost): void {
  for (let x = 10; x <= 40; x++) for (let y = 64; y <= 66; y++) h.set([x, y, 8], x === 10 ? MOSSY : BRICK);
}

/** The view's candidate, resolved. */
function candidate(v: WorldView) {
  return resolveSelection("candidate", { doc: v.doc }).mask;
}

describe("world_fill and world_expand against the fake host (18, pieces 3 and 4)", () => {
  it("fills to the read area's edge, then expands by the frontier and by a direction until complete", async () => {
    const { host, call, view } = await setup();
    wall(host);
    host.set([-5, 64, 8], STONE); // in the margin of section (0,4,0), outside the shape
    host.set([12, 64, 9], STONE); // touching the wall, not matched
    const f = await call("world_fill", { seed: [12, 65, 8], match: ["family:stone_bricks"], area: 0 });
    expect(f.error).toBe(false);
    expect(f.lines[0]).toBe("ok · world_fill · candidate: 18 blocks in 1 section, box (10,64,8)–(15,66,8) (6×3×1) · seed (12,65,8), match family:stone_bricks (3 ids), connectivity 26");
    expect(f.lines[1]).toBe('Cut off at 9 faces (3 frontier blocks) where the shape reaches the read area\'s edge: world_expand({by:"frontier"}) to continue (or by a direction and chunks, or a box).');
    // Section (0,4,0) plus 8 blocks around: 32³.
    expect(f.lines[2]).toBe("Read into the world view: its 1 section plus 8 blocks around, 32,768 blocks (44 non-air).");
    expect(f.lines[3]).toMatch(/^The shape is the named selection "candidate" in the world view/);
    expect(host.received.filter((m) => m.type === "fill")).toMatchObject([{ seed: [12, 65, 8], match: [BRICK, STAIRS, MOSSY], area: 0 }]);
    expect(host.received.find((m) => m.type === "snapshot" && "kind" in m && m.kind === "mask")).toMatchObject({ sections: [[0, 4, 0]] });
    // The candidate is the wall's first 6 columns, block for block; the margin is read, the stone too.
    const c = candidate(view);
    expect(c.count()).toBe(18);
    for (let x = 10; x <= 15; x++) for (let y = 64; y <= 66; y++) expect(c.has(x, y, 8)).toBe(true);
    expect(c.has(16, 64, 8)).toBe(false);
    expect(view.doc.getState(10, 64, 8)).toBe(MOSSY);
    expect(view.doc.getState(-5, 64, 8)).toBe(STONE);
    expect(view.doc.getState(12, 64, 9)).toBe(STONE);
    expect(view.has([-8, 56, -8])).toBe(true);
    expect(view.has([-9, 64, 8])).toBe(false);
    expect(view.has([24, 64, 8])).toBe(false);

    const e = await call("world_expand", { by: "frontier" });
    expect(e.error).toBe(false);
    expect(e.lines[0]).toBe("ok · world_expand (by the frontier) · candidate: 66 blocks (+48, 1 section changed) in 2 sections, box (10,64,8)–(31,66,8) (22×3×1) · seed (12,65,8), match family:stone_bricks (3 ids), connectivity 26");
    expect(e.lines[1]).toMatch(/^Cut off at 9 faces \(3 frontier blocks\) where the shape reaches the read area's edge/);
    expect(e.lines[2]).toBe("Read into the world view: the 1 changed section plus 8 blocks around, 32,768 blocks (91 non-air).");
    expect(candidate(view).count()).toBe(66);
    expect(view.doc.getState(31, 66, 8)).toBe(BRICK);
    expect(view.doc.getState(12, 64, 9)).toBe(STONE); // the first read is kept

    const d = await call("world_expand", { by: { direction: "east", chunks: 2 } });
    expect(d.lines[0]).toBe("ok · world_expand (2 chunks east) · candidate: 93 blocks (+27, 1 section changed) in 3 sections, box (10,64,8)–(40,66,8) (31×3×1) · seed (12,65,8), match family:stone_bricks (3 ids), connectivity 26");
    expect(d.lines[1]).toBe("Complete: the shape ends at non-matching blocks (or air) on every side; the frontier is empty.");
    const all = candidate(view);
    expect(all.count()).toBe(93);
    for (let x = 10; x <= 40; x++) for (let y = 64; y <= 66; y++) expect(all.has(x, y, 8)).toBe(true);
    expect(host.received.filter((m) => m.type === "expand")).toMatchObject([{ by: "frontier" }, { by: { direction: "east", chunks: 2 } }]);
  });

  it("cuts off at the budget, resumes with a fresh one, and matches the seed's block or family", async () => {
    const { host, call, view } = await setup();
    wall(host);
    const f = await call("world_fill", { seed: [20, 64, 8], match: "block", connectivity: 6, budget: 10 });
    expect(f.lines[0]).toMatch(/^ok · world_fill · candidate: 10 blocks in 1 section, .* match the seed's block minecraft:stone_bricks, connectivity 6$/);
    expect(f.lines[1]).toMatch(/^Cut off at \d+ faces \(\d+ frontier blocks\): the step's budget of 10 blocks ran out\. world_expand\(\{by:"frontier"\}\) continues with a fresh budget\.$/);
    expect(candidate(view).count()).toBe(10);
    // The seed's block was read once, as a one-block snapshot, and sent as an id.
    expect(host.received.filter((m) => m.type === "fill")).toMatchObject([{ seed: [20, 64, 8], match: [BRICK], connectivity: 6, budget: 10 }]);
    const e = await call("world_expand", { by: { box: { min: [0, 60, 0], max: [47, 70, 15] } } });
    expect(e.lines[0]).toMatch(/^ok · world_expand \(by the chunks of \(0,60,0\)–\(47,70,15\)\) · candidate: 90 blocks \(\+80, /);
    expect(e.lines[1]).toBe("Complete: the shape ends at non-matching blocks (or air) on every side; the frontier is empty.");
    // The mossy column isn't the seed's block.
    const c = candidate(view);
    expect(c.count()).toBe(90);
    expect(c.has(10, 64, 8)).toBe(false);
    expect(c.has(11, 64, 8)).toBe(true);

    // "family" takes the mossy column too, and a new fill replaces the candidate.
    const g = await call("world_fill", { seed: [20, 64, 8], match: "family" });
    expect(g.lines[0]).toMatch(/candidate: 93 blocks in 3 sections, .* match the seed's family minecraft:stone_bricks \(3 ids\), connectivity 26$/);
    expect(candidate(view).count()).toBe(93);
  });

  it("names nothing on a non-matching seed, refuses air seeds and expand without a fill, and drops the fill with the request", async () => {
    const { host, call, view, newRequest } = await setup();
    wall(host);
    const none = await call("world_fill", { seed: [12, 64, 9], match: [BRICK] });
    expect(none.lines[0]).toBe("ok · world_fill · nothing filled: the seed (12,64,9) doesn't match minecraft:stone_bricks.");
    expect(view.doc.selections.has("candidate")).toBe(false);
    const air = await call("world_fill", { seed: [12, 70, 8], match: "block" });
    expect(air.error).toBe(true);
    expect(air.lines[0]).toMatch(/the seed \(12,70,8\) is air/);
    const bad = await call("world_fill", { seed: [12, 64, 8], match: ["stone_brickz"] });
    expect(bad.lines[0]).toMatch(/stone_brickz isn't a block in this instance.*nothing was filled/);
    const ex = await call("world_expand", { by: "frontier" });
    expect(ex.error).toBe(true);
    expect(ex.lines[0]).toMatch(/no fill to expand in this request/);

    const ok = await call("world_fill", { seed: [12, 64, 8], match: [BRICK], area: 0 });
    expect(ok.error).toBe(false);
    newRequest();
    const stale = await call("world_expand", { by: "frontier" });
    expect(stale.lines[0]).toMatch(/no fill to expand in this request/);
    expect(host.received.filter((m) => m.type === "expand")).toEqual([]);
  });

  it("reads the margin coarse when it is over the per-read cap, and keeps the candidate exact", async () => {
    const { host, call, view } = await setup({}, 10_000);
    wall(host);
    const f = await call("world_fill", { seed: [12, 64, 8], match: [BRICK, MOSSY], area: 0 });
    expect(f.lines[2]).toMatch(/^Read into the world view: its 1 section plus 8 blocks around, 32,768 blocks, over the per-read cap so coarse, one block per 2³ cell/);
    expect(view.isCoarse([12, 64, 8])).toBe(true);
    expect(candidate(view).count()).toBe(18);
  });

  it("can be trimmed with the selection algebra in the view, frozen under its own name", async () => {
    const { host, call, view } = await setup();
    wall(host);
    await call("world_fill", { seed: [12, 64, 8], match: [BRICK, MOSSY], area: 0 });
    const s = await call("select", { view: "world", sel: { freeze: { subtract: ["candidate", { min: [10, 66, 8], max: [15, 66, 8] }] } }, name: "candidate" });
    expect(s.error).toBe(false);
    expect(candidate(view).count()).toBe(12);
  });
});

async function fixtureContext(root: string): Promise<InstanceContext> {
  const stack = await memStack([["base", "base", {}]]);
  return { info: { name: "Fixture", mcVersion: "1.21.1", launcher: "generic", root }, stack, registry, palette: index, plugins: [], sheets: new SheetRenderer(index, stack), book: new PaletteBook(), warnings: [], timings: {} };
}
