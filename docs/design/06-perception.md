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
| `render` views | Named views, `component:<id>` (iso from the south-east, framed on the component box), custom `{yaw, pitch, distance?, target?}`. Views are orthographic, so `distance` is a zoom: the view frames a sphere of that radius around `target`. |
| `render` region, cutaway | `region` takes any selection (resolved to a mask by the tool layer; an exact box takes the box path). Cutaways: `{maxY}` and `{plane, at, keep}` (the plane's own layer stays). A component-interior cutaway is not done. |
| `render` highlight | A resolved mask (any selection; `{"changed":"op:-1"}` for a diff is the preferred form, `{since}` still works), tinted orange; highlighted air is drawn as wire cubes. The scene carries per-block flags; `CONTEXT` marks a sandbox's context volume. |
| Context volume | `render({ context: "ghost"\|"normal"\|"hide" })` over `doc.context` (`11`). Ghosted blocks are a desaturated light grey at 30% opacity and never cull the faces of editable blocks behind them; the caption counts them. `view_slice` appends `\| ctx` to rows that are wholly context and `\| ctx x3..4` (column ranges) to rows that are partly context. |
| `render` overlays | Component labels, opt-in. (Storey lines were removed with architectural labelling.) |
| `raycast` | Done. The cameras of the last 8 renders are kept per document (`perception/render/cameras.ts`, not saved); the render caption gives the id. Hits are voxel-level (the first non-air block in the drawn clip), with the face entered, and warn when the document changed since the render. |
| Op `preview: true` | On `set_blocks`, `fill`, `clear`, `replace`, the transforms (`move`, `copy`, `rotate`, `mirror`) and the brushes (`hollow`, `paint`, `smooth`, `extrude`, `sweep`, `array`): one 512² iso view of the changed box plus 2 blocks, changes highlighted. |
| `analyze` | Done (`perception/analyze.ts`): measurements only, see *Structural measurements*. Checked against three fixture buildings in `test/helpers/buildings.ts`. The earlier architectural labelling (footprint, walls, storeys, openings, roof type, rooms, issues, proposed components) was removed on 2026-11-07. |
| `diff` | Done (`perception/diff.ts`): `checkpoint:<name>` (or a bare name) and `op:-n`, in either journal direction; counts by family (added, removed, replaced, state-only changes) and up to 5 clustered regions. `render: true` adds before/after 384² images of the changed area, the before image from a read-only snapshot. |
| Morphological and render-seeded selections | Done: `enclosed`, `interior`, `heightmap`, `changed` (`perception/morphology.ts`, measured geometry with no labels) and `view_box`/`view_lasso` with `depth: visible\|through` (`perception/render/pick.ts`, using the stored cameras). `face`, `storey`, `roof`, `openings` were removed with architectural labelling; `room` is now `enclosed`. `ops/selection.ts` calls into them read-only; see `05`, *Implementation status*, for the JSON forms. `render` `highlight` takes `{changed}` like any selection; `{since}` still works. |
| Events | `render`, `diff` with `render: true` and op previews emit `render.produced` (`source: "tool"`, view labels joined by commas, image size) through the session's event sink (`12`). |

## Open questions

- Is there a reliable heuristic for "iso view with the least occlusion of the region of interest"? (Auto-pick the camera.)
- Should the agent be able to register reference images (user sketches or photos) for side-by-side comparison? (Likely yes, as a library item.)
