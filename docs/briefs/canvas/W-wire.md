# Silo W: Wire contracts

**Wave 0** (W1). Every other mod and MCP silo builds against W1: keep it to shapes, vectors, codecs and the fake host, and land it first.

**Specs:** `19` (Part A *Status line*, *Stop*, *Queueing*; Part B *Model*, *Setting the canvas*; *Changes to other specs*); `13` (*Versions and features*, *Request kinds*, *Message schemas*, *Relay to the client*, *Read grants in select mode*); `16` (*Wire additions*); `17` piece 3 (reply-line action).

## Deliverables (W1)

1. `chat` kind `status` as the README's *Status line* contract. Without feature `requests` on both hellos, the MCP sends plain `chat` lines instead (Q1 does the fallback; W1 records it).
2. `ui.request` kinds `request.stop`, `queue.send`, `queue.cancel`, `request.undo`, with their `ui.result`s (`answered` when the request has already finished or the entry was already delivered).
3. **Commands from the server half.** `/autosketch stop` and `queue …` must work for a vanilla client. Pick the path (a mod→MCP message such as `request.control {player, action, request?}`, or the existing `/autosketch action <n>` for the buttons) and record it in `13`.
4. `prompt.result` `queued` with `request` and `position`; `busy` when the queue is full (already a code).
5. Canvas: mod→MCP `canvas {box|null, dimension, id?}`, MCP→mod `canvas.set {id, box}` (`bad_volumes` over `canvasChunks`, `wrong_dimension`). Canvas reads served as inside the select grant, in every mode (record in `13`, *Where the mod serves reads*).
6. Features `requests` and `canvas` in both hellos. Protocol stays 4.
7. Golden vectors for every new message, both codecs, and the fake host: it holds a canvas, answers `canvas.set`, serves reads inside it, and accepts the new `chat` and `ui.request` kinds (recorded for tests).
8. `19`'s *Implementation status* table, one row per step of this set.

## Files you own

`src/world/protocol/**`, `test/data/world-protocol/**`, `test/support/fake-host.ts`, `test/support/fake-mcp.ts`, `mod/common/.../protocol/**`, `13`'s wire sections.

## Done when

- Both codecs round-trip every new vector; existing vectors unchanged.
- A side without a feature gets no message of that feature, and an unknown kind is `bad_request`.
