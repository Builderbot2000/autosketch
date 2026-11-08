# 13 — Live World Link

Lets the agent build directly in the world the player has loaded, while the player keeps placing and tweaking blocks by hand. The agent's edits appear in the world op by op, and the player's hand edits reach the agent automatically. Nobody carries schematic files back and forth or types commands per action.

Two pieces make it work: a **companion mod** in the game, and a **world link** in the MCP server that connects a document to part of the loaded world. The player marks that part in-game as a **work volume** and a **context volume**, the same two volumes a sandbox has (`11`): the linked document is the root scope of the session, and the player sets its volumes the way a parent agent sets a subagent's. The player then asks the agent for work from inside the game, pointing at what they mean (*Prompting from the game*), which starts the root agent on that work volume.

## Principles

- **The world is authoritative; the document is a cache.** The MCP keeps a local copy of the work and context volumes because every tool (selections, perception, scripts, scopes, the journal) runs on the in-memory document, and a block-by-block round trip to the game per query would be far too slow. The copy never wins a disagreement: whenever world and cache differ, the world's value replaces the cache's.
- **The toolset doesn't change.** Tools keep acting on the document. The link sits beside it: it turns committed journal entries into patches for the world and brings world changes into the cache. No tool knows whether its document is linked.
- **One scope model, from the world down.** The player-set volumes are a scope like any sandbox (`11`): the agent writes only inside the work volume, reads the context volume, and everything the link watches lies inside the two. Player edits outside both volumes are none of the link's business. Subagents fork from the root scope exactly as they fork from any base document.
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
│        world link            │                    │   · volume snapshots       │
│   · patch sender             │  ◄── dirty ─────── │   · change tracker         │
│   · sync (world → cache)     │  ── snapshot ────► │   · wand: volumes, focus   │
│   · guarded undo / restore   │  ◄── blocks ────── │                           │
└──────────────────────────────┘   localhost socket └─────────────┬─────────────┘
                                                                   ▼
                                                        loaded world (the save)
```

- One link per session, between the base document and one dimension of the loaded world. The base document is the **root scope**: it holds exactly the player's **work volume** and **context volume**, as a sandbox holds its parent's (`11`, *Work and context volumes*).
- **Work volume:** an inclusive box (`01`) the agent may change. Every write outside it, by any op, script, plugin action or merge, is refused (`outside_work_volume`), through the same write rule a sandbox uses, enforced by `Document.guard`. Whole blocks only: when the box cuts a door, bed, double chest or plugin multi-block, the MCP extends the work volume to include it and tells the player, as a fork does.
- **Context volume:** what the agent must see to fit in, which it can read, query, slice and render but never change. One or more boxes: by default the work volume grown by 3 blocks (`11`'s default), and the player can grow it or add boxes anywhere in the dimension, including a distant reference ("match the tower over there"). It always includes the one-block seam around the work volume, so fences, walls, panes and stairs at the edge connect to what they meet (*Connection seams* in `11`). Renders ghost it and slices mark it, as in a sandbox (`Document.context`).
- **Frame:** the work volume's minimum corner is local (0,0,0), and context sits at negative or beyond-max coordinates, the same re-origin a fork does. World position = local position + work volume minimum. A linked document's bounds are the two volumes and never grow. Exports work as usual.
- **Unlike a sandbox's context, the root's context is live.** A sandbox's context is a copy from fork time and may go stale (`11`). The root's context comes from the world, which is authoritative, so the player's edits there sync into the cache like edits in the work volume (*World → agent*). Patches never include context positions, because the agent can't write them.

## Work and context volumes in-game

The player marks both volumes in-game, the way WorldEdit's wooden axe marks a selection.

- **Wand:** `/autosketch wand` gives a vanilla item (not a wooden axe, to avoid clashing with Axiom or WorldEdit) carrying a `custom_data` marker. The wand has three modes: **work**, **context** and **focus** (*Prompting from the game*). Left-click a block sets corner 1 and right-click sets corner 2 of the current mode's box. Pressing the swap-hands key while holding the wand cycles the mode, and `/autosketch mode work|context|focus` sets it. The action bar shows the mode, and each mode's outline has its own particle colour.
- **Commands:** `/autosketch pos1`, `pos2` (at the player's feet, or given coordinates, for the current mode), `show` (outline all volumes), `clear` (remove the work volume, which unlinks).
- **Context commands:** `/autosketch context add` (add the box just marked in context mode), `context grow <n>` (the work volume grown by `n`, replacing the boxes), `context clear` (back to the default). A configurable cap on total context volume keeps snapshots practical.
- The mod sends both volumes to the MCP whenever either changes.
- **A new work volume relinks and starts a fresh journal.** The new work volume re-origins the document, and the expected states recorded against the old frame mean nothing in the new one, so the history before a relink can't be undone. The cache is replaced by a snapshot of the new volumes. Saved selections, palettes and checkpoints are kept; old checkpoints can no longer be restored and say so when tried.
- **A context change alone doesn't relink.** The frame stays, the journal stays, and the MCP snapshots the added context and clears the removed context in one `world_sync` entry.
- While linked, the mod keeps the chunks under both volumes loaded (a chunk ticket) so patches and snapshots never hit unloaded chunks. The ticket is released on unlink or disconnect.

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

**`world_sync` replaces the cache with the world.** The MCP compares section hashes for the work and context volumes, the mod snapshots every section that differs (states plus block-entity NBT), and the document's blocks are replaced to match. Anything only the cache had (stale drafts, lost acks, missed changes) is gone. This is the reset to a known-good state.

- **Journaled.** A sync is one journal entry, op name `world_sync`, holding whatever changed. `history`, `diff` and the `{"changed": …}` selection show what the world changed relative to the cache, which is mostly the player's hand edits.
- **Pushes nothing.** Sync only writes the cache, so it is always safe to run. Its entry is never itself sent as a patch.
- **Metadata survives.** Saved selections, anchors, palettes and checkpoints are kept. Selections stored as expressions re-resolve against the new blocks. Components keep their regions, and the sync result reports how many blocks changed inside each component it touched, rather than silently rewriting it.
- **Automatic.** The MCP can't see user prompts, only tool calls, so "sync at the start of each turn" is implemented as: the mod tracks every block change inside the work or context volume that isn't one of its own patch writes (including Axiom edits, pistons, explosions, fluids), and reports the volumes dirty. Changes outside both volumes are ignored and never reported. Before running the next tool call on the linked document, the MCP syncs if the volumes are dirty. Dirty notices may carry the changed positions, so small hand edits sync without a snapshot. Contents-only changes (a chest's items) don't change block states, so the tracker doesn't see them; the NBT hash in the patch guard catches them when the agent next writes that block, and the next section-hash comparison catches them otherwise.
- **Section hashes instead of full snapshots.** Both sides can hash the volumes per 16×16×16 chunk section: every position's canonical state and NBT hash, in a fixed order. When the MCP needs to know how far the cache has drifted (on reconnect, or after an "everything" dirty notice), it asks for the section hashes, compares them with its own, and snapshots only the sections that differ. A full snapshot of every section remains for linking, relinking and newly added context, when there is no cache to compare.
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

The linked document is the root of the session's scope tree, and the player is its parent:

```
world (the save)
 └─ root scope      work + context volumes set by the player in-game; linked; the root agent works here
     └─ sandbox     work + context volumes set by an agent with scope_fork (11)
         └─ nested sandbox   (up to scope.maxDepth)
```

- **Sandboxes are unchanged** (`11`): unlinked sub-documents, so subagents draft privately and nothing reaches the world until merge. Their volumes must lie inside the root's volumes, as for any nested fork. The merge is one journal entry on the root, and therefore one guarded patch. The ratio limit for a fork from the root measures against the root's work volume.
- **The root's volumes aren't a lock**, because the player who set them is not bound by locks. Agents' locks inside the root work as in `11`.
- **The player is a writer who ignores locks.** A hand edit inside a locked work volume reaches the root through a sync, which is allowed: the world is authoritative. That breaks the merge's "parent unchanged since fork" check, so with a link the check is relaxed for positions changed by `world_sync` entries: the merge still applies, and those positions go out through the patch guard, which skips them if the world still holds the hand edit. The merge report lists them.

## Connection

- **Same machine only.** The MCP runs on the machine the game (or dedicated server) runs on. Remote servers are out of scope for now (see *Open questions*). Running the game on Windows and the MCP in WSL2 counts as the same machine: WSL2 reaches the mod's loopback socket with mirrored networking (`networkingMode=mirrored` in `%UserProfile%\.wslconfig`). Without it, the MCP reports that the port in the pairing file can't be reached and names the setting.
- **Transport:** a localhost TCP socket opened by the mod, length-prefixed messages. JSON for control messages; patch and snapshot bodies use a compact binary encoding (palette plus packed positions), since a large stamp can carry millions of blocks.
- **Pairing:** the mod writes its port and a random token to `<instance>/config/autosketch-bridge.toml` on startup. The MCP already locates the instance (`02`), reads the file, and sends the token in its hello. A connection without the right token is refused.
- **Version check:** hellos carry the protocol version, the game version and data version, and the mod version. A mismatch is reported, not guessed around.
- **Lifecycle:** the MCP reconnects when the game restarts, and the link resumes with a sync of the sections whose hashes differ (a full snapshot if the work volume changed meanwhile, which is a relink). Patches queued while disconnected are discarded, not replayed: the next sync makes the cache match the world, and the agent sees the result.
- **Permissions:** commands and the wand require op level 2 (cheats on, in singleplayer).

### Messages

| Direction | Message | Contents |
|-----------|---------|----------|
| both | `hello` | protocol version, token and volatile-key list (MCP → mod), game/data/mod versions (mod → MCP) |
| mod → MCP | `volumes` | dimension, work volume box, context boxes, or none (on change and after hello) |
| MCP → mod | `hashes` | boxes (work and context volumes) |
| mod → MCP | `hashes.result` | one hash per chunk section the box touches |
| MCP → mod | `snapshot` | boxes, or a list of chunk sections |
| mod → MCP | `snapshot.result` | palette, blocks, block entities |
| MCP → mod | `patch` | id, dimension, positions with expected states and NBT hashes, new states, NBT |
| mod → MCP | `patch.ack` | id, applied count, skipped (position, actual state, actual NBT), rejected (position, reason) |
| mod → MCP | `dirty` | changed positions, or "everything" when too many to list |
| mod → MCP | `prompt` | id, player (name and UUID), text, game context (*Prompting from the game*) |
| MCP → mod | `prompt.result` | id, delivered or refused, with the reason when refused |
| MCP → mod | `notice` | short text for the player's action bar (optional) |
| MCP → mod | `chat` | request id or none, target (one player or all with log on), kind (`activity` or `reply`), lines |

## Player feedback in-game

- Volume outlines (work, context and focus in their own colours) while the wand is held, or after `/autosketch show`; the wand's mode on the action bar.
- An action-bar line when a patch lands: `Autosketch: 1,204 placed, 3 skipped`. Toggle with `/autosketch notices on|off`.
- `/autosketch status`: link state, volumes, last patch, pending patches.

## Prompting from the game

The player can ask the agent for something without leaving the game: stand in the world, point at what they mean, and type the request. The request starts the root agent on the work volume the player set, the way a fork's handoff starts a subagent on its sandbox. The agent receives the request with enough game context that "here", "this" and "that wall" resolve to positions, and acts on the linked document as usual. Results show up in the world, and the agent's replies and a live log of what it is doing stream back into the game chat.

**In the game:**

- `/autosketch ask <text>` sends a request. The command is long on purpose so it can't clash with other mods; the config can register a short alias.
- **Focus box:** the wand's focus mode marks a focus box, the in-game counterpart of a selection. It must lie inside the work or context volume (it is clipped to them, with a warning), so it can point at something to change or at something to match. `/autosketch focus clear` removes it.
- The mod attaches the **game context** to every request: the player's position and facing, the block under the crosshair (state and the face looked at, up to a configurable reach), and the focus box if any. All world positions; the MCP converts them.
- The action bar says when the request was delivered, or why not: no link, not allowed, no agent session listening.

**In the MCP:**

- **Delivery through Claude Code channels.** The MCP server declares itself a channel and pushes each request into the running Claude Code session as a channel event, the way Claude Code's Telegram and Discord bridges do. Channels are a Claude Code feature (a research preview at the time of writing): the session must be started with the server named in `--channels`, and other MCP clients get the world link without in-game prompting. When the MCP can tell that no session will receive the event, it refuses the request so the player hears about it.
- **Context as handles, not coordinates.** Before pushing the request, the MCP converts the context to document-local coordinates and saves it on the linked document as saved selections: `focus` (the focus box) and `target` (the crosshair block), replaced by each request. The event text names them, so the agent works with `{"saved": "focus"}` rather than raw numbers (*Semantic handles over coordinates*, `ARCHITECTURE.md`). Focus and target outside both volumes are reported as outside and not saved, since the agent can't see there. In the context volume they are saved and marked read-only.
- **The event text** is short and fixed in shape, and opens with the same handoff facts a fork gives a subagent (`11`): work volume size, context volume, the scope to address. For example: `In-game request from Kev: "put a balcony here". Work volume 32×24×32, context +3 and 1 reference box (scope "base"). Looking at minecraft:oak_planks (south face), saved as "target". Focus box 5×3×2, saved as "focus". Standing at (10, 5, 8) facing north.`
- **What streams back.** The MCP never sees the agent's own text or reasoning (they live in the agent's interface), only its tool calls. So two streams go to the chat:
  - **Activity:** one compact line per tool call on the linked document as it happens (`fill: 1,204 blocks`, `render: 1 image`, `refused: lock_overlap`), and each patch result. It is built from the same event stream that feeds the viewer (`12`, `call.start`, `call.end`, `call.refused`, `doc.op`, `world.patch`), so no tool emits anything extra. Lines are shortened and coalesced, and rate-limited so a script making thousands of edits shows as one line.
  - **Replies:** `world_reply`, a tool the agent calls to answer in the chat, as Claude Code's two-way channels do. It can carry several lines, and a `done` flag that closes the request. The channel event tells the agent to answer in-game requests through it.
- **Which requests stream.** An in-game request opens a stream to the requesting player. It closes when the agent replies with `done`, or after a configurable idle time with no tool calls. `/autosketch log off|mine|all` sets what a player sees: nothing, only activity following their own requests (the default), or everything the agent does on the linked document, including work prompted from the terminal.
- **Allowed players.** A request becomes a prompt to an agent that can run commands on the user's machine, so the allowlist lives on the MCP side, not in the game: setting `world.promptPlayers` (UUIDs or names). In singleplayer the host player is allowed by default. On a dedicated server the list starts empty, and requests are refused until the user adds players. Op level 2 is required as well, like every `/autosketch` command.
- **Not in v1:** approving or denying the agent's tool use from the game. Channels can relay permission prompts, but approvals stay in the agent's interface for now.

## Companion mod requirements

| # | Requirement |
|---|-------------|
| M1 | NeoForge 1.21.1, Java (JDK 21), built from NeoForge's MDK as a `mod/` subproject. |
| M2 | Server-side only: no registered blocks, items or other registry content; clients join without it. |
| M3 | Work and context volumes: wand item marked with `custom_data` with work/context/focus modes (swap-hands key cycles), `/autosketch wand|mode|pos1|pos2|show|clear|status|notices`, `/autosketch context add|grow|clear`, a cap on context size, op level 2. |
| M4 | Sends both volumes to the MCP on change; keeps their chunks loaded with a ticket while linked. |
| M5 | Guarded patch applier: per-position expected-state and expected-NBT-hash check (volatile keys excluded), skip and report state and NBT on mismatch, reject unknown states. |
| M6 | Writes without neighbour updates, physics or drops; replaces block entities with the patch's NBT. |
| M7 | Applies patches in order under a configurable per-tick block budget. |
| M8 | Snapshots of the work and context volumes, whole or by chunk section: states and block-entity NBT. Per-section hashes on request. |
| M9 | Change tracker: reports changes inside the work or context volume that aren't its own patch writes, from any source (players, Axiom, pistons, explosions, fluids). Ignores everything outside both. |
| M10 | Localhost socket with token pairing through `config/autosketch-bridge.toml`; version check in hello; survives MCP restarts. |
| M11 | Action-bar notices and outline particles, toggleable. |
| M12 | Leaves entities alone. |
| M13 | `/autosketch ask <text>` (with an optional configured alias) and `/autosketch focus clear`; focus box set in the wand's focus mode, clipped to the work and context volumes; game context (position, facing, crosshair block and face, focus box) attached to each `prompt`; delivery result on the action bar; `chat` lines shown to their target, styled by kind; `/autosketch log off|mine|all`. |

## MCP requirements

| # | Requirement |
|---|-------------|
| W1 | Bridge client: connect, pair with the token from the instance config, reconnect, version check; a clear error naming WSL mirrored networking when the port can't be reached. |
| W2 | Link the base document as the root scope (`doc_open({ world: true })` or similar): the player's work and context volumes, re-origined to the work volume's minimum corner, whole-block extension, the sandbox write rule (`outside_work_volume`) and context ghosting reused from `11`, fresh journal on a new work volume, context-only changes synced without relinking. |
| W3 | Patch sender subscribed to the journal's event stream; one patch per committed entry on the linked document (one per `restore`), carrying expected states and NBT hashes. |
| W4 | Ack handling: skipped and rejected positions written back into the cache as a `world_sync` entry, and summarized in a tool result. |
| W5 | `world_sync` tool and automatic sync before a tool call when the volumes are dirty; section-hash comparison so only differing sections are snapshotted; journaled, pushes nothing, keeps metadata, reports component drift. |
| W6 | Sync barrier for undo, redo and restore through `Document.guard`; `overwriteHandEdits` to cross it and to force one patch. |
| W7 | Scope merges as one guarded patch; merge check relaxed for positions changed by syncs, listed in the report. |
| W8 | Events for the viewer (`12`): `world.link`, `world.patch` (with ack counts), `world.sync`. |
| W9 | A fake in-game host implementing the protocol in TypeScript, for unit tests of the guard, sync, barrier, merge and reconnect paths without a running game. |
| W10 | Canonical NBT hashing and section hashing identical to the mod's, with the volatile-key list (built-in default plus plugin entries) sent in `hello`. |
| W11 | In-game requests: declared as a Claude Code channel; allowlist (`world.promptPlayers`); context converted to local coordinates and saved as the `focus` and `target` selections; one channel event per request, opening with the handoff facts; `prompt.result` back to the mod; activity stream from the event feed (coalesced, rate-limited) and the `world_reply` tool, sent as `chat`; request streams closed by `done` or idle time. |

## Implementation status

Not started. Work is split into silos in `docs/briefs/world/`. Suggested order: protocol, hashing and fake host (W9, W10), then the MCP side (W1–W8, W11) tested against the fake host, then the mod (M1–M13), then end-to-end tests in a Craftoria save.

## Open questions

- **Throughput.** How many blocks per tick can the mod apply without visible lag, and what default budget does that suggest? Measure on a Craftoria save with a large stamp.
- **Change tracking.** Catching every change source (M9), including Axiom's, probably needs a mixin on chunk block-state writes. Is its per-write cost acceptable, and does it hold up with Craftoria's other mods? Fallback: the mod compares its own section hashes periodically and reports the sections that changed as dirty.
- **Snapshot cost** for large volumes. Full snapshots happen only on link, relink and added context; reconnects and "everything" dirty notices re-read only the sections whose hashes differ. How large can the volumes get before that's impractical, what should the context cap default to, and how long does hashing every section take?
- **Volatile keys.** Which NBT keys change on their own in Craftoria's block entities (Create, storage mods, machines)? Too few on the list means false "hand-edited" skips; too many means missed contents edits. Measure the false-skip rate on a running Craftoria base and grow the default list from it.
- **Channel availability.** Channels are a Claude Code research preview. Can the MCP reliably tell whether a session will receive an event (from the client's capabilities at initialize, or otherwise), and what should other clients get instead? A later option is an Agent SDK host that runs requests without a terminal session.
- **The agent's own text.** Streaming the agent's full response, not just what it sends through `world_reply`, would need something outside the MCP, such as a Claude Code hook that forwards each finished turn. Worth it?
- **Permission relay.** Should the requesting player be able to approve the agent's tool use from the game?
- **Remote servers.** Out of scope for now: the MCP runs on the game's machine. Later: on a multiplayer server the mod runs on the server's machine. Does the MCP reach it through a port opened beyond localhost (with the token), a tunnel, or by running beside the server?

## Decisions

Settled with the user on 2026-11-08:

- **The player's volumes are the root scope** (*Model*, *Scoped sessions*). The player sets a work volume and a context volume in-game, exactly the volumes `11` gives a sandbox, and the linked document is the root of the scope tree. Reason: one model from the world down to the deepest sandbox; the player delegates to the root agent the way an agent delegates to a subagent, and the same write rules, ghosting and nesting apply.
- **The volumes bound everything.** The agent writes only inside the work volume; the link watches only the two volumes, and player edits outside them are ignored. Reason: the work volume is the contract between player and agent, and the context volume is what the player chose to show.
- **A new work volume starts a fresh journal** (*Work and context volumes in-game*). Reason: re-origining makes the old expected states meaningless, so undoing past a relink could only ever be wrong.
- **Expected NBT as a hash** (*Agent → world*). Reason: it closes the "contents changed, block didn't" gap at the cost of a few bytes per block entity, instead of sending whole NBT compounds in every patch. Section hashes reuse the same canonical form to make reconnects cheap.
- **No `/autosketch undo`.** The player asks the agent to undo, so there is one history with one owner.
- **`restore` reaches the world as one patch**, even though `Document.restore` steps entry by entry.
- **The player can prompt the agent from the game, with game context** (*Prompting from the game*). Reason: pointing at the thing is faster and less ambiguous than describing coordinates in a terminal. It is a request channel with game context, with the agent's activity and replies streamed back to the chat; it is not a second command set that runs tools without the agent.
