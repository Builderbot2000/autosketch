# Autosketch companion mod

Server-side NeoForge mod for Minecraft 1.21.1 (NeoForge 21.1.249, as in Craftoria 1.37.0) that links a running game to a local Autosketch MCP server. Design: `docs/design/13-live-world.md`. It registers no blocks, items or other registry content, so vanilla clients can join a server that runs it.

## Build and test

**Gradle needs `JAVA_HOME` at JDK 17 or newer** to run (Gradle 9). On the dev machine that is JDK 21 at `/usr/lib/jvm/java-21-openjdk-amd64`; the default `JAVA_HOME` there points at JDK 11, which can't run Gradle 9. The mod itself **compiles** with JDK 21 through Gradle toolchains: the foojay resolver downloads one if none is installed.

```sh
cd mod
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64   # any JDK >= 17
./gradlew build                # compile, JUnit tests, jar in build/libs/
./gradlew test                 # codec and dispatch tests (golden vectors from ../test/data/world-protocol)
./gradlew runGameTestServer    # headless GameTests (src/gametest), exits non-zero on failure
./gradlew runServer            # a dev dedicated server in run/ (needs run/eula.txt accepted)
```

The smoke script `scripts/mod-bridge-smoke.ts` (repository root) plays the MCP against a running game with the mod: `npx tsx scripts/mod-bridge-smoke.ts <instance dir> [--seconds 120] [--extend]`. It checks a wrong token and a wrong protocol are refused, pairs, and prints every `volumes` message while you mark volumes in-game.

The JUnit tests read the protocol's golden vectors straight from `../test/data/world-protocol/` (the only files shared with the TypeScript side), so they need the whole repository checked out.

## Layout and ownership

| Package | Silo | Contents |
|---|---|---|
| `dev.autosketch.mod` | N | entry point, config (`config/autosketch-common.toml`) |
| `…api` | N | extension points: `AutosketchSetupEvent`, `MessageHandler`/`Exchange`, `CommandExtension`, `WandMode`, `Bridge`, `LinkState`, `PatchStatus` |
| `…protocol` | N | wire codec: frames, typed messages, binary bodies, deterministic NBT |
| `…bridge`, `…volume`, `…command`, `…feedback` | N | socket and dispatch, work/context volumes and wand, `/autosketch`, outlines and notices |
| `…world` | O | snapshots, section hashes, patch applier, change tracker |
| `…prompt` | S | `/autosketch ask`, focus mode, chat |
| `src/gametest` | all | GameTests; template `autosketch:empty` is a synthetic 3×3×3 of air |

Silos register from their own package by subscribing to `AutosketchSetupEvent` on the mod bus, so nobody edits another silo's files. See the javadoc of `AutosketchSetupEvent`.

## Using it

- **Pairing.** On server start (a dedicated server, or a singleplayer world opening) the mod listens on `127.0.0.1` and writes `config/autosketch-bridge.toml` with the port and a fresh token; the MCP reads it. Set a fixed port with `bridge.port` in `config/autosketch-common.toml` (0 = a free port each start).
- **Commands** (op level 2, cheats on in singleplayer): `/autosketch wand` gives the wand (a blaze rod marked with `custom_data`). Left click a block sets corner 1, right click corner 2 of the current mode's box; the swap-hands key (F) cycles the mode, or `/autosketch mode work|context|…`. `/autosketch pos1|pos2 [x y z]` does the same at your feet or the given position. `/autosketch context add` adds the box marked in context mode, `context grow <n>` makes the context the work volume grown by `n`, `context clear` goes back to the default (grown by 3). `/autosketch clear` removes the work volume (unlinks). `/autosketch show` toggles outlines when not holding the wand, `/autosketch notices on|off` the action-bar notices, `/autosketch status` shows the link.
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
