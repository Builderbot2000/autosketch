/**
 * The "does not push" marker (docs/design/13-live-world.md, *World → agent: sync*: a sync "pushes
 * nothing"; briefs/world, *"Does not push" marker*).
 *
 * A journal entry whose op name is in `NO_PUSH_OPS` only brought the world into the cache, so the
 * patch sender never turns its commit into a patch. The marker is the op name, because that is what
 * the journal already records and persists and what every `doc.op` event carries, so neither the
 * journal format nor the event changes. Silo Q's sync primitive (`applyWorldState`) commits with
 * `WORLD_SYNC_OP`; P's ack handling and context changes go through that primitive too.
 *
 * Only the commit is exempt. Undoing or redoing such an entry moves the cache away from the world
 * state it recorded, so those steps are patches like any other (and the sync barrier, `13` *World
 * undo and restore*, decides whether they may happen at all).
 */

/** The op name of a sync entry (`13`, *Journaled*). */
export const WORLD_SYNC_OP = "world_sync";

/** Op names whose commits are never sent to the world. */
export const NO_PUSH_OPS: ReadonlySet<string> = new Set([WORLD_SYNC_OP]);

/** Whether committing an entry with this op name sends a patch. */
export function pushes(op: string): boolean {
  return !NO_PUSH_OPS.has(op);
}
