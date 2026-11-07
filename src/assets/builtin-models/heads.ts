import type { Props } from "../models.js";
import { boxFaces, boxUnwrap, cuboid, facingDegrees, rotationDegrees, splitAngle, type Sheet } from "./geometry.js";
import type { CodeModel } from "./index.js";

/** Mob heads and skulls (02, "Code-drawn blocks"): an 8×8×8 head box from the mob's texture. */

const SHEETS: Record<string, Sheet & { u?: number; v?: number; size?: [number, number, number] }> = {
  skeleton: { id: "entity/skeleton/skeleton", w: 64, h: 32 },
  wither_skeleton: { id: "entity/skeleton/wither_skeleton", w: 64, h: 32 },
  zombie: { id: "entity/zombie/zombie", w: 64, h: 64 },
  creeper: { id: "entity/creeper/creeper", w: 64, h: 32 },
  player: { id: "entity/player/wide/steve", w: 64, h: 64 },
  piglin: { id: "entity/piglin/piglin", w: 64, h: 64, size: [10, 8, 8] },
  dragon: { id: "entity/enderdragon/dragon", w: 256, h: 256, u: 112, v: 30, size: [16, 16, 16] },
};

export function headModel(ns: string, path: string, props: Props): CodeModel {
  const wall = path.includes("_wall_");
  const mob = path.replace(/_wall/, "").replace(/_(skull|head)$/, "");
  const known = ns === "minecraft" ? SHEETS[mob] : undefined;
  const sheet: Sheet = known ? { id: `minecraft:${known.id}`, w: known.w, h: known.h } : { id: `${ns}:entity/${mob}/${mob}`, w: 64, h: 32 };
  const [w, h, d] = known?.size ?? [8, 8, 8];
  const faces = boxFaces(sheet, boxUnwrap(known?.u ?? 0, known?.v ?? 0, w, h, d));
  // Drawn 8 units across whatever the texture box size (the dragon head is scaled down to fit).
  const sx = 8 * (w / Math.max(w, h, d) || 1), sy = 8 * (h / Math.max(w, h, d) || 1);
  const x0 = 8 - sx / 2;
  if (wall) return { parts: [{ elements: [cuboid([x0, 4, 8], [x0 + sx, 4 + sy, 16], faces)], y: facingDegrees(props.facing) }] };
  const { step, rest } = splitAngle(rotationDegrees(props.rotation));
  return { parts: [{ elements: [cuboid([x0, 0, 4], [x0 + sx, sy, 12], faces, rest)], y: step }] };
}
