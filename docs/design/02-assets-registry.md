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

A read-only virtual filesystem over zip jars and folders, resolved like the game's resource manager:

1. Base game jar
2. Mod jars (all of `mods/*.jar`; `META-INF/jarjar` nested jars included)
3. Generated packs: `kubejs/assets`, `dynamic-resource-pack-cache`, mod-provided built-in packs
4. User resource packs, in the order of `options.txt` `resourcePacks`. Later entries win.

Jars are indexed by central directory only (file list, no decompression). Entries are decompressed lazily and cached. Craftoria has about 530 jars, so the cold index must run in seconds and the warm (cached) index in under 1 s.

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
