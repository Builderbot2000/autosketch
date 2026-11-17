# Silo S: Screens, menu, key bindings

**Wave 1** from C's client skeleton and H's driver; **wave 2** for the 3D preview, once G's block drawing merges.

**Specs:** `16` (*Autosketch menu and key bindings*, *Settings screen*, *Library screen*), `15` (what the settings and library tabs showed, for parity), C's request kinds.

## Goal

The player reaches every feature from one key: a menu with the toggles and the entry points, a settings screen generated from the MCP's rows, and a library screen with thumbnails and a 3D preview.

## Deliverables, in merge order

1. **Autosketch menu** on `Home` (C declares the mapping; S attaches it): toggles for HUD, job volumes, change flashes, ghosts (writing `UiToggles`), and buttons for *Settings*, *Library*, *Replay* (opens R's log list, or the list as a screen if R prefers), *Ghost here* (sends G's `ghost.anchor`), and a link to the mod's Cloth Config screen. The unbound open-settings, open-library and open-replay keys open the same screens.
2. **Settings screen:** generated from the `settings.list` result: groups, summaries, controls (toggle, cycle, number field with bounds, list editor, text field), source and what a launch value overrides, a restart-needed mark. Save sends `settings.set`/`unset` with the hash; a `conflict` reloads the rows and tells the player.
3. **Library screen:** roots with counts, per-kind lists filtered by text and `tag:`, prefab thumbnails in a grid (PNG bodies loaded as dynamic textures, freed when the screen closes), flags for origin, overrides, shadowed and hidden, and the actions from C's table with a confirmation for delete and empty trash.
4. **3D preview** (wave 2): the selected prefab's `library.preview` voxels drawn with G's block drawing in the detail pane, with an orbit camera.

## Files you own

- New `mod/neoforge/.../client/ui/screen/**`, the menu and screen key actions in `AutosketchKeys`, lang entries for every screen string, client tests under `screen/`.

## Notes

- The screens show what the MCP sends. Don't sort, group, validate bounds or word messages beyond what the rows carry; if something is missing from a row, raise it with C and M.
- Screens open only when `LinkState` is `connected`; otherwise the menu key shows L's action-bar line.

## Done when

- Client tests: `Home` opens the menu, each toggle flips its `UiToggles` field, each button opens its screen; the settings screen builds one widget per row of a fake MCP's `settings.list` and saving sends the hash, and a `conflict` reloads; the library screen lists a fake MCP's entries, filters by text and `tag:`, loads a thumbnail texture, and sends each action's request; the preview draws the voxels it was sent.
- One screenshot test of the library grid with thumbnails.
