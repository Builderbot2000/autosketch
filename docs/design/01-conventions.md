# 01 — Conventions

These contracts are shared by every tool, render label and file format. Changing them later breaks prompts, tests and saved prefabs, so they are fixed here.

## Coordinates

- **Axes match Minecraft:** +X = east, +Y = up, +Z = south. Integer block coordinates.
- **Document-local space.** Every coordinate an agent sees is local to the current schematic. A new document starts with (0,0,0) at the minimum corner of its declared size. World placement is an export concern (`08`), never an ops concern.
- **Coordinates are stable while editing.** If an op writes outside the current bounds, the document grows, into negative coordinates if needed (a roof overhang at x=-1 makes the bounds start at -1). Existing coordinates never change, so a planned build stays valid op after op. Op results report the bounds when they extend below zero. **Exports normalise**: the exported file's minimum corner is (0,0,0), and the export result reports the offset.
  - *Why:* an earlier rule renumbered the document after every op so the minimum corner stayed at (0,0,0). In the first real test build each roof-overhang row shifted every later coordinate by one, which smeared the build. Agents plan in absolute coordinates, so the frame must not move under them.

## Regions

- **Public API: inclusive boxes** `{min:[x,y,z], max:[x,y,z]}`. This is what Axiom, WorldEdit and players use. `{min:[0,0,0], max:[0,0,0]}` is one block.
- **Internal: half-open** `[min, max)`, so size arithmetic is simple. Conversion happens only at the `server/` boundary.
- Every op result echoes the affected box in public (inclusive) form.
- Corners may be given in any order. They are normalised.

## Orientation

- **Front.** Each document and prefab has a `front` facing. The default is `south` (+Z), so the default "front elevation" view looks north at the +Z face. The agent may change `front` per document. Facade names (`front`, `back`, `left`, `right`) resolve through it.
- **Rotation** is in 90° steps, clockwise when viewed from above (matching Minecraft `Rotation.CLOCKWISE_90`), about a pivot. The default pivot is the selection's centre, rounded toward the minimum corner.
- **Mirror** is across an axis plane: `x` flips east↔west, `z` flips north↔south, `y` flips up↔down (remapping `half`, `attachment`, `face` and `facing=up|down`).
- Rotating or mirroring block content **always remaps block states** (facing, axis, rotation, hinge, shape, half, attachment, multipart side flags) using the registry's state rotation tables plus plugin overrides (`09`).
- **Stair semantics** are documented once and repeated in tool descriptions: `facing` = the direction you walk to climb the stair. A roof slope that descends toward the south uses `facing=north`.

## Block identity

- **Canonical form:** `namespace:path[prop=value,...]` with properties sorted alphabetically. The namespace defaults to `minecraft`. Omitted properties take the registry default (or the game default when there is no registry).
- **Block entities:** a position may carry an NBT compound, stored alongside the state (`04`). Ops that move or copy blocks move the NBT with them. Ops that replace a block drop its NBT unless the replacement is in the same plugin-declared compat group.
- **Unknown blocks** (not in the registry) are **never dropped or rewritten**. They round-trip verbatim, render as a magenta "unknown" cube, and appear in warnings.
- **DataVersion** is tracked per document. Craftoria (1.21.1) uses `3955`. Exports write the target instance's DataVersion.

## Patterns

Anywhere a block argument is accepted, a **pattern** is also accepted (WorldEdit's term for a block mix):

```
"stone_bricks"                                         single block
"stone_bricks 70%, mossy_stone_bricks 30%"              weighted mix
{"gradient": [...], "axis": "y", "range": [0,12]}       dithered gradient
{"noise": [...], "scale": 6}                            organic patches
{"tile": "checker", "blocks": [...], "size": 1}         tiling
"palette:castle.wall"                                   named palette role (03)
```

Patterns are deterministic for a given `seed` (default: the document seed). Tools take them as `pattern` (`fill`, `paint`, `hollow`, `smooth`), or wherever a single block goes (`block`, `to`). The old `{"pattern": "checker"}` form is refused with a message naming `tile`.

## Output conventions for tools

- Results are terse text: what changed, how many blocks, the affected box, warnings. No block dumps unless explicitly requested.
- Errors say what was wrong and how to fix it. Example: `"facing=up is invalid for oak_stairs; valid: north|south|east|west"`.

## Terminology

When an established field already has an exact term for something here, we use it. Readers then bring the right expectations, and the pitfalls that field has documented apply directly. Settled with the user on 2026-11-08.

| Term | Meaning here | Source |
|---|---|---|
| pattern | A block mix accepted wherever a block is (*Patterns*) | WorldEdit |
| heightmap | The highest non-air block per column (`sel.heightmap`, `05`) | Minecraft (`WORLD_SURFACE`) |
| dilate / erode | Grow or shrink a selection by a box kernel (`sel.dilate`, `sel.erode`, `05`) | Mathematical morphology |
| padding | The default margin of a context volume around its work volume (`{ padding: n }`, `11`) | Image inpainting |
| try-lock, range lock | A fork's lock on its work volume: refused at once on overlap, never blocking (`11`) | Concurrency control |
| snapshot isolation | A job reads its parent as of fork time and writes only what its lock covers (`11`) | Databases |
| compare-and-set, precondition | A patch writes a block only where the world still holds the expected state (`13`) | Concurrency control; HTTP conditional requests |

**Close, but not exact.** Our own terms stay; these are for orientation only:

- Work and context volumes ≈ a transaction's write set and read set, or an inpainting mask and its padding. ("Mask" already means a block filter in WorldEdit, so we don't use it.)
- Section hashes ≈ one level of a Merkle tree (`13`).
- A sandbox fork ≈ a sparse checkout of a branch (`11`).
- Connection properties ≈ the states the game recomputes in a shape update (`05`).

**Collisions with Minecraft.** `sel.slab` is the geometric slab (the region between two parallel planes), not the slab block; `sel.plane` is a one-block slab. Tool descriptions say so. The chisel plugin's `chisel.pattern` (`09`) uses "pattern" in the Chipped and Rechiseled sense, a block variant within one material, because that is those mods' own term; its argument takes a variant name, not a pattern.
