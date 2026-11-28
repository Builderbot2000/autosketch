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
import type { ObserveEvent } from "../../../src/core/events.js";
import type { EventListener } from "../../../src/core/fanout.js";
import { Mask } from "../../../src/core/mask.js";
import { Document } from "../../../src/document/document.js";
import { REQUEST_MODES, type GameContext, type PlayerRef, type WireBox } from "../../../src/world/protocol/messages.js";
import { describeConfirm, maskRuns, wireBoxOf } from "../../../src/world/select/confirm.js";
import { WorldSelect } from "../../../src/world/select/select.js";
import { WorldMap } from "../../../src/world/map.js";
import { WorldView } from "../../../src/world/view.js";
import { FakeHost } from "../../support/fake-host.js";
import { fakeRegistry } from "../../helpers/registry.js";
import { memStack } from "../../helpers/stack.js";

/**
 * Confirming (docs/design/18-select.md, piece 9; step T3): world_volumes({from: "candidate", margin?})
 * against the fake host, in a select request with no linked document: the volumes sent, the shape
 * named in the linked document once it links, and a candidate too large for the work volume.
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


describe("the confirm's pieces (18, piece 9)", () => {
  it("turns a mask into runs shifted to local coordinates, and an inclusive box", () => {
    const m = new Mask();
    for (const p of [[10, 64, 8], [11, 64, 8], [13, 64, 8], [10, 65, 8]] as Vec3[]) m.add(...p);
    expect(maskRuns(m)).toEqual([[10, 64, 8, 2], [13, 64, 8, 1], [10, 65, 8, 1]]);
    expect(maskRuns(m, [10, 64, 8])).toEqual([[0, 0, 0, 2], [3, 0, 0, 1], [0, 1, 0, 1]]);
    expect(wireBoxOf(m)).toEqual({ min: [10, 64, 8], max: [13, 65, 8] });
    expect(wireBoxOf(new Mask())).toBeUndefined();
  });

  it("words a confirm with linking to follow, and one too large", () => {
    const box: WireBox = { min: [10, 64, 8], max: [15, 66, 8] };
    const volumes = { type: "volumes" as const, link: 3, dimension: OW, work: box, context: [{ min: [2, 56, 0], max: [23, 74, 16] }] as WireBox[] };
    expect(describeConfirm({ from: "candidate", count: 18, box, margin: 8, withCandidate: false, volumes, autoLink: false, placed: false }).split("\n")).toEqual([
      "ok · world_volumes · from \"candidate\" (18 blocks, box 6×3×1 at world (10,64,8)–(15,66,8)): work 6×3×1 at world (10,64,8)–(15,66,8), context +8 (1 box after the game's build-height clipping) · link 3.",
      'The game shows the outlines; call doc_open({world: true}) to link (world.autoLink is off), and "candidate" comes along as named selection in the linked document. The shape is a guide for where to work; only the work volume\'s box is enforced.',
    ]);
    const big = describeConfirm({ from: "candidate", count: 18, box, margin: 8, withCandidate: false, tooLarge: "the context holds 7106 blocks, more than the cap of 1000", autoLink: true, placed: false }).split("\n");
    expect(big[0]).toBe(
      'ok · world_volumes · from "candidate" (18 blocks, box 6×3×1 at world (10,64,8)–(15,66,8)): confirmed as a selection, but too large for a work volume. The mod refused the volumes (the context holds 7106 blocks, more than the cap of 1000): with its context (+8) the box is over the mod\'s contextCap, which isn\'t raised, so no volumes were set.',
    );
    expect(big[2]).toMatch(/world_volumes\(\{from:"part"\}\).*sandboxes \(scope_fork\)/);
  });
});

// ── world_volumes({from}) against the fake host ─────────────────────────────────────────────

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));
let host: FakeHost | undefined;
let bridge: Bridge | undefined;
let view: WorldView | undefined;
let worldMap: WorldMap | undefined;
afterEach(async () => {
  view?.close();
  worldMap?.close();
  bridge?.close();
  await host?.close();
  host = bridge = view = worldMap = undefined;
});

/** A linked document as the live link would hold it, and the `world.link` event it emits. */
interface FakeLink {
  doc: Document;
  origin: Vec3;
  dimension: string;
  work: WireBox;
}

async function setup(opts: Parameters<typeof FakeHost.start>[0] = {}) {
  host = await FakeHost.start({ selectChunks: 8, ...opts });
  bridge = new Bridge({ instanceDir: host.instanceDir, volatile: DEFAULT_VOLATILE, reconnect: false, modes: [...REQUEST_MODES] });
  let request: number | undefined;
  let context: GameContext | undefined;
  bridge.on("prompt", (m) => ((request = m.id), (context = m.context)));
  let linked: FakeLink | undefined;
  // Before connecting: the mod reports its canvas right after the hello.
  const map = (worldMap = new WorldMap({ bridge, player: () => context, linked: () => linked }));
  await bridge.connect();
  const dir = mkdtempSync(join(tmpdir(), "autosketch-confirm-"));
  roots.push(dir);
  const session = new Session(dir);
  const v = (view = new WorldView({ bridge, request: () => request, dimension: () => OW }));
  const listeners: EventListener[] = [];
  session.worldView = v;
  session.worldMap = map;
  session.worldSelect = new WorldSelect({
    bridge,
    request: () => request,
    context: () => context,
    dimension: () => OW,
    view: () => v,
    linked: () => linked,
    subscribe: (fn) => (listeners.push(fn), () => {}),
    autoLink: true,
    canvas: () => map.canvas,
  });
  const server = createServer(fixtureContext(dir), { session });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  void host.playerAsk(KEV, "the stone brick wall", { position: [8.5, 64, 8.5], eye: [8.5, 65.62, 8.5] }, { mode: "select" });
  await host.waitFor(() => context);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    const content = r.content as { type: string; text?: string }[];
    return { error: !!r.isError, lines: content.find((c) => c.type === "text")!.text!.split("\n") };
  };
  /** Links a fresh document over `work` (world) and emits `world.link`, as the live link does. */
  const link = (work: WireBox) => {
    linked = { doc: Document.create({ name: "world", dataVersion: 0 }), origin: [...work.min], dimension: OW, work };
    const e: ObserveEvent = { kind: "world.link", state: "linked", dimension: OW };
    for (const fn of listeners) fn(e, "base");
    return linked.doc;
  };
  return { host, call, session, view: v, link, newRequest: () => (request = (request ?? 0) + 1000) };
}

/** A wall of stone bricks along x from 10 to 15 at z 8, y 64..66, inside one section. */
function wall(h: FakeHost): void {
  for (let x = 10; x <= 15; x++) for (let y = 64; y <= 66; y++) h.set([x, y, 8], BRICK);
}

const WALL: WireBox = { min: [10, 64, 8], max: [15, 66, 8] };

describe("world_volumes({from}) against the fake host (18, piece 9)", () => {
  it("sets work = the candidate's box and context = box + margin, then names the shape in the linked document", async () => {
    const { host, call, link } = await setup();
    wall(host);
    host.set([16, 64, 8], STONE);
    const f = await call("world_fill", { seed: [12, 65, 8], match: [BRICK] });
    expect(f.error).toBe(false);
    const c = await call("world_volumes", { from: "candidate" });
    expect(c.error).toBe(false);
    expect(c.lines[0]).toBe('ok · world_volumes · from "candidate" (18 blocks, box 6×3×1 at world (10,64,8)–(15,66,8)): work 6×3×1 at world (10,64,8)–(15,66,8), context +8 (1 box after the game\'s build-height clipping) · link 2.');
    expect(c.lines[1]).toMatch(/^The game shows the outlines; linking follows on its own .* "candidate" comes along as named selection in the linked document\./);
    expect(host.received.filter((m) => m.type === "volumes.set")).toMatchObject([{ dimension: OW, work: WALL, context: [{ min: [2, 56, 0], max: [23, 74, 16] }] }]);
    // No canvas held the box plus margin, so it was set first (19, *Setting the canvas*), widened by the mod.
    expect(host.received.filter((m) => m.type === "canvas.set")).toMatchObject([{ dimension: OW, box: { min: [2, 56, 0], max: [23, 74, 16] } }]);
    expect(host.received.findIndex((m) => m.type === "canvas.set")).toBeLessThan(host.received.findIndex((m) => m.type === "volumes.set"));
    expect(host.canvas).toEqual({ dimension: OW, box: { min: [0, -64, 0], max: [31, 319, 31] } });
    expect(c.lines[2]).toBe(
      "The canvas is set to 2×2 chunks at world (0,-64,0)–(31,319,31) (the box plus 8, widened to whole chunk columns and the build height): reads work anywhere in it in every mode, and the brush can move inside it.",
    );
    expect(c.lines[1]).toMatch(/in the canvas's frame: coordinates don't move with the brush/);

    // The link follows: the shape is named there in local coordinates, block for block.
    const doc = link(WALL);
    const m = resolveSelection("candidate", { doc }).mask;
    expect(m.count()).toBe(18);
    for (let x = 0; x <= 5; x++) for (let y = 0; y <= 2; y++) expect(m.has(x, y, 0)).toBe(true);
    expect(m.has(6, 0, 0)).toBe(false);
    expect(m.has(-1, 0, 0)).toBe(false);
  });

  it("honours margin, follows a trimmed candidate, and names it at once when the link already holds those volumes", async () => {
    const { host, call, link } = await setup();
    wall(host);
    await call("world_fill", { seed: [12, 65, 8], match: [BRICK] });
    await call("select", { view: "world", sel: { freeze: { subtract: ["candidate", { min: [10, 66, 8], max: [15, 66, 8] }] } }, name: "candidate" });
    const work: WireBox = { min: [10, 64, 8], max: [15, 65, 8] };
    const doc = link(work); // already linked over the trimmed box (nothing named yet)
    expect(doc.selections.has("candidate")).toBe(false);
    const c = await call("world_volumes", { from: "candidate", margin: 2 });
    expect(c.lines[0]).toMatch(/from "candidate" \(12 blocks, box 6×2×1 at world \(10,64,8\)–\(15,65,8\)\): work 6×2×1 .* context \+2 /);
    expect(c.lines[1]).toMatch(/^The linked document already holds these volumes: "candidate" is now named selection there/);
    expect(host.received.filter((m) => m.type === "volumes.set")).toMatchObject([{ work, context: [{ min: [8, 62, 6], max: [17, 67, 10] }] }]);
    const m = resolveSelection("candidate", { doc }).mask;
    expect(m.count()).toBe(12);
    expect(m.has(5, 1, 0)).toBe(true);
    expect(m.has(0, 2, 0)).toBe(false);
  });

  it("sets the canvas when the shape is over the brush cap, and the agent then places the brush on a part inside it (19)", async () => {
    // The select flow refused in the 2026-11-27 test: a shape whose context is over contextCap.
    const { host, call, link } = await setup({ contextCap: 1000 });
    wall(host);
    await call("world_fill", { seed: [12, 65, 8], match: [BRICK] });
    const big = await call("world_volumes", { from: "candidate" });
    expect(big.error).toBe(false);
    expect(big.lines).toEqual([
      'ok · world_volumes · from "candidate" (18 blocks, box 6×3×1 at world (10,64,8)–(15,66,8)): over the brush cap, so no volumes were set. The mod refused them (the context holds 7106 blocks, more than the cap of 1000): with its context (+8) the box is over the mod\'s contextCap. The canvas is set to 2×2 chunks at world (0,-64,0)–(31,319,31) (the box plus 8, widened to whole chunk columns and the build height).',
      'The shape stays the named selection "candidate" in the world view, and comes along into the next document linked in this request.',
      'You place the brush (the work volume) yourself, anywhere in the canvas, without asking the player: look at the whole canvas with world_map, choose a part, keep it with select({view:"world", sel:{freeze:{intersect:["candidate", <box>]}}, name:"part"}) and confirm it with world_volumes({from:"part"}). Reads anywhere in the canvas work in every mode (world_view_read, render with view:"world", world_search).',
    ]);
    expect(host.received.filter((m) => m.type === "canvas.set")).toMatchObject([{ dimension: OW, box: { min: [2, 56, 0], max: [23, 74, 16] } }]);
    expect(host.canvas).toEqual({ dimension: OW, box: { min: [0, -64, 0], max: [31, 319, 31] } });
    expect(host.received.filter((m) => m.type === "volumes.set")).toHaveLength(1);
    expect(host.received.filter((m) => m.type === "volumes")).toHaveLength(0);

    // The agent looks at the whole canvas.
    const map = await call("world_map", {});
    expect(map.error).toBe(false);
    expect(map.lines[0]).toBe("ok · world_map · canvas 2×2 chunks (32×32 blocks, world y -64 to 319) in minecraft:overworld, world (0,-64,0)–(31,319,31) = local (0,0,0)–(31,383,31); local (0,0,0) is world (0,-64,0) (the canvas's minimum corner: the frame once a brush inside it links).");
    expect(map.lines).toContain("Brush: none set.");

    // It places the brush on a part (two columns, margin 1): inside the canvas, so no new canvas.
    await call("select", { view: "world", sel: { freeze: { intersect: ["candidate", { min: [10, 60, 0], max: [11, 70, 15] }] } }, name: "part" });
    const p = await call("world_volumes", { from: "part", margin: 1 });
    expect(p.error).toBe(false);
    expect(p.lines[0]).toMatch(/^ok · world_volumes · from "part" \(6 blocks, box 2×3×1 at world \(10,64,8\)–\(11,66,8\)\): work 2×3×1 /);
    expect(p.lines[1]).toMatch(/"part" and the whole "candidate" come along as named selections/);
    expect(p.lines).toHaveLength(2);
    expect(host.received.filter((m) => m.type === "canvas.set")).toHaveLength(1);
    expect(p.lines[0]).toContain("work 2×3×1 at world (10,64,8)–(11,66,8)");
    expect(host.canvas?.box).toEqual({ min: [0, -64, 0], max: [31, 319, 31] });
    const doc = link({ min: [10, 64, 8], max: [11, 66, 8] });
    expect(resolveSelection("part", { doc }).mask.count()).toBe(6);
    const whole = resolveSelection("candidate", { doc }).mask;
    expect(whole.count()).toBe(18);
    expect(whole.has(5, 2, 0)).toBe(true); // past the work box: a guide, not a limit
  });

  it("keeps 18's selection-only answer on a mod without the canvas, and says when the canvas is refused", async () => {
    const { host, call } = await setup({ contextCap: 1000, features: ["modes", "scan", "volumes.set", "registry", "upgrade", "ui", "select"] });
    wall(host);
    await call("world_fill", { seed: [12, 65, 8], match: [BRICK] });
    const big = await call("world_volumes", { from: "candidate" });
    expect(big.lines[0]).toBe(
      'ok · world_volumes · from "candidate" (18 blocks, box 6×3×1 at world (10,64,8)–(15,66,8)): confirmed as a selection, but too large for a work volume. The mod refused the volumes (the context holds 7106 blocks, more than the cap of 1000): with its context (+8) the box is over the mod\'s contextCap, which isn\'t raised, so no volumes were set.',
    );
    expect(big.lines[2]).toMatch(/world_volumes\(\{from:"part"\}\).*sandboxes \(scope_fork\)/);
    expect(host.received.filter((m) => m.type === "canvas.set")).toHaveLength(0);
    await host.close();
    bridge?.close();
    view?.close();
    worldMap?.close();

    // canvasChunks 1: the canvas (2×2 chunks) is refused, the volumes are set as before.
    const s2 = await setup({ canvasChunks: 1 });
    wall(s2.host);
    await s2.call("world_fill", { seed: [12, 65, 8], match: [BRICK] });
    const c = await s2.call("world_volumes", { from: "candidate" });
    expect(c.error).toBe(false);
    expect(c.lines[0]).toMatch(/: work 6×3×1 at world/);
    expect(c.lines[2]).toBe("The canvas wasn't set (the canvas would span 2 chunks, more than canvasChunks (1)).");
    expect(s2.host.canvas).toBeNull();
  });

  it("sets no canvas when the mod's canvas already holds the shape and its margin", async () => {
    const { host, call } = await setup({ canvas: { box: { min: [-32, 0, -32], max: [47, 0, 47] } } });
    wall(host);
    await call("world_fill", { seed: [12, 65, 8], match: [BRICK] });
    const c = await call("world_volumes", { from: "candidate" });
    expect(c.error).toBe(false);
    expect(c.lines).toHaveLength(2);
    expect(host.received.filter((m) => m.type === "canvas.set")).toHaveLength(0);
    expect(host.canvas?.box).toEqual({ min: [-32, -64, -32], max: [47, 319, 47] });
  });

  it("refuses without a candidate, with both from and work, and drops a confirm when the request changes", async () => {
    const { host, call, link, newRequest } = await setup();
    wall(host);
    const none = await call("world_volumes", { from: "candidate" });
    expect(none.error).toBe(true);
    expect(none.lines[0]).toBe('There is no "candidate" in the world view for this request: grow one with world_fill first.');
    const part = await call("world_volumes", { from: "part" });
    expect(part.lines[0]).toMatch(/^There is no selection "part" in the world view/);
    await call("world_fill", { seed: [12, 65, 8], match: [BRICK] });
    const both = await call("world_volumes", { from: "candidate", work: { min: [0, 0, 0], max: [1, 1, 1] } });
    expect(both.error).toBe(true);
    expect(both.lines[0]).toMatch(/either from .* or work/);
    const neither = await call("world_volumes", {});
    expect(neither.error).toBe(true);
    expect(host.received.filter((m) => m.type === "volumes.set")).toHaveLength(0);

    const ok = await call("world_volumes", { from: "candidate" });
    expect(ok.error).toBe(false);
    newRequest();
    const doc = link(WALL);
    expect(doc.selections.has("candidate")).toBe(false);
  });
});

async function fixtureContext(root: string): Promise<InstanceContext> {
  const stack = await memStack([["base", "base", {}]]);
  return { info: { name: "Fixture", mcVersion: "1.21.1", launcher: "generic", root }, stack, registry, palette: index, plugins: [], sheets: new SheetRenderer(index, stack), book: new PaletteBook(), warnings: [], timings: {} };
}
