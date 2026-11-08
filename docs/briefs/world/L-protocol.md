# Silo L: Protocol and fake host

**Wave 0.** Every other silo builds against what this one freezes. Keep it small and land it fast: the protocol doc and golden vectors first, the codec and fake host right after.

**Specs:** `13` (*Connection*, *Messages*, *Agent → world*, *World → agent*), `01` (inclusive boxes, canonical block states), `04` (block-entity NBT in the document), `08` (how the formats encode palettes and NBT; reuse what fits).

## Goal

A wire protocol that both a TypeScript client and a Java mod can implement from the spec alone, a reference codec, and a fake in-game host good enough that silos P and Q never need a running game for their unit tests.

## Deliverables, in merge order

1. **`13` gains a *Wire format* section** that settles everything the *Messages* table leaves open:
   - Framing: length prefix width and byte order, maximum frame size, how a binary body follows a JSON header.
   - The JSON schema of every message in the table, with field names and types. Request/response pairing (`snapshot` ↔ `snapshot.result`, `patch` ↔ `patch.ack`): by id.
   - The binary encoding of patch and snapshot bodies (palette plus packed positions, `13`). Positions as world coordinates in patches, region-relative in snapshots, or both relative: pick one and say why. Block-entity NBT as uncompressed binary NBT (big-endian, as the game writes it), one compound per position.
   - Block-state strings: the exact canonical form both sides use (namespace always present, properties sorted by name, as in `01`). The mod parses and prints this form; the MCP never sends anything else.
   - `dirty`: the cap on listed positions before it becomes "whole region".
   - Protocol version `1`, and what each side does on a mismatch (report and refuse, `13`, *Version check*).
   - Pairing file format: the exact keys in `config/autosketch-bridge.toml`.
2. **Golden vectors** in `test/data/world-protocol/`: one binary file per message kind (several for patch and snapshot: empty, one block, mixed palette, block entities, a large patch), each with a `.json` sidecar describing the decoded value. Synthetic content only (main README, *Legal stance*). The mod's tests (silos N, O) decode and re-encode these byte for byte.
3. **TypeScript codec** in `src/world/protocol/`: encode and decode every message, streaming frame reader over a socket. Unit tests against the golden vectors, plus round-trip property tests.
4. **Fake host** (W9) in `test/support/fake-host.ts`: listens on a localhost port, writes a pairing file into a temp instance folder, holds an in-memory world (`Map` of world position → state and NBT), and implements the mod's side of every message exactly as `13` specifies the mod's rules: the patch guard, skip and report, reject unknown states (a configurable known-state set), `dirty` notices. Test hooks: `playerSet(pos, state)` (marks dirty), `setRegion(box | null)`, `dropConnection()`, `restart()` (new token and port), `knownStates`, and a patch log for assertions.

## Files you own

- New: `src/world/protocol/**`, `test/support/fake-host.ts`, `test/data/world-protocol/**`, `test/unit/world/protocol*.test.ts`.
- The *Wire format* section of `13`.

## Done when

- A second implementer could write the Java side from `13` and the golden vectors alone, without reading TypeScript. Ask someone from silo N to review the *Wire format* section before merging.
- The codec round-trips every golden vector byte for byte.
- A fake-host test runs the full happy path: hello, region, snapshot, patch with one guarded skip, ack, dirty.
- Encoding a one-million-block patch takes well under a second, and the encoded size is reported in the test output.
