# 05 — Operations & Scripting

**"Axiom, but for agents."** Placing blocks by coordinate is the lowest level of the API, not the main one. The agent mostly works with **selections**, **shapes**, **brushes**, **anchors** and **prefabs**, the way a player works with Axiom's tools. Anything repetitive goes into a **script** that uses the same API.

## Layers

```
 L4  Scripts        build(window_bay, along facade.front, every 4)        (QuickJS)
 L3  Generators     roof · arch · staircase · tower · wall_run · window · stamp(prefab)
 L2  Brushes/edits  fill · hollow · shell · replace · smooth · extrude · offset · sweep · array · mirror · rotate · move
 L1  Selections     box · polygon · cylinder · sphere · component · mask(predicate) · boolean ops
 L0  Blocks         set_blocks([{pos, block}])                            (escape hatch)
```

Every layer is a TypeScript function in `ops/`. The MCP tools and the script API are thin bindings over the same functions.

## Selections (L1)

A selection is a reusable, nameable region expression. It is cheap and does not touch the document until an op uses it.

```ts
sel.box(min, max)               sel.polygon(points2d, y0, y1)
sel.cylinder(center, r, h, axis) sel.sphere(center, r)
sel.component("tower_ne")       sel.face("keep", "front")          // a facade plane of a component
sel.mask(base, { block: "#minecraft:logs" | predicate })
sel.union(a, b)  sel.subtract(a, b)  sel.intersect(a, b)
sel.shell(a, thickness)  sel.offset(a, dx, dy, dz)  sel.expand(a, n)  sel.layer(a, y)
```

Tools accept a selection inline or by name (`select({ name: "nave", ... })` stores it).

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

## Open questions

- The exact script API surface. Proposal: generate TypeScript `.d.ts` from the op registry and expose it as an MCP resource so the agent can read it.
- Should brushes support "soft" falloff (Axiom sculpt-style) in v1, or only hard selections?
