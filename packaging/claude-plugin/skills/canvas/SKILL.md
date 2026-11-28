---
name: canvas
description: "How to work when the player has set a large canvas: look at the whole canvas first, then place the brush (the work volume) over one coherent part, finish it, and move on; reading outside the brush, and when to ask. (Method for building with Autosketch: suggestions to weigh, not rules.)"
---
<!-- Generated from library/knowledge/skills/canvas.md by `npm run package:plugin`; edit that file instead. -->
# Work across a canvas

A way to work inside an in-game canvas. It's here to use, adapt or skip; edit it to suit how you like to work.

Why it exists: the canvas is the area you may look at; the brush (the work volume) is the much smaller area you can change at once. With a large canvas it's easy to start editing wherever the brush happens to be, or to plan from one close-up view. Looking at the whole first, then choosing where the brush goes, keeps each stroke about one thing.

## The loop
1. **Look at the whole canvas.** `world_map()` draws it from above, one cell per chunk, shaded by surface height, with the brush, its context, open jobs and the player marked and a grid in local coordinates. The text gives the canvas size, the height range and where the brush and player are. It reports measurements only: what the heights mean (a hill, a building, a wall) is yours to judge.
2. **Look closer where it matters.** `world_view_read({box})` or `{surface}` reads any part of the canvas (coarse past the per-read cap; read again smaller for full detail), then `render({view: "world"})`, `view_slice({view: "world"})` and `camera` show it. `world_search` finds materials anywhere in the canvas, `world_fill` follows a shape.
3. **Choose one coherent part.** A part you can finish in one go: one building, one wing, a stretch of wall, a garden. Prefer a part whose edges fall where the work naturally stops (a corner, a change of height, a gap) over one cut by the cap.
4. **Place the brush there.** `world_volumes({work, context})` inside the canvas, in local coordinates, without asking the player each time; or keep a part of a confirmed shape (`select({view: "world", sel: {freeze: {intersect: ["candidate", <box>]}}, name: "part"})`) and `world_volumes({from: "part"})`. Coordinates don't move with the brush: a plan written in local coordinates stays valid after every move.
5. **Work, check, move on.** Build and review inside the brush as usual (`render`, `view_slice`, the review skill). Then `world_map()` again to see what's done and choose the next part.

## Notes
- Document reads (`query_*`, `view_slice`, `render`) reach the canvas outside the brush too; those parts are read through the world view, read-only and possibly stale (the result's `world:` line says so). Edits stay inside the brush.
- An undo of a stroke outside the current brush asks you to move the brush back there first.
- Split a part into sandboxes (`scope_fork`) only when one part is still too big to keep in mind; open jobs show on the map.
- Ask the player when the choice is a matter of taste or intent ("start with the gatehouse or the keep?"), in their terms, with `world_reply({choices})`. Placing and moving the brush itself needs no permission.
- The canvas is the player's: they set, grow and clear it (`/autosketch canvas …`). If it's too small for what they asked, say so and let them grow it.
