# Reusable-components silos (`17`): completion record and follow-ups

Written for whoever picks up work after `17`. Every step of this set (silos W, K, F, Q, V, E and Z, steps W1 to Z2) was done on 2026-11-18, each merged into `main` by the lead. `17`'s *Implementation status* describes what was built, and [PROGRESS.md](PROGRESS.md) is the step-by-step log. This file keeps the state at completion and what the merges left open.

## State at completion (branch `silo/rc-z-end-to-end`, step Z2, on `main` at `ef95cb9`)

- `npm run typecheck` clean; `npm test` 1039 passed, 14 skipped (opt-in local and e2e tiers).
- `cd mod && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ./gradlew build test runGameTestServer`: build and JUnit pass, all 52 GameTests pass.
- `mod/clienttest.sh` (all suites, `candidates` and `editors` included): 651 steps, passing two runs in a row after the Z2 test changes below.
- e2e world tier against the Craftoria server (`AUTOSKETCH_E2E_SERVER=~/servers/craftoria`, Craftoria 1.37.0, NeoForge 21.1.249): 13 of 13, the new `test/e2e/world/components.test.ts` included (lead's run after Z1).

## How the work ran

- **One fresh agent per step, never resumed or messaged.** A step is one merge (`README.md`, *How to run this set*). Each agent (`rc-<step>`) worked in its silo's worktree on `silo/rc-<letter>-<slug>`, committed, and stopped with a four-line report. The lead checked a step by running the tiers on the branch and reading `git log --stat`, not the transcript, then merged with `--no-ff` and logged one line in `PROGRESS.md`. This replaced the `16` run's resumed agents, whose growing transcripts overloaded contexts.
- **The resume safeguard.** A project hook (`.claude/hooks/no-silo-resume.mjs`, PreToolUse on SendMessage) blocks any message to an agent named `rc-…`. Review fixes and interrupted steps were to start a fresh agent with the step prompt plus notes (`rc-<step>-fix`, or "the branch has a WIP commit"); no step needed either in this run.
- **Lead-side rebases of the status table.** Several silos added rows to `17`'s *Implementation status* in parallel. The lead rebased branches and combined the rows at merge time (K1 on F1, W1 into W's table, W2 extended F1's), and fixed stale rows other silos' work had overtaken (`13`'s candidates row after W2, W's piece 6 row after E1, `13`'s `onChat` note after V2). Once this went wrong (*Fixed at the end*).
- **Waves.** Wave 0: W1, K1, F1 in parallel. Wave 1: K2, Q1 to Q3, V1 to V3, W2, K3, E1, E2, F2 as their dependencies merged (E2 and V3 were tested together, 655 client steps). Wave 2: Z1, Z2.

## Decisions taken during the work

All are recorded in `17` (in the body beside each piece, under *Settled while building it*, *Wire shape*, *MCP side*, *Candidate ghost* or *Built*) or in `13`.

- **Component set (K1).** Arguments combine in one call, applied as `load` or `clear`, `remove`, `add`, `save_as`, after every name is checked, so a refused call changes nothing. `add` takes ids or display names, never sheet cells. The set is not tied to the open document.
- **Kits (K1).** `save_as` writes `knowledge/kits/<stem>.md` and rewrites only `entries` on a second save. `load` skips a prefab gone from the library with a warning, rather than refusing the kit.
- **Labels (K2).** Labels win over names and cells, case-insensitively. Resolution is in the `stamp` tool only, not in scripts or procedures, so a saved procedure never depends on one session's labels.
- **Reminder (K2, K3, Z2).** The last line of `prefab_search`, `prefab_sheet` and `stamp` results and of each in-game request's event (build, ask, plan, scan, and the picks event), only while the set has entries. Placement kept, not widened: about 40–50 tokens for 5 entries, 110–145 for 15 (estimated at 3–4 characters a token, not counted with a tokenizer).
- **Candidates limit (Q1, Z2).** At most 24, no paging: the default cells come from one sheet page.
- **Save format (F1).** `.litematic` is now listed by library scans. Saving in another format replaces the old `prefab.<ext>`.
- **Wire (W1, W2).** The clickable line is an optional `action` on a `chat` reply. `candidates.ghost` takes `dimension`. New error `answered`. `candidates.ghost.clear` with no ghost is `{}`. Editor writes are four kinds, `library.write.{prefab,palette,procedure,knowledge}`. A stale hash is the existing `conflict`, a read-only root `bad_request`, and a folder without `prefab.json` hashes as `"absent"`. The save flash is a Flash record with job `"save"` in `#ffffff`.
- **Candidates on the MCP (Q1 to Q3).** Ids `c1`, `c2`, … for the session; prefabs not on the last sheet get `#n`; set labels aren't used in candidates; the line is `[Show candidates (n)]`, or the cells as plain text without `ui`. The ghost is placed as `stamp` places it, untinted, with the rotation shared through `core/rotate.ts` (`orientBox`). A closed request reopens under its own id (the mod's counter); a list with no request answers `{request: null}`. A list is marked answered only once the event is delivered.
- **Candidates screen (V1 to V3).** `ThumbnailGrid` and `OrbitPreview` extracted from `LibraryScreen`. The click runs `/autosketch action <n>` (a client command is capped at 256 characters), and the line is clickable only for clients with `autosketch:ui`. Submit closes only when the MCP accepts. *Preview here* uses the block under the crosshair, with no rotate. The screen keeps ticks and labels across a preview. The fake MCP's script `replies` gained an optional `args` match.
- **Editors (E1, E2).** A read-only root is checked before the hash. Palette edits are weights, remove, drop and rename, plus members added by block id. With no instance loaded, a palette member edit is `bad_request`. *Edit* sits beside *Delete*, only when the entry is editable. Each form is its own class on `EntryEditorScreen`. A `conflict` drops the typed text and reloads.
- **Flash on save (F2).** Sent only while the base document is linked. It is not a session event, so it never appears in replay.
- **End to end (Z1).** The client side is driven at the MCP's edge: a headless server has no player with `autosketch:ui`, and the client harness on Craftoria is a manual 8 GB run.

## Fixed at the end

- **ENOTEMPTY flake in `test/unit/server/library.test.ts`** (seen in W2 and Q3's runs, and probably the unidentified intermittent failure in the `16` handoff). Each `connect()` opened a Session whose autosave timer could fire after the last test and race `afterAll`'s `rm`. The lead fixed it in `4c8ee87` by closing the sessions before removing the temp tree.
- **Conflict markers in `17`.** The lead's progress commit `65e430f` (Q1's merge) committed unresolved conflict markers in `17`'s status table. `f7c88fe` resolved them.
- **Flaky client test `screen/LibraryClientTests.actionsSendTheirRequests`** (Z2). It timed out once on "park_bench's entry arrived" after Copy in V2's run. Cause: the test selected the next entry as soon as the action's request was *sent*. The copy's result arrived after that click and cleared the selection (`selectLater`: a copy selects the new entry once a list holds it). The library screen then dropped the newly selected entry's `library.entry` answer, because it was no longer selected, so the entry never showed. Rename and delete clear the selection the same way. Fix, test side only: the actions that reload (rename, duplicate, delete, copy, hide, restore, empty trash) now wait for the list the screen loads after the result (`acts`), a condition, not ticks. The screen's behaviour is unchanged. A player who clicks another entry while a copy is in flight sees the copy selected afterwards, which is the intended behaviour.
- **Editors client suite on one fake MCP** (Z2). The suite restarted the fake MCP before each test to change what `library.entry` answered. Its script now answers `library.entry` per entry (replies matched on root, kind and name) and refuses `library.write.procedure` with `conflict` only for the conflict test's typed text. Every check is kept. The one that asserted "no write sent at all" now counts from the test's own start, as the others do.

## Follow-ups

**Checks still to run**
- **Dev `runServer`:** not run in this set, because the EULA in `mod/run` isn't accepted (it needs the user). The dedicated GameTest server (`runGameTestServer`) and the vanilla-join GameTests pass, and the jar boots on the Craftoria server in the e2e tier.
- **Client harness against Craftoria** (`mod/clienttest-craftoria.sh`): a manual run, needing about 8 GB more for the client instance's mods. The click, the candidates screen, *Preview here* and the editors are covered only against the fake MCP.
- **In-game check by the user** on the real Craftoria client: the candidates screen from a reply line, *Preview here* and *Clear candidate ghost*, the four editors, the white save flash.

**Possible later work**
- **Reminder line in long sessions.** Nobody has yet seen whether the line survives an agent client's summarising over a long real session. Widen the placement only with that evidence, and firm up K2's token estimate with the token-counting API if it matters.
- **Pending select after a copy into a list that never holds it.** `LibraryScreen.selectLater` keeps its pending address until a list contains it. With a real MCP the copy always appears, so this is harmless. Worth a look only if a copy can fail silently.
