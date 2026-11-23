# Silo M: Mod world reads

**Wave 1**, from W1. M1 first (Z1 measures it as soon as it lands), then M2, then M3.

**Specs:** `18` pieces 2, 3, 4, 5 (snapshot side), *Already built* (`SurfaceReads` disk reads, `maybeHas`), *Measure first*, *Testing* (JUnit, GameTests); `13` (tick budget, chunk tickets, reads).

## Goal

The server half of select: find materials without reading blocks, grow a shape through unloaded but generated chunks, and ship masks and coarse snapshots, all sliced per tick and never generating a chunk.

## Deliverables

**M1 search**

1. Ring walk outward from the centre chunk (player's, or `around`), loaded chunks directly, generated ones from disk as `SurfaceReads` does, ungenerated ones listed. Per section `maybeHas` against the resolved materials (ids, families, tags); on a yes, count the matches in that section only.
2. Clusters of touching matching chunks; closed once the walk is `gap` rings past their edge with no new touching match; stop after `stop` closed clusters or at the radius. Resumable from the reached ring (`continue`), state kept per player request.
3. Config `selectChunks` (default and cap 256) and the search defaults, in `AutosketchConfig` and `ConfigToml`, with a migration test.
4. Reads granted inside the searched chunks for the rest of the request (plus whatever the user settles, README *Open point*).
5. JUnit: `maybeHas` walk has no false negatives (a stale palette entry is a "maybe" that counts zero). GameTests: loaded and unloaded generated chunks, ungenerated listed, early stop, `continue`.

**M2 fill and expand**

6. `fill`: depth-first over 6, 18 or 26 neighbours (default 26), matching as `{connected}`, inside the read area, block budget per step, sliced per tick. Answer: mask per touched section ("full" when all 4096), bounding box, count, frontier faces where the fill stopped at the read edge or the budget.
7. `expand`: by `"frontier"`, direction and chunk count, or box; grows the read area and resumes a fill with a frontier.
8. JUnit: parity with the TS `{connected}` on the same blocks at each connectivity (share fixtures with W's vectors), frontier detection, mask encoding. GameTests across chunk edges and over several ticks.

**M3 snapshots**

9. `snapshot` with `mask` (sections plus margin) and `coarse` (2³ or 4³ cells, the most common non-air block per cell). GameTests for both.

## Files you own

New classes in `mod/common/.../world/` (e.g. `MaterialSearch`, `WorldFill`, `ReadArea`), the `search`/`fill`/`expand` dispatch in `WorldModule`, the snapshot changes in `WorldReads`, config keys, their tests and GameTests.

## Done when

The *Testing* JUnit and GameTest items for search, fill and expand pass, with timings logged (Z1 reads them); `18`'s pieces 2–4 mod rows marked built.
