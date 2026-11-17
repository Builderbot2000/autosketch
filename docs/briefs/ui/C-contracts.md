# Silo C: Contracts

**Wave 0.** Every other silo except H and L builds against what this one freezes. Keep it small and land it fast, in this order: the schemas in `13` and the golden vectors first (one merge), then the TypeScript codec and both fakes, then the Java codec, relay and client skeleton.

**Specs:** `16` (*Architecture*, *Wire additions*, *Mod side*), `13` (*Wire format*, *Versions and features*, *Binary bodies*, *Allowed players*), `15` (settings rows and the compare-and-set hash, for the request shapes).

## Goal

A `ui` feature both sides can implement from `13` and the vectors alone, a packet path from the bridge to the right players' clients, and the client-side skeleton (dispatch, toggles, key mappings, link state holder) that O, G, R and S register into without touching each other's files.

## Deliverables, in merge order

1. **Schemas in `13`.** Add `ui` to *MCP features* and *Mod features* in *Versions and features*. Under *Message schemas*, one table per message in `16`'s *Wire additions*:
   - Every MCP → mod message names its `players` (UUIDs); the relay forwards only to those.
   - `ui.state`: `full` or changes; jobs (id, colour, brief, work box, context boxes, all in world coordinates with dimension), current request (id, mode), token totals, last refusal. Settle how changes are expressed (replace-by-key per job is the suggested default) and say why.
   - `ui.flash`: boxes and a colour per job.
   - `ui.ghost` (body) and `ui.ghost.clear`: ghost id, origin, tint; the body reuses the snapshot body encoding (`13`, *Binary bodies*). Settle whether an update is a whole region or a delta (section list), and say why.
   - `replay.frame` (body): replay id, step, keyframe or forward deltas, job volumes and HUD text at the step, markers (fork, merge, refusal, checkpoint) for the strip.
   - `ui.request` / `ui.result`: their own id space, the player's UUID, a `kind` and arguments. One table of kinds (main README of this set, *Cross-silo contracts*) with argument and result shapes, binary bodies for thumbnail PNGs and preview voxels. Errors as fixed codes (`not_allowed`, `conflict` for a stale settings hash, `not_found`, `bad_request`, `busy`).
   - Size and rate: the coalescing interval for `ui.state` and `ui.flash` (`16`, *Never slows the build*), and what "resync" is on the wire (the mod asks with a `ui.request` kind `resync`, or the MCP resends a full state on any player join: pick one).
2. **Golden vectors** in `test/data/world-protocol/` for every new message, including a multi-part body. Synthetic content only.
3. **TypeScript codec** additions in `src/world/protocol/`, tested against the vectors byte for byte. Gate sending on both hellos listing `ui`.
4. **Fake host** (`test/support/fake-host.ts`): lists `ui`, records every `ui.*` and `replay.*` it receives, and `playerUiRequest(player, request)` sends a `ui.request` and resolves with the `ui.result`.
5. **Fake MCP** (`test/support/fake-mcp.ts`), new: plays the MCP against the real mod's bridge. Reads the pairing file, `hello` with a chosen feature list (so tests can play an MCP that's too old), sends scripted messages, answers `ui.request`s from a table, records everything, and runs both as a library and as a CLI (`node test/support/fake-mcp.ts --pairing <file> --script <json>`) for H's harness. It replaces the ad hoc TS drivers earlier silos used.
6. **Java codec** in `mod/common/.../protocol/`, passing the same vectors in JUnit.
7. **Relay** (server half, `mod/common/.../ui/relay/` plus the NeoForge payload registration): one payload channel registered optional on the client (vanilla clients still join); forwards each message to its named players whose clients registered the channel; splits bodies over about 1 MiB into numbered parts; forwards a client's `ui.request` to the bridge with the player's UUID; resends the last full `ui.state` when a named player joins. No other UI state. GameTests for each rule (`16`, *Testing*, server half), except the chunk resend on replay close, which R owns.
8. **Client skeleton** (`mod/neoforge/.../client/ui/`): `UiClient` (joins parts, dispatches by kind), `UiToggles`, `AutosketchKeys` (every mapping in `16`'s key table, declared once, actions attached by the owning silo), `LinkState` (a holder L fills). Wired from `AutosketchClient`. A client-side handler that only logs each kind, so the path is testable end to end before any feature exists.
9. `16` gains an *Implementation status* table, with a row per stream.

## Files you own

- `13`'s *Wire format* additions and the `ui` entries in *Versions and features*.
- `src/world/protocol/**` additions, `test/data/world-protocol/**` additions, `test/support/fake-host.ts`, new `test/support/fake-mcp.ts`, `test/unit/world/protocol*.test.ts`.
- `mod/common/.../protocol/**` additions, new `mod/common/.../ui/relay/**`, new `mod/neoforge/.../client/ui/{UiClient,UiToggles,AutosketchKeys,LinkState}.java`, and the one-line wiring in `AutosketchClient`.

## Notes

- `prompt.close` is the model for a feature added within protocol 3; copy how it was gated, documented and vectored.
- The mod has only ever answered requests. `ui.request` is the first request it originates; make sure the Java bridge's reader routes `ui.result`-style replies by C's own id space and never confuses them with the MCP's ids.
- Ask someone from M and someone from the mod silos to review the schemas before merging deliverable 1.

## Done when

- A second implementer could write either side of `ui` from `13` and the vectors alone.
- Both codecs round-trip every new vector byte for byte.
- A GameTest drives the fake MCP through the real bridge: a `ui.state` naming one of two players reaches only that player's (simulated) connection; a 3 MiB `ui.ghost` arrives in order as parts; a `ui.request` reaches the fake MCP with the player's UUID and the `ui.result` comes back to it; without `ui` in both hellos nothing is sent.
