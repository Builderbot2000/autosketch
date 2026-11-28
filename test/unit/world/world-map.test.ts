import { afterEach, describe, expect, it } from "vitest";
import type { Vec3 } from "../../../src/core/region.js";
import { Image } from "../../../src/palette/image.js";
import { Bridge } from "../../../src/world/bridge.js";
import { CONTEXT_COLOUR, JOB_COLOUR, PLAYER_COLOUR, WORK_COLOUR, WorldMap, chunkTops, heightShade, renderMap, type MapCanvas } from "../../../src/world/map.js";
import { DEFAULT_VOLATILE } from "../../../src/world/protocol/hash.js";
import { REQUEST_MODES, type GameContext, type PlayerRef, type SurfaceResult, type WireBox } from "../../../src/world/protocol/messages.js";
import { FakeHost } from "../../support/fake-host.js";

/**
 * world_map (docs/design/19-canvas-and-requests.md, *Seeing the whole canvas*; step M1): the chunk
 * heights from surface snapshots, the image's size and marks on a synthetic canvas, and the text,
 * against the fake host (every column, and coarse past the cap).
 */

const OW = "minecraft:overworld";
const KEV: PlayerRef = { name: "Kev", uuid: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" };
const CANVAS: MapCanvas = { dimension: OW, box: { min: [0, -64, 0], max: [63, 319, 63] } };

const px = (img: Image, x: number, y: number) => [...img.get(x, y)];

/** A surface snapshot of an area with one height function (0: no block). */
function surface(min: [number, number], max: [number, number], height: (x: number, z: number) => number, missing: [number, number][] = []): SurfaceResult {
  const sx = max[0] - min[0] + 1, sz = max[1] - min[1] + 1;
  const heights = new Uint32Array(sx * sz), states = new Uint32Array(sx * sz);
  for (let i = 0; i < sx * sz; i++) {
    const y = height(min[0] + (i % sx), min[1] + Math.floor(i / sx));
    heights[i] = y ? y + 64 + 1 : 0;
  }
  return { type: "snapshot.result", id: 1, dimension: OW, kind: "surface", columns: { min, max }, minY: -64, missing, palette: ["minecraft:stone"], surface: { heights, states } };
}

describe("world_map's pieces (19, *Seeing the whole canvas*)", () => {
  it("takes the highest surface block per chunk, and marks ungenerated chunks", () => {
    const s = surface([0, 0], [63, 63], (x, z) => (x >= 32 && z < 16 ? 0 : x === 20 && z === 5 ? 90 : 60 + (z >> 4)), [[3, 3]]);
    const t = chunkTops(CANVAS.box, [s], false);
    expect([t.nx, t.nz, t.min, t.columns, t.snapshots, t.sampled]).toEqual([4, 4, [0, 0], 4096, 1, false]);
    expect([...t.top]).toEqual([60, 90, NaN, NaN, 61, 61, 61, 61, 62, 62, 62, 62, 63, 63, 63, 63]);
    expect([...t.missing]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  });

  it("draws one cell per chunk with the heights, the brush, context, jobs, the player and a labelled grid", () => {
    const s = surface([0, 0], [63, 63], (x, z) => (x >= 32 && z < 16 ? 0 : x === 20 && z === 5 ? 90 : 60 + (z >> 4)), [[3, 3]]);
    const t = chunkTops(CANVAS.box, [s], false);
    const work: WireBox = { min: [16, 64, 16], max: [31, 70, 31] };
    const m = renderMap(CANVAS, t, {
      origin: [0, -64, 0],
      linked: true,
      work,
      context: [{ min: [13, 61, 13], max: [34, 73, 34] }],
      jobs: [{ id: "j1", box: { min: [40, 64, 40], max: [47, 70, 47] } }],
      player: [52.5, 64, 8.5],
    });
    // 4×4 chunks at 24 px each; labels "0".."64" need 2 characters: left margin 15, top 11.
    expect([m.width, m.height, m.cell, m.step, m.left, m.top]).toEqual([113, 109, 24, 1, 15, 11]);
    const img = Image.decodePng(m.png);
    expect([img.width, img.height]).toEqual([113, 109]);
    const cellAt = (cx: number, cz: number) => px(img, m.left + cx * 24 + 12, m.top + cz * 24 + 12);
    // Heights: chunk (1,0) holds the highest block (90), chunk (0,0) the lowest (60).
    expect(cellAt(1, 0)).toEqual(heightShade(90, 60, 90));
    expect(cellAt(0, 0)).toEqual(heightShade(60, 60, 90));
    expect(cellAt(0, 3)).toEqual(heightShade(63, 60, 90));
    expect(cellAt(2, 0)).toEqual([44, 44, 50, 255]); // no surface block
    expect(cellAt(3, 3)).toEqual([110, 110, 110, 255]); // the grey cross through an ungenerated chunk's middle
    expect(px(img, m.left + 3 * 24 + 5, m.top + 3 * 24 + 12)).toEqual([8, 8, 8, 255]);
    // The brush's corners, block x 16 → px 15 + 24.
    expect(px(img, 39, 35)).toEqual(WORK_COLOUR);
    expect(px(img, 62, 58)).toEqual(WORK_COLOUR);
    expect(px(img, 50, 46)).not.toEqual(WORK_COLOUR);
    // The context, dashed: block 13 → 15 + floor(13·24/16) = 34; its top edge alternates every 2 px.
    expect(px(img, 34, 30)).toEqual(CONTEXT_COLOUR);
    expect(px(img, 35, 30)).toEqual(CONTEXT_COLOUR);
    expect(px(img, 36, 30)).not.toEqual(CONTEXT_COLOUR);
    // The job: block 40 → 75.
    expect(px(img, 75, 71)).toEqual(JOB_COLOUR);
    // The player's ring around block (52, 8) → (93, 23).
    expect(px(img, 90, 20)).toEqual(PLAYER_COLOUR);
    expect(px(img, 93, 23)).not.toEqual(PLAYER_COLOUR);
    expect(m.caption).toBe(
      "Map 113×109 px: 4×4 chunks, 24 px per chunk (16×16 blocks), north up (N top left). Shade = the highest surface block in each chunk, dark at local y 124 to light at 154; " +
        "white = brush (work volume), dashed yellow = context, magenta = open jobs (numbered as listed), cyan ring = the player; dark grey = no surface block read, black with a grey cross = ungenerated. " +
        "Grid every 1 chunk (16 blocks), labelled with local x (top) and z (left).",
    );
  });

  it("keeps a 256-chunk canvas within 480 px of grid, 1 px per chunk, with grid lines further apart", () => {
    const big: MapCanvas = { dimension: OW, box: { min: [-2048, -64, -2048], max: [2047, 319, 2047] } };
    const t = chunkTops(big.box, [], true);
    const m = renderMap(big, t, { origin: [-2048, -64, -2048], linked: false });
    expect([m.cell, m.step]).toEqual([1, 32]);
    expect(m.width).toBeLessThanOrEqual(480 + 40);
    expect(m.height).toBeLessThanOrEqual(480 + 20);
  });
});

// ── against the fake host ─────────────────────────────────────────────────────────────────

let host: FakeHost | undefined;
let bridge: Bridge | undefined;
let map: WorldMap | undefined;
afterEach(async () => {
  map?.close();
  bridge?.close();
  await host?.close();
  host = bridge = map = undefined;
});

async function setup(opts: Parameters<typeof FakeHost.start>[0] = {}, linked?: Vec3) {
  host = await FakeHost.start(opts);
  bridge = new Bridge({ instanceDir: host.instanceDir, volatile: DEFAULT_VOLATILE, reconnect: false, modes: [...REQUEST_MODES] });
  let context: GameContext | undefined;
  bridge.on("prompt", (m) => (context = m.context));
  const m = (map = new WorldMap({ bridge, player: () => context, linked: () => (linked ? { origin: linked, dimension: OW } : undefined), ...(opts.contextCap ? { contextCap: opts.contextCap } : {}) }));
  await bridge.connect();
  // Ground at y 60 over the canvas, a tower to y 80 in chunk (1,1).
  for (let x = 0; x < 64; x++) for (let z = 0; z < 64; z++) host.set([x, 60, z], "minecraft:grass_block");
  for (let y = 61; y <= 80; y++) host.set([20, y, 20], "minecraft:stone");
  return { host, map: m, ask: async () => (void host!.playerAsk(KEV, "look", { position: [40.5, 61, 8.5] }, { mode: "plan" }), await host!.waitFor(() => context)) };
}

describe("world_map against the fake host (19)", () => {
  it("reads every column of the canvas in one surface snapshot and words the canvas, brush and player", async () => {
    const { host, map, ask } = await setup({ canvas: { box: { min: [0, 0, 0], max: [63, 0, 63] } }, volumes: { work: { min: [16, 60, 16], max: [31, 70, 31] } }, missingChunks: new Set(["3,3"]) });
    await host.waitFor(() => map.canvas?.box);
    await ask();
    const r = await map.map();
    expect(host.received.filter((m) => m.type === "snapshot")).toMatchObject([{ kind: "surface", columns: { min: [0, 0], max: [63, 63] } }]);
    expect(r.text.split("\n")).toEqual([
      "ok · world_map · canvas 4×4 chunks (64×64 blocks, world y -64 to 319) in minecraft:overworld, world (0,-64,0)–(63,319,63) = local (0,0,0)–(63,383,63); local (0,0,0) is world (0,-64,0) (the canvas's minimum corner: the frame once a brush inside it links).",
      "Surface: read 4,096 columns in 1 surface snapshot, every column, as of this call. Highest surface block per chunk from local y 124 to 144 (world y 60 to 80); the highest in the chunk at local x 16..31, z 16..31. 1 chunk ungenerated.",
      "Brush: work 16×11×16 at local (16,124,16)–(31,134,31) (world (16,60,16)–(31,70,31)); context 1 box.",
      "Player: at local (40,125,8) (world (40,61,8)).",
      r.image.caption + " Image plus text.",
    ]);
    expect([r.image.width, r.image.height]).toEqual([113, 109]);
  });

  it("goes coarse past the cap (each chunk row's middle line), uses the linked frame, and marks the linked document's jobs", async () => {
    const { host, map } = await setup({ contextCap: 1000, canvas: { box: { min: [0, 0, 0], max: [63, 0, 63] } }, volumes: { work: { min: [16, 60, 16], max: [31, 70, 31] } } }, [0, -64, 0]);
    await host.waitFor(() => map.canvas?.box);
    const r = await map.map([{ id: "j1", box: { min: [40, 124, 40], max: [48, 130, 48] }, blocks: 384 }]);
    expect(host.received.filter((m) => m.type === "snapshot")).toMatchObject([8, 24, 40, 56].map((z) => ({ kind: "surface", columns: { min: [0, z], max: [63, z] } })));
    const lines = r.text.split("\n");
    expect(lines[0]).toMatch(/local \(0,0,0\) is world \(0,-64,0\) \(the linked document's frame\)\.$/);
    // The tower stands at z 20, off chunk row 1's middle line (z 24): the coarse read doesn't see it.
    expect(lines[1]).toBe(
      "Surface: read 256 columns in 4 surface snapshots, coarse: the canvas is over the per-read cap of 1,000 columns (contextCap), so each chunk's middle row (16 of its 256 columns), as of this call. Highest surface block per chunk from local y 124 to 124 (world y 60 to 60); the highest in the chunk at local x 0..15, z 0..15.",
    );
    expect(lines[3]).toBe("Open jobs: [1] j1 at local (40,124,40)–(47,129,47) (384 blocks).");
    expect(lines[4]).toBe("Player: position not known (no in-game request open).");
    const img = Image.decodePng(r.png);
    expect(px(img, r.image.left + 60, r.image.top + 60)).toEqual(JOB_COLOUR);
  });

  it("refuses without a canvas, and forgets the canvas when the game disconnects", async () => {
    const { host, map } = await setup();
    await expect(map.map()).rejects.toThrow(/No canvas is set, so there is nothing to map/);
    host.setCanvas({ box: { min: [0, 0, 0], max: [15, 0, 15] } });
    await host.waitFor(() => map.canvas?.box);
    expect(map.canvas).toEqual({ dimension: OW, box: { min: [0, -64, 0], max: [15, 319, 15] } });
    bridge!.close();
    await host.waitFor(() => map.canvas === undefined || undefined);
    await expect(map.map()).rejects.toThrow(/No game is connected/);
  });
});
