import type { PublicBox, Vec3 } from "../core/region.js";
import type { BridgeConnection } from "./bridge.js";
import type { WireBox } from "./protocol/messages.js";

/**
 * Setting the player's volumes from the agent (docs/design/13-live-world.md, *Backlog* B4,
 * `world_volumes`; *Wire format*, `volumes.set`). The agent gives boxes in the coordinates of the
 * linked document; they become world boxes with its origin, and the mod sets them as if the player had marked them. Linking
 * follows as for any new work volume. No accept step: the player refines or moves on.
 */

/** The document whose coordinates the boxes are in. */
export interface VolumesFrame {
  /** World position of local (0, 0, 0). */
  origin: Vec3;
  dimension: string;
  /** Names the coordinates in the result ("local"). */
  label: string;
}

/** The context as the tool takes it: boxes, a padding around the work volume, or the mod's default. */
export type ContextArg = PublicBox[] | { padding: number } | undefined;

const toWorld = (b: PublicBox, o: Vec3): WireBox => {
  const lo = [0, 1, 2].map((i) => Math.min(b.min[i]!, b.max[i]!) + o[i]!) as Vec3;
  const hi = [0, 1, 2].map((i) => Math.max(b.min[i]!, b.max[i]!) + o[i]!) as Vec3;
  return { min: lo, max: hi };
};
const size = (b: WireBox) => [0, 1, 2].map((i) => b.max[i]! - b.min[i]! + 1).join("×");
const pt = (v: readonly number[]) => `(${v.join(",")})`;

/** Sends `volumes.set` and describes the volumes the mod confirmed. Rejects with the bridge's refusals (`world_mod_outdated`, `bad_volumes`, …). */
export async function setVolumes(bridge: Pick<BridgeConnection, "request">, frame: VolumesFrame, work: PublicBox, context: ContextArg, autoLink: boolean): Promise<string> {
  const w = toWorld(work, frame.origin);
  let ctx: WireBox[] | undefined;
  if (Array.isArray(context)) ctx = context.map((b) => toWorld(b, frame.origin));
  else if (context) {
    const p = context.padding;
    ctx = [{ min: [w.min[0] - p, w.min[1] - p, w.min[2] - p], max: [w.max[0] + p, w.max[1] + p, w.max[2] + p] }];
  }
  const v = await bridge.request({ type: "volumes.set", dimension: frame.dimension, work: w, ...(ctx ? { context: ctx } : {}) });
  if (v.work === null) throw new Error("The mod confirmed no work volume.");
  const local = (b: WireBox) => `${pt(b.min.map((c, i) => c - frame.origin[i]!))}–${pt(b.max.map((c, i) => c - frame.origin[i]!))}`;
  const n = v.context.length;
  const how = Array.isArray(context) ? `${n} context box${n === 1 ? "" : "es"} (seam and build-height clipping by the game)` : context ? `context +${context.padding}` : "the default context (+3)";
  return (
    `ok · world_volumes · work ${size(v.work)} at ${frame.label} ${local(v.work)} (world ${pt(v.work.min)}–${pt(v.work.max)}), ${how} · link ${v.link}. ` +
    (autoLink ? "The game shows the outlines; linking follows on its own, replacing the open document, and the work volume's minimum corner becomes local (0,0,0)." : "The game shows the outlines; call doc_open({world: true}) to link (world.autoLink is off).")
  );
}
