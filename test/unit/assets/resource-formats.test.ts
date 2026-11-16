import { describe, expect, it } from "vitest";
import { isFullCube, ModelResolver, parseBlockstate, parseElementRotation, rotateFace, selectModels } from "../../../src/assets/models.js";
import { TextureLoader } from "../../../src/palette/textures.js";
import { BlockBaker, type BakedBlock, type BakedQuad } from "../../../src/perception/render/bake.js";
import { solidPng } from "../../helpers/fixtures.js";
import { memStack, VANILLA_PARENTS } from "../../helpers/stack.js";

/**
 * Newer resource formats (14, "Resource formats on the MCP side"), read alongside the old ones
 * with no version switch: multi-axis element rotation and variant `z` (1.21.11), texture entries
 * as objects (26.1), `shade_direction_override` (26.3), and angles off the 22.5° grid (1.21.6).
 * Every fixture is synthetic.
 */

const GREY: [number, number, number] = [128, 128, 128];
const RED: [number, number, number] = [200, 30, 30];

const plate = (rotation: unknown) => ({
  textures: { t: "test:block/grey" },
  elements: [{ from: [0, 7, 0], to: [16, 9, 16], rotation, faces: { up: { texture: "#t" }, north: { texture: "#t" } } }],
});
const one = (model: string, extra: Record<string, unknown> = {}) => ({ variants: { "": { model, ...extra } } });

async function fixture() {
  const files: Record<string, unknown> = {
    ...VANILLA_PARENTS,
    "assets/test/textures/block/grey.png": solidPng(GREY),
    "assets/test/textures/block/red.png": solidPng(RED),
    // Element rotation, one axis: old form, new per-axis form, and an angle off the 22.5° grid.
    "assets/test/models/block/turn_old.json": plate({ origin: [8, 8, 8], axis: "y", angle: 30, rescale: true }),
    "assets/test/models/block/turn_new.json": plate({ origin: [8, 8, 8], y: 30, rescale: true }),
    // Both notations present: axis + angle wins (25w46a).
    "assets/test/models/block/turn_both.json": plate({ origin: [8, 8, 8], axis: "y", angle: 30, x: 45, z: 10, rescale: true }),
    // Two axes, applied x then y.
    "assets/test/models/block/turn_xy.json": {
      textures: { t: "test:block/grey", r: "test:block/red" },
      elements: [{ from: [0, 0, 0], to: [16, 16, 16], rotation: { origin: [8, 8, 8], x: 90, y: 90 }, faces: { north: { texture: "#r" }, up: { texture: "#t" } } }],
    },
    // Texture map entries: string against object.
    "assets/test/models/block/tex_old.json": { parent: "block/cube_all", textures: { all: "test:block/grey" } },
    "assets/test/models/block/tex_new.json": { parent: "block/cube_all", textures: { all: { sprite: "test:block/grey" } } },
    "assets/test/models/block/tex_glassy.json": { parent: "block/cube_all", textures: { all: { sprite: "test:block/grey", force_translucent: true } } },
    // Shading: shade false against shade_direction_override "up" (26.3's stated equivalent), and another direction.
    "assets/test/models/block/flat_old.json": { parent: "block/slab", textures: { top: "test:block/grey", bottom: "test:block/grey", side: "test:block/grey" }, elements: [slabElement({ shade: false })] },
    "assets/test/models/block/flat_new.json": { parent: "block/slab", textures: { top: "test:block/grey", bottom: "test:block/grey", side: "test:block/grey" }, elements: [slabElement({ shade_direction_override: "up" })] },
    "assets/test/models/block/flat_east.json": { parent: "block/slab", textures: { top: "test:block/grey", bottom: "test:block/grey", side: "test:block/grey" }, elements: [slabElement({ shade_direction_override: "east" })] },
    // A cube with a red top, for blockstate rotation.
    "assets/test/models/block/red_top.json": { parent: "block/cube", textures: { up: "test:block/red", down: "test:block/grey", north: "test:block/grey", south: "test:block/grey", west: "test:block/grey", east: "test:block/grey", particle: "test:block/grey" } },
    "assets/test/models/block/half.json": { parent: "block/slab", textures: { top: "test:block/red", bottom: "test:block/grey", side: "test:block/grey" } },
  };
  for (const m of ["turn_old", "turn_new", "turn_both", "turn_xy", "tex_old", "tex_new", "tex_glassy", "flat_old", "flat_new", "flat_east", "red_top"])
    files[`assets/test/blockstates/${m}.json`] = one(`test:block/${m}`);
  files["assets/test/blockstates/red_top_z0.json"] = one("test:block/red_top", { z: 0 });
  files["assets/test/blockstates/red_top_z90.json"] = one("test:block/red_top", { z: 90 });
  files["assets/test/blockstates/half_z90.json"] = one("test:block/half", { z: 90 });
  files["assets/test/blockstates/red_top_x90_y90_z90.json"] = one("test:block/red_top", { x: 90, y: 90, z: 90 });
  const stack = await memStack([["base", "base", files as never]]);
  return { stack, baker: new BlockBaker(stack, new TextureLoader(stack), undefined) };
}

function slabElement(extra: Record<string, unknown>) {
  return { from: [0, 0, 0], to: [16, 8, 16], ...extra, faces: { up: { texture: "#top" }, down: { texture: "#bottom" }, north: { texture: "#side" }, east: { texture: "#side" } } };
}

/** Quads as plain data, comparable with toEqual (texture by its mean colour). */
const flat = (b: BakedBlock) =>
  b.quads.map((q) => ({ pos: [...q.pos].map((v) => +v.toFixed(5)), uv: [...q.uv], shade: +q.shade.toFixed(5), cull: q.cull, mean: q.tex.mean, translucent: q.tex.translucent }));

const centre = (q: BakedQuad) => [0, 1, 2].map((a) => +((q.pos[a]! + q.pos[a + 3]! + q.pos[a + 6]! + q.pos[a + 9]!) / 4).toFixed(5));
const span = (b: BakedBlock, axis: number) => {
  const v = b.quads.flatMap((q) => [0, 1, 2, 3].map((i) => q.pos[i * 3 + axis]!));
  return [+Math.min(...v).toFixed(5), +Math.max(...v).toFixed(5)];
};

describe("reading the new forms", () => {
  it("normalises element rotation: old form, per-axis form, precedence, several axes", () => {
    expect(parseElementRotation({ origin: [8, 8, 8], axis: "x", angle: 22.5 })).toEqual({ origin: [8, 8, 8], axis: "x", angle: 22.5 });
    expect(parseElementRotation({ origin: [8, 8, 8], z: -60, rescale: true })).toEqual({ origin: [8, 8, 8], axis: "z", angle: -60, rescale: true });
    expect(parseElementRotation({ origin: [8, 8, 8], axis: "y", angle: 30, x: 45 })).toEqual({ origin: [8, 8, 8], axis: "y", angle: 30 });
    expect(parseElementRotation({ origin: [4, 0, 4], x: 10, y: 0, z: 100 })).toEqual({ origin: [4, 0, 4], angles: [10, 0, 100] });
    expect(parseElementRotation({ origin: [8, 8, 8], x: 0, y: 0, z: 0 })).toBeUndefined();
  });

  it("reads variant z, keeping old variants unchanged", () => {
    const def = parseBlockstate({ variants: { "a=1": { model: "block/m", x: 90, z: 270 }, "a=2": { model: "block/m", z: 0 } } });
    expect(selectModels(def, { a: "1" })).toEqual([{ model: "minecraft:block/m", x: 90, y: 0, z: 270, uvlock: false, weight: 1 }]);
    expect(selectModels(def, { a: "2" })).toEqual([{ model: "minecraft:block/m", x: 0, y: 0, uvlock: false, weight: 1 }]);
  });

  it("rotates faces about z after x and y", () => {
    expect(rotateFace("up", 0, 0, 90)).toBe("east");
    expect(rotateFace("east", 0, 0, 90)).toBe("down");
    expect(rotateFace("north", 0, 0, 90)).toBe("north");
    expect(rotateFace("up", 0, 0, 270)).toBe("west");
    // x 90 (up → north), y 90 (north → east), z 90 (east → down).
    expect(rotateFace("up", 90, 90, 90)).toBe("down");
  });

  it("resolves object texture entries and keeps force_translucent on the face", async () => {
    const { stack } = await fixture();
    const r = new ModelResolver(stack);
    const [oldM, newM, glassy] = await Promise.all(["test:block/tex_old", "test:block/tex_new", "test:block/tex_glassy"].map((m) => r.resolve(m)));
    expect(newM!.textures).toEqual(oldM!.textures);
    expect(newM!.elements).toEqual(oldM!.elements);
    expect(newM!.issues).toEqual([]);
    expect(glassy!.elements[0]!.faces.up).toEqual({ texture: "test:block/grey", cullface: "up", forceTranslucent: true });
  });

  it("reads shade_direction_override", async () => {
    const { stack } = await fixture();
    const r = new ModelResolver(stack);
    expect((await r.resolve("test:block/flat_east")).elements[0]!.shadeDirection).toBe("east");
    expect((await r.resolve("test:block/flat_old")).elements[0]!.shade).toBe(false);
  });

  it("counts an element with all-zero per-axis angles as unrotated", () => {
    const faces = Object.fromEntries((["down", "up", "north", "south", "west", "east"] as const).map((f) => [f, { texture: "x:y" }]));
    const model = { id: "m", textures: {}, ambientOcclusion: true, issues: [], elements: [{ from: [0, 0, 0] as [number, number, number], to: [16, 16, 16] as [number, number, number], faces }] };
    expect(isFullCube([{ model }])).toBe(true);
    expect(isFullCube([{ model: { ...model, elements: [{ ...model.elements[0]!, rotation: { origin: [8, 8, 8] as [number, number, number], angles: [0, 15, 15] as [number, number, number] } }] } }])).toBe(false);
  });
});

describe("new forms render like their old equivalents", () => {
  it("per-axis element rotation = axis + angle", async () => {
    const { baker } = await fixture();
    expect(flat(await baker.bake("test:turn_new"))).toEqual(flat(await baker.bake("test:turn_old")));
    expect(flat(await baker.bake("test:turn_both"))).toEqual(flat(await baker.bake("test:turn_old")));
  });

  it("object texture entries = string entries", async () => {
    const { baker } = await fixture();
    expect(flat(await baker.bake("test:tex_new"))).toEqual(flat(await baker.bake("test:tex_old")));
  });

  it("shade_direction_override up = shade false", async () => {
    const { baker } = await fixture();
    expect(flat(await baker.bake("test:flat_new"))).toEqual(flat(await baker.bake("test:flat_old")));
  });

  it("variant z 0 = no z", async () => {
    const { baker } = await fixture();
    expect(flat(await baker.bake("test:red_top_z0"))).toEqual(flat(await baker.bake("test:red_top")));
  });
});

describe("new behaviour", () => {
  it("does not snap a 30° element rotation to the 22.5° grid (1.21.6)", async () => {
    const { baker } = await fixture();
    const up = (await baker.bake("test:turn_old")).quads[0]!;
    // Plate corner (0, 9, 0) about (8, 8, 8): rotated 30° about y, then rescaled by 1/cos 30° on x and z.
    const a = (30 * Math.PI) / 180, k = 1 / Math.cos(a);
    const [dx, dz] = [-0.5, -0.5];
    const x = (dx * Math.cos(a) + dz * Math.sin(a)) * k + 0.5;
    const z = (-dx * Math.sin(a) + dz * Math.cos(a)) * k + 0.5;
    expect([...up.pos.slice(0, 3)].map((v) => +v.toFixed(4))).toEqual([+x.toFixed(4), 9 / 16, +z.toFixed(4)]);
  });

  it("applies two element axes in order x then y", async () => {
    const { baker } = await fixture();
    const b = await baker.bake("test:turn_xy");
    const north = b.quads.find((q) => q.tex.mean[0] === RED[0])!;
    // x 90 turns the north face up; y 90 then leaves it up. (y first would have turned it west.)
    expect(centre(north)).toEqual([0.5, 1, 0.5]);
    // Face names ignore element rotation: no cullface was given, so nothing culls it.
    expect(north.cull).toBeUndefined();
  });

  it("turns a variant about z: the red top faces east and culls against east", async () => {
    const { baker } = await fixture();
    const b = await baker.bake("test:red_top_z90");
    const red = b.quads.find((q) => q.tex.mean[0] === RED[0])!;
    expect(centre(red)).toEqual([1, 0.5, 0.5]);
    expect(red.cull).toBe("east");
    expect(red.shade).toBe(0.6);
    expect([...b.occludes].sort()).toEqual(["down", "east", "north", "south", "up", "west"]);
  });

  it("turns a bottom slab about z into a west half", async () => {
    const { baker } = await fixture();
    const b = await baker.bake("test:half_z90");
    expect(span(b, 0)).toEqual([0, 0.5]);
    expect(span(b, 1)).toEqual([0, 1]);
    expect(span(b, 2)).toEqual([0, 1]);
  });

  it("applies variant x, y, then z", async () => {
    const { baker } = await fixture();
    const red = (await baker.bake("test:red_top_x90_y90_z90")).quads.find((q) => q.tex.mean[0] === RED[0])!;
    expect(centre(red)).toEqual([0.5, 0, 0.5]);
    expect(red.cull).toBe("down");
  });

  it("shades every face of an element as the overridden direction", async () => {
    const { baker } = await fixture();
    expect(new Set((await baker.bake("test:flat_east")).quads.map((q) => q.shade))).toEqual(new Set([0.6]));
  });

  it("draws force_translucent textures in the blended pass", async () => {
    const { baker } = await fixture();
    const opaque = await baker.bake("test:tex_old");
    const glassy = await baker.bake("test:tex_glassy");
    expect(opaque.translucent).toBe(false);
    expect(glassy.translucent).toBe(true);
    expect(glassy.quads.every((q) => q.tex.translucent && q.tex.opaque)).toBe(true);
  });
});
