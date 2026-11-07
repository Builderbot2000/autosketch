import type { Props } from "../models.js";
import { boxFaces, boxUnwrap, cuboid, facingDegrees, type Sheet, type V3 } from "./geometry.js";
import type { CodeModel } from "./index.js";

/**
 * Chests and shulker boxes (02, "Code-drawn blocks"). Chests use the instance's entity chest
 * texture laid out as a box unwrap; a missing texture falls back to the model's particle texture.
 */

/** "minecraft:chest" → "minecraft:entity/chest/normal"; modded chests guess "<ns>:entity/chest/<name>". */
function chestSheet(ns: string, path: string): Sheet {
  const name = path === "chest" ? "normal" : path === "trapped_chest" ? "trapped" : path === "ender_chest" ? "ender" : path.replace(/_chest$/, "");
  return { id: `${ns}:entity/chest/${name}`, w: 64, h: 64 };
}

export function chestModel(ns: string, path: string, props: Props): CodeModel {
  const sheet = chestSheet(ns, path);
  // A double chest's halves reach the shared side: "left" joins clockwise of its facing (east when facing north).
  const x0 = props.type === "right" ? 0 : 1;
  const x1 = props.type === "left" ? 16 : 15;
  // The chest texture is laid out upside down: the unwrap's "top" is the underside.
  const flip = (uw: ReturnType<typeof boxUnwrap>) => ({ ...uw, top: uw.bottom, bottom: uw.top });
  const base = cuboid([x0, 0, 1], [x1, 10, 15], boxFaces(sheet, flip(boxUnwrap(0, 19, 14, 10, 14))));
  const lid = cuboid([x0, 10, 1], [x1, 14, 15], boxFaces(sheet, flip(boxUnwrap(0, 0, 14, 5, 14))));
  // The latch is centred; on a double chest it sits on the seam, each half drawing its side of it.
  const [l0, l1] = props.type === "left" ? [15, 16] : props.type === "right" ? [0, 1] : [7, 9];
  const latch = cuboid([l0, 7, 0], [l1, 11, 1], boxFaces(sheet, boxUnwrap(0, 0, 2, 4, 1)));
  const elements = [base, lid, latch];
  return { parts: [{ elements, y: facingDegrees(props.facing) }] };
}

/** Shulker boxes look like a full cube of their block texture (the lid line is ignored). */
export function shulkerModel(ns: string, path: string): CodeModel {
  const sheet: Sheet = { id: `${ns}:block/${path}`, w: 16, h: 16 };
  const all = (cull: "up" | "down" | "north" | "south" | "west" | "east") => ({ sheet, rect: [0, 0, 16, 16] as [number, number, number, number], cull });
  const from: V3 = [0, 0, 0], to: V3 = [16, 16, 16];
  return {
    parts: [{ elements: [cuboid(from, to, { up: all("up"), down: all("down"), north: all("north"), south: all("south"), west: all("west"), east: all("east") })] }],
  };
}
