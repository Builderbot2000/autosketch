# Silo P: MCP link core

**Wave 1**, against silo L's fake host. Runs in parallel with silo Q; the two meet at the sync primitive (Q) and the link object (P), see the contracts table in the README.

**Specs:** `13` (*Model*, *Agent → world: patches*, *Connection*, *MCP requirements*), `12` (*Event stream*: P adds the `world.*` kinds), `04` (journal), `02` (instance locator).

## Goal

Link the base document to the world as the root scope (the player's work and context volumes), turn every committed journal entry on it into one guarded patch, then fold each ack back into the cache. No tool or op knows the link exists.

## Deliverables, in merge order

1. **Journal subscription.** The link needs every `doc.op`, `doc.undo` and `doc.redo` on the base document, including when observability is off. Today `doc.events` is a single sink and emitters skip building payloads when it isn't `enabled` (`core/events.ts`). Add the smallest change that works: e.g. a fan-out sink that stays enabled while a link is open, or a separate commit listener on `Document`. Like the `deltas.bin` writer (`observe/deltas.ts`), look the entry up by `jseq` to get positions and before/after states. Sandboxes' events are never patched. Silo S's activity stream reads the same fan-out, including the `tool()` wrapper's `call.*` events, so make it carry those too and expose a subscribe function.
2. **Bridge client** (W1) in `src/world/bridge.ts`: read the pairing file from the instance `02` already locates, connect, `hello`, version check, reconnect with backoff when the game restarts. When the port can't be reached, the error names WSL mirrored networking (`13`, *Connection*). Queued patches are discarded on disconnect, not replayed (`13`, *Lifecycle*); a reconnect asks Q's sync for a section-hash sync.
3. **Root scope** (W2) in `src/world/link.ts`: `doc_open({ world: true })` (an optional argument, so additive) opens or replaces the base document as a linked one when the mod reports volumes (`13`, *Model*). Reuse `11`'s machinery rather than re-implementing it: re-origin to the work volume's minimum corner, whole-block extension (`scope/multiblock.ts`, reported to the player through `notice` and to the agent in the next result), `Document.context` for the context volume so renders ghost it and slices mark it, and the sandbox write rule so writes outside the work volume are refused with the existing `outside_work_volume`. If that rule is private to `scope/scopes.ts`, export it there in a small additive change (the dependency `world/` → `scope/` is allowed, one way). A new work volume relinks with a fresh journal and a full snapshot; a context-only change syncs the added and removed context through Q's primitive without relinking. Patches never include context positions. Expose the link object (README contracts) on the session.
4. **Patch sender** (W3) in `src/world/patch.ts`: one patch per committed entry, carrying world positions, expected (before) states, expected NBT hashes for before-blocks with a block entity (L's `hash.ts`), new states and NBT. Send the volatile-key list in `hello`: L's default plus entries from plugins (an optional field on the plugin interface in `src/plugins/types.ts`, additive). Skip entries marked "does not push" (`world_sync`). Coalesce a `restore` into one patch (README *Decisions* 4): this needs a start/end signal around `Document.restore`; add it as a small additive hook. Patches go out in journal order.
5. **Ack handling** (W4): write skipped and rejected positions' actual states into the cache through Q's `applyWorldState` (one `world_sync` entry), then add `world: N placed, N skipped (hand-edited), N rejected` to the result of the tool that caused the patch if it's still running, else to the next tool result on the linked document. Do that through the `tool()` wrapper without changing any tool module.
6. **Events** (W8): `world.link`, `world.patch` (with ack counts) and `world.sync` in `core/events.ts` and the kinds table in `12`. Viewer support for them is optional; a feed line is enough.

## Files you own

- New: `src/world/**` except `src/world/protocol/**` (L), `src/world/sync.ts` (Q) and S's prompt and chat-stream modules; `src/server/tools/world.ts` if `doc_open`'s argument can't live in `document.ts`'s schema (prefer the latter, one optional field); matching tests in `test/unit/world/`.
- Additive: `document.ts` (subscription, restore start/end, entry marker), `session.ts`, the `tool()` wrapper, `server/index.ts` wiring, `core/events.ts`.

## Done when

All against the fake host, in `test/unit/world/`:

- A `fill` on a linked document produces one patch whose expected states are the fill's before-states, and the fake world matches the cache afterwards.
- A fake-host `playerSet` on a position the next op also writes leaves the player's block in the world, the cache matches the world after the ack, and the tool result carries the `world:` line.
- A `restore` across five ops sends exactly one patch.
- A fake-host `playerSetNbt` on a chest the next op replaces leaves the chest in the world, and the cache gets the chest's actual NBT from the ack. A `tick` on a furnace doesn't cause a skip.
- A script, a stamp, a plugin action and a scope merge each send exactly one patch.
- `world_sync` entries are never sent.
- Disconnect, edit, reconnect: nothing queued is replayed, and a full sync runs.
- An unlinked session's tool results and journal are identical before and after this silo's changes (compare a recorded session).
- `13`'s rows W1–W4 and W8 are marked done.
