# 02 — Assets & Registry

Reads the user's own Minecraft instance at runtime to discover which blocks exist, what properties they have, and what they look like. No game assets are shipped or redistributed. Derived data is cached locally.

## Instance location (`assets/locate.ts`)

Supported, in priority order:

| Launcher | Detection | Base jar | Mods / packs |
|----------|-----------|----------|--------------|
| CurseForge | `minecraftinstance.json` | `curseforge/minecraft/Install/versions/<ver>/<ver>.jar` | `mods/`, `resourcepacks/`, `kubejs/assets`, `dynamic-resource-pack-cache/` |
| Vanilla launcher | `.minecraft/versions/<ver>/` | `<ver>.jar` | `resourcepacks/` |
| Prism / MultiMC | `instance.cfg` + `mmc-pack.json` | libraries cache | later |

Configured by path (`AUTOSKETCH_INSTANCE`, or the `instance` argument at server start). WSL paths (`/mnt/c/...`) must work.

## Layered pack VFS (`assets/pack.ts`)

A read-only virtual filesystem over zip jars and folders, resolved like the game's resource manager. Single files (models, textures, blockstates) come from the topmost layer that has them. Tags and other merging data are read from every layer (`readAll`).

Layer order (lowest priority first), as implemented in `locate.ts`:

1. Base game jar
2. The `mod_resources` group, placed where `options.txt` lists it:
   - the loader jar (NeoForge/Forge `-universal.jar`)
   - mod jars, alphabetical (`*.jar` only; `.disabled` is skipped). `META-INF/jarjar` nested jars with assets or data sit just below their parent.
   - generated packs: `kubejs/` (assets and data), `dynamic-resource-pack-cache/*`, `dynamic-data-pack-cache/*`
   - the instance `datapacks/` folder
3. The remaining `options.txt` `resourcePacks` entries, in order: `file/<name>` resolves to `resourcepacks/<name>`. Bare names and `mod/<id>:<name>` are **built-in packs** inside the game or mod jars. `fabric` and `openloader/…` entries are skipped.
4. OpenLoader packs (`config/openloader/packs`, filename order). They are force-enabled and placed on top.

**Built-in packs:** the conventional location is `resourcepacks/<name>/`, but mods may register any folder in code. XyCraft registers `add_xycraft_overrides_stone` from `OverridesStone/`. As a fallback, top-level pack folders in jars are matched by normalised name, preferring jars whose name matches.

**Pack overlays** (`pack.mcmeta` `overlays.entries`) are applied as higher-priority sub-folder layers, with assets matched against the resource pack format and data against the data pack format (1.21.1: 34 / 48).

**Known approximation:** mod-to-mod order inside `mod_resources` follows the loader's dependency sort, which we don't reproduce. Conflicts over the same path between mods are rare. A future config option can pin the order.

Jars are indexed by central directory only (file list, no decompression). Only `assets/`, `data/`, `resourcepacks/`, top-level pack folders, `META-INF/jarjar/` and mod metadata are indexed. Entries are decompressed lazily. A small LRU of file handles avoids fd exhaustion.

**Measured on Craftoria** (WSL, instance on `/mnt/c`): 656 layers (532 mod jars, 59 nested jars, 38 OpenLoader packs), 409k indexed entries, 32,274 blockstate files across 526 namespaces. Cold open takes about 4–5 s with about 265 MB RSS. The persistent index cache (below) should bring a warm start under 1 s.

## Model resolution (`assets/models.ts`)

- `blockstates/*.json`: `variants` (property-match keys) and `multipart` (`when` / `OR` / `AND` conditions), weighted model lists, `x`/`y` rotation, `uvlock`.
- `models/block/*.json`: parent chain, texture variable resolution (`#var`), `elements` (from/to, per-face uv, rotation, `tintindex`, `cullface`), and builtin parents (`builtin/entity`, `builtin/generated`).
- Output: a **baked model** per block state, made of cuboids with resolved texture refs, cached by state key.
- **Code-drawn blocks** (chests, signs, beds, banners, heads, shulkers, bells) have no usable JSON model. They get hand-written fallback models in `assets/builtin-models/`.
- **Tint:** `tintindex` faces use the grass/foliage colormaps at a configurable default biome (plains), plus fixed tints for water, redstone and stems.
- Unresolvable models fall back to the `particle` texture on a full cube, flagged `approximate`.

## Registry (`assets/registry.ts`)

Per block:

```ts
interface BlockInfo {
  id: string;                         // "create:andesite_casing"
  mod: string;                        // namespace → mod display name
  properties: Record<string, string[]>;
  defaults: Record<string, string>;
  shape: "full" | "partial" | "none"; // derived from baked model bounds
  tags: string[];                     // from data/<ns>/tags/block
  renderable: "exact" | "approximate" | "fallback";
  family?: string;                    // filled in by palette ingestion (03)
}
```

**Property sources, merged:**
1. `blockstates/*.json` keys. These cover only properties that change the model.
2. Vanilla: `minecraft-data`, or the game's `--reports` `blocks.json` when available. This fills non-visual properties such as `waterlogged` and `distance`.
3. Plugin-supplied definitions (`09`).

A block with no assets but present in a schematic is "unknown" (`01`).

## Cache

`~/.cache/autosketch/<instance-hash>/`. The key is a hash of the jar list plus mtimes and the pack order. Contents: VFS index, baked models, registry JSON, texture averages, palette families, rendered sheets. A changed mod list invalidates only the affected entries.

## Legal stance

Assets are read from files the user already has, at runtime, on their machine. Caches stay local. Nothing derived from game or mod assets goes into this repository or into exported schematics (beyond block IDs).
