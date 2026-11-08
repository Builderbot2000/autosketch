# Silo R: End-to-end and measurement

**Wave 2**, after N, O, P and Q merge.

**Specs:** `13` (all, especially *Open questions*), `10` (test tiers), `12` (the viewer's `world.*` events).

## Goal

Prove the link works with the real mod in a real world, on the Craftoria instance, and settle the measured open questions in `13` with numbers.

## Deliverables

1. **E2E harness:** start a NeoForge server with the mod (headless), point the MCP at its instance folder, and drive tool calls from a vitest suite (a new tier in `10`, opt-in, skipped when no server is configured). First on a vanilla NeoForge server, then on a Craftoria server.
2. **Scenarios:** link a region; build a small house with ops, a script and a stamp; a simulated hand edit (the mod's test command, or RCON `/setblock`) on a position the next op writes; undo across a sync (refused, then forced); a fork and merge with a hand edit inside the lock; kill and restart the server mid-build (resume with a full sync, nothing replayed); a modded block from Craftoria (Create, FramedBlocks) round-tripping with its NBT.
3. **Measurements** (`13`, *Open questions*): per-tick block budget before visible lag on a Craftoria save, the default it suggests; change-tracker cost per write and whether the mixin holds with Craftoria's mods (else switch O's fallback on by default); snapshot time and size by region volume, and the largest practical region.
4. **Update `13`:** answer each measured open question in the body with the number and the reason, set the defaults, and mark *Implementation status* complete.

## Files you own

- New: `test/e2e/world/**`, a script to start the test server, the new tier's entry in `10`.

## Needs from the user

The user will do the final in-client check (outline particles, action bar, a real hand edit with Axiom) and is setting up the environment. Confirm with them before starting that the Craftoria server pack is unpacked in WSL and that WSL mirrored networking is on. Hand them a short checklist of client steps when the automated scenarios pass.

## Done when

- The scenarios pass against a headless Craftoria server, or the ones that can't are listed as unverified with the reason.
- Every measured open question in `13` has a number and a decision.
