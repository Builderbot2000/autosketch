# 07 — Library

User-owned, editable building knowledge: **prefabs**, **palettes**, **procedures** and **knowledge packs**. All of it is plain files, so users can curate, version and share their own.

**Principle: advise, don't constrain.** Heuristics and styles are things the agent *can retrieve and consider*, never rules the server enforces. Over-constraining the agent degrades its reasoning. Users tune the library to their taste, and the agent decides how to apply it.

## Layout

```
~/autosketch/library/            # user library (configurable; multiple roots allowed)
  prefabs/
    oak_tree_large/
      prefab.schem               # or .nbt / .bp / .autosketch
      prefab.json                # metadata (below)
      thumb.png                  # generated
  palettes/
    castle.json
  procedures/
    window_bay.js                # saved scripts (05)
  knowledge/
    styles/gothic.md
    styles/tudor.md
    heuristics/proportions.md
    heuristics/roofs.md
```

The repo ships a small **starter library** under `library/` containing original content only, with no third-party schematics.

## Prefabs

```jsonc
// prefab.json
{
  "name": "Large oak tree",
  "tags": ["tree", "nature", "oak"],
  "front": "south",
  "anchors": { "base": [3, 0, 3] },      // default stamp point
  "footprint": [7, 7], "height": 12,
  "roles": {                             // optional: lets stamps recolour with the current palette
    "log":    ["oak_log"],
    "leaves": ["oak_leaves"]
  },
  "requires": ["minecraft"],             // namespaces; flagged if missing from the instance
  "notes": "Good as a courtyard centrepiece"
}
```

- **Browsing uses the tilemap pattern** (`03`). `prefab_sheet({ tags?, query? })` returns a grid of thumbnails with chessboard cell IDs plus a compact caption (name, footprint). The agent picks by cell: `stamp({ prefab: "B3", at: "courtyard.center" })`.
- `prefab_search({ query, tags, max_footprint })` is a text search that returns at most 10 results.
- **Palette remap:** `stamp(..., { palette_remap: { log: "palette:castle.trim" } })` swaps role blocks, preserving shapes and states through families.
- `prefab_save({ sel | component, name, tags })` saves part of the current document. The agent or user can grow the library during a session.
- Missing namespaces produce a warning. Unknown blocks are kept as-is (`01`).

## Palettes

Named palettes from `03`, saved as JSON (roles → families + weights) and tagged (`medieval`, `warm`, `nether`). `palette_load` brings one into the current document. Families not present in the instance are reported with the nearest-colour substitute suggested, not applied silently.

## Procedures

Saved scripts (`05`) with a header comment describing their parameters. They are listed with `procedure_list` and invoked with `run_procedure({ name, args })`. This is how users teach the agent their own building techniques.

## Knowledge packs

Markdown files with light frontmatter, exposed as **MCP resources**. They are retrieved on demand, not injected wholesale:

```markdown
---
kind: style            # style | heuristic | technique
name: Gothic
tags: [medieval, church, vertical]
summary: Pointed arches, verticality, buttresses, tracery, steep roofs.
---
## Proportions
- Nave height ≈ 2–3× width ...
## Elements
- Pointed arch (`arch` style=pointed) ...
## Palette ideas
- ...
## Prefabs / procedures
- buttress_flying, rose_window
```

- `knowledge_list({ kind?, tags? })` returns only names and summaries (cheap). `knowledge_read({ name })` returns the full text.
- Packs may reference prefabs, palettes and procedures by name, so a style is a bundle of guidance plus reusable parts.
- The vocabulary is aligned with analysis output (`06`): storey, bay, facade, opening, cornice, buttress, pitch, overhang.
- The starter library ships a few general heuristics (proportion, roof pitch, window rhythm, depth/layering) written as *suggestions with reasons*, not rules.

## Roots

Library roots are searched in order, and the first root holding a name wins, so a user's entries shadow the starter library's:

1. User roots: `AUTOSKETCH_LIBRARY` (several paths, separated by the platform path delimiter), else `<workspace>/library` (`~/autosketch/library`). The first one is writable: `prefab_save` and `palette_save` write there.
2. The starter library shipped in the repo (`library/`), read-only.
3. **Axiom blueprints:** a read-only root over `<instance>/config/axiom/blueprints`. Every `.bp` below it is a prefab named `axiom/<path>`, with the blueprint's own name, tags and thumbnail. This resolves the former open question: no shared format is needed, because `.bp` already carries what a prefab needs except anchors and roles, which default (minimum corner; roles from block families at stamp time).

Thumbnails rendered for read-only prefabs go to the cache folder (`$AUTOSKETCH_CACHE/prefab-thumbs/`), never into the starter library or the instance. In a writable root they are written as `thumb.png` beside the prefab.

## Implementation status

| Piece | Status |
|-------|--------|
| Resource registration | `ToolDeps.resource` (`src/server/tools/shared.ts`): fixed URIs or RFC 6570 templates with a `list` callback. Resources don't wait on the instance. |
| Roots | As above (`src/library/roots.ts`). Entries are re-read on each call, so edits made outside the server show up at once. |
| Prefabs | Any readable format (`08`) as `prefabs/<id>/prefab.<ext>` (or a loose `prefabs/<id>.<ext>`) plus optional `prefab.json`. Missing metadata defaults: name = id, size from the blocks. |
| `prefab_sheet` | Thumbnails on a chessboard grid, at most 6×4 per page (≈0.8k tokens), caption with `A1 id x×z×height` per cell. The last sheet is remembered so `stamp({prefab:"B2"})` resolves its cells. |
| `prefab_search` | Words (name, tags, notes), tags and `max_footprint` (either orientation); at most 10 results with size, tags, anchors and roles. |
| `stamp` | At `[x,y,z]`, `"component.anchor"` or `{anchor, offset}`. Also `{face, u, v}`; all forms resolve through the shared anchor resolver (`ops/anchors.ts`, `05`). The prefab's `base` anchor (else its minimum corner) is placed there. Prefab air leaves the document as is unless `include_air`. One journal entry; registers a component `kind: "prefab:<id>"` with the prefab's anchors and tags. Unknown blocks are kept; namespaces missing from the instance warn. Block entities are copied; entities are not placed yet (warned). |
| `palette_remap` | Keys are prefab roles, or a block/family used in the prefab. Values are `palette:<name>.<role>` (weighted, seeded per position) or a block/family id. Each block keeps its shape within the family (stairs → the target's stairs) and the properties the target supports. A target family without that shape keeps the original block, with a warning. |
| `prefab_save` | From `sel`/`box` (blocks outside a non-box selection become air) or a `component` (its anchors carried over). Writes Sponge v3 `prefab.schem` + `prefab.json` (footprint, height, `requires` from the namespaces used). Without `roles`, the eight most-used families become roles named after them. |
| Rotate / mirror on stamp | `rotate` (0/90/180/270, clockwise from above) and `mirror` (`x`/`z`, across the prefab's own centre plane); mirror applies first, then rotation (`01`, Orientation). Block states go through `core/rotate.ts` (with plugin overrides), block entities move with their blocks, and the prefab anchors and registered component box take the same transform, so the chosen anchor still lands on `at`. `palette_remap` applies to the oriented states. |
| Palettes | `palette_save` writes `palettes/<name>.json` (roles → family, block, weight, plus the family's mean colour). `palette_load` keeps members present in the instance; a missing variant falls back to its family's base (warned); a missing family is left out and reported with the nearest-colour buildable family (ΔE76), applied only with `substitute:true`. `palette_list` shows session and library palettes; `palette_edit` (`03`) adds, removes, swaps, reweights, renames and drops roles. |
| Procedures | `procedures/*.js` with a header comment (summary plus `@param` lines). `procedure_list` works. `run_procedure` runs the file as a script in the sandbox (`05`, Scripting) with `args`, as one journal entry; on an error nothing changes. |
| Knowledge packs | `knowledge/**/*.md` with light frontmatter (`kind`, `name`, `tags`, `summary`; a missing `kind` comes from the folder). `knowledge_list` returns names and summaries only; `knowledge_read` finds a pack by path, last segment or title. Also MCP resources at `autosketch://knowledge/{+name}`. |
| Starter library | Four original prefabs (`lamp_post`, `small_oak_tree`, `village_well`, `park_bench`), generated by `library/build-starter.ts`; one palette (`timber_cottage`, no colours, so no nearest-colour suggestions); the four general heuristics (proportions, roofs, windows, depth). No thumbnails are committed: they are rendered from the user's own instance. |

## Open questions

- How should the library be versioned and shared? (Folders plus git are probably enough; nothing in the format prevents it.)
- Should starter palettes carry reference colours so missing families get suggestions? Colours measured from game textures would be derived from game assets (`02`, *Legal stance*), so the starter palette has none for now.
