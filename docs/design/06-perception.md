# 06 — Perception

Helps the agent understand the 3D structure it is editing and relate it to architectural intent, within a token budget.

## Principles

1. **Text first, images on demand.** Exact facts (what block is where, how many storeys) go as text. Images are for gestalt, proportion and verification.
2. **Every image is coordinate-referenced.** Axis ticks, a compass and a grid let the agent map pixels to blocks.
3. **Small by default.** Default images are 512² (~350 tokens). The maximum is 1024² unless explicitly requested.
4. **Answer the question asked.** Prefer a point query or a slice over another full render.

## Tools

### Point and region queries (text, cheapest)

- `query_block(pos)` returns the state, NBT summary and component membership.
- `query_column(x, z)` returns a bottom-to-top run-length list.
- `query_region(sel, { summary })` returns block counts by family and role, the bounding box, and the components inside.
- `raycast({ view, px, py })` returns the block under a pixel in a previous render, to resolve "what is that thing in the image".

### Slices (text grid, exact)

`view_slice({ axis: "y"|"x"|"z", at, region?, legend: "auto" })`

```
y=4  x→ 0         1
z↓   0123456789012345
 0   SSSSSSSSSSSSSSSS      S stone_bricks  W oak_planks
 1   S..............S      G glass_pane    D oak_door[lower]
 2   G..............G      . air
 3   S......W.......D
```

- One character per block, with an auto legend (families first, states abbreviated).
- Cap: 64×64 per call. Larger regions are cropped, with a note. Run-length mode is available for sparse layers.

### Renders (images)

`render({ views, region?, cutaway?, highlight?, size?, style?, context? })`

- **Views:** `iso_ne|iso_nw|iso_se|iso_sw` (3/4 isometric), `front|back|left|right|top` (orthographic elevations, resolved via `front`, `01`), `component:<id>` (auto-framed), or a custom camera `{ yaw, pitch, distance, target }`.
- **Multi-view contact sheet:** `views: ["iso_ne","iso_sw","front","top"]` renders one image as a 2×2 grid. This is cheaper than four calls and makes comparison easier.
- **Cutaway:** `{ maxY }`, `{ plane: "x", at, keep: "west" }`, or a component's interior.
- **Subregions:** `region` takes any selection (`05`). Only blocks inside it are drawn, and only they hide faces, so a cut through solid material draws as a closed surface. The camera frames the region tightly, and axis ticks show the region's own coordinates. This was verified for boxes on 2026-11-07 (a cube cut from a 40×12×40 solid). Masks work the same way: the tool layer resolves the selection and the renderer takes the mask.
- **Highlight:** a selection or the last op's diff drawn as a tint or outline.
- **Context volume** (in a sandbox, `11`): `context: "ghost"` (default, desaturated and translucent) | `"normal"` | `"hide"`, so read-only surroundings are never mistaken for editable blocks.
- **Overlays:** axis ticks every 4/8/16 blocks (adaptive), a compass, and component labels (optional).
- **Styles:** `textured` (default, real models and textures from `02`), `flat` (mean colours, faster and clearer for structure), `depth` (shaded by distance, for reading 3D form), `xray` (translucent shell).
- The renderer is a pure-JS software rasterizer: baked models → triangles → z-buffer → PNG via `pngjs`. Back-face and occlusion culling at block level.

### Cameras

Besides the named orthographic views, a render can take a camera. Each camera is a standard graphics or CAD device that re-presents the build so hidden shape becomes visible, interiors especially. None of them interprets anything (*measure, don't interpret*). The server ships no camera policy: skills in the library (`07`) describe when to reach for which, and the agent chooses.

- **Perspective:** `{ eye: [x,y,z], target: pos | anchor | {sel: selection}, fov?: 70 }`. The eye can sit anywhere, including inside an enclosed space, so an interior can be seen the way a player sees it. `fov` is vertical, as in Minecraft. Eye and target are in blocks, and an integer is the block's centre: `[5,2,5]` sits in the middle of block (5,2,5), and rounding any position gives the block it lies in. Fractions are allowed (a player's eye is 1.62 above their feet). An anchor target is its block. A selection target aims at the selection's centre and is framed: without `fov`, the fov is fitted so the selection's box fills the view (5° to 120°; 70° when the eye is inside or beside the box).
  - The rasterizer divides by depth and clips every triangle against a near plane 0.05 blocks in front of the eye, so an eye inside a room or right against a wall sees no inverted or smeared geometry. Back faces are culled per face from the eye position; block-level occlusion culling is view-independent. The z-buffer holds −1/depth, which is linear in screen space, and textures are interpolated perspective-correctly.
  - A 512² perspective render costs about the same as an orthographic one. On the golden builds (2026-11-08, one view, textured, warm caches): cottage 47 ms orthographic (`iso_se`), 44 ms perspective from outside, 61 ms with the eye inside the house (near faces fill the screen); sampler 28, 25 and 34 ms.
- **Saved cameras:** `camera({ name, eye, target, fov? })` stores one, `views: [{ camera: "name" }]` reuses it, `camera({ name })` shows one, `camera({})` lists them and `camera({ name, delete: true })` removes one. Saved cameras live on the document like saved selections: saved with it, not journaled. A target is resolved when the camera is saved (an anchor to its block, a selection to its centre, with the fov fitted for a square view), so a saved camera is always eye, target point and fov. The document keeps them in store coordinates (`04`), so a re-origin moves them with the blocks. `saveCamera(doc, name, camera)` in `document/cameras.ts` is the API the world link uses: a linked document saves the requesting player's view as `player` (`13`, *Prompting from the game*), with `lookTarget(eye, yaw, pitch)` turning Minecraft's yaw and pitch into a target.
  - **Forks** (`11`): a sandbox gets the cameras whose eye lies inside its work or context volume, translated into its frame as anchors are. The others would look from outside what the sandbox holds, so they stay behind. Cameras saved inside a sandbox stay with it and are not merged back: a merge carries blocks and components, and a camera is a viewpoint for that job.
- **Near clip:** `near: n` drops every block whose centre is closer than `n` blocks to the eye, measured along the view, so the front of the build falls away without the agent choosing a cut plane. Orthographic views have no eye, so they measure from the front of the drawn box: `near: 1` on an elevation removes exactly the front layer. (The plan said "the plane through `target`"; named views have no target, and measuring from the front gives the same meaning to `n` in every view.) The clip works on whole blocks, like `region`: a dropped block hides nothing, so cut faces draw closed. It applies to every view of the render and is stored with each view's camera, so `raycast` and the view picks skip what it removed.
- **Section box:** `section: box | selection` clips the scene to a box, as in Revit or SketchUp. It generalises the single-plane cutaway: remove one octant (`{"subtract": [<box>, <octant>]}`) to expose a corner of the interior. It intersects with `region` and `cutaway`, and cut faces draw closed, as `region` already does.
- **Depth peeling:** `peel: n` draws the n-th visible surface along each ray instead of the first (1 is a normal render). `peel: 2` shows what lies directly behind a façade, without a cut.
- **Cubemap:** `views: [{ cubemap: pos }]` renders the six faces seen from one point as a labelled 3×2 contact sheet: a whole room at a glance.
- **Exploded view:** `explode: { axis: "y", at: [y, …], gap }` splits the build at the given layers and spreads the bands apart in one image.
- **Turntable:** `views: [{ turntable: target, steps?: 8, pitch? }]` renders a ring of views around a target as one contact sheet.
- Every camera composes with the existing options: `region`, cutaways, styles, highlights, context ghosting and size. Every camera is stored for `raycast` and `view_box`/`view_lasso` like any render. Perspective images carry no axis ticks, since ticks wouldn't be uniform; the caption gives eye, target and fov, and `raycast` resolves any pixel to a block.

### Structural measurements (text, high value)

`analyze({ component? | region? })` returns compact, objective measurements of the build:

```
box: (-1,0,-1)–(9,9,7), 11×10×9 (x×y×z); 306 blocks; front=south
layers (blocks, x/z extent, share of extent filled):
  y=0: 63 in x 0..8, z 0..6 (9×7, 100% filled)
  y=1..4: 28 in x 0..8, z 0..6 (9×7, 44% filled)
  y=5: 36 in x -1..9, z -1..7 (11×9, 36% filled)
  …
materials: oak_planks 146 (48%), oak_stairs 88 (29%), cobblestone 63 (21%), glass_pane 7 (2%), oak_door 2 (1%)
connectivity: 1 group (faces, edges and corners join); all reach the bottom layer (y=0)
enclosed air (not reachable from outside; any block bounds it): 1 region: 252 in (1,1,0)–(7,8,6)
```

**Principle: measure, don't interpret.** The server never names architectural elements: no storeys, walls, roofs, windows, doors, rooms or facades, and no "issues". Labelling needs thresholds (how much coverage is a floor? how wide is a window?), and every fixed threshold mislabels the builds that sit near it or don't fit the template a house-shaped detector assumes. The model already knows architecture, so the server hands it facts and leaves the reading to it. The same rule applies to selections (`05`, *Semantic*) and anchors (`storey:n` comes only from a named anchor). See also `07`: heuristics are advisory resources the agent may consult, not server verdicts.

What is measured:
- **Layers:** for every y, the block count, the x/z extent of those blocks and the share of that extent filled. Consecutive layers with the same extent and count are merged in the text; past 48 rows the middle is elided (use `region` or `view_slice`).
- **Materials:** block ids by count (states ignored).
- **Connectivity:** groups of blocks joined through faces, edges or corners (26 neighbours), and any group that does not reach the bottom layer of the measured box.
- **Enclosed air:** 6-connected air not reachable from outside the box. Every non-air block bounds it, whatever its shape; there is no minimum size.

### Diffs

`diff({ since: "checkpoint:name" | "op:-3" })` returns a text summary (counts by family and the regions changed) plus an optional before/after render pair with the changes highlighted.

## Token budget (guidance shipped in the server instructions)

| Need | Use | ~Tokens |
|------|-----|---------|
| "What's at X?" | `query_block` / `query_column` | < 50 |
| Exact layout of a floor | `view_slice` | 300–1,500 |
| Exact structural numbers (layers, materials, enclosed air) | `analyze` | 200–400 |
| Overall look / proportion | `render` 2×2 sheet @ 768² | ~800 |
| Detail check | `render component:<id>` @ 512² | ~350 |
| Verify the last edit | op `preview: true` | ~350 |

Each tool's description carries its cost hint.

## Implementation status

| Piece | Status |
|-------|--------|
| `query_block`, `query_column`, `query_region` | Done (`perception/query.ts`, `tools/query.ts`). `query_region` counts by family (palette index) and by role of the document's named palettes, and lists components fully or partly inside. It does not change `"last"`. |
| `view_slice` | Done. `mode: "runs"` lists each non-empty row as runs (`x0-15 S, x20 G`) with a 256×256 cap; grid mode suggests it for large sparse layers. |
| `render` styles | `textured`, `flat`, `depth` (flat colours darkened with distance along the view), `xray` (all shell faces, both sides, blended at 28%; highlighted blocks stay solid). |
| `render` views | Named views, `component:<id>` (iso from the south-east, framed on the component box), custom `{yaw, pitch, distance?, target?}`. These views are orthographic, so `distance` is a zoom: the view frames a sphere of that radius around `target`. Perspective `{eye, target, fov?}` and saved `{camera}` views: see *Cameras*. |
| `render` region, cutaway | `region` takes any selection (resolved to a mask by the tool layer; an exact box takes the box path). Cutaways: `{maxY}` and `{plane, at, keep}` (the plane's own layer stays). A component-interior cutaway is not done. |
| `render` highlight | A resolved mask (any selection; `{"changed":"op:-1"}` for a diff is the preferred form, `{since}` still works), tinted orange; highlighted air is drawn as wire cubes. The scene carries per-block flags; `CONTEXT` marks a sandbox's context volume. |
| Context volume | `render({ context: "ghost"\|"normal"\|"hide" })` over `doc.context` (`11`). Ghosted blocks are a desaturated light grey at 30% opacity and never cull the faces of editable blocks behind them; the caption counts them. `view_slice` appends `\| ctx` to rows that are wholly context and `\| ctx x3..4` (column ranges) to rows that are partly context. |
| `render` overlays | Component labels, opt-in. (Storey lines were removed with architectural labelling.) |
| Cameras | In progress (silo T). Done: perspective views with near-plane clipping (`render/raster.ts`, `render/render.ts`), mixed freely with orthographic views in one sheet and captioned with eye, target and fov; saved cameras (`document/cameras.ts`, the `camera` tool in `tools/camera.ts`, saved in the native file as `Cameras`, carried into forks); `raycast`, `view_box` and `view_lasso` cast perspective rays from the stored camera (`render/cameras.ts`, `render/pick.ts`). `near` and `section` (render options; whole blocks, cut faces closed, honoured by `raycast` and the picks). Not yet: depth peeling, cubemap, turntable, exploded view. |
| `raycast` | Done. The cameras of the last 8 renders are kept per document (`perception/render/cameras.ts`, not saved); the render caption gives the id. Hits are voxel-level (the first non-air block in the drawn clip), with the face entered (a perspective ray starts at the eye), and warn when the document changed since the render. |
| Op `preview: true` | On `set_blocks`, `fill`, `clear`, `replace`, the transforms (`move`, `copy`, `rotate`, `mirror`) and the brushes (`hollow`, `paint`, `smooth`, `extrude`, `sweep`, `array`): one 512² iso view of the changed box plus 2 blocks, changes highlighted. |
| `analyze` | Done (`perception/analyze.ts`): measurements only, see *Structural measurements*. Checked against three fixture buildings in `test/helpers/buildings.ts`. The earlier architectural labelling (footprint, walls, storeys, openings, roof type, rooms, issues, proposed components) was removed on 2026-11-07. |
| `diff` | Done (`perception/diff.ts`): `checkpoint:<name>` (or a bare name) and `op:-n`, in either journal direction; counts by family (added, removed, replaced, state-only changes) and up to 5 clustered regions. `render: true` adds before/after 384² images of the changed area, the before image from a read-only snapshot. |
| Morphological and render-seeded selections | Done: `enclosed`, `interior`, `heightmap`, `changed` (`perception/morphology.ts`, measured geometry with no labels) and `view_box`/`view_lasso` with `depth: visible\|through` (`perception/render/pick.ts`, using the stored cameras). `face`, `storey`, `roof`, `openings` were removed with architectural labelling; `room` is now `enclosed`. `ops/selection.ts` calls into them read-only; see `05`, *Implementation status*, for the JSON forms. `render` `highlight` takes `{changed}` like any selection; `{since}` still works. |
| Events | `render`, `diff` with `render: true` and op previews emit `render.produced` (`source: "tool"`, view labels joined by commas, image size) through the session's event sink (`12`). |

## Open questions

- Is there a reliable heuristic for "iso view with the least occlusion of the region of interest"? (Auto-pick the camera.) Robotics calls this next-best-view planning. With cheap framing defaults on each camera, a skill may be enough.
- Should the agent be able to register reference images (user sketches or photos) for side-by-side comparison? (Likely yes, as a library item.)
