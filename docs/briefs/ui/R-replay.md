# Silo R: Replay in the world

**Wave 1**, from C's client skeleton and H's driver. Does not need G's block drawing: replay writes into the client's own copy of the world, which the game meshes itself.

**Specs:** `16` (*Replay in the world*, the replay rows of the key table, *Decisions*: replay client-side, live updates ignored), C's `replay.frame` and the replay `ui.request` kinds, `12` (what a step is; gaps).

## Goal

A session's timeline plays in the world: the replayed volume shows step S in the player's client only, the camera is detached, and the player steps, plays and jumps between markers. Closing leaves the client showing exactly the server's world.

## Deliverables, in merge order

1. **Open and close:** `/autosketch replay` asks for the log list (`ui.request` `logs.list`) and shows it as clickable chat lines, newest first; `/autosketch replay <log>` (or the live session) sends `replay.open`; Backspace or `/autosketch replay close` sends `replay.close`.
2. **Client overrides:** apply a `replay.frame` keyframe to every position in the replayed volume in the client's world copy, then forward deltas; chunks that load inside the volume during replay get the current frame reapplied.
3. **Live updates ignored:** a client mixin, in its own client mixin config, on the block-update and section-update packet handlers drops server updates inside the replayed volume while replay is open.
4. **Chunk resend on close** (server half): on `replay.close`, the server half resends the chunks covering the volume to that player. GameTest for it.
5. **Camera:** detach the camera and freeze the player during replay; no game-mode change; restore on close, on disconnect and on `LinkState` going `offline`.
6. **Controls and HUD strip:** the replay keys from `16`'s table (attached in `AutosketchKeys`, active only in replay), scroll to step, each sending `replay.seek` or changing local play speed; a strip with the time, the step's tool call and job brief, and ticks for markers, all from the frame. Job volumes and per-step flashes at each step, from the frame (reuse O's drawing if it has landed; otherwise draw minimal boxes and switch to O's once it merges).

## Files you own

- New `mod/neoforge/.../client/ui/replay/**`, a new client mixin config and its mixin, the server-half resend in `mod/common/.../ui/relay/` (additive, coordinate with C), the `replay` subcommand through the command hook, client tests under `replay/`, the replay key actions.

## Notes

- Close must be crash-safe for the server: nothing in replay ever writes to the server's world. If the client crashes mid-replay, the next join shows the server's state with nothing to clean up. Test the disconnect path.
- Keep the mixin minimal: one check against the replayed volume's box per update.

## Done when

- Client tests: after a keyframe the client's block at each test position equals the frame's; a delta changes exactly its positions; a server block change inside the volume during replay doesn't show, and after close the client matches the server's world (checked against the integrated server in the same process); the camera is detached and the player doesn't move while keys are pressed; each replay key sends the right request or changes speed; Backspace closes and Esc still opens the pause menu.
- GameTest: `replay.close` resends exactly the volume's chunks to that player only.
