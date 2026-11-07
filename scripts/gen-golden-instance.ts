#!/usr/bin/env -S npx tsx
/**
 * Generates the synthetic Minecraft instance the golden test tier runs against
 * (docs/design/10-testing.md, "Asset pipeline"). Everything in it is original: the block models
 * are hand-written JSON in the game's model format, and every texture is drawn procedurally
 * below. No game or mod asset is read or copied (docs/design/02-assets-registry.md, Legal stance).
 *
 *   npx tsx scripts/gen-golden-instance.ts <out-dir>
 *
 * The golden tests call `writeSyntheticInstance` into a temp folder, so nothing binary is
 * committed. Output is byte-for-byte reproducible (fixed zip timestamps, seeded noise).
 *
 * What it covers:
 *   - VFS layer order: a vanilla-layout instance with a base jar, two mod jars (alphabetical),
 *     a KubeJS folder, a selected resource pack and an OpenLoader pack. Each layer ships
 *     `assets/golden/probe/<k>.txt` for every k ≥ its own position, so probe k must resolve to
 *     layer k. Real overrides ride along (a mod retexturing a base block, a pack restyling a model).
 *   - Blockstates: plain variants, rotated variants (logs, pillars, stairs), a property-switched
 *     variant (lamp), a weighted list, and multipart (wall, fence).
 *   - Parent chains: a mod model three levels deep before reaching the base cube, with texture
 *     variables passed down through `#refs`.
 *   - Colour index: a 16-colour wool series, tinted blocks with their own colormaps, distinct
 *     solid hues for the stone, wood and marble families.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Image } from "../src/palette/image.js";
import { makeZip, writeTree, type FileTree } from "../test/helpers/fixtures.js";

export const MC_VERSION = "1.21.1";
/** Zip entry timestamps, fixed so jars are reproducible. */
export const SYNTHETIC_MTIME = new Date(Date.UTC(2026, 0, 1));

/** Layer ids in the order the locator must report them, lowest priority first. */
export const SYNTHETIC_LAYERS = [
  `minecraft:${MC_VERSION}.jar`,
  "mod:a_golden.jar",
  "mod:b_tweaks.jar",
  "generated:kubejs",
  "resourcepack:Restyle.zip",
  "openloader:00_top.zip",
] as const;

// ---------------------------------------------------------------------------------------------
// Procedural textures
// ---------------------------------------------------------------------------------------------

type RGB = [number, number, number];
type RGBA = [number, number, number, number];

/** Deterministic hash noise in [0, 1). */
function hash(x: number, y: number, seed: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
const shade = (c: RGB, k: number): RGB => [clamp(c[0] * k), clamp(c[1] * k), clamp(c[2] * k)];

function texture(fn: (x: number, y: number) => RGB | RGBA, size = 16): Uint8Array {
  const img = new Image(size, size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const c = fn(x, y);
      const i = (y * size + x) * 4;
      img.data[i] = c[0];
      img.data[i + 1] = c[1];
      img.data[i + 2] = c[2];
      img.data[i + 3] = c[3] ?? 255;
    }
  return img.encodePng();
}

/** Flat colour with per-pixel brightness noise. */
const speckle = (base: RGB, amp: number, seed: number) => texture((x, y) => shade(base, 1 + (hash(x, y, seed) - 0.5) * amp));

/** Running-bond bricks: 8×4 bricks, alternate rows offset by half a brick. */
const bricks = (brick: RGB, mortar: RGB, seed: number) =>
  texture((x, y) => {
    const row = y >> 2;
    const off = row % 2 ? 4 : 0;
    if (y % 4 === 3 || (x + off) % 8 === 7) return mortar;
    return shade(brick, 0.9 + hash((x + off) >> 3, row, seed) * 0.2 + (hash(x, y, seed + 1) - 0.5) * 0.08);
  });

/** Horizontal boards with darker seams and a running grain. */
const planks = (wood: RGB, seed: number) =>
  texture((x, y) => {
    if (y % 4 === 3) return shade(wood, 0.7);
    const grain = Math.sin((x + hash(0, y >> 2, seed) * 16) * 0.9) * 0.06;
    return shade(wood, 1 + grain + (hash(x, y, seed) - 0.5) * 0.06);
  });

/** Vertical bark furrows. */
const bark = (c: RGB, seed: number) => texture((x, y) => shade(c, 0.85 + hash(x, 0, seed) * 0.25 + (hash(x, y, seed + 1) - 0.5) * 0.1));

/** End grain: concentric square rings. */
const rings = (ring: RGB, core: RGB, edge: RGB) =>
  texture((x, y) => {
    const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
    if (d > 7) return edge;
    return Math.floor(d) % 3 === 0 ? ring : core;
  });

/** Clear pane with an opaque frame and a faint diagonal streak. */
const pane = (frame: RGB, fillAlpha: number) =>
  texture((x, y) => {
    if (x === 0 || y === 0 || x === 15 || y === 15) return [...frame, 255];
    if (x - y === 4 || x - y === 5) return [255, 255, 255, 140];
    return [frame[0], frame[1], frame[2], fillAlpha];
  });

/** A bordered tile (polished stone, lamp faces). */
const framed = (inner: RGB, border: RGB, seed: number) =>
  texture((x, y) => (x === 0 || y === 0 || x === 15 || y === 15 ? border : shade(inner, 1 + (hash(x, y, seed) - 0.5) * 0.05)));

/** Veined stone: diagonal bands. */
const veined = (base: RGB, vein: RGB, seed: number) =>
  texture((x, y) => (Math.abs(((x * 2 + y + Math.floor(hash(y, 0, seed) * 3)) % 11) - 5) === 0 ? vein : shade(base, 1 + (hash(x, y, seed) - 0.5) * 0.04)));

/** A two-axis colour gradient used as a biome colormap. */
const colormap = (a: RGB, b: RGB, c: RGB) =>
  texture((x, y) => {
    const u = x / 15, v = y / 15;
    return [0, 1, 2].map((i) => clamp(a[i]! * (1 - u) * (1 - v) + b[i]! * u * (1 - v) + c[i]! * v)) as RGB;
  });

/** Wool: soft cross-hatched fibre. */
const wool = (c: RGB, seed: number) => texture((x, y) => shade(c, 0.94 + ((x + y) % 4 === 0 ? -0.06 : 0) + (hash(x, y, seed) - 0.5) * 0.08));

/** Our own wool colours, one per dye name (any distinct hues would do). */
export const WOOL_COLORS: [string, RGB][] = [
  ["white", [236, 236, 230]], ["orange", [226, 128, 40]], ["magenta", [184, 72, 176]], ["light_blue", [96, 168, 220]],
  ["yellow", [232, 206, 64]], ["lime", [124, 196, 52]], ["pink", [228, 144, 168]], ["gray", [76, 80, 84]],
  ["light_gray", [150, 150, 144]], ["cyan", [32, 140, 150]], ["purple", [120, 56, 168]], ["blue", [52, 64, 160]],
  ["brown", [118, 80, 50]], ["green", [84, 112, 32]], ["red", [168, 44, 40]], ["black", [28, 28, 32]],
];

// ---------------------------------------------------------------------------------------------
// Models (hand-written, in the game's JSON model format)
// ---------------------------------------------------------------------------------------------

const box = (from: number[], to: number[], tex: string, extra: Record<string, unknown> = {}) => ({
  from,
  to,
  faces: Object.fromEntries(["down", "up", "north", "south", "west", "east"].map((f) => [f, { texture: tex, ...extra }])),
});

const BASE_MODELS: FileTree = {
  "assets/minecraft/models/block/block.json": { textures: { particle: "#all" } },
  "assets/minecraft/models/block/cube.json": {
    parent: "block/block",
    elements: [
      {
        from: [0, 0, 0],
        to: [16, 16, 16],
        faces: {
          down: { texture: "#down", cullface: "down" },
          up: { texture: "#up", cullface: "up" },
          north: { texture: "#north", cullface: "north" },
          south: { texture: "#south", cullface: "south" },
          west: { texture: "#west", cullface: "west" },
          east: { texture: "#east", cullface: "east" },
        },
      },
    ],
  },
  "assets/minecraft/models/block/cube_all.json": {
    parent: "block/cube",
    textures: { particle: "#all", down: "#all", up: "#all", north: "#all", south: "#all", west: "#all", east: "#all" },
  },
  "assets/minecraft/models/block/cube_column.json": {
    parent: "block/cube",
    textures: { particle: "#side", down: "#end", up: "#end", north: "#side", south: "#side", west: "#side", east: "#side" },
  },
  "assets/minecraft/models/block/tinted_cube_all.json": {
    parent: "block/block",
    elements: [{ ...box([0, 0, 0], [16, 16, 16], "#all", { tintindex: 0 }) }],
  },
  "assets/minecraft/models/block/slab.json": {
    parent: "block/block",
    elements: [{ from: [0, 0, 0], to: [16, 8, 16], faces: { down: { texture: "#bottom", cullface: "down" }, up: { texture: "#top" }, north: { texture: "#side" }, south: { texture: "#side" }, west: { texture: "#side" }, east: { texture: "#side" } } }],
  },
  "assets/minecraft/models/block/slab_top.json": {
    parent: "block/block",
    elements: [{ from: [0, 8, 0], to: [16, 16, 16], faces: { down: { texture: "#bottom" }, up: { texture: "#top", cullface: "up" }, north: { texture: "#side" }, south: { texture: "#side" }, west: { texture: "#side" }, east: { texture: "#side" } } }],
  },
  // Straight stairs, climbing toward east (the game's convention; blockstates rotate it).
  "assets/minecraft/models/block/stairs.json": {
    parent: "block/block",
    elements: [
      { from: [0, 0, 0], to: [16, 8, 16], faces: { down: { texture: "#bottom", cullface: "down" }, up: { texture: "#top" }, north: { texture: "#side" }, south: { texture: "#side" }, west: { texture: "#side" }, east: { texture: "#side", cullface: "east" } } },
      { from: [8, 8, 0], to: [16, 16, 16], faces: { up: { texture: "#top", cullface: "up" }, north: { texture: "#side" }, south: { texture: "#side" }, west: { texture: "#side" }, east: { texture: "#side", cullface: "east" } } },
    ],
  },
  "assets/minecraft/models/block/wall_post.json": { parent: "block/block", elements: [box([4, 0, 4], [12, 16, 12], "#wall")] },
  "assets/minecraft/models/block/wall_side.json": { parent: "block/block", elements: [box([5, 0, 0], [11, 14, 8], "#wall")] },
  "assets/minecraft/models/block/wall_side_tall.json": { parent: "block/block", elements: [box([5, 0, 0], [11, 16, 8], "#wall")] },
  "assets/minecraft/models/block/fence_post.json": { parent: "block/block", elements: [box([6, 0, 6], [10, 16, 10], "#texture")] },
  "assets/minecraft/models/block/fence_side.json": {
    parent: "block/block",
    elements: [box([7, 12, 0], [9, 15, 9], "#texture"), box([7, 6, 0], [9, 9, 9], "#texture")],
  },
  "assets/minecraft/models/block/grass_block.json": {
    parent: "block/block",
    textures: { particle: "block/dirt", bottom: "block/dirt", top: "block/grass_block_top", side: "block/grass_block_side" },
    elements: [
      {
        from: [0, 0, 0],
        to: [16, 16, 16],
        faces: {
          down: { texture: "#bottom", cullface: "down" },
          up: { texture: "#top", cullface: "up", tintindex: 0 },
          north: { texture: "#side", cullface: "north" },
          south: { texture: "#side", cullface: "south" },
          west: { texture: "#side", cullface: "west" },
          east: { texture: "#side", cullface: "east" },
        },
      },
    ],
  },
};

const cubeAll = (ns: string, name: string, tex = `${ns}:block/${name}`): FileTree => ({
  [`assets/${ns}/blockstates/${name}.json`]: { variants: { "": { model: `${ns}:block/${name}` } } },
  [`assets/${ns}/models/block/${name}.json`]: { parent: "minecraft:block/cube_all", textures: { all: tex } },
});

/** Axis-rotated column (logs, pillars). */
const column = (ns: string, name: string, side: string, end: string): FileTree => ({
  [`assets/${ns}/blockstates/${name}.json`]: {
    variants: {
      "axis=x": { model: `${ns}:block/${name}`, x: 90, y: 90 },
      "axis=y": { model: `${ns}:block/${name}` },
      "axis=z": { model: `${ns}:block/${name}`, x: 90 },
    },
  },
  [`assets/${ns}/models/block/${name}.json`]: { parent: "minecraft:block/cube_column", textures: { side, end } },
});

const FACING_Y: Record<string, number> = { east: 0, south: 90, west: 180, north: 270 };

function stairs(ns: string, name: string, tex: string): FileTree {
  const variants: Record<string, unknown> = {};
  for (const facing of Object.keys(FACING_Y))
    for (const half of ["bottom", "top"])
      for (const shape of ["straight", "inner_left", "inner_right", "outer_left", "outer_right"]) {
        // Every shape draws as straight: enough for the pipeline, and keeps this file short.
        variants[`facing=${facing},half=${half},shape=${shape}`] = {
          model: `${ns}:block/${name}`,
          ...(half === "top" ? { x: 180 } : {}),
          ...(FACING_Y[facing] ? { y: FACING_Y[facing] } : {}),
          uvlock: true,
        };
      }
  return {
    [`assets/${ns}/blockstates/${name}.json`]: { variants },
    [`assets/${ns}/models/block/${name}.json`]: { parent: "minecraft:block/stairs", textures: { bottom: tex, top: tex, side: tex } },
  };
}

function slab(ns: string, name: string, tex: string, double: string): FileTree {
  return {
    [`assets/${ns}/blockstates/${name}.json`]: {
      variants: { "type=bottom": { model: `${ns}:block/${name}` }, "type=top": { model: `${ns}:block/${name}_top` }, "type=double": { model: double } },
    },
    [`assets/${ns}/models/block/${name}.json`]: { parent: "minecraft:block/slab", textures: { bottom: tex, top: tex, side: tex } },
    [`assets/${ns}/models/block/${name}_top.json`]: { parent: "minecraft:block/slab_top", textures: { bottom: tex, top: tex, side: tex } },
  };
}

function wall(ns: string, name: string, tex: string): FileTree {
  const m = (suffix: string) => `${ns}:block/${name}_${suffix}`;
  const parts: unknown[] = [{ when: { up: "true" }, apply: { model: m("post") } }];
  for (const [dir, y] of Object.entries({ north: 0, east: 90, south: 180, west: 270 })) {
    parts.push({ when: { [dir]: "low" }, apply: { model: m("side"), y, uvlock: true } });
    parts.push({ when: { [dir]: "tall" }, apply: { model: m("side_tall"), y, uvlock: true } });
  }
  return {
    [`assets/${ns}/blockstates/${name}.json`]: { multipart: parts },
    [`assets/${ns}/models/block/${name}_post.json`]: { parent: "minecraft:block/wall_post", textures: { wall: tex } },
    [`assets/${ns}/models/block/${name}_side.json`]: { parent: "minecraft:block/wall_side", textures: { wall: tex } },
    [`assets/${ns}/models/block/${name}_side_tall.json`]: { parent: "minecraft:block/wall_side_tall", textures: { wall: tex } },
  };
}

function fence(ns: string, name: string, tex: string): FileTree {
  const parts: unknown[] = [{ apply: { model: `${ns}:block/${name}_post` } }];
  for (const [dir, y] of Object.entries({ north: 0, east: 90, south: 180, west: 270 })) {
    parts.push({ when: { [dir]: "true" }, apply: { model: `${ns}:block/${name}_side`, y, uvlock: true } });
  }
  return {
    [`assets/${ns}/blockstates/${name}.json`]: { multipart: parts },
    [`assets/${ns}/models/block/${name}_post.json`]: { parent: "minecraft:block/fence_post", textures: { texture: tex } },
    [`assets/${ns}/models/block/${name}_side.json`]: { parent: "minecraft:block/fence_side", textures: { texture: tex } },
  };
}

/** Layer i ships probe files k ≥ i, so probe k must resolve to layer k. */
function probes(layer: number, ns = "golden"): FileTree {
  const out: FileTree = {};
  for (let k = layer; k < SYNTHETIC_LAYERS.length; k++) out[`assets/${ns}/probe/${k}.txt`] = SYNTHETIC_LAYERS[layer]!;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------------------------

const STONE: RGB = [128, 130, 134];
const BRICK: RGB = [116, 118, 124];
const OAK: RGB = [176, 138, 84];
const BARK: RGB = [92, 70, 44];
const MARBLE: RGB = [226, 222, 214];

function baseJar(): FileTree {
  const t = (name: string) => `assets/minecraft/textures/block/${name}.png`;
  const tree: FileTree = {
    "version.json": { id: MC_VERSION, name: MC_VERSION },
    "pack.mcmeta": { pack: { pack_format: 34, description: "Autosketch synthetic base (original test assets)" } },
    ...probes(0),
    ...BASE_MODELS,
    ...cubeAll("minecraft", "stone"),
    ...cubeAll("minecraft", "stone_bricks"),
    ...cubeAll("minecraft", "cracked_stone_bricks"),
    ...stairs("minecraft", "stone_brick_stairs", "minecraft:block/stone_bricks"),
    ...slab("minecraft", "stone_brick_slab", "minecraft:block/stone_bricks", "minecraft:block/stone_bricks"),
    ...wall("minecraft", "stone_brick_wall", "minecraft:block/stone_bricks"),
    ...cubeAll("minecraft", "oak_planks"),
    ...stairs("minecraft", "oak_stairs", "minecraft:block/oak_planks"),
    ...slab("minecraft", "oak_slab", "minecraft:block/oak_planks", "minecraft:block/oak_planks"),
    ...fence("minecraft", "oak_fence", "minecraft:block/oak_planks"),
    ...column("minecraft", "oak_log", "minecraft:block/oak_log", "minecraft:block/oak_log_top"),
    ...cubeAll("minecraft", "glass"),
    ...cubeAll("minecraft", "glowstone"),
    "assets/minecraft/blockstates/grass_block.json": { variants: { "snowy=false": { model: "minecraft:block/grass_block" }, "snowy=true": { model: "minecraft:block/grass_block" } } },
    "assets/minecraft/blockstates/oak_leaves.json": { variants: { "": { model: "minecraft:block/oak_leaves" } } },
    "assets/minecraft/models/block/oak_leaves.json": { parent: "block/tinted_cube_all", textures: { all: "block/oak_leaves" } },
    // A block entity with no element model: it draws as the fallback placeholder.
    "assets/minecraft/blockstates/chest.json": { variants: { "": { model: "minecraft:block/chest" } } },
    "assets/minecraft/models/block/chest.json": { parent: "builtin/entity", textures: { particle: "block/oak_planks" } },

    [t("stone")]: speckle(STONE, 0.18, 1),
    [t("stone_bricks")]: bricks(BRICK, [84, 86, 90], 2),
    [t("cracked_stone_bricks")]: bricks(shade(BRICK, 0.92), [60, 60, 62], 3),
    [t("oak_planks")]: planks(OAK, 4),
    [t("oak_log")]: bark(BARK, 5),
    [t("oak_log_top")]: rings(shade(OAK, 0.8), OAK, BARK),
    [t("glass")]: pane([200, 224, 232], 48),
    [t("glowstone")]: speckle([236, 200, 96], 0.35, 6),
    [t("dirt")]: speckle([122, 86, 58], 0.25, 7),
    [t("grass_block_top")]: speckle([160, 160, 160], 0.25, 8), // grey: tinted by the grass colormap
    [t("grass_block_side")]: texture((x, y) => (y < 3 + Math.floor(hash(x, 0, 9) * 2) ? [92, 140, 60] : shade([122, 86, 58], 1 + (hash(x, y, 9) - 0.5) * 0.25))),
    [t("oak_leaves")]: texture((x, y) => (hash(x, y, 10) < 0.15 ? [0, 0, 0, 0] : [...shade([150, 150, 150], 0.8 + hash(x, y, 11) * 0.4), 255] as RGBA)),
    "assets/minecraft/textures/colormap/grass.png": colormap([140, 180, 80], [190, 180, 90], [70, 130, 60]),
    "assets/minecraft/textures/colormap/foliage.png": colormap([96, 160, 48], [170, 150, 60], [40, 110, 40]),

    "data/minecraft/tags/block/logs.json": { values: ["#minecraft:oak_logs"] },
    "data/minecraft/tags/block/oak_logs.json": { values: ["minecraft:oak_log"] },
    "data/minecraft/tags/block/walls.json": { values: ["minecraft:stone_brick_wall"] },
    "data/minecraft/tags/block/stairs.json": { values: ["minecraft:stone_brick_stairs", "minecraft:oak_stairs"] },
  };
  WOOL_COLORS.forEach(([dye, rgb], i) => Object.assign(tree, cubeAll("minecraft", `${dye}_wool`), { [t(`${dye}_wool`)]: wool(rgb, 20 + i) }));
  return tree;
}

function goldenMod(): FileTree {
  const t = (name: string) => `assets/golden/textures/block/${name}.png`;
  return {
    "META-INF/neoforge.mods.toml": 'modLoader="javafml"\nloaderVersion="[1,)"\n[[mods]]\nmodId="golden"\ndisplayName="Golden Test Blocks"\n',
    ...probes(1),
    // Parent chain: golden:block/marble → golden:block/polished → golden:block/template → minecraft:block/cube_all → cube → block.
    "assets/golden/blockstates/marble.json": { variants: { "": { model: "golden:block/marble" } } },
    "assets/golden/models/block/marble.json": { parent: "golden:block/polished", textures: { stone: "golden:block/marble" } },
    "assets/golden/models/block/polished.json": { parent: "golden:block/template", textures: { face: "#stone" } },
    "assets/golden/models/block/template.json": { parent: "minecraft:block/cube_all", textures: { all: "#face" } },
    ...cubeAll("golden", "chiseled_marble"),
    ...cubeAll("golden", "marble_bricks"),
    ...stairs("golden", "marble_brick_stairs", "golden:block/marble_bricks"),
    ...slab("golden", "marble_brick_slab", "golden:block/marble_bricks", "golden:block/marble_bricks"),
    ...wall("golden", "marble_brick_wall", "golden:block/marble_bricks"),
    ...column("golden", "marble_pillar", "golden:block/marble_pillar", "golden:block/marble_pillar_top"),
    // Property-switched variant.
    "assets/golden/blockstates/lamp.json": { variants: { "lit=false": { model: "golden:block/lamp" }, "lit=true": { model: "golden:block/lamp_on" } } },
    "assets/golden/models/block/lamp.json": { parent: "minecraft:block/cube_all", textures: { all: "golden:block/lamp" } },
    "assets/golden/models/block/lamp_on.json": { parent: "minecraft:block/cube_all", textures: { all: "golden:block/lamp_on" } },
    // Weighted variant list: the first entry is the one drawn.
    "assets/golden/blockstates/rubble.json": { variants: { "": [{ model: "golden:block/rubble", weight: 3 }, { model: "golden:block/rubble_alt", y: 90 }] } },
    "assets/golden/models/block/rubble.json": { parent: "minecraft:block/cube_all", textures: { all: "golden:block/rubble" } },
    "assets/golden/models/block/rubble_alt.json": { parent: "minecraft:block/cube_all", textures: { all: "golden:block/marble" } },

    // Mod retextures a base-game block.
    "assets/minecraft/textures/block/oak_planks.png": planks([196, 150, 92], 40),

    [t("marble")]: veined(MARBLE, [180, 176, 170], 41), // replaced by b_tweaks.jar
    [t("chiseled_marble")]: framed(MARBLE, [170, 166, 160], 42),
    [t("marble_bricks")]: bricks(MARBLE, [190, 186, 180], 43),
    [t("marble_pillar")]: texture((x, y) => (x < 2 || x > 13 ? shade(MARBLE, 0.82) : shade(MARBLE, 1 + (hash(x, y, 44) - 0.5) * 0.05))),
    [t("marble_pillar_top")]: framed(shade(MARBLE, 0.95), shade(MARBLE, 0.8), 45),
    [t("lamp")]: framed([90, 70, 40], [60, 50, 30], 46),
    [t("lamp_on")]: framed([250, 220, 120], [160, 120, 50], 47),
    [t("rubble")]: speckle([100, 96, 90], 0.5, 48),

    "data/minecraft/tags/block/logs.json": { values: [{ id: "golden:marble_pillar", required: false }] },
    "data/minecraft/tags/block/walls.json": { values: ["golden:marble_brick_wall"] },
    "data/golden/tags/block/polished.json": { values: ["golden:marble", "golden:chiseled_marble"] },
  };
}

function tweaksMod(): FileTree {
  return {
    "META-INF/neoforge.mods.toml": 'modLoader="javafml"\nloaderVersion="[1,)"\n[[mods]]\nmodId="tweaks"\ndisplayName="Tweaks"\n',
    ...probes(2),
    // Sorts after a_golden.jar, so this replaces the marble texture.
    "assets/golden/textures/block/marble.png": veined([232, 226, 236], [196, 186, 206], 50),
    // replace: drops a_golden's chiseled_marble from the tag.
    "data/golden/tags/block/polished.json": { replace: true, values: ["golden:marble", "golden:marble_bricks"] },
  };
}

function kubejs(): FileTree {
  return {
    ...probes(3),
    ...cubeAll("kubejs", "crate"),
    "assets/kubejs/textures/block/crate.png": framed([150, 110, 64], [90, 64, 36], 60),
    "data/minecraft/tags/block/logs.json": { values: ["kubejs:crate"] },
  };
}

function restylePack(): FileTree {
  return {
    "pack.mcmeta": { pack: { pack_format: 34, description: "restyles stone bricks" } },
    ...probes(4),
    "assets/minecraft/models/block/stone_bricks.json": { parent: "block/cube_all", textures: { all: "block/restyled_bricks" } },
    "assets/minecraft/textures/block/restyled_bricks.png": bricks([150, 108, 96], [96, 90, 86], 70),
    // A blockstate for a mod that isn't installed: resource packs must not create blocks.
    "assets/absent/blockstates/ghost.json": { variants: { "": { model: "minecraft:block/stone" } } },
  };
}

function openloaderPack(): FileTree {
  return {
    "pack.mcmeta": { pack: { pack_format: 34, description: "force-enabled top layer" } },
    ...probes(5),
    "assets/minecraft/textures/block/glass.png": pane([168, 208, 236], 72),
  };
}

/** The whole instance as root-relative files (jars and zips already packed). */
export function syntheticInstanceTree(): FileTree {
  const zip = (files: FileTree) => makeZip(files, { mtime: SYNTHETIC_MTIME });
  const kube: FileTree = {};
  for (const [p, v] of Object.entries(kubejs())) kube[`kubejs/${p}`] = v;
  return {
    [`versions/${MC_VERSION}/${MC_VERSION}.jar`]: zip(baseJar()),
    "mods/a_golden.jar": zip(goldenMod()),
    "mods/b_tweaks.jar": zip(tweaksMod()),
    "mods/c_disabled.jar.disabled": zip({ ...probes(0), "assets/golden/probe/5.txt": "disabled jars must be ignored" }),
    ...kube,
    "resourcepacks/Restyle.zip": zip(restylePack()),
    "resourcepacks/Unselected.zip": zip({ "assets/golden/probe/5.txt": "unselected packs must be ignored" }),
    "config/openloader/packs/00_top.zip": zip(openloaderPack()),
    "options.txt": 'version:3955\nresourcePacks:["vanilla","mod_resources","file/Restyle.zip"]\nlang:en_us\n',
  };
}

/** Writes the synthetic instance into `dir` (its root) and returns `dir`. */
export async function writeSyntheticInstance(dir: string): Promise<string> {
  await writeTree(dir, syntheticInstanceTree());
  return dir;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[2];
  if (!out) throw new Error("usage: npx tsx scripts/gen-golden-instance.ts <out-dir>");
  await writeSyntheticInstance(out);
  console.log(`wrote synthetic instance to ${join(out)}`);
}
