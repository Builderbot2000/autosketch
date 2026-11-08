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
- **Context volume** (in a sandbox, `11`; not yet implemented): `context: "ghost"` (default, desaturated and translucent) | `"normal"` | `"hide"`, so read-only surroundings are never mistaken for editable blocks.
- **Overlays:** axis ticks every 4/8/16 blocks (adaptive), a compass, component labels (optional), and storey lines (optional).
- **Styles:** `textured` (default, real models and textures from `02`), `flat` (mean colours, faster and clearer for structure), `depth` (shaded by distance, for reading 3D form), `xray` (translucent shell).
- The renderer is a pure-JS software rasterizer: baked models → triangles → z-buffer → PNG via `pngjs`. Back-face and occlusion culling at block level.

### Structural analysis (text, high value)

`analyze({ component? | region? })` returns a compact architectural description:

```
footprint: 24×16, rectangular, front=south
storeys: 3 (floor y=0, 5, 10; heights 5,5,4)
walls: thickness 1, material wall=stone_bricks mix
openings: front 6 windows (2 per storey, rhythm 4), 1 door (center); left 3 windows; back 0; right 3 windows
roof: gable, ridge along x at y=19, pitch 1:1, overhang 1
rooms: 5 enclosed (largest 10×7 on storey 1)
issues: 2 floating blocks at (3,12,4),(3,12,5); roof gap at (0,15,8)
proposed components: storey_1..3, roof, door_main
```

Detection methods:
- Storeys: horizontal layers with high solid coverage inside the footprint.
- Rooms: 3D flood fill of enclosed air.
- Openings: wall-plane gaps and glass, door and pane blocks.
- Roof: stair/slab topology above the top storey.
- Issues: unsupported blocks, holes in the shell, z-fighting materials.

The vocabulary is shared with knowledge packs (`07`), so the agent's style guidance and the analysis output use the same terms.

### Diffs

`diff({ since: "checkpoint:name" | "op:-3" })` returns a text summary (counts by family and the regions changed) plus an optional before/after render pair with the changes highlighted.

## Token budget (guidance shipped in the server instructions)

| Need | Use | ~Tokens |
|------|-----|---------|
| "What's at X?" | `query_block` / `query_column` | < 50 |
| Exact layout of a floor | `view_slice` | 300–1,500 |
| "Does the structure make sense?" | `analyze` | 200–400 |
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
| `render` highlight | A resolved mask (any selection; `{"changed":"op:-1"}` for a diff is the preferred form, `{since}` still works), tinted orange; highlighted air is drawn as wire cubes. The scene carries per-block flags; `CONTEXT` is reserved for sandbox ghosting (`11`), not drawn yet. |
| `render` overlays | Component labels and storey floor lines (from `analyze`), both opt-in. |
| `raycast` | Done. The cameras of the last 8 renders are kept per document (`perception/render/cameras.ts`, not saved); the render caption gives the id. Hits are voxel-level (the first non-air block in the drawn clip), with the face entered, and warn when the document changed since the render. |
| Op `preview: true` | On `set_blocks`, `fill`, `clear`, `replace`, the transforms (`move`, `copy`, `rotate`, `mirror`) and the brushes (`hollow`, `paint`, `smooth`, `extrude`, `sweep`, `array`): one 512² iso view of the changed box plus 2 blocks, changes highlighted. |
| `analyze` | Done (`perception/analyze.ts`), see *Analysis methods* below. Checked against three fixture buildings in `test/helpers/buildings.ts` (gable house, two-storey hip roof, tower with battlements). Not done: z-fighting materials, round-footprint openings (openings are found on the footprint's bounding-box sides), dome/mansard roofs (reported as `other`). |
| `diff` | Done (`perception/diff.ts`): `checkpoint:<name>` (or a bare name) and `op:-n`, in either journal direction; counts by family (added, removed, replaced, state-only changes) and up to 5 clustered regions. `render: true` adds before/after 384² images of the changed area, the before image from a read-only snapshot. |
| Semantic and render-seeded selections | Done: `face`, `storey`, `roof`, `room`, `interior`, `openings`, `top`, `changed` (`perception/semantic.ts`, using `analyze`) and `view_box`/`view_lasso` with `depth: visible\|through` (`perception/render/pick.ts`, using the stored cameras). `ops/selection.ts` calls into them read-only; see `05`, *Implementation status*, for the JSON forms. `render` `highlight` takes `{changed}` like any selection; `{since}` still works. |
| Events | `render`, `diff` with `render: true` and op previews emit `render.produced` (`source: "tool"`, view labels joined by commas, image size) through the session's event sink (`12`). |

### Analysis methods

- **Blocks are classed by id:** doors and fence gates (door), glass, panes and bars (window), stairs and slabs (roof material), decor (torches, flowers, carpets, signs, trapdoors and other non-colliding blocks; the registry's `shape: none` too), walls and fences (partial), everything else solid.
- **Footprint:** the commonest per-layer bounding box of wall-like blocks, so roof overhangs don't count. Shape is rectangular when the walls cover ≥ 85% of its edge, round when the corners are empty.
- **Walls:** layers where at least 3 of the 4 footprint sides are ≥ 50% covered (gable triangles cover only 2). Thickness is the median inward run at the first storey's mid-height.
- **Storeys:** floors are layers with ≥ 60% of the footprint interior covered (a thick floor counts at its top layer). A floor with fewer than 3 layers above it before the next floor or the top of the walls is a roof deck, not a storey.
- **Openings:** 4-connected gaps, glass and doors in each side's wall plane. Air two high from a storey floor counts as a doorway; anything wider than 5 or larger than 15 blocks is a wide gap.
- **Roof:** the heightmap above the top storey (bottom slabs count half). Flat when the interior is level within one block, with a parapet or battlements from the raised rim. Otherwise the slope statistics pick gable or shed (one axis) or hip or pyramid (both). Pitch is measured along the middle of the roof.
- **Rooms:** 6-connected air (and decor) not reachable from outside; pockets under 8 blocks are counted separately.
- **Issues:** floating groups are not connected to the bottom layer, even diagonally (stair roofs step diagonally and hold in the game). Roof gaps are footprint columns with no roof block, or pits 2 or more below all four neighbours.

## Open questions

- Is there a reliable heuristic for "iso view with the least occlusion of the region of interest"? (Auto-pick the camera.)
- Should the agent be able to register reference images (user sketches or photos) for side-by-side comparison? (Likely yes, as a library item.)
