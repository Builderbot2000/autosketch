# Silo Y: Mod side of in-game requests

**Wave 1** (B1, B6, B2), after X's restructure merges and against Z's wave-0 vectors. **Wave 2** (B4 scan).

**Specs:** `13` (*Backlog* B1, B2, B4, B6; *Mod requirements* M3, M4, M11, M13; *Wire format*), `14` (the mod's layout and Cloth Config, from X).

## Goal

The wand works like WorldEdit's (any blaze rod, main hand, op level 2), corners can be marked in the air, the player's subcommand names what the agent may do, and `/autosketch scan` sends the agent what it needs to set the volumes.

## Deliverables, in merge order

1. **B1: the wand is any configured item.** `wandItem` in Cloth Config (default `minecraft:blaze_rod`); any stack of it is the wand, main hand only, op level 2 only; both clicks cancelled, so clicking a brewing stand with the rod sets a corner instead of opening it. Remove the `custom_data` marker and `/autosketch wand`. Mode cycling and the action bar stay. Update the wand GameTests (`Wand.create()` becomes a plain rod).
2. **B6: request modes as subcommands.** `/autosketch ask|scan|plan|build <text>` send `mode` in `prompt`; refuse a mode not in the MCP's `hello` with `unsupported_mode` on the action bar; `askAlias` becomes a short root (`/as build …`). Update M13's GameTests.
3. **B2: air mode.** `/autosketch air on|off` per player. With the client half: air clicks sent as an optional custom payload (`LeftClickEmpty` is client-only), distance by sneak+scroll, the outline previewing the point while the wand is held. Without it: right-click in the air sets corner 2, sneak+right-click corner 1, `/autosketch air reach <n>` sets the distance. `displayTest` stays `IGNORE_ALL_VERSION`; remove the "server-side only" comment in the metadata. The client half lives in the NeoForge module's client source set, so a dedicated server never loads it.
4. **B4: scan.** `/autosketch scan [radius] [text]` in mode `scan`: radius in chunks (default `scanChunks` 4, capped at `scanChunksMax` 12 with an action-bar warning when clipped); answer `snapshot` kind `surface`; apply `volumes.set` as if the player had marked the volumes (outlines at once, `world.autoLink` as usual). Config keys `scanChunks`, `scanChunksMax`, `scanBelow`, `scanAbove`, `scanCap`. Measure surface snapshot size and time on Craftoria and record them in `13` before the defaults are fixed.

## Files you own

- New files in `mod/common` and `mod/neoforge` for the features above; the wand, volume and prompt packages' changes; GameTests for them.
- Shared (additive): `AutosketchConfig` (new keys), command registration, the protocol classes (new message bodies matching Z's vectors), `13` (B1, B2, B4 mod side, B6 mod side rows).

## Done when

- GameTests: a plain blaze rod sets corners for an op and does nothing for a non-op or in the off hand; clicking a brewing stand with it sets a corner and doesn't open it.
- Java decodes and encodes Z's new golden vectors byte for byte.
- A `scan` request against an MCP that doesn't list `scan` shows `unsupported_mode`, and nothing is sent.
- Air mode with and without the client half sets the expected corner (GameTest for the server path; the client path checked in game by the user and noted in `13`).
- A surface snapshot of the maximum radius completes within the measured budget, without stalling the tick beyond `tickBudget`.
- The e2e tier still passes on the test server.
