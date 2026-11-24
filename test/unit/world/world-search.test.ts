import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Vec3 } from "../../../src/core/region.js";
import type { Family } from "../../../src/palette/families.js";
import { Image } from "../../../src/palette/image.js";
import { PaletteIndex } from "../../../src/palette/index.js";
import { PaletteBook } from "../../../src/palette/pick.js";
import { SheetRenderer } from "../../../src/palette/sheet.js";
import type { InstanceContext } from "../../../src/server/context.js";
import { createServer } from "../../../src/server/server.js";
import { Session } from "../../../src/server/session.js";
import { Bridge } from "../../../src/world/bridge.js";
import { DEFAULT_VOLATILE } from "../../../src/world/protocol/hash.js";
import { REQUEST_MODES, type GameContext, type PlayerRef, type SearchResult } from "../../../src/world/protocol/messages.js";
import { resolveMaterials } from "../../../src/world/select/materials.js";
import { bearing, describeSearch, heatMap, shade } from "../../../src/world/select/search.js";
import { WorldSelect } from "../../../src/world/select/select.js";
import { FakeHost } from "../../support/fake-host.js";
import { fakeRegistry } from "../../helpers/registry.js";
import { memStack } from "../../helpers/stack.js";

/**
 * world_search (docs/design/18-select.md, piece 2; step T1): materials resolved as given, the heat
 * map and the cluster text, and the tool against the fake host, `continue` included.
 */

const OW = "minecraft:overworld";
const KEV: PlayerRef = { name: "Kev", uuid: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" };
const BRICK = "minecraft:stone_bricks";
const MOSSY = "minecraft:mossy_stone_bricks";
const STAIRS = "minecraft:stone_brick_stairs";
const COBBLE = "minecraft:mossy_cobblestone";

const registry = fakeRegistry([
  { id: BRICK, tags: ["minecraft:stone_bricks"] },
  { id: MOSSY, tags: ["minecraft:stone_bricks"] },
  { id: STAIRS, properties: { facing: ["north", "south", "west", "east"], half: ["top", "bottom"] }, defaults: { facing: "north", half: "bottom" } },
  { id: COBBLE },
  { id: "minecraft:stone" },
]);
const family = (base: string, extra: Partial<Family> = {}): Family => ({ id: base, base, namespace: "minecraft", category: "stone", buildable: true, shapes: {}, variants: [], extras: {}, aliases: [], ...extra });
const index = new PaletteIndex(
  {
    cacheVersion: "test",
    fingerprint: "test",
    families: [family(BRICK, { shapes: { stairs: STAIRS }, variants: [{ base: MOSSY, shapes: {} }] }), family(COBBLE), family("minecraft:stone")],
    series: [],
    stats: {},
    looseCount: 0,
  },
  registry,
);

describe("materials as given (18, piece 2)", () => {
  it("resolves ids, families, tags and states into the wire list, each once, and keeps the agent's groups", () => {
    const m = resolveMaterials(["family:stone_bricks", "mossy_cobblestone", "minecraft:mossy_stone_bricks", "#stone_bricks", "stone_brick_stairs[half=top]"], { registry, index });
    expect(m.wire).toEqual([BRICK, STAIRS, MOSSY, COBBLE, "#minecraft:stone_bricks", "minecraft:stone_brick_stairs[facing=north,half=top]"]);
    expect(m.groupOf).toEqual([0, 0, 0, 1, 3, 4]);
    expect(m.groups.map((g) => [g.given, g.members, g.wire.length])).toEqual([
      ["family:stone_bricks", 3, 3],
      ["mossy_cobblestone", 1, 1],
      ["minecraft:mossy_stone_bricks", 1, 0], // already sent with the family
      ["#stone_bricks", 1, 1],
      ["stone_brick_stairs[half=top]", 1, 1],
    ]);
    // A family named by any member is that member's family.
    expect(resolveMaterials(["family:mossy_stone_bricks"], { registry, index }).wire).toEqual([BRICK, STAIRS, MOSSY]);
  });

  it("never guesses: unknown ids, families and tags are one error that names each", () => {
    expect(() => resolveMaterials(["stone_brickz", "family:granite", "#minecraft:nope", "stone"], { registry, index })).toThrow(
      /^stone_brickz: minecraft:stone_brickz isn't a block in this instance; family:granite: no family has minecraft:granite; #minecraft:nope: no block has the tag #minecraft:nope\. Look materials up/,
    );
    expect(() => resolveMaterials(["air"], { registry, index })).toThrow(/air can't be searched/);
    expect(() => resolveMaterials(["solid"], { registry, index })).toThrow(/name materials/);
    expect(() => resolveMaterials(["stone_brick_stairs[shape=x]"], { registry, index })).toThrow(/has no property "shape"/);
    expect(() => resolveMaterials(["family:stone"], { registry })).toThrow(/families need the loaded palette/);
  });
});

/** A hand-made answer: centre (0,0), rings 0–2 of 8, two clusters, one ungenerated chunk. */
const answer: SearchResult = {
  type: "search.result",
  id: 1,
  dimension: OW,
  materials: [BRICK, MOSSY],
  centre: [0, 0],
  radius: 8,
  reached: 2,
  minSection: -4,
  clusters: [
    { min: [1, -1], max: [2, -1], chunks: 2, blocks: 300, closed: true },
    { min: [-2, 2], max: [-2, 2], chunks: 1, blocks: 12, closed: false },
  ],
  chunks: [
    { chunk: [1, -1], counts: [100, 0], cluster: 0, sections: [4] },
    { chunk: [2, -1], counts: [180, 20], cluster: 0, sections: [4, 5] },
    { chunk: [-2, 2], counts: [0, 12], cluster: 1, sections: [3] },
  ],
  missing: [[0, 2]],
};

describe("the search's text (18, piece 2)", () => {
  it("lists clusters nearest first with distance, bearing, y range and counts per material, and says how to go on", () => {
    const groups = resolveMaterials(["stone_bricks", "mossy_stone_bricks"], { registry, index }).groups;
    const text = describeSearch(answer, { groups, groupOf: [0, 1], from: [8, 8], fromName: "the player (x 8 z 8)", continued: false });
    expect(text.split("\n")).toEqual([
      "ok · world_search · 2 clusters (1 closed, 1 open) · rings 0–2 of 8 walked around chunk (0,0) in minecraft:overworld · 1 ungenerated chunk not read",
      "Materials: [1] stone_bricks, [2] mossy_stone_bricks. Distances from the player (x 8 z 8).",
      // centre: (24·100 + 40·200)/300 = 34.67 → 35; z −8
      "#1 closed · 31 blocks north-east (centre x 35 z -8) · 2 chunks x 16..47 z -16..-1, y 64..95 · 300 blocks: [1] 280, [2] 20 · densest",
      "#2 open (may reach past the walk) · 45 blocks south-west (centre x -24 z 40) · 1 chunk x -32..-17 z 32..47, y 48..63 · 12 blocks: [2] 12",
      "The walk stopped at ring 2: world_search({continue:true}) walks on for more clusters (stop:n for several).",
    ]);
  });

  it("names bearings on eight points, north up (−z)", () => {
    expect(bearing([0, 0], [0, -100])).toEqual({ distance: 100, bearing: "north" });
    expect(bearing([0, 0], [100, 0])).toEqual({ distance: 100, bearing: "east" });
    expect(bearing([0, 0], [-70, 70])).toEqual({ distance: 99, bearing: "south-west" });
    expect(bearing([0, 0], [3, 4])).toEqual({ distance: 5, bearing: "here" });
  });
});

describe("the heat map (18, piece 2)", () => {
  it("draws one cell per chunk, north up, shaded by count, the player ringed, ungenerated chunks marked, clusters outlined", () => {
    const map = heatMap(answer, [0, 0]);
    // 5×5 chunks at 24 px (480/5 = 96, capped at 24), 12 px above for the N.
    expect([map.width, map.height, map.cell, map.min, map.max, map.peak]).toEqual([120, 132, 24, [-2, -2], [2, 2], 200]);
    const img = Image.decodePng(map.png);
    const at = (cx: number, cz: number, dx = 12, dy = 12) => img.get((cx + 2) * 24 + dx, (cz + 2) * 24 + 12 + dy);
    expect(at(2, -1)).toEqual(shade(200, 200)); // the densest chunk, brightest
    expect(at(1, -1)).toEqual(shade(100, 200));
    expect(shade(100, 200)[0]).toBeLessThan(shade(200, 200)[0]);
    expect(at(-1, 1)).toEqual([44, 44, 50, 255]); // walked, no match
    expect(at(0, 2, 5, 12)).toEqual([8, 8, 8, 255]); // ungenerated, off its cross
    expect(at(0, 2, 5, 5)).toEqual([110, 110, 110, 255]); // on its cross
    expect(at(0, 0, 0, 12)).toEqual([0, 220, 255, 255]); // the player's ring
    expect(at(1, -1, 12, 0)).toEqual([255, 255, 255, 255]); // closed cluster's top edge
    expect(at(-2, 2, 12, 23)).toEqual([255, 80, 200, 255]); // open cluster's bottom edge
    expect(map.caption).toContain("5×5 chunks (-2,-2)–(2,2), 24 px per chunk");
    expect(map.caption).toContain("black with a grey cross = ungenerated");
  });

  it("keeps a full 256-chunk walk within 513 px, a pixel per chunk", () => {
    const big = heatMap({ ...answer, radius: 256, reached: 256 }, [0, 0]);
    expect([big.width, big.height, big.cell]).toEqual([513, 525, 1]);
  });
});

// ── the tool against the fake host ──────────────────────────────────────────────────────────

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));
let host: FakeHost | undefined;
let bridge: Bridge | undefined;
afterEach(async () => {
  bridge?.close();
  await host?.close();
  host = bridge = undefined;
});

async function setup(opts: Parameters<typeof FakeHost.start>[0] = {}, position: [number, number, number] = [8.5, 64, 8.5], select = true) {
  host = await FakeHost.start(opts);
  bridge = new Bridge({ instanceDir: host.instanceDir, volatile: DEFAULT_VOLATILE, reconnect: false, modes: [...REQUEST_MODES] });
  let request: number | undefined;
  let context: GameContext | undefined;
  bridge.on("prompt", (m) => ((request = m.id), (context = m.context)));
  await bridge.connect();
  const dir = mkdtempSync(join(tmpdir(), "autosketch-search-"));
  roots.push(dir);
  const session = new Session(dir);
  session.worldSelect = new WorldSelect({ bridge, request: () => request, context: () => context, dimension: () => OW });
  const server = createServer(fixtureContext(dir), { session });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  if (select) {
    void host.playerAsk(KEV, "the mossy stone brick house", { position, eye: [position[0], position[1] + 1.62, position[2]] }, { mode: "select" });
    await host.waitFor(() => context);
  }
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  return { host, call, session };
}

/** A hollow 6×5×6 house of stone bricks, mossy at one corner column; returns [bricks, mossy]. */
function house(h: FakeHost, at: Vec3): [number, number] {
  let n = 0;
  for (let y = 0; y < 5; y++)
    for (let z = 0; z < 6; z++)
      for (let x = 0; x < 6; x++) {
        if (x > 0 && x < 5 && z > 0 && z < 5 && y > 0 && y < 4) continue;
        h.set([at[0] + x, at[1] + y, at[2] + z], x === 0 && z === 0 ? MOSSY : BRICK);
        n++;
      }
  return [n - 5, 5];
}

describe("world_search against the fake host (18, piece 2)", () => {
  it("finds the nearest house, then the next with continue, each answer replacing the last", async () => {
    const { host, call, session } = await setup({ selectChunks: 8, missingChunks: new Set(["-3,0"]) });
    const [b1, m1] = house(host, [20, 64, 4]); // chunk (1,0), ring 1
    house(host, [-80, 70, 96]); // chunk (-5,6), ring 6
    const r = await call("world_search", { materials: ["family:stone_bricks"], radius: 20 });
    expect(r.isError).toBeFalsy();
    const content = r.content as { type: string; text?: string; data?: string }[];
    expect(content[0]!.type).toBe("image");
    const lines = content[1]!.text!.split("\n");
    expect(lines[0]).toBe("ok · world_search · 1 cluster (1 closed, 0 open) · rings 0–3 of 8 walked around chunk (0,0) in minecraft:overworld · 1 ungenerated chunk not read");
    expect(lines[1]).toBe("The radius was clipped to 8 chunks (the mod's selectChunks).");
    expect(lines[2]).toBe("Materials: [1] family:stone_bricks (3 ids). Distances from the player (x 8 z 8).");
    expect(lines[3]).toBe(`#1 closed · 16 blocks east (centre x 24 z 8) · 1 chunk x 16..31 z 0..15, y 64..79 · ${b1 + m1} blocks: [1] ${b1 + m1}`);
    expect(lines[4]).toMatch(/^The walk stopped at ring 3: world_search\(\{continue:true\}\)/);
    // The wire carried ids only (the family resolved here), and no stop/radius defaults were invented.
    expect(host.received.filter((m) => m.type === "search")).toMatchObject([{ materials: [BRICK, STAIRS, MOSSY], radius: 20 }]);
    expect(Image.decodePng(Buffer.from(content[0]!.data!, "base64")).width).toBe(7 * 24);

    const c = await call("world_search", { continue: true });
    expect(c.isError).toBeFalsy();
    const t = (c.content as { text?: string }[])[1]!.text!.split("\n");
    expect(t[0]).toBe("ok · world_search (continued) · 2 clusters (2 closed, 0 open) · rings 0–8 of 8 walked around chunk (0,0) in minecraft:overworld · 1 ungenerated chunk not read");
    expect(t[3]).toMatch(/^#1 closed · 16 blocks east/);
    expect(t[4]).toMatch(/^#2 closed · 125 blocks south-west \(centre x -72 z 104\) · 1 chunk x -80\.\.-65 z 96\.\.111, y 64\.\.79 · 132 blocks: \[1\] 132$/);
    expect(t[5]).toBe("The walk covered the whole radius.");
    expect(host.received.filter((m) => m.type === "search").at(-1)).toEqual(expect.objectContaining({ continue: true }));
    // Replaced, not merged: the state is the continuation's whole walk.
    expect(session.worldSelect!.lastSearch!.clusters).toHaveLength(2);
  });

  it("refuses unknown materials before sending, and continue without a search or with materials", async () => {
    const { host, call } = await setup();
    const r = await call("world_search", { materials: ["stone_brickz"] });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0]!.text).toMatch(/stone_brickz isn't a block in this instance/);
    expect((r.content as { text: string }[])[0]!.text).toMatch(/nothing was searched/);
    const c = await call("world_search", { continue: true });
    expect((c.content as { text: string }[])[0]!.text).toMatch(/no search to continue in this request/);
    const m = await call("world_search", { continue: true, materials: [BRICK] });
    expect((m.content as { text: string }[])[0]!.text).toMatch(/give only continue/);
    expect(host.received.filter((x) => x.type === "search")).toEqual([]);
  });

  it("passes the mod's refusals on: no select request (no_grant), and a mod without select (world_mod_outdated, unsent)", async () => {
    const { call } = await setup({}, undefined, false);
    const r = await call("world_search", { materials: [BRICK] });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0]!.text).toMatch(/no select request is open/);
    bridge!.close();
    await host!.close();
    const old = await setup({ features: ["modes", "volumes.set"] }, undefined, false);
    const o = await old.call("world_search", { materials: [BRICK] });
    expect(o.isError).toBe(true);
    expect((o.content as { text: string }[])[0]!.text).toMatch(/doesn't support selecting in the world/);
    expect(old.host.received.filter((x) => x.type === "search")).toEqual([]);
  });
});

async function fixtureContext(root: string): Promise<InstanceContext> {
  const stack = await memStack([["base", "base", {}]]);
  return { info: { name: "Fixture", mcVersion: "1.21.1", launcher: "generic", root }, stack, registry, palette: index, plugins: [], sheets: new SheetRenderer(index, stack), book: new PaletteBook(), warnings: [], timings: {} };
}
