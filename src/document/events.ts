import type { BlockCounts, ObserveEvent } from "../core/events.js";
import { toPublic, type Box } from "../core/region.js";
import type { Document } from "./document.js";
import type { JournalEntry } from "./journal.js";

/**
 * Builds the document's observability events (docs/design/12-observability.md, *Kinds*). Kept out
 * of document.ts so the hooks there stay one line each. Only called when the sink is enabled.
 */

export function opEvent(doc: Document, e: JournalEntry): ObserveEvent {
  const counts: BlockCounts = { placed: {}, removed: 0 };
  const byId = new Map<number, number>();
  for (const id of e.after) byId.set(id, (byId.get(id) ?? 0) + 1);
  for (const [id, n] of byId) {
    if (id === 0) counts.removed += n;
    else {
      const block = doc.states.get(id).split("[")[0]!;
      counts.placed[block] = (counts.placed[block] ?? 0) + n;
    }
  }
  const box = localBox(doc, e.positions);
  const shift = diff(e.originAfter, e.originBefore);
  return { kind: "doc.op", jseq: e.seq, op: e.op, summary: e.summary, changed: e.after.length, ...(box ? { box } : {}), counts, ...(shift ? { shift } : {}) };
}

export function stepEvent(doc: Document, kind: "doc.undo" | "doc.redo", e: JournalEntry): ObserveEvent {
  const box = localBox(doc, e.positions);
  return { kind, jseq: e.seq, op: e.op, changed: e.after.length, ...(box ? { box } : {}) };
}

/** Inclusive local box of store positions, in the document's current frame. */
function localBox(doc: Document, p: Int32Array): ReturnType<typeof toPublic> | undefined {
  if (p.length === 0) return undefined;
  const b: Box = { min: [p[0]!, p[1]!, p[2]!], max: [p[0]! + 1, p[1]! + 1, p[2]! + 1] };
  for (let i = 3; i < p.length; i += 3)
    for (let a = 0; a < 3; a++) {
      const v = p[i + a]!;
      if (v < b.min[a]!) b.min[a] = v;
      if (v + 1 > b.max[a]!) b.max[a] = v + 1;
    }
  return toPublic(doc.boxToLocal(b));
}

function diff(a: readonly number[], b: readonly number[]): [number, number, number] | undefined {
  const d: [number, number, number] = [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
  return d.some((v) => v !== 0) ? d : undefined;
}
