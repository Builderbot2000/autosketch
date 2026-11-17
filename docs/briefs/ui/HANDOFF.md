# In-game UI silos (`16`): completion record and follow-ups

Written for whoever picks up work after `16`. Every silo in this set (C, H, L, M, O, G, R, S, X) was merged into `main` on 2026-11-17. Their branches and worktrees are deleted. `16`'s *Implementation status* describes what was built. This file keeps what the merges left open.

## State at completion (`main`)

- `npm run typecheck` clean; `npm test` 971 passed, 13 skipped (opt-in local and e2e tiers).
- `cd mod && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ./gradlew build test runGameTestServer`: build and JUnit pass, all 51 GameTests pass.
- `mod/clienttest.sh` (all suites: basics, ghost, ghost-measure, link, overlay, replay, screen): 455 steps, passing three runs in a row after the harness fix below.
- `npm pack --dry-run`: no `viewer/` or `three`.

## How the work ran

- One named background agent per silo, each in its own worktree on `silo/ui-<letter>-<slug>`. The lead reviewed contracts, merged with `--no-ff` after running every tier above, and pushed.
- Early merges kept dependent silos unblocked: L's test change (L1), M's move of the viewer's model files (M1), R's client-action relay op, and G's block drawing (G1).
- All agents stopped once on an account usage limit. Their uncommitted work was committed as one WIP commit per branch and pushed. The same session then resumed them, and each silo split or replaced its WIP commit before it was merged.

## Decisions taken during the work

All are recorded in `16`'s *Decisions* or in `13`.

- The offline lock covers the server console and RCON too.
- The Craftoria-sized client run is deferred, because neither the server pack nor the current client pack boots on the dev profile (NeoForge 21.1.249).
- Relay op 3 `CLIENT_ACTION` is generic. Server commands (`/autosketch replay`, `/autosketch ghost`) hand actions to the client half, and the client sends its own `ui.request`.
- `ui` overlays go to one player set. Jobs, flashes, ghosts and frames from another dimension are kept but not drawn.
- C added the request kinds `library.trash` and `ghost.clear` and the error `internal`.
- The automatic instance choice is not saved to `config.toml` (X).
- Sandbox ghosts show only positions that differ from the base. A finished log replays at the current link or ghost anchor, because logs don't record a world origin (M).
- `AutosketchConfig`'s static fields are excluded from the Cloth Config screen; building entries for them crashed the screen (S).
- No reference screenshots are committed. Pixel checks compare frames from the same run.

## Fixed at the end

- **Harness: leaked fake MCPs.** `FakeMcp.close()` stopped `tsx` but not its child node process. The orphan kept reconnecting and fought the next test's fake MCP, which failed S's settings tests and O's offline wait intermittently. Fixed with the user's go-ahead: `close()` now stops the process's descendants too.

## Follow-ups

**Checks run after the merges** (2026-11-17)
- **Dedicated server:** passed. The fresh jar booted on the Craftoria server pack (`test/e2e/world/server.sh start ~/servers/craftoria`, 537 mods) with the bridge listening and no Autosketch errors. The dev `runServer` still needs the user to accept the EULA in `mod/run`.
- **e2e world tier:** 12 of 12 pass, with `AUTOSKETCH_E2E_SERVER=~/servers/craftoria` and `AUTOSKETCH_E2E_INSTANCE` set to the Craftoria CurseForge instance.
- **CI `client` job:** passes (run 44201769605: 467 steps; the game boots on the runner in about 17 s). The earlier replay failures came from a fake MCP leaked when it was closed while tsx was still starting its child. The fix: the fake MCP runs in its own process group, which `close()` kills whole, and replay tests switch MCPs deterministically. It also closed a product gap: the client ends its replay (`replay.ended`) when the MCP side drops or resyncs.
- **In-game check by the user** on the real Craftoria client: still to do. `docs/briefs/world/test-setup.md` marks what the harness now automates.
- The `src/ui/` dependency rule was added to `docs/ARCHITECTURE.md` with the user's OK.

**Small code follow-ups**
- R draws replay job volumes and flashes with its own minimal line boxes. Switch them to O's overlay drawing now that both are on `main`.
- S's log list opens a replay through `/autosketch replay <log>`, because `ReplayClient.open` is package-private. Either keep that, or have R install its opener (`AutosketchScreens.setReplayOpener`, `LogListScreen.setOpener`).
- `OPEN_REPLAY` key: S attached it to the log list. Check that R and S agree on it.
- Ghost meshing runs on the render thread with a 4 ms budget per frame. A solid 256³ ghost takes about 45 s to fill in. A scattered 256³ ghost needs 3.3 GiB of meshes. Possible follow-ups: mesh off the render thread, or cap quads or distance.
- Dead code: `library/manage.ts`'s editor writes (`writeEntryText`, `writePrefabMeta`, `writePaletteFile`) have no callers now.
- Old "management UI" wording in comments in `core/config.ts`, `core/settings.ts`, `cli/index.ts`, `library/roots.ts` and `assets/discover/types.ts`.
- An intermittent `npm test` failure was seen twice, once by silo-c and once at R's merge. It didn't recur in later reruns, and the failing test wasn't identified.
- `JAVA_HOME` in the user's `~/.bash_profile` points at JDK 11; Gradle needs 17 or later. Prefix Gradle as above, or change that line.
- The Craftoria-sized client run (`mod/clienttest-craftoria.sh`) waits for a newer NeoForge on the dev profile, or a curated list of mods to leave out.

## Paused 2026-11-17

The user paused the follow-up work. State at the pause:

- **Done and pushed:** the `src/ui/` dependency rule in ARCHITECTURE.md; the dead library editor writes removed; the old "management UI" comments updated.
- **Replay follow-ups** (switch replay's boxes to O's `DrawList`, have S's log list call R's opener directly, check that the `OPEN_REPLAY` key matches): partly done. An untested WIP commit sits on the local branch `fix/replay-followups`, in worktree `.claude/worktrees/silo-r-fu`. It is not pushed.
- **Ghost meshing off the render thread, and a distance cap:** not started in any lasting form. The agent was stopped before it committed, so its work was lost.
- **Intermittent `npm test` failure:** not investigated yet.

