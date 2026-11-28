# Silo Z: In game, close-out

**Wave 5** (Z1 after every other step; Z2 after Z1).

**Specs:** `21` *Steps* Z, *Open*; `10` (test tiers); `13` (e2e world tier); `docs/briefs/world/test-setup.md`.

## Deliverables

**Z1** (agent, headless)

1. On the headless Craftoria server (`~/servers/craftoria`, e2e tier `npm run test:e2e-world`): the mode set, the server restarted, the mode back to `build`; a long reply (≥3 paragraphs, ~2000 characters) arriving as one chat message for a vanilla-path player.
2. `21`'s *Implementation status* complete for every step, *Changes to other specs* checked against `13`, `16`, `19`; *Open* carried with what Z2 must judge.
3. `docs/briefs/world/test-setup.md` gains the console's in-client checks (the Z2 list below) so they can be repeated.
4. `HANDOFF.md` in this folder.

**Z2** (the lead with the user, using the `ingame-setup` skill; not a subagent)

5. The panel over a live world while walking and building; its size at the user's GUI scale; `'`, Shift+`'` and Ctrl+C with the instance's real bindings and the user's keyboard layout (*Open*: Shift+`'`); whether folded activity is enough to follow the agent while moving (*Open*); a long reply as one entry. Results and any default changes recorded in `21`; Z2 sets `21`'s *Status* line.

## Files you own

The new e2e file, `21`'s *Status*, *Open* and Z rows, `HANDOFF.md`, `test-setup.md`.
