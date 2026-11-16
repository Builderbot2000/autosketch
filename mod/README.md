# Autosketch companion mod

Server-side mod for Minecraft 1.21.1 on NeoForge (21.1.249, as in Craftoria 1.37.0) that links a running game to a local Autosketch MCP server. Design: `docs/design/13-live-world.md`; build layout and release: `docs/design/14-distribution.md`. It registers no blocks, items or other registry content, so vanilla clients can join a server that runs it. It needs **Cloth Config** (`cloth_config`, 15.x on 1.21.1) wherever it is installed; Craftoria already has it.

## Build and test

**Gradle needs `JAVA_HOME` at JDK 17 or newer** to run (Gradle 9). On the dev machine that is JDK 21 at `/usr/lib/jvm/java-21-openjdk-amd64`; the default `JAVA_HOME` there points at JDK 11, which can't run Gradle 9. The mod itself **compiles** with JDK 21 through Gradle toolchains: the foojay resolver downloads one if none is installed.

```sh
cd mod
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64   # any JDK >= 17
./gradlew build                # loader check, compile, JUnit tests, the jar (below)
./gradlew test                 # codec, dispatch and config tests in common (golden vectors from ../test/data/world-protocol)
./gradlew runGameTestServer    # headless GameTests (neoforge/src/gametest), exits non-zero on failure
./gradlew runSmokeTestServer   # the per-target smoke test alone: server starts, pointer file, bridge pairs
./gradlew releaseInfo          # the jar's release metadata, in neoforge/versions/<v>/build/release/release.properties
./gradlew runServer            # a dev dedicated server in run/ (needs run/eula.txt accepted)
```

Task names run in every module that has them; to name one project, prefix it: `./gradlew :neoforge:1.21.1:runGameTestServer`, `./gradlew :common:1.21.1:test`. The jar is `neoforge/versions/1.21.1/build/libs/autosketch-neoforge-1.21.1-<version>.jar` (`test/e2e/world/server.sh` picks it up from there). GameTests run in `run/gametest/`.

**CI and releases.** `.github/workflows/mod.yml` runs the smoke test for every target (no JUnit tests, so the golden-vector test never blocks a target) and the full suite on the Craftoria profile. `.github/workflows/mod-release.yml` publishes to CurseForge and Modrinth when a tag `mod-v<version>` matching `mod_version` is pushed; the tag must be annotated, and its message is the changelog. It needs the repository secrets `CURSEFORGE_TOKEN` and `MODRINTH_TOKEN` and the variables `CURSEFORGE_PROJECT_ID` and `MODRINTH_PROJECT_ID`; without them it stops in preflight and publishes nothing (`mod/release/preflight.sh` checks the same locally). Running the workflow by hand is the dry run.

The bridge smoke script `scripts/mod-bridge-smoke.ts` (repository root) plays the MCP against a running game with the mod: `npx tsx scripts/mod-bridge-smoke.ts <instance dir> [--seconds 120] [--extend]`. It checks a wrong token and a wrong protocol are refused, pairs, and prints every `volumes` message while you mark volumes in-game.

The JUnit tests read the protocol's golden vectors straight from `../test/data/world-protocol/` (the only files shared with the TypeScript side), so they need the whole repository checked out.

## Build layout

The MultiLoader template's layout with Stonecutter (`14`, *Build layout*):

| Path | What |
|---|---|
| `common/` | Every class that uses only vanilla types: protocol, bridge, volumes, commands, feedback, world I/O, prompts, the config, the change tracker's mixin, the lang file, and the JUnit tests. Compiled against vanilla Minecraft (NeoForm) with Mixin and Cloth Config's API as compile-only libraries, and never shipped as its own jar: each loader module compiles these sources into its jar. |
| `neoforge/` | The NeoForge module: the entry point, NeoForge's events, the client config screen, `neoforge.mods.toml`, and the GameTests. |
| `stonecutter.gradle`, `settings.gradle` | Stonecutter's tree: `common` and `neoforge` are branches sharing the version list and the active version. Each module is built once per Minecraft version as `:<module>:<version>`, in `<module>/versions/<version>/`. |
| `versions/<version>/gradle.properties` | That version's Minecraft, NeoForge, NeoForm, Parchment, Mixin and Cloth Config versions, loaded by `gradle/java.gradle` into every module. `gradle.properties` holds what every version shares. |

One target is active today, Minecraft 1.21.1 on NeoForge (Java 21). A new version is a line in `settings.gradle`, a `versions/<version>/gradle.properties`, and Stonecutter's version-conditional comments (`//? if >=1.21.5 {`) where the code differs; a new loader is a module beside `neoforge/` with its own entry point, events and `Platform`.

**Loader-free common module, by build check.** `checkNoLoaderImports` runs before `common` compiles and fails on any `net.neoforged`, `net.minecraftforge` or `net.fabricmc` name in its sources, listing the lines; compiling against NeoForm fails on any NeoForge class as well, including NeoForge's additions to vanilla classes (such as `Entity.getPersistentData()`). What common code needs from the loader goes through `dev.autosketch.mod.platform.Platform` (the running server, the config folder, the loader's name and version for `hello`, the player's saved mod data), which the entry point installs.

## Packages and ownership

| Package | Module | Silo | Contents |
|---|---|---|---|
| `dev.autosketch.mod` | common | N | `AutosketchCore` (the pieces and lifecycle), `AutosketchConfig` (Cloth Config, `config/autosketch.toml`) |
| `dev.autosketch.mod` | neoforge | N | `AutosketchMod`: the NeoForge entry point |
| `…platform` | common | N | `Platform`: what common code needs from the loader |
| `…api` | common, neoforge | N | extension points: `AutosketchSetup` (common) and `AutosketchSetupEvent` (neoforge, same methods), `MessageHandler`/`Exchange`, `CommandExtension`, `WandMode`, `Bridge`, `LinkState`, `PatchStatus` |
| `…protocol` | common | N | wire codec: frames, typed messages, binary bodies, deterministic NBT |
| `…bridge`, `…volume`, `…command`, `…feedback` | common | N | socket and dispatch, work/context volumes and wand (`WandControl`), `/autosketch`, outlines and notices |
| `…volume.WandEvents` | neoforge | N | NeoForge's click and swap-hands events for the wand |
| `…world` | common | O | snapshots, section hashes, patch applier, change tracker (`WorldModule`) |
| `…world.WorldEvents` | neoforge | O | NeoForge's setup and tick hooks for `WorldModule` |
| `…prompt` | common | S | `/autosketch ask`, focus mode, chat (`PromptModule`) |
| `…prompt.PromptEvents` | neoforge | S | NeoForge's setup hook for `PromptModule` |
| `…client` | neoforge | N | the config screen in the mod list (client only) |
| `neoforge/src/gametest` | neoforge | all | GameTests; template `autosketch:empty` is a synthetic 3×3×3 of air |

Silos register from their own package: the registration code is a `setup(AutosketchSetup)` method in common, called from a small NeoForge class that subscribes to `AutosketchSetupEvent` on the mod bus (`WorldEvents`, `PromptEvents`), so nobody edits another silo's files. See the javadoc of `AutosketchSetupEvent`.

## Using it

- **Pointer file.** On server start the mod also writes `~/.autosketch/games/<hash of the game folder>.toml` (`docs/design/14-distribution.md`, *Pointer file format*) so a local Autosketch MCP finds this game, and deletes pointer files whose game folder is gone. `discovery.pointer = false` in `config/autosketch.toml` turns it off and removes this game's file. `AUTOSKETCH_HOME` (or `-Dautosketch.home`) replaces `~/.autosketch`; Gradle's dev and GameTest runs use `run/autosketch-home/`.
- **Pairing.** On server start (a dedicated server, or a singleplayer world opening) the mod listens on `127.0.0.1` and writes `config/autosketch-bridge.toml` with the port and a fresh token; the MCP reads it. Set a fixed port with `port` under `[bridge]` in `config/autosketch.toml` (0 = a free port each start).
- **Commands** (op level 2, cheats on in singleplayer): `/autosketch wand` gives the wand (a blaze rod marked with `custom_data`). Left click a block sets corner 1, right click corner 2 of the current mode's box; the swap-hands key (F) cycles the mode, or `/autosketch mode work|context|…`. `/autosketch pos1|pos2 [x y z]` does the same at your feet or the given position. `/autosketch context add` adds the box marked in context mode, `context grow <n>` makes the context the work volume grown by `n`, `context clear` goes back to the default (grown by 3). `/autosketch clear` removes the work volume (unlinks). `/autosketch show` toggles outlines when not holding the wand, `/autosketch notices on|off` the action-bar notices, `/autosketch status` shows the link.
- **From the console or RCON** (no player): `/autosketch mode work|context`, `/autosketch pos1|pos2 <x y z>` and `/autosketch context add` work too, with one shared set of corners in the source's dimension; each `pos1` + `pos2` pair names one box. The end-to-end tests set volumes this way.
- **Config** (`config/autosketch.toml`, Cloth Config; on a client also from the mod list's config button): `tickBudget = 20000` blocks per tick and `tracker = "both"` (hook plus scan, so Axiom's direct writes are seen too), from measurements on Craftoria (`docs/design/13-live-world.md`, *Measured on Craftoria*). The file is read at game start, again on every server start, and within a second of being saved while a server runs (as NeoForge did); `tracker` is read once at game start, since it decides whether the mixin applies. Out-of-range numbers are clamped and invalid values reset to the default. **Upgrading from a build before Cloth Config:** on the first start, `config/autosketch-common.toml` (the old NeoForge config) is read once, every key and value kept, and renamed to `autosketch-common.toml.bak`.
- **Volumes are shared**: one work volume per server, whoever marks it. Wand mode and half-marked corners are per player.

### Game on Windows, MCP in WSL2

The mod binds to loopback only (`127.0.0.1`), so the MCP must run on the same machine. WSL2 counts, but only with **mirrored networking**, which makes Windows' loopback reachable from WSL:

1. In `%UserProfile%\.wslconfig` on Windows, add:
   ```ini
   [wsl2]
   networkingMode=mirrored
   ```
2. Run `wsl --shutdown` in a Windows terminal, then reopen WSL.
3. Start the game (or open the singleplayer world). From WSL, the port in the instance's `config/autosketch-bridge.toml` is now reachable at `127.0.0.1`. The MCP finds the instance as usual (setting `world.gameDir` overrides it).

Without mirrored networking the MCP reports that the port can't be reached and names this setting.
