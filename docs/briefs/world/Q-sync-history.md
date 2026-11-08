# Silo Q: Sync and history safety

**Wave 1**, against silo L's fake host. Land the sync primitive (deliverable 1) first, in its own merge: silo P's ack handling calls it. Auto-sync (deliverable 3) needs P's link object; build the rest first.

**Specs:** `13` (*World → agent: sync*, *World undo and restore*, *Scoped sessions*), `11` (*Locks also guard undo and redo*, merge sanity check, *Implementation status* on `Document.guard`), `04` (journal, checkpoints, components), `05` (`{"changed": …}` selection, saved selections).

## Goal

Bring the world into the cache safely and keep undo, redo, restore and scope merges from ever pushing stale cache over a hand edit unless the player asked for it.

## Deliverables, in merge order

1. **Sync primitive** in `src/world/sync.ts`: `applyWorldState(doc, changes, opts)` writes world states and NBT into the cache as one journal entry with op name `world_sync`, carrying P's "does not push" marker. Whole form (replace everything inside the work and context volumes, from a snapshot), section form (replace the listed chunk sections, from a section snapshot), and partial form (listed positions, from `dirty` or an ack).
   Writes `raw` (no auto-connection recompute: the world's states are the truth). Bypasses the write rules that exist for agents: locks, and the root scope's work-volume rule, since a sync writes context positions too. Clearing context the player removed is a sync as well.

   **Section-hash sync** in the same module: hash the cache per chunk section with L's `hash.ts`, ask the mod for `hashes`, snapshot only the sections that differ, apply them in one entry. Used by `world_sync`, auto-sync after an "everything" dirty, and P's reconnect. Keep cache section hashes incrementally (invalidate a section on every write) so comparing large volumes doesn't rehash them all.
2. **What a sync keeps** (W5): saved selections, anchors, palettes and checkpoints survive; expression selections re-resolve on use; components keep their regions, and the result reports blocks changed inside each component it touched. The result also feeds `history`, `diff` and `{"changed": …}` like any entry.
3. **`world_sync` tool and auto-sync** (W5): a tool in `src/server/tools/world.ts` (shared with P if P creates it; agree in the first merge). Auto-sync: before running any tool call on the linked document, if the link reports dirty, sync first (partial when positions are listed, section-hash sync otherwise). One hook in the `tool()` wrapper, never in tool modules. A sync during a call that already ran a sync is skipped.
4. **Sync barrier** (W6): undo and redo refuse to step past a `world_sync` entry that changed blocks (`sync_barrier`, with the message `13` describes). `restore` refuses the same way, checked before any step, all or nothing. `overwriteHandEdits: true` on `undo`, `redo` and `restore` (optional arguments, so additive) crosses the barrier and marks the resulting patch as forced. Enforced through `Document.guard` so tools, scripts and history obey it alike.
5. **Guard composition.** `Document.guard` is a single function today, installed by the scope layer (`scope/scopes.ts`). Compose the barrier with the lock guard rather than replacing it: e.g. a small list of guards on `Document`, run in order. Unlinked documents keep exactly today's behaviour.
6. **Scope merges** (W7): the merge's "parent unchanged since fork" check ignores positions changed by `world_sync` entries since the fork; those positions are listed in the merge report and go out through the patch precondition as usual (P sends the merge as one patch already).

## Files you own

- New: `src/world/sync.ts`, the `world_sync` tool, matching tests.
- Additive: `document.ts` (guard list, barrier), `scope/scopes.ts` (merge check, guard composition), the `tool()` wrapper (one auto-sync hook), `history`/`restore` tool schemas for `overwriteHandEdits`.

## Open points for this silo

- **Ack and dirty arrive between tool calls**, so a `world_sync` entry can commit while the agent has undone ops. Committing it truncates the redo stack, as any edit does. Decide whether that's acceptable or whether sync entries should be applied without truncating redo, record the answer in `13`, and test it.

## Done when

All against the fake host, in `test/unit/world/`:

- A player edit, then the next tool call: the cache shows the edit before the tool runs, and `history` lists one `world_sync` entry.
- A player edit in the context volume syncs, and the agent still can't write there.
- An "everything" dirty with one changed section snapshots only that section; a `playerSetNbt` with no dirty is picked up by the next `world_sync`.
- `undo` past a sync that changed blocks is refused with `sync_barrier`; `undo({ overwriteHandEdits: true })` crosses it and the fake world is forced.
- `restore` across a barrier is refused with nothing changed; with `overwriteHandEdits` it sends one forced patch.
- A sync doesn't drop saved selections, anchors, palettes, checkpoints or components, and reports drift per component.
- A fork, a player edit inside the locked work volume, then merge: the merge applies, the edited positions are listed, and the patch skips them.
- Every existing scope test passes unchanged.
- `13`'s rows W5–W7 are marked done.
