import { parseState, stateId } from "../core/blockstate.js";
import { Mask } from "../core/mask.js";
import type { Vec3 } from "../core/region.js";
import type { Document } from "../document/document.js";
import type { AutosketchPlugin } from "../plugins/types.js";

/**
 * Whole blocks only (docs/design/11-scoped-sessions.md, *Model*): a sandbox volume never holds
 * half of a door, bed, tall plant, double chest or plugin-declared multi-block. A selection that
 * cuts one is extended over the rest of it.
 */

const H: Record<string, Vec3> = { north: [0, 0, -1], east: [1, 0, 0], south: [0, 0, 1], west: [-1, 0, 0] };
const CW: Record<string, string> = { north: "east", east: "south", south: "west", west: "north" };
const CCW: Record<string, string> = { north: "west", west: "south", south: "east", east: "north" };

/**
 * Offsets of the other positions `state` belongs with, or undefined for a single block. Two-high
 * blocks (doors, tall plants, tall seagrass) carry half=upper|lower; beds part=head|foot along
 * facing; double chests type=left|right (left: the partner is clockwise of facing, as in
 * ChestBlock). Plugins declare their own (`multiBlock`). `sameId`: the partner must be the same
 * block to count.
 */
export function multiBlockPartners(state: string, plugins: readonly AutosketchPlugin[] = []): { offsets: Vec3[]; sameId: boolean } | undefined {
  for (const p of plugins) {
    const o = p.multiBlock?.partners(state);
    if (o?.length) return { offsets: o, sameId: false };
  }
  if (!state.includes("[")) return undefined;
  const { id, props } = parseState(state);
  if (props.half === "upper") return { offsets: [[0, -1, 0]], sameId: true };
  if (props.half === "lower") return { offsets: [[0, 1, 0]], sameId: true };
  const f = props.facing;
  const d = f ? H[f] : undefined;
  if (!f || !d) return undefined;
  if (/_bed$/.test(id) && (props.part === "head" || props.part === "foot")) return { offsets: [props.part === "foot" ? d : [-d[0], 0, -d[2]]], sameId: true };
  if (/chest$/.test(id) && (props.type === "left" || props.type === "right")) return { offsets: [H[props.type === "left" ? CW[f]! : CCW[f]!]!], sameId: true };
  return undefined;
}

/**
 * Extends `mask` (local positions of `doc`) over every multi-block it cuts. Returns the extended
 * mask and the positions added. Partners of built-in kinds count only when they hold the same
 * block (a lone lower door half next to grass stays alone).
 */
export function extendWholeBlocks(doc: Document, mask: Mask, plugins: readonly AutosketchPlugin[] = []): { mask: Mask; added: Mask } {
  const out = mask.clone();
  const added = new Mask();
  const cache = new Map<number, ReturnType<typeof multiBlockPartners> | null>();
  const idAt = (x: number, y: number, z: number) => doc.voxels.get(...doc.toStore(x, y, z));
  const queue = mask.positions();
  while (queue.length) {
    const [x, y, z] = queue.pop()!;
    const id = idAt(x, y, z);
    if (id === 0) continue;
    let m = cache.get(id);
    if (m === undefined) cache.set(id, (m = multiBlockPartners(doc.states.get(id), plugins) ?? null));
    if (!m) continue;
    for (const o of m.offsets) {
      const q: Vec3 = [x + o[0], y + o[1], z + o[2]];
      if (out.has(...q)) continue;
      if (m.sameId) {
        const qid = idAt(...q);
        if (qid === 0 || stateId(doc.states.get(qid)) !== stateId(doc.states.get(id))) continue;
      }
      out.add(...q);
      added.add(...q);
      queue.push(q);
    }
  }
  return { mask: out, added };
}
