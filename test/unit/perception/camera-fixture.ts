import { PNG } from "pngjs";
import { fromPublic, type Vec3 } from "../../../src/core/region.js";
import { Document } from "../../../src/document/document.js";
import { fill } from "../../../src/ops/edit.js";
import { TextureLoader } from "../../../src/palette/textures.js";
import { BlockBaker } from "../../../src/perception/render/bake.js";
import { solidPng } from "../../helpers/fixtures.js";
import { memStack, VANILLA_PARENTS } from "../../helpers/stack.js";

/** Shared fixture for the camera tests: solid-colour cubes and a closed room with one colour per side. */

export type RGB = [number, number, number];
export const COLOURS: Record<string, RGB> = { red: [200, 30, 30], green: [30, 200, 30], blue: [30, 30, 200], grey: [120, 120, 120], white: [240, 240, 240], yellow: [220, 200, 20] };

/** A baker with one cube_all block per colour: test:red, test:green, … */
export async function fixture(): Promise<BlockBaker> {
  const files: Record<string, unknown> = { ...VANILLA_PARENTS };
  for (const [name, rgb] of Object.entries(COLOURS)) {
    files[`assets/test/blockstates/${name}.json`] = { variants: { "": { model: `test:block/${name}` } } };
    files[`assets/test/models/block/${name}.json`] = { parent: "block/cube_all", textures: { all: `test:block/${name}` } };
    files[`assets/test/textures/block/${name}.png`] = solidPng(rgb);
  }
  const stack = await memStack([["base", "base", files]]);
  return new BlockBaker(stack, new TextureLoader(stack), undefined);
}

export const B = (min: Vec3, max: Vec3) => fromPublic({ min, max });

/**
 * A closed 9×9×9 room, walls one block thick, each side its own colour: west red, east green,
 * north blue, south yellow, floor grey, ceiling white. Inside: (1..7)³.
 */
export function room(): Document {
  const doc = Document.create({ name: "room", dataVersion: 3955, seed: 1 });
  fill(doc, {}, B([0, 0, 0], [8, 0, 8]), "test:grey");
  fill(doc, {}, B([0, 8, 0], [8, 8, 8]), "test:white");
  fill(doc, {}, B([0, 1, 0], [0, 7, 8]), "test:red");
  fill(doc, {}, B([8, 1, 0], [8, 7, 8]), "test:green");
  fill(doc, {}, B([1, 1, 0], [7, 7, 0]), "test:blue");
  fill(doc, {}, B([1, 1, 8], [7, 7, 8]), "test:yellow");
  return doc;
}

export const decode = (png: Buffer) => PNG.sync.read(png);
export const at = (p: PNG, x: number, y: number): RGB => {
  const i = (y * p.width + x) * 4;
  return [p.data[i]!, p.data[i + 1]!, p.data[i + 2]!];
};
export const shaded = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
export const near = (a: RGB, b: RGB, tol = 6) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);
/** Inside faces seen in flat style: the colour times the face's shade (east/west 0.6, north/south 0.8, up 1, down 0.5). */
export const INSIDE = {
  west: shaded(COLOURS.red!, 0.6), // the red wall's east face
  east: shaded(COLOURS.green!, 0.6),
  north: shaded(COLOURS.blue!, 0.8),
  south: shaded(COLOURS.yellow!, 0.8),
  floor: shaded(COLOURS.grey!, 1),
  ceiling: shaded(COLOURS.white!, 0.5),
};
