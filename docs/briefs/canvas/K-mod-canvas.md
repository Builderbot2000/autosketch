# Silo K: Canvas in the mod

**Wave 1** (K1, after W1).

**Specs:** `19` Part B *Model*, *Setting the canvas*, *Placing and moving the brush* (outline); `13` (*Work and context volumes in-game*, *Where the mod serves reads*, *Read grants in select mode*, tickets); `16` (overlays); `18` (M1–M5: how grant reads are served).

## Deliverables (K1)

1. Wand mode `canvas` after `work` and `context`; corners give the canvas widened to whole chunk columns and full build height. `/autosketch canvas here [radius]` (default 16), `grow <chunks>`, `clear`, `show` (size in chunks). One canvas per server, not saved.
2. `canvasChunks` config (default 256, range 1–256): over it, `bad_volumes` naming the key, for the player and for `canvas.set`.
3. A work volume marked outside the canvas clears the canvas (action bar says so). `canvas` sent after hello and on every change; `canvas.set` answered as W1 records.
4. **Reads inside the canvas** in every mode, served exactly as inside the select grant (async disk reads, no tickets, no generation, per-call `contextCap`). Reuse `SelectGrants`' serving path; the readable area is the union of the grant and the canvas.
5. Overlay: the canvas as a faint box, and a chunk grid on the ground while the wand is held (client half; particles for clients without it, at most as today's volume outline).
6. GameTests (commands, widening, cap, clearing rule, reads inside and outside, `canvas.set`) and client tests (outline, grid).

## Files you own

`mod/common/.../volume/**` (canvas beside the volumes), a new canvas command class, `AutosketchConfig.java` (`canvasChunks`), `mod/common/.../world/` read-area check (minimal), `mod/neoforge/.../client/ui/overlay/**`, `19`'s K row.

## Done when

- A blocks snapshot far from the work volume but inside the canvas is served in `build` mode, and one outside it is `outside_volumes`.
