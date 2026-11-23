import { afterEach, describe, expect, it } from "vitest";
import type { Vec3 } from "../../../src/core/region.js";
import { Document } from "../../../src/document/document.js";
import { resolveSelection } from "../../../src/ops/selection.js";
import { Bridge, type BridgeError } from "../../../src/world/bridge.js";
import { alignBox, maskRegions } from "../../../src/world/protocol/body.js";
import { decodeFrame, encodeMessage, ProtocolError } from "../../../src/world/protocol/codec.js";
import { DEFAULT_VOLATILE } from "../../../src/world/protocol/hash.js";
import { REQUEST_MODES, type FillResult, type MaskSection, type McpMessage, type ModMessage, type PlayerRef } from "../../../src/world/protocol/messages.js";
import { FakeHost } from "../../support/fake-host.js";

/**
 * Select on the wire (docs/design/18-select.md, *Wire*; `13`, *Message schemas*, *Select*): the codec's
 * checks, the mask layout rule, and the fake host's search, fill, expand, mask and coarse reads under
 * the select-mode grant, with the fill's parity with `{connected}`.
 */

const OW = "minecraft:overworld";
const KEV: PlayerRef = { name: "Kev", uuid: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" };
const BRICK = "minecraft:stone_bricks";
const MOSSY = "minecraft:mossy_stone_bricks";

const roundTrip = (m: McpMessage | ModMessage, sender: "mcp" | "mod") => decodeFrame(encodeMessage(m), sender);
const frameOf = (header: object) => {
  const h = Buffer.from(JSON.stringify(header));
  const out = Buffer.alloc(8 + h.length);
  out.writeUInt32BE(4 + h.length, 0);
  out.writeUInt32BE(h.length, 4);
  h.copy(out, 8);
  return new Uint8Array(out);
};

/** Every position a fill result's sections hold. */
function positions(sections: MaskSection[]): string[] {
  const out: string[] = [];
  for (const s of sections)
    for (let i = 0; i < 4096; i++)
      if (s.mask === "full" || (s.mask[i >> 3]! & (1 << (i & 7))) !== 0) {
        const x = i & 15, z = (i >> 4) & 15, y = i >> 8;
        out.push(`${s.section[0] * 16 + x},${s.section[1] * 16 + y},${s.section[2] * 16 + z}`);
      }
  return out.sort();
}

describe("select codec", () => {
  it("lists select as a request mode and refuses a grant on a select prompt", () => {
    expect(REQUEST_MODES).toContain("select");
    const ctx = { dimension: OW, position: [0.5, 64, 0.5] as [number, number, number], eye: [0.5, 65.62, 0.5] as [number, number, number], yaw: 0, pitch: 0, facing: "south" as const };
    expect(roundTrip({ type: "prompt", id: 1, player: KEV, text: "", context: ctx, mode: "select" }, "mod")).toMatchObject({ mode: "select" });
    const scan = { radius: 1, columns: { min: [0, 0], max: [15, 15] }, box: { min: [0, 0, 0], max: [1, 1, 1] } };
    expect(() => decodeFrame(frameOf({ type: "prompt", id: 1, player: KEV, text: "", context: ctx, mode: "select", scan }), "mod")).toThrow(/scan is sent only with mode scan/);
  });

  it("checks searches: materials, a continuing search takes only stop, stop and gap at least 1", () => {
    expect(() => decodeFrame(frameOf({ type: "search", id: 1, dimension: OW, materials: [] }), "mcp")).toThrow(/non-empty list of materials/);
    expect(() => decodeFrame(frameOf({ type: "search", id: 1, dimension: OW, materials: ["stone_bricks"] }), "mcp")).toThrow(/not a block id/);
    expect(() => decodeFrame(frameOf({ type: "search", id: 1, dimension: OW, materials: ["solid"] }), "mcp")).toThrow(/not a block id/);
    expect(() => decodeFrame(frameOf({ type: "search", id: 1, dimension: OW, materials: [BRICK, BRICK] }), "mcp")).toThrow(/unique/);
    expect(() => decodeFrame(frameOf({ type: "search", id: 1, dimension: OW, continue: true, materials: [BRICK] }), "mcp")).toThrow(/only stop/);
    expect(() => decodeFrame(frameOf({ type: "search", id: 1, dimension: OW, continue: false }), "mcp")).toThrow(/true or omitted/);
    expect(() => decodeFrame(frameOf({ type: "search", id: 1, dimension: OW, materials: [BRICK], gap: 0 }), "mcp")).toThrow(/≥ 1/);
    expect(roundTrip({ type: "search", id: 2, dimension: OW, materials: ["#minecraft:logs", "minecraft:oak_log[axis=y]"], stop: 3 }, "mcp")).toEqual({ type: "search", id: 2, dimension: OW, materials: ["#minecraft:logs", "minecraft:oak_log[axis=y]"], stop: 3 });
  });

  it("checks fills, expands and the new snapshot kinds", () => {
    expect(() => decodeFrame(frameOf({ type: "fill", id: 1, dimension: OW, seed: [0, 0, 0], match: [BRICK], connectivity: 8 }), "mcp")).toThrow(/6, 18 or 26/);
    expect(roundTrip({ type: "fill", id: 1, dimension: OW, seed: [0, 0, 0], match: ["solid"] }, "mcp")).toMatchObject({ match: ["solid"] });
    expect(() => decodeFrame(frameOf({ type: "expand", id: 1, dimension: OW, by: { direction: "up", chunks: 1 } }), "mcp")).toThrow(/direction/);
    expect(() => decodeFrame(frameOf({ type: "expand", id: 1, dimension: OW, by: { box: { min: [0, 0, 0], max: [1, 1, 1] }, chunks: 2 } }), "mcp")).toThrow(/a box, or a direction/);
    expect(() => decodeFrame(frameOf({ type: "snapshot", id: 1, dimension: OW, kind: "mask", sections: [[0, 4, 0]], margin: 17 }), "mcp")).toThrow(/0 to 16/);
    expect(() => decodeFrame(frameOf({ type: "snapshot", id: 1, dimension: OW, kind: "mask", sections: [[0, 4, 0], [0, 4, 0]] }), "mcp")).toThrow(/unique/);
    expect(() => decodeFrame(frameOf({ type: "snapshot", id: 1, dimension: OW, kind: "coarse", cell: 3, boxes: [{ min: [0, 0, 0], max: [1, 1, 1] }] }), "mcp")).toThrow(/cell/);
    expect(() => decodeFrame(frameOf({ type: "snapshot", id: 1, dimension: OW, boxes: [{ min: [0, 0, 0], max: [1, 1, 1] }], cell: 2 }), "mcp")).toThrow(/belong to mask and coarse/);
  });

  it("encodes masks as full or a bitset that is neither empty nor full, and box null exactly when empty", () => {
    const base: FillResult = { type: "fill.result", id: 1, dimension: OW, seed: [0, 64, 0], count: 4096, box: { min: [0, 64, 0], max: [15, 79, 15] }, stopped: "complete", missing: [], sections: [], frontier: [] };
    expect(() => encodeMessage({ ...base, sections: [{ section: [0, 4, 0], mask: new Uint8Array(512).fill(0xff) }] })).toThrow(/full mask is sent as full/);
    expect(() => encodeMessage({ ...base, sections: [{ section: [0, 4, 0], mask: new Uint8Array(512) }] })).toThrow(/no positions/);
    expect(() => encodeMessage({ ...base, box: null })).toThrow(ProtocolError);
    expect(() => encodeMessage({ ...base, sections: [{ section: [1, 4, 0], mask: "full" }, { section: [0, 4, 0], mask: "full" }] })).toThrow(/ascending/);
    expect(() => encodeMessage({ ...base, sections: [{ section: [0, 4, 0], mask: "full" }], frontier: [{ section: [0, 4, 0], index: [3], faces: [64] }] })).toThrow(/face mask/);
    const back = roundTrip({ ...base, sections: [{ section: [0, 4, 0], mask: "full" }], frontier: [{ section: [0, 4, 0], index: [0, 4095], faces: [16, 41] }] }, "mod");
    expect(back).toMatchObject({ sections: [{ section: [0, 4, 0], mask: "full" }], frontier: [{ section: [0, 4, 0], index: [0, 4095], faces: [16, 41] }] });
  });
});

describe("mask layout and cells", () => {
  it("answers a mask snapshot with the sections, then the margin's pieces of their neighbours", () => {
    expect(maskRegions([[0, 4, 0]], 0)).toEqual([{ min: [0, 64, 0], max: [15, 79, 15] }]);
    const one = maskRegions([[0, 4, 0]], 8);
    expect(one).toHaveLength(27);
    expect(one[1]).toEqual({ min: [-8, 56, -8], max: [-1, 63, -1] }); // below, north-west corner piece first
    expect(one).toContainEqual({ min: [16, 64, 0], max: [23, 79, 15] }); // the east face piece
    // Two sections side by side: the piece of a shared neighbour is the bounding box of both reaches.
    const two = maskRegions([[0, 4, 0], [1, 4, 0]], 2);
    expect(two.slice(0, 2)).toEqual([
      { min: [0, 64, 0], max: [15, 79, 15] },
      { min: [16, 64, 0], max: [31, 79, 15] },
    ]);
    expect(two).toContainEqual({ min: [0, 64, -2], max: [15, 79, -1] }); // north of the first
    expect(two).toHaveLength(2 + 34); // the 4×3×3 sections around the pair, less the pair
  });

  it("aligns coarse boxes outward to the world's cell grid", () => {
    expect(alignBox({ min: [-7, 64, 33], max: [-1, 70, 38] }, 4)).toEqual({ min: [-8, 64, 32], max: [-1, 71, 39] });
    expect(alignBox({ min: [1, -63, 0], max: [1, -63, 0] }, 2)).toEqual({ min: [0, -64, 0], max: [1, -63, 1] });
  });
});

describe("fake host: select requests", () => {
  let host: FakeHost | undefined;
  let bridge: Bridge | undefined;
  afterEach(async () => {
    bridge?.close();
    await host?.close();
    host = bridge = undefined;
  });

  async function pair(opts: Parameters<typeof FakeHost.start>[0] = {}, position: [number, number, number] = [0.5, 64, 0.5]) {
    host = await FakeHost.start(opts);
    bridge = new Bridge({ instanceDir: host.instanceDir, volatile: DEFAULT_VOLATILE, reconnect: false, modes: [...REQUEST_MODES] });
    await bridge.connect();
    if (host.has("select")) {
      void host.playerAsk(KEV, "the mossy stone brick house", { position, eye: [position[0], position[1] + 1.62, position[2]] }, { mode: "select" });
      await host.waitFor(() => host!.selectGrant);
    }
    return { host, bridge };
  }

  /** A hollow 6×5×6 house of bricks (walls mossy at the corner) with its minimum corner at `at`. */
  function house(h: FakeHost, at: Vec3): number {
    let n = 0;
    for (let y = 0; y < 5; y++)
      for (let z = 0; z < 6; z++)
        for (let x = 0; x < 6; x++) {
          if (x > 0 && x < 5 && z > 0 && z < 5 && y > 0 && y < 4) continue;
          h.set([at[0] + x, at[1] + y, at[2] + z], x === 0 && z === 0 ? MOSSY : BRICK);
          n++;
        }
    return n;
  }

  it("needs the select feature: the bridge refuses unsent, and a mod without it refuses the kinds", async () => {
    const { host, bridge } = await pair({ features: ["modes", "scan", "volumes.set"] });
    const e = (await bridge.request({ type: "search", dimension: OW, materials: [BRICK] }).catch((x: unknown) => x)) as BridgeError;
    expect(e.refusal).toBe("world_mod_outdated");
    expect(e.message).toContain("selecting in the world");
    const c = (await bridge.request({ type: "snapshot", dimension: OW, kind: "coarse", cell: 2, boxes: [{ min: [0, 0, 0], max: [1, 1, 1] }] }).catch((x: unknown) => x)) as BridgeError;
    expect(c.refusal).toBe("world_mod_outdated");
    expect(host.received.filter((m) => m.type === "search" || m.type === "snapshot")).toEqual([]);
    expect(() => host.playerAsk(KEV, "", {}, { mode: "select" })).toThrow(/no select subcommand/);
  });

  it("refuses select requests while no select grant is in force (no_grant), and in another dimension", async () => {
    host = await FakeHost.start();
    bridge = new Bridge({ instanceDir: host.instanceDir, volatile: DEFAULT_VOLATILE, reconnect: false, modes: [...REQUEST_MODES] });
    await bridge.connect();
    const e = (await bridge.request({ type: "fill", dimension: OW, seed: [0, 64, 0], match: [BRICK] }).catch((x: unknown) => x)) as BridgeError;
    expect(e.refusal).toBe("no_grant");
    void host.playerAsk(KEV, "", {}, { mode: "select" });
    await host.waitFor(() => host!.selectGrant);
    const d = (await bridge.request({ type: "search", dimension: "minecraft:the_nether", materials: [BRICK] }).catch((x: unknown) => x)) as BridgeError;
    expect(d.refusal).toBe("wrong_dimension");
  });

  it("searches nearest first, stops at a closed cluster, continues to the next, and lists ungenerated chunks", async () => {
    const { host, bridge } = await pair({ selectChunks: 8, missingChunks: new Set(["-3,0"]) }, [8.5, 64, 8.5]);
    const near = house(host, [20, 64, 4]); // chunk 1,0, ring 1
    const far = house(host, [-80, 70, 96]); // chunk -5,6, ring 6
    const r = await bridge.request({ type: "search", dimension: OW, materials: [BRICK, MOSSY], radius: 20 });
    expect(r).toMatchObject({ centre: [0, 0], radius: 8, clipped: true, reached: 3, minSection: -4 });
    expect(r.clusters).toEqual([{ min: [1, 0], max: [1, 0], chunks: 1, blocks: near, closed: true }]);
    expect(r.chunks).toEqual([{ chunk: [1, 0], counts: [near - 5, 5], cluster: 0, sections: [4] }]);
    expect(r.missing).toEqual([[-3, 0]]);
    const more = await bridge.request({ type: "search", dimension: OW, continue: true });
    expect(more.reached).toBe(8); // the far house's cluster closes only past ring 6 + 2
    expect(more.clusters).toEqual([
      { min: [1, 0], max: [1, 0], chunks: 1, blocks: near, closed: true },
      { min: [-5, 6], max: [-5, 6], chunks: 1, blocks: far, closed: true },
    ]);
    expect(more.chunks.map((c) => c.chunk)).toEqual([[1, 0], [-5, 6]]);
  });

  it("fills exactly as {connected} on the same blocks, at each connectivity", async () => {
    const { host, bridge } = await pair({}, [8.5, 64, 8.5]);
    const doc = Document.create({ name: "t", dataVersion: 3955, seed: 1, size: [24, 12, 24] });
    const origin: Vec3 = [-12, 60, 4]; // world position of the document's [0,0,0]: the blocks span four chunks
    doc.edit("test", "blobs", (tx) => {
      for (let y = 0; y < 12; y++)
        for (let z = 0; z < 24; z++)
          for (let x = 0; x < 24; x++) {
            const h = (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
            const r = ((h >>> 0) % 100) / 100;
            const state = r < 0.45 ? BRICK : r < 0.55 ? MOSSY : undefined;
            if (!state) continue;
            tx.set(x, y, z, state);
            host.set([origin[0] + x, origin[1] + y, origin[2] + z], state);
          }
    });
    let seed: Vec3 = [0, 0, 0];
    for (let i = 0; doc.getState(...seed) !== BRICK; i++) seed = [i % 24, 0, Math.floor(i / 24)];
    for (const connectivity of [6, 18, 26] as const) {
      const want = resolveSelection({ connected: { seed, connectivity } }, { doc })
        .mask.positions()
        .map((p) => `${p[0] + origin[0]},${p[1] + origin[1]},${p[2] + origin[2]}`)
        .sort();
      const got = await bridge.request({ type: "fill", dimension: OW, seed: [seed[0] + origin[0], seed[1] + origin[1], seed[2] + origin[2]], match: [BRICK], connectivity, area: 2 });
      expect(got.stopped).toBe("complete");
      expect(got.count).toBe(want.length);
      expect(positions(got.sections)).toEqual(want);
    }
  });

  it("stops at the read area's edge with a frontier, and expand grows it and sends only what changed", async () => {
    const { host, bridge } = await pair({}, [8.5, 64, 8.5]);
    for (let x = 0; x < 40; x++) host.set([x, 64, 5], BRICK); // a wall from chunk 0 into chunk 2
    const first = await bridge.request({ type: "fill", dimension: OW, seed: [3, 64, 5], match: [BRICK], connectivity: 6, area: 0 });
    expect(first).toMatchObject({ count: 16, box: { min: [0, 64, 5], max: [15, 64, 5] }, stopped: "edge", missing: [] });
    // The area's edges: the wall leaves chunk 0 east (x 15 → 16) and west (x 0 → -1, which holds nothing but isn't read).
    expect(first.frontier).toEqual([{ section: [0, 4, 0], index: [80, 95], faces: [16, 32] }]);
    const grown = await bridge.request({ type: "expand", dimension: OW, by: "frontier" });
    expect(grown).toMatchObject({ delta: true, count: 32, box: { min: [0, 64, 5], max: [31, 64, 5] }, stopped: "edge" });
    expect(grown.sections.map((s) => s.section)).toEqual([[1, 4, 0]]);
    expect(grown.frontier).toEqual([{ section: [1, 4, 0], index: [95], faces: [32] }]); // -1 is now read: nothing there
    const east = await bridge.request({ type: "expand", dimension: OW, by: { direction: "east", chunks: 1 } });
    expect(east).toMatchObject({ count: 40, box: { min: [0, 64, 5], max: [39, 64, 5] }, stopped: "complete", frontier: [] });
  });

  it("stops at the budget and resumes with a fresh one", async () => {
    const { host, bridge } = await pair({}, [8.5, 64, 8.5]);
    for (let x = 0; x < 10; x++) host.set([x, 64, 5], BRICK);
    const part = await bridge.request({ type: "fill", dimension: OW, seed: [0, 64, 5], match: [BRICK], connectivity: 6, budget: 3 });
    expect(part).toMatchObject({ count: 3, stopped: "budget" }); // the seed counts toward the budget
    expect(part.frontier).toEqual([{ section: [0, 4, 0], index: [82], faces: [1 | 2 | 4 | 8 | 32] }]);
    const rest = await bridge.request({ type: "expand", dimension: OW, by: "frontier", budget: 100 });
    expect(rest).toMatchObject({ count: 10, stopped: "complete", frontier: [] });
  });

  it("doesn't fill into ungenerated chunks, and lists those of its area", async () => {
    const { host, bridge } = await pair({ missingChunks: new Set(["1,0"]) }, [8.5, 64, 8.5]);
    for (let x = 0; x < 20; x++) host.set([x, 64, 5], BRICK);
    const r = await bridge.request({ type: "fill", dimension: OW, seed: [0, 64, 5], match: [BRICK], connectivity: 6 });
    // An ungenerated chunk stops the fill like non-matching blocks (expanding can't read it), and is listed.
    expect(r).toMatchObject({ count: 16, stopped: "complete", missing: [[1, 0]], frontier: [] });
  });

  it("reads anywhere within selectChunks of the player without volumes, capped by contextCap, as mask and coarse snapshots too", async () => {
    const { host, bridge } = await pair({ selectChunks: 4, contextCap: 20_000, missingChunks: new Set(["2,0"]) }, [8.5, 64, 8.5]);
    host.set([40, 64, 5], MOSSY); // in the missing chunk 2,0: never read
    host.set([3, 64, 5], BRICK);
    const blocks = await bridge.request({ type: "snapshot", dimension: OW, boxes: [{ min: [30, 64, 5], max: [33, 64, 5] }] });
    expect(blocks.missing).toEqual([[2, 0]]);
    expect(blocks.regions[0]!.states.length).toBe(4);
    const out = (await bridge.request({ type: "snapshot", dimension: OW, boxes: [{ min: [80, 64, 0], max: [80, 64, 0] }] }).catch((x: unknown) => x)) as BridgeError;
    expect(out.refusal).toBe("no_volumes"); // chunk 5 is past the grant's 4: the volumes' rule applies, and there are none
    const big = (await bridge.request({ type: "snapshot", dimension: OW, boxes: [{ min: [0, 0, 0], max: [15, 99, 15] }] }).catch((x: unknown) => x)) as BridgeError;
    expect(big.refusal).toBe("too_large");
    const mask = await bridge.request({ type: "snapshot", dimension: OW, kind: "mask", sections: [[0, 4, 0]], margin: 2 });
    expect(mask.regions.map((r) => r.box)).toEqual(maskRegions([[0, 4, 0]], 2));
    const coarse = await bridge.request({ type: "snapshot", dimension: OW, kind: "coarse", cell: 4, boxes: [{ min: [1, 63, 5], max: [6, 64, 6] }, { min: [33, 64, 4], max: [33, 64, 4] }] });
    expect(coarse.regions.map((r) => r.box)).toEqual([
      { min: [0, 60, 4], max: [7, 67, 7] },
      { min: [32, 64, 4], max: [35, 67, 7] },
    ]);
    expect(coarse.regions[0]!.states.length).toBe(2 * 2 * 1);
    expect(Array.from(coarse.regions[0]!.states)).toEqual([0, 0, 1, 0]); // x fastest, then z, then y: air below; the brick's cell above
    expect(coarse.palette).toEqual(["minecraft:air", BRICK]);
    expect(coarse.missing).toEqual([[2, 0]]);
  });

  it("serves a surface snapshot inside the select grant (terrain, piece 10)", async () => {
    const { host, bridge } = await pair({ selectChunks: 2 }, [8.5, 64, 8.5]);
    host.set([20, 70, 20], "minecraft:grass_block[snowy=false]");
    const s = await bridge.request({ type: "snapshot", dimension: OW, kind: "surface", columns: { min: [16, 16], max: [31, 31] } });
    expect(s.palette).toEqual(["minecraft:grass_block[snowy=false]"]);
  });

  it("a new select or scan request replaces the grant, and its search and fill", async () => {
    const { host, bridge } = await pair({}, [8.5, 64, 8.5]);
    host.set([3, 64, 5], BRICK);
    await bridge.request({ type: "fill", dimension: OW, seed: [3, 64, 5], match: [BRICK] });
    void host.playerAsk(KEV, "", {}, { mode: "scan" });
    await host.waitFor(() => host.scanGrant);
    expect(host.selectGrant).toBeNull();
    const e = (await bridge.request({ type: "expand", dimension: OW, by: "frontier" }).catch((x: unknown) => x)) as BridgeError;
    expect(e.refusal).toBe("no_grant");
  });
});
