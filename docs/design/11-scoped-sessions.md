# 11 — Scoped Sessions

Keeps large builds out of model attention. When the region an agent is working on gets too large to comprehend, the agent can hand part of it to a subagent. The job runs in an **isolated sandbox** that holds only the blocks it needs, so the subagent never sees the rest of the build.

**Delegation is the exception, not the workflow.** An agent normally works directly in its document. It forks a sandbox only when the region in work passes a comprehension threshold (see *When to delegate*). Each fork costs a brief, a handoff, a report and a merge, so forking too eagerly makes the work chain longer without making anything better.

## Why

Model attention drifts over large inputs, and output quality drops with it. On a big build the main source of that input is the mass of block coordinates that make up the build itself. Scoping tools to a region doesn't help much: earlier results stay in the context. So the subagent gets a separate space instead. It contains its work, the surroundings it needs to match, and nothing else.

The same separation works upward. Block-level history is useless to the agent that delegated the job, so a job returns a summary, not its journal.

## Roles

There is **no designated coordinator**. Any agent, whether working on the base build or inside a sandbox, can delegate and act as the parent of the jobs it forks. "Parent" and "subagent" describe one fork, not fixed roles. With a live world link (`13`), the player is the parent of the whole tree: they set the base document's work and context volumes in-game, so the base document is a **root scope** with the same volumes and write rules as a sandbox, and the root agent works inside it. A subagent that finds its own work volume too large can delegate in turn (see *Nesting*).

Most of a parent's work around a fork is **choosing volumes and writing briefs**, usually by selecting boxes or picking components (`05`). It needs to perceive the region at the level of selections (the component graph, coarse renders, `analyze`), not block detail.

## When to delegate

Delegate only when the region in work is **too large to comprehend**, beyond a threshold set by the skill guidelines. The threshold is semantic and visual, not computed: a homogeneous stone mountain is easy to comprehend at any size, and a whole detailed cathedral is not. The server never measures complexity or prompts a fork. Tool descriptions and server instructions present scoped sessions as an option for large builds, never as a step in the normal workflow. See *Advise, don't constrain* in [ARCHITECTURE.md](../ARCHITECTURE.md).

Guidance for the skill (advisory, like all heuristics):

- **Below the threshold, just work.** Don't select-and-fork small or medium tasks, even when they have distinct parts.
- **One job per distinct task.** Don't fork the same task in several places, such as four sandboxes each building "a corner tower". That spends the tokens four times and invites four slightly different towers. Build it once, then repeat it with `copy`, `array`, `mirror` or a saved prefab (`05`, `07`). Fork again only for what really differs.
- **Make each work volume contain the whole job**, and give it enough context to match its surroundings.
- Merge jobs whose context overlaps another job's work before relying on that context.

## Model

```
 parent document                       sandbox (own local frame)
┌───────────────────────────┐   fork   ┌──────────────────┐
│        ┌─────────┐        │ ───────► │ ░░░░░░░░░░░░░░░░ │  ░ context volume
│        │░░┌───┐░░│        │          │ ░░ ┌────────┐ ░░ │    read-only copy
│        │░░│ W │░░│◄locked │          │ ░░ │ work   │ ░░ │
│        │░░└───┘░░│        │ ◄─────── │ ░░ │ volume │ ░░ │  work volume
│        └─────────┘        │  merge   │ ░░ └────────┘ ░░ │    editable
└───────────────────────────┘ (patch)  └──────────────────┘
```

- **Work volume:** the region the job may change. It should contain the **whole job**: everything one coherent building task touches. If two jobs would need to edit the same blocks, they are one job.
- **Whole blocks only.** A volume never contains half of a multi-block structure (door, bed, tall plant, double chest, or a plugin-declared multi-block). When a selection cuts one, the fork extends the work volume to include all of it and reports the extension. Nothing straddles the boundary.
- **Context volume:** the region the job must see in order to fit in, such as the neighbouring wall, the roofline it meets, or the ground it stands on. It is copied into the sandbox, and the subagent can read, query, slice and render it but not change it. By default it is the work volume plus a few blocks of **padding** (the inpainting term), but it can be any selection, including a distant reference.
- **Sandbox:** a separate document containing only those two volumes. Nothing else from the parent document is in it, so tools can't leak it.
- Both volumes are **chosen by the delegating agent** to suit the job. The server never judges complexity. It only enforces the size limits that prevent over-nesting (see *Nesting*).

## Lifecycle

### 1. Fork

```
scope_fork({ work: sel, context?: sel | { padding: n }, brief, spec?, scope? })
  → scope id, local frame, lock, handoff text
```

- Refused if the work volume breaks the over-nesting limits (see *Nesting*).
- Copies the work and context blocks (with block entities) into a new sandbox document.
- **Re-origins** the sandbox so the work volume's minimum corner is (0,0,0). Context blocks sit at negative or beyond-max coordinates. The subagent works with small local numbers, and the parent's coordinates never reach it. The fork records the translation for the merge.
- `brief` is the job description. `spec` is shared design data the job must match: palette, reference lines (storey heights, cornice y, wall thickness) and anchors. Anchors are translated into the local frame.
- Returns a **handoff block** for the parent to paste into the subagent's prompt. It gives the scope id, the local frame, both volumes in local coordinates, the brief, and the rule that every call passes `scope`.

### 2. Work

The subagent works inside the sandbox with the normal tools, passing `scope: "<id>"` on each call.

- Writes inside the work volume behave normally.
- Writes to the context volume, or anywhere outside both volumes, are refused, and the error explains why. This rule isn't about the agent's behaviour: the copied space simply ends there.
- Perception works as usual. Renders show the context volume ghosted (desaturated, translucent) by default, so it's never mistaken for editable blocks (`render({ context: "ghost"|"normal"|"hide" })`). Slices mark context rows.
- The sandbox has its own journal, undo and checkpoints. They are discarded at merge.

### 3. Merge or abandon

```
scope_merge({ scope, report })   → summary for the parent
scope_abandon({ scope })         → discard, release the lock
```

- Merge applies the sandbox's diff, limited to the work volume, to the parent document as **one journal entry**, so it can be undone with one undo.
- The parent receives the subagent's `report` (a few sentences on what was built and anything the parent must know), server diff stats (counts by family, the changed box in the parent's coordinates), and an optional render of the work volume in the parent document. It does not receive the sandbox journal or block lists.
- Merge or abandon releases the lock.

## Locks (parallel work)

Parallel jobs take a **try-lock on the work volume**: a range lock over its blocks that is refused at once on overlap instead of blocking, so the parent decides whether to wait. Each document keeps the locks for the jobs forked from it.

- A fork locks its **work volume** in the parent document. Context volumes are not locked.
- No later fork may select a work volume that overlaps a held lock. The refusal names the lock and its job, so the parent can wait or pick another region.
- Context volumes may overlap each other and may overlap other jobs' work volumes. Neighbouring jobs that share surroundings can therefore run at the same time.
- The parent can still read and render locked regions. Its own edits that intersect a lock are refused until the lock is released.
- **Merges can't conflict.** Work volumes are exclusive and context is read-only. Minecraft building jobs shouldn't run at the same place at the same time, so a job that needs more space should take a bigger work volume. As a sanity check, the merge verifies that the parent's blocks inside the work volume are unchanged since the fork. It fails loudly if they changed, which would mean a bug.
- **Accepted trade-off: context can be stale.** A job runs under *snapshot isolation*: it reads its parent as of fork time and writes only what its lock covers. If a context volume overlaps another job's active work volume, the sandbox shows that area as it was at fork time. The fork result lists any such overlaps, so the parent can either wait for that job to merge first or tell the subagent which area is still changing.
- `scope_list()` shows open scopes, their locks, their briefs and how long they've been open. That's how a parent recovers after losing context.

## Connection seams

Ops auto-connect blocks such as fences, walls, panes, stairs and redstone (`05`), and treat their connection properties as **derived state**: a function of the neighbours, not content.

- **In the sandbox**, context blocks count as neighbours, so a fence built up to the boundary connects to the wall it meets. Context blocks next to the work volume may have their connection properties recomputed so renders are correct. That is the only change ever made outside the work volume.
- **On merge**, after the patch is applied, connection properties are recomputed from the current parent document in a one-block shell on both sides of the work-volume boundary.
- **Locks and checks ignore derived state.** A shell recompute may touch blocks inside a neighbouring job's locked work volume. That isn't a conflict: the merge sanity check compares content and skips connection properties, and the neighbour's own merge recomputes its seam again. Recomputing is idempotent, so the order of merges doesn't matter.

## Components

Components cross the boundary under strict rules. Without them a component would either break when merged or blend into a neighbouring one.

| Parent component at fork | In the sandbox | On merge |
|---|---|---|
| Wholly inside the work volume | Copied and editable (metadata, anchors, region within the work volume) | Changes written back |
| Crossing the work-volume boundary, or in the context volume | Read-only reference, clipped, flagged `external` (and `partial` if clipped). Its anchors can still be used for placement. | Untouched |
| Outside both volumes | Absent | Untouched |

- New components created in the sandbox must lie wholly inside the work volume.
- Ids must be unique across the whole build. The fork sends the sandbox the component ids from the whole document chain (names only, no regions) as reserved names, so a collision fails when the component is created, not at merge. The merge checks again.
- The merge translates every region and anchor back to the parent's coordinates.

## Addressing

All subagents share one MCP server process, so one server holds the base session plus any number of sandboxes.

- Every document tool accepts an optional `scope` parameter. Without it, calls go to the base document.
- **While any scope is open, mutating calls must name their target**, with `scope: "<id>"` or `scope: "base"`. A subagent that forgets its id gets an error instead of silently editing the wrong document at the wrong coordinates.

## Nesting

Since any agent can delegate, a subagent may fork a sandbox from its own sandbox with the same mechanism:

- The child's work volume must lie inside the parent's work volume. The child's context volume must lie inside the parent's work and context volumes.
- The child's lock lives in the parent sandbox, and the child merges into the parent, not into the base build.

Nesting costs coordination: more briefs, more reports, and locks at several levels. The delegation threshold keeps it rare. A subagent's sandbox is usually already below the threshold, so in practice depth stays at one or two.

### Over-nesting safeguard

The skill's threshold is advisory, so the server adds hard limits that stop runaway recursion. Unlike complexity, these are mechanical size checks the server can measure, so it enforces them in `scope_fork`. Each refusal says which limit was hit and what to do instead.

| Limit | Default | Refusal tells the agent |
|---|---|---|
| **Not too large:** the child's work volume is at most this fraction of the parent's work volume (for a fork from the base build, of the base's bounds) | 50% | "This is most of your own job: do it yourself, or split it into smaller jobs." |
| **Not too small:** the child's work volume has at least this many blocks | 512 (8³) | "Small enough to do directly." |
| **Depth backstop:** maximum fork depth below the base build | 3 | "Too deep: finish this job in your own sandbox." |

- Sizes are voxel counts of the work volume after whole-block extension. Context volume doesn't count.
- The 50% cap means each level at least halves the region. Delegating "almost all of my job" just moves the same problem down a level and adds overhead.
- The ratio and size limits alone don't bound depth tightly on a very large build (halving from 512³ to 8³ takes 18 levels), so the depth cap is the backstop.
- All three are configurable in server settings. They stop pathological forks, while deciding *whether* to delegate stays with the skill.

## Persistence

Resolved (was an open question): open scopes and locks live **in memory only** and are abandoned when the session closes (`scope.abandon` with reason `restart`, `12`). `scope_list` and `scope_abandon` are the cleanup tools. Persisting them under `<doc>/scopes/<id>/` would mean saving every sandbox and reconciling locks with a base document that may have been edited by another process; that isn't worth it until a real session shows jobs outliving a restart. While a scope is open, `doc_new` and `doc_open` (including imports) are refused (`scopes_open`), so a job's base document can't be swapped out from under it.

## Implementation status

| Piece | Status |
|-------|--------|
| Scope model | Built: `src/scope/scopes.ts` (`ScopeManager`, held by `Session.scopes`). A sandbox is a `Document` with only the work and context volumes copied (block entities cloned), re-origined so the work volume's minimum corner is (0,0,0). It shares the parent's state table and palette book. `offset` records the translation; boxes in events compose offsets up the chain into the base frame. |
| `scope_fork` | Built (`src/server/tools/scope.ts`). Whole-block extension (`src/scope/multiblock.ts`): doors and other `half=upper\|lower` blocks, beds, double chests and a new optional plugin hook `multiBlock.partners(state)` (`plugins/types.ts`); applied to work and context, the work extension is reported. Limits, locks, stale-context report and the handoff block as specified. |
| Limits | `scope.maxWorkRatio` (0.5), `scope.minWorkBlocks` (512), `scope.maxDepth` (3) in `src/scope/settings.ts`, read through `core/settings.ts` (`--set scope.maxDepth=2`, `AUTOSKETCH_SCOPE_MAX_DEPTH`), passed to `Session` by `server/index.ts`. |
| Write rules and locks | Built on a new optional `Document.guard` (checked after an edit body, inside its rollback, and before every undo and redo) so tools, scripts, plugin actions and history all obey it. |
| `scope_merge` | Built: one parent journal entry (`scope_merge`), content sanity check, seam recompute with `reconnectPositions` over a one-block shell on both sides, components written back. Result: report, `formatDiff` counts by family, changed box, seam count, optional render. |
| `scope_abandon`, `scope_list` | Built. Abandon cascades to jobs forked from the abandoned one. |
| Components | Built per the table. External components are tagged `external` (and `partial` when clipped). |
| Addressing | Built centrally: the `tool()` wrapper adds `scope` to every document tool's schema and runs the call in `Session.inScope`; `Session.require()` returns the addressed document (AsyncLocalStorage, so concurrent calls never mix). Tools that address no document carry `doc: false`. |
| Nesting | Built. |
| Perception | `render({ context })` ghosts (default), draws normally or hides `doc.context`; ghosted blocks never cull an editable block's faces. `view_slice` marks context rows (`\| ctx`, or `\| ctx x3..4` for part of a row). |
| Events | `scope.fork`, `scope.merge`, `scope.abandon` through the parent's sink; sandbox documents get `Session.eventsFor(id)` (the observer's sink tagged with the scope id), so their `doc.op` events carry `doc: "<id>"`. |
| Tests | `test/unit/scope/` (every refusal code, fence seam in sandbox and after merge, parallel merges in either order, one-undo merge, nesting, components, extension, events, settings, ghosting and slice marks) and `test/unit/server/scope-tools.test.ts` (over MCP). |

Decisions made while building:

- **Connection properties** are defined by `connectionNeutral` in `ops/connect.ts`: fence, pane and wire sides, wall sides and `up`, stair `shape`, chest `type`. A plugin's connecting block keeps only its id, since the plugin doesn't say which properties it derives. A change is "derived" when the neutral states match and the block entity didn't change.
- **Net changes only.** The guard sees each position's net change, so an op over a larger selection that changes nothing outside the work volume (a `clear` of air, a `replace` that matches nothing there) passes.
- **Context recompute** is allowed anywhere in the context volume, not only next to the work volume. In practice only neighbours of written blocks are ever recomputed, so it is the same rule, checked more cheaply.
- **Locks also guard undo and redo** in the parent: undoing an older edit inside a lock would break the merge check. **`restore` is all or nothing:** with a guard installed, `Document.restore` first runs the guard over every step (read from memory or disk with `journal.peek`, each in the origin it would see) and applies none if any is refused. The refusal names the step (`step 3 of 3 (undo of op #1 …)`), keeps that step's code (`lock_overlap`, `outside_work_volume`; `restore_refused` for a guard error without one) and says the document is unchanged.
- **The merge diff** compares the sandbox with the parent inside the work volume (the check guarantees the parent is unchanged), rather than replaying the sandbox journal. Block entities are compared by value.
- **The ratio limit for a fork from the base** uses the base document's bounds (declared size plus everything built), or the root's work volume when the base is linked to the world (`13`). An empty document with no declared size has no bounds, so every fork from it is too large.
- **Default context** is the work volume grown by 3 blocks (a cube kernel), i.e. `{ padding: 3 }`. The old `{ expand: n }` is refused with a message naming `padding` (`01`, *Terminology*). A nested job's context is clipped to its parent's volumes and the result says how much was dropped. A nested work volume outside the parent's is refused.
- **Extra refusal codes** beyond those `12` lists: `nest_outside`, `scope_unknown`, `scope_children` (merge a job with open children), `scopes_open`, `component_reserved`, `merge_check`, `restore_refused`.
- **Who merges.** The parent calls `scope_merge` with the subagent's report; the handoff tells the subagent not to merge itself. `scope_merge`, `scope_abandon` and `scope_list` name the job directly and don't take the wrapper's `scope`. For `scope_fork`, `scope` is the document to fork from.
- **Sandbox documents** are named `<doc>-<id>`. `export` works from a sandbox and writes into the base document's `exports/` folder.
- **Spec v1 shape:** `{ palette?, levels? (named y values, translated), anchors? (named points, translated), values? (anything else, passed as is) }`.

## Open questions

- **Spec format.** v1 uses the shape above. Is it the smallest spec that keeps neighbouring jobs consistent, and should it be a library item (`07`) so it can be reused across jobs?
- **Threshold wording.** How should the skill describe "too large to comprehend" so agents delegate when they should and not otherwise? Tier 3 evals (`10`) should calibrate it, including runs that show over-eager forking.
- **Component picks.** When an agent picks a component, what does it select by default: the component's box, its voxel mask, or connected blocks of the same family? (Ties into the box-vs-mask question in `04`.) Sandboxes classify components by their box for now.
