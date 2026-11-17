import type { PublicBox, Vec3 } from "../core/region.js";
import type { WireBox } from "../world/protocol/messages.js";

/**
 * Where the base document sits in the world, for everything `src/ui/` sends (docs/design/16-in-game-ui.md,
 * *MCP side*; `13`, *In-game UI*: every message is in world coordinates with the dimension). A linked
 * document's frame is the link's (`origin` = the work volume's minimum corner); an unlinked document's
 * is the anchor the player chose with `ghost.anchor`. Document-local coordinates become world
 * coordinates here and nowhere else (`docs/briefs/ui/M-mcp-ui-core.md`, *Notes*).
 */
export interface WorldFrame {
  dimension: string;
  /** World position of base-document-local (0,0,0). */
  origin: Vec3;
}

/** A base-document-local position in the world. */
export function toWorld(frame: WorldFrame, p: Vec3): Vec3 {
  return [p[0] + frame.origin[0], p[1] + frame.origin[1], p[2] + frame.origin[2]];
}

/** A base-document-local inclusive box in the world. */
export function toWorldBox(frame: WorldFrame, b: PublicBox): WireBox {
  return { min: toWorld(frame, b.min), max: toWorld(frame, b.max) };
}

export const sameFrame = (a: WorldFrame | undefined, b: WorldFrame | undefined): boolean =>
  a === b || (!!a && !!b && a.dimension === b.dimension && a.origin.every((v, i) => v === b.origin[i]));
