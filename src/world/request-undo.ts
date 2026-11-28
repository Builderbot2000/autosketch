import type { Document } from "../document/document.js";
import type { JournalEntry } from "../document/journal.js";
import type { ControlAnswer } from "./requests.js";
import { isWorldSync } from "./sync.js";

/**
 * `[Undo request]` (docs/design/19-canvas-and-requests.md, *Stop*, step 5; *Settled in step Q2*):
 * the journal entries one in-game request made on the base document, undone as one step through
 * the usual undo. Measurements only: which entries, how many, and what blocks the undo.
 */

/** The base-document journal entries a request committed while it ran (its own ops and the scope merges it made; never `world_sync`). */
export interface RequestEdits {
  /** The base document they were made on (a relink or `doc_open` replaces it, with a fresh journal). */
  doc: Document;
  /** Their journal sequence numbers, in commit order. */
  seqs: number[];
}

/** A successful undo: how many of the request's entries were undone and the steps taken (the same, as nothing else lies between them). */
export type UndoDone = { ok: true; entries: number; steps: number; first: number; last: number };

/**
 * Undoes request `id`'s entries on `current` (the base document now), all or nothing:
 *
 * - `answered` when nothing is left to undo (no entries, or every one already undone);
 * - `refused` when the document changed since, when another entry came after the request's last
 *   applied one (an edit, or a `world_sync` bringing hand edits in), or when a write guard refuses
 *   a step (the sync barrier for a `world_sync` between its entries, a lock, a held read-only mode);
 * - otherwise `Document.undoTo` steps back to just before its first applied entry, one restore, so
 *   the world link sends one patch.
 */
export function undoRequest(id: number, edits: RequestEdits, current: Document | undefined): UndoDone | Extract<ControlAnswer, { ok: false }> {
  const no = (error: "answered" | "refused", message: string) => ({ ok: false as const, error, message });
  if (!edits.seqs.length) return no("answered", `Request ${id} made no edits.`);
  if (current !== edits.doc) return no("refused", `Request ${id} edited document "${edits.doc.meta.name}", and ${current ? `"${current.meta.name}"` : "no document"} is open now (or it was relinked, with a new journal).`);
  const j = current.journal;
  const mine = new Set(edits.seqs);
  // Chain indices of the request's entries still applied (an entry the agent undid and replaced is gone from the chain).
  const applied: number[] = [];
  for (let i = 0; i < j.position; i++) if (mine.has(j.seqs[i]!)) applied.push(i);
  if (!applied.length) return no("answered", `Request ${id}'s ${count(edits.seqs.length, "edit")} ${edits.seqs.length === 1 ? "is" : "are"} already undone.`);
  const first = applied[0]!, last = applied.at(-1)!;
  if (last < j.position - 1) {
    const later = j.peek(last + 1, j.position);
    const n = j.position - 1 - last;
    return no("refused", `Request ${id} can't be undone: ${count(n, "later entry", "later entries")} came after its last one (#${j.seqs[last]}): ${later.slice(0, 3).map(describe).join("; ")}${n > 3 ? "; …" : ""}.`);
  }
  try {
    const r = current.undoTo(first, `undo of request ${id}`);
    return { ok: true, entries: applied.length, steps: r.steps, first: j.seqs[first]!, last: j.seqs[last]! };
  } catch (e) {
    const inner = ((e as { cause?: unknown }).cause ?? e) as Error;
    const code = (e as { refusal?: unknown }).refusal;
    if (code === "sync_barrier") {
      const sync = j.peek(first, j.position).find((x) => isWorldSync(x) && x.before.length > 0);
      if (sync) return no("refused", `Request ${id} can't be undone: ${describe(sync)} lies between its entries; undoing past it would overwrite those blocks in the world.`);
    }
    if (typeof code === "string" && code) return no("refused", `Request ${id} can't be undone: ${inner.message.replace(/ Nothing was written\.$/, "")}`);
    throw e;
  }
}

/** `#12 world_sync (4 blocks changed in the world)`, `#9 fill …`. */
function describe(e: JournalEntry): string {
  if (isWorldSync(e)) return `#${e.seq} world_sync (${count(e.before.length, "block")} changed in the world)`;
  return `#${e.seq} ${e.summary}`;
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** What `requestUndoer` needs of the session (`Session`): the call hooks, the base document, autosave. */
export interface UndoHost {
  /** `Session.runCall`: the call hooks run around the undo (the stop refusal, the sync of a dirty cache, the world link's patch and ack wait). */
  runCall(call: { tool: string; scope: string; doc: boolean; mutating: boolean }, run: () => { content: { type: "text"; text: string }[]; isError?: boolean }): Promise<unknown>;
  readonly doc?: Document | undefined;
  touch(): void;
}

/**
 * The lifecycle's `undo` (`RequestLifecycleOptions.undo`): `undoRequest` run as an `undo` call
 * through the session's call hooks, so it goes the way the agent's own undo goes: a dirty cache is
 * synced first (hand edits since then become a `world_sync` entry after the request's, which
 * refuses the undo), and the world link sends the steps as one patch and waits for its ack.
 * `note` tells the agent on its next linked call.
 */
export function requestUndoer(host: UndoHost, note?: (line: string) => void): (request: number, edits: RequestEdits) => Promise<UndoDone | Extract<ControlAnswer, { ok: false }>> {
  return async (request, edits) => {
    let answer: UndoDone | Extract<ControlAnswer, { ok: false }> | undefined;
    try {
      await host.runCall({ tool: "undo", scope: "base", doc: true, mutating: true }, () => {
        answer = undoRequest(request, edits, host.doc);
        if (answer.ok) host.touch();
        return { content: [{ type: "text", text: answer.ok ? `undid request ${request}` : answer.message }], ...(answer.ok ? {} : { isError: true }) };
      });
    } catch (e) {
      // A hook refused before the undo ran (a held read-only mode's volume rule, a failed sync), or a step failed.
      if (answer?.ok) throw e;
      return { ok: false, error: "refused", message: `Request ${request} can't be undone: ${(e as Error).message}` };
    }
    if (!answer) return { ok: false, error: "refused", message: `Request ${request} can't be undone.` };
    if (answer.ok) note?.(`The player undid request ${request}: ${answer.entries} entr${answer.entries === 1 ? "y" : "ies"} (#${answer.first}–#${answer.last}) in one step.`);
    return answer;
  };
}
