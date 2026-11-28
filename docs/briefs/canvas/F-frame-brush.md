# Silo F: Canvas frame and brush, MCP

**Wave 1** (F1, after W1), **wave 2** (F2).

**Specs:** `19` Part B *The frame doesn't move with the brush*, *Placing and moving the brush*; `01` (*Coordinates*); `04` (sparse `VoxelStore`); `11` (*Nesting*, the ratio); `13` (*Model*, *Frame*, `world_sync`, sync barrier, `world_volumes` B4); `18` piece 5 (world view).

## Deliverables

**F1**

1. With a canvas, local (0,0,0) = canvas min; world = local + canvas min. Without one, `13`'s frame unchanged. Clearing or setting the canvas is a relink and the result says the frame changed.
2. The linked document holds only the brush's and context's sections. Document reads (`query_*`, `view_slice`, `render`, `raycast`, `analyze`, selections that read blocks) at canvas positions outside the mirror read through the world view (`18` piece 5), marked read-only and possibly stale; outside the canvas, refused as now. Writes stay limited to the brush (`Document.guard`).
3. The request event and `doc_info` name the canvas, the brush and the frame.
4. Tests with the fake host: frame arithmetic, reads through the view, no air read outside the mirror, writes refused outside the brush.

**F2**

5. `world_volumes({work, context?})` inside the canvas is allowed in every mode, without the player. Outside it or without a canvas, today's rule.
6. A move happens between calls: wait for the brush's pending patch acks, drop the old brush's sections from the mirror (journal kept), release and retake tickets (the mod does this on relink), snapshot the new brush and context. The result reports both boxes and the time taken. Coordinates never change.
7. Undo or redo of an entry that wrote outside the current brush: refused, naming the box to move the brush to. After moving back, the region is snapshotted fresh, so the sync barrier applies as usual.
8. The fork ratio (`11`) measures against the brush.
9. Tests: three moves with no coordinate change, a move while a patch is unacked, undo outside refused, undo after moving back with a hand edit stopping at the barrier.

## Files you own

`src/world/link.ts`, `live-link.ts`, `sync.ts`, `set-volumes.ts`, `src/server/tools/world-volumes.ts`, the scope ratio base in `src/scope/` (minimal), `19`'s F rows, `11`/`13` text the spec's *Changes to other specs* names for F.

## Done when

- No test can observe a local coordinate change across a brush move.
