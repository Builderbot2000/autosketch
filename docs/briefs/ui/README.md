# Work briefs: in-game UI (`16`)

One brief per workstream in `16`'s *Work plan*, as of commit `6d169d8` (2026-11-17). Each team reads the main [briefs README](../README.md) first (its rules for branching, file ownership, code style and *Done means* all apply), then the [world README](../world/README.md)'s rules where it touches `src/world/` or `mod/`, then this README, then its own brief, then `16` and the sections of `13` the brief cites. `16` is the source of truth. A brief only scopes, sequences and assigns files.

**Silo letters are the stream letters in `16`'s work plan**, so a brief and the spec name the same thing. Several collide with earlier sets (C, G, L, O, R, S, X); in this set they always mean the `16` streams. Branches are named `silo/ui-<letter>-<slug>` so they never collide with the old ones.

| Silo | Brief | Wave | Side | Depends on |
|---|---|---|---|---|
| C | [Contracts](C-contracts.md) | 0 | both | — |
| H | [Client test harness](H-harness.md) | 0 | mod, test | — (uses C's fake MCP once it lands) |
| L | [Offline lock](L-offline-lock.md) | 0 | mod | — (lands early: it changes how every mod test marks volumes) |
| M | [MCP UI core](M-mcp-ui-core.md) | 1 | MCP | C |
| O | [Overlays and HUD](O-overlays-hud.md) | 1 | mod | C, H |
| G | [Ghosts](G-ghosts.md) | 1 | mod | C, H |
| R | [Replay in the world](R-replay.md) | 1 | mod | C, H |
| S | [Screens, menu, key bindings](S-screens.md) | 1, then 2 | mod | C, H; G's block drawing for the 3D preview (wave 2) |
| X | [Removal and CLI](X-removal-cli.md) | 2 | MCP, docs | M's move of `model.js` and `replay.js` |

**Status (2026-11-17):** the work stopped mid-wave and moved to another session. See [HANDOFF.md](HANDOFF.md) for where every silo stands.

```
wave 0 (contracts, harness, lock)    wave 1                                   wave 2
C: schemas, vectors, codecs, ───┬──► M: move, feed, ghosts, frames, requests ─► X: removal, CLI, docs
   relay channel, fake MCP,     ├──► O: volumes, flashes, HUD
   client skeleton              ├──► G: block drawing ─────────────────────────► S: 3D preview
                                ├──► R: overrides, camera, controls
                                └──► S: menu, keys, settings, library lists
H: clientTest run, driver ──────────► (O, G, R, S write their client tests on it)
L: lock, status, link state ────────► (everyone's mod tests connect a fake MCP)
```

**Why this split.** As in the world set, the two sides meet only at the protocol, so C freezes the protocol first and both sides build against it: the MCP (M) against the fake host with the `ui` feature, the mod (O, G, R, S) against the golden vectors and a fake MCP. On the mod side the client half splits by feature, each owning its own package and its own client tests, because the features share nothing but the client skeleton C lands (message dispatch, toggles, key mappings) and G's block drawing, which only S's preview reuses. L and H touch no `ui` message and start on day one; L lands early because it changes every existing mod test that marks a volume without an MCP connected, and every new client test is written against the lock.

**Principles every team keeps** (`16`, *Principles*): nothing drawn is returned to an agent; the client draws and asks, the MCP computes; one data path through the bridge; UI traffic never slows an op and never touches the server's world.

## Cross-silo contracts

The owner lands the contract in its first merge, and the users code against it.

| Contract | Owner | Users | Shape |
|---|---|---|---|
| `ui` feature and message schemas | C | M, O, G, R, S | `13` *Wire format*: `ui` in both hellos' `features`; `ui.state`, `ui.flash`, `ui.ghost`, `ui.ghost.clear`, `replay.frame`, `ui.request`, `ui.result`, each naming its players; golden vectors in `test/data/world-protocol/`; both codecs |
| `ui.request` kinds | C (names and shapes), M (behaviour) | S, R, G | One table in `13`: settings list/set/unset, library list/entry/thumbnail/preview/rename/duplicate/delete/restore/hide/copy/empty-trash, logs list, replay open/seek/close, ghost anchor. Errors as fixed codes |
| Fake host with `ui` | C | M | `test/support/fake-host.ts` lists `ui`, records `ui.*` and `replay.*` it receives, and can send `ui.request` as a player (`playerUiRequest(player, request)`) |
| Fake MCP | C | H, O, G, R, S, L | `test/support/fake-mcp.ts`: reads a pairing file, connects to the real mod's bridge, does `hello` with chosen features, sends scripted `ui.*`/`replay.*` messages, answers `ui.request`s from a table, records everything. Runnable as a library (vitest) and as a CLI the client harness starts |
| Relay and packet channel | C | O, G, R, S | Server half: one NeoForge payload channel, optional on the client, forwarding by player, splitting bodies over ~1 MiB into numbered parts. Client side: `UiClient.register(kind, handler)`, so each silo adds its handler without editing C's files |
| Client skeleton | C | O, G, R, S, L | In `mod/neoforge/.../client/ui/`: `UiClient` (dispatch), `UiToggles` (HUD, volumes, flashes, ghosts; read by O and G, written by S's menu and the toggle keys), `AutosketchKeys` (every mapping in `16`'s table, category `key.categories.autosketch`, replay keys in a replay-only `IKeyConflictContext`; silos attach actions, never add mappings elsewhere), `LinkState` (L writes, everyone reads) |
| Link state to the client | L | O, G, R, S | A mod-internal payload on C's channel: `offline`, `too_old` (MCP without `ui`), `connected`. Every client feature checks `LinkState` before drawing or sending |
| Block drawing | G | S (3D preview) | `client/ui/blocks/`: draw a palette-plus-positions region with the game's block renderer, model only (no block-entity renderers), tint and alpha as parameters, usable both in the world and in a screen |
| Client test driver | H | O, G, R, S, L | `mod/neoforge/src/gametest/.../client/`: `ClientTestSuite` with `step`, `waitUntil(condition, timeout)`, key and scroll helpers, screenshot with tolerance, the fake MCP started per suite. One `clientTest` run, one boot per suite |
| Session model and replay planner in TS | M | X | `src/observe/session-model.ts`, `src/observe/replay.ts`, with their tests moved. X deletes `viewer/` only after this lands |

## Contested files

| File | Who touches it | Protocol |
|---|---|---|
| `docs/design/13-live-world.md` | C (*Wire format*, *Versions and features*), L (lock in *Companion mod requirements*), X (pointers to `16`) | Each edits only its own sections. C's lands first |
| `src/world/protocol/**`, `test/data/world-protocol/**`, `test/support/fake-host.ts` | C, then M (bug fixes only) | C owns them. M asks C (or the user) before changing a schema |
| `mod/common/.../protocol/**`, `mod/common/.../bridge/**` | C (codec, `ui` feature, relay), L (link-state hooks) | C's codec lands first; L's hooks are additive |
| `mod/neoforge/.../client/AutosketchClient.java` | C (wires the skeleton), then nobody | Silos register through C's `UiClient` and `AutosketchKeys`, not here |
| `mod/neoforge/.../client/ui/AutosketchKeys.java` | C (declares), O, G, R, S (attach actions) | Additive, one block per silo |
| Command registration (`…/command/`) | L (lock and `status`), G (`ghost`), R (`replay`) | Through the existing command hook; additive |
| Mixin configs | R (client block-update mixin), L (none expected) | R adds a separate client mixin config, never edits the common one |
| Existing GameTests and `test/e2e/world/**` | L | L alone, in its first merge: tests that mark volumes connect a fake MCP first. Others rebase on it |
| `mod/neoforge/build.gradle` | H (`clientTest` run), C (none expected) | H only |
| `.github/workflows/mod.yml` | H (client job) | H only |
| `src/observe/**`, `viewer/**` | M (moves, reduces `http.ts`, `guard.ts`), then X (deletes) | M first; X starts after M's move merges |
| `src/server/index.ts` | M (wires `src/ui/` to the bridge), X (removes `ui`, `observe`; automatic instance choice) | M's wiring lands first; X's changes are removals plus the instance message |
| `docs/briefs/release/README.md` | X | Its *Release gate* names K's U4 wizard; X replaces that with automatic instance choice |

## Rules for this set

- **The client half stays thin.** If a client feature needs to decide something about scopes, steps, settings or the library, the decision belongs in M and travels in a message. Raise it in the merge request rather than computing it in Java.
- **Every client feature checks `LinkState`** and draws nothing and sends nothing unless it is `connected` (`16`, *Mod side*).
- **Never reference client classes from the server half** or from `mod/common`. Dedicated servers and vanilla clients must keep working: run the existing `runServer` and the vanilla-join GameTest before each merge.
- **Client tests run headless** on H's harness (`xvfb-run`, `LIBGL_ALWAYS_SOFTWARE=1`) and wait on conditions, never fixed tick counts. Assert on state first; screenshots only where `16`'s *Testing* says state can't prove it.
- **Version-sensitive code stays in `mod/neoforge`** (rendering, GUI, key mappings, mixins). Comment each call that 1.21.x changed, so the next port knows where to look.

## Done means (in addition to the main README's)

- `npm run typecheck`, `npm test`, `cd mod && ./gradlew build test runGameTestServer` and (from wave 1) the `clientTest` run pass.
- `16`'s *Implementation status* gains a row per feature, marked as built. Add the table in C's first merge.

## Setup the user has done

- JDK 21 is the default `java` (`/usr/lib/jvm/java-21-openjdk-amd64`), but the login shell may still export `JAVA_HOME` as JDK 11, which Gradle refuses: run Gradle as `JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ./gradlew …` unless `echo $JAVA_HOME` already shows 21; Xvfb, `xvfb-run` and Mesa (software and `d3d12`) are installed; WSLg provides a display (`DISPLAY=:0`) for watching a run. Checked 2026-11-17.
- `xdotool` is installed (2026-11-17), for `16`'s one test with true OS input; H still skips that test with a message when `xdotool` is missing (CI, other machines).
- The Craftoria server pack is at `~/servers/craftoria` (`world/test-setup.md`), for the occasional Craftoria-sized client run.
