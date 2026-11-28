# Silo M: Seeing the canvas, select confirm

**Wave 2** (M1, after F1).

**Specs:** `19` Part B *Setting the canvas* (select confirm), *Seeing the whole canvas*; `18` piece 9 (confirm), piece 5 (world view), T1's heat map (image conventions); `06` (perception, token-cost hints); `07` (skills).

## Deliverables (M1)

1. `world_volumes({from: "candidate"})` (`src/world/select/confirm.ts`): when the shape's box plus margin is over the brush cap, send `canvas.set` with the box plus margin, widened to chunk columns, and report that the agent places the brush itself. Under the cap: volumes as now, and the canvas too when none contains them. This replaces the "too large for a work volume" text.
2. `world_map()` (new MCP tool): the canvas from above, one cell per chunk column, shaded by surface height (surface snapshot, coarse past the cap), brush, context, open jobs and player marked, a chunk grid labelled in local coordinates; text with the canvas size, brush box and what was read. Token-cost hint in the description. Measurements only.
3. A canvas skill in `library/knowledge/skills/` (advisory: look at the whole canvas, then place the brush over one coherent part), regenerated into `packaging/claude-plugin/skills/`.
4. Tests: confirm over and under the cap against the fake host; `world_map` image size and marks on a synthetic canvas; golden text.

## Files you own

`src/world/select/confirm.ts`, a new `world_map` module in `src/server/tools/` and its logic in `src/world/`, the skill, `19`'s M row.

## Done when

- The select flow that was refused in the 2026-11-27 test (a shape over `contextCap`) ends with a canvas set and a brush placed by the agent, in a fake-host test.
