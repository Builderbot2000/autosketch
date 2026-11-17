# Handoff: in-game UI silos (`16`), 2026-11-17

Written for the next lead session, which will run under another account and can't resume the agents of this one. It records where every silo stands, what was decided along the way, and how to pick the work up. Read this set's [README](README.md) and the silo briefs first; `16` stays the source of truth.

## How this session ran

- The lead (main session) started one named background agent per silo (`silo-c`, `silo-h`, …), each in its own git worktree under `.claude/worktrees/`, on a branch `silo/ui-<letter>-<slug>`. Agents committed and never merged or pushed. The lead reviewed, ran every tier, merged into `main` with `--no-ff` and pushed.
- Tiers run before each merge: `npm run typecheck`, `npm test`, `cd mod && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ./gradlew build test runGameTestServer`, and `mod/clienttest.sh` (all client suites).
- The user's standing instruction: decide small points within the specs, keep merging and starting waves until the work plan is done, and record decisions in `16`'s *Decisions*. Still stop for the briefs' "decisions you should not make alone", for permission refusals, and for anything that loses work.
- All agents stopped together on an account usage limit. Their uncommitted work was committed by the lead as one "work in progress at handoff" commit per branch, and every silo branch was pushed to `origin`. **Those WIP commits were not built or tested as a whole.**

## State of `main` (pushed, `5d8bd35` plus this file)

Merged and verified (typecheck clean; `npm test` 963 passed, 13 skipped; 49 GameTests; client suites 65 steps passing):

| Silo | What's on main |
|---|---|
| C | All of it: `ui` schemas and request kinds in `13`, golden vectors, TS and Java codecs, fake host with `ui`, `test/support/fake-mcp.ts`, the `autosketch:ui` relay (ops 0 frame part, 1 request, 2 link state), client skeleton (`UiClient`, `UiToggles`, `AutosketchKeys`, `LinkState`), `16` *Implementation status* rows |
| H | All of it: `mod/clienttest.sh`, `clientTest` run, `ClientTestSuite` driver (`@ClientTest("<suite>")`), fake MCP wiring, air mode, `/autosketch done`, xdotool and `LinkState` client tests, CI `client` job (never run yet), boot timings in `16` |
| L | All of it: tests connect a fake MCP first (`FakeMcp.java`), link state, the offline lock (`Link.requireConnected`, `Link.requireUi`, `Link.lock` wrapping every `/autosketch` node except `status`), `/autosketch status` link line, M14 in `13` |
| M | Part 1 only: `src/observe/session-model.ts`, `src/observe/replay.ts` (moved from `viewer/js/`), tests moved |
| R | Part only: relay op 3 `CLIENT_ACTION` (`UiRelay.sendAction`, `UiClient.onAction`) and the replay command's server half (`d5e3942`) |
| G | Part 1 only: block drawing (`client/ui/blocks/`: `PaletteRegion`, `BlockMesher`, `BlockDrawer`, `BlockMesh`) |

## Silo branches (all pushed to `origin`)

| Silo | Branch | Ahead of main | State when stopped | Left to do |
|---|---|---|---|---|
| M | `silo/ui-m-mcp-ui-core` | 4 (feed, ghost regions, replay frames, WIP) | Committed: `src/ui` feed (`ui.state`, `ui.flash`), ghost regions, replay frames. WIP: request handlers (`src/ui/requests.ts`, `settings.ts`, `library.ts`, `errors.ts`, `index.ts`), a fake-host integration test being written, a small `src/world/live-link.ts` change | Finish handlers and the fake-host test; wire `src/ui` into `server/index.ts`; list `ui` in the bridge's `features` (C made the default hello omit it until M answers requests); reduce `http.ts` to `/v1/logs` and `guard.ts` to Origin/Host checks; delete `settings-api.ts`, `library-api.ts`, `library-host.ts` once replaced; latency measurement; rebase (2 behind) |
| O | `silo/ui-o-overlays-hud` | 1 (WIP) | Job volumes, flashes, `seq` check and resync, HUD, overlay and HUD client tests written; was about to run the full checks | Run all tiers; fix what fails; rebase (behind main); final report items. Known flake: see *Open items* (FakeMcp orphan) |
| G | `silo/ui-g-ghosts` | 1 (WIP) | Ghost client suite passed on the last run; was checking a screenshot by eye. WIP: section meshing, sandbox and anchored ghosts (`client/ui/ghost/`, `mod/common/.../ui/ghost/`, `GhostEvents.java`), `/autosketch ghost`, a measurement suite (`ghost-measure`) | Run all tiers; mesh timings into `16`; use `UiClient.onAction` for `ghost.here`/`ghost.clear`; the Craftoria modded-block check is skipped (deferred, *Decisions*) |
| R | `silo/ui-r-replay` | 4 | Overrides, live-update mixin, detached camera, keys, HUD strip, chunk-resend GameTests, client tests, `16` status. Was re-verifying after a rebase; no uncommitted work | Run all tiers; final report; merge |
| S | `silo/ui-s-screens` | 1 (WIP) | Menu on `Home`, toggles, keys, settings screen, library screen with thumbnails all passing their client tests (before the WIP). WIP includes the Cloth Config fix (approved, see *Decisions*), the 3D preview on G's API, lang strings, and a mod-list config test | Finish the preview and its test; run all tiers; final report |
| X | `silo/ui-x-removal-cli` | 3 (X1, X2, WIP) | X1 deleted `viewer/`, `autosketch ui` and `observe`, `observe.open`, `three`; X2 automatic instance choice. WIP: doc edits to `12`, `13`, `14`, `15` | Finish docs (`README.md`, `world/test-setup.md` with what H automates, the release README's *Release gate*: replace K's U4 wizard with automatic instance choice); `16` *Cost* numbers; anything blocked on M's five files (X was told not to touch `http.ts`, `guard.ts`, `settings-api.ts`, `library-api.ts`, `library-host.ts`); `npm pack --dry-run` check; rebase (2 behind) |

Suggested merge order: R, then G, O, S (mod side, independent), M, then X last (it may need follow-up deletions after M).

## Decisions taken this session (all in `16` or `13` unless noted)

- The offline lock covers the server console and RCON too (`16`, *Decisions*).
- The Craftoria-sized client run is deferred: neither the server pack nor the current client pack boots on the dev profile (NeoForge 21.1.249) (`16`, *Decisions*).
- Relay op 3 `CLIENT_ACTION` (server tells a client half to run a named action; mod-internal, same jar) is generic, shared by replay and ghosts (`13`, *Relay to the client*).
- `ui` overlays go to one player set (the allowlist); a client keeps but doesn't draw jobs, flashes, ghosts and replay frames from another dimension (`13`).
- C added request kinds `library.trash` and `ghost.clear`, and error `internal`; the real MCP's default hello omits `ui` until M answers requests.
- S may fix `AutosketchConfig` (another silo's file, additive): `@ConfigEntry.Gui.Excluded` on its static fields, because AutoConfig tried to build entries for them and the Cloth Config screen crashed on `main` (from the mod list too). The fix is in S's WIP commit, not on `main` yet.
- The client harness keeps no reference screenshots (game renders); pixel checks compare two frames of the same run.

## Open items needing the user

- **FakeMcp orphan process** (flaky client tests). `FakeMcp.close()` (`mod/neoforge/src/gametest/.../client/FakeMcp.java`) destroys the `tsx` process but not its child node process, which reconnects and keeps the link `connected`, so a following "offline" wait can time out. Suggested fix: collect `process.descendants()`, destroy them and the process, then `destroyForcibly()` the children. silo-o's attempt to edit the file was refused by a permission check, so the lead didn't apply it; it waits on the user's go-ahead.
- **Dedicated-server boot check** (`./gradlew runServer`) wasn't completed: silo-l's run was inconclusive and silo-c's and the lead's attempts were refused by permission checks. GameTests load the server half without client classes, so the risk is low, but it should be run once by hand.
- **`JAVA_HOME`** in `~/.bash_profile` line 7 points at JDK 11; Gradle needs 17+. Prefix Gradle with `JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64` or change that line (the lead wasn't allowed to edit the profile).
- **e2e tier** (`test/e2e/world/`) hasn't run since L changed it; it needs a running server (`test/e2e/world/server.sh start ~/servers/craftoria`, `AUTOSKETCH_E2E_SERVER`).

## Resuming

1. `git fetch origin` and check each `silo/ui-*` branch against the table above.
2. For each unfinished silo, start a fresh agent (worktree isolation; `worktree.baseRef` defaults to `origin/<default>`, so check out the silo branch in it) with: the brief, this file's row for that silo, "your branch already holds your earlier work, the last commit is an untested WIP commit: build and test first, then finish the *Left to do* column", and the environment notes (`JAVA_HOME` prefix, `npm install` if `node_modules` is missing).
3. Agent teams: `.claude/settings.local.json` (git-ignored, this machine only) sets `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`; teammates start through the Agent tool with a `name`. On another machine or account, set it again.
4. Merge in the suggested order, running every tier; push `main`; remove each finished silo's worktree and branches.

## Leftovers to clean up

- Locked worktree of finished silo H: `.claude/worktrees/agent-a359a5f851afb8573` (branch `silo/ui-h-harness`, merged). Remove once no agent holds it (`git worktree remove -f -f`), then delete the branch.
- Stale local branches `worktree-agent-*` (created by worktree isolation, all behind `main` with nothing of their own): delete with `git branch -d`.
- Silo worktrees under `.claude/worktrees/` (`silo-m`, `silo-o`, `silo-r`, `silo-s`, `agent-a4086e9a85853c0d3` for G, `agent-ab4f54de1cecfee07` for X): local to this machine; the branches on `origin` hold everything.
