/**
 * Original fixture builds for the golden tier. Every state is written out in full canonical form
 * (all properties, sorted), so the builds need no registry and the format goldens stay
 * independent of the asset pipeline. The render test checks they are canonical for the synthetic
 * instance.
 */
import type { Compound } from "prismarine-nbt";
import { formatState } from "../../src/core/blockstate.js";
import { Document, type Transaction } from "../../src/document/document.js";
import { T } from "../../src/formats/nbt.js";

const st = (id: string, props: Record<string, string> = {}) => formatState(id.includes(":") ? id : `minecraft:${id}`, props);

/**
 * Vanilla blocks carry the game's full property set (from data/vanilla); mod blocks only the
 * properties their blockstate mentions, so the golden: ones have no `waterlogged` and their wall
 * sides can only be low or tall (what the multipart conditions list).
 */
const vanilla = (id: string) => !id.includes(":") || id.startsWith("minecraft:");
const stairs = (id: string, facing: string, half = "bottom") => st(id, { facing, half, shape: "straight", ...(vanilla(id) ? { waterlogged: "false" } : {}) });
const slab = (id: string, type = "bottom") => st(id, { type, waterlogged: "false" });
const log = (id: string, axis: string) => st(id, { axis });
const wall = (id: string, sides: Partial<Record<"north" | "east" | "south" | "west", "none" | "low" | "tall">>, up: boolean) =>
  st(id, { east: sides.east ?? "none", north: sides.north ?? "none", south: sides.south ?? "none", up: String(up), waterlogged: "false", west: sides.west ?? "none" });
const modWall = (id: string, tall: Partial<Record<"north" | "east" | "south" | "west", boolean>>) =>
  st(id, { east: tall.east ? "tall" : "low", north: tall.north ? "tall" : "low", south: tall.south ? "tall" : "low", up: "true", west: tall.west ? "tall" : "low" });
const fence = (sides: Partial<Record<"north" | "east" | "south" | "west", boolean>>) =>
  st("oak_fence", { east: String(!!sides.east), north: String(!!sides.north), south: String(!!sides.south), waterlogged: "false", west: String(!!sides.west) });

export const STATES = {
  grass: st("grass_block", { snowy: "false" }),
  stone: st("stone"),
  bricks: st("stone_bricks"),
  cracked: st("cracked_stone_bricks"),
  planks: st("oak_planks"),
  glass: st("glass"),
  glowstone: st("glowstone"),
  leaves: st("oak_leaves", { distance: "7", persistent: "true", waterlogged: "false" }),
  chest: st("chest", { facing: "south", type: "single", waterlogged: "false" }),
  marble: st("golden:marble"),
  chiseled: st("golden:chiseled_marble"),
  marbleBricks: st("golden:marble_bricks"),
  rubble: st("golden:rubble"),
  crate: st("kubejs:crate"),
  lampOn: st("golden:lamp", { lit: "true" }),
  lampOff: st("golden:lamp", { lit: "false" }),
  /** Not in any registry: must survive every format and draw as the placeholder. */
  gizmo: st("othermod:gizmo", { mode: "fast" }),
};

/** Chest contents and a deliberately odd compound covering every NBT tag type. */
export function chestNbt(): Compound {
  return T.compound({
    id: T.str("minecraft:chest"),
    CustomName: T.str('{"text":"Supplies"}'),
    Items: T.compoundList([
      T.compound({ Slot: T.byte(0), id: T.str("minecraft:oak_planks"), count: T.int(32) }),
      T.compound({ Slot: T.byte(13), id: T.str("othermod:widget"), count: T.int(1), components: T.compound({ "othermod:charge": T.int(7) }) }),
    ]),
  });
}

export function gizmoNbt(): Compound {
  return T.compound({
    id: T.str("othermod:gizmo"),
    Speed: { type: "float", value: 1.5 },
    Ratio: { type: "double", value: 0.125 },
    Ticks: T.short(-3),
    Owner: { type: "intArray", value: [1, -2, 3, -4] },
    Seed: { type: "long", value: [0x12345678, 0x1abcdef] },
    Bytes: { type: "byteArray", value: [1, -1, 0, 127] },
    Longs: { type: "longArray", value: [[0, 1], [-1, -1]] },
    Grid: { type: "list", value: { type: "list", value: [{ type: "int", value: [1, 2] }, { type: "int", value: [3] }] } },
    Empty: T.compound({}),
  } as Compound["value"]);
}

/** Our own made-up entity: a marker with nested data. */
export function markerEntity(): Compound {
  return T.compound({
    id: T.str("othermod:marker"),
    Pos: T.doubleList([5.5, 1, 9.5]),
    Rotation: { type: "list", value: { type: "float", value: [90, 0] } },
    Tags: { type: "list", value: { type: "string", value: ["golden", "fixture"] } },
  } as Compound["value"]);
}

/**
 * A small cottage, front (door) facing south: stone-brick walls with log corners, a gabled stair
 * roof, glass windows, a wool rug, a fenced yard, a chest, a lamp-lit door and a few mod and
 * unknown blocks. 11 × 10 × 11.
 */
export function cottage(opts: { nbt?: boolean } = {}): Document {
  const doc = Document.create({ name: "cottage", dataVersion: 3955, seed: 7, size: [11, 10, 11] });
  doc.edit("test", "build cottage", (tx: Transaction) => {
    const S = STATES;
    for (let x = 0; x <= 10; x++) for (let z = 0; z <= 10; z++) tx.set(x, 0, z, S.grass);
    // Floor: stone border, wool rug inside.
    const rug = ["minecraft:red_wool", "minecraft:white_wool", "minecraft:blue_wool"];
    for (let x = 2; x <= 8; x++)
      for (let z = 2; z <= 7; z++) {
        const edge = x === 2 || x === 8 || z === 2 || z === 7;
        tx.set(x, 1, z, edge ? S.stone : rug[(x + z) % 3]!);
      }
    // Walls y 2..4, log corners.
    for (let y = 2; y <= 4; y++)
      for (let x = 2; x <= 8; x++)
        for (let z = 2; z <= 7; z++) {
          const onX = x === 2 || x === 8, onZ = z === 2 || z === 7;
          if (!onX && !onZ) continue;
          tx.set(x, y, z, onX && onZ ? log("oak_log", "y") : (x * 3 + z * 5 + y) % 7 === 0 ? S.cracked : S.bricks);
        }
    // Door gap, windows, lintel.
    tx.set(5, 2, 7, "minecraft:air");
    tx.set(5, 3, 7, "minecraft:air");
    tx.set(5, 4, 7, S.chiseled);
    for (const x of [3, 7]) (tx.set(x, 3, 7, S.glass), tx.set(x, 3, 2, S.glass));
    for (const z of [4, 5]) (tx.set(2, 3, z, S.glass), tx.set(8, 3, z, S.glass));
    tx.set(5, 4, 2, S.marble);
    // Gable roof along x: south slope faces north, north slope faces south; slab ridge.
    for (let x = 1; x <= 9; x++) {
      for (let i = 0; i < 3; i++) {
        tx.set(x, 5 + i, 8 - i, stairs("oak_stairs", "north"));
        tx.set(x, 5 + i, 1 + i, stairs("oak_stairs", "south"));
      }
      tx.set(x, 8, 4, slab("oak_slab"));
      tx.set(x, 8, 5, slab("oak_slab"));
    }
    // Gable ends.
    for (const x of [2, 8])
      for (let y = 5; y <= 7; y++) for (let z = 2 + (y - 5); z <= 7 - (y - 5); z++) tx.set(x, y, z, S.planks);
    // Chimney (marble pillar) through the north slope.
    for (let y = 6; y <= 9; y++) tx.set(7, y, 3, log("golden:marble_pillar", "y"));
    // Inside: glowstone ceiling light, chest, unknown gizmo.
    tx.set(5, 4, 4, S.glowstone);
    tx.set(3, 2, 3, S.chest, opts.nbt ? chestNbt() : undefined);
    tx.set(7, 2, 6, S.gizmo, opts.nbt ? gizmoNbt() : undefined);
    // Front: marble step, path, lamps, yard.
    tx.set(5, 1, 8, stairs("golden:marble_brick_stairs", "north"));
    tx.set(5, 1, 9, slab("stone_brick_slab"));
    tx.set(5, 1, 10, slab("stone_brick_slab"));
    tx.set(4, 3, 8, S.lampOn);
    tx.set(6, 3, 8, S.lampOff);
    tx.set(7, 1, 9, S.crate);
    tx.set(8, 1, 9, log("golden:marble_pillar", "x"));
    tx.set(9, 1, 9, log("golden:marble_pillar", "x"));
    tx.set(1, 1, 8, S.leaves);
    tx.set(1, 2, 8, S.leaves);
    tx.set(1, 1, 7, S.leaves);
    tx.set(9, 1, 1, S.rubble);
    // Fence along the south edge (gap for the path), wall along the north edge.
    for (let x = 0; x <= 10; x++) {
      if (x !== 5) tx.set(x, 1, 10, fence({ west: x > 0 && x !== 6, east: x < 10 && x !== 4 }));
      const end = x === 0 || x === 10;
      tx.set(x, 1, 0, x === 5 ? modWall("golden:marble_brick_wall", { west: true }) : wall("stone_brick_wall", { west: x > 0 ? "low" : "none", east: x < 10 ? "low" : "none" }, end));
    }
  });
  if (opts.nbt) doc.entities = [markerEntity()];
  return doc;
}

/**
 * Every rotated, switched and multipart state on a grid, spaced so nothing occludes: log and
 * pillar axes, stairs in all facings and halves, slab types, wall and fence connections, lamp
 * on/off, the weighted-variant block and a glass block.
 */
export function sampler(): Document {
  const doc = Document.create({ name: "sampler", dataVersion: 3955, seed: 3, size: [15, 3, 9] });
  doc.edit("test", "build sampler", (tx) => {
    const row = (z: number, states: string[]) => states.forEach((s, i) => tx.set(i * 2, 0, z, s));
    row(0, ["x", "y", "z"].flatMap((a) => [log("oak_log", a), log("golden:marble_pillar", a)]));
    row(2, ["north", "east", "south", "west"].flatMap((f) => [stairs("stone_brick_stairs", f), stairs("golden:marble_brick_stairs", f, "top")]));
    row(4, [slab("oak_slab"), slab("oak_slab", "top"), slab("oak_slab", "double"), STATES.lampOff, STATES.lampOn, STATES.rubble, STATES.glass, STATES.gizmo]);
    row(6, [
      wall("stone_brick_wall", { north: "low", south: "low" }, false),
      wall("stone_brick_wall", { east: "tall", west: "low" }, true),
      modWall("golden:marble_brick_wall", { north: true }),
      fence({}),
      fence({ north: true, east: true }),
      fence({ north: true, east: true, south: true, west: true }),
      STATES.grass,
      STATES.leaves,
    ]);
    row(8, [STATES.bricks, STATES.cracked, STATES.stone, STATES.planks, STATES.marble, STATES.chiseled, STATES.marbleBricks, STATES.crate]);
  });
  return doc;
}
