# Silo C: Command and client overlays

**Wave 1** (C1, after W1), **wave 2** (C2, C3, after W2).

**Specs:** `18` pieces 1, 7, 8, *Testing* (client suite); `16` (overlays, `OverlayRenderer`, `DrawList`, client half thin); `17` piece 3 (clickable reply lines, `/autosketch action <n>`); `13` B6 (read-only modes).

## Goal

The player's side: `/autosketch select`, clickable choices, and a candidate and volumes the player can see at any distance.

## Deliverables

**C1**

1. `/autosketch select [text]` and `/<alias> select [text]`, mode `select`, read-only like `scan` (edits and drafts refused on the MCP side; the mod sends the mode). The prompt carries position, look, crosshair block, dimension, and no grant. `/autosketch done` ends it as other read-only requests. `scan` stays until R1.
2. Choice lines are ordinary `chat` reply lines with an action (`17`); check the existing click path works for one message per line. If W2 has merged, wire the choice kind's click here; otherwise in C2.
3. GameTests in `PromptGameTests` for the select prompt and its refusals.

**C2**

4. `DrawList` gains the steady fill record (W2); `OverlayRenderer` draws it at constant alpha through blocks with the existing `XRAY_QUADS` path, and the candidate's near-range outline boxes. Distinct candidate colour.
5. Proposed hits pulsed (`Pulse`) when the MCP sends them.
6. Client suite: candidate outline near and far, shell faces drawn without doubling, choice clicks.

**C3**

7. Work and context volumes drawn on the overlay with lines thick enough to see at distance, by W2's chosen route. `Feedback`'s dust particles stay only for players without the client half.
8. Client suite: volumes drawn without particles; a vanilla client still gets particles.

## Files you own

`mod/common/.../command/AutosketchCommand.java` (the select subcommand), `prompt/InGamePrompts.java` (select), `mod/neoforge/.../client/ui/overlay/**`, `feedback/Feedback.java`, lang keys for select, their GameTests and client tests.

## Done when

GameTests and `mod/clienttest.sh` pass with the new suites; `18`'s pieces 1 (mod), 7 (click) and 8 (client) rows marked built.
