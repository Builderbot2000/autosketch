# Silo Z: Measure, end to end, close-out

**Wave 2** (Z1, after M1–M3), **wave 3** (Z2, Z3, after everything else).

**Specs:** `18` *Measure first*, *Testing* (end to end), *Open questions*, *Decisions*; `10` (test tiers); `docs/briefs/world/test-setup.md` and the `ingame-setup` skill for the Craftoria server.

## Deliverables

**Z1 measure first** (Craftoria test server, `~/servers/craftoria`)

1. Search: cold `maybeHas` walk at 64 and 256 chunks; time to the first closed cluster for a build near the player; tick impact; how often real terrain sections answer "maybe" for common building materials.
2. Fill: a large build (tens of millions of blocks) in rounds: time per round, mask size on the wire.
3. Coarse view: transfer and render time at 4³ cells, and a legibility check of the render.
4. Record the numbers in `18` (*Measured*, new section), settle the radius open question with the reason, and change defaults only where the numbers say so. Measurement scripts go in `test/e2e/world/measure.ts` (extend it).

**Z2 end to end**

5. World-tier test: "select the mossy stone brick house" on a test world with two candidate houses and a ruin, through search, choices (driven at the MCP's edge, as `17` Z1 did), fill, expand, fade render and confirmed volumes.

**Z3 close-out**

6. `18`'s *Status* line and *Implementation status* complete; open questions moved into the body; `HANDOFF.md` in this folder in the shape of `components/HANDOFF.md`.

## Files you own

`test/e2e/world/measure.ts`, a new `test/e2e/world/select.test.ts` and its world fixture (original builds only), `18`'s *Measured*, *Open questions* and *Status*, `HANDOFF.md`.

## Done when

All tiers pass, the e2e world tier passes on Craftoria, and the lead's final run is recorded in `HANDOFF.md`.
