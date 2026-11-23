# Silo V: World view and fade

**Wave 0** (V1, needs only today's box snapshots), **wave 1** (V2, after W1).

**Specs:** `18` pieces 5, 6, 10 and *Already built* (isolated render, ghosted context); `06` (render, slices, raycast, analyze); `11` (sandbox context, ghost style); `05` (selection algebra).

## Goal

Give the agent a read-only view of the world held beside the open document, which every perception tool can address, and a render that shows a selection solid among faded surroundings.

## Deliverables

**V1**

1. A `WorldView` on the session, beside (never replacing) the open document, and coexisting with open sandboxes. It holds the blocks read for the current request, in world coordinates, plus named selections. Cleared when the request ends.
2. `view: "world"` on `render`, `view_slice`, `raycast`, `select` and `analyze`. Every edit addressed to the view is refused with a clear refusal code.
3. `world_view_read({sel | box})`: reads through `snapshot` by box, capped per call by `contextCap`, merged into the view.
4. Unit tests against the fake host: the view beside an open document, with sandboxes open, edits refused, selections stored and reused.

**V2**

5. Coarse level: reads over `contextCap` use W1's `coarse` snapshot; a later full-detail read of a region replaces the coarse blocks there; the render caption says which parts are coarse.
6. `render({fade: <sel>})`: everything outside `fade` drawn in the ghost style (generalise `ContextMode` "ghost" from `doc.context` to any mask). Works on documents too, not only the world view.
7. A test that `highlight: {filter: [{subtract: [{dilate: ["candidate", 1]}, "candidate"]}, "solid"]}` tints left-out neighbours with the existing algebra (`18` piece 6 says test, not build; fix only what fails).
8. Surface read for terrain (piece 10): `world_view_read({surface: box})` writes one block per column from today's surface snapshot.

## Files you own

New `src/world/view.ts` (or `src/perception/world-view.ts`; pick the layer the dependency rules allow and say why), `src/server/tools/perception.ts` and `query.ts` (the `view` argument), the session's world-view field, `src/perception/render/render.ts` (`fade`, coarse caption), `world_view_read` in a new tool module.

## Done when

The *Testing* unit items for the world view, `fade` and coarse replacement pass; `06` notes `view` and `fade`; `18`'s pieces 5 and 6 rows are marked built.
