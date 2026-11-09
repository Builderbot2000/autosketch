import type { Compound } from "prismarine-nbt";
import type { Mask } from "../core/mask.js";
import type { Vec3 } from "../core/region.js";
import type { Document } from "../document/document.js";
import type { JournalStep } from "./journal-tap.js";
import { nbtHash } from "./protocol/hash.js";
import type { PatchBlock, VolatileList } from "./protocol/messages.js";

/**
 * Patch contents (docs/design/13-live-world.md, *Agent → world: patches*, W3): the positions a
 * batch of journal steps changed, in world coordinates, each with the state it expects to replace
 * (the first step's from-side), the hash of the block entity it expects when the before-block has
 * one, the new state (the last step's to-side) and the new block entity's NBT.
 *
 * Positions outside the work volume (`work`, local) are left out: the agent can't write the
 * context, and the only changes a guard lets through there are connection properties recomputed
 * on context blocks (11, *Connection seams*), which stay in the cache until the world disagrees.
 */

interface Cell {
  pos: Vec3;
  expected: number;
  expectedNbt: Compound | undefined;
  state: number;
  nbt: Compound | undefined;
}

/**
 * Builds a patch's blocks from a batch (one entry, or a restore's steps). `origin` is the world
 * position of local (0,0,0). Positions a batch leaves as they were are dropped.
 */
export function patchBlocks(doc: Document, steps: readonly JournalStep[], work: Mask, origin: Vec3, volatile: VolatileList): PatchBlock[] {
  const cells = new Map<string, Cell>();
  const [dx, dy, dz] = doc.origin;
  for (const s of steps) {
    const e = s.entry;
    const [from, into] = s.to === "after" ? [e.before, e.after] : [e.after, e.before];
    const nbtAt = new Map((e.nbt ?? []).map((c) => [c.index, c]));
    for (let i = 0; i < from.length; i++) {
      const sx = e.positions[i * 3]!, sy = e.positions[i * 3 + 1]!, sz = e.positions[i * 3 + 2]!;
      const lx = sx - dx, ly = sy - dy, lz = sz - dz;
      if (!work.has(lx, ly, lz)) continue;
      const k = `${sx},${sy},${sz}`;
      const c = nbtAt.get(i);
      // A position whose block entity this step didn't change keeps the one the document holds.
      const kept = c ? undefined : doc.blockEntities.get(k);
      const nbtFrom = c ? (s.to === "after" ? c.before : c.after) : kept;
      const nbtInto = c ? (s.to === "after" ? c.after : c.before) : kept;
      const cell = cells.get(k);
      if (cell) {
        cell.state = into[i]!;
        cell.nbt = nbtInto;
      } else cells.set(k, { pos: [lx + origin[0], ly + origin[1], lz + origin[2]], expected: from[i]!, expectedNbt: nbtFrom, state: into[i]!, nbt: nbtInto });
    }
  }
  const out: PatchBlock[] = [];
  for (const c of cells.values()) {
    if (c.expected === c.state && c.expectedNbt === c.nbt) continue;
    const hash = c.expectedNbt && nbtHash(c.expectedNbt, volatile);
    const nbt = c.state !== 0 && c.nbt ? withoutPosition(c.nbt) : undefined;
    out.push({
      pos: c.pos,
      expected: doc.states.get(c.expected),
      ...(hash ? { expectedNbtHash: hash } : {}),
      state: doc.states.get(c.state),
      ...(nbt ? { nbt } : {}),
    });
  }
  return out;
}

/** The compound without top-level `x`, `y`, `z` (the message gives the position; *Wire format*, *NBT*). */
function withoutPosition(c: Compound): Compound {
  if (!("x" in c.value) && !("y" in c.value) && !("z" in c.value)) return c;
  const { x: _x, y: _y, z: _z, ...rest } = c.value;
  return { type: "compound", value: rest } as Compound;
}
