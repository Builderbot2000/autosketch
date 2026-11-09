# Autosketch companion mod

Server-side NeoForge mod for Minecraft 1.21.1 (NeoForge 21.1.249, as in Craftoria 1.37.0) that links a running game to a local Autosketch MCP server. Design: `docs/design/13-live-world.md`. It registers no blocks, items or other registry content, so vanilla clients can join a server that runs it.

## Build and test

Gradle 9 needs a JVM 17 or newer to **run**. Point `JAVA_HOME` at one if your default is older. The mod **compiles** with JDK 21 through Gradle toolchains: the foojay resolver downloads one if none is installed.

```sh
cd mod
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64   # any JDK >= 17
./gradlew build                # compile, JUnit tests, jar in build/libs/
./gradlew test                 # codec and dispatch tests (golden vectors from ../test/data/world-protocol)
./gradlew runGameTestServer    # headless GameTests (src/gametest), exits non-zero on failure
./gradlew runServer            # a dev dedicated server in run/
```

The JUnit tests read the protocol's golden vectors straight from `../test/data/world-protocol/` (the only files shared with the TypeScript side), so they need the whole repository checked out.

## Layout and ownership

| Package | Silo | Contents |
|---|---|---|
| `dev.autosketch.mod` | N | entry point, config (`config/autosketch-common.toml`) |
| `…api` | N | extension points: `AutosketchSetupEvent`, `MessageHandler`/`Exchange`, `CommandExtension`, `WandMode`, `Bridge`, `LinkState`, `PatchStatus` |
| `…protocol` | N | wire codec: frames, typed messages, binary bodies, deterministic NBT |
| `…bridge`, `…volume`, `…command` | N | socket and dispatch, work/context volumes and wand, `/autosketch` |
| `…world` | O | snapshots, section hashes, patch applier, change tracker |
| `…prompt` | S | `/autosketch ask`, focus mode, chat |
| `src/gametest` | all | GameTests; template `autosketch:empty` is a synthetic 3×3×3 of air |

Silos register from their own package by subscribing to `AutosketchSetupEvent` on the mod bus, so nobody edits another silo's files. See the javadoc of `AutosketchSetupEvent`.
