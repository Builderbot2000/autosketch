# Silo F: Scoped sessions

**Wave 3.** Needs silo A (auto-connection shell recompute, transforms) and silo B (render styles, so the context volume can be ghosted). Starting earlier means rebasing through both.

**Specs:** `11` (all), `04` (sandboxes), `05` (selections as volumes), `06` (`context` render option). `11` also holds the design rationale (*Why*, *When to delegate*): read it before changing any limit.

## Goal

Implement isolated sandboxes for subagent jobs exactly as `11` specifies: work and context volumes, re-origin, locks, merge as one patch, nesting limits, scope addressing.

## Deliverables

1. **Scope model** (new `src/scope/`): a sandbox is a `Document` holding only the copied work and context volumes, re-origined so the work volume's minimum corner is (0,0,0), with its own journal. Keep a translation for merge.
2. **`scope_fork`:** resolve both selections to masks; whole-block extension for doors, beds, tall plants, double chests and plugin multi-blocks (report the extension); the three over-nesting limits (50% ratio, 512-block minimum, depth 3, all configurable) with the refusal messages from `11`; locks on the parent; a stale-context overlap report; the handoff block text.
3. **Write rules inside a sandbox:** writes outside the work volume are refused with an explanation; context blocks next to the work volume may get connection properties recomputed (the only exception).
4. **`scope_merge`:** apply the diff limited to the work volume as one parent journal entry; the sanity check (parent content unchanged since fork, ignoring connection properties); seam recompute in a one-block shell on both sides using A's function; the summary for the parent (report, stats by family, changed box in parent coordinates, optional render).
5. **`scope_abandon` and `scope_list`.**
6. **Components across the boundary** per the table in `11`: copied and editable, external and read-only (`partial` if clipped), or absent. Reserved ids from the whole document chain. Translation back on merge.
7. **Addressing:** every document tool accepts optional `scope`. While any scope is open, mutating calls must name `scope` (an id or `"base"`). Do this centrally (the `tool()` wrapper and a `session.docFor(args)` helper), so each tool module needs only a mechanical one-line change.
8. **Nesting:** a child fork from a sandbox, with volumes inside the parent's volumes and the lock living in the parent sandbox.
9. **Ghosted context in renders and marked context rows in slices** (`render({ context: "ghost" | "normal" | "hide" })`).

Persistence: follow the proposal in `11` (in memory for v1, abandoned on exit), and record that decision in the spec.

## Files you own

- New: `src/scope/**`, `src/server/tools/scope.ts`, matching tests.
- `src/server/session.ts` and the `tool()` wrapper in `src/server/server.ts`.
- Mechanical edits across `src/server/tools/*.ts` for `scope`, plus additive hooks in `document.ts`, `perception/render/render.ts` and `slice.ts`.

## Done when

- Unit tests cover every refusal code that `12` lists (`lock_overlap`, `nest_too_large`, `nest_too_small`, `nest_depth`, `outside_work_volume`, `scope_required`).
- A fence built to a sandbox boundary connects to the context wall in the sandbox and to the real wall after merge.
- Two parallel forks with overlapping context volumes merge in either order with the same result.
- One undo in the parent reverts a whole merge.
- `11` gains an *Implementation status* table.
