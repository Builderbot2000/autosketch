# Silo F: Save format and flash on save

**Wave 0** for the format (no wire); the flash after W's save-flash shape lands.

**Specs:** `17` pieces 7 and 8; `07` (prefab folders); `08` (formats); `16` (*Change flashes*).

## Deliverables

1. **`prefab_save({format})`:** `schem` (default), `litematic`, `nbt`, `bp`, written with the existing writers in `src/formats/`. One schematic file per prefab folder (`prefab.<ext>`). Reading already handles every format: check that stamp, `prefab_sheet` and the library screen's thumbnail and preview load each.
2. **Setting `library.prefabFormat`** changing the default.
3. **Flash on save:** when `prefab_save` runs on a linked document, the saved box (world coordinates through `src/ui/frame.ts`) goes out as W's save flash in its fixed colour.

## Files you own

`src/library/prefabs.ts`, the `prefab_save` handler in `tools/library.ts` (additive), the setting entry, the flash call (through `src/ui/feed.ts` or a small function beside it).

## Notes

- Lossy formats: `.bp` drops block entities (main README, *Unverified items*). Warn in the save result the way `export` does.

## Done when

`prefab_save` in every format is read back by `stamp` with exact block assertions; the setting changes the default; the fake host receives the flash for a linked save and nothing for an unlinked one.
