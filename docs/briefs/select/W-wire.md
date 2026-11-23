# Silo W: Wire contracts

**Wave 0** (W1), **wave 1** (W2). W1 unblocks almost every other silo: keep it to the request shapes and the fake host, and land it first.

**Specs:** `18` *Wire*, pieces 1–5, 7, 8; `13` (*Wire format*, *Request kinds*, *Message schemas*, *Prompting from the game*); `16` (*Wire additions*, overlays); `17` piece 3 (reply-line action).

## Goal

Freeze every protocol change `18` needs, so the MCP silos (T, V, P) and the mod silos (M, C) build against the same messages.

## Deliverables

**W1**

1. Mode `select` in `prompt` (no grant; context as for the other modes). `scan` and `prompt.scan` stay until R1.
2. Requests `search {materials, radius?, around?, gap?, stop?, continue?}`, `fill {seed, match, connectivity?, budget?}`, `expand {by}`, with ids, answered in arrival order. Answers as `18` pieces 2–4 (*Cross-silo contracts* in the README lists the fields). Choose compact encodings: per-chunk counts as parallel arrays, masks as 512-byte bitsets per section in the body, frontier as faces grouped per section.
3. `snapshot` gains `mask` (sections plus a margin) and `coarse` (cell size 2 or 4).
4. Read grants in select mode as the user settles them (README, *Open point for the user*), recorded in `13`.
5. Golden vectors, the TS and Java codecs, and the fake host answering all of the above from its in-memory world. The fake host's fill uses the same algorithm as `{connected}` (`src/ops/selection.ts`) so parity tests are meaningful; its search treats every non-empty section as a `maybeHas` yes.
6. `18`'s *Implementation status* table, one row per piece.

**W2**

7. The choice kind: a `ui.request` sent by a clicked choice line, carrying the request id and the choice index; `answered` once a choice for that question was taken. A client without `autosketch:ui` types the number instead (P2 handles that side).
8. Steady fill record in `ui.state` (faces as merged rectangles, colour, constant alpha, an id), and the candidate's near-range outline boxes.
9. Volume lines for C3: decide with C's brief whether the mod's server half sends work and context boxes to its own client half or the MCP sends them in `ui.state`; record the choice in `13`.
10. `13`'s *Request kinds* and *Message schemas* updated for W1 and W2.

## Files you own

`src/world/protocol/**`, `test/data/world-protocol/**`, `test/support/fake-host.ts`, `test/support/fake-mcp.ts`, `mod/common/.../protocol/**`, `13`'s wire sections.

## Done when

- Both codecs round-trip every new vector; existing vectors unchanged.
- An MCP or mod without the new kinds answers `bad_request`, and a hello without the select feature makes the MCP say so in the event rather than fail.
