# Silo Z: End to end, close-out

**Wave 3** (Z1 after every other step, then Z2).

**Specs:** `19` (*Steps* K4, *Open*); `10` (test tiers); `13` (e2e world tier); `docs/briefs/world/test-setup.md`.

## Deliverables

**Z1**

1. An e2e world scenario on the headless Craftoria server (`test/e2e/world/`, tier `npm run test:e2e-world`; needs `AUTOSKETCH_E2E_SERVER` and `AUTOSKETCH_E2E_INSTANCE`): a 64×64-chunk canvas; three brush moves with no local coordinate change; an undo after moving back; a stop while a patch is in flight (unstarted patches dropped, the one in progress finished); a queued prompt delivered on turn end (turn end posted to the route as the hook would).
2. Measure `world_map` and coarse reads at `canvasChunks` 256 on `~/servers/craftoria/autosketch-measure`; settle the default in `19`, *Open*.
3. Whether Claude Code's `Stop` hook fires on Esc and on an error stop: check the docs, and if testable here, a real `claude -p` session against the MCP. Record the answer in `19`.

**Z2**

4. `19`'s *Status* and *Implementation status* complete, *Open* resolved or carried; `HANDOFF.md` in this folder; `docs/briefs/world/test-setup.md` gains the in-client checks (status line in place, stop button, canvas wand mode and grid).

## Files you own

The new e2e file, `19`'s *Status*, *Open* and Z rows, `HANDOFF.md`, `test-setup.md`.
