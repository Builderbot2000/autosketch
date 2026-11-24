---
name: select
description: "How to go from the player's words (\"the mossy stone brick house\", \"this hill\") to an agreed shape in the world: find, propose, grow, look and trim, confirm; terrain from a starter volume; asking by multiple choice. (Method for building with Autosketch: suggestions to weigh, not rules.)"
---
<!-- Generated from library/knowledge/skills/select.md by `npm run package:plugin`; edit that file instead. -->
# Select something in the world

A way to answer an in-game select request (`/autosketch select [text]`). It's here to use, adapt or skip; edit it to suit how you like to work.

Why it exists: a picture of the area finds nothing that is covered (trees, roofs, overhangs, underground), and a box never fits a building. Materials can't hide, and connectivity follows the shape. So search first, grow the shape second, and look last. The tools report where materials are and what connects; none of them decides what counts as the building. You judge, the player confirms.

## The loop
1. **Find.** Work out materials from the words: "stone brick" means stone bricks and their mossy, cracked and chiseled variants. Look them up yourself (`palette_sheet` with `similar:<id>` or `family:<id>`), then `world_search({materials})` with block ids, `family:<id>` or tags. Never ask the player for ids. The answer is a per-chunk heat map and a list of clusters with distances and bearings. A cluster still *open* may be only the near edge of something larger. With no words, start from the block under the crosshair (the event names it).
2. **Propose.** Pick the likeliest hits, usually the nearest and the densest, and ask with `world_reply({choices})`: "mossy stone brick house, 40 blocks north-east", "ruin, 180 blocks west", "neither, let me describe it". Give a hit as `{text, at: box}` (the cluster's box from the search) and it is pulsed in the world, so the player can turn and see what "[2]" means. If the words point somewhere particular ("the biggest", "the one by the river"), `world_search({continue: true})` walks on for more clusters before you ask.
3. **Grow.** `world_fill({seed, match})` from a block in the chosen hit, matching the materials you searched for (or the seed's family). It defaults to 26 neighbours, so diagonal walls and stairs stay whole; try 6 if it leaks along corners. If the answer reports a frontier, the shape was cut off at the edge of what was read: `world_expand({by: "frontier"})` and the fill carries on. Stop expanding once the shape is clearly right.
4. **Look and trim.** `render({view: "world", region: {dilate: "candidate", by: 8}, fade: "candidate"})` shows the candidate solid among faded surroundings. Look at the edges:
   - Leaks: the shape running into terrain, a path or a neighbour. Cut with boxes, planes or `{subtract}`, or fill again with fewer materials.
   - Left out: a roof in another material, a porch, a chimney. Highlight the solid blocks touching the candidate but not in it (`{filter: {subtract: [{dilate: "candidate", by: 1}, "candidate"]}, air: false}`) and add the materials that belong.
   - Check positions in text before cutting: `view_slice({view: "world", axis: "y", at})` gives exact coordinates, `raycast` names the block under a pixel.
   Name each cut with `select({view: "world", sel: {freeze: {subtract: ["candidate", <box>]}}, name: "candidate"})` (frozen, since a selection can't name itself). As many rounds as it takes; each one is cheap.
5. **Confirm.** Ask "is this it?" with `world_reply({choices})`, the in-world outline showing the player what you mean. On a yes, `world_volumes({from: "candidate"})` sets the work volume to the candidate's box and the context around it; the shape stays as the selection `candidate`, a guide for where to work. If the box is too large for a work volume, propose a part to work on first, or split the work into sandboxes.

## Terrain
Hills, cliffs, riverbanks and caves don't fill well: stone, dirt and grass connect to everything. Start from a **starter volume** instead: a box or shape around the feature, from the crosshair, the player's words or a surface map, read with `world_view_read`. Then cut it down:
- by height with `{layer}`, by slope or exposure with `{filter}`, by planes and polygons;
- subtract what isn't part of the feature (the next hill, the trees on it, the river);
- render the cut in isolation after each change, with `fade` to see what you dropped.
Ask the player when the edge is a matter of taste ("down to the waterline, or the whole slope?").

## Asking
- Multiple choice first, free text always open (`world_reply({choices})` adds "or type your own answer").
- Name choices in the player's terms: what it looks like, how far, which way. Not coordinates or ids.
- One question at a time. Each answer either narrows the search or changes the cut; say which you did.
- The player sees the outline in the world, so "the outlined part" is something they can check by turning around.

## Notes
- Reads reach a fixed square of chunks around where the player stood when asking (the event gives its bounds); each read is capped by `contextCap`. Large shapes read coarse first; re-read the part you zoom into at full detail.
- Select is read-only: nothing is built, not even in a sandbox. The player's next request (`/autosketch build …`) starts the work.
