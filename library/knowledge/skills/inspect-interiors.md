---
kind: skill
name: Inspect interiors and hidden shape
tags: [general, perception, interiors, workflow]
summary: Which render camera shows hidden shape (rooms, the inside of walls, what sits behind a façade), the order to try them, and how to confirm what you see.
---
A way to look at the parts of a build that ordinary views hide: rooms, the inside of thick walls, a stair behind a façade, a loft under a roof. It's here to use, adapt or skip; edit it to suit how you like to look.

Why it exists: the default iso and elevation views show the outside. An interior is enclosed on every side, so from outside you only ever see its shell. Every camera below re-presents the same blocks differently. None of them tells you what anything is: you read the picture.

## Images are for form; numbers are for positions
- Use renders to see overall form and to spot things: a missing floor, a stair that runs into a wall, a room that is too dark or too cramped, furniture floating off the floor.
- Confirm exact positions with text before you edit: `view_slice` (a plan or elevation, one character per block) or `query_column` / `query_block`. A pixel can be a block off, especially in perspective.
- `raycast({view, px, py})` names the block under any pixel of a recent render, including perspective, peeled and exploded ones. Use it to turn "that thing" into a position.

## Cheapest first
1. **Measure.** `analyze` lists enclosed air regions with their boxes. That tells you where the rooms are, how big they are, and where to put a camera, before you spend an image.
2. **Slice.** `view_slice({axis:"y", at})` through a room's floor plus one is often all you need: walls, doors, furniture, stairs, exactly.
3. **Cut it open.** `cutaway: {maxY}` takes the roof and upper floors off; a plane cutaway halves the build. Good for a whole storey at once, seen from above.
4. **Section box.** `section` clips to any selection. Removing one octant (`{"subtract":[<the build's box>, <one corner box>]}`) opens a corner and shows three inside faces with their context. Good for how rooms meet floors and walls.
5. **Near clip.** `near: n` drops the first n blocks from the camera, so the front falls away without choosing a plane. On an elevation, `near: 1` removes the front wall.
6. **Depth peeling.** `peel: 2` shows the second surface along each ray: what stands directly behind a façade, without cutting anything. `peel: 3` goes one surface further. Each extra layer costs one more pass, not more tokens.
7. **Stand inside.** A perspective view `{eye, target}` with the eye in the room shows it the way a player sees it: scale, headroom, what you see coming through a door. `{cubemap: pos}` shows all six directions from one point in one sheet: a whole room at a glance.
8. **Go around.** `{turntable: target}` gives eight views around a target at one zoom: for overall form and for spotting a side you haven't checked.
9. **Pull it apart.** `explode: {axis:"y", at:[...]}` splits a multi-storey build at its floor levels and spreads the storeys apart, so each floor's layout shows from one iso view.

## Placing cameras
- Put the eye where a person would stand: about 1.6 blocks above the floor (feet at y means an eye near y+1). Use block units: an integer is the block's centre, so `[5, 2, 5]` is the middle of block (5,2,5).
- Aim at what you want to judge: a position, an anchor, or `{sel: ...}`, which also frames it.
- The default fov of 70° matches the game. A wider fov (90–110) fits a small room, at the cost of more distortion.
- Save a viewpoint you'll come back to: `camera({name, eye, target})`, then `render({views:[{camera:"name"}]})` after each change. A linked world saves the player's own view as `player`.
- Combine: a perspective view with `peel: 2`, a section box with a turntable, a cubemap in an exploded storey. Mix perspective and orthographic views in one sheet to compare.

## When something looks wrong
- Check it in text before fixing it: slice through it, or raycast the pixel and `query_block` the result.
- After fixing, look again from the same camera (a saved one makes this easy) so the before and after compare directly.
