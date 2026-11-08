# 13 — Live World Link

Lets the agent build directly in the world the player has loaded, while the player keeps placing and tweaking blocks by hand. The agent's edits appear in the world op by op, and the player's hand edits reach the agent automatically. Nobody carries schematic files back and forth or types commands per action.

Two pieces make it work: a **companion mod** in the game, and a **world link** in the MCP server that connects a document to a region of the loaded world.

## Principles

- **The world is authoritative; the document is a cache.** The MCP keeps a local copy of the work region because every tool (selections, perception, scripts, scopes, the journal) runs on the in-memory document, and a block-by-block round trip to the game per query would be far too slow. The copy never wins a disagreement: whenever world and cache differ, the world's value replaces the cache's.
- **The toolset doesn't change.** Tools keep acting on the document. The link sits beside it: it turns committed journal entries into patches for the world and brings world changes into the cache. No tool knows whether its document is linked.
- **Bounded by the work region, both ways.** Everything the agent writes stays inside the work region, and everything the link watches is inside it too. Player edits outside the region are none of the link's business.
- **Never destroy a hand edit silently.** Every block the MCP sends carries the state it expects to replace (and, for blocks with a block entity, a hash of the NBT it expects). The mod only writes where the world still holds that state, and reports every block it skipped. Overwriting hand edits always needs an explicit request. This is the "strictly non-destructive" condition `12` set for writing into a live world.
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
- **The region bounds the document.** A linked document's bounds are the region and never grow. A write outside it, by any op, script, plugin action or merge, is refused (`outside_world_region`) through `Document.guard`, the way a sandbox refuses writes outside its work volume (`11`).
- The cache also holds a read-only **context shell**: the world's blocks one block outside the region, so fences, walls, panes and stairs at the region's edge connect to what they meet (*Connection seams* in `11`). Ops never write the shell. Patches never include it.

## Work region

The player marks the region in-game, the way WorldEdit's wooden axe does.

- **Wand:** `/autosketch wand` gives a vanilla item (not a wooden axe, to avoid clashing with Axiom or WorldEdit) carrying a `custom_data` marker. Left-click a block sets corner 1, right-click sets corner 2.
- **Commands:** `/autosketch pos1`, `pos2` (at the player's feet, or given coordinates), `show` (outline the region with particles), `clear`.
- The mod sends the region to the MCP whenever it changes. A new region relinks: the cache is replaced by a full snapshot of the new box, and the old region's outline is cleared.
- **A relink starts a fresh journal.** The new region re-origins the document, and the expected states recorded against the old box mean nothing in the new one, so the history before a relink can't be undone. Saved selections, palettes and checkpoints are kept; old checkpoints can no longer be restored and say so when tried.
- While linked, the mod keeps the region's chunks loaded (a chunk ticket) so patches and snapshots never hit unloaded chunks. The ticket is released on unlink or disconnect.

## Agent → world: patches

Every committed journal entry on the linked document becomes one patch. That covers ops, brushes, transforms, stamps, scripts, plugin actions, scope merges, undo, redo and restore. The link subscribes to the same per-op stream that feeds the observe viewer (`doc.op`, `doc.undo`, `doc.redo` through `EventSink`, `core/events.ts`), so no tool or op calls it directly.

**Patch contents:** an id, the dimension, and for each changed position: the world position, the **expected** state (the entry's before-state), the **expected NBT hash** when the before-block has a block entity, the new state, and block-entity NBT when the new block has any. States are full block-state strings with properties, exactly as the document holds them. Connection properties are already derived by the ops (`ops/connect.ts`), so the mod writes states as given.

**Expected NBT hash.** A short hash of the block entity's NBT the cache holds, so the guard notices a hand edit that changed only a block's contents (a chest's items, a sign's text) without sending the whole expected NBT. Both sides hash the same canonical form: compound keys sorted recursively, binary NBT, then the hash *Wire format* names. The form leaves out position keys (`x`, `y`, `z`) and **volatile keys**: NBT that changes on its own while the game runs, such as a furnace's burn time, a hopper's cooldown or a Create machine's kinetic speed. Without that, a ticking block would look hand-edited forever. Volatile keys come from a list: a built-in default plus per-block entries plugins can add (`09`), and blocks can be marked "state only" so their NBT is never compared. The list lives on the MCP side and travels in `hello`, so the mod hashes the same way.

**The mod applies a patch by these rules:**

- **Guard:** for each position, compare the world's current state with the expected one and, when the patch carries an expected NBT hash, the hash of the world's block entity with it. If both match, write the new state. If not, skip it and record the world's actual state and, when it has one, its block-entity NBT.
- **No side effects:** write without neighbour updates, physics or drops (the way Axiom and WorldEdit paste). Sand doesn't fall, water doesn't flow, redstone doesn't fire, and breaking a block never drops items. Old block entities are removed; new ones get the patch's NBT.
- **Tick budget:** split large patches across ticks under a configurable per-tick block budget, so a big stamp doesn't freeze the game. Patches apply strictly in id order. A patch in progress is visible part-way, which is accepted.
- **Unknown blocks:** a state the game doesn't know (a cache built from the wrong instance, a missing mod) is rejected for that position, never written as air.
- **Ack:** once done, report applied count, skipped positions with their actual states and NBT, and rejected positions with reasons.

**The MCP handles the ack** by writing every skipped or rejected position's actual world state (and NBT) into the cache as a "world sync" entry (*World → agent*), and appending a line to the result of the tool that caused the patch when it's still pending, or to the next tool result otherwise: `world: 1,204 placed, 3 skipped (hand-edited), 0 rejected`.

## World → agent: sync

**`world_sync` replaces the cache with the world.** The MCP compares section hashes for the region and the shell, the mod snapshots every section that differs (states plus block-entity NBT), and the document's blocks are replaced to match. Anything only the cache had (stale drafts, lost acks, missed changes) is gone. This is the reset to a known-good state.

- **Journaled.** A sync is one journal entry, op name `world_sync`, holding whatever changed. `history`, `diff` and the `{"changed": …}` selection show what the world changed relative to the cache, which is mostly the player's hand edits.
- **Pushes nothing.** Sync only writes the cache, so it is always safe to run. Its entry is never itself sent as a patch.
- **Metadata survives.** Saved selections, anchors, palettes and checkpoints are kept. Selections stored as expressions re-resolve against the new blocks. Components keep their regions, and the sync result reports how many blocks changed inside each component it touched, rather than silently rewriting it.
- **Automatic.** The MCP can't see user prompts, only tool calls, so "sync at the start of each turn" is implemented as: the mod tracks every block change inside the region that isn't one of its own patch writes (including Axiom edits, pistons, explosions, fluids), and reports the region dirty. Changes outside the region, including the context shell, are ignored and never reported; the shell is refreshed only when sections are re-read. Before running the next tool call on the linked document, the MCP syncs if the region is dirty. Dirty notices may carry the changed positions, so small hand edits sync without a snapshot. Contents-only changes (a chest's items) don't change block states, so the tracker doesn't see them; the NBT hash in the patch guard catches them when the agent next writes that block, and the next section-hash comparison catches them otherwise.
- **Section hashes instead of full snapshots.** Both sides can hash the region per 16×16×16 chunk section: every position's canonical state and NBT hash, in a fixed order. When the MCP needs to know how far the cache has drifted (on reconnect, or after a "whole region" dirty notice), it asks for the section hashes, compares them with its own, and snapshots only the sections that differ. A full snapshot of every section remains for linking and relinking, when there is no cache to compare.
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

- **Same machine only.** The MCP runs on the machine the game (or dedicated server) runs on. Remote servers are out of scope for now (see *Open questions*). Running the game on Windows and the MCP in WSL2 counts as the same machine: WSL2 reaches the mod's loopback socket with mirrored networking (`networkingMode=mirrored` in `%UserProfile%\.wslconfig`). Without it, the MCP reports that the port in the pairing file can't be reached and names the setting.
- **Transport:** a localhost TCP socket opened by the mod, length-prefixed messages. JSON for control messages; patch and snapshot bodies use a compact binary encoding (palette plus packed positions), since a large stamp can carry millions of blocks.
- **Pairing:** the mod writes its port and a random token to `<instance>/config/autosketch-bridge.toml` on startup. The MCP already locates the instance (`02`), reads the file, and sends the token in its hello. A connection without the right token is refused.
- **Version check:** hellos carry the protocol version, the game version and data version, and the mod version. A mismatch is reported, not guessed around.
- **Lifecycle:** the MCP reconnects when the game restarts, and the link resumes with a sync of the sections whose hashes differ (a full snapshot if the region changed meanwhile, which is a relink). Patches queued while disconnected are discarded, not replayed: the next sync makes the cache match the world, and the agent sees the result.
- **Permissions:** commands and the wand require op level 2 (cheats on, in singleplayer).

### Messages

| Direction | Message | Contents |
|-----------|---------|----------|
| both | `hello` | protocol version, token and volatile-key list (MCP → mod), game/data/mod versions (mod → MCP) |
| mod → MCP | `region` | dimension and inclusive box, or none (on change and after hello) |
| MCP → mod | `hashes` | box (region plus shell) |
| mod → MCP | `hashes.result` | one hash per chunk section the box touches |
| MCP → mod | `snapshot` | box (region plus shell), or a list of chunk sections |
| mod → MCP | `snapshot.result` | palette, blocks, block entities |
| MCP → mod | `patch` | id, dimension, positions with expected states and NBT hashes, new states, NBT |
| mod → MCP | `patch.ack` | id, applied count, skipped (position, actual state, actual NBT), rejected (position, reason) |
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
| M5 | Guarded patch applier: per-position expected-state and expected-NBT-hash check (volatile keys excluded), skip and report state and NBT on mismatch, reject unknown states. |
| M6 | Writes without neighbour updates, physics or drops; replaces block entities with the patch's NBT. |
| M7 | Applies patches in order under a configurable per-tick block budget. |
| M8 | Region snapshots (region plus a one-block shell, whole or by chunk section): states and block-entity NBT. Per-section hashes on request. |
| M9 | Change tracker: reports changes inside the region that aren't its own patch writes, from any source (players, Axiom, pistons, explosions, fluids). Ignores everything outside the region. |
| M10 | Localhost socket with token pairing through `config/autosketch-bridge.toml`; version check in hello; survives MCP restarts. |
| M11 | Action-bar notices and outline particles, toggleable. |
| M12 | Leaves entities alone. |

## MCP requirements

| # | Requirement |
|---|-------------|
| W1 | Bridge client: connect, pair with the token from the instance config, reconnect, version check; a clear error naming WSL mirrored networking when the port can't be reached. |
| W2 | Link a document to the world region (`doc_open({ world: true })` or similar), local frame at the region's minimum corner, read-only context shell, writes outside the region refused, fresh journal on relink. |
| W3 | Patch sender subscribed to the journal's event stream; one patch per committed entry on the linked document (one per `restore`), carrying expected states and NBT hashes. |
| W4 | Ack handling: skipped and rejected positions written back into the cache as a `world_sync` entry, and summarized in a tool result. |
| W5 | `world_sync` tool and automatic sync before a tool call when the region is dirty; section-hash comparison so only differing sections are snapshotted; journaled, pushes nothing, keeps metadata, reports component drift. |
| W10 | Canonical NBT hashing and section hashing identical to the mod's, with the volatile-key list (built-in default plus plugin entries) sent in `hello`. |
| W6 | Sync barrier for undo, redo and restore through `Document.guard`; `overwriteHandEdits` to cross it and to force one patch. |
| W7 | Scope merges as one guarded patch; merge check relaxed for positions changed by syncs, listed in the report. |
| W8 | Events for the viewer (`12`): `world.link`, `world.patch` (with ack counts), `world.sync`. |
| W9 | A fake in-game host implementing the protocol in TypeScript, for unit tests of the guard, sync, barrier, merge and reconnect paths without a running game. |

## Implementation status

Not started. Work is split into silos in `docs/briefs/world/`. Suggested order: protocol, hashing and fake host (W9, W10), then the MCP side (W1–W8) tested against the fake host, then the mod (M1–M12), then end-to-end tests in a Craftoria save.

## Open questions

- **Throughput.** How many blocks per tick can the mod apply without visible lag, and what default budget does that suggest? Measure on a Craftoria save with a large stamp.
- **Change tracking.** Catching every change source (M9), including Axiom's, probably needs a mixin on chunk block-state writes. Is its per-write cost acceptable, and does it hold up with Craftoria's other mods? Fallback: the mod compares its own section hashes periodically and reports the sections that changed as dirty.
- **Snapshot cost** for large regions. Full snapshots happen only on link and relink; reconnects and "whole region" dirty notices re-read only the sections whose hashes differ. How large a region stays practical, and how long does hashing every section take?
- **Volatile keys.** Which NBT keys change on their own in Craftoria's block entities (Create, storage mods, machines)? Too few on the list means false "hand-edited" skips; too many means missed contents edits. Measure the false-skip rate on a running Craftoria base and grow the default list from it.
- **Remote servers.** Out of scope for now: the MCP runs on the game's machine. Later: on a multiplayer server the mod runs on the server's machine. Does the MCP reach it through a port opened beyond localhost (with the token), a tunnel, or by running beside the server?

## Decisions

Settled with the user on 2026-11-08:

- **The work region bounds everything** (*Principles*, *Model*, *World → agent*). The agent's writes outside it are refused, and player edits outside it are ignored. Reason: the region is the contract between player and agent; anything the agent could touch outside it would be a surprise, and anything outside it the player does is theirs.
- **A relink starts a fresh journal** (*Work region*). Reason: re-origining makes the old expected states meaningless, so undoing past a relink could only ever be wrong.
- **Expected NBT as a hash** (*Agent → world*). Reason: it closes the "contents changed, block didn't" gap at the cost of a few bytes per block entity, instead of sending whole NBT compounds in every patch. Section hashes reuse the same canonical form to make reconnects cheap.
- **No `/autosketch undo`.** The player asks the agent to undo, so there is one history with one owner.
- **`restore` reaches the world as one patch**, even though `Document.restore` steps entry by entry.
