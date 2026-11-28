# Silo G: Request control in game

**Wave 1** (G1, after W1).

**Specs:** `19` Part A *Status line*, *Stop*, *Queueing*; `13` (*Prompting from the game*, commands, *Disconnect*); `16` (HUD, client half); `17` piece 3 (clickable lines); `18` C5 (`ActionBarHold`, so lines aren't overwritten).

## Deliverables (G1)

1. `/autosketch stop`, `/autosketch queue`, `/autosketch queue cancel <n>` (and the alias), op level 2, the request's player or any op, through the server-half path W1 chose, so a vanilla client can use them.
2. **Status line in place** (client half): one chat line per request id, replaced as `status` messages arrive; buttons as clickable `ui.request`s. Without the client half: a new plain line per state change and a command hint.
3. HUD request line shows the state and queue length (`16`, `HudOverlay`).
4. Stop on the mod side: unstarted patches dropped, the patch in progress finished (as on disconnect), when the MCP says so (W1's message).
5. GameTests (commands, the server path, patches dropped) and client tests (the line rewritten in place, buttons send the right request, HUD text, the plain fallback).

## Files you own

New command class under `mod/common/.../command/`, the stop handling in the patch queue (minimal, additive), `mod/neoforge/.../client/ui/hud/**`, a new client chat-line module, their tests, `19`'s G row.

## Done when

- A client test sees one line go `working → stopping → stopped` in place, and a vanilla-path test sees the same as three plain lines.
