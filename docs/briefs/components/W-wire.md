# Silo W: Wire contracts

**Wave 0.** Everything in this silo is one merge if it stays small; otherwise land the `candidates.*` kinds and the reply-line action first (Q and V wait on them).

**Specs:** `17` pieces 3, 6 and 8; `13` (*Wire format*, *Request kinds*, *Message schemas*, *Prompting from the game*); `16` (*Wire additions*).

## Goal

Freeze every protocol change `17` needs, so the MCP silos (Q, E, F) and the mod silos (V, E) build against the same messages.

## Deliverables

1. **`candidates.*` kinds:** `candidates.open {id}`, `candidates.ghost {id, prefab, at, rotate?}`, `candidates.ghost.clear`, `candidates.submit {id, picks: [{prefab, cell, label?}], note?}`, with their results as `17` piece 3 describes (the `open` answer lists cell, prefab, root, size, tags, notes per entry, plus the open request id and question text). Errors use the existing fixed codes; add `answered` (or reuse one, decide and record it) for a submit after the list was answered.
2. **Editor write kinds** for prefab meta, palette, procedure text and knowledge text (`17` piece 6), each with the `hash` it started from, answered with the new hash, or `conflict`. The entry detail already sends `hash` and `editable`.
3. **Clickable reply line:** an optional action on a `chat` message's reply line that names a `ui.request` for the client to send. A vanilla client shows the plain text.
4. **Save flash:** a `ui.flash` entry without a job, with a fixed colour.
5. Golden vectors in `test/data/world-protocol/`, the TS and Java codecs, the fake host able to send the new kinds as a player, and the fake MCP able to answer them from its table.
6. `13`'s tables updated; `17`'s *Implementation status* table added with one row per piece.

## Files you own

`src/world/protocol/**`, `test/data/world-protocol/**`, `test/support/fake-host.ts`, `test/support/fake-mcp.ts`, `mod/common/.../protocol/**`, `13`'s wire sections.

## Done when

- Both codecs round-trip every new vector; existing vectors unchanged.
- The `ui` feature gate still holds: an MCP without these kinds answers `bad_request`, and a client without the action shows plain text.
