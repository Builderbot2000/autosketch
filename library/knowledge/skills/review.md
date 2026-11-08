---
kind: skill
name: Review a build
tags: [general, review, workflow, extension]
summary: A pass for checking your own work before calling it done: what changed, where new meets old, and how to look closely enough to see it.
---
A method for reviewing a build, especially an addition to an existing one. It's here to use, adapt or skip; edit it to match how you like builds checked.

Why it exists: a first pass usually confirms that the build *built* (it's connected, the floors line up, the doors open) rather than that it *looks right*. Full-build renders hide detail at about 10 px per block, and you tend to see what you meant to build. The steps below swap in a different way of looking.

## 1. Start from a checkpoint
- Before the first edit, `checkpoint` the starting state (e.g. `original`). Every later step compares against it.
- Check that it is still there before relying on it (`history`); if it isn't, fall back to `diff` with `op:-n`.

## 2. Measure what changed (cheap, and catches the most)
- `diff({since:"checkpoint:original"})` lists blocks added, removed and replaced by material family, and the regions they're in.
- **Read the removed and replaced lines first.** On an addition, every removed block from the original build is either intended (a wall knocked through for a door) or damage: half a window, a shutter left without its pair, decoration now stuck to the new wall. Account for each one.
- `render({highlight:{since:"checkpoint:original"}})` or `diff({..., render:true})` shows where those changes sit.

## 3. Check the structure
- `analyze`: one connected group? Anything floating (lanterns hanging under nothing, a corbel with nothing above it)? Enclosed air where you expect rooms, none where you don't.
- `view_slice` through each place two parts meet: floors at the same levels, openings that go all the way through, no double floors or doubled beams.

## 4. Look closely where new meets old
- Render each junction up close: a custom view with `target` on the seam and a small `distance` (about 14–18) gives roughly 30 px per block. A whole-build render won't show seam problems.
- Look from a low angle (small or negative `pitch`) at jetties, eaves and overhangs; that's how they're seen from the ground.
- Use `cutaway` through the middle of the addition to check the inside.

## 5. Compare against the existing build's own vocabulary
Ask these with the original in view; the answers come from that build, not from a style guide:
- Does the addition reuse the original's details: window width and framing, shutter and sill style, beam spacing and thickness, trim and edge materials?
- Do its horizontal lines (base course, beam heights, eave line) carry on from the original's, or start at new heights?
- Is anything thicker, denser or plainer than its counterpart on the original (a beam band three blocks deep where the original uses one; a window filling its whole bay where the original leaves wall around it)?
- Does it read as part of the original, or as something placed beside it? Shared walls, a roof that runs into the addition, and continuous base and beam lines tie the two together.

## 6. Optional: a second pair of eyes
If your client can start a reviewer with fresh context (a subagent), give it the brief, the close-up renders and the diff summary, without your reasoning. It isn't anchored on what you meant to build.

## 7. Fix, then repeat steps 2–4
Fixes can cause damage too; a fresh `diff` since the checkpoint shows the whole change at once.
