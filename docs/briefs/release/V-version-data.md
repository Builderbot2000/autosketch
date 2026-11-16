# Silo V: Version data

**Wave 3**, after X's layout and Z's `N`/`N−1` support have merged. Owns both sides of one feature: the registry report and upgrade in the mod, and their consumers in the MCP.

**Specs:** `14` (*Version-specific data lives in the mod*, *Schematics from other versions: the established practice*, *Resource formats on the MCP side*), `13` (the modded-state answer under *Open questions*), `08` (*Import*), `02` (canonical states), `10` (Tier 2).

## Goal

The MCP learns every block's properties from the running game instead of guessing them, so a typed modded block gets its full state and the game no longer rejects it. Schematics from older versions upgrade through the game's own data fixer. The model reader accepts the newer resource formats.

## Deliverables, in merge order

1. **Measure first.** Generate the registry report on the Craftoria test server (every block, its properties, allowed values, default state, block tags, which blocks have block entities, `DataVersion`) and record its raw and compressed size in `14` before fixing the format.
2. **Registry report, mod side.** Written at server start to `<user.home>/.autosketch/games/<hash>.registry.json.gz` beside X's pointer file, plus a `registry` protocol request for a modset changed since. Version-specific code goes in the version-conditional parts of the layout.
3. **Registry report, MCP side.** The order of trust when canonicalizing a block (`02`): the report, then the instance's blockstate files, then the bundled vanilla tables. `set_blocks create:cogwheel` gets the full state, including `waterlogged`.
4. **Upgrade, mod side.** An `upgrade` request: the game's data fixer over block states and block entity NBT from a given `DataVersion`, with the fix types in `14` (whole-file `STRUCTURE` for `.nbt`; per element for `.schem`, `.bp`, `.litematic`).
5. **Upgrade, MCP side.** On import and on prefab load, when linked: forward-only upgrade through the mod; formats' own defaults for missing versions (Sponge v1 as 1631, structure as 500, MCEdit through the flattening table first); files newer than the game import with a warning naming both versions; unknown blocks kept verbatim and reported. Unlinked: the rename and legacy tables, with a warning that the upgrade was partial. Writing stamps the running game's version. Update `08`'s *Import*.
6. **Resource formats.** In `src/assets/models.ts`, accept both old and new forms: multi-axis element rotation and blockstate `z` rotation (1.21.11), texture entries as objects (26.1), `shade_direction_override` (26.3); check for snapping of non-22.5° rotations (1.21.6). Synthetic fixtures only.
7. **Tier 2 `.litematic` round-trip** (`10`), now that silo H's reader and writer exist.

## Files you own

- New in `mod/`: the report and upgrade modules and their GameTests. New in `src/`: the report reader (for example `src/assets/report.ts`) and the upgrade client (for example `src/world/upgrade.ts`). Tests in `test/unit/assets/`, `test/unit/formats/`, `test/unit/world/`.
- Shared (additive): `src/world/protocol/**` and the vectors (a protocol bump after Z's), the canonicalization path in `02`'s code, `src/formats/**` import paths, `src/assets/models.ts`.

## Done when

- With a report present, `set_blocks create:cogwheel` sends a state the game accepts (e2e on the test server); without one, behaviour is as today.
- A `.schem` with `DataVersion` 3465 holding `minecraft:grass` imports as `short_grass` when linked, and imports with a partial-upgrade warning unlinked.
- A file newer than the game imports with the warning, and unknown blocks stay verbatim.
- Model fixtures in the new forms render the same as their old-form equivalents where the forms overlap.
- The `.litematic` round-trip test is in Tier 2.
- `14`'s version data rows and `13`'s modded-state answer are marked built.
