# 03 — Palette Ingestion

**Goal:** give the agent a fast, accurate, token-cheap picture of *every building material available in this instance*, and let it commit to a material set in one action.

This is critical context. The agent's design decisions are only as good as its view of the options. A big modpack has thousands of blocks, which is impossible to list and pointless to enumerate. Palette ingestion turns that into a small number of browsable sheets.

## Pipeline

```
registry (02) ──► classify ──► group into families ──► collapse series ──► colour index
                                                                             │
                     named palettes ◄── palette_pick ◄── sheets (tilemaps) ◄─┘
```

### 1. Classify

Each block gets a **category** and a **buildable** flag.

- Categories: `stone`, `brick`, `wood`, `metal`, `glass`, `soil`, `organic` (leaves, plants, wool), `concrete/ceramic`, `light`, `decor`, `functional`, `technical`.
- Sources, in priority order: plugin hints (`09`), then block tags (`minecraft:logs`, `planks`, `c:stones`, `c:glass_blocks`, …), then name tokens (`brick`, `tile`, `plank`, `glass`), then texture statistics.
- `buildable = false` for functional and technical blocks (machines, pipes, crops, fluids, air variants, ores by default). They are excluded from default sheets but reachable with filters.

### 2. Group into families

A **family** is one material with its shape variants:

```ts
interface Family {
  id: string;               // "minecraft:andesite"
  base: string;             // full-cube representative
  shapes: Partial<Record<"stairs"|"slab"|"wall"|"fence"|"fence_gate"|"door"|"trapdoor"|"pane"|"button"|"pressure_plate"|"pillar"|"vertical_slab", string>>;
  variants: string[];       // decorative variants (polished, chiseled, chisel-mod patterns…)
  series?: string;          // colour series membership
  category: string;
  mod: string;
}
```

- Matching uses suffix/prefix rules (`X_stairs`, `X_slab`, `X_wall`, `polished_X`, `X_bricks` → related family), then tags, then stonecutter and crafting recipe links from `data/<ns>/recipe/`, then plugin declarations.
- **Decorative mods** (Chisel, Rechiseled, Chipped) attach their patterns as `variants` of the base family through their plugins. They do not each become a family. Chisel's dozens of andesite patterns are one tile with a variant count badge.
- Shape coverage is the key architectural signal. A family with stairs and slab can make roofs and trim. One without them cannot.

### 3. Collapse colour series

Dye-coloured sets (wool, concrete, terracotta, glazed terracotta, stained glass and panes, candles, beds, and modded equivalents that follow the `<colour>_X` pattern) become **one series tile** showing a 16-colour strip.

### 4. Colour index

Per family (base block, all faces):
- Mean colour in CIELAB, a dominant 2–3 colour cluster, and luminance.
- A **texture noise** score: high-frequency energy, so smooth (polished stone) can be told apart from busy (cobblestone).
- Emission (light level), transparency and tint dependency.

This supports `match_color`, LAB gradients and "similar to" queries.

## Sheets (tilemaps)

A sheet is a PNG grid of tiles, with chessboard axes (columns `A…Z, AA…`, rows `1…N`) and no per-tile text.

| Sheet | Content | Typical size |
|-------|---------|--------------|
| `overview` | All buildable families + series | ≤ 32×32 tiles @ 32px ≈ 1024² px ≈ 1.4k tokens |
| `category:<c>` | One category, larger tiles | 16×16 @ 48px |
| `zoom:<range>` | A cell range from any sheet at 64px, variants expanded | ≤ 8×8 |
| `family:<id>` | All shapes and variants of one family | ≤ 8×8 |
| `series:<id>` | All colours of a series | 4×4 |
| `filter:<query>` | Ad-hoc filtered view (mod, tag, has-stairs, colour near …) | ≤ 32×32 |

**Layout rules (overview):**
- **Rows grouped by category**, in a fixed order. A thin divider and category key appear on the left axis.
- **Within a category, columns sorted by hue, then rows by lightness.** Any rectangle selection is therefore a coherent palette ("warm light stones").
- Low-chroma (grey/neutral) families are placed at the start of each category band.

**Tile rendering:** the base block drawn as a 3/4 isometric cube (top + two faces), so the agent sees top and side textures (logs, pillars). Corner badges:
- top-right: shape coverage. Pips for stairs, slab, wall, fence.
- bottom-right: variant count (when > 1).
- bottom-left: mod marker (a small coloured square keyed to a mod legend, only on filtered sheets).
- An emission glow or transparency checkerboard where relevant.

**Stability:** a sheet is deterministic for (instance hash, sheet spec). Cell IDs are stable until the mod list changes. Sheets are cached as PNG plus a JSON cell map.

**Every sheet comes with a text caption** of at most about 150 tokens: the sheet spec, category row ranges, the number of families, and how to select. Never a per-cell listing.

## Selection API

```ts
palette_sheet({ sheet: "overview" | "category:stone" | "zoom:C4:H9" | "family:minecraft:andesite" | "filter:...", page? })
  → image + caption

palette_pick({
  sheet: "overview",
  name: "castle",                       // saved as a named palette
  roles: {
    wall:   "C4:F6",                     // range → weighted mix of the families in it
    trim:   "B9",
    roof:   "K2:K5",
    floor:  ["M7", "N8"],
    accent: { cells: "R3", variant: "chiseled" }
  },
  weights?: "even" | "luminance" | { "C4": 3, ... }
})
  → text: per role, the resolved families with their available shapes, plus warnings
     ("roof: K4 has no stairs; excluded from roof stairs, kept for full blocks")
```

- **Roles** are free-form names. Conventional ones (`wall`, `trim`, `roof`, `floor`, `accent`, `glass`, `light`, `foundation`) get tool-description hints but are not enforced.
- **Shape-aware resolution:** `palette:castle.roof` used by a stair op resolves to the stair variants of the families in that role. Families without stairs are skipped, with a warning on first use.
- `palette_edit` adds or removes cells, reweights, and swaps a role.
- `palette_list` and `palette_show` (a text summary plus an optional 1-row sheet of the palette itself).
- Named palettes persist per document and can be saved to the library (`07`).

## Token budget

| Action | Approx. cost |
|--------|-------------|
| Overview sheet + caption | ~1.5k tokens |
| Zoom / family sheet | ~0.5–0.8k |
| palette_pick result | ~100–300 |
| Using a named palette in ops | ~0 extra |

Target: a build session spends **under 3k tokens** on material selection in the common case.

## Instance-agnostic by design

Ingestion must work on any modpack with **no per-pack configuration**. Every grouping and classification rule is derived from data the instance already contains. Plugins (`09`) are optional refinements, not requirements:

| Concern | Generic rule (no plugin needed) |
|---------|---------------------------------|
| Decorative-variant mods | **Detected:** a namespace whose tags are named after *another mod's* block and contain ≥75% of its own blocks, across ≥5 such tags (finds Chipped and Rechiseled automatically) |
| Camo/frame mods | **Placeholder textures:** one texture skinning ≥15 unrelated blocks of its own mod, ≥70% of them partial shapes → excluded |
| Visual duplicates | Families with identical base textures fold into one. Code-tinted blocks fold only into an untinted twin from another mod (reinforced copies); code-dyed sets within one mod stay apart |
| Duplicate series | Series whose members all look identical (behaviour-only variants) fold into the first |
| Extra dye colours | Any `<colour>_<rest>` family joins a series when a vanilla dye series `*_<rest>` exists (Dyenamics etc.) |
| Category | Light level, glass/colour words, then **mining-tool tags** (`mineable/axe` wood, `/shovel` earth, `/hoe` organic, `/pickaxe` stone or metal), then generic English words. No pack-specific vocabulary |
| Overview size | Widen to ≤40 columns. If it still overflows, fold near-identical families (same category and shape coverage, ΔE and noise under a threshold that tightens until it fits) into `+n` tiles, reachable via `similar:<id>` |
| Caches | Keyed by stack fingerprint + a hash of the deriving source code, so they never go stale |

**Verified on three instances, with and without plugins:**

| Instance | Blocks | Buildable families | Overview | Plugins change |
|----------|--------|--------------------|----------|----------------|
| Craftoria (NeoForge 1.21.1, ~530 mods) | 30,945 | 2,981 | 804 tiles, 32×29, ≈1.4k tokens | ≤5 families |
| ATM10 (NeoForge 1.21.1, ~480 mods) | 51,347 | 4,439 | 984 tiles, 34×32, ≈1.6k tokens | ≤5 families |
| Vanilla 1.21.1 | 1,062 | 265 | 61 tiles | none |

## Implementation status (Craftoria, measured)

| Stage | Result |
|-------|--------|
| Registry | 30,945 blocks |
| Families | 4,659 (3,080 buildable after exclusions: functional 530, directional 436, FramedBlocks 213, ores 179) |
| Variant folding | Chipped and Rechiseled patterns grouped by their own tags (`chipped:<base>`, `rechiseled:<base>`); andesite = 1 family with 77 variants. 1,851 Rechiseled `_connecting` copies folded as aliases |
| Extras | Macaw's Roofs and similar pieces attach to the family whose texture they reuse |
| Series | 40 dye series (wool, concrete, plastic bricks…) |
| Overview | 886 tiles (families with stairs/slabs, ≥5 variants, extras or a series) on **one** 32×32 sheet, 1079×1075 px ≈ 1.5k tokens, rendered in ~0.3 s |
| Index build | ~0.7 s cold (texture stats for ~2.9k families); cached load ~20 ms |

Rules learned from real data:
- **Variant tags resolve through shapes and aliases.** `rechiseled:andesite_stairs` maps to andesite, and `chipped:waxed_copper_block` maps to copper. Tags with no base block (Chipped `borderless_bricks`) are headed by their first member.
- **Wood forms** (`X_wood`, `stripped_X_log/wood`) are variants of `X_log`. **Numbered sets** (`zane_block_0…15`) become one family.
- **Tints:** biome colormaps only for plant-like blocks. Dye-named tinted blocks use the dye colour, since mods often tint in code. Anything else is untinted.
- **Model and texture fallbacks feed in from the registry:** custom-loader overrides (XyCraft connected textures) fall back to the lower pack's model, and face textures that don't exist as files (runtime-generated) are skipped.
- `polished_`, `smooth_`, `cut_` and `_bricks` forms stay separate families, because they look distinct and matter for palettes.
- **Odd naming needs a plugin** (resolved): Create Deco's metal sets (`<metal>_sheet_metal`, `_hull`, `_bars`, `_mesh_fence`, `_door`) share no stem the suffix rules can use, so the `createdeco` plugin groups each set under its sheet metal through `families` hints, read by naming pattern from the registry (`09`). Its corner, cracked and mossy bricks become variants of their colour; long, short and tiled bricks stay separate by the rule above.

## Open questions

- Should tiles show weathered or mixed previews for roles with mixes? (Probably only in `palette_show`.)
- Should there be a "material availability" filter (survival-obtainable) for Create Schematicannon builds?
