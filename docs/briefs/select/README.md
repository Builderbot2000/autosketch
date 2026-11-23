# Work briefs: select (`18`)

One brief per silo of `18`'s *New pieces*, *Removal*, *Measure first* and *Testing*, as of commit `4825b48` (2026-11-22). Each team reads the main [briefs README](../README.md) first (branching, file ownership, code style and *Done means* all apply), then the [world README](../world/README.md) and the [UI README](../ui/README.md)'s *Rules for this set* where it touches `src/world/`, `src/ui/` or `mod/`, then this README, then its own brief, then `18` and the sections of `05`, `06`, `11`, `13`, `16` and `17` the brief cites. `18` is the source of truth. A brief only scopes, sequences and assigns files.

**Status: not started.** [PROGRESS.md](PROGRESS.md) is the step log.

Letters are local to this set. Agents work one step at a time and are never resumed (*How to run this set*). Branches are named `silo/sl-<letter>-<slug>` so they never collide with earlier sets.

| Silo | Brief | `18` pieces | Wave | Side | Depends on |
|---|---|---|---|---|---|
| W | [Wire contracts](W-wire.md) | *Wire*; 2, 3, 4, 5, 7, 8 (wire parts) | 0, then 1 | both | — |
| V | [World view and fade](V-world-view.md) | 5, 6, 10 (surface read) | 0, then 1 | MCP | W1 for coarse and mask snapshots (V2) |
| M | [Mod world reads](M-mod-reads.md) | 2, 3, 4, snapshot `mask`/`coarse` | 1 | mod | W1 |
| C | [Command and client overlays](C-command-overlays.md) | 1 (mod), 7 (click), 8 (client) | 1, then 2 | mod | W1 (C1), W2 (C2, C3) |
| T | [Search, fill, expand and confirm tools](T-select-tools.md) | 2, 3, 4, 9 (MCP) | 1, then 2 | MCP | W1; V1 (T2) |
| P | [Select mode, choices and candidate outline](P-prompt-choices.md) | 1 (MCP), 7, 8 (MCP), 10 (agent guide) | 1, then 2 | MCP | W1 (P1), W2 (P2, P3), T2 (P3) |
| R | [Scan removal](R-removal.md) | *Removal* | 3 | both | P1, C1, V2 |
| Z | [Measure, end to end, close-out](Z-measure-e2e.md) | *Measure first*, *Testing* (end to end), open questions | 2, then 3 | both | M (Z1); all (Z2, Z3) |

```
wave 0                    wave 1                                  wave 2                              wave 3
W1: mode select, search, ─┬─► M1 search · M2 fill+expand · M3 snapshot mask/coarse ──► Z1 measure ─┐
    fill, expand,         ├─► C1 /autosketch select (mod) ─────────────────────────────────────────┼─► R1 scan removal
    snapshot mask/coarse  ├─► T1 world_search ──► T2 world_fill, world_expand ──► T3 confirm ─────┤
                          ├─► P1 select mode, agent guide ─────────────────────────────────────────┤
                          └─► V2 coarse, fade, surface read                                        ├─► Z2 end to end
V1: world view beside the document ─────────► (T2 uses it)                                         │   Z3 status, handoff
W2: choices kind, steady fill, volume lines ─┬─► C2 candidate outline, C3 volumes on the overlay ─┤
                                             └─► P2 choices · P3 candidate shell feed (after T2) ──┘
```

**Why this split.** As in the UI and components sets, the MCP and the mod meet only at the protocol, so W freezes the wire first and both sides build against it, the MCP side against W's fake host. The mod work splits by side of the game: M is server-side world reads (search, fill, expand, snapshots: all chunk and tick-slicing work in `mod/common/.../world/`), C is the command and everything the client draws. On the MCP, V owns the world view and the renderer (a perception concern every select tool reads through), T owns the four world tools that move the candidate, and P owns how the request is presented to the agent and the player (mode, guide, choices, the in-world candidate drawing). Removal waits until select works end to end on both sides, so the tree never has neither command. Z measures as soon as M's reads exist, because *Measure first* fixes defaults the others use as interim values.

**Principles every team keeps** (`18`, *Principles*): measurements, not opinions (no code decides what a building is, which blocks are player-placed, or where a structure ends); no built-versus-generated split; the player never types block ids; the agent owns the cut; the confirmed shape advises, only the box is enforced; cost follows need (block-type lists for finding, full blocks only for the shape and its margin, coarse first).

## Cross-silo contracts

The owner lands the contract in its first merge, and the users code against it.

| Contract | Owner | Users | Shape |
|---|---|---|---|
| Mode `select` | W1 | C1, P1, R1 | Added to `RequestMode` and the mod's modes; read-only, volume-changing; `prompt` in mode `select` carries no grant. `scan` stays on the wire until R1 retires it in a protocol bump |
| `search`, `fill`, `expand` requests | W1 (shapes), M (behaviour), T (callers) | M, T | `18` pieces 2–4: request ids, served in arrival order; answers carry per-chunk counts, sections, clusters (closed/open), reached ring and ungenerated chunks (search); mask per touched section (4096-bit set or "full"), bounding box, count, frontier faces (fill); expand by `"frontier"`, direction and chunk count, or box |
| Snapshot `mask` and `coarse` | W1 (shape), M3 (mod), V2 (MCP) | V, T | `snapshot` gains sections-plus-margin by mask and a cell size 2 or 4 (most common non-air block per cell) |
| Read grants in select mode | W1 records, M enforces | T, V | A search grants block snapshots inside its searched chunks for the rest of the request; see *Open point for the user* for reads before any search |
| Fake host | W1, W2 | T, V, P | `test/support/fake-host.ts` answers `search`, `fill`, `expand` and the new snapshots from its in-memory world with the same algorithm (fill parity with `{connected}` in `src/ops/selection.ts`), so MCP silos never wait on the mod |
| Choice kind | W2 (names, shapes), P2 (behaviour), C1 (click) | C, P | One `ui.request` kind for a clicked choice, carrying the request id and the choice index (or text); answered `answered` once taken. Choices go out as one `chat` message per line (`17`'s one-action rule) |
| Steady fill record | W2 | C2, P3 | A `ui.state` record beside outlines and pulses: faces merged into rectangles, a colour, a constant alpha, a job or `candidate` id. Candidate edges near range as outline boxes per section mask boundary |
| Volume lines | W2 | C3 | Whatever C3 needs to draw work and context volumes on the overlay at distance (from the mod's own volume state or from `ui.state`); W2 decides with C's brief and records it in `13` |
| World view | V1 | T, P, Z | A session-held read-only `WorldView` beside the open document: `read(boxes|sections)`, `has(pos)`, named selections (`candidate`), the blocks read so far; `view: "world"` accepted by `render`, `view_slice`, `raycast`, `select`, `analyze`; every edit refused |
| Candidate | T2 | P3, T3, Z | The named selection `candidate` in the world view, with its mask, box, count and frontier; replaced or combined by later fills and the selection algebra |

## Contested files

| File | Who touches it | Protocol |
|---|---|---|
| `src/world/protocol/**`, `test/data/world-protocol/**`, `test/support/fake-host.ts`, `test/support/fake-mcp.ts`, `mod/common/.../protocol/**` | W, then R (the scan retirement bump), bug fixes only otherwise | W owns them. Others ask W (or the user) before changing a schema |
| `docs/design/13-live-world.md` | W (*Request kinds*, *Message schemas*), R (B4 pointers, *Implementation status* rows) | W first, R last |
| `docs/design/18-select.md` | W1 adds the *Implementation status* table; each silo its own rows; Z1 the measured defaults and the radius answer; Z3 the *Status* line | Edit only your rows |
| `src/server/session.ts` | V1 (world view field), T (search state, candidate) | Additive fields only; V1 first |
| `src/server/tools/perception.ts`, `query.ts` | V (`view` argument) | V only |
| `src/server/tools/world-volumes.ts` | T3 (`from: "candidate"`), R (drop probe coordinates) | T3 first |
| `src/server/tools/world-prompt.ts` | P2 (`choices`) | P only |
| `src/world/prompt.ts`, `src/world/modes.ts` | P1 (select mode), R (scan out) | P1 first |
| `src/perception/render/render.ts` | V2 (`fade`, coarse caption) | V only |
| `src/ui/feed.ts`, `src/ui/requests.ts` (dispatch) | P2 (choice kind), P3 (candidate shell) | One line per kind; handlers in their own modules |
| `mod/common/.../world/SurfaceReads.java`, `WorldReads.java` | M (grants by search), R (scan grant reads out) | M first |
| `mod/common/.../prompt/InGamePrompts.java`, `command/AutosketchCommand.java` | C1 (select), R (scan out) | C1 first |
| `mod/neoforge/.../client/ui/overlay/**` | C2, C3 | C only |
| `mod/common/.../feedback/Feedback.java` | C3 (particles become the fallback) | C only |
| `AutosketchConfig.java`, `ConfigToml.java` | M (`selectChunks`, search defaults), R (`[scan]` out) | M first |

## Rules for this set

- **No opinions in code.** The mod and the MCP report where materials are and what connects. No heuristic for "player-placed", no automatic cut, no ranking beyond nearest and densest in the heat-map text.
- **The candidate guides, the box enforces.** Nothing refuses an edit for being outside the shape; only the work box does, as today.
- **The client half stays thin** (UI set rule): the shell's faces and outline boxes are computed on the MCP and travel in messages.
- **Tick slicing everywhere in the mod.** Search, fill and expand never do more than their per-tick budget; nothing generates chunks.
- **Interim defaults stay configurable** (`selectChunks` 256, `gap` 2, `stop` 1, margin 8, coarse cell sizes) until Z1 measures them.

## Open point for the user

`18` grants reads inside searched chunks, but terrain (piece 10) starts from a starter volume with no search, and `world_view_read` may target an area no search covered. The lead must settle with the user, before M1 and V1 build the grant, which reads select mode allows before or outside a search. Proposed default: in select mode, the mod serves block snapshots anywhere within `selectChunks` of the player, capped per call by `contextCap`, and a search extends nothing further.

## How to run this set

As in the components set: **an agent lives for exactly one step, and is never resumed or messaged.**

- **A step is one merge.** The table below fixes the steps. One fresh agent per step, named `sl-<step>` (e.g. `sl-m2`), working in the silo's worktree on `silo/sl-<letter>-<slug>`.
- **No resume, no SendMessage.** The project hook (`.claude/hooks/no-silo-resume.mjs`) blocks SendMessage to any agent named `rc-…` or `sl-…`. Never use the `fork` agent type for a step: it copies the lead's context.
- **Review fixes are a new agent** (`sl-m2-fix`) whose prompt is the step prompt plus the lead's review notes.
- **An interrupted step**: the lead commits whatever the worktree holds as `WIP sl-<step>: interrupted` and starts a fresh agent with the step prompt plus "the branch has a WIP commit with partial work: read `git diff main...HEAD`, then finish the step and replace the WIP commit."
- **State lives in git and the docs**: commits, `18`'s *Implementation status* rows, and `PROGRESS.md` in this folder.

| Silo | Steps (one merge each) |
|---|---|
| W | W1 mode `select`; `search`, `fill`, `expand`; snapshot `mask`/`coarse`; vectors, both codecs, fake host serving them; `18`'s status table · W2 choice kind, steady fill record, volume lines; `13`'s tables |
| V | V1 world view beside the document, `view: "world"` on the five tools, `world_view_read` by box · V2 coarse level and its caption, `fade`, left-out-neighbour highlight test, surface read for terrain (after W1) |
| M | M1 material search: ring walk, `maybeHas`, clusters, `gap`/`stop`, resumable, disk reads, tick slicing, grants, `selectChunks` config · M2 fill and expand: mask, frontier, budgets · M3 snapshot `mask` and `coarse` |
| C | C1 `/autosketch select [text]` and alias, mode `select` in prompts, choice-line click (after W1; the choice kind's click after W2 if not yet merged, else in C2) · C2 steady fill record and candidate outline near and far, pulses for proposed hits · C3 work and context volumes on the overlay, particles as the fallback |
| T | T1 `world_search` with heat-map image, cluster text, `continue` · T2 `world_fill`, `world_expand`, candidate in the world view with its margin read (after V1) · T3 `world_volumes({from: "candidate", margin?})`, too-large handling |
| P | P1 select mode in `modes.ts` and `prompt.ts`, the select event text, agent guide `library/knowledge/skills/select.md` (workflow and terrain) · P2 `world_reply({choices})` and the choice answer as text (after W2) · P3 candidate shell and outline faces sent through the UI feed, proposed hits pulsed (after W2, T2) |
| R | R1 scan removed on both sides, protocol bump retiring `scan` and `prompt.scan`, `13`'s B4 rows pointing to `18` |
| Z | Z1 *Measure first* on Craftoria, defaults and the radius answer recorded in `18` (after M) · Z2 end-to-end world test, two houses and a ruin · Z3 status, `HANDOFF.md` |

**Waves.** Wave 0: W1, V1. Wave 1, from W1: M1–M3, C1, T1, P1, V2, W2. Wave 2: T2 (V1), T3, C2, C3, P2, P3, Z1 (M). Wave 3: R1, Z2, Z3.

**Step prompt** (the whole prompt; add review notes or WIP instructions after it):

> You are agent `sl-<step>` in the autosketch repo, worktree `<path>`, branch `silo/sl-<letter>-<slug>`. Read `docs/briefs/README.md`, `docs/briefs/select/README.md` and `docs/briefs/select/<brief>.md`, then the spec sections the brief cites. Do step <step> only: <one line from the table>. Meet the *Done means* for what this step builds, commit (attribution line from the main README), and don't merge or push. Write full test and build output to files and read only the summary or the failures. Then stop with this report and nothing else:
> ```
> sl-<step> · branch <branch> · commits <first>..<last>
> tiers: typecheck <ok|fail> · npm test <n passed / n failed> · gradle <ok|fail|n/a> · clienttest <n steps ok|fail|n/a>
> decisions: <one line each, already recorded in the spec>
> questions for the lead: <one line each, or none>
> ```

The lead checks a step by running the tiers on the branch and reading `git log --stat main..<branch>`, not the agent's transcript or output file, and then adds one line to `PROGRESS.md`.

## Done means (in addition to the main README's)

- `npm run typecheck`, `npm test`, `cd mod && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ./gradlew build test runGameTestServer` and `mod/clienttest.sh` pass (the last for silos touching `mod/`).
- `18`'s *Implementation status* has a row per piece, marked built, and its *Status* line is updated when Z closes the set.
