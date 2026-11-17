# Silo G: Ghosts

**Wave 1**, from C's client skeleton and H's driver. Land the block drawing (deliverable 1) first, in its own merge: S's 3D preview uses it.

**Specs:** `16` (*Ghost blocks*, *Decisions*: block models only), `13` (*Binary bodies*), C's `ui.ghost` schemas.

## Goal

Translucent blocks drawn with the game's own block renderer: a sandbox's blocks where they will land before merge, and an unlinked document at an anchor the player sets.

## Deliverables, in merge order

1. **Block drawing** (`client/ui/blocks/`), the contract S uses: draw a region given as palette plus positions with the game's block renderer, model only (blocks with block-entity renderers show their model), tint and alpha as parameters; usable in the world and inside a screen with its own camera.
2. **Section meshing:** a ghost region meshed per 16³ section, re-meshed only where an update lands, meshes freed on `ui.ghost.clear`, on dimension change and on disconnect.
3. **Sandbox ghosts:** each `ui.ghost` region drawn in its job's tint at its origin; toggled by `UiToggles.ghosts` and its key.
4. **Anchored documents:** `/autosketch ghost here` and the wand (in a mode that sets the anchor; agree the mode name with L and the existing wand code) send a `ui.request` kind `ghost.anchor`; the region arrives as `ui.ghost`. `/autosketch ghost clear` removes it.

## Files you own

- New `mod/neoforge/.../client/ui/blocks/**` and `…/client/ui/ghost/**`, the `ghost` subcommand through the command hook, their client tests under `ghost/`, G's toggle key action.

## Notes

- Measure as you go: mesh time per 16³ section and memory for a 256³ ghost with software rendering and on a real GPU (the dev machine's `d3d12` driver under WSLg). Record both in `16`.
- Modded blocks: try at least one Create part and one FramedBlocks block in the Craftoria-sized run (H's manual script); if the model-only rule looks wrong, record it under `16`'s *Decisions* revisit note rather than changing the rule.

## Done when

- Client tests: a fake MCP's `ui.ghost` produces meshes for exactly the sections it covers; an update re-meshes only the touched sections; `ui.ghost.clear` frees them; the toggle hides and shows; `/autosketch ghost here` sends `ghost.anchor` with the player's position; nothing draws while `LinkState` is `offline`.
- One screenshot test: a ghost is visible and translucent over terrain.
