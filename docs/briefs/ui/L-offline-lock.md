# Silo L: Offline lock

**Wave 0**, from day one; independent of the `ui` messages. Land the test change (deliverable 1) first and fast: it touches every existing test that marks a volume, and the other mod silos rebase on it.

**Specs:** `16` (*Mod side*: *The whole mod is locked while the MCP is offline*, *An MCP that is connected but older*), `13` (*Companion mod requirements*, *Player feedback in-game*).

## Goal

With no bridge connection, the mod does nothing for the player except let the MCP connect and let the player check on it; with an MCP that lacks `ui`, only `16`'s in-game UI is locked. The client always knows which of the three states it is in.

## Deliverables, in merge order

1. **Tests connect first.** Existing GameTests and `test/e2e/world/` scenarios that mark volumes or use the wand without an MCP connected get a connected fake MCP first (an in-process Java stand-in for GameTests is fine if C's TS fake MCP isn't usable there; keep it in the gametest source set). Merge this alone, before the lock itself, with every test still passing.
2. **Link state** in the server half: `offline`, `too_old` (connected, no `ui` in the MCP's hello), `connected`. Sent to each client with the client half on change and on join, as a mod-internal payload on C's channel (or, if C hasn't landed, a payload of your own that C folds in). The client half writes it into C's `LinkState`.
3. **The lock.** While `offline`: the wand, air mode, and the `/autosketch` volume, request, scan, replay and ghost commands answer with one action-bar line saying the Autosketch MCP isn't connected and do nothing else; key bindings and the menu (S) and every client draw (O, G, R, today's volume outlines) check `LinkState` and do nothing. Marked volumes stay in the player's saved data and show again on connect. What keeps working: the bridge listening, pairing and pointer files, the mod's config screen, `/autosketch status`. While `too_old`: today's features work, and only `16`'s features answer with an action-bar line saying the MCP is too old.
4. **`/autosketch status`** reports the link state (and, for `too_old`, the MCP's protocol and features), on top of what it shows today.
5. **Mod requirement row** in `13`'s *Companion mod requirements* and `16`'s *Implementation status*.

## Files you own

- New `…/link/` (or the package N's bridge used for connection state) in `mod/common`, the gating calls in the command and wand handlers (additive, one check each), the client-side `LinkState` writer, the existing GameTests and e2e scenarios for deliverable 1.

## Notes

- The check must be one place: a single `Link.requireConnected(player)` (or similar) that sends the action-bar line and returns false. Command handlers call it; nothing re-implements the message.
- A vanilla client still gets the action-bar line from the server half, since it's a server message.
- Don't hide the existing particle outlines code; gate it.

## Done when

- GameTests: with no MCP, each locked command and the wand answer with the line and change nothing; marked volumes survive a disconnect and come back on connect; `/autosketch status` works offline; with an MCP lacking `ui`, today's commands work and `16`'s are refused with the too-old line.
- A client test on H's harness: the client's `LinkState` follows a fake MCP connecting, disconnecting, and connecting without `ui`.
- Every existing GameTest and e2e scenario still passes.
