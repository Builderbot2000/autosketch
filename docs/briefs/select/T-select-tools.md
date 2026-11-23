# Silo T: Search, fill, expand and confirm tools

**Wave 1** (T1, after W1), **wave 2** (T2 after V1, T3 after T2).

**Specs:** `18` pieces 2, 3, 4, 9, *Principles*, *Testing* (unit); `11` (sandboxes for too-large selections); `13` B4 (`world_volumes`); `05` (selection algebra, `{connected}`).

## Goal

The agent's four tools that find, grow and confirm a candidate, all against W's fake host, with logic below `server/`.

## Deliverables

**T1 `world_search({materials, radius?, around?, continue?})`**

1. Resolves materials as given (ids, `family:`, tags) and checks them against the registry; the agent turns words into these, the tool never guesses.
2. Answer as an image (one cell per chunk, density shaded, player marked, north up, ungenerated chunks marked) and a short text list of clusters: closed or open, distance, bearing, count per material, and the ring reached. Token-cost hint in the description.
3. `continue: true` walks on from the stopping ring.

**T2 `world_fill` and `world_expand`**

4. `world_fill({seed, match, connectivity?, budget?})` names the result `candidate` in the world view (V1), reading the candidate's sections plus `margin` (default 8) automatically; a further fill can replace or combine (`mode: replace|union|subtract`, or leave combination to `select`, decide and record).
5. The result text: box, count, sections, and whether the frontier is empty ("cut off at N faces, world_expand to continue").
6. `world_expand({by})`, resuming the fill; re-reads what it adds.

**T3 confirm**

7. `world_volumes({from: "candidate", margin?})`: work volume = candidate box (enforced as today), context = box grown by `margin` (default 8), the shape kept as named selection `candidate` in the linked document, re-read on confirm. Over `contextCap`: confirmed as a selection, the result says the work volume can't hold it and suggests a part or sandboxes; the cap is not raised.

## Files you own

New `src/world/select/` (search, fill, expand, confirm logic and the heat-map image), a new `src/server/tools/world-select.ts`, the `from` argument in `tools/world-volumes.ts`, the session's search state and candidate fields.

## Done when

Unit tests for the heat-map image and cluster text, fill and expand against the fake host (including cut-off and resumed shapes), and confirm inside and over the cap pass; `18`'s pieces 2–4 (MCP) and 9 rows marked built.
