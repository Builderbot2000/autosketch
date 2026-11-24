# Select silos (`18`): completion record and follow-ups

Written for whoever picks up work after `18`. Every step of this set (silos W, V, M, C, T, P, R, S and Z, steps W1 to Z3, plus the follow-ups V3, M4 and M5 that Z1's measurements raised) was done between 2026-11-22 and 2026-11-24, each merged into `main` by the lead. `18`'s *Implementation status* describes what was built, *Measured* the numbers behind the defaults, and [PROGRESS.md](PROGRESS.md) is the step-by-step log. This file keeps the state at completion and what the merges left open.

## State at completion (branch `silo/sl-z-measure-e2e`, step Z3, on `main` at `a89a309`)

Final run, 2026-11-24, on the Z3 branch (`main` at `a89a309` plus this step's doc changes; no code changed in Z3):

- `npm run typecheck` clean; `npm test` 1287 passed, 14 skipped (opt-in local and e2e tiers), 125 files passed, 6 skipped.
- `cd mod && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ./gradlew build test runGameTestServer`: build and JUnit pass, all 67 GameTests pass.
- `mod/clienttest.sh` (all suites) under `timeout 900`: 722 steps, passing on the second run. The first run failed two `candidates` steps (`CandidatesClientTests.previewHereDrawsTheGhostAtTheCrosshairAndTheMenuClearsIt` and `replyLineOpensTheScreenAndSubmitSendsThePicks`, 703 steps passed), both timing out with the wand's `work mode` line on the action bar where the test waited for its own: the same pattern as the C2 flake (*Known flakes*).
- e2e world tier against the Craftoria server (`~/servers/craftoria`, Craftoria 1.37.0, NeoForge 21.1.249, the jar built from this branch): 13 of 13 on the second run, `select.test.ts` included. The first run failed `scenarios.test.ts`'s kill-and-restart scenario (an MCP request timed out while the server restarted), which left `select.test.ts` with no server (`ECONNREFUSED` on RCON); a fresh start passed everything.

## What was built

`/autosketch select [text]` replaces `/autosketch scan`. The player names something in the world ("the mossy stone brick house", "this hill", or nothing: the crosshair block), and the agent finds it, works out its exact extent, agrees on it with the player, and sets the volumes from it, without building anything.

- **Wire (W1, W2).** Mode `select`; requests `search`, `fill`, `expand`; snapshot kinds `mask` and `coarse`; the select-mode read grant (block and surface snapshots anywhere within `selectChunks` of the chunk where the player asked, capped per call by `contextCap`); `ui.request` `choices.pick`; `ui.state` steady `fills`; proposed hits as `ui.flash` job `candidate`; volume outlines on relay op 4. Golden vectors both ways, and a fake host (`test/support/fake-select.ts`) answering it all with the mod's algorithms.
- **Mod reads (M1 to M5).** Material search by rings with `maybeHas`, clusters, `gap`/`stop`, `continue`; fill and expand with masks and frontiers (parity fixture shared with `{connected}`); mask and coarse snapshots. Every read inside the grant takes unloaded chunks from disk through the chunk storage's asynchronous I/O and decodes them off-thread (64 in flight, 5 ms of server time per tick); nothing is loaded, ticketed or generated. `/autosketch measure grant|last|slice` (console and RCON) gives a headless grant and the last read's costs.
- **Command and client (C1 to C3).** The command and its alias, choice lines clickable one per message (`/autosketch action <n>`), the candidate drawn as a steady tinted shell (edges within 64 blocks, faces beyond, through blocks), proposed hits pulsed, and work and context volumes drawn as wide lines visible at distance, particles kept only for clients without the UI channel.
- **MCP tools (T1 to T3, V1 to V3, P1 to P3, S1).** `world_search` (heat-map image, cluster text, `continue`; radius 64 unless given), `world_fill`, `world_expand`, `world_volumes({from: "candidate", margin?})`; the read-only world view beside the open document (`view: "world"` on `render`, `view_slice`, `raycast`, `select`, `analyze`; `world_view_read` by box, selection or surface; coarse 2³/4³ past `contextCap`, drawn one cube per cell); `render({fade})`; `world_reply({choices})` with typed numbers as the fallback; the candidate's shell and edges sent through the UI feed; the select mode and its event; the agent guide `library/knowledge/skills/select.md`. Unknown tool arguments are refused on every tool (S1).
- **Removal (R1).** Protocol 4, the first non-additive bump: mode `scan`, `prompt.scan` and feature `scan` gone; the MCP still speaks 3 (v3 vectors frozen); the `[scan]` config section dropped on first load.
- **Measured (Z1, M5) and end to end (Z2).** *Measured* in `18`; `test/e2e/world/select.test.ts` selects the mossy house among three original builds against the real mod, through search, choices, fill, expand, the faded render, a trim and confirmed volumes.

## How the work ran

As in the components set: **one fresh agent per step, never resumed or messaged** (`README.md`, *How to run this set*; the hook `.claude/hooks/no-silo-resume.mjs` blocks SendMessage to `sl-…`). The lead checked each step by running the tiers on the branch and reading `git log --stat`, merged with `--no-ff` and logged one line in `PROGRESS.md`. Five steps (M1, T2, C1, P2, Z1) were interrupted and restarted from a `WIP` commit; C3 hit a usage limit after committing and the lead rebased it. Parallel silos edited `18`'s and `13`'s status tables, so the lead merged rows by hand several times, and once restored rows an agent's amend had reverted (C1). Waves: 0 W1, V1; 1 M1–M3, C1, T1, P1, V2, W2; 2 T2, T3, C2, C3, P2, P3, Z1; 3 R1, S1, Z2, V3, M4, M5, Z3.

## Decisions taken during the work

All are recorded in `18` (beside each piece under *As built*, in *Measured* and *Decisions*) or in `13` and `05`; PROGRESS.md has one line per step.

- **Read grant (W1).** A square within `selectChunks` of the prompt's chunk, fixed when the prompt arrives, so the player walking doesn't move it; new errors `no_grant`, `too_large`.
- **Defaults (Z1).** `selectChunks` 256 as cap and grant; a search with no radius walks 64 (a miss costs about 1 s per 1,300 chunks with the player waiting); `gap` 2, `stop` 1, margin 8, coarse 2³ then 4³, 5 ms slices kept.
- **Follow-ups built in the set (Z1, M4).** One cube per coarse cell (V3: a 4³ overview took one to three minutes to render); grant blocks and mask snapshots (M4) and surface snapshots (M5) read off the server thread (cold at the cap 8.1 s became 0.15 s; cold surface over the generated square 48.6 s became 1.7 s).
- **Candidate (T2, T3, P3).** `world_fill` always replaces the candidate; combining goes through `select` with `{freeze:…}`. `world_volumes({from})` takes the candidate or any named world-view selection (a part); a shape over the cap is the mod's `bad_volumes`, answered as confirmed-as-a-selection with parts and sandboxes suggested. Confirming leaves the outline; it clears when the request ends (lead).
- **Choices (W2, P2, C1).** At most 9 (one digit on vanilla); a typed `/autosketch <mode> N` counts as the choice while an unanswered question has that many; choices may carry a box (`{text, at}`), pulsed once as a hit.
- **Strict arguments (S1).** Unknown arguments refused on every tool (`unknown_argument`); `view:"world"` on a mutating tool refused `world_view_read_only` instead of editing the open document.
- **Protocol 4 (R1).** Surface snapshots gated on feature `select`; `world_volumes({work})` needs a link, else points to `from: "candidate"` or `doc_open({world: true})`.
- **End to end (Z2).** The player is stood in for at the MCP's edge (select prompt and `prompt.close` dispatched on the bridge, clicks as `choices.pick`, the grant from `/autosketch measure grant`), as `17`'s Z1 did. It found that the select event and the skill wrote `{dilate:["candidate",8]}`, which the resolver refuses; both now say `{dilate:"candidate",by:8}`.

## Fixed at the end (Z3)

- `docs/briefs/world/test-setup.md` step 8 still described `/autosketch scan`; it now walks through `/autosketch select` by hand (choice lines, the outline near and far, confirmed volumes as lines), saying which parts the automated tiers already cover. The `/autosketch done` line there names select instead of scan. No other user-facing instructions in `docs/` or `README.md` still told people to use scan (`13` already marks every scan row retired).
- `18`'s *Status* line, *Implementation status* (every piece marked built, the follow-ups V3, M4, M5 with their own rows; piece 9's "mod GameTest not started" replaced by the end-to-end world test that covers it), and *Open questions* (none).

## Follow-ups

**Known limits left as they are**
- **Volume reads still load chunks on the server thread.** Blocks and surface snapshots inside the work and context volumes (not the select grant) take the old section loop and load unloaded chunks synchronously. Deliberate: the link keeps those chunks loaded, so the load doesn't happen in practice. Move them to the grant's disk path only if a measurement shows a cost.
- **`world_mod_outdated` for surface on a protocol-3 mod.** R1 gated surface snapshots on feature `select`, so an MCP paired with a protocol-3 mod that lacks `select` refuses surface reads with `world_mod_outdated`. Correct, but such a mod still had scan's surface reads; tell users to update the mod together with the MCP.
- **The second world `~/servers/craftoria/autosketch-measure`** (seed 1801, a generated 47 × 47 chunk square) is kept for re-measuring. `server.properties` points at `autosketch-e2e`; switch `level-name` to re-measure and back afterwards.

**Checks still to run**
- **By hand on the real Craftoria client** (`docs/briefs/world/test-setup.md`, step 8, *Select*): the command-to-`prompt` path, a real click through to the real MCP, and how the candidate outline and the volume lines read in a real world. The client suites cover these only against the fake MCP; the e2e world tier covers everything after the `prompt` with the player stood in for.

**Known flakes**
- **clienttest hung once in ghost-measure** (256³, unrelated to select; M2's run). Run `mod/clienttest.sh` under `timeout 900`; a rerun passed.
- **Timing tests flake under load**: the 1M-block encode and log latency bounds in `npm test`. Rerun the file alone.
- **The kill-and-restart scenario** (`test/e2e/world/scenarios.test.ts`) timed out once in Z3's run waiting on the restarted server, and the files after it then fail with `ECONNREFUSED`. Stop the server, start it fresh and rerun the tier.
- **Client steps that wait for an action-bar line** (`candidates`): the wand's mode line (`Autosketch wand: work mode`) can overwrite the line a step waits for. Seen in `ChoicesClientTests.choiceLinesSendTheirIndexOnClick` (C2's run; C3 hardened that one) and, in Z3's first run, in `CandidatesClientTests.previewHereDrawsTheGhostAtTheCrosshairAndTheMenuClearsIt` and `replyLineOpensTheScreenAndSubmitSendsThePicks`, which were not hardened. A rerun passed. Hardening them the way C3 did is a small test-side follow-up.

## How to run the tiers

From the repository (a worktree needs `node_modules` linked to the main checkout: the fake-MCP CLI test spawns `node_modules/.bin/tsx`):

```
npm run typecheck
npm test
cd mod && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ./gradlew build test runGameTestServer
JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 timeout 900 mod/clienttest.sh
```

The e2e world tier needs the Craftoria server (`~/servers/craftoria`, EULA accepted) and the mod jar built by the gradle step. Check first that nothing else runs a server (`pgrep -a java | grep unix_args`):

```
test/e2e/world/server.sh start ~/servers/craftoria      # copies the built jar into mods/
test/e2e/world/server.sh wait ~/servers/craftoria 600
AUTOSKETCH_E2E_SERVER=~/servers/craftoria \
AUTOSKETCH_E2E_INSTANCE=/mnt/c/Users/kevin/curseforge/minecraft/Instances/Craftoria \
  npm run test:e2e-world
test/e2e/world/server.sh stop ~/servers/craftoria
```

- **The e2e world tier skips silently** unless both variables are set: a run without them reports the files as skipped, not failed. Check the count.
- **Don't export them for a plain `npm test`**: the e2e files then run with no server up and fail with `ECONNREFUSED`. Set them on the `test:e2e-world` command line only.
