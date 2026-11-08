import type { EventListener } from "../core/fanout.js";
import type { Document } from "../document/document.js";
import type { Journal, JournalEntry } from "../document/journal.js";
import { pushes } from "./no-push.js";

/**
 * The patch sender's view of the journal (docs/design/13-live-world.md, *Agent → world: patches*,
 * W3): every committed step on the linked base document, from the same `doc.op`, `doc.undo` and
 * `doc.redo` events that feed the viewer (through the session's event fan-out), grouped into the
 * batches that each become one patch.
 *
 * - One batch per committed entry, undo or redo; sandboxes' events (`doc` ≠ "base") are ignored,
 *   since nothing reaches the world before a merge, and the merge is one entry on the base.
 * - A `restore`'s steps are one batch (`13`, *Decisions*), between the document's restore start and
 *   end signals.
 * - Commits of "does not push" entries (`world_sync`, `no-push.ts`) are dropped; their undo and
 *   redo are not.
 *
 * Like the `deltas.bin` writer, a step is found by its `jseq` in the journal, which holds the
 * positions and the before and after states.
 */

/** One journal step: `to` is the side the document moved to ("after" for an op or redo). */
export interface JournalStep {
  kind: "op" | "undo" | "redo";
  entry: JournalEntry;
  to: "before" | "after";
}

export interface JournalTap {
  /** Stops listening (and drops a restore batch in progress). */
  close(): void;
}

/**
 * Listens through `subscribe` (the session's fan-out) and calls `onBatch` with the steps of each
 * batch, in journal order, for the document `doc()` returns (the linked base document, or undefined
 * while nothing is linked). `onBatch` runs synchronously inside the commit, so it must only queue.
 */
export function tapJournal(subscribe: (fn: EventListener) => () => void, doc: () => Document | undefined, onBatch: (doc: Document, steps: JournalStep[]) => void): JournalTap {
  let restoring: { doc: Document; steps: JournalStep[] } | undefined;
  let watched: Document | undefined;
  const onRestore = (phase: "start" | "end") => {
    const d = doc();
    if (!d) return;
    if (phase === "start") restoring = { doc: d, steps: [] };
    else {
      const r = restoring;
      restoring = undefined;
      if (r && r.doc === d && r.steps.length) onBatch(d, r.steps);
    }
  };
  /** Follows the linked document so the restore signal comes from the right one. */
  const watch = () => {
    const d = doc();
    if (d === watched) return d;
    watched?.restoreListeners.delete(onRestore);
    watched = d;
    d?.restoreListeners.add(onRestore);
    return d;
  };
  watch();
  const unsubscribe = subscribe((e, tag) => {
    if (tag !== "base" || (e.kind !== "doc.op" && e.kind !== "doc.undo" && e.kind !== "doc.redo")) return;
    const d = watch();
    if (!d) return;
    const entry = findEntry(d.journal, e.jseq);
    if (!entry) return;
    const kind = e.kind === "doc.op" ? "op" : e.kind === "doc.undo" ? "undo" : "redo";
    if (kind === "op" && !pushes(entry.op)) return;
    const step: JournalStep = { kind, entry, to: kind === "undo" ? "before" : "after" };
    if (restoring && restoring.doc === d) restoring.steps.push(step);
    else onBatch(d, [step]);
  });
  return {
    close() {
      unsubscribe();
      watched?.restoreListeners.delete(onRestore);
      watched = undefined;
      restoring = undefined;
    },
  };
}

/** The entry with journal sequence number `jseq`, searched from the newest (it is normally the last). */
function findEntry(j: Journal, jseq: number): JournalEntry | undefined {
  for (let i = j.entries.length - 1; i >= 0; i--) if (j.entries[i]!.seq === jseq) return j.entries[i];
  return undefined;
}
