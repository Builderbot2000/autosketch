# Silo S: In-game requests

**Wave 2.** A vertical silo: it owns the feature on both sides, the mod half (M13) and the MCP half (W11). Start once N's skeleton and bridge and P's link object and event fan-out have merged. The TypeScript half can start earlier against L's fake host (`playerAsk`) once P's link object is in.

**Specs:** `13` (*Prompting from the game*, *Messages*, M13, W11, the channel and permission open questions), `12` (*Event stream*: the `call.*`, `doc.op` and `world.patch` events the activity stream reads), `05` (saved selections), L's *Wire format* section. Claude Code's channels documentation for the capability and notification shapes: read it, don't guess them.

## Goal

The player types a request in-game while pointing at what they mean; it reaches the running Claude Code session with the context saved as selection handles; the agent's activity and replies stream back to the game chat.

## Deliverables, in merge order

1. **Mod: command and context** (M13), in its own package in `mod/` (e.g. `…prompt`):
   - `/autosketch ask <text>` with an optional alias from config, registered through the command hook N's skeleton exposes.
   - The focus box: the wand's focus mode, registered through N's wand-mode hook, clipped to the work and context volumes with a warning, outlined in its own particle colour, `/autosketch focus clear`.
   - Game-context capture: position, eye position, facing (yaw and pitch), a server-side raycast for the crosshair block and face up to a configurable reach. Send `prompt`; show the `prompt.result` line on the action bar.
2. **MCP: delivery** (W11), in `src/world/prompt.ts`:
   - Declare the server as a Claude Code channel and push one channel event per allowed request, with the fixed text shape in `13`. Document how to start a session with the server in `--channels` in the README.
   - The allowlist setting `world.promptPlayers` in the existing settings module; singleplayer host allowed by default, empty on a dedicated server (the mod's `hello` says which it is: agree that field with L, or add it in a small protocol bump).
   - Convert the context to local coordinates and save `focus` and `target` as saved selections on the linked document before pushing; focus or target outside both volumes is reported, not saved; inside the context volume it is saved and marked read-only. Save the player's view as the camera `player` (`13`, `06` *Cameras*). Saved cameras belong to the perception work: if they haven't landed yet, keep the eye position, yaw and pitch on the link and say so in the event text, then switch to a saved camera when they arrive. The event text opens with the handoff facts (work volume size, context, scope), as `13` shows.
   - `prompt.result` for every request: delivered, or refused with `no_link`, `not_allowed` or `no_listener`. Find out whether the MCP can tell that no session is listening (the client's capabilities at initialize); if it can't, record that in `13`'s open question and deliver optimistically.
3. **MCP: streams back** as `chat` messages:
   - Activity: one short line per tool call on the linked document, built from P's event fan-out (it must carry the `tool()` wrapper's `call.*` events even with observability off; ask P for that, don't add a second hook). Coalesced and rate-limited so a script making thousands of edits is one line.
   - The `world_reply` tool in its own module, `src/server/tools/world-prompt.ts` (several lines, optional `done`). The channel event text tells the agent to answer through it.
   - Request streams close on `done` or a configurable idle time.
4. **Mod: chat display**: `chat` lines shown with activity dimmed and replies prominent, long lines wrapped; `/autosketch log off|mine|all` per player (the MCP sends `chat` to everyone linked; the mod filters by each player's setting and the request id).

## Files you own

- New: the `…prompt` package in `mod/` and its tests; `src/world/prompt.ts`, `src/world/chat-stream.ts` (or similar), `src/server/tools/world-prompt.ts`, matching tests in `test/unit/world/`.
- Additive: one line in `tools/index.ts`; the setting key; the channel capability where the server is constructed (`server/server.ts` or `server/index.ts`, coordinate with P).

## Notes

- Security is the point of the allowlist: a request becomes a prompt to an agent that can run commands on the user's machine. The check runs on the MCP side before anything reaches the channel. Never deliver a request from a player who isn't on the list, even "just this once" in tests.
- Approvals from the game (permission relay) are out of scope. Leave the open question in `13`.

## Done when

- A GameTest player running `/autosketch ask` while looking at a block with a focus box set produces a `prompt` whose context matches; a refused `prompt.result` shows its reason on the action bar; `chat` lines respect each player's `log` setting.
- Against the fake host: a `playerAsk` from an allowed player produces one channel notification with the fixed text shape, `focus` and `target` resolve to the right local blocks, and the `player` view matches the request's eye position and facing; the following tool calls arrive as coalesced `activity` lines; a `world_reply` with `done` arrives as `reply` and closes the stream; a player not on the list gets `not_allowed` and no notification.
- An unlinked session, or one with no in-game requests, has identical tool results before and after this silo's changes.
- `13`'s rows M13 and W11 are marked done.
