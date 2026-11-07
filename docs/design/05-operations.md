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

These are derived from analysis (`06`), so they use its vocabulary:

```ts
sel.face("keep", "front")      sel.storey(2, "keep")     sel.roof("keep")
sel.room(seed | id)            // enclosed air, by flood fill
sel.interior(sel)              // enclosed air inside a shell
sel.openings("keep.front")     // windows, doors, gaps in a wall plane
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
- `storey:n` resolves from analysis (`06`) or from component metadata.
- The resolved absolute coordinates are always echoed in results, so the agent learns the mapping.

## Mod actions

Plugins (`09`) register extra ops under their namespace, e.g. `framed.camo(sel, camo_block)` and `chisel.pattern(sel, "bricks_soft")`. They are discoverable through `ops_list({ namespace })` and callable from scripts.

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
| Selection representation | JSON expression trees, since tool calls send JSON (the `sel.*` JS form is for scripting and will compile to the same trees). They resolve to a sparse 16³-chunked bitmask (`src/core/mask.ts`) in document-local coordinates. One selection may cover at most 8M blocks. |
| Shapes | `{min,max}` box shorthand, `box`, `"all"`, `cylinder` (center is the base centre; radius + 0.5 like WorldEdit; any axis), `sphere`, `ellipsoid`, `polygon` (prism; the edges are part of the shape), `plane`, `component`. |
| Picking | `connected` (flood fill; match block/state/family/solid/air; connectivity 6/18/26; `within`; a seed on air adds a note) and `similar` (block/state/family). Seeds from renders (`view_box`/`view_lasso`/`raycast`) wait on `06`. |
| Modifiers | `union`, `intersect`, `subtract`, `xor`, `invert`, `expand`/`contract` (box kernel; a number, `[dx,dy,dz]`, or per direction), `offset`, `shell` (6-neighbour erosion, or 4-neighbour with `walls_only`; equals fill's box shells exactly), `layer`, `surface`, `bbox`, `filter` (block matcher and/or air). |
| Naming | `select({sel, name})` stores an expression, re-evaluated on each use. Stored selections are saved with the document (not journaled). `"last"` is the previous op's or select's selection. Every `select` returns a summary: count, solid and air, bbox, top blocks, components touched. |
| Ops | `fill`, `clear` and `replace` take `sel`, with `box` kept as shorthand. A selection that is exactly a box takes the box fast path. Shell modes follow the selection's shape, so walls on a cylinder make a round tower. |
| Not yet | `hull`, `tube`, semantic selections (`face`, `storey`, `room`, `interior`, `openings`, `changed`, which need `06`), `grow`/`shrink`, `mirror`/`rotate` (with the transforms), `checker`/`random`/`every`, `freeze`, `highlight` renders. |

## Open questions

- The exact script API surface. Proposal: generate TypeScript `.d.ts` from the op registry and expose it as an MCP resource so the agent can read it.
- Should brushes support "soft" falloff (Axiom sculpt-style) in v1, or only hard selections?
