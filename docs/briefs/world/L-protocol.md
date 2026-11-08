# Silo L: Protocol and fake host

**Wave 0.** Every other silo builds against what this one freezes. Keep it small and land it fast: the protocol doc and golden vectors first, the codec and fake host right after.

**Specs:** `13` (*Connection*, *Messages*, *Agent → world*, *World → agent*), `01` (inclusive boxes, canonical block states), `04` (block-entity NBT in the document), `08` (how the formats encode palettes and NBT; reuse what fits).

## Goal

A wire protocol that both a TypeScript client and a Java mod can implement from the spec alone, a reference codec, and a fake in-game host good enough that silos P and Q never need a running game for their unit tests.

## Deliverables, in merge order

1. **`13` gains a *Wire format* section** that settles everything the *Messages* table leaves open:
   - Framing: length prefix width and byte order, maximum frame size, how a binary body follows a JSON header.
   - The JSON schema of every message in the table, with field names and types. Request/response pairing (`snapshot` ↔ `snapshot.result`, `patch` ↔ `patch.ack`): by id.
   - The binary encoding of patch and snapshot bodies (palette plus packed positions, `13`). Positions as world coordinates in patches, relative to the work volume's minimum corner in snapshots, or both relative: pick one and say why. Block-entity NBT as uncompressed binary NBT (big-endian, as the game writes it), one compound per position.
   - Block-state strings: the exact canonical form both sides use (namespace always present, properties sorted by name, as in `01`). The mod parses and prints this form; the MCP never sends anything else.
   - `dirty`: the cap on listed positions before it becomes "everything".
   - `volumes`: dimension, the work volume box and the context boxes; `hello` from the mod also says whether the server is singleplayer and who the host is (silo S's allowlist default).
   - `prompt`, `prompt.result` and `chat` (`13`, *Prompting from the game*): the game-context fields (position, eye position, facing as yaw/pitch plus cardinal, crosshair block position, state and face, focus box), all in world coordinates; refusal reasons as fixed codes (`no_link`, `not_allowed`, `no_listener`).
   - Protocol version `1`, and what each side does on a mismatch (report and refuse, `13`, *Version check*).
   - Pairing file format: the exact keys in `config/autosketch-bridge.toml`.
   - **Hashing** (`13`, *Expected NBT hash*, *Section hashes*): the canonical NBT form (keys sorted recursively, position keys and volatile keys removed, binary NBT), the hash function and width, and the section hash (which positions, in what order, how states and NBT hashes are combined, how air and sections only partly inside the volumes are handled). It must be implementable in Java and Node with no extra dependencies: SHA-256 truncated to 64 bits (`MessageDigest` and `node:crypto`) is the suggested default; pick something else only with a measured reason. The volatile-key list format sent in `hello`: per block-entity type, keys to drop, or "state only".
2. **Golden vectors** in `test/data/world-protocol/`: one binary file per message kind (several for patch and snapshot: empty, one block, mixed palette, block entities, a large patch), each with a `.json` sidecar describing the decoded value. Hash vectors: NBT compounds (nested, unordered keys, lists, with volatile keys present) with their expected hash, and a few sections with their expected section hash. Synthetic content only (main README, *Legal stance*). The mod's tests (silos N, O) decode and re-encode these byte for byte.
3. **TypeScript codec** in `src/world/protocol/`: encode and decode every message, streaming frame reader over a socket. Unit tests against the golden vectors, plus round-trip property tests.
4. **Hashing** (W10) in `src/world/protocol/hash.ts`: canonical NBT, NBT hash, section hash, the built-in default volatile-key list (start small: furnace-family burn and cook times, hopper cooldown, brewing time; silo R grows it), tested against the hash vectors.
5. **Fake host** (W9) in `test/support/fake-host.ts`: listens on a localhost port, writes a pairing file into a temp instance folder, holds an in-memory world (`Map` of world position → state and NBT), and implements the mod's side of every message exactly as `13` specifies the mod's rules: the patch precondition (per-block compare-and-set) including NBT hashes, skip and report, reject unknown states (a configurable known-state set), `dirty` notices, `hashes` and section snapshots. Test hooks: `playerAsk(player, text, context)` (sends a `prompt`, records the `prompt.result`), `playerSet(pos, state)` (marks dirty), `playerSetNbt(pos, nbt)` (contents-only change: not dirty, as in the real mod), `tick(pos, nbt)` (a volatile-key change), `setVolumes({ work, context } | null)`, `dropConnection()`, `restart()` (new token and port), `knownStates`, and a patch log for assertions.

## Files you own

- New: `src/world/protocol/**`, `test/support/fake-host.ts`, `test/data/world-protocol/**`, `test/unit/world/protocol*.test.ts`.
- The *Wire format* section of `13`.

## Done when

- A second implementer could write the Java side from `13` and the golden vectors alone, without reading TypeScript. Ask someone from silo N to review the *Wire format* section before merging.
- The codec round-trips every golden vector byte for byte, and every hash vector matches.
- A fake-host test runs the full happy path: hello, volumes, snapshot, patch with one skip on a failed precondition, ack, dirty.
- Encoding a one-million-block patch takes well under a second, and the encoded size is reported in the test output.
