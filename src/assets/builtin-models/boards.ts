import type { ModelElement, Props } from "../models.js";
import { boxFaces, boxUnwrap, cuboid, DYE_COLORS, dyeOf, facingDegrees, rotationDegrees, splitAngle, type Sheet } from "./geometry.js";
import type { CodeModel, CodeModelPart } from "./index.js";

/**
 * Signs and banners (02, "Code-drawn blocks"). Floor-standing ones turn in 22.5° steps
 * (`rotation=0..15`); wall ones follow `facing` and sit against the wall behind them.
 */

/** Turns a north-facing set of elements to `deg` clockwise: whole 90° steps on the part, the rest per element. */
function turned(build: (rest: number) => ModelElement[], deg: number): CodeModelPart {
  const { step, rest } = splitAngle(deg);
  return { elements: build(rest), y: step };
}

export function signModel(ns: string, path: string, props: Props): CodeModel {
  const wall = path.includes("_wall_");
  const hanging = path.includes("hanging_sign");
  const wood = path.replace(/_wall/, "").replace(/_(hanging_)?sign$/, "");
  if (hanging) {
    const sheet: Sheet = { id: `${ns}:entity/signs/hanging/${wood}`, w: 64, h: 32 };
    const board = boxUnwrap(0, 12, 14, 10, 2);
    const chain = boxUnwrap(0, 6, 1, 6, 1);
    const deg = props.rotation !== undefined && !wall ? rotationDegrees(props.rotation) : facingDegrees(props.facing);
    return {
      parts: [
        turned(
          (rest) => [
            cuboid([1, 0, 7], [15, 10, 9], boxFaces(sheet, board), rest),
            cuboid([2.5, 10, 7.5], [3.5, 16, 8.5], boxFaces(sheet, chain), rest),
            cuboid([12.5, 10, 7.5], [13.5, 16, 8.5], boxFaces(sheet, chain), rest),
            ...(wall ? [cuboid([0, 14, 6], [16, 16, 10], boxFaces(sheet, boxUnwrap(0, 0, 16, 2, 4)), rest)] : []),
          ],
          deg,
        ),
      ],
    };
  }
  const sheet: Sheet = { id: `${ns}:entity/signs/${wood}`, w: 64, h: 32 };
  const board = boxFaces(sheet, boxUnwrap(0, 0, 24, 12, 2));
  if (wall) {
    // Facing is the side the text faces; the board hangs on the wall behind it.
    return { parts: [{ elements: [cuboid([0, 4.5, 14.67], [16, 12.5, 16], board)], y: facingDegrees(props.facing) }] };
  }
  const post = boxFaces(sheet, boxUnwrap(0, 14, 2, 14, 2));
  return {
    parts: [turned((rest) => [cuboid([0, 8, 7.33], [16, 16, 8.67], board, rest), cuboid([7.33, 0, 7.33], [8.67, 8, 8.67], post, rest)], rotationDegrees(props.rotation))],
  };
}

export function bannerModel(ns: string, path: string, props: Props): CodeModel {
  const sheet: Sheet = { id: `${ns}:entity/banner_base`, w: 64, h: 64 };
  const dye = dyeOf(path);
  const color = dye ? `ff${DYE_COLORS[dye]}` : undefined;
  const flag = boxFaces(sheet, boxUnwrap(0, 0, 20, 40, 1), color ? { color } : {});
  const bar = boxFaces(sheet, boxUnwrap(0, 42, 20, 2, 2));
  if (path.includes("_wall_")) {
    // Hangs from a bar against the wall behind it, reaching down into the block below (as in game).
    return {
      parts: [{ elements: [cuboid([1.33, 14.67, 14], [14.67, 16, 15.33], bar), cuboid([1.33, -10.67, 13.33], [14.67, 16, 14], flag)], y: facingDegrees(props.facing) }],
    };
  }
  const pole = boxFaces(sheet, boxUnwrap(44, 0, 2, 42, 2));
  return {
    parts: [
      turned(
        (rest) => [
          cuboid([7.33, 0, 7.33], [8.67, 28, 8.67], pole, rest),
          cuboid([1.33, 28, 7.33], [14.67, 29.33, 8.67], bar, rest),
          cuboid([1.33, 2, 6.67], [14.67, 28.67, 7.33], flag, rest),
        ],
        rotationDegrees(props.rotation),
      ),
    ],
  };
}
