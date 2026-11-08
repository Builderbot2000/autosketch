# Silo N: Mod skeleton, bridge, region, feedback

**Wave 1**, as soon as silo L's *Wire format* section and golden vectors merge. Land the skeleton (deliverable 1) first, in its own merge: silo O starts from it.

**Specs:** `13` (*Work region*, *Connection*, *Player feedback in-game*, *Companion mod requirements*), L's *Wire format* section.

## Goal

A server-side-only NeoForge mod that pairs with the MCP over a localhost socket, lets the player mark the work region with a wand or commands, and shows what the link is doing. It leaves reading and writing blocks to silo O.

## Deliverables, in merge order

1. **Skeleton** (M1, M2): a `mod/` Gradle subproject from NeoForge's MDK for 1.21.1, JDK 21, its own Gradle wrapper. No registry content of any kind. A config file (per-tick block budget, notices default, dirty cap) and a message dispatch interface: `register(kind, handler)`, so silo O adds the `snapshot` and `patch` handlers without editing this silo's files. A JUnit test setup and NeoForge's GameTest setup, runnable headless (`./gradlew test`, `runGameTestServer`).
2. **Bridge** (M10): open a localhost-only server socket on startup, write port and a fresh random token to `<instance>/config/autosketch-bridge.toml`, accept one MCP connection at a time, refuse a wrong token, run the version check in `hello`. Socket I/O on its own thread; every world access handed to the server thread. Survive the MCP disconnecting and reconnecting. Frame and message codec tested against L's golden vectors.
3. **Work region** (M3, M4): the wand (a vanilla item with a `custom_data` marker, not a wooden axe), left and right click for corners, `/autosketch wand|pos1|pos2|show|clear|status|notices`, op level 2. Send `region` on every change and after `hello`. A chunk ticket over the region while linked, released on unlink or disconnect. Region and wand state per player or global: pick one, record it in `13`, and say why.
4. **Feedback** (M11): outline particles while the wand is held or after `show`, action-bar text for `notice` messages and patch results, `/autosketch status` (link state, region, last patch, pending patches; O exposes the patch numbers through an interface you define).
5. **M12:** nothing in this silo touches entities. Write a GameTest that asserts it.

## Files you own

- `mod/**` except the packages silo O owns (agree the package split in N's skeleton merge, e.g. `…bridge`, `…region`, `…command` here and `…world` for O).
- The mod rows of `13`'s *Implementation status*.

## Notes

- **JDK 21 is not installed on the dev machine** (only 11). Use Gradle toolchains with auto-provisioning (the MDK's foojay resolver) rather than requiring a system install, unless the user says otherwise.
- The user's game runs on Windows and the MCP in WSL2 (README *Decisions* 3). Bind to loopback only, and document the mirrored-networking setup in the mod's README.
- Dedicated server and singleplayer must both work: never reference client-only classes, and test with `runServer`.
- Command and wand behaviour that needs a player is GameTest territory. Socket and codec behaviour is plain JUnit.

## Done when

- `./gradlew build test` passes from a clean checkout with no system JDK 21.
- A vanilla client without the mod joins a server running it.
- Driven by a small TS script that plays the MCP's side with L's codec, the mod pairs, refuses a bad token, reports a version mismatch, and sends `region` after hello and on change.
- `13`'s mod requirement rows M1–M4 and M10–M12 are marked done in *Implementation status*.
