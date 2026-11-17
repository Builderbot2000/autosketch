# Silo O: Overlays and HUD

**Wave 1**, from C's client skeleton and H's driver. Codes against the fake MCP; never needs M.

**Specs:** `16` (*Overlays in the world*, *HUD*), C's `ui.state` and `ui.flash` schemas.

## Goal

The player sees where the agents are working and what they just changed, in the world, and a small HUD with the request, jobs, last refusal and token totals.

## Deliverables, in merge order

1. **Job volumes:** a line box per open job's work volume in its colour, the brief as a camera-facing label, context volumes as dashed boxes; appear on the `ui.state` that adds the job, leave on the one that removes it. Drawn through blocks; toggled by `UiToggles.volumes` and its key.
2. **Change flashes:** a short pulse on each `ui.flash` box in the job's colour; toggled by `UiToggles.flashes`.
3. **HUD:** a corner panel with the open request and mode, open job count and newest briefs, last refusal, token totals for the current prompt; one line when collapsed; toggled by `UiToggles.hud`. Placement that doesn't collide with vanilla's HUD elements or the action bar.
4. The player's own volume outlines (`13`) stay as they are; don't merge them into this code.

## Files you own

- New `mod/neoforge/.../client/ui/overlay/**` and `…/client/ui/hud/**`, their client tests under the client test folder's `overlay/`, the action blocks for O's toggle keys in `AutosketchKeys`.

## Notes

- Everything you draw comes from the latest `ui.state` and `ui.flash`. Don't derive anything (no job ordering, colour choice or text wording beyond layout) that M could send.
- Check `LinkState` (L) before drawing.

## Done when

- Client tests: after a fake MCP's `ui.state` with two jobs, the draw list holds two solid boxes, their context boxes dashed, and two labels; removing a job removes its boxes; a `ui.flash` adds a pulse that expires; toggling each key empties and refills its part of the draw list; the HUD's widget text matches the state; nothing is drawn while `LinkState` is `offline`.
- One screenshot test: a job's outline is visible through a wall of blocks.
