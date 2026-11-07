# Silo H: Formats and assets loose ends

**Wave 1.** No dependencies. These are independent items: merge each on its own.

**Specs:** `08` (Supported formats, Import), `04` (Persistence, Journal), `02` (Instance location, Layered pack VFS, Model resolution, Cache).

## Deliverables

1. **Litematica `.litematic`** read and write (`08` marks it *later*). Multi-region files import as one document with a warning, unless the format makes something better obvious.
2. **Legacy MCEdit `.schematic`** read only, with a numeric-ID → state map for pre-1.13 blocks. Unknown IDs are kept as visible unknown blocks with a warning.
3. **Block rename table** for DataVersion mismatches on import (a small table, not DFU, as `08` scopes it).
4. **Journal persistence** (`04`): compact old journal entries to `<doc>/journal/` segments so undo history survives reopening a document and memory stays bounded. Update the note in `04` that says v1 keeps it in memory.
5. **Prism / MultiMC locator** (`02`): `instance.cfg` plus `mmc-pack.json`, base jar from the libraries cache.
6. **Pinned mod order:** a config option that fixes conflicting mod order inside `mod_resources` (`02`, *Known approximation*).
7. **Configurable tint biome** (default plains) for colormapped blocks (`02`).
8. **Extra caches** (`02`, *Cache*, "Later"): texture averages, palette families and rendered sheets keyed by the stack fingerprint plus code hash. Check first what `src/palette/` already caches and only add what's missing.

## Files you own

- `src/formats/**`, `src/assets/**` (except `assets/builtin-models/`, which is silo E's), `src/document/journal.ts`, `src/document/native.ts`, matching tests.
- Additive only: `src/document/document.ts` (journal persistence hooks; G and A also touch it).

## Done when

- Round-trip tests for `.litematic`, and import tests for `.schematic`, using small synthetic fixtures you write. No third-party schematics.
- Undo after `doc_open` reaches ops from before the reopen.
- `08`'s and `02`'s status sections reflect what changed.
