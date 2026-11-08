# Silo N: Mod skeleton, bridge, volumes, feedback

**Wave 1**, as soon as silo L's *Wire format* section and golden vectors merge. Land the skeleton (deliverable 1) first, in its own merge: silo O starts from it.

**Specs:** `13` (*Model*, *Work and context volumes in-game*, *Connection*, *Player feedback in-game*, *Companion mod requirements*), L's *Wire format* section.

## Goal

A server-side-only NeoForge mod that pairs with the MCP over a localhost socket, lets the player mark the work and context volumes with a wand or commands, and shows what the link is doing. It leaves reading and writing blocks to silo O.

## Deliverables, in merge order

1. **Skeleton** (M1, M2): a `mod/` Gradle subproject from NeoForge's MDK for 1.21.1, JDK 21, its own Gradle wrapper. No registry content of any kind. A config file (per-tick block budget, notices default, dirty cap) and a message dispatch interface: `register(kind, handler)`, so silo O adds the `snapshot` and `patch` handlers without editing this silo's files, and a command hook so silo S adds `ask`, `focus` and `log` subcommands and the wand's focus mode the same way. A JUnit test setup and NeoForge's GameTest setup, runnable headless (`./gradlew test`, `runGameTestServer`).
2. **Bridge** (M10): open a localhost-only server socket on startup, write port and a fresh random token to `<instance>/config/autosketch-bridge.toml`, accept one MCP connection at a time, refuse a wrong token, run the version check in `hello`. Socket I/O on its own thread; every world access handed to the server thread. Survive the MCP disconnecting and reconnecting. Frame and message codec tested against L's golden vectors.
3. **Work and context volumes** (M3, M4): the wand (a vanilla item with a `custom_data` marker, not a wooden axe) with modes (work and context here; S registers focus), left and right click for the current mode's corners, the swap-hands key to cycle modes, `/autosketch wand|mode|pos1|pos2|show|clear|status|notices` and `/autosketch context add|grow <n>|clear`, the default context (work volume grown by 3), a configurable cap on total context volume, op level 2. Send `volumes` on every change and after `hello`. A chunk ticket over both volumes while linked, released on unlink or disconnect. Volume and wand state per player or global: pick one, record it in `13`, and say why. Whole-block extension is the MCP's job; show whatever volumes the MCP's `notice` reports.
4. **Feedback** (M11): outline particles per volume in their own colours while the wand is held or after `show`, action-bar text for `notice` messages and patch results, `/autosketch status` (link state, volumes, last patch, pending patches; O exposes the patch numbers through an interface you define).
5. **M12:** nothing in this silo touches entities. Write a GameTest that asserts it.

## Files you own

- `mod/**` except the packages silos O and S own (agree the package split in N's skeleton merge, e.g. `…bridge`, `…volume`, `…command` here, `…world` for O, `…prompt` for S).
- The mod rows of `13`'s *Implementation status*.

## Notes

- **JDK 21 is not installed on the dev machine** (only 11). Use Gradle toolchains with auto-provisioning (the MDK's foojay resolver) rather than requiring a system install, unless the user says otherwise.
- The user's game runs on Windows and the MCP in WSL2 (README *Decisions* 3). Bind to loopback only, and document the mirrored-networking setup in the mod's README.
- Dedicated server and singleplayer must both work: never reference client-only classes, and test with `runServer`.
- Command and wand behaviour that needs a player is GameTest territory. Socket and codec behaviour is plain JUnit.

## Done when

- `./gradlew build test` passes from a clean checkout with no system JDK 21.
- A vanilla client without the mod joins a server running it.
- Driven by a small TS script that plays the MCP's side with L's codec, the mod pairs, refuses a bad token, reports a version mismatch, and sends `volumes` after hello and on every change (work, context add, grow and clear).
- `13`'s mod requirement rows M1–M4 and M10–M12 are marked done in *Implementation status*.
