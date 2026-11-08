# 13 — Live World Link

Lets the agent build directly in the world the player has loaded, while the player keeps placing and tweaking blocks by hand. The agent's edits appear in the world op by op, and the player's hand edits reach the agent automatically. Nobody carries schematic files back and forth or types commands per action.

Two pieces make it work: a **companion mod** in the game, and a **world link** in the MCP server that connects a document to a region of the loaded world.

## Principles

- **The world is authoritative; the document is a cache.** The MCP keeps a local copy of the work region because every tool (selections, perception, scripts, scopes, the journal) runs on the in-memory document, and a block-by-block round trip to the game per query would be far too slow. The copy never wins a disagreement: whenever world and cache differ, the world's value replaces the cache's.
- **The toolset doesn't change.** Tools keep acting on the document. The link sits beside it: it turns committed journal entries into patches for the world and brings world changes into the cache. No tool knows whether its document is linked.
- **Never destroy a hand edit silently.** Every block the MCP sends carries the state it expects to replace. The mod only writes where the world still holds that state, and reports every block it skipped. Overwriting hand edits always needs an explicit request. This is the "strictly non-destructive" condition `12` set for writing into a live world.
- **Server-side only, no new content.** The mod registers no blocks or items, so it runs in singleplayer (the game's built-in server) and on a dedicated server without clients installing anything.
- **The same engine for both workflows.** An unlinked document is just a schematic, exactly as before. The link is an attachment, not a different kind of document.

## Model

```
   MCP server (Node)                                   Minecraft (JVM)
┌──────────────────────────────┐                    ┌───────────────────────────┐
│ tools ──► Document (cache) ──┼─ journal entry ──► │                           │
│              ▲  journal      │    = patch          │  companion mod            │
│              │               │  ◄── ack ───────── │   · guarded patch applier │
│        world link            │                    │   · region snapshots       │
│   · patch sender             │  ◄── dirty ─────── │   · change tracker         │
│   · sync (world → cache)     │  ── snapshot ────► │   · wand + commands        │
│   · guarded undo / restore   │  ◄── blocks ────── │                           │
└──────────────────────────────┘   localhost socket └─────────────┬─────────────┘
                                                                   ▼
                                                        loaded world (the save)
```

- One link per session, between the base document and one **work region**: a dimension plus an inclusive box (`01`), set by the player in-game.
- The document's local frame puts the region's minimum corner at (0,0,0). World position = local position + region minimum. Exports from a linked document work as usual.
- The cache also holds a read-only **context shell**: the world's blocks one block outside the region, so fences, walls, panes and stairs at the region's edge connect to what they meet (*Connection seams* in `11`). Ops never write the shell. Patches never include it.

## Work region

The player marks the region in-game, the way WorldEdit's wooden axe does.

- **Wand:** `/autosketch wand` gives a vanilla item (not a wooden axe, to avoid clashing with Axiom or WorldEdit) carrying a `custom_data` marker. Left-click a block sets corner 1, right-click sets corner 2.
- **Commands:** `/autosketch pos1`, `pos2` (at the player's feet, or given coordinates), `show` (outline the region with particles), `clear`.
- The mod sends the region to the MCP whenever it changes. A new region relinks: the cache is replaced by a sync of the new box (journaled like any sync), and the old region's outline is cleared.
- While linked, the mod keeps the region's chunks loaded (a chunk ticket) so patches and snapshots never hit unloaded chunks. The ticket is released on unlink or disconnect.

## Agent → world: patches

Every committed journal entry on the linked document becomes one patch. That covers ops, brushes, transforms, stamps, scripts, plugin actions, scope merges, undo, redo and restore. The link subscribes to the same per-op stream that feeds the observe viewer (`doc.op`, `doc.undo`, `doc.redo` through `EventSink`, `core/events.ts`), so no tool or op calls it directly.

**Patch contents:** an id, the dimension, and for each changed position: the world position, the **expected** state (the entry's before-state), the new state, and block-entity NBT when the new block has any. States are full block-state strings with properties, exactly as the document holds them. Connection properties are already derived by the ops (`ops/connect.ts`), so the mod writes states as given.

**The mod applies a patch by these rules:**

- **Guard:** for each position, compare the world's current state with the expected one. If they match, write the new state. If not, skip it and record the world's actual state.
- **No side effects:** write without neighbour updates, physics or drops (the way Axiom and WorldEdit paste). Sand doesn't fall, water doesn't flow, redstone doesn't fire, and breaking a block never drops items. Old block entities are removed; new ones get the patch's NBT.
- **Tick budget:** split large patches across ticks under a configurable per-tick block budget, so a big stamp doesn't freeze the game. Patches apply strictly in id order. A patch in progress is visible part-way, which is accepted.
- **Unknown blocks:** a state the game doesn't know (a cache built from the wrong instance, a missing mod) is rejected for that position, never written as air.
- **Ack:** once done, report applied count, skipped positions with their actual states, and rejected positions with reasons.

**The MCP handles the ack** by writing every skipped or rejected position's actual world state into the cache as a "world sync" entry (*World → agent*), and appending a line to the result of the tool that caused the patch when it's still pending, or to the next tool result otherwise: `world: 1,204 placed, 3 skipped (hand-edited), 0 rejected`.

## World → agent: sync

**`world_sync` replaces the cache with the world.** The mod snapshots the whole region (states plus block-entity NBT) and the shell. The document's blocks are replaced to match. Anything only the cache had (stale drafts, lost acks, missed changes) is gone. This is the reset to a known-good state.

- **Journaled.** A sync is one journal entry, op name `world_sync`, holding whatever changed. `history`, `diff` and the `{"changed": …}` selection show what the world changed relative to the cache, which is mostly the player's hand edits.
- **Pushes nothing.** Sync only writes the cache, so it is always safe to run. Its entry is never itself sent as a patch.
- **Metadata survives.** Saved selections, anchors, palettes and checkpoints are kept. Selections stored as expressions re-resolve against the new blocks. Components keep their regions, and the sync result reports how many blocks changed inside each component it touched, rather than silently rewriting it.
- **Automatic.** The MCP can't see user prompts, only tool calls, so "sync at the start of each turn" is implemented as: the mod tracks every block change inside the region that isn't one of its own patch writes (including Axiom edits, pistons, explosions, fluids), and reports the region dirty. Before running the next tool call on the linked document, the MCP syncs if the region is dirty. Dirty notices may carry the changed positions, so small hand edits sync without a full snapshot.
- **Manual.** `world_sync` is also a tool the agent (or the player through the agent) can call at any time.

## World undo and restore

The world has no undo history of its own, so the journal provides it.

- **Undo and redo** produce journal entries like any op, and so become guarded patches. Expected states are the cache's current states, so a block the player changed after the last sync is skipped and reported.
- **Sync barrier.** Undo and redo stop at a `world_sync` entry that changed blocks: going past it would push the pre-sync cache into the world and erase the player's hand edits. The refusal says so. `overwriteHandEdits: true` crosses the barrier.
- **Restore to a checkpoint** pushes the difference between the cache and the checkpoint to the world as one guarded patch. If the path back crosses a sync barrier, it is refused the same way unless `overwriteHandEdits: true` is passed. It stays all or nothing in the cache, as in `11` (*Locks also guard undo and redo*): every step is checked before any is applied.
- **`overwriteHandEdits: true`** also turns off the patch guard for that one patch, so the world is forced to the target state. The agent passes it only when the player has asked to discard their hand edits. The result reports how many hand-edited blocks were overwritten.
- The barrier is enforced through `Document.guard` (`11`, *Implementation status*), so tools, scripts and history all obey it the same way they obey locks.

Together these are the two directions:

| Direction | Tool | Effect | Safety |
|-----------|------|--------|--------|
| World → cache | `world_sync` | Cache replaced by the world | Always safe; pushes nothing |
| Cache → world | `restore`, `undo`, `redo` | World moved to a journal state | Guarded; sync barrier; forced only with `overwriteHandEdits` |

## Scoped sessions

Sandboxes (`11`) are unchanged: they are unlinked sub-documents, so subagents draft privately and nothing reaches the world until merge. The merge is one journal entry on the base document, and therefore one guarded patch.

The player is a writer who ignores locks. A hand edit inside a locked work volume reaches the base document through a sync, which is allowed: the world is authoritative. That breaks the merge's "parent unchanged since fork" check, so with a link the check is relaxed for positions changed by `world_sync` entries: the merge still applies, and those positions go out through the patch guard, which skips them if the world still holds the hand edit. The merge report lists them.

## Connection

- **Transport:** a localhost TCP socket opened by the mod, length-prefixed messages. JSON for control messages; patch and snapshot bodies use a compact binary encoding (palette plus packed positions), since a large stamp can carry millions of blocks.
- **Pairing:** the mod writes its port and a random token to `<instance>/config/autosketch-bridge.toml` on startup. The MCP already locates the instance (`02`), reads the file, and sends the token in its hello. A connection without the right token is refused.
- **Version check:** hellos carry the protocol version, the game version and data version, and the mod version. A mismatch is reported, not guessed around.
- **Lifecycle:** the MCP reconnects when the game restarts, and the link resumes with a full sync. Patches queued while disconnected are discarded, not replayed: the next sync makes the cache match the world, and the agent sees the result.
- **Permissions:** commands and the wand require op level 2 (cheats on, in singleplayer).

### Messages

| Direction | Message | Contents |
|-----------|---------|----------|
| both | `hello` | protocol version, token (MCP → mod), game/data/mod versions (mod → MCP) |
| mod → MCP | `region` | dimension and inclusive box, or none (on change and after hello) |
| MCP → mod | `snapshot` | box (region plus shell) |
| mod → MCP | `snapshot.result` | palette, blocks, block entities |
| MCP → mod | `patch` | id, dimension, positions with expected and new states, NBT |
| mod → MCP | `patch.ack` | id, applied count, skipped (position, actual state), rejected (position, reason) |
| mod → MCP | `dirty` | changed positions, or "whole region" when too many to list |
| MCP → mod | `notice` | short text for the player's action bar (optional) |

## Player feedback in-game

- The region outline while the wand is held, or after `/autosketch show`.
- An action-bar line when a patch lands: `Autosketch: 1,204 placed, 3 skipped`. Toggle with `/autosketch notices on|off`.
- `/autosketch status`: link state, region, last patch, pending patches.

## Companion mod requirements

| # | Requirement |
|---|-------------|
| M1 | NeoForge 1.21.1, Java (JDK 21), built from NeoForge's MDK as a `mod/` subproject. |
| M2 | Server-side only: no registered blocks, items or other registry content; clients join without it. |
| M3 | Work region: wand item marked with `custom_data`, `/autosketch wand|pos1|pos2|show|clear|status|notices`, op level 2. |
| M4 | Sends the region to the MCP on change; keeps its chunks loaded with a ticket while linked. |
| M5 | Guarded patch applier: per-position expected-state check, skip and report on mismatch, reject unknown states. |
| M6 | Writes without neighbour updates, physics or drops; replaces block entities with the patch's NBT. |
| M7 | Applies patches in order under a configurable per-tick block budget. |
| M8 | Region snapshots (region plus a one-block shell): states and block-entity NBT. |
| M9 | Change tracker: reports changes inside the region that aren't its own patch writes, from any source (players, Axiom, pistons, explosions, fluids). |
| M10 | Localhost socket with token pairing through `config/autosketch-bridge.toml`; version check in hello; survives MCP restarts. |
| M11 | Action-bar notices and outline particles, toggleable. |
| M12 | Leaves entities alone. |

## MCP requirements

| # | Requirement |
|---|-------------|
| W1 | Bridge client: connect, pair with the token from the instance config, reconnect, version check. |
| W2 | Link a document to the world region (`doc_open({ world: true })` or similar), local frame at the region's minimum corner, read-only context shell. |
| W3 | Patch sender subscribed to the journal's event stream; one patch per committed entry on the linked document, carrying expected states. |
| W4 | Ack handling: skipped and rejected positions written back into the cache as a `world_sync` entry, and summarized in a tool result. |
| W5 | `world_sync` tool and automatic sync before a tool call when the region is dirty; journaled, pushes nothing, keeps metadata, reports component drift. |
| W6 | Sync barrier for undo, redo and restore through `Document.guard`; `overwriteHandEdits` to cross it and to force one patch. |
| W7 | Scope merges as one guarded patch; merge check relaxed for positions changed by syncs, listed in the report. |
| W8 | Events for the viewer (`12`): `world.link`, `world.patch` (with ack counts), `world.sync`. |
| W9 | A fake in-game host implementing the protocol in TypeScript, for unit tests of the guard, sync, barrier, merge and reconnect paths without a running game. |

## Implementation status

Not started. Suggested order: protocol and fake host (W9), then the MCP side (W1–W8) tested against the fake host, then the mod (M1–M12), then end-to-end tests in a Craftoria save.

## Open questions

- **Throughput.** How many blocks per tick can the mod apply without visible lag, and what default budget does that suggest? Measure on a Craftoria save with a large stamp.
- **Change tracking.** Catching every change source (M9), including Axiom's, probably needs a mixin on chunk block-state writes. Is its per-write cost acceptable, and does it hold up with Craftoria's other mods? Fallback: periodic snapshot comparison.
- **Snapshot cost** for large regions. Full snapshots should be rare (link, relink, reconnect, "whole region" dirty notices), but how large a region stays practical?
- **Expected NBT.** The guard compares block states only, so a player changing a chest's contents without changing the block isn't detected. Should block-entity NBT be part of the expected value for some blocks?
- **Remote servers.** On a multiplayer server the mod runs on the server's machine. Does the MCP reach it through a port opened beyond localhost (with the token), a tunnel, or by running beside the server?
- **Region changes and the journal.** Relinking to a different box re-origins the document. Should history before the relink stay undoable, or should a relink start a fresh journal?
- **Player-side undo.** Is a `/autosketch undo` command (asking the MCP to undo the last agent op) worth it, or should the player always ask the agent?
