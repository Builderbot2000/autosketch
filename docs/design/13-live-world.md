# 13 — Live World Link

Lets the agent build directly in the world the player has loaded, while the player keeps placing and tweaking blocks by hand. The agent's edits appear in the world op by op, and the player's hand edits reach the agent automatically. Nobody carries schematic files back and forth or types commands per action.

> **Changes coming from `16`** (2026-11-17): the whole mod locks while the MCP is offline (the wand and volume commands included), and the mod's client half gains the in-game UI over this protocol (feature `ui`). The sections below describe the mod as built until those land.

Two pieces make it work: a **companion mod** in the game, and a **world link** in the MCP server that connects a document to part of the loaded world. The player marks that part in-game as a **work volume** and a **context volume**, the same two volumes a sandbox has (`11`): the linked document is the root scope of the session, and the player sets its volumes the way a parent agent sets a subagent's. The player then asks the agent for work from inside the game, pointing at what they mean (*Prompting from the game*), which starts the root agent on that work volume.

## Principles

- **The world is authoritative; the document is a cache.** The MCP keeps a local copy of the work and context volumes because every tool (selections, perception, scripts, scopes, the journal) runs on the in-memory document, and a block-by-block round trip to the game per query would be far too slow. The copy never wins a disagreement: whenever world and cache differ, the world's value replaces the cache's.
- **The toolset doesn't change.** Tools keep acting on the document. The link sits beside it: it turns committed journal entries into patches for the world and brings world changes into the cache. No tool knows whether its document is linked.
- **One scope model, from the world down.** The player-set volumes are a scope like any sandbox (`11`): the agent writes only inside the work volume, reads the context volume, and everything the link watches lies inside the two. Player edits outside both volumes are none of the link's business. Subagents fork from the root scope exactly as they fork from any base document.
- **Never destroy a hand edit silently.** Every block the MCP sends carries the state it expects to replace (and, for blocks with a block entity, a hash of the NBT it expects). The mod only writes where the world still holds that state (a per-block **compare-and-set**, with the expected state as the **precondition**), and reports every block it skipped. Overwriting hand edits always needs an explicit request. This is the "strictly non-destructive" condition `12` set for writing into a live world.
- **No new content; the client half is optional.** The mod registers no blocks or items. One jar runs on the server, which in singleplayer is the game's own built-in server, and it can also run in the client for input and display the server can't see (B2). A client without it still joins a dedicated server and loses only those extras.
- **The same engine for both workflows.** An unlinked document is just a schematic, exactly as before. The link is an attachment, not a different kind of document.

## Model

```
   MCP server (Node)                                   Minecraft (JVM)
┌──────────────────────────────┐                    ┌───────────────────────────┐
│ tools ──► Document (cache) ──┼─ journal entry ──► │                           │
│              ▲  journal      │    = patch          │  companion mod            │
│              │               │  ◄── ack ───────── │   · CAS patch applier     │
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

- **Wand:** any stack of the configured item (`wandItem`, default `minecraft:blaze_rod`: not a wooden axe, to avoid clashing with Axiom or WorldEdit), held in the main hand by an op, as WorldEdit's wand is any wooden axe (B1). There is no marker and no command to hand it out. Both clicks are cancelled, so the rod never opens or uses the block it clicks. The wand has three modes: **work**, **context** and **focus** (*Prompting from the game*). Left-click a block sets corner 1 and right-click sets corner 2 of the current mode's box. Pressing the swap-hands key while holding the wand cycles the mode, and `/autosketch mode work|context|focus` sets it. The action bar shows the mode, and each mode's outline has its own particle colour.
- **Air mode** (B2, per player, `/autosketch air on|off`): a click into the air sets the corner at the block `/autosketch air reach <n>` blocks (default 5, at most 64) along the look vector. Right click into the air sets corner 2 and sneak+right click corner 1; with the client half, a left click into the air sets corner 1 and sneak+scroll sets the distance.
- **Commands:** `/autosketch pos1`, `pos2` (at the player's feet, or given coordinates, for the current mode), `show` (outline all volumes), `clear` (remove the work volume, which unlinks).
- **Context commands:** `/autosketch context add` (add the box just marked in context mode), `context grow <n>` (the work volume grown by `n`, replacing the boxes), `context clear` (back to the default). A configurable cap on total context volume keeps snapshots practical.
- The mod sends both volumes to the MCP whenever either changes.
- **One set of volumes per server; wand state per player.** The work and context volumes are global: every op marks and sees the same ones, and whoever marks a work volume relinks it for everyone. The wand's mode and the corners marked but not yet complete are per player. Reason: the MCP links one document to one work volume (*Model*), so per-player volumes would need a choice of whose volumes the link follows; a single set is the honest model, and two ops marking corners each keep their own half-finished box until it completes. The volumes aren't saved with the world: they last until the server stops or a player clears them, across MCP reconnects.
- **A new work volume relinks and starts a fresh journal.** The new work volume re-origins the document, and the expected states recorded against the old frame mean nothing in the new one, so the history before a relink can't be undone. The cache is replaced by a snapshot of the new volumes. Saved selections, palettes and checkpoints are kept; old checkpoints can no longer be restored and say so when tried.
- **A context change alone doesn't relink.** The frame stays, the journal stays, and the MCP snapshots the added context and clears the removed context in one `world_sync` entry.
- While linked, the mod keeps the chunks under both volumes loaded (a chunk ticket) so patches and snapshots never hit unloaded chunks. The ticket is released on unlink or disconnect.

## Agent → world: patches

Every committed journal entry on the linked document becomes one patch. That covers ops, brushes, transforms, stamps, scripts, plugin actions, scope merges, undo, redo and restore. The link subscribes to the same per-op stream that feeds the observe viewer (`doc.op`, `doc.undo`, `doc.redo` through `EventSink`, `core/events.ts`), so no tool or op calls it directly.

**Patch contents:** an id, the dimension, and for each changed position: the world position, the **expected** state (the entry's before-state), the **expected NBT hash** when the before-block has a block entity, the new state, and block-entity NBT when the new block has any. States are full block-state strings with properties, exactly as the document holds them. Connection properties are already derived by the ops (`ops/connect.ts`), so the mod writes states as given.

**Expected NBT hash.** A short hash of the block entity's NBT the cache holds, so the precondition notices a hand edit that changed only a block's contents (a chest's items, a sign's text) without sending the whole expected NBT. Both sides hash the same canonical form: compound keys sorted recursively, binary NBT, then the hash *Wire format* names. The form leaves out position keys (`x`, `y`, `z`) and **volatile keys**: NBT that changes on its own while the game runs, such as a furnace's burn time, a hopper's cooldown or a Create machine's kinetic speed. Without that, a ticking block would look hand-edited forever. Volatile keys come from a list: a built-in default plus per-block entries plugins can add (`09`), and blocks can be marked "state only" so their NBT is never compared. The list lives on the MCP side and travels in `hello`, so the mod hashes the same way.

**The mod applies a patch by these rules:**

- **Precondition (compare-and-set):** for each position, compare the world's current state with the expected one and, when the patch carries an expected NBT hash, the hash of the world's block entity with it. If both match, write the new state. If not, skip it and record the world's actual state and, when it has one, its block-entity NBT.
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
- **Automatic.** The MCP can't see user prompts, only tool calls, so "sync at the start of each turn" is implemented as: the mod tracks every block change inside the work or context volume that isn't one of its own patch writes (including Axiom edits, pistons, explosions, fluids), and reports the volumes dirty. Changes outside both volumes are ignored and never reported. Before running the next tool call on the linked document, the MCP syncs if the volumes are dirty. Dirty notices may carry the changed positions, so small hand edits sync without a snapshot. Contents-only changes (a chest's items) don't change block states, so the tracker doesn't see them; the NBT hash in the patch precondition catches them when the agent next writes that block, and the next section-hash comparison catches them otherwise.
- **Section hashes instead of full snapshots.** Both sides can hash the volumes per 16×16×16 chunk section: every position's canonical state and NBT hash, in a fixed order. When the MCP needs to know how far the cache has drifted (on reconnect, or after an "everything" dirty notice), it asks for the section hashes, compares them with its own, and snapshots only the sections that differ. A full snapshot of every section remains for linking, relinking and newly added context, when there is no cache to compare.
- **Manual.** `world_sync` is also a tool the agent (or the player through the agent) can call at any time.

## World undo and restore

The world has no undo history of its own, so the journal provides it.

- **Undo and redo** produce journal entries like any op, and so become conditional patches. Expected states are the cache's current states, so a block the player changed after the last sync is skipped and reported.
- **Sync barrier.** Undo and redo stop at a `world_sync` entry that changed blocks: going past it would push the pre-sync cache into the world and erase the player's hand edits. The refusal says so. `overwriteHandEdits: true` crosses the barrier.
- **Restore to a checkpoint** pushes the difference between the cache and the checkpoint to the world as one conditional patch. If the path back crosses a sync barrier, it is refused the same way unless `overwriteHandEdits: true` is passed. It stays all or nothing in the cache, as in `11` (*Locks also guard undo and redo*): every step is checked before any is applied.
- **`overwriteHandEdits: true`** also turns off the patch precondition for that one patch, so the world is forced to the target state. The agent passes it only when the player has asked to discard their hand edits. The result reports how many hand-edited blocks were overwritten.
- The barrier is enforced through `Document.guard` (`11`, *Implementation status*), so tools, scripts and history all obey it the same way they obey locks.
- **A sync discards the redo tail**, as any edit does (resolved). Acks and dirty notices arrive between tool calls, so a `world_sync` entry can commit while the agent has undone ops. Keeping the redo tail would mean redoing entries whose before-states no longer match the cache, and redoing past the world's change is exactly what the barrier exists to stop. A sync that changes nothing adds no entry and keeps the redo tail. **The exception is an ack's normalized list**: the game rewriting NBT the patch itself just wrote reconciles the cache with our own write, not a change in the world. If it dropped the redo tail, every undo that touches a block entity would break redo. So ack handling passes `reconcile: true`, and the normalized NBT is taken into the cache in place, with no journal entry: every in-memory entry that recorded the sent compound at that position now records the world's form. The redo tail survives, no barrier appears, and later undo and redo write the normalized NBT. Entries already written to on-disk segments keep the sent form, and the next patch's ack reconciles them again. The ack's skipped blocks are hand edits, so they still commit one `world_sync` entry and drop the redo tail.

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

- **Sandboxes are unchanged** (`11`): unlinked sub-documents, so subagents draft privately and nothing reaches the world until merge. Their volumes must lie inside the root's volumes, as for any nested fork. The merge is one journal entry on the root, and therefore one conditional patch. The ratio limit for a fork from the root measures against the root's work volume.
- **The root's volumes aren't a lock**, because the player who set them is not bound by locks. Agents' locks inside the root work as in `11`.
- **The player is a writer who ignores locks.** A hand edit inside a locked work volume reaches the root through a sync, which is allowed: the world is authoritative. That breaks the merge's "parent unchanged since fork" check, so with a link the check is relaxed for positions changed by `world_sync` entries: the merge still applies, but it doesn't write those positions, so the world's block stays in both the cache and the world. The merge report lists them. (Sending them through the patch precondition wouldn't protect them: the merge's expected state would be the cache's, which already holds the synced hand edit, so the precondition would pass and the hand edit would be overwritten.)

## Connection

- **Same machine only.** The MCP runs on the machine the game (or dedicated server) runs on. Remote servers are out of scope for now (see *Open questions*). Running the game on Windows and the MCP in WSL2 counts as the same machine: WSL2 reaches the mod's loopback socket with mirrored networking (`networkingMode=mirrored` in `%UserProfile%\.wslconfig`). Without it, the MCP reports that the port in the pairing file can't be reached and names the setting.
- **Transport:** a localhost TCP socket opened by the mod, length-prefixed messages. JSON for control messages; patch and snapshot bodies use a compact binary encoding (palette plus packed positions), since a large stamp can carry millions of blocks.
- **Pairing:** the mod writes its port and a random token to `<instance>/config/autosketch-bridge.toml` on startup. The MCP already locates the instance (`02`), reads the file, and sends the token in its hello. A connection without the right token is refused.
- **Version check:** hellos carry the protocol version, the game version and data version, and the mod version. The MCP speaks its own protocol version and the one before it, and gates every addition on what the hellos list (*Wire format*, *Versions and features*). Any other mismatch is reported, saying which side is older, not guessed around.
- **Lifecycle:** the MCP reconnects when the game restarts, and the link resumes with a sync of the sections whose hashes differ (a full snapshot if the work volume changed meanwhile, which is a relink). Patches queued while disconnected are discarded, not replayed: the next sync makes the cache match the world, and the agent sees the result.
- **Permissions:** commands and the wand require op level 2 (cheats on, in singleplayer).
- **Automatic linking** (setting `world.autoLink`, default on): once the instance is loaded, the MCP keeps trying to connect (every 2 s, quietly, until the game is up; the bridge's own reconnect takes over after the first connection). Whenever the player has a work volume and nothing is linked, it links the base document as `doc_open({ world: true })` would, and the agent's next result on it carries a `world: linked automatically` line. It doesn't do this on its own while scoped jobs are open, or over an open document that isn't a world document (`meta.source` `world:…`), so it never takes the agent's work away. An in-game request arriving unlinked links even over another document (it is saved and closed, and the agent is told), because the player asking is the signal; it still waits for scoped jobs. Clearing the work volume unlinks as before, and the next work volume links again. Reason: a player marking a work volume in the game has already said what to link; requiring the agent to call `doc_open` first made every first request fail with `no_link`. `doc_open({ world: true })` stays for explicit links, a document name, and relinking after scoped jobs.

### Messages

| Direction | Message | Contents |
|-----------|---------|----------|
| both | `hello` | protocol version, token, volatile-key list, request modes and features (MCP → mod), game/data/mod versions and features (mod → MCP) |
| mod → MCP | `volumes` | dimension, work volume box, context boxes, or none (on change and after hello) |
| MCP → mod | `volumes.extend` | link, the work volume extended to whole blocks (*Model*: a box that cuts a door or multi-block) |
| MCP → mod | `volumes.set` | dimension, work volume, context boxes or the default: the mod sets them as if the player had (B4) |
| MCP → mod | `hashes` | boxes (work and context volumes) |
| mod → MCP | `hashes.result` | one hash per chunk section the box touches |
| MCP → mod | `snapshot` | boxes, or a list of chunk sections; or, kind `surface`, an area of columns (B4) |
| mod → MCP | `snapshot.result` | palette, blocks, block entities; or per column the topmost non-air block (and ceiling) |
| MCP → mod | `patch` | id, dimension, positions with expected states and NBT hashes, new states, NBT |
| mod → MCP | `patch.ack` | id, applied count, skipped (position, actual state, actual NBT), rejected (position, reason) |
| mod → MCP | `dirty` | changed positions, or "everything" when too many to list |
| mod → MCP | `prompt` | id, player (name and UUID), text, game context (*Prompting from the game*), mode (B6), scan grant (B4) |
| MCP → mod | `prompt.result` | id, delivered or refused, with the reason when refused |
| mod → MCP | `prompt.close` | player: `/autosketch done`, ending the open read-only request (B6; MCP feature `prompt.close`) |
| MCP → mod | `notice` | short text for the player's action bar (optional) |
| MCP → mod | `chat` | request id or none, target (one player or all with log on), kind (`activity` or `reply`), lines |
| MCP → mod | `registry` | the hash of the report the MCP holds, if any (protocol 3) |
| mod → MCP | `registry.result` | the registry report (`14`), or `unchanged` |
| MCP → mod | `upgrade` | a schematic's data and its DataVersion: palette states, block-entity and entity NBT, or a whole structure (protocol 3) |
| mod → MCP | `upgrade.result` | the same data through the game's data fixer, at the running DataVersion |

Field names, types and encodings are in *Wire format*, *Message schemas*.

## Wire format

Protocol version **3** (*Versions and features*: the MCP also speaks version 2; the version-2 contract is this section without the additions marked "protocol 3", and its vectors are in `test/data/world-protocol/v2/`; version 1, no longer spoken, is that without the "protocol 2" additions too, in `v1/`). This section and the golden vectors in `test/data/world-protocol/` are the whole contract between the mod and the MCP: either side can be written from them alone. The TypeScript reference is `src/world/protocol/` (codec, hashing, pairing file) and `test/support/fake-host.ts` (the mod's side, in memory), but nothing here needs them.

### Primitives

- **Byte order** is big-endian everywhere (as `DataOutputStream` writes).
- **u32** is an unsigned 32-bit integer, 4 bytes.
- **varint** is an unsigned LEB128 integer: 7 bits per byte, low group first, high bit set on every byte but the last (the same encoding as Minecraft's `FriendlyByteBuf.writeVarInt`, but unsigned and wider). Values are 0 to 2^53 − 1, so a varint is at most 8 bytes. Encodings are minimal: a last byte of `0x00` after a continuation byte is an error. In Java, read and write them as `long`.
- **string** (in binary bodies) is a varint byte length, then the bytes in standard UTF-8 (`StandardCharsets.UTF_8`).
- **table** is a varint count, then that many strings.
- **JSON** is RFC 8259, UTF-8. All integers in headers fit in ±2^53. Non-integer numbers appear only in `prompt` (position, eye, yaw, pitch).
- **Box** in JSON is `{"min":[x,y,z],"max":[x,y,z]}`: an inclusive box in world coordinates (`01`), with `min ≤ max` on every axis. Senders normalise; a receiver rejects an unnormalised box.
- **Section** is a 16×16×16 chunk section, named by section coordinates `[sx,sy,sz]` = `[x >> 4, y >> 4, z >> 4]` (arithmetic shift, so −1 is in section −1). Its box is `16·s … 16·s + 15` on each axis.
- **Hash** is a 64-bit value: the first 8 bytes of a SHA-256 digest. In JSON it is 16 lowercase hex digits; in a binary body it is the 8 bytes, in digest order.
- **UUID** is lowercase and hyphenated (`3f2504e0-4f89-41d3-9a0c-0305e82c3301`), as `UUID.toString()` prints it.
- **Dimension** is a resource location: `minecraft:overworld`, `minecraft:the_nether`, a mod's id.

### Framing

The mod listens on a TCP socket on `127.0.0.1`. Each message is one frame:

```
u32      frameLength     bytes that follow this field (≥ 4)
u32      headerLength    bytes of the JSON header (≤ frameLength − 4, ≤ 1 MiB)
bytes    header          a JSON object, UTF-8, with a "type" field
bytes    body            frameLength − 4 − headerLength bytes; empty unless the message has a body
```

- **Maximum frame size:** `frameLength` ≤ 268,435,456 (256 MiB). A sender never writes a larger frame.
- **Undecodable messages.** If the framing or the header can't be decoded (a `frameLength` below 4 or above the maximum, a `headerLength` that doesn't fit, a header that isn't UTF-8 JSON or isn't an object), the receiver sends `error` `bad_request` with id `null` and closes the connection: it can no longer tell where the next frame starts, or whom to answer. If the frame and header decode and the header has an `id`, but a field or the body is invalid (a missing or mistyped field, a body on a message that has none, a count that disagrees with the body, a bad NBT compound), it replies `error` `bad_request` with that `id` and the connection stays open. An invalid message without an `id` is answered with `bad_request` id `null`, and the connection stays open too.
- **Messages with a body:** `patch`, `snapshot.result`, `patch.ack` and `dirty` (unless `everything`); protocol 3 adds `registry.result` (unless `unchanged`), `upgrade` and `upgrade.result`. Every other message has an empty body.
- **Headers** are written compact (no whitespace), keys in the order the tables below list them, optional fields omitted when absent. Receivers accept any key order and ignore keys they don't know (so an addition stays readable by the previous version, *Versions and features*). Compare headers as JSON values, not as bytes: number formatting differs between JSON libraries.
- **Ordering:** TCP keeps frames in order. Each side sends messages in the order the events happen. The mod handles **requests** (MCP messages with an `id`: `volumes.extend`, `volumes.set`, `hashes`, `snapshot`, `patch`, and in protocol 3 `registry` and `upgrade`) strictly in arrival order, each finishing before the next starts: a `snapshot` or `hashes` request that arrives while a patch is still applying across ticks is answered after that patch's ack, so it sees the patch. Messages without an `id` (`notice`, `chat`, `prompt.result`, `error`) don't wait behind a multi-tick patch; the mod may handle them as they arrive. From the mod, `dirty`, `volumes`, `prompt` and `prompt.close` may interleave with responses.
- **Request ids:** `volumes.extend`, `volumes.set`, `hashes`, `snapshot` and `patch` carry an `id` the MCP assigns from one counter per connection, starting at 1 and increasing by at least 1 per request (so patch ids increase, and patches apply in id order). Their responses (`hashes.result`, `snapshot.result`, `patch.ack`, `registry.result`, `upgrade.result`, or `error`) carry the same `id`. A `volumes.extend` that succeeds is answered by a `volumes` message (which has no id), and one that fails by an `error` with its id. A `volumes.set` that succeeds is answered by a `volumes` message carrying its `id` (protocol 2), and one that fails by an `error` with its id. `prompt` ids come from the mod's own counter; a `prompt.result` carries the prompt's id in its `id` field, and a `chat` carries it in its `request` field.

### Connection and handshake

1. The mod starts listening when the server starts (singleplayer: when the world opens; dedicated: at startup), on the configured port or an ephemeral one, bound to `127.0.0.1` only, and writes the pairing file. It deletes the file when the server stops.
2. The MCP reads the pairing file, connects to `host:port` and sends `hello` with the token, its volatile-key list, its request modes and its features. Its `protocol` is the pairing file's when the MCP speaks that version (its own or the one before), and its own otherwise, so that the mod refuses it in step 3 and can tell the player which side is older (*Versions and features*).
3. The mod checks, in order: the first frame is a `hello` (else `error` `not_ready`, close); `protocol` equals its own (else `error` `protocol_mismatch` carrying its own version in `protocol`, close, and an action-bar notice to ops naming the older side: the hello's `protocol` lower than the mod's means the MCP is older, higher means the mod is); `token` equals its token, compared in constant time (else `error` `bad_token`, close). The handshake must finish within 10 seconds of connecting, or the mod closes the socket.
4. The mod replies with its own `hello`, then immediately sends `volumes`.
5. The MCP checks the mod's `hello`: on a `protocol` other than the one it sent it reports the mismatch to the agent, naming the older side and what to update, and closes. It never guesses around a mismatch (*Version check*). A `protocol_mismatch` naming a version the MCP speaks means the pairing file was stale (the game restarted with another mod), so the MCP retries instead of reporting. The `game.dataVersion` is the MCP's to compare with its documents.
6. **One connection at a time.** When a new connection completes the handshake, the mod sends `error` `replaced` to the old one and closes it. A restarted MCP therefore takes over without waiting for the old socket to time out (M10).
7. **Disconnect.** Either side may close at any time. The mod discards queued patches it hasn't started and finishes the one in progress (its ack is lost; the next sync reconciles). It keeps the volumes of the current link until the server stops or the player clears the work volume, so a reconnecting MCP finds the same volumes. It releases the chunk tickets on disconnect and takes them again on reconnect (*Model*), so an unattended server doesn't keep chunks loaded.

The framing, the `hello` fields `type`, `protocol` and `token`, and the `error` message keep their meaning in every future protocol version, so a mismatch is always reported clearly.

### Versions and features

Settled in `14` (*Version skew between mod and MCP*): the mod and the MCP release separately, so updating either side first must not break a working setup.

- **The mod speaks one version**, its own, written in the pairing file. **The MCP speaks two:** its own (`N`, now 3) and the one before (`N−1`, now 2). It says hello in the mod's version when it speaks it. Otherwise it says hello in its own, the mod refuses it (`protocol_mismatch`), and both sides say which one is older and what to update: the MCP in the tool result (`The mod speaks bridge protocol 4 and this Autosketch speaks 2 and 3: the Autosketch MCP server is older; update the Autosketch MCP server.`), the mod on the action bar.
- **Every addition is optional on the wire.** A field added in version `N` is omitted by a version-`N−1` sender and ignored by a version-`N−1` receiver, and a message type added in `N` is never sent to a side that doesn't list it. So one codec reads both versions, and the version-2 (and version-1) vectors round-trip through the version-3 codec unchanged.
- **Features gate on the hellos, never on version numbers.** The MCP uses an addition only when the mod's `hello` lists it in `features`; the mod sends a request mode only when the MCP's `hello` lists it in `modes`, and uses an addition of the MCP's only when the MCP's `hello` lists it in its own `features`. A mod that leaves a feature out (an older build, a port to another loader) is treated, for that feature, exactly like a mod of the version before it, and likewise an MCP.
- **An addition gated by a feature needs no version bump.** Both sides ignore keys they don't know and never send a message type the other side's hello doesn't list, so a feature can be added within a version: `prompt.close` was added to version 3 this way (below).
- **Mod features** (protocols 2 and 3; receivers ignore names they don't know):

  | Feature | The mod |
  |---|---|
  | `modes` | sends `mode` on every `prompt`, and only modes the MCP's hello lists; refuses any other request itself with `unsupported_mode` on the action bar (B6) |
  | `scan` | sends the `scan` grant on scan prompts, serves `snapshot` kind `surface`, and serves blocks snapshots inside the grant (B4) |
  | `volumes.set` | accepts `volumes.set` |
  | `registry` | protocol 3: serves `registry` with the registry report (`14`, *Version-specific data lives in the mod*) |
  | `upgrade` | protocol 3: serves `upgrade` through the game's data fixer (`14`, *Schematics from other versions*) |

- **MCP features** (in the MCP's `hello`, within protocol 3; the mod ignores names it doesn't know):

  | Feature | The MCP |
  |---|---|
  | `prompt.close` | handles `prompt.close` (`/autosketch done`, B6): ends the open read-only request and answers with a `notice` to that player |

- **Without an MCP feature**, the mod: without `prompt.close` it refuses `/autosketch done` itself, telling the player on the action bar that the Autosketch MCP server is too old for it (a new request still ends the open one), and sends nothing.
- **Without a feature**, the MCP: treats a `prompt` without `mode` as `build` (what `/autosketch ask` meant in version 1); refuses tools that need `scan` or `volumes.set` with `world_mod_outdated`, saying the mod is older and to update it, without sending anything; without `registry` it keeps the report file read at startup (or none); without `upgrade`, imports fall back to the rename table with a partial-upgrade warning (`08`, *Import*).
- **What changed from version 1 to 2:** `hello` (MCP) gained `modes`, `hello` (mod) gained `features`; `prompt` gained `mode` and `scan`; `prompt.result` gained the reason `unsupported_mode`; `snapshot` and `snapshot.result` gained the kind `surface`; `volumes` gained `id`; the message `volumes.set` and the error `bad_volumes` are new. Nothing was removed or changed in meaning.
- **What changed from version 2 to 3:** the features `registry` and `upgrade` and their four messages are new. Nothing else changed: the protocol-2 vectors that differ are the hellos (their `protocol`, and the new features in the mod's list) and the mismatch example.
- **Added within version 3** (feature-gated, no bump; settled with the user 2026-11-16, B6): `hello` (MCP) gained `features`, and the message `prompt.close` is new. An MCP from before sends no `features`, so the mod never sends it `prompt.close`; a mod from before never sends one and ignores the key. The current vectors that changed are `hello-mcp` (it lists the feature); `prompt-close` and `notice-prompt-closed` are new.

### Pairing file

`<instance>/config/autosketch-bridge.toml`, where `<instance>` is the game directory (the server directory for a dedicated server). The mod writes it atomically (a temporary file, then a rename) and deletes it on server stop. A new token and, unless the port is configured, a new port on every start.

```toml
# Autosketch bridge pairing file. Written by the mod when the server starts, deleted when it stops.
# Do not edit. The token lets a local Autosketch MCP server connect to this game.
protocol = 1
host = "127.0.0.1"
port = 52817
token = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
pid = 18320
started = "2026-11-08T10:15:30Z"
```

| Key | Type | Meaning |
|---|---|---|
| `protocol` | integer | The mod's protocol version. The MCP says hello in it when it speaks it (*Versions and features*); otherwise the handshake fails and both sides say which one to update. |
| `host` | string | Always `127.0.0.1` in v1 (*Same machine only*). |
| `port` | integer | The listening TCP port. |
| `token` | string | 32 bytes from `SecureRandom`, as 64 lowercase hex digits. |
| `pid` | integer, optional | The game's process id, for diagnostics. |
| `started` | string, optional | ISO-8601 UTC time the server started, for diagnostics. |

The file is a strict TOML subset: one `key = value` per line, values are integers or double-quoted strings with no escapes, `#` starts a comment line, blank lines are allowed. The MCP requires the first four keys and ignores any others. The mod's own settings (port, tick budget, context cap, alias) live in its NeoForge config, not in this file.

### Block states

Every block state on the wire, in either direction, is in this **canonical form**:

```
namespace:path[name=value,name=value,...]
```

- The namespace is always present (`minecraft:stone`, never `stone`).
- Every property the block's state definition has is present, with its value as the game names it (`Property.getName(value)`), sorted by property name in ascending code-point order. No whitespace. A block without properties has no brackets.
- `minecraft:cave_air` and `minecraft:void_air` are written as `minecraft:air`, on output and when comparing.

The mod **prints** a world state this way (`BuiltInRegistries.BLOCK.getKey(block)`, then the sorted properties). It **compares** an expected state with the world by printing the world's state and comparing strings exactly. It **accepts** a new state only if the string is exactly the canonical printing of some state the game knows: an unknown block, an unknown property or value, a missing property, wrong order or stray whitespace all reject that position as `unknown_state`, and the mod never substitutes air or a default. The MCP never sends anything but this form; with a registry, the document's states already are (`core/blockstate.ts`, `01`).

### NBT

Block-entity NBT travels as **binary NBT**, uncompressed and big-endian, as `NbtIo.write(CompoundTag, DataOutput)` writes it: tag id `0x0A`, an empty name (u16 `0x0000`), the compound payload. Strings inside NBT (keys and string tags) are in Java's modified UTF-8 (`DataOutput.writeUTF`), unlike body strings. Two rules make the bytes deterministic, so both sides produce identical frames:

- **Compound keys are written sorted**, recursively (including compounds inside lists), in UTF-16 code-unit order (Java's `String.compareTo`). `CompoundTag` iterates a `HashMap`, so the mod writes NBT with its own small writer rather than `NbtIo` (it needs that writer for hashing anyway). Readers accept any order.
- **Empty lists** are written with element type End (`0x00`), as the game writes them.

**Limits and reader rules**, the same on both sides:

- A string (key or value) is at most 65,535 bytes of modified UTF-8, the game's own limit (`writeUTF`'s u16 length). It can't be written: the TypeScript encoder refuses it with an error naming the length, and the mod rejects it (a patch NBT it can't load is `bad_nbt`; a world block entity it can't encode fails the request with `internal`).
- A compound with the same key twice is invalid (`bad_request`, or `bad_nbt` for a patch's new NBT).
- A non-empty list of element type End is invalid.
- An empty list of any element type is accepted, and re-encoded with type End.
- Nesting is limited to 512 levels, as in the game.

**What the compound holds:** the block entity as `BlockEntity.saveWithId(registries)` saves it, so it carries `id` (the block-entity type) and its data, but **without the top-level `x`, `y`, `z`**: the position is given by the message. This is the document's own representation of block-entity NBT (`04`). When the mod writes NBT from a patch, it loads it at the patch position (`BlockEntity.loadStatic(pos, state, tag, registries)`). Nothing is stripped other than `x`, `y`, `z`: volatile keys travel and are kept, and only hashing ignores them. NeoForge may add its own keys when saving (data attachments, under `neoforge:attachments`); they travel like any other key, and silo R's volatile-key measurements should check whether any of them change on their own.

In a body, each NBT compound is preceded by its varint byte length, so a reader can slice it out without parsing.

### Binary bodies

**Positions** in bodies are relative, never world coordinates: the header gives an `origin` (world position) and a `size` `[sx,sy,sz]`, the bounding box of every position the message lists, and each position is the linear index

```
index = dx + sx · (dz + sz · dy)        (dx, dy, dz) = position − origin
```

that is x fastest, then z, then y, the order of chunk sections, Litematica and `.bp` (`08`). A list of positions is written in ascending index order, each as a varint **gap** = index − previous index − 1, with the previous index starting at −1. Positions in one list are unique. When a message lists no positions, `origin` and `size` are `[0,0,0]`.

- **Why relative:** offsets inside a small grid make short varints (a dense fill is one `0x00` byte per position), and an explicit origin in each message makes it self-contained: it never depends on the link's current volumes, which the player can change while a patch is in flight. **Why the tight bounding box** rather than the work volume's corner: the encoding then needs no link state at all, and both sides compute the same grid, so frames are byte-identical.
- **Ordinals:** NBT lists and hash lists refer to entries of a position list by ordinal (0-based position in the ascending list), gap-coded the same way.
- **Palettes** are tables of canonical state strings in **first-use order**: the order in which the encoder first meets each string while writing the message's entries in order (for a patch, each entry's expected state before its new state). Every palette entry is used.

The sub-structures:

```
positions(N)  N × varint gap
indices(N)    N × varint table index
nbtList       varint E, then E × (varint ordinal gap, varint byteLength, NBT compound)
hashList      varint H, then H × (varint ordinal gap, 8 bytes hash)
blockList     table palette, varint N, positions(N), indices(N) states, nbtList
```

| Message | Body |
|---|---|
| `patch` | table palette · varint N · positions(N) · indices(N) **expected** states · indices(N) **new** states · hashList (expected NBT hashes) · nbtList (new NBT) |
| `dirty` | blockList (the changed positions with their current state and NBT) |
| `patch.ack` | blockList (**skipped**: actual state and NBT) · table reasons · varint R · positions(R) **rejected** · indices(R) reasons · varint M · positions(M) **normalized** · nbtList (normalized NBT; an entry without NBT means "no block entity") |
| `snapshot.result` | table palette · for each region, in header order, every position of its box in index order: varint palette index · nbtList (ordinals run over all regions' positions concatenated, in header order) |
| `registry.result` (protocol 3) | the registry report file exactly as the mod writes it: gzip of the report's UTF-8 JSON (`14`); empty with `unchanged` |
| `upgrade`, `upgrade.result` (protocol 3) | kind `elements`: table states (in the sender's order, duplicates allowed, not necessarily canonical) · varint B · B × (varint byteLength, NBT) block entities · varint E · E × (varint byteLength, NBT) entities. Kind `structure`: varint 1 · varint byteLength · NBT, the whole structure file's root compound. A result has the request's layout, order and counts |
| `snapshot.result`, kind `surface` | table palette · for each column of the area in index order (`dx + sx · dz`, x fastest): varint **h**, then varint palette index when h > 0; with `ceiling`, the column's ceiling value (h and index the same way) follows its surface value. h = 0 means none (all air, or a missing chunk); otherwise the block is at y = `minY` + h − 1. The palette is in first-use order over that sequence |

For a `patch.ack` the grid covers the skipped, rejected and normalized positions together, and the reason table is in first-use order over the rejected list. A snapshot region's positions are its box's own grid (origin = box min); a snapshot carries no `origin` or `size`.

A decoder checks every index against its grid and table, every count against its header, and that the body is fully consumed; anything else is `bad_request`.

### Message schemas

Every header has `type` first. "MCP → mod" and "mod → MCP" say who sends it.

**`hello`**, MCP → mod

| Key | Type | Meaning |
|---|---|---|
| `type` | `"hello"` | |
| `protocol` | integer | `3`, or `2` to a version-2 mod (*Versions and features*) |
| `token` | string | From the pairing file |
| `client` | `{name, version}` | `{"name":"autosketch","version":"1.0.0"}` |
| `volatile` | object | The volatile-key list (*Hashing*). May be `{}` |
| `modes` | string[] | Protocol 2. The request modes the MCP enforces, from `ask`, `scan`, `plan`, `build` (B6). The mod sends no other mode. Absent means `["build"]`. This MCP lists all four by default. Sent to a version-1 mod too, which ignores it |
| `features` | string[] | Added within protocol 3 (*Versions and features*). The optional capabilities the MCP has: `prompt.close`. The mod uses no other MCP addition. Absent means none. Sent to a version-2 mod too, which ignores it |

**`hello`**, mod → MCP

| Key | Type | Meaning |
|---|---|---|
| `type` | `"hello"` | |
| `protocol` | integer | `3` |
| `mod` | `{version}` | The mod's version |
| `game` | `{version, dataVersion, loader, loaderVersion}` | e.g. `"1.21.1"`, `3955`, `"neoforge"`, `"21.1.249"` |
| `singleplayer` | boolean | True on the integrated server of a singleplayer world |
| `host` | `{name, uuid}` or `null` | The singleplayer host (the allowlist default, *Allowed players*); `null` on a dedicated server |
| `features` | string[] | Protocol 2. The optional capabilities the mod has (*Versions and features*): `modes`, `scan`, `volumes.set`, and in protocol 3 `registry`, `upgrade`. Absent means none |

**`error`**, either direction

| Key | Type | Meaning |
|---|---|---|
| `type` | `"error"` | |
| `id` | integer or `null` | The request it answers, or `null` |
| `code` | string | One of the codes below |
| `message` | string | Human-readable detail, for logs and the agent |
| `protocol` | integer, optional | Only with `protocol_mismatch`: the sender's own version |

| Code | Sent by | Meaning | Connection |
|---|---|---|---|
| `protocol_mismatch` | mod | `hello.protocol` differs | closed |
| `bad_token` | mod | wrong token | closed |
| `not_ready` | mod | a message before the handshake finished | closed |
| `bad_request` | both | the sender's fault: an undecodable frame or header (id `null`, closed), or a decodable message with an invalid field or body (by id when it has one, stays open; *Framing*) | see left |
| `unknown_type` | both | a well-formed frame of a type the receiver doesn't know; answered only if it carries an `id` | open |
| `no_volumes` | mod | `hashes` or `snapshot` while no work volume is set | open |
| `wrong_dimension` | mod | the request's dimension isn't the volumes' dimension | open |
| `outside_volumes` | mod | a requested box or section lies outside the chunks the link keeps loaded (those under the work volume, its declared extension and the context volumes) | open |
| `too_large` | mod | the result would exceed the maximum frame size; the MCP asks again for fewer boxes or sections | open |
| `replaced` | mod | a newer connection took over | closed |
| `internal` | mod | the request was valid, but the mod failed serving it (an exception, a world block entity it can't encode). `bad_request` only ever blames the sender; this blames the mod | open |
| `stale_link` | mod | a `volumes.extend` for a `link` that isn't the current one, or while no work volume is set | open |
| `bad_extension` | mod | a `volumes.extend` box that doesn't contain the player's work volume | open |
| `bad_volumes` | mod | protocol 2: a `volumes.set` the player couldn't have marked either: a work volume outside the build height, or a context over `contextCap` | open |

**`volumes`**, mod → MCP: after `hello`, and whenever the work volume, the context or the dimension changes.

| Key | Type | Meaning |
|---|---|---|
| `type` | `"volumes"` | |
| `id` | integer, optional | Protocol 2. Only on the `volumes` that confirms a `volumes.set`: that request's id |
| `link` | integer | Link generation, from a counter that lasts the server's lifetime (not reset by reconnects). Changes, to a value not used before since the server started, whenever the work volume or dimension changes, including when the work volume is cleared. Context-only changes and `volumes.extend` keep it |
| `dimension` | string | The dimension of both volumes. Absent when `work` is `null` |
| `work` | Box or `null` | The work volume; `null` when none is set (unlinked) |
| `context` | Box[] | The effective context boxes: by default one box, the work volume grown by 3; then whatever the player grew or added. Always includes a box covering the work volume grown by at least 1 (the seam, `11`). Clipped to the world's build height. Absent when `work` is `null` |
| `extended` | Box, optional | The extended work volume the MCP declared with `volumes.extend` for this `link`, present while it is in force. `work` stays the player's own box |

The MCP relinks (fresh journal, full snapshot) when `dimension` or `work` differs from what its document was linked to, and treats a `volumes` with only different `context` (or `extended`) as no relink (*Work and context volumes in-game*). It stamps each patch with the latest `link` it has received.

**`volumes.extend`**, MCP → mod. When the player's work box cuts a door, bed, double chest or plugin multi-block, the MCP extends its work volume to include the whole block (*Model*) and declares the extension to the mod, so the mod's `outside_volumes` check lets those writes through. A plugin multi-block can reach past the one-block seam, and past the context, so the mod can't infer the extension itself.

| Key | Type | Meaning |
|---|---|---|
| `type`, `id` | | |
| `link` | integer | The current link. Otherwise refused with `error` `stale_link` |
| `work` | Box | The extended work volume. Must contain the player's work volume; otherwise refused with `error` `bad_extension` |

On success the mod:

- uses the box as the work volume for the `outside_volumes` check and the change tracker, and keeps its chunks loaded with the link's ticket;
- shows it in the work-volume outline and with an action-bar notice (for example `Autosketch: work volume extended to 34×27×32 to include whole blocks`), so the player sees the extension;
- sends `volumes` again, with the same `link` and the box in `extended`. The `link` doesn't change, because the MCP caused the extension and its journal stays valid.

A later `volumes.extend` replaces the earlier one. The extension is dropped when the player changes the work volume or dimension (a new `link`) or clears it. The MCP declares the extension before sending any patch that writes into it; requests are handled in arrival order, so a patch sent after `volumes.extend` sees it.

**`volumes.set`**, MCP → mod, protocol 2, feature `volumes.set`. The agent sets the volumes (B4, `/autosketch scan`); the mod sets them exactly as if the player had marked them with the wand.

| Key | Type | Meaning |
|---|---|---|
| `type`, `id` | | |
| `dimension` | string | The dimension of both volumes; one the server has, otherwise `error` `wrong_dimension` |
| `work` | Box | The work volume; inside the build height, otherwise `error` `bad_volumes` |
| `context` | Box[], optional | The context boxes. Absent: the default context, as when the player marks a work volume (the work volume grown by 3) |

On success the mod:

- clips the context boxes to the build height and puts the seam box (the work volume grown by 1) first when no given box contains it, as for the player's own context (*Work and context volumes in-game*); refuses with `bad_volumes` when the context then exceeds `contextCap`;
- sets the volumes: a new `link` when the work volume or dimension changes (dropping any extension), the same `link` otherwise; outlines and tickets follow as for the player's volumes;
- tells ops with notices on (for example `Autosketch: the agent set the work volume to 32×24×32`), so the player sees whose change it was;
- answers with `volumes` carrying the request's `id` (that message is also the usual change notice; it isn't sent twice).

The mod accepts `volumes.set` from the paired MCP at any time: which requests may send it is the MCP's to enforce (B6). Linking follows as for any new work volume (*Connection*, automatic linking).

**`hashes`**, MCP → mod

| Key | Type | Meaning |
|---|---|---|
| `type`, `id` | | |
| `dimension` | string | Must be the volumes' dimension |
| `boxes` | Box[] | Non-empty; normally the work volume and every context box |

**`hashes.result`**, mod → MCP

| Key | Type | Meaning |
|---|---|---|
| `type`, `id` | | |
| `sections` | `[sx, sy, sz, hash][]` | One entry per section that at least one box touches, ascending by `sy`, then `sz`, then `sx`. Each hash covers only the section's positions inside the union of the request's boxes (*Section hash*) |

**`snapshot`**, MCP → mod. Exactly one of `boxes` or `sections`.

| Key | Type | Meaning |
|---|---|---|
| `type`, `id` | | |
| `dimension` | string | Must be the volumes' dimension |
| `boxes` | Box[] | Read these boxes |
| `sections` | `[sx, sy, sz][]` | Read these whole sections (each the full 16³ box, even where it extends past the volumes; the MCP keeps only the positions inside its volumes) |

Protocol 2 adds `kind` (feature `scan`). A blocks snapshot (`kind` absent, or `"blocks"`) is the one above. A **surface** snapshot reads one value per column instead (B4):

| Key | Type | Meaning |
|---|---|---|
| `type`, `id` | | |
| `dimension` | string | |
| `kind` | `"surface"` | |
| `columns` | Area | `{"min":[x,z],"max":[x,z]}`: an inclusive area of block columns, `min ≤ max` |
| `ceiling` | integer, optional | Also report, per column, the lowest non-air block at or above this y (the MCP asks when the player is underground) |

**Where the mod serves reads.** Blocks snapshots, section hashes and surface snapshots are served inside the chunks the link keeps loaded (the `outside_volumes` error). Protocol 2 adds the **scan grant** of the latest `scan` prompt (`prompt`, `scan`): while it lasts, a surface snapshot whose columns lie inside `scan.columns`, and a blocks snapshot whose boxes lie inside `scan.box`, are served in the grant's dimension even when no work volume is set (no `no_volumes`). Outside both: `outside_volumes`, or `no_volumes` when no work volume is set. A grant lasts until the next `scan` prompt replaces it, the connection closes or the server stops. For grant reads the mod loads chunks as it reads (it may spread the read over ticks, as for other snapshots), takes no ticket, and never generates a chunk.

**`snapshot.result`**, mod → MCP, with a body

| Key | Type | Meaning |
|---|---|---|
| `type`, `id` | | |
| `dimension` | string | |
| `regions` | Box[] | The boxes read, in request order (for `sections`, each section's box) |

For a surface snapshot (protocol 2) the header is instead:

| Key | Type | Meaning |
|---|---|---|
| `type`, `id` | | |
| `dimension` | string | |
| `kind` | `"surface"` | |
| `columns` | Area | As requested |
| `minY` | integer | The dimension's lowest build y (`-64` in the 1.21.1 overworld) |
| `ceiling` | integer, optional | As requested; present exactly when the body has ceilings |
| `missing` | `[cx, cz][]` | Chunks of the area that aren't generated, ascending by `cz`, then `cx`; may be empty. Their columns read as none |

Per column, the **surface block** is the highest position within the build height whose state isn't air (`minecraft:air`, which on the wire includes cave and void air): what the game's `WORLD_SURFACE` heightmap gives, one below its value. Fluids, leaves, plants and snow layers count. The **ceiling block** is the lowest non-air position at or above `ceiling` (none when everything from there to the top is air). States only, no block entities: the full-block layer of a scan is a blocks snapshot of `scan.box`.

The body holds every position of every region, air included, as states, plus the NBT of every block entity in them. Positions outside the world's build height (a section box above the top or below the bottom) read as `minecraft:air` with no block entity, in snapshots and section hashes alike. Regions may overlap (a context box overlapping the work volume); a position in two regions appears in both, with its NBT in both.

**`patch`**, MCP → mod, with a body

| Key | Type | Meaning |
|---|---|---|
| `type`, `id` | | `id` is the patch id |
| `link` | integer | The `link` of the volumes the patch was built for |
| `dimension` | string | |
| `force` | `true`, optional | `overwriteHandEdits`: skip the precondition (*World undo and restore*). Omitted when false |
| `origin`, `size` | `[x,y,z]` | The body's grid |
| `count` | integer | Number of positions |

Per position the body gives the expected state, the new state, optionally the expected NBT hash (sent when the cache's before-block has a block entity whose type isn't state only) and optionally the new NBT (when the new block has a block entity).

**`patch.ack`**, mod → MCP, with a body

| Key | Type | Meaning |
|---|---|---|
| `type`, `id` | | The patch id |
| `applied` | integer | Positions written |
| `overwritten` | integer | Of those, how many failed the precondition and were written anyway because of `force` (0 otherwise) |
| `skipped` | integer | Positions whose precondition failed (never with `force`) |
| `rejected` | integer | Positions refused (reasons below) |
| `normalized` | integer | Applied positions listed in the normalized list |
| `origin`, `size` | `[x,y,z]` | The body's grid |

`applied + skipped + rejected` equals the patch's `count`. Reject reasons:

| Reason | Meaning |
|---|---|
| `stale_link` | The patch's `link` isn't the current one (the work volume changed since the MCP built it), no work volume is set, or the patch's dimension isn't the volumes'. Every position is rejected with this reason |
| `outside_volumes` | The position lies outside the effective work volume: the player's work volume, or the extension declared with `volumes.extend`. A position in a context box is rejected too: patches never write context |
| `unknown_state` | The new state isn't the canonical form of a state the game knows (*Block states*) |
| `bad_nbt` | The patch gives NBT, but the new block has no block entity, its `id` names another block-entity type, or the game can't load it |

The **normalized** list closes a gap the precondition would otherwise open: the game rewrites block-entity NBT as it loads it (filling defaults, adding `components`), so the NBT the cache sent and the NBT the world now holds can differ even though nobody edited anything. For each applied position, the mod compares the NBT hash of the block entity now in the world with the hash of the NBT the patch sent ("none" counts as a value: a block entity created where the patch sent none, or none where it sent some). When they differ, it lists the position with the world's NBT (or none). State-only types are never listed. **Who acts on it:** the mod only reports. Writing the world's NBT into the cache is an MCP-side `world_sync` write through Q's sync primitive (`applyWorldState`), in the same `world_sync` entry as the skipped and rejected positions of that ack. P's ack handling hands the list over, and nothing about it is ever pushed back to the world.

**`dirty`**, mod → MCP: at most one per server tick, sent at the end of a tick in which a tracked change happened.

| Key | Type | Meaning |
|---|---|---|
| `type` | `"dirty"` | |
| `everything` | boolean | True when more positions changed in the tick than the mod's cap (or the tracker lost track): no body; the MCP compares section hashes |
| `origin`, `size`, `count` | | Only when `everything` is false: the body's grid and number of positions |

The **dirty cap is at most 4,096 positions** (one section's worth); the mod may be configured lower, and the MCP must not assume the exact cap, only that a notice lists no more than 4,096 positions and that `everything` can come at any count. A notice lists the changed positions with the state and NBT the world holds at the end of that tick, so small hand edits sync without a snapshot. Positions outside both volumes are never listed, and nor are the mod's own patch writes. Contents-only changes are not tracked (*World → agent*).

**`prompt`**, mod → MCP

| Key | Type | Meaning |
|---|---|---|
| `type`, `id` | | `id` from the mod's prompt counter |
| `player` | `{name, uuid}` | Who asked |
| `text` | string | The request text |
| `context` | object | Game context, all world coordinates: |
| `context.dimension` | string | The player's dimension |
| `context.position` | `[x,y,z]` numbers | The player's feet (`Entity.position()`) |
| `context.eye` | `[x,y,z]` numbers | `Entity.getEyePosition()` |
| `context.yaw` | number | Degrees, the game's convention: 0 = facing south (+Z), 90 = west, ±180 = north, −90 = east; wrapped to [−180, 180) |
| `context.pitch` | number | Degrees, −90 = straight up, 90 = straight down |
| `context.facing` | string | The horizontal cardinal of the yaw (`Direction.fromYRot`): `north`, `south`, `west` or `east` |
| `context.target` | `{pos, state, face}`, optional | The block under the crosshair within the configured reach: integer position, canonical state, the face looked at (`down`, `up`, `north`, `south`, `west`, `east`). Absent when the crosshair hits no block |
| `context.focus` | Box, optional | The focus box, already clipped to the work and context volumes |
| `context.focusClipped` | `true`, optional | The focus box was clipped |
| `mode` | string, optional | Protocol 2, feature `modes`: the subcommand, `ask`, `scan`, `plan` or `build` (B6). A mod with the feature sends it on every prompt, and only a mode the MCP's hello lists. Absent means `build` |
| `scan` | object, optional | Protocol 2, only with mode `scan`: the **scan grant**, what the mod lets the MCP read for the probe (B4). The mod sizes it from its config: |
| `scan.radius` | integer | Radius in chunks around the player's chunk, after clipping to `scanChunksMax` |
| `scan.clipped` | `true`, optional | The player asked for a larger radius (the mod also warns on the action bar) |
| `scan.columns` | Area | The columns of the chunks within the radius: `16·(cx−r)` to `16·(cx+r)+15` on x, likewise on z, for the player's chunk `(cx, cz)` |
| `scan.box` | Box | The full-block box: from `scanBelow` under the feet to `scanAbove` over them, clipped to the build height, around the player and inside `columns`, as wide as `scanCap` blocks allow |

**`prompt.result`**, MCP → mod

| Key | Type | Meaning |
|---|---|---|
| `type`, `id` | | The prompt's id |
| `delivered` | boolean | |
| `reason` | string | Only when not delivered: `no_link` (no linked document), `not_allowed` (not on `world.promptPlayers`), `no_listener` (no agent session will receive it), `unsupported_mode` (protocol 2: the prompt's mode isn't one the MCP's hello listed; the mod should have refused it itself, and shows this code the same way) |

When the mod has no connection at all, it tells the player `no_link` itself.

**`prompt.close`**, mod → MCP, MCP feature `prompt.close` (added within protocol 3)

| Key | Type | Meaning |
|---|---|---|
| `type` | `"prompt.close"` | |
| `player` | `{name, uuid}` | Who ran `/autosketch done` |

The player ended the open read-only request (B6). The mod sends it only when the MCP's hello lists `prompt.close`, and without a connection tells the player `no_link` itself. It carries no request id: it ends whichever `ask`, `plan` or `scan` request is open, since the request a player last sent may have been refused or superseded. The MCP owns the request state, so it answers with a `notice` to that player: the request it ended (`Autosketch: ask request 3 ended; the agent may edit again.`), that none is open, or, for a player not on the allowlist (*Allowed players*), that they can't end one either. A `build` request isn't ended by it.

**`registry`**, MCP → mod, protocol 3, feature `registry`

| Key | Type | Meaning |
|---|---|---|
| `type`, `id` | | |
| `have` | Hash, optional | The hash of the report the MCP holds (from the file beside the pointer, or an earlier answer) |

**`registry.result`**, mod → MCP, with a body unless `unchanged`

| Key | Type | Meaning |
|---|---|---|
| `type`, `id` | | |
| `hash` | Hash | The first 8 bytes of SHA-256 over the report's uncompressed JSON |
| `dataVersion` | integer | The running game's DataVersion |
| `unchanged` | `true`, optional | `hash` equals the request's `have`: no body |

The body is the report file the mod wrote at server start (its format is `14`'s), so the MCP reads both the same way. The report is built from the live registries once per server run.

**`upgrade`**, MCP → mod, protocol 3, feature `upgrade`, with a body

| Key | Type | Meaning |
|---|---|---|
| `type`, `id` | | |
| `from` | integer | The DataVersion the data was written on (a format's default when the file names none, `14`) |
| `kind` | `"elements"` or `"structure"` | Per element, as WorldEdit upgrades `.schem` (also used for `.bp` and `.litematic`); or a whole structure file with the `STRUCTURE` fix type, as the game upgrades `.nbt` |

**`upgrade.result`**, mod → MCP, with a body

| Key | Type | Meaning |
|---|---|---|
| `type`, `id` | | |
| `to` | integer | The running game's DataVersion |
| `kind` | | As requested |
| `failed` | integer, optional | Elements the data fixer threw on, returned unchanged; omitted when 0 |

The mod runs the game's data fixer from `from` to the running version: block states as `block_state` (`{Name, Properties}`, printed back with properties sorted), block entities as `block_entity`, entities as `entity`, a structure as `STRUCTURE` (and stamps its `DataVersion`). Forward only: with `from` at or above the running version the data comes back unchanged. Blocks the fixer doesn't know pass through as they were; a state string that doesn't parse comes back as it was and counts in `failed`.

**`notice`**, MCP → mod

| Key | Type | Meaning |
|---|---|---|
| `type` | `"notice"` | |
| `text` | string | Action-bar text |
| `player` | UUID or `null` | One player (shown whatever their notices setting: it answers something they did, such as `/autosketch done`), or `null` for every op with notices on |

**`chat`**, MCP → mod

| Key | Type | Meaning |
|---|---|---|
| `type` | `"chat"` | |
| `request` | integer or `null` | The prompt id this belongs to, or `null` (work not prompted from the game) |
| `player` | UUID or `null` | The requesting player, or `null` |
| `kind` | `"activity"` or `"reply"` | Styled differently in chat |
| `lines` | string[] | One chat line each |

The mod shows a `chat` to the named player (a `reply` always; an `activity` unless their log setting is `off`), and to every other player whose log setting is `all`.

### Applying a patch

For each position, in index order, under the tick budget:

1. The patch's `link` isn't the current link, or there are no volumes, or `dimension` isn't theirs: reject (`stale_link`) every position.
2. Outside the effective work volume (the work volume, or its declared extension, `volumes.extend`): reject `outside_volumes`, even when the position lies in a context box. Patches never write context (*Model*).
3. The new state isn't canonical and known: reject `unknown_state`. NBT given but unusable for the new block: reject `bad_nbt`.
4. **Precondition:** the canonical printing of the world's state equals the expected state, and, when an expected NBT hash is given, the world's block has a block entity whose NBT hash (*Hashing*, with the hello's volatile list) equals it. Not both: skip, recording the world's state and NBT. With `force`, write anyway and count it as overwritten.
5. Write the new state without side effects (*Agent → world*), remove the old block entity, and load the patch's NBT when it gives some.
6. Compare NBT hashes for the normalized list.

Then send the `patch.ack`.

### Hashing

**Volatile-key list.** A JSON object sent in the MCP's `hello`. Each key is a block-entity type id (the NBT's `id`, e.g. `minecraft:furnace`) or `*` (every type). Each value is either a list of key paths to drop before hashing, or the string `"state_only"`, which means the NBT of that type is never compared and never hashed. A key path names a top-level key (`BurnTime`) or a nested compound key with `/` between the levels (`Network/Stress`); paths don't descend into lists, and keys containing `/` can't be named. For a given block entity, the paths of `*` and of its type both apply; `"state_only"` on either wins. The MCP's built-in default (`src/world/protocol/hash.ts`; silo R grows it from measurements):

```json
{ "minecraft:furnace":       ["BurnTime", "CookTime", "CookTimeTotal", "lit_time_remaining", "lit_total_time", "cooking_time_spent", "cooking_total_time"],
  "minecraft:blast_furnace": ["BurnTime", "CookTime", "CookTimeTotal", "lit_time_remaining", "lit_total_time", "cooking_time_spent", "cooking_total_time"],
  "minecraft:smoker":        ["BurnTime", "CookTime", "CookTimeTotal", "lit_time_remaining", "lit_total_time", "cooking_time_spent", "cooking_total_time"],
  "minecraft:hopper":        ["TransferCooldown"],
  "minecraft:brewing_stand": ["BrewTime"],
  "minecraft:campfire":      ["CookingTimes"],
  "minecraft:soul_campfire": ["CookingTimes"],
  "*":                       ["NeedsSpeedUpdate"],
  "create:simple_kinetic":   ["Speed", "Network", "Source"],
  "create:motor":            ["Speed", "Network", "Source"],
  "create:encased_fan":      ["Speed", "Network", "Source"],
  "create:gearbox":          ["Speed", "Network", "Source"],
  "create:mechanical_press": ["Speed", "Network", "Source", "Running", "Finished", "Ticks"],
  "create:millstone":        ["Speed", "Network", "Source", "Timer"] }
```

The furnace, hopper and brewing entries were the starting list; the rest came from measurements on a running Craftoria base (*Measured on Craftoria*).

Plugins add entries (`09`), merged as a union per type. The mod keeps no list of its own: it hashes with whatever the hello sent.

**Canonical NBT** of a block entity's compound:

1. If its type is state only, it has no canonical form and no hash.
2. Remove the top-level `x`, `y`, `z` (nested keys named `x` stay).
3. Remove every volatile key path that applies.
4. Write it as binary NBT, with keys sorted recursively and empty lists of type End (*NBT*): `0x0A 0x00 0x00`, the sorted payload, `0x00`.

**NBT hash** = the first 8 bytes of SHA-256 over the canonical bytes. The empty compound's canonical bytes are `0a 00 00 00`.

**Section hash**, for a section and a set of boxes (the request's boxes):

1. Take the section's positions that lie inside at least one box, in order y, then z, then x (ascending; x innermost). Positions outside every box are left out entirely. A section with no such position has no hash and isn't listed.
2. For each, append to a byte stream: the canonical state as a body string (varint length, UTF-8), air included as `minecraft:air`; then `0x00` if the block has no block entity or a state-only one, or `0x01` followed by the 8-byte NBT hash.
3. The section hash is the first 8 bytes of SHA-256 over the stream.

Both sides compute it the same way: the mod over the world, the MCP over its cache (which holds exactly the positions inside its volumes). Because the boxes come from the request, a section only partly inside the volumes hashes only its inside part on both sides. Positions outside the world's build height hash as `minecraft:air` with no block entity.

**Why SHA-256 truncated to 64 bits:** both sides have it with no dependency (`MessageDigest.getInstance("SHA-256")`, `node:crypto`), it is fast enough (hashing a full section is about 80 KB of input), and 64 bits make an accidental collision between a cache and a world state negligible at the scale of a few thousand sections. Nothing measured called for something else.

### Golden vectors

`test/data/world-protocol/` holds one complete frame per file (`<name>.bin`, length prefix included) with a sidecar `<name>.json`, for the current version (3). `test/data/world-protocol/v2/` keeps the version-2 frames, frozen as they were cut; an MCP must still decode and re-encode them (it speaks `N−1`), and the version-3 codec does, byte for byte. `v1/` keeps the version-1 frames, no longer spoken but still checked on both sides as a guard that the codec only grows additively. The hash vectors are shared: hashing didn't change.

- `description`, `sender` (`"mcp"` or `"mod"`), and `header`, the frame's JSON header exactly.
- `body`, for messages with a body: the decoded content in encoded order. Surface results list `surface` (and `ceilings`) as `heights` and `states` arrays, one entry per column (a state is `0`, and not encoded, where the height is `0`). Patches list `blocks` with world `pos`, `expected`, `expectedNbtHash`, `state` and `nbt`; acks list `skipped`, `rejected` (with `reason`) and `normalized`; dirty notices list `blocks`; snapshot results list each region's `states` (palette indices) and `blockEntities`. The `palette` (and `reasons`) tables are given too, in their encoded order. NBT is written as SNBT (the game's `TagParser.parseTag` reads it).
- `generated`, instead of `body`, for `patch-large`: the rule that produces its blocks.
- Protocol 3: `registry.result` bodies are given as `bytes` (base64 of the body) and `report` (the decoded JSON, for reading); upgrades list `states`, `blockEntities` and `entities` (SNBT), or `structure`.

There is a vector per message kind: `hello` both ways, `error` (including a refused extension and `internal`), `volumes` (with and without a work volume, and with an extension in force), `volumes.extend`, `hashes` and its result, `snapshot` by boxes and by sections, `snapshot.result` (empty, one block, mixed palette with block entities and overlapping regions), `patch` (empty, one block, mixed palette given out of order, block entities with expected NBT hashes, forced, large), `patch.ack` (all applied, mixed, forced, stale), `dirty` (positions, everything), `prompt` (full and minimal), `prompt.result` (delivered, refused), `notice` and `chat` (activity, reply). Protocol 2 adds: `hello` with `modes` (all, and build only) and with `features` (all, and some), `prompt` with modes `build`, `ask` and `scan` (with a clipped grant), `prompt.result` `unsupported_mode`, `volumes.set` (with context, and default), the `volumes` confirming one (with `id`), `error` `bad_volumes`, `snapshot` kind `surface` (with and without `ceiling`) and its results (a missing chunk; ceilings). Protocol 3 adds: `registry` (with and without `have`), `registry.result` (a synthetic report, and `unchanged`), `upgrade` of elements and of a structure without a DataVersion, and their results (one with `failed`). Hash vectors: `hash-nbt.json` (compounds with their volatile lists, canonical bytes in hex and hash: empty, unordered keys, nested, every tag type, modified UTF-8, furnace with and without volatile keys, a nested path and `*`, state only) and `hash-sections.json` (sections with their boxes and blocks and expected hash: full, a single position, negative coordinates with partial overlapping boxes, block entities with volatile and state-only types).

An implementation passes when it decodes every vector to its sidecar, re-encodes the sidecar to the same bytes (headers compared as JSON), and reproduces every hash. The vectors are synthetic, and they are frozen: a change to them is a protocol change.

**Worked example** (`patch-one.bin`): one block at world (100, 64, −200), air to stone.

```
00 00 00 9c                       frameLength 156
00 00 00 73                       headerLength 115
7b 22 74 79 … 3a 31 7d            {"type":"patch","id":21,"link":3,"dimension":"minecraft:overworld",
                                   "origin":[100,64,-200],"size":[1,1,1],"count":1}
02                                palette: 2 strings
0d 6d 69 6e … 61 69 72            "minecraft:air" (13 bytes)
0f 6d 69 6e … 6e 65               "minecraft:stone" (15 bytes)
01                                N = 1
00                                gap 0 → index 0 → (100, 64, −200)
00                                expected = palette[0], minecraft:air
01                                new = palette[1], minecraft:stone
00                                no expected NBT hashes
00                                no NBT
```

## Player feedback in-game

- Volume outlines (work, context and focus in their own colours) while the wand is held, or after `/autosketch show`; the wand's mode on the action bar.
- An action-bar line when a patch lands: `Autosketch: 1,204 placed, 3 skipped`. Toggle with `/autosketch notices on|off`.
- `/autosketch status`: link state, volumes, last patch, pending patches.

## Prompting from the game

The player can ask the agent for something without leaving the game: stand in the world, point at what they mean, and type the request. The request starts the root agent on the work volume the player set, the way a fork's handoff starts a subagent on its sandbox. The agent receives the request with enough game context that "here", "this" and "that wall" resolve to positions, and acts on the linked document as usual. Results show up in the world, and the agent's replies and a live log of what it is doing stream back into the game chat.

**In the game:**

- `/autosketch ask <text>` sends a request. The command is long on purpose so it can't clash with other mods; the config can register a short alias. `/autosketch done` ends the open read-only request (B6).
- **Focus box:** the wand's focus mode marks a focus box, the in-game counterpart of a selection. It must lie inside the work or context volume (it is clipped to them, with a warning), so it can point at something to change or at something to match. `/autosketch focus clear` removes it.
- The mod attaches the **game context** to every request: the player's position, eye position and facing (yaw and pitch), the block under the crosshair (state and the face looked at, up to a configurable reach), and the focus box if any. All world positions; the MCP converts them.
- The action bar says when the request was delivered, or why not: no link, not allowed, no agent session listening.

**In the MCP:**

- **Delivery through Claude Code channels.** The MCP server declares itself a channel and pushes each request into the running Claude Code session as a channel event, the way Claude Code's Telegram and Discord bridges do. Channels are a Claude Code feature (a research preview at the time of writing): the session must be started with the server named in `--channels`, and other MCP clients get the world link without in-game prompting. When the MCP can tell that no session will receive the event, it refuses the request so the player hears about it.
- **Context as handles, not coordinates.** Before pushing the request, the MCP converts the context to document-local coordinates and saves it on the linked document as saved selections: `focus` (the focus box) and `target` (the crosshair block), replaced by each request. It also saves the player's view (eye position, yaw and pitch) as the saved camera `player` (`06`, *Cameras*), so `render({ views: [{ camera: "player" }] })` shows roughly what the player sees. The server doesn't know the client's field of view, so the camera uses the game's default of 70°. The event text names them, so the agent works with `{"saved": "focus"}` rather than raw numbers (*Semantic handles over coordinates*, `ARCHITECTURE.md`). Focus and target outside both volumes are reported as outside and not saved, since the agent can't see there. In the context volume they are saved and marked read-only.
- **The event text** is short and fixed in shape, and opens with the request's mode and one line on what it allows (B6), then the same handoff facts a fork gives a subagent (`11`): work volume size, context volume, the scope to address. For example: `In-game build request from Kev: "put a balcony here". Build mode: you may edit the linked document. Work volume 32×24×32, context +3 and 1 reference box (scope "base"). Looking at minecraft:oak_planks (south face), saved as "target". Focus box 5×3×2, saved as "focus". Standing at (10, 5, 8) facing north; your view is saved as camera "player".`
- **What streams back.** The MCP never sees the agent's own text or reasoning (they live in the agent's interface), only its tool calls. So two streams go to the chat:
  - **Activity:** one compact line per tool call on the linked document as it happens (`fill: 1,204 blocks`, `render: 1 image`, `refused: lock_overlap`), and each patch result. It is built from the same event stream that feeds the viewer (`12`, `call.start`, `call.end`, `call.refused`, `doc.op`, `world.patch`), so no tool emits anything extra. Lines are shortened and coalesced, and rate-limited so a script making thousands of edits shows as one line.
  - **Replies:** `world_reply`, a tool the agent calls to answer in the chat, as Claude Code's two-way channels do. It can carry several lines, and a `done` flag that marks the request answered and closes its stream (a read-only request's mode stays until the player ends it, B6). The channel event tells the agent to answer in-game requests through it.
- **Which requests stream.** An in-game request opens a stream to the requesting player. It closes when the agent replies with `done`, when the player ends it with `/autosketch done`, or after a configurable idle time with no tool calls (not for a read-only request, B6). For a read-only request, the agent's `done` closes the stream but not the mode (B6, *When a request is open*). `/autosketch log off|mine|all` sets what a player sees: nothing, only activity following their own requests (the default), or everything the agent does on the linked document, including work prompted from the terminal.
- **Allowed players.** A request becomes a prompt to an agent that can run commands on the user's machine, so the allowlist lives on the MCP side, not in the game: setting `world.promptPlayers` (UUIDs or names). In singleplayer the host player (named in the mod's `hello`) is always allowed, in addition to the list: the host is the user at the machine. Names compare case-insensitively; UUIDs are safer, since a name can be reused, or claimed by anyone on an offline-mode server. On a dedicated server the list starts empty, and requests are refused until the user adds players. Op level 2 is required as well, like every `/autosketch` command.
- **Not in v1:** approving or denying the agent's tool use from the game. Channels can relay permission prompts, but approvals stay in the agent's interface for now.

## Companion mod requirements

| # | Requirement |
|---|-------------|
| M1 | NeoForge 1.21.1, Java (JDK 21), built from NeoForge's MDK as a `mod/` subproject. |
| M2 | No registered blocks, items or other registry content. The server half is required. The client half is optional: clients without it join and lose only client-side input and display (B2). |
| M3 | Work and context volumes: the wand is any stack of the configured item (`wandItem`, main hand, both clicks cancelled; B1) with work/context/focus modes (swap-hands key cycles), air mode (B2), `/autosketch mode|pos1|pos2|show|clear|status|notices|air`, `/autosketch context add|grow|clear`, a cap on context size, op level 2. |
| M4 | Sends both volumes to the MCP on change; keeps their chunks loaded with a ticket while linked. |
| M5 | Conditional patch applier (per-block compare-and-set): per-position expected-state and expected-NBT-hash check (volatile keys excluded), skip and report state and NBT on mismatch, reject unknown states. |
| M6 | Writes without neighbour updates, physics or drops; replaces block entities with the patch's NBT. |
| M7 | Applies patches in order under a configurable per-tick block budget. |
| M8 | Snapshots of the work and context volumes, whole or by chunk section: states and block-entity NBT. Per-section hashes on request. |
| M9 | Change tracker: reports changes inside the work or context volume that aren't its own patch writes, from any source (players, Axiom, pistons, explosions, fluids). Ignores everything outside both. |
| M10 | Localhost socket with token pairing through `config/autosketch-bridge.toml`; version check in hello; survives MCP restarts. |
| M11 | Action-bar notices and outline particles, toggleable. |
| M12 | Leaves entities alone. |
| M13 | `/autosketch ask|plan|build <text>` and `/autosketch scan [radius] [text]` (the request's mode, B6; the scan grant, B4), with the configured alias as a short root for them, `/autosketch done` (ends the open read-only request, sent as `prompt.close` only to an MCP listing the feature; B6), and `/autosketch focus clear`; focus box set in the wand's focus mode, clipped to the work and context volumes; game context (position, eye position, facing as yaw and pitch, crosshair block and face, focus box) attached to each `prompt`; delivery result on the action bar; `chat` lines shown to their target, styled by kind; `/autosketch log off|mine|all`. |
| M14 | Locked while no MCP is connected (`16`, *Mod side*): the wand, air mode and every `/autosketch` subcommand but `status` (and the request alias) answer with one action-bar line and do nothing else; no outlines or air preview are drawn; marked volumes are kept and show again on connect. With an MCP whose hello lacks `ui`, today's features work and only `16`'s in-game UI is refused with a too-old line. The link state (`offline`, `too_old`, `connected`) goes to the client half on change and on join; `/autosketch status` reports it (for `too_old`, the MCP's protocol and features). |

## MCP requirements

| # | Requirement |
|---|-------------|
| W1 | Bridge client: connect, pair with the token from the instance config, reconnect, version check; a clear error naming WSL mirrored networking when the port can't be reached. |
| W2 | Link the base document as the root scope (`doc_open({ world: true })` or similar): the player's work and context volumes, re-origined to the work volume's minimum corner, whole-block extension, the sandbox write rule (`outside_work_volume`) and context ghosting reused from `11`, fresh journal on a new work volume, context-only changes synced without relinking. |
| W3 | Patch sender subscribed to the journal's event stream; one patch per committed entry on the linked document (one per `restore`), carrying expected states and NBT hashes. |
| W4 | Ack handling: skipped and rejected positions written back into the cache as a `world_sync` entry, and summarized in a tool result. |
| W5 | `world_sync` tool and automatic sync before a tool call when the volumes are dirty; section-hash comparison so only differing sections are snapshotted; journaled, pushes nothing, keeps metadata, reports component drift. |
| W6 | Sync barrier for undo, redo and restore through `Document.guard`; `overwriteHandEdits` to cross it and to force one patch. |
| W7 | Scope merges as one conditional patch; merge check relaxed for positions changed by syncs, listed in the report. |
| W8 | Events for the viewer (`12`): `world.link`, `world.patch` (with ack counts), `world.sync`. |
| W9 | A fake in-game host implementing the protocol in TypeScript, for unit tests of the precondition, sync, barrier, merge and reconnect paths without a running game. |
| W10 | Canonical NBT hashing and section hashing identical to the mod's, with the volatile-key list (built-in default plus plugin entries) sent in `hello`. |
| W11 | In-game requests: declared as a Claude Code channel; allowlist (`world.promptPlayers`); context converted to local coordinates and saved as the `focus` and `target` selections and the `player` camera; one channel event per request, opening with the handoff facts; `prompt.result` back to the mod; activity stream from the event feed (coalesced, rate-limited) and the `world_reply` tool, sent as `chat`; request streams closed by `done` or idle time; a read-only request's mode held until the player's `prompt.close`, the next request or a disconnect (B6). |

## Measured on Craftoria

Silo R answered the measured open questions on the headless Craftoria 1.37.0 server (NeoForge 21.1.249, 537 mods, WSL2, flat test world, 10 GB heap), with the end-to-end tier's scripts (`test/e2e/world/measure.ts`, `volatile.ts`; `10`, *Optional e2e world tier*). Numbers are single runs; expect ±30%.

- **Throughput and the tick budget.** Plain states (air ↔ stone) cost about **0.5 µs per block** on Craftoria (the whole-server tick time over 100 ticks rose from 0.9 ms to 3.6 ms while a 600,000-block patch applied 10,000 blocks in each of 60 ticks), the same as silo O's vanilla figure. 600,000 blocks acked in 3.0 s, exactly 60 ticks of 50 ms, so no tick ran long. Chests with NBT: 4,000 in one tick, about 20 ms, so about 5 µs each. **Decision: `tickBudget` default 20,000** (about 10 ms of a 50 ms tick, leaving room on a busy base; a large stamp lands twice as fast as at 10,000), and **the fixed 25 ms time cap stays**: no realistic block-entity stamp reached it, and it only matters for heavy modded block entities, where it is the right guard.
- **Ack wait.** Patches of up to 9,000 blocks were acked in 1–51 ms (median 49 ms at 9,000, most of it the wait for the next tick); 100,000 blocks in 0.49 s and 300,000 in 1.5 s at the old budget of 10,000 (half that at 20,000). **Decision: `world.ackWaitMs` stays 1,500 ms.** It costs nothing for ordinary edits, which ack in well under 100 ms, and covers patches up to about 600,000 blocks at the new budget, so only the very largest stamps move their `world:` line to the next result.
- **Change tracker.** The `setBlockState` mixin applies cleanly with Craftoria's mods (no mixin warnings; dirty notices arrive about 20 ms after an RCON `setblock`). Its cost is below measurement noise: 32,768-block `/fill`s took 78–80 ms whether inside the work volume or outside both volumes. The scan (`tracker = "scan"`) works on the dedicated server, so the mixin config plugin finds `config/autosketch-common.toml` from the server's working directory; it reports an edit within one scan period (0.67 s measured) and costs about **1.1 ms per tick** for a 224×64×224 work volume plus context (3.7 M blocks), and about 0.7 µs more per changed block inside the volumes. An edit made right after `doc_open` returned was reported in every mode (scan alone: after 0.67 s). An edit inside the scan's baseline gap (after the link snapshot, before the first pass records the baseline) wasn't probed separately: with `scan` alone it would be missed until the next section-hash sync, and with `both` the hook covers that window. **Decision: `tracker` default `both`**: the hook for immediate notices, plus the scan, the only detector that sees writers bypassing `setBlockState` (Axiom is believed to write chunk sections directly; the user checks it in-client), for about 1 ms per tick at the largest volumes.
- **Snapshot cost and the context cap.** Server-side snapshot of a checkerboard-filled box: 0.13 M blocks 4 ms, 0.5 M 13 ms, 1.6 M 32 ms, 3.2 M 66 ms (about 1 byte of frame per block for a two-state palette); section hashes 7, 19, 53 and 94 ms for the same boxes. Linking a 224×64×224 work volume with its default context (3.7 M blocks) takes about 0.6 s end to end, and a `world_sync` of an unchanged 3.2 M-block volume 0.5 s. The largest practical volume is therefore set by the context cap, not by snapshot time. **Decision: `contextCap` stays 4,194,304 blocks** (a 224×64×224 work volume fits with its default context; 256×64×256 doesn't), since the MCP's in-memory document and renders, not the mod, are the limit beyond it.
- **Volatile keys.** A synthetic running base (Create creative motors driving a hopper-fed millstone, a fan, cogwheels and a gearbox; three burning furnaces; a hopper line between chests; a brewing stand; a campfire; AE2 controller, drive, interface, inscriber and charger on a creative cell; Mekanism machines on a creative cube; Functional Storage drawers and controller; Sophisticated Storage chest and barrel; Powah; and idle vanilla block entities), 52 block entities, snapshotted every 5 s for 2 minutes. With the starting list, 1 of 52 would false-skip (the millstone's `Timer`); with the grown list, **0**. NeoForge's `neoforge:attachments` never appeared or changed. The remaining NBT changes were automation moving items (`Items`, a millstone's inventories): real contents changes that the precondition should catch, and no volatile key can tell a machine from a hand. Create also adds `NeedsSpeedUpdate` when a kinetic block entity loads, and its kinetic `Speed`/`Network` change whenever a connected source or load changes, so they are listed too (13's own example of a volatile key). **Decision:** the grown default above; plugins (`09`) add per-type entries for modded machines that a base shows to tick.
- **Surface snapshots (B4)** (silo Y, 2026-11-16, `measure.ts surface`, 5 runs each, same server and flat world). Served inside a flat context box over the area, whose ticket keeps the chunks loaded: the default scan radius (4 chunks, 144×144 = 20,736 columns) in 2–4 ms median, 43 KB of frame (85 KB with a ceiling); the maximum (12 chunks, 400×400 = 160,000 columns) in 9–13 ms median (at most 51 ms), **324 KB** (about 2 bytes per column), and with a ceiling 49–51 ms (at most 98 ms), 644 KB. The whole-server tick time over 100 ticks stayed at 1.6–1.9 ms (at most +0.12 ms after the ceiling runs), since the read is sliced at 5 ms per tick. Cold, right after the 625 chunks had unloaded (the read loads from disk whatever the returning ticket hasn't loaded yet): 148–180 ms for the maximum radius, tick time +0.15 ms. A flat world has a two-entry palette, so real terrain costs somewhat more bytes per column (a larger palette's indices take two bytes past 128 states), still well under 1 MB at the maximum. **Decision: the defaults stand** (`scanChunks` 4, `scanChunksMax` 12, `scanBelow` 32, `scanAbove` 64, `scanCap` 4,194,304): the surface layer at the maximum radius costs a fraction of a second and under a megabyte, and the full-block box under `scanCap` is a blocks snapshot of the size already measured above (about 70 ms server side for 3.2 M blocks). Not measured: a cold read over terrain no ticket is loading (the scan grant's own path needs a player in-game; the GameTests cover its logic).

## Implementation status

Work is split into silos in `docs/briefs/world/`. Suggested order: protocol, hashing and fake host (W9, W10), then the MCP side (W1–W8, W11) tested against the fake host, then the mod (M1–M13), then end-to-end tests in a Craftoria save.

| Part | Silo | Status |
|---|---|---|
| Wire format, golden vectors, codec, hashing (W10), fake host (W9) | L | Done. *Wire format* above, including `volumes.extend` for the MCP's whole-block extension of the work volume; vectors and hash vectors in `test/data/world-protocol/` (regenerate with `npx tsx test/data/world-protocol/generate.ts` only for a protocol change); codec, frame reader, hashing and pairing file in `src/world/protocol/`; fake host in `test/support/fake-host.ts` (handshake, patches limited to the effective work volume, invalid messages answered by id, build height read as air, compare-and-set with NBT hashes, normalized list, dirty notices, section hashes, snapshots, prompts, `volumes.extend` (link and containment checks, reset on a new link), and hooks for player edits, ticks, volume changes, dropped connections and restarts; no tick budget or chunk loading). A one-million-block patch encodes in about 0.1 s to 3.0 MB. The volatile-key default was grown by silo R from a running Craftoria base (*Hashing*, *Measured on Craftoria*). |
| Sync primitive, section-hash sync, `world_sync` tool, auto-sync (W5) | Q | Done against the fake host, with a minimal test link over P's `Bridge` (P's link implementation wired in by `server/index.ts`). `src/world/sync.ts`: `applyWorldState` (whole/section snapshot form filtered to the volumes, partial form from `dirty` or an ack, NBT-only form for `normalized`, clearing removed context) writes one `world_sync` entry raw and through `Document.editUnguarded`, so locks and the root write rule don't apply; positions that already match (NBT by content, volatile keys ignored) are left alone, so an unchanged world adds no entry; the result counts blocks changed per component. With `reconcile: true` (ack handling), the normalized list is reconciled in place without an entry (the redo-tail answer, *World undo and restore*). `syncBySections` compares section hashes and snapshots only differing sections; cache hashes are kept per document and invalidated per section by `VoxelStore.onWrite`. `syncLink` is the link's `SyncFn`; `autoSyncHook` is the session call hook (one sync shared by concurrent calls, skipped for `world_sync` itself and while disconnected); `server/index.ts` installs both. Tool `world_sync` in `server/tools/world.ts`. |
| Sync barrier and `overwriteHandEdits` (W6) | Q | Done in the cache. `Document.guards` (run before the scope layer's `guard`) holds `syncBarrier`, installed by the first sync (`attachSyncBarrier`); undo, redo and every step of `restore` (checked first, all or nothing) refuse `sync_barrier`. `undo`, `redo`, `restore` take optional `overwriteHandEdits`; `Document.overwriting` is true while such a step (or the whole restore, listeners included) applies, for the patch sender to set `force`. Undoing a sync that changed context positions stays refused even when forced (`outside_work_volume`: the agent never writes context). |
| Scope merges with synced positions (W7) | Q | Done. A fork records the parent's journal position; the merge check compares positions changed by `world_sync` entries since then at their pre-sync state. Those positions are **not written by the merge** (the world's block stays in cache and world), and are listed in `MergeResult.synced` and the `scope_merge` text (*Scoped sessions*). |
| Bridge client (W1) | P | Done. `src/world/bridge.ts`: pairing file from the located instance or its `.minecraft`/`minecraft` folder (setting `world.gameDir` overrides, for a dedicated server), hello with token and volatile list, version check (a mismatch names the side to update), requests matched by id (a `volumes.extend` success is the id-less `volumes`), reconnect with backoff re-reading the pairing file, an unreachable port names WSL mirrored networking. Nothing is queued across a disconnect: requests in flight reject with `world_disconnected`. A `replaced` error stops reconnecting. |
| Root scope (W2) | P | Done. `doc_open({ world: true })` (optional `name`, default `world`; `overwrite` for a workspace document that isn't a linked one) goes through `Session.linkWorld` to `LiveLink.open` (`src/world/live-link.ts`): a full snapshot of the work and context boxes into a new document re-origined to the work volume's minimum corner (no journal entry), whole-block extension with `scope/multiblock.ts` (a plugin multi-block past the context is snapshotted too) declared with `volumes.extend` before any patch, `Document.context` for the context, and `ScopeManager.root` for the sandbox write rule (`outside_work_volume`) and fork bounds. A new work volume or dimension relinks with a fresh journal (selections and cameras kept); with scoped jobs open it unlinks instead and says how to relink. A context-only change syncs the added boxes (snapshot) and the removed positions (cleared) in one `world_sync` entry. Clearing the work volume unlinks. Link changes that arrive during a call are applied after its body returns. Refusal `world_no_volume` when no work volume is set. Automatic linking (*Connection*): `LiveLink.autoLink` (wired in `server/index.ts` behind `world.autoLink`) retries the first connection, links on a work volume when allowed, and `ensureLinked` links on an in-game request (`InGameRequests.onPrompt` before the `no_link` check); one connection attempt at a time is shared with `doc_open`. Unit tests against the fake host: game started later, unlink and relink, another open document kept until a request, scoped jobs. |
| Patch sender (W3) | P | Done. `tapJournal` (`journal-tap.ts`) reads `doc.op`/`doc.undo`/`doc.redo` of the base document from the session's event fan-out, one batch per entry and one per `restore` (`Document.restoreListeners`); `world_sync` commits are skipped (`no-push.ts`). `patchBlocks` (`patch.ts`) gives world positions inside the work volume only, expected states, expected NBT hashes (volatile list: L's default plus the plugins' new optional `volatileKeys`), new states and NBT; `force` while `Document.overwriting`. Patches go out in journal order with the current `link`; while disconnected they are dropped and the result says so. |
| Ack handling (W4) | P | Done. Skipped blocks, normalized NBT (with the NBT the patch sent, `reconcile: true`, so it adds no entry) and the world's states at rejected positions (read back with a `snapshot` of those positions, never guessed) go through `applyWorldState` as one `world_sync` entry. The call that sent the patch waits up to `world.ackWaitMs` (1.5 s) for its acks; its result gains `world: N placed, N skipped (hand-edited), N rejected` (plus overwritten when forced, rejection reasons, disconnects); later acks go to the next result on the linked document. |
| Events (W8) | P | Done. `world.link`, `world.patch` (ack counts, or `dropped`) and `world.sync` (reason, changed, `jseq`) in `core/events.ts` and `12`, published through the base document's sink (so S's activity stream sees them on the fan-out). No viewer rendering yet (optional). |
| Mod skeleton, codec (M1, M2) | N | Done. `mod/`: Gradle subproject from NeoForge's ModDevGradle MDK (NeoForge 21.1.249, JDK 21 by toolchain; Gradle itself needs `JAVA_HOME` at JDK 17+), no registry content (`displayTest = IGNORE_ALL_VERSION`). Extension points in `dev.autosketch.mod.api` (`AutosketchSetupEvent` for message handlers, `/autosketch` subcommands, wand modes and patch status; `Bridge`, `LinkState`, `PatchStatus`). Java codec in `…protocol` decodes and re-encodes every golden vector byte for byte. JUnit (`./gradlew test`) and headless GameTests (`./gradlew runGameTestServer`). Since silo X's restructure (`14`, *Build layout*) the sources are split into `mod/common` (vanilla types only, loader calls through `platform/Platform`, enforced by a build check; the JUnit tests) and `mod/neoforge` (entry point, NeoForge events, client classes, GameTests in `mod/neoforge/src/gametest`); see `mod/README.md`. Protocol 2 (silo Y): the mod speaks version 2 only; the Java codec decodes and re-encodes every version-2 vector and the frozen version-1 vectors in `v1/` byte for byte (`GoldenVectorsTest`); the mod's `hello` lists `features` `modes`, `scan`, `volumes.set`; a hello in another version is refused `protocol_mismatch` and ops get an action-bar notice naming the older side (`BridgeServer.mismatchText`). |
| Volumes and wand (M3, M4) | N | Done. Volumes global, wand state per player (*Work and context volumes in-game*). Wand: since B1 (silo Y), any stack of `wandItem` (see the B1 row); left/right click set the current mode's corners (cancelled, so nothing breaks or is used), swap-hands cycles modes (work, context, then registered ones). `/autosketch mode\|pos1\|pos2\|show\|clear\|status\|notices` and `context add\|grow <n>\|clear`, op level 2; default context the work volume grown by 3, `grow` at least 1 (the seam), boxes clipped to the build height, total context capped (config `contextCap`). `volumes` sent after hello and on every change; `volumes.extend` checked (`stale_link`, `bad_extension`) and shown. Region tickets (not forced chunks, nothing saved) over the effective work volume and the context while a work volume is set and an MCP is connected; released on clear or disconnect, re-taken on reconnect. |
| Bridge (M10) | N | Done. Listens on `127.0.0.1` only (configured port or ephemeral), pairing file written atomically with a 32-byte `SecureRandom` token and deleted on stop; handshake checks (`not_ready`, `protocol_mismatch` with the mod's version, `bad_token` in constant time, 10 s deadline); a newer paired connection replaces the old (`replaced`); socket reader and writer threads, everything else on the server thread; requests strictly in order with deferral for multi-tick patches, id-less messages bypassing; `internal` for handler failures. Tested over real sockets in JUnit and end to end in a GameTest; `scripts/mod-bridge-smoke.ts` plays the MCP with L's codec against a running game (run against the live Craftoria server by silo R: all checks pass). Unverified: a vanilla client joining a server with the mod (on the user's client checklist, `docs/briefs/world/test-setup.md` section 3). |
| Feedback (M11) | N | Done. Outline particles (dust in each mode's colour, block-boundary edges, nearby points only) while holding the wand or after `/autosketch show`; the wand's mode on the action bar; `notice` messages and finished patches (`Autosketch: 1,204 placed, 3 skipped`, from O's `PatchStatus`) on the action bar for ops with notices on (`/autosketch notices on\|off`, default from config). `/autosketch status`: MCP, link, volumes, extension, context, pending and last patch. |
| Entities (M12) | N | Done for silo N: a GameTest links volumes, grows context, extends, holds and releases tickets and shows outlines around a pig and an armor stand, and checks they're alive, unmoved and the entity count unchanged. |
| In-game requests, mod (M13) | S | Done; the subcommands became modes with B6 (silo Y, row below). Package `…prompt`: `/autosketch ask <text>` and the configured `askAlias` (op level 2, skipped with a warning when the name is malformed or taken), `/autosketch focus clear`, `/autosketch log off\|mine\|all` (kept in the player's saved data, default `mine`). The wand's `focus` mode (gold outline) clips the focus box to the volume box it overlaps most (the effective work volume or a context box), with an action-bar warning. A `prompt` carries the player's dimension, feet and eye position, yaw (wrapped to [−180, 180)), pitch, facing, the crosshair block from a server-side raycast to `targetReach` (fluids looked through; state in canonical form, face) and the clipped focus box. Without a connection the player hears `no_link` at once. `prompt.result` goes on the asking player's action bar. `chat` goes to the named player (replies always, activity unless `off`) and to every other player with `all`; only op-level-2 players see agent output. Activity is dimmed, replies prominent, and lines wrap at 100 characters. JUnit for clipping, visibility and wrapping; GameTests for the prompt's context, refusals on the action bar and the log settings. |
| Protocol 2: modes, surface, `volumes.set`; `N`/`N−1` (B4, B6 wire) | Z | Done (wave 0), against the fake host; the mod side is silo Y's. *Versions and features* and the protocol-2 rows above. `src/world/protocol/`: `PROTOCOL_VERSION` 2 and `SUPPORTED_PROTOCOLS` [2, 1]; codec for `modes`, `features`, `mode`, `scan`, `unsupported_mode`, `volumes.set`, `volumes` `id`, `bad_volumes`, `snapshot`/`snapshot.result` kind `surface` (body in `body.ts`), all optional so version-1 frames round-trip; `modHas`, `helloModes`. Vectors regenerated (`generate.ts`; the hash vectors pinned to the starting volatile list they were cut with, so they stay frozen); version-1 frames kept in `v1/`. `src/world/bridge.ts`: hello in the pairing file's version when it is 2 or 1, else in 2 so the mod can name the older side; mismatch messages name the older side and what to update; a stale pairing file is retried; `supports(feature)` from the mod's hello; `volumes.set` (matched by `id`) and surface snapshots refused `world_mod_outdated` unsent when the mod doesn't list `volumes.set` or `scan`; hello `modes` from the option `modes`, default `["ask", "plan", "build"]` since enforcement landed (wave 1, B6 row). `src/world/prompt.ts`: a prompt in a mode the hello didn't list is refused `unsupported_mode` (no mode: `build`). Fake host: speaks 1 or 2 (`protocol`, `features`), records the MCP's modes and refuses other modes itself, scan grant, surface snapshots (ceiling, missing chunks), grant reads without volumes, `volumes.set` (default context, seam, `bad_volumes`, `wrong_dimension`); a version-1 host answers version-2 requests as the old mod would. Tests: `test/unit/world/protocol-versions.test.ts`. Scan, the probe and `world_volumes` landed in wave 2 (B4 row). |
| Request modes, enforced, MCP side (B6) | Z | Done (wave 1), against the fake host; the subcommands in the mod are silo Y's. `src/world/modes.ts`: `RequestModeRule`, a write guard attached to the linked document (on delivery, and by its call hook before every call, so a relink is covered; idempotent; refuses only while that document is the linked one) that refuses every guarded journal entry with `request_mode` while the open request is `ask`, `plan` or `scan`, and a call hook that refuses `VOLUME_TOOLS` (`world_volumes`) in `ask` and `plan`. The open request is `InGameRequests.current`, which now carries `mode`; read-only requests skip the idle close (`chat-stream.ts`). Since 2026-11-16 the rule reads the held read-only request instead (`InGameRequests.heldRequest`; row "B6: only the player ends a read-only request"). The channel event opens with the mode and `MODE_ALLOWS`' line; the channel instructions mention modes. `server/index.ts` installs `inGame.modeRule` in `Session.callHooks`. The bridge's default hello `modes` is `["ask", "plan", "build"]`. `request_mode` added to `12`'s refusal codes. Tests (`test/unit/world/prompt.test.ts`): an `ask` request's `fill` refused with the exact text, journal, world and patch log unchanged, while views, `select`, `checkpoint` pass and the activity line shows the refusal; `plan` refuses `undo` and a script's fill; the next request and a disconnect end the rule, after which edits pass (`done` no longer does, below); a read-only request outlives the idle time and a build request doesn't; the rule unit-tested for volume tools by mode, `scan` refusing edits, other documents, unlinking and `world_sync`. Not covered by a test: a scope merge refused during a request (it goes through the same guard). |
| Scan: probe document and `world_volumes`, MCP side (B4) | Z | Done (wave 2), against the fake host; the mod side (the subcommand, the grant, surface reads, `volumes.set`) is silo Y's. `src/world/probe.ts` (`loadProbe`, `probeText`), `src/world/set-volumes.ts`, the `world_volumes` tool in `src/server/tools/world-volumes.ts`, the scan branch of `InGameRequests.onPrompt` (no link needed; probe opened before the event; activity streams while the probe is open), `Session.adoptTemporary` (a temporary base document, never saved), and the hello's default `modes` now all four. Tests (`test/unit/world/scan.test.ts`): the probe holds the box's blocks and the surface skin, with the expected bounds, source, event text, `target` and `player` camera; edits refused `probe_read_only` with no patch; `view_slice` and a `top` render work; nothing saved; the ceiling asked from the feet when covered and written; a mod without the grant gets a probe-less event; `world_volumes` from probe coordinates sets the volumes, the link follows and replaces the probe, and the scan mode then holds on the linked document; padding and context boxes from linked coordinates; refusals with no document, without `volumes.set`, and in a plan request. The surface size bound in `surface-size.test.ts`. The Craftoria measurement was made with Y's mod (*Measured on Craftoria*, surface snapshots). |
| B1: the wand is any configured item, mod | Y | Done. `volume/Wand`: any stack of `wandItem` (Cloth Config, `[volumes]`, default `minecraft:blaze_rod`, an item id normalised with its namespace) is the wand; `WandControl` counts only the main hand and op level 2, and cancels both clicks, so a rod clicked on a brewing stand sets a corner and doesn't open it. The `custom_data` marker and `/autosketch wand` are gone (texts that named the command now name the rod, including the MCP's `world_no_volume` refusal and the `doc_open` description). GameTests: a plain rod sets corners for an op; a non-op's rod is untouched (the brewing stand opens, no corner) and a rod in the off hand does nothing; the op's click on the brewing stand through the game's own interaction path sets corner 2 without opening it. |
| B6: request modes as subcommands, mod | Y | Done. `/autosketch ask\|plan\|build <text>` and `scan [radius] [text]` (B4 row) send `mode` on `prompt` (`InGamePrompts.request`, built with the typed `Messages.Prompt`); a mode the MCP's hello doesn't list (`BridgeSession.modes`, `["build"]` when the hello has none) is refused on the action bar, `unsupported_mode`, and nothing is sent; the MCP's own `unsupported_mode` result shows the same way. `askAlias` is a short root for the four request subcommands (`/as build …`). GameTests: each subcommand's mode, ask and plan to a build-only MCP refused unsent, `prompt.result` `unsupported_mode`, the alias root. |
| B6: only the player ends a read-only request (`/autosketch done`, `prompt.close`) | — | Done (2026-11-16), mod and MCP; settled with the user, replacing the agent closing with `done`. **Wire:** the MCP's hello lists `features: ["prompt.close"]` (`MCP_FEATURES`, bridge option `features`); `prompt.close {player}` (mod → MCP) added within protocol 3, no bump; TS codec, Java codec (`McpHello.features`, `Messages.PromptClose`, `BridgeSession.features`), fake host (`mcpFeatures`, `playerDone`); vectors regenerated (`hello-mcp` lists the feature; `prompt-close`, `notice-prompt-closed` new; `v1/`, `v2/` unchanged). **MCP** (`src/world/prompt.ts`): `InGameRequests` holds the delivered read-only request (`heldRequest`) and the mode rule reads it; `world_reply` `done` closes the stream but not the hold, and its result says the mode stays in force; the hold ends on `prompt.close` (`onClose`, allowlist checked, answer as a `notice` to that player: ended, none open, not allowed), the next delivered request, or a disconnect. The `request_mode` refusal's last sentence now says only the player can end the request and the agent should tell the user at the terminal. **Mod** (`…prompt`): `/autosketch done` and `/<askAlias> done` (`InGamePrompts.done`) send `prompt.close` only when the session's MCP features list it, else `DONE_UNSUPPORTED` on the action bar; `no_link` without a connection. A `notice` to one player now shows whatever their notices setting (`Feedback.notice`). Tests: `test/unit/world/prompt.test.ts` (done keeps an `ask` mode with the exact refusal, journal and world unchanged, until `playerDone`; done on a `plan` request before any reply; a build request isn't ended by it and a player off the allowlist is refused; an MCP hello without the feature gets nothing sent; the next request and a disconnect end the hold, answered or not; refusal texts exact); Java golden vectors both sides; GameTest `doneIsSentOnlyToAnMcpListingPromptClose` (sent with the player, the alias root has it, refused on the action bar to an MCP without the feature, `no_link` disconnected). The e2e scenario (1) now checks the mode survives `done` and ends with the player's `prompt.close` (`onClose`, handed to the MCP as for `prompt`). Not checked in a client: the command, the alias and the notice on the action bar (test-setup.md, step 8). |
| B2: air mode, mod | Y | Done; the client half is unverified in a real client. `volume/AirMode`, `AirCommands`: `/autosketch air on\|off\|reach <n>` per player (default 5, at most 64, in memory until the server stops); the point is the block `reach` along the look from the eye, always computed on the server. Without the client half: right click into the air (NeoForge `RightClickItem`) sets corner 2, sneak+right click corner 1; a use that follows a click on a block within interaction range is left to the block click; the point is previewed as a white particle box for players whose client lacks the half. The client half (`client/AirClient`, loaded only with `Dist.CLIENT`): two optional custom payloads (`AirPayloads`: `autosketch:air_click` client → server, a left click into the air as corner 1 or a sneak+scroll distance; `autosketch:air_state` server → client, sent only when the client has the channel), and the point drawn as a line box while the wand is held and air mode is on. `displayTest` stays `IGNORE_ALL_VERSION`; the metadata no longer says server-side only. GameTest for the server path (air off untouched, sneak+right and right click corners, a block in reach ignored, the client message's corner 1). **To check in game (user):** with the mod on the client, left click into the air sets corner 1, sneak+scroll changes the distance (action bar), and the outline follows the look; a vanilla client still joins a server with the mod. |
| B4: scan, mod side | Y | Done. `/autosketch scan [radius] [text]` (a leading number is the radius) sends mode `scan` with the grant from `[scan]` config (`scanChunks` 4, `scanChunksMax` 12 with an action-bar warning when clipped, `scanBelow` 32, `scanAbove` 64, `scanCap` 4,194,304; `world/ScanGrants.size`, which reproduces the golden `prompt-scan` grant); the grant takes effect as the request goes out and lasts until the next scan, a disconnect or the server stopping. `world/SurfaceReads` serves `snapshot` kind `surface` inside the grant's columns (or the chunks the link keeps loaded): `WORLD_SURFACE` per column, the ceiling above `ceiling` (all-air sections skipped), a chunk that isn't loaded read from disk only when it is fully generated (never generated; otherwise listed in `missing`), sliced at 5 ms per tick, encoded off-thread, no ticket. Blocks snapshots inside the grant's box are served without volumes and without generating chunks (an addition to O's `WorldReads`). `volumes.set` (`VolumeManager.setFromAgent`): the default context, or the given boxes clipped and led by the seam box when none covers it; `bad_volumes` for a work volume outside the build height or a context over `contextCap`, `wrong_dimension`; a new `link` only when the work volume or dimension changes; answered by the `volumes` carrying its id; a notice to ops; a player's next work volume starts from the default context again. Tests: JUnit for the grant; GameTests for scan requests (unlisted mode refused unsent, defaults, clipping, the grant in force), surface and grant reads (against the heightmap, a ceiling, a far ungenerated chunk missing and still ungenerated, refusals) and `volumes.set`. Measured on Craftoria (*Measured on Craftoria*, surface snapshots). |
| Shared auto memory (B5) | Z | Done (wave 1), documentation only: `docs/briefs/world/test-setup.md` section 3, step 3 has the `autoMemoryDirectory` setting beside `--channels`, with its limits (not passed to subagents except forks; local to the machine). |
| In-game requests, MCP (W11) | S | Done against the fake host. `src/world/prompt.ts`: the allowlist (`world.promptPlayers`, UUIDs or names, plus the singleplayer host named in `hello`) runs first, then `no_link`, then `no_listener`. The context becomes local handles on the linked document: the `focus` and `target` selections (outside both volumes, or in another dimension, reported and not saved; in the context volume, saved and called read-only), and the camera `player` (eye − origin − 0.5, `lookTarget` from yaw and pitch, 70°). Handles a request doesn't carry are removed. One `notifications/claude/channel` event with the fixed text and `request`/`player` meta, then `prompt.result`. `createServer({ channel })` declares the experimental `claude/channel` capability and adds the channel instructions (wired in `server/index.ts`). `src/world/chat-stream.ts`: activity lines from the session fan-out (calls with their blocks, images and patch results; `world_sync` commits and `world_reply` itself left out), consecutive same-outcome calls merged, at most one message per `world.activityMs` (6 lines, the rest summed), listening only while the bridge is up. The `world_reply` tool (`server/tools/world-prompt.ts`, through `Session.inGame`) flushes activity, then sends the reply. `done` closes the stream, and so does `world.promptIdleMs` with no tool calls or the next request. A late reply still reaches the player who asked. |
| Patch applier (M5, M6) | O | Done. `mod/…/world/PatchApplier.java`: the steps of *Applying a patch* per position in index order: `stale_link` (link, volumes, dimension checked per position, so a relink mid-patch rejects the rest); `outside_volumes` for anything outside `LinkVolumes.effectiveWork()` (context included) or the build height; `unknown_state` unless the string is exactly the canonical printing of a known state (`States`); `bad_nbt` when the new block has no block entity, the `id` is missing, unknown or not valid for the block, or the game fails to load it (the block entity is built and loaded before anything is written); the precondition compares the printed world state and, with an expected hash, the hash of the world's block entity (missing or state-only never matches); `force` writes and counts `overwritten`; then the normalized check. Writes (`WorldBlocks.write`) go straight into the chunk section, as Axiom and WorldEdit paste, so neither the old block's `onRemove` (drops) nor the new one's `onPlace` (falling, flowing, redstone) runs; heightmaps, section emptiness, sky-light sources and a queued light check, block-entity removal and loading, POI, unsaved flag and the client update (`sendBlockUpdated`, no neighbour updates) follow. Entities are never touched. Chunks load synchronously when not yet loaded. A world block entity the ack can't encode fails the patch with `internal`. Hashing (`Hashing`, `VolatileKeys`) reproduces every case of `hash-nbt.json` and `hash-sections.json` (JUnit). GameTests: matching write, mismatch skip with the actual state, forced overwrite, chest skipped by NBT hash after its items changed, lit furnace with ticked burn time not skipped, unknown and non-canonical states rejected (never air), context, outside and stale rejections, `bad_nbt`, normalized list, sand doesn't fall, water doesn't flow, a broken chest drops nothing, light follows a patched light source, and an ack identical to L's fake host's on the same world and patch (`ParityGameTests`, the fake host's ack recorded in the test). |
| Ordering and budget (M7) | O | Done. Patches queue in id order and apply at the start of each server tick (and at once on arrival, with what is left of the tick's budget) under `tickBudget` blocks per tick (default 20,000 since silo R's Craftoria measurements, *Measured on Craftoria*; positions rejected without touching the world don't count), plus a 25 ms time cap per tick so a stamp full of block entities can't stall a tick. A patch in progress is visible part-way; its ack goes out when it finishes, and later requests wait for it (the dispatcher's order). A patch not started when its connection closed is dropped; the one in progress finishes. `PatchStatus` gives pending (queued plus applying) and the last ack's counts. GameTest: 100,000 blocks under a 10,000 budget take at least 10 ticks, a second patch applies after the first and sees its result. |
| Snapshots and section hashes (M8) | O | Done. `WorldReads`: `no_volumes`, `wrong_dimension`, `outside_volumes` (chunk columns of the work volume, extension and context), `too_large` (over a frame) checked first; then each tick copies chunk sections' state containers and the NBT of block entities inside the boxes for up to 5 ms of server time (at least one section), and the reply is encoded or hashed off-thread from the copies. Positions outside the build height read as air. GameTests: snapshot equal to the world with overlapping regions and cave air printed as air, section hashes equal to a per-position reading, refusals, a section above the build height. |
| Change tracker (M9) | O | Done, two detectors chosen by config `tracker` (`ChangeTracker`). `hook`: a mixin at the return of `LevelChunk.setBlockState` (every `Level.setBlock`: players, pistons, explosions, fluids, most mods); outside the volumes it costs a null check, a level check and one bounding-box test. `scan`: every `scanPeriod` ticks (default 20) each section under the volumes is compared with a baseline of its state ids, spread evenly over the period; it also sees writers that bypass `setBlockState`. With `tracker = "scan"` a mixin config plugin leaves the mixin out entirely (read from the config file at game start). `both` runs both, and is the default since silo R's Craftoria measurements (*Measured on Craftoria*). The mod's own writes bypass `setBlockState`, so the hook never sees them, and update the scan baseline as they happen. One `dirty` per tick at most, sent at the end of the tick with the world's state and NBT then, only positions inside the volumes; more than `dirtyCap` (≤ 4,096) positions send `everything`. GameTests, with the hook and with the scan: a piston push in the work volume and a block broken in the context are reported, a change outside both volumes and the mod's own write are not; a 4,851-block change sends `everything`. Whether Axiom's edits reach the hook is unverified (believed to write sections directly; the scan catches them either way). |
| End-to-end tier and measurements | R | Done on the headless Craftoria server (no vanilla NeoForge server run: it needs its own EULA acceptance; the vanilla side is the GameTests). `test/e2e/world/`: `server.sh` (start, stop, wait; RCON on, never touches the EULA), an RCON client, a harness wiring the real MCP server code as `server/index.ts` does against the server's pairing file, and `scenarios.test.ts` (opt-in: `AUTOSKETCH_E2E_SERVER` and an instance; `npm run test:e2e-world`): a distant reference box readable but not writable; a house by ops, script and stamp with world equal to cache; a hand edit synced before the next op and a contents-only edit skipped by the NBT hash; undo across a sync refused then forced; restore, relink and a re-opened document landing at the right world positions; fork and merge with a hand edit inside the lock kept; Create and FramedBlocks blocks with NBT copied by the agent; a server kill and restart (offline edits not replayed, relink from the world). The mod's volume commands also work from the console and RCON (`mode work\|context`, `pos1\|pos2 <x y z>`, `context add`). Measurements in *Measured on Craftoria*. Unverified (need a player): the in-game request through a Claude Code channel session with a render from the `player` camera, outline particles, the action bar, the wand and an Axiom hand edit (user checklist). |
| End-to-end scenarios for in-game requests (B4, B6) | Z | Done (wave 3) on the headless Craftoria server with silo Y's mod (the jar in `mods/` rebuilt from main and byte-identical in the changed classes). `test/e2e/world/requests.test.ts`, 4 scenarios, in R's tier (`npm run test:e2e-world`, which now runs its files one at a time, since each takes the one bridge): (1) an `ask` request's `fill` and a `plan` request's `run_script`, `undo`, `clear` and `world_volumes` are refused `request_mode` and the world keeps its blocks (read back with the mod's snapshot), `world_reply` done ends each (since 2026-11-16: done keeps the mode, and the player's `prompt.close` or the next request ends it), and a `build` request's edit reaches the world; (2) a `scan` prompt opens the probe from the mod's blocks snapshot and surface read (a tower in the box, grass as the surface outside it, no ceiling under open sky), a `top` render works, and `world_volumes` from probe coordinates sets volumes the mod confirms with its default context, after which the link follows over them and the scan mode holds on it; (3) `volumes.set` above the build height and with a context over `contextCap` are refused `bad_volumes`, and the volumes stay; (4) a fresh bridge pairs in protocol 2 with `modes`, `scan`, `volumes.set` listed, and a raw protocol-1 hello is refused `protocol_mismatch` with protocol 2. Results: the file passed 4/4 on three consecutive runs, and the whole tier 12/12 (R's 8 and these 4). **Limits:** a headless server has no player, and the mod sends `prompt` only for a player's command, so the scenarios hand the MCP the `prompt` a player's command would send and check everything after it against the real mod; for the same reason the scan reads are served inside a linked work volume with a matching grant, not under a grant the mod issued. The command side (subcommands, the grant, the mod's own `unsupported_mode`) is Y's GameTests plus the in-client checklist (`docs/briefs/world/test-setup.md`, step 8), as is air mode. `N−1`: the mod speaks only protocol 2, so a one-version-old *MCP* is refused by design; the MCP's own `N−1` (speaking 1 to an older mod) is covered against the frozen version-1 fake host (`test/unit/world/protocol-versions.test.ts`), since no protocol-1 mod build is kept. **Found and fixed:** a call refused by a hook's `before` (the mode rule refusing `world_volumes`) skipped the other hooks' `after`, so the world link counted the call as running forever: later results lost their `world:` line and link changes stayed deferred. `Session.runCall` now unwinds the hooks that already ran (unit test in `prompt.test.ts`). |
| Protocol 3: registry report and upgrades (`14`) | V | Done. Wire: `registry`/`registry.result`, `upgrade`/`upgrade.result`, features `registry` and `upgrade`; protocol-2 vectors frozen in `v2/`, both codecs check `v2/` and `v1/`. Mod: `data/RegistryReport`, `Upgrades`, `DataModule` (common), `DataEvents` (neoforge); the report is written at server start beside the pointer file and both requests run on a worker thread; the hello lists the two features when their handlers are registered; `PointerFile` removes reports with stale pointers, reports without a pointer, and this game's report when the pointer is off. GameTests (`DataGameTests`): the report's content and file, element and structure upgrades (1.19.4 sign and grass, a structure without DataVersion), and both requests over the bridge. MCP: `assets/report.ts` (file, order of trust, refresh on each connection), `formats/upgrade.ts`, `world/upgrade.ts`; fake host serves both. E2e on Craftoria: the tier 12/12 with the typed cogwheel written, and a 1.19.4 `.schem` upgraded through the real fixer (`test/e2e/world/upgrade-check.ts`). |
| B3: token spend in the viewer | K | Done, tested with synthetic OTLP batches built from the documented event shapes (`test/unit/observe/ui.test.ts`). `POST /v1/logs` (`src/observe/http.ts`, `otel.ts`): OTLP/HTTP JSON only (415 for protobuf, with a log line naming `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json`), gzip accepted, 16 MB cap, foreign `Origin` refused, live sessions only; each record is published unchanged as an `otel` event, so the log and replay carry it. The viewer's `Spend` (`viewer/js/model.js`, part of `SessionModel`, so replay rebuilds it at any seq): per-prompt totals by token type with `cost_usd` (exporter retries dropped by `session.id` + `event.sequence`), per-action labels on `call.end` feed rows (the issuing request's `output_tokens` split across the tool results it issued, and `tool_result_size_bytes`), tokens per job in the scope tree by `agent_id`. A Tokens panel in the Observe tab; with no records yet it shows the setup snippet from `/info` `otel.setup`, plus a warning while `observe.http` isn't pinned. `/autosketch` documenting the snippet is not done. The two *to confirm* points are unconfirmed (*Backlog*, B3). |

## Backlog

From the first in-world test on Craftoria (2026-11-15). Designs settled with the user (*Decisions*); B1, B2, B4, B5 and B6 are built (mod and MCP), see *Implementation status*. Points marked *to confirm* are checked while building; numbers marked as defaults are measured on Craftoria before they are fixed.

- **B1. The wand is any blaze rod, as WorldEdit's is any wooden axe.** WorldEdit's model: the wand is a configured item type (`wand-item`, default `minecraft:wooden_axe`), and any stack of that type is the wand, with no marker. While a player with the selection permission holds it in the main hand, left-clicking a block sets pos1 and right-clicking a block sets pos2. Both clicks are cancelled, so the axe never breaks the block, strips a log or opens the block. `//wand` only hands out the item. Follow it:
  - The wand item comes from config (`wandItem`, default `minecraft:blaze_rod`). Any stack of it is the wand; the `custom_data` marker and `/autosketch wand` go.
  - Only clicks with the rod in the main hand count, and only for op-level-2 players. Carrying rods, crafting with them or putting them in a brewing stand does nothing; clicking the brewing stand with the rod in hand sets a corner instead of opening it, as with WorldEdit's axe.
  - Mode cycling (swap-hands) and the action bar stay. M3 and the wand GameTests change (`Wand.create()` becomes a plain rod).
  - No Craftoria mod gives blaze rods a click action (checked by the user).
- **B2. Marking corners in the air, through the client half.** Corners can only be set on a block now, so marking a box in open space means placing guide blocks first. Add an air mode, toggled with `/autosketch air on|off` per player: a click into the air sets the corner at a point in front of the eye along the look vector, the way angel blocks place. The outline previews the point while the wand is held.
  - A left click into the air never reaches the server (`LeftClickEmpty` fires only on the client), so the mod's client half sends air clicks as a custom payload (registered optional), and sets the distance with sneak+scroll. It can later draw outlines and ghost previews properly instead of with particles.
  - Without the client half (another player on a dedicated server): right-click in the air sets corner 2 and sneak+right-click corner 1 (`RightClickItem` reaches the server), and `/autosketch air reach <n>` sets the distance.
  - `displayTest` stays `IGNORE_ALL_VERSION` so joining never fails on a mismatch. The `mods.toml` comment about server-side only goes.
- **B3. Token spend in the viewer, from Claude Code's OpenTelemetry.** Each prompt shows a running token total that counts up while the agent works, and each action in the log carries the tokens it took. The MCP never sees model tokens (`12`, *Metrics and evals*). The source is Claude Code's OpenTelemetry log events (Claude Code docs, *Monitoring usage*), and the visuals are built on its event names and attributes as they come, with no schema of our own on top. Hook input carries no usage and the transcript format isn't documented, so neither is used.
  - **Events used.** `claude_code.user_prompt` (`prompt_length`, `command_name`), `claude_code.api_request` (`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `cost_usd`, `model`, `request_id`, `query_source`), `claude_code.tool_result` (`tool_name`, `tool_use_id`, `request_id`, `success`, `duration_ms`, `tool_result_size_bytes`, `tool_parameters`, `tool_input`) and `claude_code.assistant_response` (`request_id`, `response_length`). Every event carries `prompt.id` (it links the `user_prompt` with the `api_request` and `tool_result` events that follow it), `session.id`, `event.timestamp` and `event.sequence`. Subagent events also carry `agent_id` and `parent_agent_id`.
  - **Setup** (shell or `~/.claude/settings.json`; a repo's `.claude/settings.json` can't set exporters): `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_LOGS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://localhost:47100/v1/logs` (the full URL, with the default `observe.http` port, or the user's own if they set one; the default protocol is `http/protobuf`), and `OTEL_LOG_TOOL_DETAILS=1`. Without that last flag, MCP calls show up as `tool_name: "mcp_tool"` with no arguments, and per-action matching is impossible. `OTEL_LOGS_EXPORT_INTERVAL` (default 5,000 ms) sets how live the count is; 1,000 suits the viewer. `/autosketch` documents the snippet, and the viewer says when no OTLP data has arrived.
  - **Receiving.** The viewer's HTTP server (`observe.http`) accepts OTLP/HTTP JSON at `/v1/logs` and appends each log record unchanged to the log as an `otel` event, so replay has it too. Ordering follows the docs: `event.timestamp`, then `event.sequence`.
  - **Prompt total.** The sum of `api_request` tokens sharing a `prompt.id`, shown per token type (input, output, cache read, cache write) with `cost_usd`, counting up as batches arrive.
  - **Per action.** A `tool_result` whose `tool_parameters.mcp_server_name` is autosketch is matched to our `call.end` by `mcp_tool_name` and `tool_input` (the call's arguments) in order (the MCP never receives the client's `tool_use_id`). Its `request_id` names the `api_request` that issued it. The label shows that request's `output_tokens`, split across the calls it issued, and the result's size. `input_tokens` grows with the whole context, so it isn't charged to one action.
  - **Subagents.** `agent_id` separates a `scope_fork` subagent's spend, so the scope tree can show tokens per job: the calibration data `11` wants for the delegation threshold.
  - **To confirm while building:** whether a channel event (an in-game request) starts a new `prompt.id` the way a typed prompt does, and that `tool_input` is the full arguments object (it is cut off at about 4K characters). *Both still unconfirmed* (silo K, 2026-11-16): checking them needs a live Claude Code session exporting to the viewer, which wasn't available while building. The viewer depends on neither: prompt totals key on whatever `prompt.id` arrives, and a `tool_input` that is cut off before it parses leaves the match to tool name, time window and order.
  - **Built** (silo K, 2026-11-16; *Implementation status*). Matching uses `call.start`'s new `input` (the call's top-level scalar arguments, `12`, *Kinds*): a `tool_result` pairs with the earliest unpaired `call.end` of the same tool that ended at most 2 s after and 120 s before the result's `event.timestamp` and whose scalar arguments agree with `tool_input` where both have them. A subagent's `agent_id` is tied to a scope by the `scope` argument of its matched calls. The free default port of `observe.http` changes every launch, so the notice asks the user to pin it.
- **B4. Volumes set by the agent (`/autosketch scan`).** Marking volumes by hand for every request is a chore. `/autosketch scan [radius] [text]` (mode `scan`, B6) asks the agent to set the work and context volumes from what it finds around the player, with an optional description of what to include ("the tower and the courtyard").
  - **Radius in chunks.** Scan gathers general background (terrain, neighbouring builds, roads, water) before the volumes are drawn, so it reaches well past a build: an optional radius in chunks around the player's chunk, default `scanChunks` 4 (9×9 chunks, 144 blocks across), capped at `scanChunksMax` 12 (25×25 chunks, 400 blocks across). A larger number is clipped with an action-bar warning. Chunk-aligned areas also match how the mod snapshots and tickets.
  - **Two layers, so a wide radius stays cheap.** A full column of 25×25 chunks is tens of millions of blocks, far past `contextCap`. So the probe has:
    - **Surface** for the whole radius: per column, the height and state of the topmost non-air block (a `MOTION_BLOCKING`-style heightmap), plus the same for the ceiling when the player is underground. About 160,000 columns at the maximum: small, and enough for a top-down map and a terrain render.
    - **Full blocks** in a box centred on the player, from `scanBelow` (32) under the feet to `scanAbove` (64) over them, as wide as the radius allows within `scanCap` (default `contextCap`, 4,194,304 blocks). At the default radius the whole area fits (144×144×96, about 2 M blocks).
    - Surface snapshots are a protocol addition (`snapshot` with a `surface` kind), measured on Craftoria before the defaults are fixed.
  - **Probe document.** Before any link, the MCP loads the probe into a temporary read-only document. The agent looks at it through the usual views (render, a top-down map of the surface, slices, the `player` camera), and nothing is written to the world.
  - **Setting volumes:** a new tool, for example `world_volumes({ work, context })`, sends a new `volumes.set` message, and the mod sets the volumes as if the player had marked them. Outlines show at once and linking follows as usual (`world.autoLink`).
  - **No accept step.** The agent's volumes are suggestions in place. The player refines them by scanning again with other words, by asking, or with the wand, and moves on whenever they are happy, by giving build instructions (`/autosketch build`).
  - The harness does no structural analysis of its own: the agent decides where the build ends, not the mod or the MCP.
  - **The probe as built** (`src/world/probe.ts`). On a `scan` prompt with a grant, before any link and without `ensureLinked`: a blocks snapshot of `scan.box`, then a surface snapshot of `scan.columns`. **Ceiling rule:** the player is *covered* when their own column holds a non-air block above their eyes within `scan.box` (a cave, or indoors); then the surface is asked with `ceiling` = the feet's y, so each column also reports the lowest non-air block at or above the feet (the cave roof or room ceiling). Reason: the box is already read, so this costs no extra request, and the feet's y makes the player's own ceiling the first block over their head. A covered player more than `scanAbove` under open air reads as uncovered (the surface is still read). The document `probe` holds the box's blocks (states and block entities) and, outside it, each column's surface block (and ceiling block) alone, so a `top` render is a map of the surface and iso renders show the land around. Local (0, 0, 0) is the north-west corner of the columns at the bottom of the box (a deep valley can lie at negative y). The `player` camera, and `target` and `focus` when inside the columns, are saved on it. It is the session's base document while it is open, through `Session.adoptTemporary`: never saved to the workspace, replaced by the next document opened (the previous one is saved and closed first, as for any switch; refused while scoped jobs are open, and the event says so). Every edit is refused with `probe_read_only`. When the grant is missing (a mod without the `scan` feature) or the read fails, the request is delivered anyway and the event says there is no probe and why.
  - **The scan event:** `In-game scan request from Kev: "the tower". Scan mode: … The probe is open as the read-only document "probe" (nothing is linked yet): the surface of 9×9 chunks (144×144 columns, local x 0–143, z 0–143), and full blocks in local (…)–(…) (W×H×D). [You are covered, so each column's ceiling from local y N up is in it too.] [N chunks aren't generated (empty columns).] Outside the full-block box each column holds only its top block: render({views:["top"]}) is a map of the surface. Set the volumes with world_volumes({work, context}) in this document's coordinates.` then the target, focus and camera lines and the `world_reply` line, as for other requests.
  - **`world_volumes({ work, context? })`** (`src/server/tools/world-volumes.ts`, through `Session.inGame`; `src/world/set-volumes.ts`). Boxes are in the open document's coordinates: the probe while it is open, else the linked document; with neither, refused `world_no_document`. `context` is boxes, `{ padding: n }` (the work volume grown by n), or omitted for the mod's default (+3). Sends `volumes.set` (refused `world_mod_outdated` unsent when the mod doesn't list it; the mod's `bad_volumes` and `wrong_dimension` come back as refusals) and reports the confirmed volumes in both coordinate systems and the link number. Linking follows through `world.autoLink`: the probe's source is `world:probe …`, so automatic linking replaces it like any world document. Allowed with no request open and in `scan` and `build` requests; refused `request_mode` in `ask` and `plan` (B6). Description: "Sets the player's work volume (where the build may change) and context volume (what you see around it) in the game, as if they had marked them with the wand. … Text, <80 tokens."
  - **Surface size.** A 25×25-chunk surface (160,000 columns) encodes to about 481 KB, or 928 KB with ceilings, for synthetic terrain at y 64–140 over 24 states (about 3 bytes a column: a two-byte height and a palette index); `test/unit/world/surface-size.test.ts` keeps it under 512 KB and 1 MB. Still to measure on Craftoria (with silo Y's mod): the time to read it.
- **B5. Agent memory is Claude Code's own auto memory.** In-game requests run in a Claude Code session, which already keeps auto memory (Claude Code docs, *Memory*): a `MEMORY.md` index (first 200 lines or 25 KB load at session start) and one file per fact with `type: user | feedback | project | reference` frontmatter, read and written with Claude's ordinary file tools. Autosketch adds no memory tools or format. What it needs is for every session that builds to use one store, wherever it was started:
  - Set Claude Code's `autoMemoryDirectory` to one shared path (for example `~/.autosketch/memory/`) in `~/.claude/settings.json`, or in the settings of the folder the in-game session is launched from. Without it, the store is keyed by the launch repository, so a session started elsewhere starts with no memory.
  - Document this in the in-game setup steps (`docs/briefs/world/test-setup.md`) alongside `--channels`.
  - Limits to keep in mind: auto memory isn't passed to subagents (except forks), so a `scope_fork` subagent doesn't see it unless its handoff quotes what matters; and it's local to the machine.
- **B6. Request modes as subcommands.** Instead of one `/autosketch ask` for everything, the subcommand names the request's purpose, the way Claude Code's permission modes (plan, default, auto) scope what the agent may do:

  | Command | Mode | The agent may |
  |---|---|---|
  | `/autosketch ask <text>` | `ask` | Answer questions. Read and look only: no edits, no volume changes. |
  | `/autosketch scan [radius] [text]` | `scan` | Look around and set the volumes (B4). No edits. |
  | `/autosketch plan <text>` | `plan` | Look and propose: a reply describing what it would build. No edits. |
  | `/autosketch build <text>` | `build` | Everything: today's `ask`. |

  - The mod sends `mode` in the `prompt` message, and the channel event opens with it (`In-game build request from Kev: …`) with one line saying what that mode allows.
  - **Enforced, not advised** (settled with the user). While a request in a read-only mode is open, the MCP refuses edits on the linked document with `request_mode` (naming the mode and the command to use instead), as Claude Code's plan mode blocks edits. `scan` may call only the volume tool; `ask` and `plan` may call neither. The mode is the player's choice of what may happen to their world, so it is a permission, not a heuristic, and *Advise, don't constrain* doesn't apply. Work prompted from the terminal isn't affected.
  - **What counts as an edit.** Every journal entry on the linked document: any `doc.edit`, script group, undo, redo, restore step or scope merge that runs the document's write guards, whatever tool, script or plugin action makes it. Only those entries become patches, so refusing them is exactly "nothing happens to the world". The refusal is a write guard on the linked document (beside the sync barrier), so no tool list can fall out of date; the edit is rolled back, never half-applied. Not edits: views and queries, saved selections, cameras and checkpoints (not journaled), exports, library and palette writes, and `world_sync` entries (the world coming in, which run no guards). **Drafts are refused too: read-only requests are text only** (settled with the user 2026-11-16). While an `ask`, `plan` or `scan` request is open, a call hook refuses `scope_fork`, `doc_new` and `doc_open` (`DRAFT_TOOLS`) and any mutating call addressed to an existing sandbox, with `request_mode`; looking at a sandbox and `scope_abandon` still pass. So `plan` proposes in words in a `world_reply`, and nothing is built anywhere, not even in a scratch copy. **Volume changes** are the volume tools (B4's `world_volumes`): refused in `ask` and `plan` by a call hook before the tool runs, allowed in `scan` and `build`.
  - **When a request is open.** From the moment the MCP delivers it (the channel event is sent and `prompt.result` says delivered). A **read-only** request (`ask`, `plan`, `scan`) holds its mode until the first of: the player's `/autosketch done` (or its form under the alias root, `/as done`; the mod's `prompt.close`), the next delivered request (which brings its own mode), or the game disconnecting. The agent's `world_reply` with `done: true` answers it (the reply is delivered and the activity stream closes, as for any request) but leaves the mode in force, and the reply's result says so. A read-only request does not close on `world.promptIdleMs` either: the idle close only routes activity, and a permission that lapsed during a slow turn would not be one. A **`build`** request closes as before: on `done`, the next request, a disconnect or the idle time. A `build` request, or no open request, changes nothing.
  - **Only the player ends a read-only request** (settled with the user 2026-11-16): the mode is the player's permission over their world, so only the player lifts it. The agent can't, even when the user at the terminal asks it to: the refusal tells the agent to say so, and the player (in singleplayer, the same person) ends it in game.
  - **Terminal work during an open request.** The MCP sees tool calls, not who prompted them, so while an `ask`, `plan` or `scan` request is open an edit typed at the terminal is refused too. The refusal says so: the agent answers the player with `world_reply`, and if the user at the terminal wants the edit, tells them that the player ends the request in game with `/autosketch done` (or by sending a new request).
  - **The refusal text**, for an edit: `The open in-game ask request (request 3 from Kev) allows reading and looking only, so fill can't edit the linked document. Nothing was written. To have it built, the player sends /autosketch build <text>. Answer with world_reply. Only the player can end this request, in game with /autosketch done or by sending a new request; if the user at the terminal wants this edit, tell them so.` (`plan`: "looking and proposing only"; `scan`: "looking and setting the volumes only".) For a volume tool in `ask` or `plan`: `… so world_volumes can't change the volumes. Nothing was sent. To have the agent set them, the player sends /autosketch scan [radius] [text]. …`
  - **The channel event** opens `In-game <mode> request from <player>: "<text>".`, then one line: `Ask mode: read and look only; edits and volume changes are refused while this request is open.`, `Plan mode: look, then propose what you would build in a world_reply; edits and volume changes are refused while this request is open.`, `Scan mode: look around and set the volumes with world_volumes; edits are refused while this request is open.`, or `Build mode: you may edit the linked document.` A prompt without `mode` (a version-1 mod) is a `build` request.
  - **Listed modes.** The MCP's `hello` lists all four by default: `ask`, `plan` and `build` since enforcement (wave 1), `scan` since the probe and `world_volumes` (wave 2).
  - **`/autosketch done`** (settled with the user 2026-11-16, replacing the agent closing a read-only request with `done` when the user at the terminal asked). The mod sends `prompt.close` (*Message schemas*), only to an MCP whose hello lists the feature `prompt.close`, otherwise it tells the player on the action bar that the MCP needs updating; the MCP ends the open read-only request and answers on the player's action bar, saying which request it ended or that none was open. Reason: the mode is the player's permission over their world, so only the player lifts it. (Drafting in a sandbox during a read-only request was answered by the user: refused, above.)
  - **Compatibility:** an MCP that doesn't know `mode` would ignore it and treat an `ask` as a build. So the MCP's `hello` lists the modes it supports, and the mod refuses a mode not on the list (`unsupported_mode` on the action bar).
  - Aliases: the config's `askAlias` becomes a short root (for example `/as build …`, `/as done`) instead of an alias for one subcommand.
  - M13 and W11 change.

## Open questions

- **Channel availability.** Channels are a Claude Code research preview. *Answered in part:* the MCP can't tell whether a session will receive an event. The client's capabilities at initialize don't say whether the session loaded the server as a channel, notifications aren't acknowledged, and Claude Code drops events silently when the channel isn't loaded (Claude Code docs, *Channels reference*). So `no_listener` is sent only when no client has initialized, and otherwise delivery is optimistic: the player can be told "delivered" for a request no session sees. Still open: what other clients should get instead. A later option is an Agent SDK host that runs requests without a terminal session.
- **The agent's own text.** Streaming the agent's full response, not just what it sends through `world_reply`, would need something outside the MCP, such as a Claude Code hook that forwards each finished turn. Worth it?
- **Permission relay.** Should the requesting player be able to approve the agent's tool use from the game?
- **Modded states the asset registry gets wrong.** The MCP canonicalizes a typed block from the instance's blockstate files (`02`). Mods often leave properties out of those files when they don't change the model (Create's `waterlogged`, FramedBlocks' `solid`, `glowing`, `propagates_skylight`), so `set_blocks` with `create:cogwheel` sends `create:cogwheel[axis=y]` and the game rejects it as `unknown_state` (found by silo R; the world stays as it was and the cache is re-read, so nothing is lost). Blocks that came from the world (snapshots, syncs) carry the game's full state and round-trip fine. *Decided 2026-11-16, built (silo V):* the mod's registry report (`14`, *Version-specific data lives in the mod*) gives the MCP every block's full property set, so typed blocks are completed from the game's own definitions: with the report, `set_blocks create:cogwheel` sends `create:cogwheel[axis=y,waterlogged=false]` and the game writes it (e2e scenario on the Craftoria server). Learning from seen states and asking per block were set aside: the first misses blocks not yet seen in the world, the second works only while linked.
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

Settled with the user on 2026-11-15 (Backlog):

- **The mod has an optional client half** (*Principles*, M2, B2). Reason: autosketch serves one player building, and in singleplayer the game's built-in server and the client run in one game, so a server-only rule only cost features (left clicks in the air) without buying anything.
- **The wand follows WorldEdit** (B1): any stack of the configured item, default the blaze rod, with no marker and no command.
- **Token figures come from Claude Code's OpenTelemetry as-is** (B3), with no schema of our own.
- **Memory is Claude Code's auto memory, pointed at one shared directory** (B5), not an autosketch format.
- **`/autosketch scan` sets volumes with no accept step** (B4): an optional radius in chunks, wide by default because scan gathers background; the player refines and proceeds when happy.
- **Requests carry a mode named by the subcommand** (B6): `ask`, `scan`, `plan`, `build`, enforced by the MCP, not advisory.
- **Only the player ends a read-only request** (B6, 2026-11-16): with `/autosketch done`, a new request, or by disconnecting; the agent's `done` answers it but keeps the mode. Reason: the mode is the player's permission over their world, so only the player lifts it.
- **No playback pacing.** Patches keep applying as fast as `tickBudget` allows; they are not slowed down to show an action building up. Reason: each action already reaches the world as its own patch, and pacing would only add wall time: syncs and snapshots queue behind a paced patch (a half-written section can't be read as the truth), and acks would miss the call that caused them. Steps inside one action (a script's loop) would need partial patches mid-op, an engine change not worth making.
