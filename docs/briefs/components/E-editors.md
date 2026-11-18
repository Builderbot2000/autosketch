# Silo E: Library editors in game

**Wave 1**, from W; the forms after V's extracted screen parts merge.

**Specs:** `17` piece 6, *Principles* 5; `15` (editors, for behaviour); `16` principle 7 (files are the source of truth); `03` (`palette_edit` operations).

## Deliverables, in merge order

1. **Recovered writes:** `writeEntryText`, `writePrefabMeta`, `writePaletteFile` and their tests from commit `b6e60bf` back into `src/library/manage.ts`, adapted to the current code.
2. **Handlers** for W's editor kinds in `src/ui/library.ts` (one dispatch line each in `requests.ts`): hash check, `conflict` on a changed file, read-only roots refused.
3. **Forms** reached from the library screen's entry detail: prefab (`prefab.json`: name, tags, front, notes, anchors, roles), palette (tags, notes, member weights, remove, rename and drop roles, add by block id), procedure (source as text), knowledge pack, kits included (frontmatter and text). On `conflict` the form reloads. Read-only entries keep *Copy to my library* first.

## Files you own

`src/library/manage.ts`, `src/ui/library.ts`, new editor screens under `client/ui/screen/`, entry points in `LibraryScreen` after V's extraction, client tests in an `editors` suite.

## Notes

- Prefab blocks stay out of scope (stamp, edit, `prefab_save` with `overwrite`).

## Done when

The recovered tests pass; handler tests cover each kind, `conflict` and read-only roots; client tests open each editor, save, hit a conflict and reload, and see *Copy to my library* on a read-only entry.
