# Silo T: Render cameras

**Independent of the world silos.** Start any time; it runs alongside world wave 1. Land deliverable 1 (saved cameras and the perspective camera) first, in its own merge: world silo S saves the player's view as a saved camera (`13`, *Prompting from the game*).

**Specs:** `06` (*Cameras*, *Renders*, `raycast`, render-seeded selections, *Token budget*), `05` (`view_box`, `view_lasso`), `13` (*Prompting from the game*: the `player` camera), `01` (*Terminology*), `07` (skills), `11` (what crosses a fork).

## Goal

Let the agent see shape that is hidden, interiors especially, by giving it more ways to look: standard graphics and CAD cameras that re-present the build. Nothing interprets the build. The server ships no camera policy; a skill advises, and the agent chooses (`06`, *measure, don't interpret*).

## Deliverables, in merge order

1. **Perspective and saved cameras.**
   - The rasterizer (`render/raster.ts`) gains a perspective camera: `{ eye, target, fov }`, with the perspective divide and **near-plane clipping of triangles**. An eye inside a room must never produce inverted or smeared geometry. Back-face and block-level occlusion culling must work from the eye position, not from a single view direction.
   - `render` views accept `{ eye: [x,y,z], target, fov? }` and `{ camera: "<name>" }`. `target` is a position, an anchor (through `ops/anchors.ts`) or a selection, which is framed. `fov` is vertical, as in Minecraft, and defaults to 70°. Perspective and orthographic views can share one contact sheet.
   - A `camera` tool (`camera({ name, eye, target, fov? })`, plus list and remove) in its own module, `src/server/tools/camera.ts`. Saved cameras live on the document like saved selections: saved with it, not journaled, in document-local coordinates. Export `saveCamera(doc, name, camera)` for silo S.
   - Frames: a re-origin moves saved cameras with the document. Decide what a fork does with them (suggested: copy the cameras whose eye lies inside the sandbox's volumes and translate them, as anchors are translated, `11`). Record the decision in `06`.
   - Perspective captions give eye, target and fov instead of axis ticks.
   - `raycast`, `view_box` and `view_lasso` cast perspective rays from the stored camera (`render/cameras.ts`, `pixelRay`/`rayThrough`, `render/pick.ts`).
2. **Near clip and section box** (`near: n`, `section: box | selection`). Cut faces draw closed, as `region` already does. Both compose with `region` and `cutaway`.
3. **Depth peeling** (`peel: n`): the n-th visible surface along each ray. `peel: 1` is today's render.
4. **Composite views:** `{ cubemap: pos }` (six labelled faces, 3×2), `{ turntable: target, steps?: 8, pitch? }` and `explode: { axis, at, gap }`. A composite view counts as one view against the four-views limit (`render.ts`) and has its own size cap. Give each a token-cost hint in the tool description and a row in `06`'s *Token budget*.
5. **A skill** in the starter library, `library/knowledge/skills/inspect-interiors.md`, next to `review.md`. It covers when each camera helps and the order to try them. It also says that images are for overall form and spotting, while exact positions are confirmed with `view_slice` or `query_column`. Like every pack, it is advisory and user-editable, and the server never names it (`07`).

## Files you own

- `src/perception/render/**`, the `render` tool in `src/server/tools/perception.ts`, new `src/server/tools/camera.ts` (and one line in `tools/index.ts`), `library/knowledge/skills/inspect-interiors.md`, matching tests in `test/unit/perception/` and `test/unit/server/`.
- Additive: saved-camera storage in `src/document/document.ts` and document persistence (P and Q also touch `document.ts`: additive only, rebase often); fork translation in `src/scope/scopes.ts` (Q touches it too).
- `06`'s *Cameras* section and its *Implementation status* row.

## Done when

- A perspective render with the eye inside a closed box shows the box's inside walls with the expected colours (pixel assertions, `flat` style). An eye one block from a wall shows no artifacts.
- `raycast` on a perspective render hits the expected block and face; a `view_box` drawn on one picks the expected blocks, `visible` and `through`.
- A section box that removes one octant of a hollow cube shows the inside corner. `peel: 2` on a walled room returns the colour of a block placed just inside the wall.
- A cubemap sheet has six labelled faces; a turntable with 8 steps is one image within its cap.
- A saved camera survives save and reopen, and `render({ views: [{ camera: "x" }] })` matches rendering the same camera inline.
- Every existing render, slice and golden render test passes unchanged: today's views don't move by a pixel.
- A 512² perspective render costs about the same time as an orthographic one on the golden builds; record both numbers in `06`.
- `06`'s *Cameras* row is marked done, with anything left out listed.
