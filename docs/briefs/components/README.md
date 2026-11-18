# Work briefs: reusable components (`17`)

One brief per silo of `17`'s *New pieces*, as of commit `c231060` (2026-11-18). Each team reads the main [briefs README](../README.md) first (branching, file ownership, code style and *Done means* all apply), then the [world README](../world/README.md) and the [UI README](../ui/README.md)'s *Rules for this set* where it touches `src/world/`, `src/ui/` or `mod/`, then this README, then its own brief, then `17` and the sections of `07`, `13` and `16` the brief cites. `17` is the source of truth. A brief only scopes, sequences and assigns files.

Letters are local to this set. Agents work one step at a time and are never resumed (*How to run this set*). Branches are named `silo/rc-<letter>-<slug>` so they never collide with earlier sets.

| Silo | Brief | `17` pieces | Wave | Side | Depends on |
|---|---|---|---|---|---|
| W | [Wire contracts](W-wire.md) | 3, 6, 8 (wire parts) | 0 | both | — |
| K | [Component set and kits](K-component-set.md) | 1, 2 | 0, then 1 | MCP | — (reminder on request events after Q's first merge) |
| F | [Save format and flash on save](F-save-format-flash.md) | 7, 8 | 0, then 1 | MCP | W's save flash (piece 8 only) |
| Q | [Candidates, MCP side](Q-candidates-mcp.md) | 3, 5 | 1 | MCP | W |
| V | [Candidates screen](V-candidates-screen.md) | 4 | 1 | mod | W |
| E | [Library editors in game](E-editors.md) | 6 | 1 | both | W; V's extracted screen parts |
| Z | [End to end and close-out](Z-end-to-end.md) | *Testing* (end to end), open questions | 2 | both | all |

```
wave 0                                   wave 1                                     wave 2
W: request kinds, chat action, ──┬─────► Q: world_reply candidates, store,     ──┐
   save flash, schemas, vectors, │          handlers, picks as text              │
   both codecs, fakes            ├─────► V: candidates screen, Preview here ─────┤
                                 ├─────► E: editors (MCP writes + mod forms) ────┼──► Z: end to end,
                                 └─────► F: flash on save ───────────────────────┤      open questions,
F: save format (no wire) ──────────────────────────────────────────────────────┤      status table
K: component_set, kits, label resolution ──► K: reminder on request events ─────┘
```

**Why this split.** As in the UI set, the MCP and the mod meet only at the protocol, so W freezes the new wire first (four `candidates.*` kinds, the editor write kinds, the clickable reply line, the save flash) and both sides build against it. `component_set`, kits and the save format need no wire at all, so K and F start on day one. The candidates feature splits by side (Q the MCP, V the screen) because they share nothing but W's messages. The editors stay one vertical silo (E): the MCP half is mostly recovered code from `b6e60bf`, and each form is only useful with its handler.

**Principles every team keeps** (`17`, *Principles*): the set advises and never constrains; the set is session context and ends with the session; the screen's answer reaches the agent only as text and never changes the set or the build; automatic pastes go straight in with undo, never a preview or approval; everything the agent saves, the player can see and edit; nothing depends on one agent client.

## Cross-silo contracts

The owner lands the contract in its first merge, and the users code against it.

| Contract | Owner | Users | Shape |
|---|---|---|---|
| `candidates.*` request kinds | W (names, shapes), Q (behaviour) | V | `17` piece 3's table, added to `UI_REQUEST_KINDS` and `13`'s *Request kinds* and *Message schemas*; golden vectors; both codecs |
| Editor write kinds | W (names, shapes), E (behaviour) | E | One kind per editable entry type (`17` piece 6's table), each carrying the `hash` it started from; error `conflict` added to the fixed codes |
| Clickable reply line | W | Q (sends), V (handles) | An optional action on a `chat` reply line naming a `ui.request` the client sends when clicked; the client half runs it as replay's log lines do. Vanilla clients see plain text |
| Save flash | W | F | A `ui.flash` entry not tied to a job, in a fixed colour |
| Session component set | K | Q, Z | A record on the MCP session (`src/server/session.ts`, additive): ordered entries, `labelFor(prefab)`, `resolve(label)`, `reminderLine()` (empty while the set is) |
| Last sheet cells | Q | Q, V (through `candidates.open`) | The session remembers prefab → cell from the last `prefab_sheet` call |
| Candidate ghost | Q (MCP, `src/ui/ghosts.ts`), V (draws through G's existing ghost code) | V | One ghost per session with a fixed id, replaced on each `candidates.ghost`, cleared on `candidates.ghost.clear` and on submit |
| Shared screen parts | V | E | V's first merge extracts the thumbnail grid and the 3D preview out of `LibraryScreen` into reusable classes under `client/ui/screen/`, with no behaviour change |

## Contested files

| File | Who touches it | Protocol |
|---|---|---|
| `src/world/protocol/**`, `test/data/world-protocol/**`, `test/support/fake-host.ts`, `test/support/fake-mcp.ts`, `mod/common/.../protocol/**` | W, then bug fixes only | W owns them. Others ask W (or the user) before changing a schema |
| `docs/design/13-live-world.md` | W (*Request kinds*, *Message schemas*, chat message) | W only |
| `docs/design/17-reusable-components.md` | W adds the *Implementation status* table; each silo its own rows; Z resolves the open questions | Edit only your rows |
| `src/server/tools/library.ts` | K (stamp label resolution, reminder on search, sheet and stamp), F (`prefab_save` format and flash), Q (record sheet cells in `prefab_sheet`) | Additive; logic goes below `server/`. K lands first |
| `src/server/session.ts` | K (component set), Q (candidates store, last sheet cells) | Additive fields only |
| `src/world/prompt.ts` | Q (picks as a channel event, new request when closed), K (reminder line on request events) | Q first; K adds one call after Q's merge |
| `src/ui/requests.ts` (dispatch) | Q (`candidates.*`), E (editor kinds) | One line per kind; each silo's handlers in its own module |
| `src/ui/library.ts` | E | E only |
| `mod/neoforge/.../client/ui/screen/LibraryScreen.java` | V (extracts parts), then E (editor entry points) | V's extraction lands first, behaviour unchanged; E rebases |
| `mod/neoforge/.../client/ui/screen/MenuScreen.java` | V (*Clear candidate ghost* next to *Ghost here*) | V only |
| Settings registration (`src/core/settings.ts`) | F (`library.prefabFormat`) | F only |

## Rules for this set

- **No enforcement.** No op refuses or rewrites a call because of the component set. Label resolution in `stamp` is a lookup ahead of names and cells, nothing more.
- **The screen never writes.** `candidates.submit` produces text for the agent. Only the agent's `component_set` call changes the set.
- **The client half stays thin** (UI set rule): candidate lists, cells and ghosts are computed on the MCP and travel in messages.
- **Reminder lines cost tokens.** Only the results `17` names carry them, and only while the set has entries. K measures the cost before anyone widens it.

## How to run this set

In the `16` run, each silo agent was resumed several times (after the usage-limit stop, after reviews, between merges), and every resume carried its whole transcript forward. That overloaded contexts and wasted tokens. In this set, **an agent lives for exactly one step, and is never resumed or messaged.**

- **A step is one merge.** The table below fixes the steps. One fresh agent per step, named `rc-<step>` (e.g. `rc-k2`), working in the silo's worktree on `silo/rc-<letter>-<slug>`.
- **No resume, no SendMessage.** A project hook (`.claude/hooks/no-silo-resume.mjs`) blocks SendMessage to any agent named `rc-…`. Never use the `fork` agent type for a step: it copies the lead's context.
- **Review fixes are a new agent** (`rc-k2-fix`) whose prompt is the step prompt plus the lead's review notes.
- **An interrupted step** (usage limit, crash, stop): the lead commits whatever the worktree holds as `WIP rc-<step>: interrupted` and starts a fresh agent with the step prompt plus "the branch has a WIP commit with partial work: read `git diff main...HEAD`, then finish the step and replace the WIP commit."
- **State lives in git and the docs**, not in transcripts: commits, the spec's *Implementation status* rows, and `PROGRESS.md` in this folder (the lead's one-line-per-step log: step, state, merge commit, open questions).

| Silo | Steps (one merge each) |
|---|---|
| W | W1 `candidates.*` kinds and the reply-line action · W2 editor kinds, save flash, `13`'s tables, `17`'s status table |
| K | K1 record, `component_set`, kits · K2 label resolution in `stamp`, reminder on search, sheet and stamp, token measurement · K3 reminder on request events (after Q1) |
| F | F1 save format and setting · F2 flash on save (after W2) |
| Q | Q1 sheet cells, `world_reply` candidates, `candidates.open` · Q2 candidate ghost handlers · Q3 submit, picks as text |
| V | V1 extract the grid and preview from `LibraryScreen` · V2 reply-line click and the screen · V3 Preview here and the menu entry |
| E | E1 recovered writes and handlers · E2 in-game forms (after V1) |
| Z | Z1 end-to-end test · Z2 open questions, status, `HANDOFF.md` |

**Step prompt** (the whole prompt; add review notes or WIP instructions after it):

> You are agent `rc-<step>` in the autosketch repo, worktree `<path>`, branch `silo/rc-<letter>-<slug>`. Read `docs/briefs/README.md`, `docs/briefs/components/README.md` and `docs/briefs/components/<brief>.md`, then the spec sections the brief cites. Do step <step> only: <one line from the table>. Meet the *Done means* for what this step builds, commit (attribution line from the main README), and don't merge or push. Write full test and build output to files and read only the summary or the failures. Then stop with this report and nothing else:
> ```
> rc-<step> · branch <branch> · commits <first>..<last>
> tiers: typecheck <ok|fail> · npm test <n passed / n failed> · gradle <ok|fail|n/a> · clienttest <n steps ok|fail|n/a>
> decisions: <one line each, already recorded in the spec>
> questions for the lead: <one line each, or none>
> ```

The lead checks a step by running the tiers on the branch and reading `git log --stat main..<branch>`, not the agent's transcript or output file, and then adds one line to `PROGRESS.md`.

## Done means (in addition to the main README's)

- `npm run typecheck`, `npm test`, `cd mod && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ./gradlew build test runGameTestServer` and `mod/clienttest.sh` pass (the last for silos touching `mod/`).
- `17`'s *Implementation status* has a row per piece, marked built, and its *Status* line is updated when Z closes the set.
