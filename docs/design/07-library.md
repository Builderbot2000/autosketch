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

## Open questions

- Should there be one shared library format for Axiom blueprints (`.bp` thumbnails and tags already exist), so that Axiom's blueprint folder can be imported directly? (Likely yes: a read-only library root pointing at `config/axiom/blueprints`.)
- How should the library be versioned and shared? (Folders plus git are probably enough.)
