# Silo D: Library

**Wave 1.** Prefab rotation and mirroring on `stamp` wait for silo A's transforms; ship `stamp` without them first and add them after A merges.

**Specs:** `07` (all), `03` (palette persistence, `palette_edit` / `palette_list`), `08` (formats for prefab files).

## Goal

User-owned building knowledge as plain files: prefabs, saved palettes, procedures and knowledge packs, browsable the same token-cheap way as materials.

## Deliverables

1. **Resource registration first.** Knowledge packs are MCP resources, but tool modules only receive `tool` today. Add a resource registrar to `ToolDeps` (`src/server/tools/shared.ts`, `server.ts`) as a small separate merge early in the wave. Silo C uses it too.
2. **Library roots:** `~/autosketch/library/` by default, configurable, several roots allowed. Plus a read-only root over `<instance>/config/axiom/blueprints` (resolves the open question in `07` as the doc proposes).
3. **Prefabs:** load any readable format (`08`) plus `prefab.json` metadata; generated thumbnails using the existing renderer; `prefab_sheet` (thumbnail tilemap with chessboard cells, following `03`'s sheet rules and caption budget); `prefab_search` (text, at most 10 results); `stamp` (at a position or anchor, `palette_remap` through families, preserving shapes and states, registers a component, warns on missing namespaces); `prefab_save` from a selection or component.
4. **Palettes:** `palette_edit` (add or remove cells, reweight, swap a role), `palette_list`, saving a document palette to the library, `palette_load` reporting missing families with a nearest-colour suggestion, never substituting silently.
5. **Procedures:** `procedure_list` and `run_procedure`. Store and list them now. Running them needs silo C's sandbox, so wire `run_procedure` once C merges.
6. **Knowledge packs:** markdown with frontmatter, `knowledge_list` (names and summaries only) and `knowledge_read`, also exposed as MCP resources.
7. **Starter library** under `library/` in the repo: a few original prefabs and the general heuristics `07` lists (proportion, roof pitch, window rhythm, depth/layering), written as suggestions with reasons. Original content only.

## Files you own

- New: `src/library/**`, `library/**` (starter content), `src/server/tools/library.ts`, matching tests.
- `src/server/tools/palette.ts` (palette tools) and `src/palette/pick.ts` for `palette_edit`.
- Small early edit: `src/server/tools/shared.ts` and `server.ts` for the resource registrar.

## Done when

- An agent can browse `prefab_sheet`, stamp a cell at a component anchor with a palette remap, and undo it in one step.
- A palette saved from one document loads into another, with missing families reported.
- `07` gains an *Implementation status* table, and its open questions are answered or still marked open.
