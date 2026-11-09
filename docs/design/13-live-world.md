# 13 — Live World Link

Lets the agent build directly in the world the player has loaded, while the player keeps placing and tweaking blocks by hand. The agent's edits appear in the world op by op, and the player's hand edits reach the agent automatically. Nobody carries schematic files back and forth or types commands per action.

Two pieces make it work: a **companion mod** in the game, and a **world link** in the MCP server that connects a document to part of the loaded world. The player marks that part in-game as a **work volume** and a **context volume**, the same two volumes a sandbox has (`11`): the linked document is the root scope of the session, and the player sets its volumes the way a parent agent sets a subagent's. The player then asks the agent for work from inside the game, pointing at what they mean (*Prompting from the game*), which starts the root agent on that work volume.

## Principles

- **The world is authoritative; the document is a cache.** The MCP keeps a local copy of the work and context volumes because every tool (selections, perception, scripts, scopes, the journal) runs on the in-memory document, and a block-by-block round trip to the game per query would be far too slow. The copy never wins a disagreement: whenever world and cache differ, the world's value replaces the cache's.
- **The toolset doesn't change.** Tools keep acting on the document. The link sits beside it: it turns committed journal entries into patches for the world and brings world changes into the cache. No tool knows whether its document is linked.
- **One scope model, from the world down.** The player-set volumes are a scope like any sandbox (`11`): the agent writes only inside the work volume, reads the context volume, and everything the link watches lies inside the two. Player edits outside both volumes are none of the link's business. Subagents fork from the root scope exactly as they fork from any base document.
- **Never destroy a hand edit silently.** Every block the MCP sends carries the state it expects to replace (and, for blocks with a block entity, a hash of the NBT it expects). The mod only writes where the world still holds that state (a per-block **compare-and-set**, with the expected state as the **precondition**), and reports every block it skipped. Overwriting hand edits always needs an explicit request. This is the "strictly non-destructive" condition `12` set for writing into a live world.
- **Server-side only, no new content.** The mod registers no blocks or items, so it runs in singleplayer (the game's built-in server) and on a dedicated server without clients installing anything.
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
- **Version check:** hellos carry the protocol version, the game version and data version, and the mod version. A mismatch is reported, not guessed around.
- **Lifecycle:** the MCP reconnects when the game restarts, and the link resumes with a sync of the sections whose hashes differ (a full snapshot if the work volume changed meanwhile, which is a relink). Patches queued while disconnected are discarded, not replayed: the next sync makes the cache match the world, and the agent sees the result.
- **Permissions:** commands and the wand require op level 2 (cheats on, in singleplayer).

### Messages

| Direction | Message | Contents |
|-----------|---------|----------|
| both | `hello` | protocol version, token and volatile-key list (MCP → mod), game/data/mod versions (mod → MCP) |
| mod → MCP | `volumes` | dimension, work volume box, context boxes, or none (on change and after hello) |
| MCP → mod | `volumes.extend` | link, the work volume extended to whole blocks (*Model*: a box that cuts a door or multi-block) |
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

Field names, types and encodings are in *Wire format*, *Message schemas*.

## Wire format

Protocol version **1**. This section and the golden vectors in `test/data/world-protocol/` are the whole contract between the mod and the MCP: either side can be written from them alone. The TypeScript reference is `src/world/protocol/` (codec, hashing, pairing file) and `test/support/fake-host.ts` (the mod's side, in memory), but nothing here needs them.

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
- **Messages with a body:** `patch`, `snapshot.result`, `patch.ack` and `dirty` (unless `everything`). Every other message has an empty body.
- **Headers** are written compact (no whitespace), keys in the order the tables below list them, optional fields omitted when absent. Receivers accept any key order and ignore keys they don't know (a later minor addition stays compatible within version 1). Compare headers as JSON values, not as bytes: number formatting differs between JSON libraries.
- **Ordering:** TCP keeps frames in order. Each side sends messages in the order the events happen. The mod handles **requests** (MCP messages with an `id`: `volumes.extend`, `hashes`, `snapshot`, `patch`) strictly in arrival order, each finishing before the next starts: a `snapshot` or `hashes` request that arrives while a patch is still applying across ticks is answered after that patch's ack, so it sees the patch. Messages without an `id` (`notice`, `chat`, `prompt.result`, `error`) don't wait behind a multi-tick patch; the mod may handle them as they arrive. From the mod, `dirty`, `volumes` and `prompt` may interleave with responses.
- **Request ids:** `volumes.extend`, `hashes`, `snapshot` and `patch` carry an `id` the MCP assigns from one counter per connection, starting at 1 and increasing by at least 1 per request (so patch ids increase, and patches apply in id order). Their responses (`hashes.result`, `snapshot.result`, `patch.ack`, or `error`) carry the same `id`. A `volumes.extend` that succeeds is answered by a `volumes` message (which has no id), and one that fails by an `error` with its id. `prompt` ids come from the mod's own counter; a `prompt.result` carries the prompt's id in its `id` field, and a `chat` carries it in its `request` field.

### Connection and handshake

1. The mod starts listening when the server starts (singleplayer: when the world opens; dedicated: at startup), on the configured port or an ephemeral one, bound to `127.0.0.1` only, and writes the pairing file. It deletes the file when the server stops.
2. The MCP reads the pairing file, checks `protocol`, connects to `host:port` and sends `hello` with the token and its volatile-key list.
3. The mod checks, in order: the first frame is a `hello` (else `error` `not_ready`, close); `protocol` equals its own (else `error` `protocol_mismatch` carrying its own version in `protocol`, close); `token` equals its token, compared in constant time (else `error` `bad_token`, close). The handshake must finish within 10 seconds of connecting, or the mod closes the socket.
4. The mod replies with its own `hello`, then immediately sends `volumes`.
5. The MCP checks the mod's `hello`: on a `protocol` other than its own it reports the mismatch to the agent and closes. It never guesses around a mismatch (*Version check*). The `game.dataVersion` is the MCP's to compare with its documents.
6. **One connection at a time.** When a new connection completes the handshake, the mod sends `error` `replaced` to the old one and closes it. A restarted MCP therefore takes over without waiting for the old socket to time out (M10).
7. **Disconnect.** Either side may close at any time. The mod discards queued patches it hasn't started and finishes the one in progress (its ack is lost; the next sync reconciles). It keeps the volumes and the chunk tickets of the current link until the server stops or the player clears the work volume, so a reconnecting MCP finds the same volumes.

The framing, the `hello` fields `type`, `protocol` and `token`, and the `error` message keep their meaning in every future protocol version, so a mismatch is always reported clearly.

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
| `protocol` | integer | The mod's protocol version. The MCP refuses to connect on a mismatch and says which side to update. |
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

For a `patch.ack` the grid covers the skipped, rejected and normalized positions together, and the reason table is in first-use order over the rejected list. A snapshot region's positions are its box's own grid (origin = box min); a snapshot carries no `origin` or `size`.

A decoder checks every index against its grid and table, every count against its header, and that the body is fully consumed; anything else is `bad_request`.

### Message schemas

Every header has `type` first. "MCP → mod" and "mod → MCP" say who sends it.

**`hello`**, MCP → mod

| Key | Type | Meaning |
|---|---|---|
| `type` | `"hello"` | |
| `protocol` | integer | `1` |
| `token` | string | From the pairing file |
| `client` | `{name, version}` | `{"name":"autosketch","version":"1.0.0"}` |
| `volatile` | object | The volatile-key list (*Hashing*). May be `{}` |

**`hello`**, mod → MCP

| Key | Type | Meaning |
|---|---|---|
| `type` | `"hello"` | |
| `protocol` | integer | `1` |
| `mod` | `{version}` | The mod's version |
| `game` | `{version, dataVersion, loader, loaderVersion}` | e.g. `"1.21.1"`, `3955`, `"neoforge"`, `"21.1.249"` |
| `singleplayer` | boolean | True on the integrated server of a singleplayer world |
| `host` | `{name, uuid}` or `null` | The singleplayer host (the allowlist default, *Allowed players*); `null` on a dedicated server |

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

**`volumes`**, mod → MCP: after `hello`, and whenever the work volume, the context or the dimension changes.

| Key | Type | Meaning |
|---|---|---|
| `type` | `"volumes"` | |
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

**`snapshot.result`**, mod → MCP, with a body

| Key | Type | Meaning |
|---|---|---|
| `type`, `id` | | |
| `dimension` | string | |
| `regions` | Box[] | The boxes read, in request order (for `sections`, each section's box) |

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

**`prompt.result`**, MCP → mod

| Key | Type | Meaning |
|---|---|---|
| `type`, `id` | | The prompt's id |
| `delivered` | boolean | |
| `reason` | string | Only when not delivered: `no_link` (no linked document), `not_allowed` (not on `world.promptPlayers`), `no_listener` (no agent session will receive it) |

When the mod has no connection at all, it tells the player `no_link` itself.

**`notice`**, MCP → mod

| Key | Type | Meaning |
|---|---|---|
| `type` | `"notice"` | |
| `text` | string | Action-bar text |
| `player` | UUID or `null` | One player, or `null` for every op with notices on |

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
  "minecraft:brewing_stand": ["BrewTime"] }
```

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

`test/data/world-protocol/` holds one complete frame per file (`<name>.bin`, length prefix included) with a sidecar `<name>.json`:

- `description`, `sender` (`"mcp"` or `"mod"`), and `header`, the frame's JSON header exactly.
- `body`, for messages with a body: the decoded content in encoded order. Patches list `blocks` with world `pos`, `expected`, `expectedNbtHash`, `state` and `nbt`; acks list `skipped`, `rejected` (with `reason`) and `normalized`; dirty notices list `blocks`; snapshot results list each region's `states` (palette indices) and `blockEntities`. The `palette` (and `reasons`) tables are given too, in their encoded order. NBT is written as SNBT (the game's `TagParser.parseTag` reads it).
- `generated`, instead of `body`, for `patch-large`: the rule that produces its blocks.

There is a vector per message kind: `hello` both ways, `error` (including a refused extension and `internal`), `volumes` (with and without a work volume, and with an extension in force), `volumes.extend`, `hashes` and its result, `snapshot` by boxes and by sections, `snapshot.result` (empty, one block, mixed palette with block entities and overlapping regions), `patch` (empty, one block, mixed palette given out of order, block entities with expected NBT hashes, forced, large), `patch.ack` (all applied, mixed, forced, stale), `dirty` (positions, everything), `prompt` (full and minimal), `prompt.result` (delivered, refused), `notice` and `chat` (activity, reply). Hash vectors: `hash-nbt.json` (compounds with their volatile lists, canonical bytes in hex and hash: empty, unordered keys, nested, every tag type, modified UTF-8, furnace with and without volatile keys, a nested path and `*`, state only) and `hash-sections.json` (sections with their boxes and blocks and expected hash: full, a single position, negative coordinates with partial overlapping boxes, block entities with volatile and state-only types).

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

- `/autosketch ask <text>` sends a request. The command is long on purpose so it can't clash with other mods; the config can register a short alias.
- **Focus box:** the wand's focus mode marks a focus box, the in-game counterpart of a selection. It must lie inside the work or context volume (it is clipped to them, with a warning), so it can point at something to change or at something to match. `/autosketch focus clear` removes it.
- The mod attaches the **game context** to every request: the player's position, eye position and facing (yaw and pitch), the block under the crosshair (state and the face looked at, up to a configurable reach), and the focus box if any. All world positions; the MCP converts them.
- The action bar says when the request was delivered, or why not: no link, not allowed, no agent session listening.

**In the MCP:**

- **Delivery through Claude Code channels.** The MCP server declares itself a channel and pushes each request into the running Claude Code session as a channel event, the way Claude Code's Telegram and Discord bridges do. Channels are a Claude Code feature (a research preview at the time of writing): the session must be started with the server named in `--channels`, and other MCP clients get the world link without in-game prompting. When the MCP can tell that no session will receive the event, it refuses the request so the player hears about it.
- **Context as handles, not coordinates.** Before pushing the request, the MCP converts the context to document-local coordinates and saves it on the linked document as saved selections: `focus` (the focus box) and `target` (the crosshair block), replaced by each request. It also saves the player's view (eye position, yaw and pitch) as the saved camera `player` (`06`, *Cameras*), so `render({ views: [{ camera: "player" }] })` shows roughly what the player sees. The server doesn't know the client's field of view, so the camera uses the game's default of 70°. The event text names them, so the agent works with `{"saved": "focus"}` rather than raw numbers (*Semantic handles over coordinates*, `ARCHITECTURE.md`). Focus and target outside both volumes are reported as outside and not saved, since the agent can't see there. In the context volume they are saved and marked read-only.
- **The event text** is short and fixed in shape, and opens with the same handoff facts a fork gives a subagent (`11`): work volume size, context volume, the scope to address. For example: `In-game request from Kev: "put a balcony here". Work volume 32×24×32, context +3 and 1 reference box (scope "base"). Looking at minecraft:oak_planks (south face), saved as "target". Focus box 5×3×2, saved as "focus". Standing at (10, 5, 8) facing north; your view is saved as camera "player".`
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
| M5 | Conditional patch applier (per-block compare-and-set): per-position expected-state and expected-NBT-hash check (volatile keys excluded), skip and report state and NBT on mismatch, reject unknown states. |
| M6 | Writes without neighbour updates, physics or drops; replaces block entities with the patch's NBT. |
| M7 | Applies patches in order under a configurable per-tick block budget. |
| M8 | Snapshots of the work and context volumes, whole or by chunk section: states and block-entity NBT. Per-section hashes on request. |
| M9 | Change tracker: reports changes inside the work or context volume that aren't its own patch writes, from any source (players, Axiom, pistons, explosions, fluids). Ignores everything outside both. |
| M10 | Localhost socket with token pairing through `config/autosketch-bridge.toml`; version check in hello; survives MCP restarts. |
| M11 | Action-bar notices and outline particles, toggleable. |
| M12 | Leaves entities alone. |
| M13 | `/autosketch ask <text>` (with an optional configured alias) and `/autosketch focus clear`; focus box set in the wand's focus mode, clipped to the work and context volumes; game context (position, eye position, facing as yaw and pitch, crosshair block and face, focus box) attached to each `prompt`; delivery result on the action bar; `chat` lines shown to their target, styled by kind; `/autosketch log off|mine|all`. |

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
| W11 | In-game requests: declared as a Claude Code channel; allowlist (`world.promptPlayers`); context converted to local coordinates and saved as the `focus` and `target` selections and the `player` camera; one channel event per request, opening with the handoff facts; `prompt.result` back to the mod; activity stream from the event feed (coalesced, rate-limited) and the `world_reply` tool, sent as `chat`; request streams closed by `done` or idle time. |

## Implementation status

Work is split into silos in `docs/briefs/world/`. Suggested order: protocol, hashing and fake host (W9, W10), then the MCP side (W1–W8, W11) tested against the fake host, then the mod (M1–M13), then end-to-end tests in a Craftoria save.

| Part | Silo | Status |
|---|---|---|
| Wire format, golden vectors, codec, hashing (W10), fake host (W9) | L | Done. *Wire format* above, including `volumes.extend` for the MCP's whole-block extension of the work volume; vectors and hash vectors in `test/data/world-protocol/` (regenerate with `npx tsx test/data/world-protocol/generate.ts` only for a protocol change); codec, frame reader, hashing and pairing file in `src/world/protocol/`; fake host in `test/support/fake-host.ts` (handshake, patches limited to the effective work volume, invalid messages answered by id, build height read as air, compare-and-set with NBT hashes, normalized list, dirty notices, section hashes, snapshots, prompts, `volumes.extend` (link and containment checks, reset on a new link), and hooks for player edits, ticks, volume changes, dropped connections and restarts; no tick budget or chunk loading). A one-million-block patch encodes in about 0.1 s to 3.0 MB. The volatile-key default is the small starting list; growing it stays open (*Volatile keys*). |
| Sync primitive, section-hash sync, `world_sync` tool, auto-sync (W5) | Q | Done against the fake host, with a minimal test link over P's `Bridge` (P's link implementation still to wire in). `src/world/sync.ts`: `applyWorldState` (whole/section snapshot form filtered to the volumes, partial form from `dirty` or an ack, NBT-only form for `normalized`, clearing removed context) writes one `world_sync` entry raw and through `Document.editUnguarded`, so locks and the root write rule don't apply; positions that already match (NBT by content, volatile keys ignored) are left alone, so an unchanged world adds no entry; the result counts blocks changed per component. With `reconcile: true` (ack handling), the normalized list is reconciled in place without an entry (the redo-tail answer, *World undo and restore*). `syncBySections` compares section hashes and snapshots only differing sections; cache hashes are kept per document and invalidated per section by `VoxelStore.onWrite`. `syncLink` is the link's `SyncFn`; `autoSyncHook` is the session call hook (one sync shared by concurrent calls, skipped for `world_sync` itself and while disconnected); `server/index.ts` installs both. Tool `world_sync` in `server/tools/world.ts`. |
| Sync barrier and `overwriteHandEdits` (W6) | Q | Done in the cache. `Document.guards` (run before the scope layer's `guard`) holds `syncBarrier`, installed by the first sync (`attachSyncBarrier`); undo, redo and every step of `restore` (checked first, all or nothing) refuse `sync_barrier`. `undo`, `redo`, `restore` take optional `overwriteHandEdits`; `Document.overwriting` is true while such a step (or the whole restore, listeners included) applies, for the patch sender to set `force`. Undoing a sync that changed context positions stays refused even when forced (`outside_work_volume`: the agent never writes context). |
| Scope merges with synced positions (W7) | Q | Done. A fork records the parent's journal position; the merge check compares positions changed by `world_sync` entries since then at their pre-sync state. Those positions are **not written by the merge** (the world's block stays in cache and world), and are listed in `MergeResult.synced` and the `scope_merge` text (*Scoped sessions*). |

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
