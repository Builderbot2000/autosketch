# Autosketch Architecture

Autosketch is a local MCP server that lets an AI agent build Minecraft structures in schematic files by issuing high-level build actions, the way a player uses Axiom, and lets the agent *see and understand* what it is building.

It is a FOSS alternative to hosted tools such as Moxel. It runs on the user's machine, reads assets from the user's own Minecraft instance, and writes schematics the user can paste with Axiom or print with a Create Schematicannon.

## The core problem

The agent has to understand (a) **what it can build with**: blocks, materials, prefabs, mod-specific capabilities; and (b) **what it has built**: 3D structure that it relates to architectural intent. Both must fit in a limited context budget. Every component is designed around that constraint:

- **Shrink before showing.** Group, deduplicate and filter before anything reaches the model.
- **Glance, then select.** Large choice sets are shown as tilemap sheets with stable cell IDs. The model picks whole sets in one action.
- **Text first, images on demand.** Exact structure goes as compact text. Images are for gestalt and verification.
- **Semantic handles over coordinates.** Agents act on named components, selections and anchors, not raw block lists.
- **Isolate, don't scroll.** On large builds each job runs in a sandbox holding only its work and context volumes, so the rest of the build never enters the subagent's context (`11`).
- **Advise, don't constrain.** Heuristics and style knowledge are retrievable and customizable, never hard-enforced.

## Component map

```
                        ┌──────────────────────────────────────────┐
                        │              MCP server (stdio)          │
                        │   tool surface · resources · prompts     │
                        └──────┬───────────┬──────────┬────────────┘
                               │           │          │
        ┌──────────────────────┘           │          └─────────────────────┐
        ▼                                  ▼                                ▼
┌───────────────┐   ┌───────────────────────────────────┐   ┌──────────────────────┐
│  Perception   │   │           Operations              │   │       Library        │
│ render·slice· │◄──┤ selections · ops · brushes ·       │──►│ prefabs · palettes · │
│ analysis·diff │   │ anchors · scripting (QuickJS)     │   │ knowledge packs      │
└──────┬────────┘   └──────┬───────────────┬────────────┘   └──────────┬───────────┘
       │                   │               │                           │
       │            ┌──────▼──────┐  ┌─────▼──────────┐                │
       │            │  Document   │  │  Mod-compat    │                │
       │            │ voxels·NBT· │  │  plugins       │                │
       │            │ components· │  │ (framed, chisel│                │
       │            │ journal     │  │  copycats, …)  │                │
       │            └──────┬──────┘  └─────┬──────────┘                │
       │                   │               │                           │
┌──────▼───────────────────▼───────────────▼───────────────────────────▼─────┐
│          Assets & Registry  ──►  Palette ingestion (families, sheets)      │
│     instance locator · layered pack VFS · blockstate/model resolution      │
└────────────────────────────────────┬───────────────────────────────────────┘
                                     │
                         ┌───────────▼────────────┐
                         │  Formats (I/O)         │
                         │ .schem · .bp · .nbt ·  │
                         │ .litematic (later)     │
                         └────────────────────────┘
```

## Components

| # | Component | Responsibility | Design doc |
|---|-----------|----------------|------------|
| 1 | Conventions | Coordinates, regions, orientation, block identity | [design/01-conventions.md](design/01-conventions.md) |
| 2 | Assets & Registry | Find the instance, layered VFS over jars and packs, resolve models and textures, build the block registry | [design/02-assets-registry.md](design/02-assets-registry.md) |
| 3 | **Palette ingestion** | Families, colour index, tilemap sheets, selection, named palettes | [design/03-palette.md](design/03-palette.md) |
| 4 | Document model | One schematic per session, voxel store, block-entity NBT, components, journal and checkpoints | [design/04-document.md](design/04-document.md) |
| 5 | Operations & scripting | Agent-native "Axiom": selections, ops, brushes, anchors, sandboxed scripts | [design/05-operations.md](design/05-operations.md) |
| 6 | Perception | Renders, slices, structural analysis, diffs, token budget | [design/06-perception.md](design/06-perception.md) |
| 7 | Library | Prefabs, saved palettes, knowledge packs (heuristics and styles) | [design/07-library.md](design/07-library.md) |
| 8 | Formats & export | Axiom `.schem`/`.bp`, Create `.nbt`, export targets | [design/08-formats.md](design/08-formats.md) |
| 9 | Mod-compat plugins | Per-mod grouping, render hints and code-based actions | [design/09-mod-compat.md](design/09-mod-compat.md) |
| 10 | Testing & evaluation | Unit/golden tests and the agent benchmark suite | [design/10-testing.md](design/10-testing.md) |
| 11 | Scoped sessions | Isolated sandboxes (work + read-only context volume) for subagents, lock and wait, merge as one patch | [design/11-scoped-sessions.md](design/11-scoped-sessions.md) |
| 12 | Observability | Event log, live localhost viewer (3D view, scope tree, locks, timeline), replay and time-lapse for the human; never read by agents | [design/12-observability.md](design/12-observability.md) |

## Dependency rules

- `formats/` depends only on `core/` (block identity, voxel store). It knows nothing about assets.
- `assets/` is read-only over the user's instance. It never writes inside the instance except through explicit export targets (`08`).
- `palette/` depends on `assets/` and `plugins/`.
- `ops/` depends on `document/`, `palette/` (material resolution), `library/` (prefabs) and `plugins/` (mod actions).
- `perception/` depends on `document/` and `assets/` (models and textures). It never mutates.
- `observe/` reads `document/` and `assets/` and never mutates. `document/` and `server/` publish to it only through the `EventSink` interface in `core/` (`12`).
- `server/` is a thin adapter: tool schemas plus calls into the layers above. All logic lives below it, so the same API powers the MCP tools, scripts and tests.

## Tech stack

- TypeScript, ESM, Node ≥ 22.
- `@modelcontextprotocol/sdk` (stdio transport), `zod` for tool schemas.
- `prismarine-nbt` for NBT, `fflate` for zip/gzip, `pngjs` for PNG encoding, and a pure-JS software rasterizer (no GPU or browser dependency).
- `quickjs-emscripten` for sandboxed scripting.
- `vitest` for tests.

## Source layout

```
src/
  core/        conventions, block-state parsing, region math
  assets/      locate, pack VFS, models, registry
  palette/     families, colour index, sheets, selection
  document/    voxel store, NBT, components, journal
  ops/         selections, primitives, brushes, anchors
  script/      QuickJS sandbox and API bindings
  perception/  render, slice, analysis, diff
  observe/     event bus, session log, viewer HTTP server, snapshots
  library/     prefabs, palettes, knowledge packs
  formats/     schem, bp, structure-nbt
  plugins/     plugin API + built-in plugins (framed, chisel, copycats, …)
  server/      MCP tool and resource definitions
test/
  unit/  golden/  eval/
```

## Reference environment

The primary test target is the **Craftoria** CurseForge instance (NeoForge 21.1.x, MC 1.21.1, about 530 mods, including Axiom, Create, FramedBlocks, Copycats+, Chisel, Rechiseled and Chipped). Every component must work against it. Vanilla-only operation, with `minecraft-data` as the registry baseline, is a supported fallback.
