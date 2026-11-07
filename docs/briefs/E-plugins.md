# Silo E: Mod-compat plugins

**Wave 1** for knowledge and rendering. **Wave 2** for agent actions, after silo A merges (actions rely on its rotate hook and auto-connection).

**Specs:** `09` (all), `02` (code-drawn blocks, tint), `03` (classification), `08` (material list `items`).

## Goal

Cover what asset data can't express: blocks drawn by game code, camo appearance stored in NBT, and actions that mirror a mod's own tools. Plugins stay optional: the generic pipeline must keep working without any of them.

## Deliverables

**Wave 1**
1. **Code-drawn fallback models** in `src/assets/builtin-models/` for chests, signs, beds, banners, heads, shulker boxes and bells (`02`). Hand-written geometry, no copied game assets. Wire them into the baker.
2. **Plugin API expansion** (`09`, *Plugin API*): `families`, `render(pos, state, nbt, ctx)`, `validateNbt`, `actions`. Keep every field optional. A extends `rotate?` first; build on it.
3. **Create and CreateDeco classification:** casings, sheet metals and girders as buildable families, machines non-buildable. Answer the `createdeco` grouping question in `03` if the data allows.
4. **Third-party plugin loading** from `~/autosketch/plugins/*.js`, documented as full trust.
5. **`ops_list({ namespace })`** tool for discovering plugin actions.

**Wave 2**
6. **FramedBlocks and Copycats:** `framed.shape`, `framed.camo`, `copycat.shape`, `copycat.camo`, rendering framed blocks with the camo texture, and `items` returning frame plus camo. Camo NBT layouts are unverified (open question in `09`; the user must supply saved blocks). Build against your best reading of the mods' public source, isolate the NBT layout in one function, and mark it unverified in the spec.
7. **Chisel family:** `chisel.pattern` and `chisel.randomize`, converting within a variant group read from the instance's data.
8. **Plugin actions in scripts:** register actions with silo C's script API if it has merged.

## Files you own

- `src/plugins/**`, `src/assets/builtin-models/**`, `src/server/tools/plugins.ts`, matching tests.
- Additive only: `src/perception/render/bake.ts` (render hook, shared with B), `src/formats/materials.ts` (already calls `items`).

## Done when

- A chest, a bed and a sign render as recognisable shapes instead of the particle-texture fallback.
- Ingestion results on vanilla, with and without plugins, stay as `03` reports (the agnostic tests still pass).
- A framed slope with a stone camo can be placed, rendered with stone, and listed in a Create material list as frame plus camo.
- `09` gains an *Implementation status* table.
