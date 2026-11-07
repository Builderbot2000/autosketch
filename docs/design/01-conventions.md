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

## Materials

Anywhere a block argument is accepted, a **material expression** is also accepted:

```
"stone_bricks"                                         single block
"stone_bricks 70%, mossy_stone_bricks 30%"              weighted mix
{"gradient": [...], "axis": "y", "range": [0,12]}       dithered gradient
{"noise": [...], "scale": 6}                            organic patches
{"pattern": "checker", "blocks": [...], "size": 1}      pattern
"palette:castle.wall"                                   named palette role (03)
```

Expressions are deterministic for a given `seed` (default: the document seed).

## Output conventions for tools

- Results are terse text: what changed, how many blocks, the affected box, warnings. No block dumps unless explicitly requested.
- Errors say what was wrong and how to fix it. Example: `"facing=up is invalid for oak_stairs; valid: north|south|east|west"`.
