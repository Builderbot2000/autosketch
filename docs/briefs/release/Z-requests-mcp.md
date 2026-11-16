# Silo Z: MCP side of in-game requests

**Wave 0** (protocol additions and `N`/`N−1`, the contract silo Y codes against), **wave 1** (modes, memory docs), **wave 2** (scan), **wave 3** (end-to-end scenarios with Y).

**Specs:** `13` (*Backlog* B4, B5, B6; *Wire format*; *MCP requirements* W11), `14` (*Version skew between mod and MCP*), `11` (sandbox read-only documents, for the probe), `06` (views of the probe).

## Goal

A player's subcommand decides what the agent may do (`ask`, `scan`, `plan`, `build`), and the MCP enforces it. `/autosketch scan` lets the agent look around and set the volumes itself. Mod and MCP releases can differ by one protocol version without breaking.

## Deliverables, in merge order

1. **Protocol additions** (wave 0, contract). In `13`'s *Wire format*: `mode` on `prompt`; `modes` listed in the MCP's `hello`; `snapshot` kind `surface` (per column, topmost non-air height and state, plus the ceiling when underground; measured before defaults are fixed); `volumes.set` (MCP to mod, the mod sets volumes as if the player had marked them). Bump the protocol version. TS codec in `src/world/protocol/`, golden vectors (regenerate with the generator script), fake host support.
2. **`N`/`N−1`** (wave 0). The bridge accepts the previous protocol version too: features gate on what each `hello` lists, never on the number. On any other mismatch, the tool result and the mod's action bar say which side is older and what to update. Keep the previous version's vectors and test against both.
3. **B6: modes, enforced** (wave 1). While an in-game request in a read-only mode is open, edits on the linked document are refused with `request_mode` (naming the mode and the command to use instead): `ask` and `plan` allow no edits and no volume changes; `scan` allows only the volume tool. Terminal-prompted work is unaffected. The channel event opens with the mode and one line on what it allows. This is a permission, not a heuristic (`13`, B6).
4. **B5: memory docs** (wave 1). `docs/briefs/world/test-setup.md` gets the `autoMemoryDirectory` step alongside `--channels`, with the limits (subagents don't see it; local to the machine).
5. **B4: scan** (wave 2). Before any link, load the probe (surface for the radius, full blocks in the `scanBelow`/`scanAbove` box within `scanCap`) into a temporary read-only document the usual views work on, including a top-down map of the surface and the `player` camera. A new tool `world_volumes({ work, context })` (its own module, `src/server/tools/world-volumes.ts`) sends `volumes.set`; linking follows as usual. No accept step, and no structural analysis in the harness: the agent decides where the build ends.
6. **End-to-end scenarios** (wave 3, with Y). In `test/e2e/world/`: each mode refuses what it must, scan sets volumes that link, an air-mode corner marks the expected box, and a one-version-old mod still pairs.

## Files you own

- `src/world/protocol/**`, `test/data/world-protocol/**`, `test/support/fake-host.ts` (wave 0; V adds later), `src/world/prompt.ts` and the mode check, the probe document module (for example `src/world/probe.ts`), `src/server/tools/world-volumes.ts`, tests in `test/unit/world/`, `test/e2e/world/` scenarios.
- Shared: `13` (*Wire format*, B4–B6 rows), `docs/briefs/world/test-setup.md`, `src/server/tools/index.ts` (one line).

## Done when

- Golden vectors round-trip in TS for both the new and the previous protocol version; the fake host speaks both.
- An `ask` request's `fill` on the linked document is refused with `request_mode`; the same `fill` from the terminal succeeds; a `scan` request may call `world_volumes` and nothing that edits.
- An MCP that lists only `build` in `hello` makes the mod refuse `scan` (fake-host test of the gate).
- The probe document refuses edits, renders, and slices, and a surface snapshot of 25×25 chunks stays under the size measured and recorded in `13`.
- `world_volumes` on the fake host sets volumes, and the link follows.
- An unlinked session's results are unchanged (compare a recorded session).
- `13`'s B4–B6 and `14`'s skew section have *Implementation status* rows.
