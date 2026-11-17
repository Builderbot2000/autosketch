# 16 — In-Game UI

Every operation the player does moves into the game, and the browser UI (`12`'s live viewer, `15`'s management UI) is removed. The command line keeps startup and anything outside the game: installing, choosing the instance, configuration with no game running. Inside the game, the companion mod's client half shows what the agents are doing in the world itself (work volumes, edits, sandboxes before merge, replay), and gives the player screens for settings and the library.

Status: designed with the user 2026-11-17 (*Decisions*); nothing built. Supersedes `15` entirely and `12`'s *Live viewer* section. The event log, deltas, snapshots and replay data in `12` stay; only the browser that read them goes.

## Principles

1. **For the human, never the model** (from `12`). Nothing drawn in the game is returned to an agent, and no tool reads it.
2. **Thin client.** The MCP computes everything: what to draw, replay state at a step, the scope tree, token totals, settings rows, library listings. The client half draws boxes, blocks and text, and turns input into requests. Logic stays in tested TypeScript, and the Java that has to be ported with each Minecraft version stays small.
3. **One data path.** MCP ↔ the existing bridge ↔ the mod's server half ↔ the mod's own custom packets ↔ the client half. No second connection, no token handed to the client, no HTTP API for the client. In singleplayer the server half and client half run in the same game, so the last hop costs almost nothing.
4. **Local only.** The MCP runs on the player's machine (`13`, *Connection*), for security. Nothing here is designed for remote servers.
5. **Never slows the build** (from `12`). UI messages are built off the tool-call path, coalesced and rate-limited. A client that falls behind is dropped and resyncs from current state; ops never wait for it.
6. **Never touches the world.** Overlays, ghosts and replay exist only on the client. The server's world changes only through patches, as now.
7. **Files stay the source of truth** (from `15`). Settings and library screens edit `~/.autosketch/config.toml` and the library folders through the MCP, exactly as `autosketch config` and a file manager would.

## What goes, what stays, what moves

Measured 2026-11-17.

| Code | Fate |
|---|---|
| `viewer/` page, 3D view, panels, tabs, CSS (about 2,100 of 2,915 lines) | **Removed** |
| `viewer/js/model.js` (session model: scope tree, feed, spend; 492) | **Moved** to `src/observe/session-model.ts`, tests kept |
| `viewer/js/replay.js` (replay planning; 149) | **Moved** to `src/observe/replay.ts`, tests kept |
| `viewer/js/voxels.js` (WebGL meshing) | **Removed**; the game meshes blocks itself |
| `src/observe/http.ts` (519) | **Reduced** to the OTLP receiver `/v1/logs` (`13`, B3): Claude Code's telemetry export can only post over HTTP. `observe.http` keeps its meaning (the port) |
| `src/observe/guard.ts` | **Reduced** to refusing foreign `Origin`s and `Host`s on `/v1/logs`. The write token and the write checks go: nothing writes over HTTP any more |
| `src/observe/atlas.ts`, `open.ts`, `instance-api.ts`, `src/server/instance-host.ts`, `src/server/ui-command.ts` (`autosketch ui`) | **Removed** |
| `src/observe/settings-api.ts`, `library-api.ts`, `src/server/library-host.ts` | **Rewritten** as bridge request handlers (*MCP side*); `core/settings.ts`, `library/manage.ts` and `library/roots.ts` are reused unchanged |
| `observe.open` | **Removed**; a value in `config.toml` is reported as unknown, as any unknown key is |
| The `three` dependency and `/vendor/three/` | **Removed** |
| Event bus, log, deltas, state table, reader, snapshots | **Unchanged** |

The browser parts can be deleted at any time: nothing else depends on them. Only the two moved files must move first.

## Command line (startup and outside actions)

- **Instance choice is command-line only.** `autosketch instances` lists candidates; `autosketch setup --instance <id|path>` saves one; `autosketch config set|unset` edits any setting. These exist today ([src/server/index.ts](../../src/server/index.ts)).
- **No setup wizard.** With no instance saved, the server picks one automatically when exactly one candidate is found, preferring games that wrote a pointer file (`14`, *Instance discovery*), and says so on stderr and in the first tool result. Otherwise the first tool result lists the candidates and the `autosketch setup` command, for the agent to pass on to the user.
  - *Built* (silo X): only candidates that can be loaded count, and "preferring" means that when one or more of them have a pointer file, only those are considered (so one modded game with the mod beats any number of plain installs; two with the mod are listed). A launcher's candidate counts as having a pointer when the mod's pointer file names its game folder (`Candidate.pointer`). The automatic choice is loaded in place but **not saved** to `config.toml`: the note gives the `setup` command to keep it, so a second instance appearing later is listed rather than silently passed over for the first. Reason: `config.toml` holds only what the user chose. A tool call that arrives while discovery is still running gets the note as its `not_configured` answer ("loading now: call the tool again") instead of a list.
- **`autosketch observe <path>` is removed.** Finished logs are replayed in game through the running MCP (*Replay in the world*). With no MCP running, every in-game UI feature is locked (*Mod side*).

## Architecture

```
MCP (TypeScript)                         mod, server half (Java)          mod, client half (Java)
 event bus ─► session model ─► UI feed ──┐
 replay planner ─► replay frames ────────┤  bridge (TCP, token)
 settings / library handlers ◄──────────►├──────────────► relay ──custom packets──► draw lists, ghosts,
                                         │               (per player,              replay overrides,
 ◄── UI requests (seek, save, rename) ───┘                allowlisted)             HUD, screens
```

### MCP side

A new module, `src/ui/`, owns everything sent to the game for display and everything the game asks for:

- **Feed.** Subscribes to the event bus and keeps the session model. It produces coalesced state for the overlays: open jobs with their work and context volumes in world coordinates and their briefs; change boxes to flash; current request and mode; token totals; refusals. It sends a full state on connect and on resync, then changes, at most a few times a second.
- **Ghosts.** For a sandbox before merge: its blocks in base-document coordinates, from the scope document. For an unlinked document: its blocks at an anchor the player chose. Sent as block-state regions, reusing the snapshot body encoding (`13`, *Binary bodies*), and updated from `doc.op` deltas.
- **Replay.** The replay planner (moved from the viewer) plus a frame builder: the states of the replayed volume at step S as a keyframe, then forward deltas, and the job volumes and HUD text at that step. It reads any session log in the workspace, not just the live one.
- **Requests.** Settings (list rows, set, unset, with the compare-and-set hash from `15`), library (list, entry detail, thumbnail PNG, preview voxels, rename, duplicate, delete, restore, hide, copy, empty trash), log list, replay open, seek and close, ghost anchor. Each request runs the same core code the HTTP endpoints called.

### Wire additions

Feature-gated within protocol 3, as `prompt.close` was (`13`, *Versions and features*): the MCP lists `ui` in its hello's `features`, the mod lists `ui` in its own. Without both, nothing below is sent, and the game behaves as today. The exact schemas go into `13`'s *Message schemas*, with golden vectors, in the contracts work (*Work plan*).

| Direction | Message | Purpose |
|---|---|---|
| MCP → mod | `ui.state` | Overlay state, full or changed: jobs, volumes, briefs, request, mode, tokens. Id-less, coalesced |
| MCP → mod | `ui.flash` | Boxes that just changed, with the job's colour |
| MCP → mod | `ui.ghost` (body) / `ui.ghost.clear` | Ghost block regions, by ghost id |
| MCP → mod | `replay.frame` (body) | Keyframe or deltas for the replayed volume, plus volumes and HUD text at the step |
| mod → MCP | `ui.request` | A request from the player's client, with a request id: settings, library, logs, replay open, seek and close, ghost anchor |
| MCP → mod | `ui.result` (body when binary, such as thumbnails and previews) | The answer to a `ui.request`, by id |

The mod has only ever sent requests one way (MCP to mod) until now. `ui.request` and `ui.result` carry their own ids so they never mix with the MCP's request ids.

### Mod side

- **Server half: a relay.** The allowlist lives on the MCP (`world.promptPlayers`, `13`, *Allowed players*), so every `ui.*` and `replay.*` message names its players, and the server half forwards it to those players whose clients registered the channel. It forwards those clients' requests to the bridge with the player's UUID, and the MCP refuses requests from players not on the allowlist. Custom packets sent to the client are limited to about 1 MiB, so large bodies (ghost regions, keyframes) are split into numbered parts and joined on the client. It keeps no UI state of its own, except to resend the last full `ui.state` when a player joins.
- **Client half: draws and asks.** It keeps the latest draw state, meshes ghost regions and draws them, applies replay overrides, draws the HUD and screens, and turns key bindings and screen actions into `ui.request`s. It holds no logic about scopes, steps or settings.
- **The whole mod is locked while the MCP is offline.** Using the mod means running the MCP, so with no bridge connection the mod does nothing for the player: the client half draws nothing (no overlays, ghosts, HUD or volume outlines); the wand, air mode, the `/autosketch` volume, request, scan, replay and ghost commands, the key bindings and the menu all answer with one action-bar line saying the Autosketch MCP isn't connected. Volumes already marked are kept in the player's saved data, shown and editable again when the MCP connects. What keeps running is only what lets the MCP connect and the player check on it: the bridge listening, the pairing and pointer files, the mod's config screen and `/autosketch status`. The server half tells the client the link state when it changes and when the player joins.
- **An MCP that is connected but older** (no `ui` feature in its hello) keeps today's features working (`13`), and only the in-game UI from this document is locked, with an action-bar line saying the MCP is too old.
- **Clients without the client half** (a vanilla client) get none of this and lose nothing they have today.

## Features

All in the client half, each drawing what the MCP sent.

### Autosketch menu and key bindings

One key opens the **Autosketch menu**, a small hub screen with the toggles (HUD, job volumes, change flashes, ghosts), *Settings*, *Library*, *Replay* (the log list) and *Ghost here*. Every feature is reachable from it, so nothing else needs a default key.

Bindings follow the usual practice for mods used in large packs: their own category (`key.categories.autosketch`), one default key, the rest unbound for players to bind, and keys that only matter in one mode active only in that mode (NeoForge `IKeyConflictContext`), so they never conflict with anything else. Checked against Craftoria's `options.txt` on 2026-11-17, where every letter key is already bound, most several times, and Left Alt carries 16 bindings.

| Binding | Default | Active |
|---|---|---|
| Open Autosketch menu | `Home` (free in Craftoria; navigation keys don't move between keyboard layouts as letters and punctuation do) | in game |
| Toggle HUD, toggle job volumes, toggle change flashes, toggle ghosts | unbound | in game |
| Open settings, open library, open replay list | unbound | in game |
| Replay: step back / forward | `←` / `→` (scroll also steps) | replay only |
| Replay: play / pause | `Space` | replay only |
| Replay: slower / faster | `↓` / `↑` | replay only |
| Replay: previous / next marker (fork, merge, refusal, checkpoint) | `Page Up` / `Page Down` | replay only |
| Replay: close | `Backspace` (`Esc` keeps opening the pause menu) | replay only |

The player is frozen during replay, so its keys can reuse movement-adjacent keys without taking anything from normal play.

### Overlays in the world

- **Job volumes:** a line box per open job's work volume in its colour, with the brief as a label facing the camera; context volumes as dashed boxes. They appear at fork and leave at merge or abandon.
- **Change flashes:** a short pulse on boxes the agent just changed, in the job's colour, so edits behind the player are noticed.
- **The player's own volumes** keep today's outlines (`13`).
- Drawn through blocks where useful, toggled with a key binding.

### HUD

A small corner panel, toggled with a key binding: the open request and its mode, open jobs (count and the newest briefs), the last refusal, and token totals for the current prompt (`13`, B3). One line when collapsed. It replaces nothing: the activity lines in chat (`13`, *Prompting from the game*) stay.

### Ghost blocks

Translucent blocks drawn with the game's own block renderer, so modded blocks look right (the browser's baked atlas never handled custom renderers):

- **Sandbox preview:** a job's blocks where they will land, before merge, in the job's colour tint.
- **Unlinked documents:** a document that isn't linked to the world, shown at an anchor the player sets (`/autosketch ghost here`, or the wand), to judge size and fit before exporting or linking.
- Meshed per 16³ section and re-meshed only where deltas land. Blocks with block-entity renderers draw their block model only (*Decisions*).

### Replay in the world

The timeline plays in the world instead of on a chart:

- **Open:** `/autosketch replay` lists the workspace's session logs, newest first; `/autosketch replay <log>` or the live session opens one. The replayed volume is the base document's footprint in the world (linked documents) or a ghost anchor (logs of unlinked documents).
- **Showing step S:** the client overrides every block in that volume in its own copy of the world (a frame starts from a keyframe of the whole volume). The server's world is untouched. On close, the server half resends those chunks to the client, so it shows exactly the server's state again with nothing to keep track of.
- **Live updates are ignored during replay.** The server's world keeps changing while the player watches (an agent still building, fluids, crops, redstone), and the server sends those changes to the client, into the same copy replay draws in. While replay is open, the client drops block updates from the server inside the replayed volume (a small client mixin on the block-update and section-update packets; the mod already uses mixins). Nothing is lost: the chunk resend on close brings the client up to date. Chunks that load inside the volume during replay get the frame reapplied.
- **Camera:** the client detaches the camera and freezes the player, so collisions with blocks that exist only on the client can't push the player around. No game-mode change.
- **Controls:** scroll or keys to step, play/pause, speed, jump to the next fork, merge, refusal or checkpoint. A HUD strip shows the time, the step's tool call and job brief, with ticks for forks, merges and refusals.
- **The scope tree in space:** at each step, open jobs' volumes are drawn as in *Overlays*, and each step's edits flash in their job's colour. That replaces the timeline chart, the scope tree panel and the activity map.
- **Gaps:** steps with no deltas (capped or off, `12`) fall back to the nearest time-lapse snapshot as a HUD message, since a snapshot image can't be shown as blocks.

### Settings screen

Generated from the MCP's settings rows (group, summary, control, bounds, options, value, source, what a launch value overrides, restart needed), as `15`'s tab was. Toggle, cycle, number field with bounds, list editor, text field. Save sends the hash and reloads on a conflict. The mod's own config screen (Cloth Config) stays separate and is linked from it.

### Library screen

Roots with counts, per-kind lists filtered by text and `tag:`, prefab thumbnails in a grid (PNGs from the MCP, loaded as textures), flags for origin, overrides, shadowed and hidden, and the actions in *MCP side*. The detail pane shows metadata or text and a **3D preview**: the prefab's blocks drawn with the game's block renderer in the screen, with an orbit camera. The preview shares its block drawing with ghosts.

## Testing

### MCP (TypeScript)

- The session model and replay planner keep their tests after the move.
- New unit tests for the feed (coalescing, resync, job colours), ghost regions from scope documents and deltas, replay frames (keyframe plus deltas equal the replayed grid at every step), and every `ui.request` handler.
- Golden vectors for every new message, both codecs, as for the rest of the protocol. The fake host gains the `ui` feature.

### Mod, server half (GameTests)

Relay: forwarded only to the named players with the channel; large bodies split and joined in order; requests forwarded with their ids; chunks resent on replay close; nothing sent without the feature.

### Mod, client half (real client, headless)

No client test framework exists in NeoForge 21.1.249 (its GameTests run only on the server), but NeoForge runs a real client headless in its own CI (`SelfTestClient`: wait for the loading screen to go, write a report file, `Minecraft.stop()`). The harness copies that pattern:

- **Run:** a `clientTest` run in [mod/neoforge/build.gradle](../../mod/neoforge/build.gradle) with `client()`, the existing `gametest` source set, `--quickPlaySingleplayer <test world>`, and a report path; launched under `xvfb-run` with Mesa software rendering (`LIBGL_ALWAYS_SOFTWARE=1`). The test code never ships in the released jar.
- **Driver:** a client tick listener that runs steps and waits for conditions, never fixed tick counts. A suite shares one client boot.
- **The MCP end:** the TypeScript fake host plays the MCP over the real bridge, sending UI state, ghosts and replay frames and answering requests.
- **Input:** `KeyMapping.click` and `KeyMapping.set` go through the same path as real input (a left click into the air reaches `CommonHooks.onEmptyLeftClick`); scrolling goes through `ClientHooks.onMouseScroll`, which posts the same event the mouse handler does. One test may use `xdotool` on the virtual screen for true OS input.
- **Assertions:** mostly on state: the draw list, the override map in replay mode, widgets after an action, the request sent over the bridge, and the server's state through the integrated server in the same process. Pixel checks only where state can't prove it (a ghost is visible, an outline draws through blocks), with `Screenshot.takeScreenshot` and a tolerance; reference images are tied to a Mesa version.
- **Also covers the existing manual checklist** (`docs/briefs/world/test-setup.md`): air mode's left click, scroll distance and outline; `/autosketch done` and its notice; a vanilla client joining a local dedicated server running the mod.
- **Environment:** the dev machine (WSL2) already has Xvfb, `xvfb-run` and Mesa's OpenGL drivers (software and `d3d12`), and WSLg provides a display for watching a run. Checked 2026-11-17.
- **CI:** a job installing Xvfb and Mesa on the Ubuntu runner, on the dev profile. A Craftoria-sized client (532 mods) runs occasionally, not on every change.
- **Timings** (Mesa llvmpipe software rendering, measured 2026-11-17). Dev machine (WSL2, Gradle daemon warm, assets downloaded): the loading screen is gone 10.4–10.8 s after the JVM starts, the world is ready at 11.2–14.2 s (14.2 s when the flat test world is created), and the first step runs at 11.4–14.4 s; `mod/clienttest.sh` takes 16–24 s end to end for the `basics` suite (45 steps). CI runner: not measured yet (the job hasn't run); its uploaded `report.txt` carries the same `TIME` lines. Craftoria-sized client: not measured (see the harness row in *Implementation status*).

Every entry point the harness needs is public; no mixin, reflection or access transformer. Line numbers and some calls will change between versions, so the harness is ported with the client half.

## Cost

Measured and estimated 2026-11-17. About 3,500 lines of JavaScript and TypeScript go (*What goes, what stays, what moves*); the client half (103 lines today) grows by an estimated 3,000 to 5,000 lines of Java. The MCP side and the security surface get simpler. The cost that remains is the client half's rendering and GUI code: it changes more between Minecraft versions than anything else the mod uses (1.21.x alone reworked both), so it is ported with each target and loader. The thin client keeps that code to drawing only.

**Measured after the removal** (silo X, 2026-11-17; the first step, before M reduces `http.ts`): 3,940 lines deleted and 46 added: `viewer/` 2,915 (its `model.js` and `replay.js` already ported to TypeScript by M), `src/` 499 (`offline.ts`, `ui-command.ts`, `instance-host.ts`, the `observe` and `ui` subcommands, the wizard and browser opening, `observe.open`), tests 524 (of removed code only). One runtime dependency removed (`three`, about 23 MB installed, which was most of the MCPB bundle's 15 MB). `npm pack`: 503.3 kB packed, 1.79 MB unpacked, 230 files before; 457.3 kB, 1.64 MB, 215 files after. Still to go once M has rewritten them: `atlas.ts`, `open.ts`, `instance-api.ts` (imported by `http.ts` and `library-api.ts`), `voxels.ts`'s viewer endpoints, and `http.ts`'s routes beyond `/v1/logs`.

## Work plan

Workstreams run in parallel. Only the contracts come first, and they are small: everything else codes against them.

| Stream | Scope | Side | Needs |
|---|---|---|---|
| **C. Contracts** | `ui` feature on both hellos; message schemas in `13`; golden vectors; both codecs; fake host; the relay's packet channel and splitting | both | — |
| **H. Client test harness** | `clientTest` run, driver, fake host wiring, first test (air mode left click sets corner 1), CI job; time a boot with software rendering, here and on the CI runner, and record it | mod | — |
| **M. MCP UI core** | `src/ui/`: move session model and replay planner, feed, ghost regions, replay frames, request handlers; `http.ts` and `guard.ts` reduced to OTLP | MCP | C |
| **O. Overlays and HUD** | job volumes, flashes, HUD | mod | C |
| **L. Offline lock** | gate the wand, air mode, commands and outlines on the bridge connection; `/autosketch status`; link state to the client; existing GameTests and e2e scenarios that mark volumes without a connected MCP connect a fake one first | mod | — |
| **G. Ghosts** | block drawing shared with the preview; section meshing; sandbox and anchored-document ghosts; `/autosketch ghost` | mod | C |
| **R. Replay** | client overrides, chunk resend on close, detached camera, controls, HUD strip, `/autosketch replay` | mod | C; G's block drawing is not needed |
| **S. Screens** | Autosketch menu and key bindings, settings screen, library screen, thumbnails, 3D preview (uses G's block drawing) | mod | C; G for the preview only |
| **X. Removal and CLI** | delete the browser code and `three`, `autosketch ui`, `autosketch observe`, `observe.open`; automatic instance choice and its messages; update `12`, `13`, `14`, `15`, `README.md` | MCP, docs | M has moved the two viewer files |

Every stream lands with its tests: TypeScript units and vectors for C and M, GameTests for the relay, client tests for O, G, R and S.

```
C contracts ─┬─► M MCP UI core ──────────┐
             ├─► O overlays, HUD ────────┤
             ├─► G ghosts ──► S preview  ├─► done
             ├─► R replay ───────────────┤
             └─► S screens ──────────────┘
L offline lock (from day one, independent)
H harness (from day one, used by O, G, R, S)
X removal (once M has moved model.js and replay.js)
```

## Implementation status

| Feature | Stream | Status |
|---|---|---|
| Offline lock, link state, `/autosketch status` (`13` M14) | L | Built. One check in `mod/common/.../link/Link.java`: `requireConnected` (today's features) and `requireUi` (this document's), each sending the one action-bar line (`OFFLINE_LINE`, `TOO_OLD_LINE`) and returning false; the status (`LinkStatus`) comes from the bridge's session and its hello's `features`. `Link.lock` wraps every `/autosketch` subcommand except `status` (and the request alias root) once all extensions have registered, so a new silo's subcommand is locked offline without code of its own; console and RCON get the line as a command failure. The wand's clicks stay cancelled but only show the line; air clicks likewise; volume outlines, the mode line and the air preview particles aren't drawn while offline. Volumes are kept in memory across a disconnect (they were never saved with the world) and re-sent in the next hello's `volumes`. The status goes to clients on bridge connect and disconnect and on join (`Platform.sendLinkStatus`); sent as op `LINK` on C's `autosketch:ui` channel (`UiNetwork.send(player, UiPayload.link(...))`) into the client's `client.ui.LinkState`, which the air-mode client half reads (the interim `autosketch:link_state` payload is gone, folded in by C). GameTests: `LinkGameTests` (every locked command, the wand and air offline; volumes across a disconnect; an MCP without `ui`; statuses sent to the client); existing tests connect a `FakeMcp` first. Client test: `LinkStateClientTests` on H's harness. |
| `ui` feature, message schemas, golden vectors (`13`, *In-game UI*) | C | Built. `ui` on both hellos, within protocol 3; `ui.state` (full or changes: whole job records replaced by id, `seq` with a client-sent `resync` on a gap), `ui.flash`, `ui.ghost` (whole 16³ sections of a local grid with an origin), `ui.ghost.clear`, `replay.frame` (keyframe or forward delta from `from`), `ui.request`/`ui.result` (paired by `request`, no `id`; one table of request kinds; error codes `not_allowed`, `conflict`, `not_found`, `bad_request`, `busy`, `internal`); 250 ms coalescing; one player set for overlays. 18 new vectors plus `relay-parts` (a frame over 1,000,000 bytes and its parts, given by a rule); `hello-mcp` and `hello-mod-singleplayer` list `ui`. |
| TypeScript codec, fake host with `ui`, fake MCP | C | Built. `src/world/protocol/` (types, codec, states-only region bodies); the bridge sends `ui` messages only when both hellos list `ui` (`BridgeConnection.ui`), and its default hello leaves `ui` out until M's handlers answer requests (`BridgeOptions.features`). `test/support/fake-host.ts` records `ui`/`replay` messages and has `playerUiRequest`. `test/support/fake-mcp.ts`: library and CLI (`--pairing --script [--record] [--exit-on-close]`, script `hello`/`send`/`replies`/`results`), tested against the fake host. Tests: `test/unit/world/protocol-ui.test.ts`, `fake-mcp.test.ts`. |
| Java codec, relay, client skeleton | C | Built. `mod/common/.../protocol/UiMessages.java` (JUnit against every vector, and `relay-parts`); `mod/common/.../ui/relay/` (`UiPayload`: the one optional `autosketch:ui` packet, ops frame part, request, link state; `UiRelay`: forwards to named players with the channel, splits at 1,000,000 bytes, numbers and routes requests, keeps only the last full `ui.state` per player, `addResultListener` for R's chunk resend); `mod/neoforge/.../ui/UiNetwork.java` (registration, transport). Client skeleton in `mod/neoforge/.../client/ui/`: `UiClient` (joins parts, dispatches by type through `register`, a logging handler until features register, `request` with result callbacks), `UiToggles`, `AutosketchKeys` (every mapping in the key table, replay keys in a replay-only conflict context, actions attached with `on`, presses locked unless `LinkState` is connected), `LinkState`. GameTests `UiRelayGameTests`: only the named player with the channel gets a `ui.state`; a 3 MiB ghost arrives as four ordered parts; a request reaches the fake MCP with the player's UUID and its result returns under the client's number; a join resends the last full state; nothing is relayed without `ui`. Not yet: a client test of the skeleton on H's harness. |
| Client test harness (*Testing*, client half) | H | Built. `runClientTest` in `mod/neoforge/build.gradle` (client, gametest source set, `--quickPlaySingleplayer autosketch-clienttest`, game directory `run/clienttest`); `mod/clienttest.sh [suites]` runs it under `xvfb-run -a` with `LIBGL_ALWAYS_SOFTWARE=1` and exits non-zero unless the report ends `RESULT pass`. Driver in `mod/neoforge/src/gametest/.../gametest/client/`: `ClientTestDriver` (a client-only `@Mod` that does nothing unless `autosketch.clienttest.suites` is set; creates the flat creative test world when missing; one boot for the selected suites; a watchdog), `ClientTestSuite` (`step`, `waitUntil`, `waitFrames`, `cleanup`, `click`/`hold` through `KeyMapping`, `scroll` through `ClientHooks.onMouseScroll`, `command`, `onServer`, action-bar capture, `widget`/`clickWidget`, `screenshot`, `changedPixels`, `assertMatchesReference` skipped on another renderer), `@ClientTest("<suite>")` methods found through the mod's scan data, and `FakeMcp` (C's `test/support/fake-mcp.ts` CLI with `--pairing --script --record`, started per suite with `clienttest/<suite>.json`; `startMcp`/`stopMcp` within a suite). Suite `basics`: air mode's left click sets corner 1, sneak+scroll distance, the outline is drawn (frames with and without the wand), `/autosketch done` sends `prompt.close` and shows the MCP's answer, and `xdotool` types a real key (skipped without `xdotool`). Suite `link`: `client.ui.LinkState` follows a fake MCP connecting (connected), going (offline), connecting without `ui` (too old) and with it again. CI job `client` in `.github/workflows/mod.yml`. `mod/clienttest-craftoria.sh` for a Craftoria-sized client, manual; not run yet: the server pack lacks client-only mods its other mods require, and the CurseForge client instance, a newer pack version, needs NeoForge 21.1.262 or later, newer than the dev profile's 21.1.249. No reference screenshots committed (they would be game renders); the outline check compares two frames of the same run instead. |
| MCP UI core | M | Not built |
| Overlays and HUD | O | Built. `mod/neoforge/.../client/ui/overlay/`: `OverlayState` (the held `ui.state` as sent: jobs by id, request, tokens, refusal; the `seq` check, a change that doesn't follow is dropped and one `resync` sent until its answer; flashes pulse 1.5 s; cleared when the link leaves `connected`), `DrawList` (solid work box, dashed context boxes, the brief as a label above the box's top centre, flash pulses; only the player's dimension, only while `connected`, per `UiToggles.volumes`/`flashes`), `OverlayRenderer` (lines and pulses twice, faint without a depth test so they show through blocks and full strength in view; labels as camera-facing see-through text; vanilla's `NO_DEPTH_TEST` leaves the depth test on at `AFTER_TRANSLUCENT_BLOCKS`, so a shard switches it off), `OverlayClient` (a second client `@Mod` entry: handlers, the volume, flash and HUD key actions, the render listener). `.../client/ui/hud/HudOverlay`: top-left panel below chat, hidden with F1 and while F3 shows (vanilla leaves that corner empty in play); request and mode, job count and the three newest briefs, last refusal, token totals; the HUD key cycles expanded, collapsed (one line) and hidden (hidden is `UiToggles.hud` off, so S's menu toggle shows and hides the same panel). Client tests (`client/overlay/`, suite `overlay`, 8 tests): two jobs give two solid boxes, dashed context boxes and two labels, the nether job is kept but not drawn, removing a job removes its boxes; a flash pulses in the job's colour and expires; a `seq` gap is dropped and resynced; the volume and flash keys empty and refill their parts; the HUD text matches the state and follows a change; the HUD key cycles; nothing is drawn offline and the keys are locked; an outline shows through a stone wall (two frames from the same run). The fake MCP's script is built at run time, since messages name the player's UUID; most tests share one MCP and reset it with a `resync`. |
| Ghosts | G | Not built |
| Replay in the world | R | Built. `/autosketch replay [live|close|<log>]` (server subcommand through the command hook, locked by `Link.lock` and `Link.requireUi`) hands the action to the client half as relay op `3` `CLIENT_ACTION` (13, *Relay to the client*; generic, `UiClient.onAction`), and the client sends the `ui.request` itself: `logs.list` shown as clickable chat lines newest first, `replay.open`, `replay.close`. Client half in `mod/neoforge/.../client/ui/replay/`: `ReplayClient` applies a keyframe to every position of the volume in the client's world copy (`setBlock` without neighbour or shape updates, at most 65,536 positions a tick), then deltas only when it shows their `from` (otherwise it seeks again for a keyframe), keeps one `replay.seek` in flight and remembers the wanted step, reapplies the frame to chunks that load inside the volume, and closes on Backspace, the command, `LinkState` leaving `connected`, logging out, or a seek answered `not_found` (a `resync` closed it); states the game doesn't know keep the server's block. `ClientPacketListenerMixin` (own config `autosketch.client.mixins.json`) drops block and section updates inside the volume while open. `ReplayCamera`: a client-only `Marker` as camera entity, flown along the look with the movement keys and turned with the player's mouse look; the player is held in place every tick (vanilla neither applies its input nor sends its position while the camera isn't the player); attack and use are cancelled; no game-mode change. Replay keys attached in `AutosketchKeys` (active only while open); scroll steps; play speeds 0.5 to 16 steps a second, 2 by default. `ReplayHud`: the strip (step, time, play state, call, brief, note; a bar with a tick per marker) and minimal line boxes for the step's job volumes and flashes, following the volume and flash toggles (to switch to O's drawing once it merges). Server half: `mod/common/.../ui/relay/ReplayResend` learns each player's open replay from `replay.open` results and resends the volume's chunks that player holds on `replay.close`, `resync`, and for every open replay on bridge disconnect. GameTests `ReplayGameTests`: a close resends exactly the volume's chunks to that player only; a disconnect resends an open replay's chunks. Client tests (`replay` suite): keyframe and delta in the client's world, server changes inside the volume dropped and outside shown, Backspace closes and the client then matches the integrated server, camera detached with the player still on client and server, Esc still pauses, each replay key's request or speed change, the MCP going away closes the replay and restores the blocks. |
| Screens, menu, key bindings | S | Not built (mappings declared by C) |
| Removal and CLI | X | Partly built (waits on M for the rest). Removed: `viewer/`, `three` and `/vendor/three/`'s package, `autosketch ui` (`src/server/ui-command.ts`), `autosketch observe` (`src/observe/offline.ts`), `src/server/instance-host.ts`, the setup wizard and browser opening in `server/index.ts`, `observe.open` (a value in `config.toml` is now reported as unknown), the UI URL in `not_configured`, and the tests of removed code. Automatic instance choice: `chooseAutomatically`, `autoChoiceText` and `ServerInstanceSetup.autoChoose` in `src/server/setup.ts`, `Candidate.pointer` in `src/assets/discover/`, `instance_info` reports `automatic choice`; tests in `test/unit/server/not-configured.test.ts` (one picked and reported once; pointer preferred and unloadable ignored; several listed with the setup command; none says how; a call during discovery). Docs: `12`, `13`, `14`, `15`, `README.md`, `world/test-setup.md`, the release *Release gate*. Left until M's rewrite lands: deleting `src/observe/atlas.ts`, `open.ts`, `instance-api.ts` (still imported by `http.ts` and `library-api.ts`), the `instance` option of `startObserve` and its type, the viewer-only comments in `src/observe/index.ts`, `settings.ts`, `otel.ts`, `states.ts`, `voxels.ts`, and `ui.test.ts`'s browser-API cases. |

## Open questions

None at the moment.

## Decisions

All settled with the user on 2026-11-17.

- **The browser UI is removed completely.** The command line handles startup and outside actions; the game handles every operation. Reason: the player is in the game, switching to a browser is friction, and the game draws modded blocks with their real renderers.
- **Instance choice is command-line only**, with automatic choice when there is exactly one candidate. Reason: it's done once, before the game matters; the existing commands already cover it.
- **Thin client.** Reason: logic stays in tested TypeScript, and the version-sensitive Java (rendering and GUI code changes across Minecraft versions) stays small.
- **One data path through the bridge and the mod's packets**, not a client connection to an HTTP API. Reason: no second connection, no token to hand over, reuses both codecs and the golden vectors; the MCP is local only.
- **Replay plays in the world, client-side.** Reason: the world is already the 3D view; replaying through the server would fight the journal and hand edits and could leave the world wrong after a crash.
- **In-client tests run a real headless client**, following NeoForge's own client self-test. Reason: NeoForge has no client test framework, but everything the harness needs is public.
- **Streams run in parallel** after the contracts, not one after another.
- **Rejected: embedding the browser page in the game** with a Chromium mod (MCEF-style). Reason: a large native dependency per platform, extra risk on Linux and WSL, at odds with the one-command install and a mod that needs no other mods (`14`), and it would still be a web page, in a worse window.
- **Rejected: a client connection to the MCP's HTTP API.** Reason: a second connection and a token to hand to the client, where the bridge already pairs, has both codecs and golden vectors. Going through the bridge also means nothing writes over HTTP any more, so browsers on the machine (which can send requests to `127.0.0.1`) have nothing to attack but the read-only OTLP receiver.
- **Rejected: keeping a small web page** for offline replay or the timeline. Reason: the in-game intent is complete; replay and the timeline play in the world.
- **Key bindings** (decided by Claude on the user's instruction to follow modding conventions, 2026-11-17): one default key (`Home`) opens the Autosketch menu; toggles and screens are unbound; replay keys are active only in replay (*Autosketch menu and key bindings*).
- **Ghosts draw block models only**; blocks with block-entity renderers (chests, Create parts) show their model without the renderer. Revisit only if it looks wrong in use.
- **The whole mod is locked while the MCP is offline**, the wand and volume commands included; only connecting and `/autosketch status` keep working. Reason: the mod exists to serve the MCP; with it off, the mod is effectively disabled, and no fallback commands or standalone server are needed.
- **The lock covers the server console and RCON too** (decided by Claude on the user's instruction, 2026-11-17): offline, they get the same line as a command failure. Reason: the same as the lock itself, and one rule is simpler than a player-only exception; the e2e harness connects before it runs commands.
- **Replay ignores the server's live block updates inside the replayed volume** and catches up on close. Reason: replay is client-side only, and live updates arriving in the same client copy of the world would mix into the picture.
- **The Craftoria-sized client run is deferred** (decided by Claude on the user's instruction, 2026-11-17): the script (`mod/clienttest-craftoria.sh`) exists, but neither source of mods boots on the dev profile (the server pack lacks client-only mods its others need; the current client pack needs NeoForge 21.1.262+, the dev profile is on 21.1.249). Revisit when the dev profile moves to a newer NeoForge, or with a curated list of mods to leave out. The default suites don't depend on it.
