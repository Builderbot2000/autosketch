# Silo M: Mode and commands

**Wave 1** (M1).

**Specs:** `21` Part A (all), *Decisions*, *Principles* 2; `13` B6 (the hold rule this replaces), M3, M13; `18` piece 7 (*Mode switch*); `16` (*Mod side*, client actions).

## Deliverables (M1)

1. **Mode store** (README contract): per-player `RequestMode` in memory, missing = `build`, gone after a server restart. Air mode kept the same way if it isn't already.
2. **`/autosketch mode <ask|plan|select|build>`** in the prompt module: suggests only modes the MCP's hello lists, refuses others with `unsupported_mode` (setting unchanged); no argument shows the current mode; a change is confirmed on the action bar (`Mode: plan (read and propose only)`) through `ActionBarHold` so the wand's line doesn't overwrite it. S1 later sends the confirmation to the console instead.
3. **Sending:** `/autosketch ask|plan|select|build <text>` keeps sending in that mode for that request only and leaves the setting alone. No bare `/autosketch <text>`.
4. **Hold rule** (`21`, *Changes to the read-only hold*): the mod side of B6 follows the setting. Check what `src/world/prompt.ts`'s `held` already does: the next delivered request replaces the hold, which is the new rule once the mod sends the player's mode. `/autosketch done` still sends `prompt.close` and leaves the setting. Change MCP code only if a GameTest shows the old hold surviving a `build` request, and say so.
5. **A picked choice with a mode** sets the player's setting (README contract, *Choice switch sets the setting*).
6. **`mode` client action** on join, on link `connected` and on every change.
7. **Removed:** `/autosketch mode work|context|focus|canvas` (`VolumeCommands`; the wand mode is the swap-hands key only, `/autosketch status` still lists it), `askAlias` and `PromptModule.alias` with their GameTests. A set `askAlias` is ignored with one log line (`ConfigMigrationTest`).
8. GameTests: each mode set and then sent; an unlisted mode refused; the per-request override leaves the setting; swap-hands still cycles the wand mode; the store empty after a restart (a fresh store instance); a picked switching choice sets the setting; the `mode` action sent on change.

## Files you own

`PromptModule.java`, a new `PlayerModes` (or similar) under `mod/common/.../prompt/`, the request-path and `done` parts of `InGamePrompts.java`, `VolumeCommands.java`, `AutosketchConfig.java` (alias only), the `mode` action call in `ui/relay/`, `PromptGameTests`, `VolumeGameTests`, `ConfigGameTests`, `ConfigMigrationTest`; `13`'s B6, M3, M13; `21`'s M1 row.

## Done when

- A GameTest sets `plan`, sends from the console path's entry point (`InGamePrompts.request` with no mode argument → the setting) and sees `mode: plan` in the fake MCP's `prompt`, then `/autosketch build x` sends `build` and the setting is still `plan`.
