# 05 — Operations & Scripting

**"Axiom, but for agents."** Placing blocks by coordinate is the lowest level of the API, not the main one. The agent mostly works with **selections**, **shapes**, **brushes**, **anchors** and **prefabs**, the way a player works with Axiom's tools. Anything repetitive goes into a **script** that uses the same API.

## Layers

```
 L4  Scripts        build(window_bay, along facade.front, every 4)        (QuickJS)
 L3  Generators     roof · arch · staircase · tower · wall_run · window · stamp(prefab)
 L2  Brushes/edits  fill · hollow · shell · replace · smooth · extrude · offset · sweep · array · mirror · rotate · move
 L1  Selections     shapes · magic wand/similar · view box/lasso · semantic · grow/shrink · boolean ops
 L0  Blocks         set_blocks([{pos, block}])                            (escape hatch)
```

Every layer is a TypeScript function in `ops/`. The MCP tools and the script API are thin bindings over the same functions.

## Selections (L1)

A selection is a reusable, nameable region expression. It is cheap and does not touch the document until an op uses it. The suite follows what 3D and voxel editors offer: box and freehand selection, magic select and boolean combination in Axiom; Select Linked, Select Similar, Select More/Less and Checker Deselect in Blender; shape and region modifiers in WorldEdit. Each tool is adapted for an agent, which has no viewport and no mouse.

### Shapes

```ts
sel.box(min, max)                    sel.polygon(points2d, y0, y1)      // prism over a footprint
sel.cylinder(center, r, h, axis)     sel.ellipsoid(center, radii)       // sel.sphere(center, r)
sel.hull(points)                     // convex hull of points
sel.tube(path, r)                    // polyline/bezier with a radius: roads, walls, pipes
sel.plane(axis, at, within?)         // a one-block slab
```

### Picking (magic wand family)

Seeded from a position, from a pixel in an earlier render (resolved by `raycast`, `06`), or from an existing selection:

```ts
sel.connected(seed, { match, tolerance?, connectivity?: 6|18|26, within? })
    // flood fill ("magic wand" / Select Linked). match: "solid" | "block" | "state" |
    //   "family" | "role" | "colour" (palette colour index, 03) | predicate
sel.similar(seed | sel, { by, tolerance?, within? })
    // everything alike, connected or not (Select Similar). by: block | family | tag | role |
    //   "prop:facing" (any state property) | colour
sel.component(id, { mask?: true })   sel.kind("tower")   sel.tagged("ruined")
sel.view_box(view, rect_px, { depth: "visible" | "through" })
sel.view_lasso(view, polygon_px, { depth: "visible" | "through" })
    // box or lasso drawn on a previous render. "visible" = only the surface blocks the camera
    //   saw; "through" = the whole volume behind the outline (x-ray select)
```

### Semantic

These are measured geometry, never architectural labels (`06`, *measure, don't interpret*): there is no `face`, `storey`, `roof` or `openings` selection, because each needs a threshold-based guess at what the blocks mean. The agent picks walls, floors and roofs itself with boxes, slabs, render picks or flood fills.

```ts
sel.enclosed(seed | n)         // one enclosed air region, by flood fill (n-th largest)
sel.interior(sel)              // all enclosed air inside a shell
sel.surface(sel, { dirs? })    // exposed blocks (only those facing up, out, …)
sel.top(sel)                   // heightmap surface: terrain, roof tops
sel.changed(since)             // the diff since a checkpoint or op (06)
```

### Modifiers

```ts
sel.union(a, b)  sel.subtract(a, b)  sel.intersect(a, b)  sel.xor(a, b)  sel.invert(a, within)
sel.expand(a, n | [dx,dy,dz] | { up, down, north, … })   sel.contract(a, …)     // geometric
sel.grow(a, n, { match? })   sel.shrink(a, n)          // topological, along connected blocks (Select More/Less)
sel.offset(a, dx, dy, dz)    sel.mirror(a, axis, about)   sel.rotate(a, turns, pivot)
sel.shell(a, thickness)      sel.edges(a)              sel.layer(a, y | "min" | "max")
sel.slab(a, axis, from, to)  sel.bbox(a)               sel.convex(a)   sel.fill_holes(a)
sel.filter(a, { block | family | role | tag | air: false } | predicate)
sel.checker(a, { size })     sel.random(a, ratio, seed)   sel.every(a, n, { along })
```

### Naming and feedback

- `select({ name: "nave", ... })` stores a selection. Tools accept a selection inline or by name. `sel.last` is the most recent selection.
- **Expressions are lazy.** A named selection is re-evaluated each time it's used, so `connected` and `similar` follow later edits. `sel.freeze(a)` stores the resolved voxel mask instead.
- Without a viewport the agent can't see what it selected, so every selection call returns a summary: block count, bounding box (public coordinates), top families, and the components touched. `highlight: true` adds a small render with the selection tinted (`06`).

Selections also define the work and context volumes of a scoped session (`11`). Any selection works; it is resolved to a voxel mask at fork time. Inside a sandbox, ops that write outside the work volume are refused.

## Auto-connection

Ops recompute the shapes of blocks that connect to their neighbours: fences, walls, panes and bars, stair shapes, redstone, chests, and plugin-declared connecting blocks (`09`). Like the game, they update both the written block and its neighbours. The game derives these **connection properties** from the surrounding blocks, so the document treats them as derived state, not content. That distinction matters at sandbox seams (`11`). `raw: true` on an op writes states exactly as given (the escape hatch).

## Edits & brushes (L2)

| Op | Meaning |
|----|---------|
| `fill(sel, material)` | Fill with a material expression (`01`) |
| `hollow(sel, thickness, material?)` | Keep a shell, clear the inside |
| `replace(sel, from, to)` | `from` is a block, tag, family or predicate. Shapes map through families (`andesite_stairs → stone_brick_stairs`, preserving state) |
| `paint(sel, material, { surface: true })` | Only exposed faces (weathering, moss) |
| `smooth(sel)` / `erode` / `dilate` | Morphological cleanup (terrain, organic shapes) |
| `extrude(face_sel, n)` | Push a face outward or inward |
| `sweep(profile, path)` | A 2D cross-section along a 3D polyline/bezier (cornices, walls, roads, bridges) |
| `array(sel, step, count)` | Repeat a region (window bays, columns, crenellations) |
| `move / copy / rotate / mirror` | With block-state remapping (`01`) |
| `clear(sel)` | Set to air |

## Generators (L3)

Parametric builders for common architectural elements. Each one takes high-level parameters and a palette, and registers a component:

- `roof({ over: sel|component, style: gable|hip|pyramid|shed|mansard|dome|flat, pitch, overhang, materials: "palette:castle" })` uses stair and slab shapes from the palette role automatically.
- `arch`, `staircase`, `wall_run` (along a path with buttresses or crenellation options), `tower` (polygon footprint plus roof), `window({ on: face, at, w, h, style })`, `door`, `column`.
- `stamp(prefab, { at: anchor|pos, rotate, mirror, palette_remap })` places a library prefab (`07`).
- **Generators are conveniences, not a style system.** Parameters are open. The agent can always fall back to L1/L2.

## Anchors & relative placement

Positions can be expressed relative to existing geometry, so the agent reasons architecturally instead of in absolute coordinates:

```
at: "tower_ne.top"                    at: { face: "keep.front", u: 0.5, v: "storey:2" }
at: { anchor: "gatehouse.door", offset: [0, 0, 3] }
```

- Every component exposes implicit anchors (`min`, `max`, `center`, `top`, `bottom`, the face centres `front/back/left/right`) plus any named anchors.
- `storey:n` resolves only from a named anchor on the component; storey levels are never inferred.
- The resolved absolute coordinates are always echoed in results, so the agent learns the mapping.

## Mod actions

Plugins (`09`) register extra ops under their namespace, e.g. `framed.camo(sel, camo_block)` and `chisel.pattern(sel, "bricks_soft")`. They are discoverable through `ops_list({ namespace })`, run with `op_run({ op, args })` as one journal entry, and callable from scripts.

## Scripting (L4)

- **Runtime:** QuickJS compiled to WASM (`quickjs-emscripten`). It has no filesystem, network or Node access. Memory and time limits are enforced (defaults: 64 MB, 10 s). Node's `vm` is not used because it is not a security boundary.
- **API:** the same `sel`, ops, generators, plugin actions, `palette()`, `component()`, `query()` (read-only) and a seeded `rand()`.
- **Atomicity:** a script run is **one journal entry**. It either commits completely or rolls back on error.
- **Output:** the script's `return` value plus a diff summary. `log()` output is capped (about 2 KB).
- Scripts can be saved to the library as reusable **procedures** (`07`), e.g. `window_bay(face, spacing)`.

```js
// example: crenellations along the keep's top edge
const top = sel.layer(component("keep").region, "max");
array(sel.box([0,0,0],[0,1,0]), { along: sel.perimeter(top), every: 2 })
  .fill("palette:castle.wall");
```

### Script API reference

Resolved (was an open question): the script API is described by TypeScript declarations generated from the script op registry (`script/dts.ts`), served as the MCP resource `autosketch://script/api.d.ts`. Generating them from the same list the sandbox binds keeps the reference from drifting, and declarations are the most compact precise form an agent reads well.

## Op result contract

Every op returns:

```
ok · fill · 1,284 blocks changed · box (0,0,0)–(15,8,11) · component: keep
warnings: 12 positions had block entities (dropped)
```

The optional `preview: true` returns a small render of the affected region with changes highlighted (`06`).

## Implementation status

| Piece | Status |
|-------|--------|
| Selection representation | JSON expression trees, since tool calls send JSON (the `sel.*` JS form in scripts compiles to the same trees). They resolve to a sparse 16³-chunked bitmask (`src/core/mask.ts`) in document-local coordinates. One selection may cover at most 8M blocks. |
| Shapes | `{min,max}` box shorthand, `box`, `"all"`, `cylinder` (center is the base centre; radius + 0.5 like WorldEdit; any axis), `sphere`, `ellipsoid`, `polygon` (prism; the edges are part of the shape), `plane`, `component`, `hull` (of points), `tube` (polyline; distance ≤ radius + 0.5, like `cylinder`). `hull` and `convex` use a 98-direction k-DOP (every primitive integer direction with components in -2..2): exact on axis-aligned and 45° faces, slightly generous on others, and cheap at any size. |
| Picking | `connected` (flood fill; connectivity 6/18/26; `within`; a seed on air adds a note) and `similar`, both matching block/state/family/solid/air and: **`tag`** (the seed's most specific block tag, fewest members then name, echoed in a note; or `tag: "#ns:tag"`), **`role`** (blocks of the families, shapes included, in the roles of a named palette that hold the seed's family or block; `palette` defaults to the only one, `role` picks one role), **`colour`** (families whose mean CIELAB colour (`03`, colour index) is within `tolerance` ΔE76 of the seed family's, default 10; a seed without colour stats matches its block, with a note), **`prop:<name>`** (any block with the seed's value of that state property). Every match is a per-state test over the blocks themselves or registered palette data; nothing is inferred. **`{"kind":"tower"}`** (a trailing `*` matches a prefix, `"prefab:*"`) and **`{"tagged":"ruined"}`** select the union of the boxes of components with that registered kind or tag; a miss is an empty selection with a note listing the kinds or tags that exist. Script forms: `sel.kind(k)`, `sel.tagged(t)`. Render seeds: see *Render-seeded* below. |
| Modifiers | `union`, `intersect`, `subtract`, `xor`, `invert`, `expand`/`contract` (box kernel; a number, `[dx,dy,dz]`, or per direction), `offset`, `shell` (6-neighbour erosion, or 4-neighbour with `walls_only`; equals fill's box shells exactly), `layer`, `surface`, `bbox`, `filter` (block matcher and/or air), `rotate`/`mirror` (same pivots as the ops), `grow` (6-neighbour steps onto `solid` blocks, the `same` block, or `any` position) / `shrink` (drops selected blocks that touch an unselected block, so a whole island never shrinks, like Blender's Select Less), `edges` (open on ≥ 2 axes), `slab`, `convex`, `fill_holes` (6-connected enclosed voids), `checker` (`size`, `odd`), `random` (`ratio`, seeded by the document seed unless `seed`), `every` (`n`, `along`, `offset`, counted from the selection's min), `freeze` (resolved when `select` stores it: the stored form is `{"frozen": [[x,y,z,len],..]}` x-runs; inline it is a no-op). |
| Naming | `select({sel, name})` stores an expression, re-evaluated on each use. Stored selections are saved with the document (not journaled). `"last"` is the previous op's or select's selection. Every `select` returns a summary: count, solid and air, bbox, top blocks, components touched. |
| Ops | `fill`, `clear` and `replace` take `sel`, with `box` kept as shorthand. A selection that is exactly a box takes the box fast path. Shell modes follow the selection's shape, so walls on a cylinder make a round tower. Every op takes `raw` and `as`/`kind` (`as` registers the affected bounding box; for transforms, the destination's). All ops run through one entry point, `opEdit` in `ops/edit.ts`. |
| Transforms | `move`, `copy` (optionally turned/mirrored about its own pivot first), `rotate` (pivot default: the selection's centre block, rounded toward min), `mirror` (`about` default: the selection's exact centre, which may be a half coordinate, so it flips in place) over any selection (`ops/transform.ts`). Sources are read, then cleared, then written, so overlaps work. Air in the selection is carried unless `skip_air`. Block entities travel with their blocks. Components whose box lies wholly inside the selection take the transform, anchors included; `copy` leaves components alone. State remapping lives in `core/rotate.ts` (01, Orientation): rules key on property names (`facing`, `axis`, `rotation`, `hinge`, stair `shape` handedness, rail `shape`, chest `type`, `orientation`, side flags), so they apply to modded blocks that follow vanilla naming; a value the registry rejects stays unchanged; plugins override with `rotate`. **Extension:** mirror also takes `axis: "y"` (flips `half`, slab `type`, `face`, `attachment`, `hanging`, vertical `facing`, up/down flags), e.g. for upside-down stairs. A mirror always swaps stair handedness, also when the stair faces across the mirror axis (geometrically right; vanilla leaves that case alone, and auto-connection re-derives stair shapes anyway). |
| Auto-connection | `ops/connect.ts`. After every non-raw op, the written blocks plus their 6 face neighbours and the 8 vertical diagonals are recomputed in the same journal entry: fences (same fence type, wooden with wooden; gates across the direction; sturdy faces), panes and bars (panes, walls, sturdy faces), walls (low/tall from the block above; post by the vanilla rule), stair shapes (vanilla `getStairsShape`), redstone wire (side/up/none, line and cross fill-in; a freshly written wire starts as a cross, an existing dot stays a dot), chests (pair with a same-facing single chest left or right) and plugin `connection` hooks. "Sturdy face" is approximated by registry shape `full` (minus leaves, pumpkins, melons, barriers, shulker boxes); double slabs and stair backs count too. Fences and walls don't join each other, as in vanilla; a fence does join a solid wall. Ops skip the whole pass while the document holds no connecting block. `reconnectPositions(doc, tx, mask, env)` recomputes exactly a given shell (for sandbox seams, `11`). |
| Brushes | `hollow` (own op; follows the selection's shape), `paint` (exposed blocks; `dirs` limits the open faces), `smooth`/`erode`/`dilate` (one `smooth` tool with `mode`: 3×3×3 majority, or face-neighbour thresholds, default 3; `dilate` uses the most common neighbour unless `material`), `extrude` (face out by n copying blocks, or in by -n clearing; `dir` inferred from the side most of the face touches air), `sweep` (profile cells `{u,v,block}` authored for travel north, u = right of travel; each segment turns the profile and its block states to its main horizontal direction), `array` (`count` total including the original). Hard selections only; no soft falloff. |
| Semantic | Geometry in `perception/semantic.ts` (read-only, no labels); `ops/selection.ts` has thin cases. A scope `S` is any selection, a bare component id (when no stored selection has that name), or `"all"`/`true`. `{"enclosed":[x,y,z]\|n,"of"?:S}` and `{"interior":S}`: enclosed air by 6-connected flood fill (every non-air block bounds it), regions largest first as `analyze` lists them; inside a scope, positions outside it count as air, so a shell selection's inside is enclosed. `{"top":S}`: the highest non-air block per column. `{"changed":"op:-n\|checkpoint:<name>"}`: the diff's positions. `sel.surface` was already a modifier. `face`, `storey`, `roof` and `openings` were removed on 2026-11-07 (architectural labels); `room` became `enclosed`. |
| Render-seeded | `{"view_box":{render?,rect:[x0,y0,x1,y1],depth?}}`, `{"view_lasso":{render?,points:[[px,py],..],depth?}}` in `perception/render/pick.ts`, over the stored cameras (`06`, `raycast`); pixels are in the whole image, and an outline over several cells of a contact sheet picks in each. `visible` (default) casts a ray through sample points at least two per block width (capped at 1M rays, with a note) and keeps the first non-air block. `through` keeps every position of the drawn clip whose centre projects inside the outline, air included (filter with `{"filter":..,"air":false}`). The expression stays lazy and only 8 renders are kept per document, so a stored pick should use `freeze`; a stale render adds a note. |
| Anchors | `ops/anchors.ts`, shared by every `at:` (generators, `stamp`, the `anchor` tool, scripts). Implicit anchors: `min`, `max` (corner blocks), `center`, `bottom` (centre of the lowest layer), `top` (centre, one above the box), `front`/`back`/`left`/`right` (face centres on the box's outer layer at mid-height, through the document's `front`), `storey:n` (box centre at the y of a named `storey:n` anchor). Named anchors win; a bare component id means `base`, else `bottom`. Component ids may contain dots: the longest existing prefix wins. Faces `comp.front|back|left|right|north|south|east|west|top|bottom`; `u` runs left→right as seen from outside, `v` bottom→up (on top/bottom: east, south); a number in 0..1 is a fraction (0 = first block, 1 = last), a larger one a block offset, a negative one counts from the far end, a numeric string is always a block offset. **`storey:n`** is the y of a named anchor `storey:n`/`storey_n` on the component; without one it is an error (storeys are never inferred). Every result echoes `ref = (x,y,z)`. The `anchor` tool resolves, lists, sets and removes named anchors (setting is one journal entry). |
| Generators | `ops/generators/`, each one journal entry through `opEdit` (auto-connected) that registers a component (`as`, default the generator's name, numbered). **`roof`** over any footprint (a selection's xz projection, so round and L-shaped work): each cell gets a distance from the eave (hip/mansard/dome: Euclidean to the nearest outside cell; gable: across the ridge axis; shed: from the low side) and a height in half blocks from it; the top block follows the slope to its inner neighbour (stairs where it rises ≥ 1 per step, bottom/top slabs at ½, full blocks under steep runs and on ridges; hip corners face one axis and auto-connection turns them). `pitch` (multiples of ½), `overhang` (eaves drop so the roof meets the wall top at the original edge), `axis`, `high` (shed), `break` (mansard: pitch 2 for that many steps, then `pitch`, default ½), `base`, gable ends filled by default. `pyramid` is hip (a point on square footprints). Stairs and slabs: explicit `stairs`/`slab`, else the material's palette role resolved per shape (`03`), else the block's family, else the `_stairs`/`_slab` name; with none, a warning and full blocks (a stepped roof). **`arch`** (round, pointed, segmental, flat; ring, depth, jambs; clears the opening), **`staircase`** (straight; `dir`+`height` or a 45° `to`; width right of the climb; solid support; **`shape: "spiral"`**: `height` steps around a newel post at `from`, one ring sector per step (`radius`, default 2; `steps_per_turn`, default 8 up to radius 2 else 4×radius, refused when a sector would get no block; first step on the `dir` side, default north; `turn` cw/ccw seen from above; stairs face the tangent of the climb, a diagonal step keeping the facing of the one before; `support: "none"` drops the post; `landing` anchor one block above, past the last step), **`wall_run`** (path of at: points, centred thickness, merlons every n, stepped buttresses left/right/both, cap course; `curve`: `polyline` (default), `smooth` (uniform Catmull-Rom through every point) or `bezier` (the points are one Bézier curve's control points); curves are sampled, rounded to blocks and joined by 3D lines so there are no gaps, and thickness follows the direction a few blocks either side), **`tower`** (round, square, n-gon or point footprint; hollow walls of any thickness; floors every n; roof as a child component `<id>_roof`; walls, floors and roof are one journal entry via `Document.group`), **`window`** (on a face; plain/arched/cross; glass, frame ring, sill one block out with stairs turned upside-down; `depth` recess), **`door`** (both halves, facing out of the face; double doors hinge on the outer edges; clears above), **`column`** (radius 0 or round; base and capital layers). |
| Scripting | `src/script/`. QuickJS (`quickjs-emscripten`, sync WASM build) with `setMemoryLimit` (64 MB) and an interrupt deadline (10 s, `timeout_ms` up to 60 s); only JSON crosses one host function, so no host object, filesystem, network or Node is reachable. The source is a function body (`args`, `return`). A run is one journal entry: `Document.group` makes every nested `doc.edit` join one transaction; a nested op that throws rolls back alone (a script may catch it), and a throw, timeout or out-of-memory rolls back everything, including selections the script stored. Result: the op's diff summary, ops that changed blocks, components added, the return value (JSON, 4 KB cap) and `log()` (2 KB cap). `rand()` is seeded (document seed) and replaces `Math.random`. **API** (one registry, `script/ops.ts`): `sel.*` builders compiling to the tools' JSON trees, plus `sel.perimeter(a)` (`{shell:a, walls_only:true}`), wrapped in a chainable `Sel` (`.fill`, `.expand`, …); every edit, brush, transform and generator; `array(t, {along, every})` returns copies of a template along a path walked in order (frozen); `component()` (with `.region`, `.anchor()`), `components()`, `anchor()`, `palette()`, `query()` (read-only), `select()`, `positions()`. Plugin ops (09) are `<plugin>.<op>({…op_run args})`, bound by `script/plugins.ts` through `runPluginActionSync` (`ops/plugin-actions.ts`: the same argument check and context as `runPluginAction`, with an `edit` hook so the writes join the run's entry); it refuses an action that returns a promise, and writes made after the call returns. **`stamp(prefab, {at, anchor?, palette_remap?, include_air?, as?, rotate?, mirror?})`** (as the tool): loading a prefab is asynchronous, so `runScript` loads, before the run and outside its time limit, every string literal passed to `stamp(` in the source plus the names in `run_script`'s `prefabs` (for computed names; at most 64 per run), through the library resolver (`script/prefabs.ts`). The script then stamps synchronously from memory, inside its one journal entry, so a later error rolls the stamps back too. A literal that doesn't resolve fails only if it is stamped; a name that wasn't preloaded throws and says how to preload it. `run_procedure` runs library procedures the same way (`07`). |

## Open questions

- Should brushes support "soft" falloff (Axiom sculpt-style) in v1, or only hard selections?
