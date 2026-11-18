# Silo K: Component set and kits

**Wave 0** for the set, kits and label resolution; the reminder on in-game request events after Q's first merge.

**Specs:** `17` pieces 1 and 2, *Principles* 1, 2 and 6, *Open questions* (reminder placement); `07` (knowledge packs, prefabs).

## Goal

The session's component set: an ordered record the agent keeps with one tool, kept as a kit when the player asks, and resolvable by label in `stamp`.

## Deliverables, in merge order

1. **The record** on the MCP session: entries `{prefab, label?, notes?}`, in memory, cleared when the session ends. Logic in a module below `server/` (e.g. `src/library/component-set.ts`), so scripts and tests use it.
2. **`component_set` tool** (new module `src/server/tools/components.ts`): show, `add` (replace by same label or prefab), `remove`, `clear`, `save_as`, `load`. Every result shows the whole set. Unknown prefab names (including `axiom/…`) refused with the nearest names. Token-cost hint in the description.
3. **Kits:** `kind: kit` knowledge packs under `knowledge/kits/` with `entries` in the frontmatter; `save_as` writes to the first writable root, `load` replaces the set; `knowledge_list({kind: "kit"})` lists them.
4. **Label resolution:** `stamp({prefab})` tries set labels before library names and sheet cells.
5. **Reminder line** (`set: corner tower = gothic_tower_a, …`) appended to `prefab_search`, `prefab_sheet` and `stamp` results while the set is not empty.
6. After Q's first merge: the same line on each in-game request's channel event (`src/world/prompt.ts`, one call).

## Files you own

The set module, `src/server/tools/components.ts`, kit reading and writing in `src/library/knowledge.ts` (additive), the session field; additive edits to `tools/library.ts` and `world/prompt.ts` (see the README's *Contested files*).

## Notes

- Measure the reminder's token cost on a realistic set (5 and 15 entries) and record it under `17`'s reminder-placement open question. Don't widen the placement.

## Done when

The *Testing* MCP items for `component_set`, kits, label resolution and the reminder (only on the named results, only while non-empty) pass.
