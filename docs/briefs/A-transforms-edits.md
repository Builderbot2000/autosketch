# Silo A: Transforms and edit completion

**Wave 1.** Several other silos wait on this one (C, E actions, F, D's prefab rotation), so land the block-state transform tables and auto-connection first, in their own merge.

**Specs:** `01` (Orientation), `05` (Selections, Auto-connection, Edits & brushes, Implementation status), `04` (Component graph), `09` (`rotate` hook).

## Goal

Finish the editing layer so an agent can move, copy, rotate and mirror work with correct block states, use the remaining brushes, and get connecting blocks (fences, walls, panes, stairs, redstone) right automatically.

## Deliverables, in merge order

1. **Block-state rotation and mirror tables** (`01`, *Orientation*). Remap `facing`, `axis`, `rotation`, `hinge`, `shape`, `half`, `attachment` and multipart side flags (`north|east|south|west`). Derive tables from the registry's property sets, with an optional `rotate?(state, rot)` override on plugins (add the optional field to `src/plugins/types.ts`). Exhaustive unit tests over vanilla stairs, logs, doors, rails, walls and fences (`10`, Tier 1).
2. **Transform ops:** `move`, `copy`, `rotate`, `mirror` over any selection, with a pivot (default: selection centre rounded toward min), block entities moving with their blocks, and component regions updated when a transform covers them (`04`). Matching selection modifiers `sel.rotate` and `sel.mirror`.
3. **Auto-connection** (`05`). Recompute connection properties of the written block and its neighbours after every op. Treat them as derived state. `raw: true` on an op writes states exactly as given. Expose a function that recomputes a given shell of positions: silo F will call it at sandbox seams.
4. **Brushes:** `hollow` (as its own op), `paint` (exposed faces only), `smooth` / `erode` / `dilate`, `extrude`, `sweep` (2D profile along a polyline), `array` (repeat with step and count).
5. **Remaining selection pieces** from the `05` *Not yet* row that need no analysis: `hull`, `tube`, `grow` / `shrink` (topological), `checker`, `random`, `every`, `freeze`, `edges`, `slab`, `convex`, `fill_holes`. The semantic ones (`face`, `storey`, `room`, …) belong to silo B.
6. **`as:` on every op**, not just `fill`, so any op can register a component.

## Files you own

- New: `src/core/rotate.ts` (or similar), `src/ops/transform.ts`, `src/ops/connect.ts`, `src/ops/brush.ts`, `src/server/tools/transform.ts`, `src/server/tools/brush.ts`, matching tests.
- Owned in wave 1: `src/ops/selection.ts`, `src/ops/edit.ts`, `src/server/tools/edit.ts`, `selSchema` in `src/server/tools/shared.ts`.
- Minimal additive edits: `src/plugins/types.ts` (optional `rotate?` and connection hooks), `src/document/document.ts` and `components.ts` (component transforms).

## Done when

- Rotating a stair-roofed house 90° and mirroring it gives correct stairs, doors, fences and logs in a `view_slice`.
- A fence line built up to a wall connects, and `raw: true` leaves states exactly as given.
- `05`'s *Implementation status* table no longer lists anything in this brief under *Not yet*.
