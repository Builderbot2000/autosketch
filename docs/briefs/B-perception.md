# Silo B: Perception

**Wave 1** for queries, analysis, diff and render extras. **Wave 2** for the semantic and render-seeded selections, after silo A merges its selection changes.

**Specs:** `06` (all), `05` (Picking: `view_box`, `view_lasso`; Semantic), `10` (Analysis goldens).

## Goal

Let the agent understand what it has built with cheap text first: point queries, a structural `analyze`, diffs. Then fill the gaps in `render`.

## Deliverables

**Wave 1**
1. **Text queries:** `query_block`, `query_column` (run-length bottom to top), `query_region` (counts by family and palette role, bbox, components inside).
2. **`analyze`** (`06`, *Structural analysis*): footprint, storeys, walls, openings per facade, roof type and pitch, rooms (enclosed-air flood fill), issues (floating blocks, shell holes), and proposed components. Output follows the example block in `06` and stays within about 200–400 tokens. Use the vocabulary shared with knowledge packs (`07`).
3. **`diff`** since a checkpoint or `op:-n`: counts by family and changed regions, with an optional before/after render pair.
4. **Render extras:** `depth` and `xray` styles, `highlight` (a selection or the last op's diff as a tint), `component:<id>` auto-framed views, custom camera `distance` / `target`, plane cutaways (`{plane, at, keep}`), selection masks as `region` (only boxes work today), component-label and storey-line overlays, and op `preview: true` (a small render of the affected region).
5. **Slices:** run-length mode for sparse layers.
6. **`raycast`:** keep the camera of each recent render per document so a pixel resolves to a block.

**Wave 2** (after A merges)
7. **Semantic selections:** `face`, `storey`, `roof`, `room`, `interior`, `openings`, `top`, `changed`. Implement the geometry in `perception/` and add thin cases to `ops/selection.ts`.
8. **Render-seeded selections:** `view_box` and `view_lasso`, with `depth: "visible" | "through"`, built on the stored render cameras.

**Dependency direction** (decided, see `ARCHITECTURE.md`): `ops/selection.ts` may call into `perception/` read-only for these selections. `perception/` must never import `ops/`. Render options such as `region` and `highlight` take resolved masks (`core/mask.ts`); the tool layer resolves selections before calling the renderer.

Leave `render({ context })` ghosting to silo F, but keep the style code open to a per-block "context" flag.

## Files you own

- `src/perception/**` (including `render/render.ts` and `slice.ts`; `render/bake.ts` is shared with E: additive only), `src/server/tools/perception.ts`, new `src/server/tools/query.ts`, matching tests.
- Wave 2 only: additive cases in `src/ops/selection.ts` and `selSchema`.

## Done when

- `analyze` gets storeys, openings and roof right on at least three small fixture buildings you build in tests (gable house, two-storey with windows, a tower). Hand silo I these fixtures for the golden tier.
- Each new tool description carries a token-cost hint matching the table in `06`.
- `06` gains an *Implementation status* table.
