# 18 — Select

The player asks the agent to work on something in the world, "the mossy stone brick house", "this hill", "the whole castle", and the agent finds it, works out its exact extent, and agrees on that extent with the player before any building starts. `/autosketch select` replaces `/autosketch scan` (`13`, B4), which only gave the agent a top-down skin of the area within render distance and a box of full blocks around the player.

Status: designed with the user 2026-11-22 (*Decisions*). Not built. Builds on `13` (live world, in-game requests, volumes), `16` (in-game UI, overlays, ghosts) and `17` (clickable reply lines, candidates).

## Why scan is replaced

A physical test of scan on Craftoria found three problems:

1. **Pictures find nothing that is covered.** The surface layer keeps one block per column, so a build under trees, overhangs or a roof, or underground, is missing or reads as noise. Pictures are good at confirming *what* something is once its place is known; they are poor at finding *where* it is.
2. **Render distance is too small.** A megabuild reaches past the fog, and the scan grant stopped at render distance (and, before that, at 12 chunks).
3. **Boxes don't fit shapes.** Builds and terrain features are irregular; the grant and the volumes were boxes, so picking "the house" out of everything near it was left to the agent's eye.

The fix is to **search first** (by material, which nothing can hide), **grow the shape second** (by connectivity, the way the magic wand does), and **look last** (to confirm and trim, in a view of the selection alone).

## Principles

1. **Measurements, not opinions.** The mod and the MCP report where materials are and what connects to what. They never decide what counts as a building, which blocks are "player-placed", or where a structure ends. The agent judges; the player confirms.
2. **No built-versus-generated split.** A village house, a ruin and the player's own tower are all just blocks. If the player means one of them, the conversation says which.
3. **Agreement with the player is the goal.** Select is a back-and-forth: the agent proposes, shows, asks, adjusts, until the player acknowledges the selection. The player never types block ids; the agent works them out from words and asks multiple-choice questions when unsure.
4. **The agent has autonomy over the cut.** It starts from a guess, looks at it, judges whether it is over- or under-selected, and changes it, as often as it needs. The tools make each round cheap; they don't prescribe how many rounds.
5. **Advise, don't constrain.** The confirmed shape guides the agent's work; the enforced limit stays a box (*Confirming*).
6. **Cost follows need.** Finding uses block-type lists, not blocks. Full blocks are read only for the shape and a margin, coarse first, full detail where the agent zooms in.

## The workflow

1. **Ask.** `/autosketch select [text]`: "select the mossy stone brick house", "select this hill", or nothing at all (the block under the crosshair is the starting point). Mode `select` is read-only, as `scan` was (`13`, B6).
2. **Find.** The agent works out materials from the words ("stone brick" → stone bricks and their mossy, cracked and chiseled variants, by family) and runs a material search around the player. The answer is a per-chunk heat map of matches. With no text, it starts from the crosshair block instead.
3. **Propose.** The agent picks the likeliest hits (the nearest, the densest) and asks the player with clickable choices: *"[1] mossy stone brick house, 40 blocks north-east ✔ [2] ruin 180 blocks west [3] neither, let me describe it"*. The candidate is outlined in the world as it is proposed.
4. **Grow.** From a seed block in the chosen hit, the mod flood-fills through the chosen materials. When the shape reaches the edge of what has been read, the agent expands (`world_expand`) and the fill carries on.
5. **Look and trim.** The agent renders the selection alone, solid, with its surroundings faded, and checks the edges for leaks (into terrain, into a neighbour) and for parts left out. It adds or drops materials, cuts with boxes or planes, or starts again from another seed. Terrain takes the same loop from a starter volume instead of a fill (*Terrain*).
6. **Confirm.** The agent asks "is this it?" with clickable choices; the player confirms, or says what's wrong and the loop continues. Confirming sets the work and context volumes from the shape. The request then ends like any read-only request: the player's next request (`/autosketch build …`) or `/autosketch done`.

## Already built

- **Magic-wand fill** in documents: `{connected:{seed, match?, connectivity?, within?}}` (`src/ops/selection.ts`), depth-first over 6, 18 or 26 neighbours, matching by block, family, tag or palette role, with a volume limit. The mod's fill (piece 3) uses the same algorithm and options, so "connected" means the same thing in the world and in a document.
- **Selection algebra** (`05`): `{subtract}`, `{dilate}`, `{shell}`, `{filter}`, `{layer}`, boxes, planes, polygons, cylinders. Trimming a candidate is ordinary selection work once the candidate is a named selection.
- **Isolated render**: `render({region: <selection>})` draws only that selection, framed tightly, with `cutaway`, `section` and `highlight` (`06`).
- **Ghosted context**: the renderer draws a sandbox's read-only context desaturated and translucent (`src/perception/render/render.ts`, `context: "ghost"`), for sandboxes only.
- **Clickable reply lines**: a `chat` reply's optional `action` makes one line clickable, running a `ui.request` (`17`, piece 3; `/autosketch action <n>`). A client without the mod gets the same words as plain text.
- **Overlay renderer** (client half, `16`): outlines and pulses drawn at full strength in view and faintly through blocks at any distance (`OverlayRenderer`), used for sandbox jobs. The work volume's own outline is still server-sent dust particles (`Feedback`), capped at 96 blocks and thin at any range.
- **Reads from disk without generating**: surface reads load a fully generated chunk that isn't loaded and list the rest as `missing` (`SurfaceReads`, `13`, B4). Measured cold: 625 chunks in 148–180 ms, about 0.25 ms a chunk.
- **Section block lists**: `LevelChunkSection.maybeHas(Predicate<BlockState>)` tests a 16³ section's palette without reading its blocks. It may say yes for a state no longer present (a palette keeps stale entries until resized) and always says yes for a section on the global palette, so a yes is a "maybe" to confirm and a no is certain.

## New pieces

### 1. Command and mode (mod, MCP)

- `/autosketch select [text]` and `/<alias> select [text]`, mode `select`, read-only (refused edits and drafts, as `scan`). The prompt carries the usual context (position, look, crosshair block, dimension) and **no grant**: what the agent may read is the search area (piece 2), set per request.
- **Select event** (as built, P1, 2026-11-23). A select prompt needs no linked document (like `scan`): the event opens with the player's words (or, with none, the crosshair block as the starting point, or a request to ask the player when there is no block either), the mode line, then the context **in world coordinates** (feet, dimension, facing, the crosshair block and the focus box), since the world view and the select tools take world positions. It states the read square (`13`, *Where the mod serves reads*) as chunk and world bounds computed with the default `selectChunks` 256, saying the mod's config may set less: the mod doesn't tell the MCP its value, and a smaller config only shrinks the square. Then the five steps with their tools, terrain's starter volume, and the usual `world_reply` line. Without the mod's `select` feature it says the select tools are refused and to update the mod, instead of the square and the steps (`13`, *Versions and features*). It names no skill: the server never names skills (`07`); the agent finds `skills/select` through `knowledge_list`. No `focus`, `target` or `player` camera is saved on a linked document, since a select request isn't about the linked volumes. The volume-change refusal in `ask` and `plan` now points the player to `/autosketch select [text]`.
- `/autosketch scan`, mode `scan`, the scan grant, the probe document and the config keys `scanChunks`, `scanChunksMax`, `scanBelow`, `scanAbove`, `scanCap` are removed (*Removal*).

### 2. Material search (mod, wire, MCP tool)

`world_search({materials, radius?, around?})`:

- **materials**: block ids, families (`family:stone_bricks`) or tags; the agent resolves words to these with the registry it already has (`palette_sheet`, `similar:`).
- **radius**: in chunks around the player's chunk (or `around`, a world position), default and cap `selectChunks` 256 (config; interim, until *Measure first*). Not tied to render distance.
- **Nearest first, stopping early.** The mod walks the chunks in rings outward from the centre chunk, loaded ones directly and generated ones from disk without generating (as `SurfaceReads`), sliced per tick. Per section it asks `maybeHas`; on a yes it counts matching blocks in that section (reading only those sections). Matching chunks that touch form **clusters**. A cluster is **closed** once the rings have moved `gap` chunks (default 2) past its edge with no new match touching it; until then it may be only the near edge of a build. The walk stops when `stop` clusters are closed (default 1; the agent asks for more when the player's words suggest a far or particular one, "the biggest", "the one by the river"), or at the radius.
- **Resumable.** A stopped search keeps its place: `world_search({continue: true})` walks on from the ring it stopped at, for the next clusters. The common case (the build is near the player) costs a few rings of loaded chunks; only a miss walks the whole radius.
- **Answer**: per chunk, the count of each material; plus the sections with matches, the clusters (closed or still open at the stopping ring), and the ring the walk reached. The MCP renders it for the agent as a heat-map image (one cell per chunk, the player marked, north up) and a text list of the densest clusters with distances and bearings. Ungenerated chunks are listed as such.
- **Grants**: none of its own. In select mode the mod serves block snapshots (piece 5) anywhere within `selectChunks` of the player, capped per call by `contextCap` (*Decisions*), so terrain starter volumes need no search.
- **As built (T1, 2026-11-23).** `world_search({materials, radius?, around?, stop?, continue?})` (`src/server/tools/world-select.ts`, logic in `src/world/select/`, state on `Session.worldSelect`). Each material is resolved as given and checked against the registry, never guessed: an id (namespace optional) must be a block, a state is canonicalised, `#tag` must have blocks, and `family:<id>` becomes every block the palette maps to that family (base, shapes, variants and their shapes, aliases, extras: what `{connected}`'s family match means), named by its base or any member. One error names every unresolved material and nothing is sent. The wire list is the groups' entries in order, each once, so the mod's per-material counts fold back into the agent's groups (a block counts under the first). `stop` is exposed (the agent asks for more clusters when the player's words point far); `gap` stays the mod's. The text lists clusters in walk order (nearest first), at most 10, each with closed/open, distance and 8-point bearing from the player to the count-weighted centre of its chunks, its block x/z span, its y range from the matching sections, and counts per group; the largest is marked "densest" and nothing else is ranked. The image is the walked square, one cell per chunk (≤24 px, so a full 256-chunk walk is 513 px at one pixel per chunk), shaded on a log scale, the player's chunk ringed, ungenerated chunks crossed, clusters outlined (closed white, open magenta) and numbered as in the text. The search state belongs to the in-game request (held or open) and is dropped when it changes; every answer replaces it, a continuation's too.

### 3. Fill (mod, wire, MCP tool)

`world_fill({seed, match, connectivity?, budget?})` grows the candidate shape in the world:

- `seed`: a world position (from a heat-map hit, the crosshair, or a block the agent picked in a view). `match` as `{connected}`: the seed's block, its family, a tag, or a list of materials. `connectivity` 6, 18 or 26 (default 26 in the world, so diagonal walls and stairs stay whole; the agent can narrow it).
- **Runs in the mod**, inside the read area, sliced per tick with a block budget per step. Reason: only the mod reaches unloaded chunks, and a megabuild's shape is too large to ship as blocks before knowing it.
- **Answer**: the shape as a mask (per touched section, a 4096-bit set or "full"), its bounding box, block count, and the **frontier**: the boundary faces where the fill stopped at the edge of the read area or the budget, rather than at non-matching blocks. A non-empty frontier means the shape is cut off.
- The MCP names the result `candidate` in the world view (piece 5). Further fills, unions and trims replace or combine it with the selection algebra.

### 4. Expand (mod, wire, MCP tool)

`world_expand({by})`, separate from `volumes.extend` (which stays the narrow rule for doors and multi-blocks cut by the work volume):

- `by`: `"frontier"` (the chunks the candidate's frontier touches), a direction and a count of chunks, or a box.
- Grows the read area; a fill with a frontier resumes from it. Each step keeps its own block budget and tick slicing, so a megabuild grows in rounds and the agent can stop as soon as the shape is clearly right.
- The candidate's overlay (piece 8) updates after each step.

### 5. World view (MCP)

A read-only view of the world held **beside** the open document, not in place of it (the probe replaced it, `Session.adoptTemporary`, and was refused while sandboxes were open).

- `render`, `view_slice`, `raycast`, `select` and `analyze` take `view: "world"` to work on it. Edits are refused there, as on the probe.
- **Contents**: the blocks the agent has asked for. After a fill, the candidate's sections plus a margin (`margin`, default 8 blocks) are read automatically; `world_view_read({sel | box})` reads more (a starter volume, an area around a hit). A read is a block snapshot, capped per call by `contextCap`; the view keeps what it has read for the request.
- **Coarse level**: for a shape over `contextCap`, the read is downsampled, one block per 2³ or 4³ cell, the cell's most common non-air block, so the whole shape can be seen at once. Reading a region again at full detail replaces the coarse blocks there. The render caption says which parts are coarse.
- **Freshness**: a snapshot. Each expand re-reads what it adds, and confirming re-reads the final shape.
- **Coarse, as built (V2, 2026-11-23).** `world_view_read` goes coarse by itself: a read over `contextCap` (the MCP's assumed cap), or one the mod answers `too_large` (its own cap may be lower), is sent as `snapshot` kind `coarse` with the smallest cell, 2 then 4, whose cell count fits the cap (the next on another `too_large`); past 4³ it is refused (`world_view_too_large`) and the agent reads part of it. Each cell's block is written over the **whole cell** at its world positions, so world coordinates, selections, slices and raycasts stay true and a full read lines up with it (the cells sit on the world grid). A full read replaces coarse cells; a coarse read **never overwrites positions already read at full detail** in the request (re-reading a large overview shouldn't throw away the detail the agent asked for; read at full detail again to refresh). The view records each read's level, and `render({view:"world"})` names the coarse parts that meet the drawn box in its caption (`RenderOptions.coarse`), marking those partly replaced. Whole-cell writes cost memory and render time per block, not per cell; *Measure first* (3) says whether 4³ needs a sparser form.
- **As built (V1, 2026-11-23).** The view is an ordinary read-only `Document` whose local coordinates are world coordinates (its `origin` keeps store coordinates near the player, inside the voxel store's range), so the five tools work on it unchanged and its named selections live in its `selections`. Reasons: no second renderer or selection path, and positions the agent reads off the view are the positions the mod's requests take. Edits on it are refused by a write guard (`world_view_read_only`), which covers ops, scripts, undo and restore alike. It belongs to the in-game request that is held or open (`InGameRequests.heldRequest`, else the open stream) and empties itself when that changes or ends, rather than through a hook in the request code. `select({view:"world", name})` changes no document, so it needs no `scope` while sandboxes are open (the tool wrapper doesn't count a `view: "world"` call as mutating). Its render ids are `w1`, `w2`, … so `raycast` can tell a view render from a document render by the id alone (its existing `view` argument is the render id; `"world"` names the latest). `world_view_read({box | sel})` reads one box (a selection's bounding box, resolved in the view) with today's blocks `snapshot`, refused past `contextCap` (the mod's default, 4,194,304, since the MCP isn't told the mod's value) until V2's coarse level; the dimension is the request's prompt context, else the linked volumes'.

### 6. Isolated render with faded surroundings (MCP)

- `render({view:"world", region:<sel>, fade:<sel>})`: `region` as today; `fade` draws everything **outside** that selection desaturated and translucent (the sandbox ghost style), so `region: {dilate:"candidate", by:8}, fade: "candidate"` shows the candidate solid among its faded surroundings. A small generalisation of the sandbox context mode.
- **Left-out neighbours**: `highlight: {filter: {subtract:[{dilate:"candidate", by:1}, "candidate"]}, air: false}` tints the solid blocks touching the candidate but not in it, where over- and under-selection show. Expected to work with the existing algebra once the view exists; to be tested, not built.
- **As built (V2, 2026-11-23).** `fade` is `RenderOptions.fade`, a mask, on any document (the world view or an open one): the renderer's ghost flag (`CONTEXT`) now marks a sandbox's context or a position outside `fade`, and a ghosted block never hides a solid one's faces, as context never did. The caption counts the faded blocks and the solid ones. The left-out-neighbour highlight needed no change; the syntax above was corrected (the algebra writes `{dilate:a, by:n}` and `{filter:a, air:false}`, not arrays).

### 7. Choices in chat (MCP, wire, mod)

`world_reply({choices: ["…", "…"], …})`: each choice is its own clickable line (`chat` `action`, `17`); a click sends the choice's text to the agent as the player's answer, as candidate picks do (`17`, piece 5). One extra line, *"or type your own answer"*, keeps free text open. A client without the mod sees numbered lines and answers by typing the number.

One action per `chat` message stays the rule (`17`, piece 3): choices go out as one message per line.

### 8. Outlines in the world (mod client, MCP)

- **The candidate** is drawn by the overlay renderer, visible at any distance and through blocks. Near range: the boundary edges of each touched section's mask. Far range: a **tinted shell**, the outer faces of the 16³ sections the shape occupies, translucent (faces between two occupied sections skipped, so the tint never doubles), so a shape spanning hundreds of chunks is one solid-looking volume rather than thousands of lines. Colour distinct from work (and from sandbox jobs).
- **Tinted boxes exist as pulses** (`DrawList.Pulse`, drawn as faces through blocks by `OverlayRenderer`, `XRAY_QUADS`), but a pulse fades over a flash's life. New: a steady fill record beside `Outline` and `Pulse`, drawn by the same code at a constant alpha. The MCP computes the shell's faces (the client stays thin, `16`) and sends them as faces merged into rectangles.
- **Work and context volumes** move from dust particles to the overlay renderer too, with lines thick enough to see at distance. Particles stay only as the fallback for players without the client half (`16`, single-player focus allows the client half as the norm).
- Heat-map hits the agent proposes can be pulsed in the world when offered as choices, so "[2] ruin 180 blocks west" is something the player can turn and see.

### 9. Confirming (MCP, wire)

`world_volumes({from: "candidate", margin?})`:

- **Work volume** = the candidate's bounding box (enforced, as today). The shape itself is kept as the named selection `candidate` in the linked document, the agent's guide for where to work (*Advise, don't constrain*).
- **Context** = the work box grown by `margin` (default 8).
- **Too large**: a candidate whose box is over `contextCap` can still be selected and confirmed as a whole, but the work volume can't hold it. The agent proposes a part to work on, or splits the work into sandboxes (`11`). The cap is not raised.

### 10. Terrain

Material fills leak through terrain (stone, dirt and grass connect to everything), so terrain starts from a **starter volume** instead: a box or shape the agent chooses around the feature (from the crosshair, the player's words, a surface map), read into the world view. The agent then cuts it with the selection algebra: by height (`{layer}`), by slope or exposure (`{filter}`), by planes and polygons, subtracting what isn't part of the feature, rendering the cut in isolation after each change, and asking the player when unsure. The same view, fade, choices and confirm apply. The surface map (one block per column) remains available as a read for this, not as an automatic part of every request.

**Surface read, as built (V2, 2026-11-23).** `world_view_read({surface: box})` sends today's surface snapshot over the box's columns and writes each column's topmost non-air block at its own height, kept only when that height lies within the box's y range (the others are counted as left out, so a box under a tree canopy doesn't jump to the canopy). Only the top block is known, so a surface read doesn't count as holding its columns (`WorldView.has`); capped at `contextCap` columns.

## Removal

- Mod: `ScanGrants`, the `scan` grant reads in `SurfaceReads` and `WorldReads` (surface reads stay for piece 10), `InGamePrompts.scan`, the `scan` subcommand, the `[scan]` config section, its lang keys and GameTests.
- MCP: `src/world/probe.ts`, the `scan` mode and its prompt handling, `Session.adoptTemporary` if nothing else uses it, the probe's tests and golden vectors.
- Wire: mode `scan` and `prompt.scan` retired in a protocol bump; mode `select` and the new requests added (*Wire*).
- Docs: `13`'s B4 and its *Measured* and *Implementation status* rows point here.

## Wire

New requests (MCP → mod, with ids, served in arrival order as `13`'s other requests): `search`, `fill`, `expand`, and `snapshot` gaining `mask` (sections plus margin) and `coarse` (cell size). Their answers carry the shapes above. Mode `select` in `prompt`; `prompt.scan` gone (R1). Golden vectors for each. The exact schemas are in `13`, *Message schemas*, *Select* (mod feature `select`, added within protocol 3), and the read grant in `13`, *Where the mod serves reads*.

Details fixed with the wire (step W1, 2026-11-23), each the simplest reading of the pieces above:

- **Materials on the wire** are block ids (any state), canonical states, block tags `#ns:path`, and for a fill `solid`. The MCP resolves words and families into them; the mod knows no families.
- **The search** walks rings in index order and counts each block once, under the first material it matches. Clusters are chunks touching by an edge or a corner; a cluster is closed once the walk has completed `gap` rings past its farthest ring. Every answer, a continuation's too, covers the whole walk so far, so the MCP replaces rather than merges.
- **The fill's read area** is a set of whole chunk columns, held by the mod with the grant: a `fill` starts it at the chunks within `area` (default 1) of the seed's chunk and replaces the previous fill; `expand` grows it (by the frontier's chunks, a direction, or a box) and resumes from the frontier with a fresh budget, answering with the changed sections only. The budget counts the seed. An ungenerated chunk stops the fill like non-matching blocks and is listed, since expanding can't read it.
- **The mask snapshot's margin** is measured from the sections' boxes, not the shape's blocks, so the request carries no mask, and it is answered as an ordinary blocks snapshot whose regions follow one layout rule on both sides. **Coarse cells** sit on the world's grid (boxes grown outward to multiples of the cell), so a region read twice lines up; ties go to the state met first in the cell.
- **`no_grant`**, a new error code, refuses `search`, `fill` and `expand` while no select request's grant is in force.

## Measure first

On the Craftoria test server, before fixing defaults:

1. **Search**: cold `maybeHas` walk at 64 and 256 chunks (256 is the interim default; a full walk happens only on a miss), and the time to the first closed cluster for a build near the player (time, tick impact), and how often real terrain's sections answer "maybe" for common building materials.
2. **Fill**: a large build (tens of millions of blocks) filled in rounds: time per round, mask size on the wire.
3. **Coarse view**: transfer and render time of that build at 4³ cells, and how legible the render is.

## Testing

- JUnit: section walk with `maybeHas` (no false negatives), fill parity with `{connected}` on the same blocks at each connectivity, frontier detection, mask encoding.
- GameTests: search over loaded and unloaded generated chunks with ungenerated ones listed; fill and expand across chunk edges; budgets sliced over ticks; `world_volumes({from:"candidate"})`; refusals.
- Unit (MCP): heat-map image and cluster text, world view beside an open document and with sandboxes open, `fade`, coarse replacement by full detail, choices as lines and as text.
- Client suite: candidate outline near and far, volumes drawn without particles, choice clicks.
- End to end (world tier): "select the mossy stone brick house" on a test world with two candidate houses and a ruin, through to confirmed volumes.

## Implementation status

The select set's briefs are `docs/briefs/select/`; each silo updates its own rows.

| Piece | Silo | Status |
|---|---|---|
| *Wire*: mode `select`; `search`, `fill`, `expand`; snapshot `mask` and `coarse`; the select-mode read grant | W (W1) | Built, wire only. Schemas in `13`, *Select*; codecs in `src/world/protocol/` and `mod/…/protocol/SelectMessages.java`; golden vectors in `test/data/world-protocol/` (and `mask-regions.json`); the fake host answers all of it (`test/support/fake-select.ts`), its fill with `{connected}`'s algorithm (parity tested at 6, 18 and 26). The bridge refuses the requests unsent (`world_mod_outdated`) without the mod feature `select` |
| *Wire*: choice kind, steady fill record, volume lines | W (W2) | Not started |
| 1. Command and mode | C (C1), P (P1) | Wire built (W1). MCP built (P1): `select` read-only and volume-changing in `src/world/modes.ts` with its own mode line and refusal wording; the bridge's hello lists `select` by default (`DEFAULT_MODES`); `InGameRequests.onSelect` and `selectText` in `src/world/prompt.ts` deliver a select prompt without a link, a probe or any read (*Select event*, below), hold the mode, attach the write guard to a linked document, and end the text with the component set's reminder line. Tests in `test/unit/world/prompt.test.ts` (exact event text with words, crosshair only, neither, with the reminder, without the mod's `select` feature; edits and drafts refused, `world_volumes` passing the mode rule, `/autosketch done` ending it). Command (C1) not started |
| 2. Material search | M (M1), T (T1) | Wire and fake host built (W1). Tool built (T1): `world_search` with materials resolved as given, heat-map image, cluster text and `continue` (piece 2, *As built (T1)*); tested against the fake host (`test/unit/world/world-search.test.ts`). Mod not started |
| 3. Fill | M (M2), T (T2) | Wire and fake host built (W1); mod and tool not started |
| 4. Expand | M (M2), T (T2) | Wire and fake host built (W1); mod and tool not started |
| 5. World view (with snapshot `mask` and `coarse`) | V (V1, V2), M (M3) | Wire and fake host built (W1). Built on the MCP (V1, V2): `world/view.ts` (`WorldView` on `Session.worldView`, wired in `server/index.ts`), `view: "world"` on `render`, `view_slice`, `raycast`, `select`, `analyze` (`tools/perception.ts`, `tools/edit.ts`, `tools/world-view.ts`), `world_view_read({box \| sel \| surface})`; the coarse level (V2: reads over `contextCap`, or answered `too_large`, go coarse at 2³ then 4³ cells; full reads replace coarse cells; the render caption names the coarse parts). Tests: `test/unit/world/world-view.test.ts` (beside the linked document, with a sandbox open, edits refused, selections stored and reused, emptied on a new request, the cap, coarse reads and their replacement by full detail, the `too_large` fallback). Mod side (M3) not started |
| 6. Isolated render with faded surroundings | V (V2) | Built: `render({fade})` (`perception/render/render.ts`, `RenderOptions.fade`; the ghost flag now covers a sandbox's context and everything outside `fade`, on any document). The left-out-neighbour highlight works with the existing algebra (no change needed; the spec's syntax corrected). Tests: `test/unit/perception/render-fade.test.ts`, `test/unit/world/world-view.test.ts` |
| 7. Choices in chat | W (W2), P (P2), C (C1) | Not started |
| 8. Outlines in the world | W (W2), C (C2, C3), P (P3) | Not started |
| 9. Confirming | T (T3) | Not started |
| 10. Terrain | V (V2), P (P1) | Wire built (W1: surface snapshots inside the select grant). Agent guide built (P1): the starter skill `skills/select` (`library/knowledge/skills/select.md`, also generated into the Claude Code plugin's skills): the workflow, terrain from a starter volume, multiple-choice asking, never asking for ids; advisory, found through `knowledge_list` like the other skills. Surface read built (V2): `world_view_read({surface: box})` writes each column's top block into the world view. |
| *Removal* | R (R1) | Not started |
| *Measure first* | Z (Z1) | Not started |
| *Testing*, end to end | Z (Z2) | Not started |

## Open questions

- **Search radius**: `selectChunks` 256 is the interim default and cap; *Measure first* says whether a cold walk at 256 is acceptable or the default should drop.

## Decisions

Settled with the user 2026-11-22:

- **Replace scan, don't patch it.** The render-distance cap fix was discarded in favour of this.
- **Name**: `/autosketch select`.
- **Materials from words**: the agent infers ids from the player's description and the nearest matches; it never asks the player for ids. Clarification is by clickable multiple choice, back and forth until the player acknowledges the selection.
- **Expand past the edge**: a cut-off shape grows the read area, agent-controlled (`world_expand`), separate from `volumes.extend`. The search radius is not bounded by render distance.
- **Isolated 3D view for the agent**, not the player (the player sees the in-world outline). It sits beside the open document.
- **Terrain**: the agent takes a starter volume, looks at its cut in isolation, judges and adjusts it, asking the player as it goes.
- **No built-versus-generated split.**
- **Work volume = bounding box, enforced; the shape guides.** A selection larger than the cap is allowed; the work volume isn't raised to fit, the agent works on a part or uses sandboxes.
- **Search radius**: 256 chunks as default and cap for now.
- **Reads in select mode** (2026-11-23): block snapshots anywhere within `selectChunks` of the player, capped per call by `contextCap`, so a starter volume for terrain needs no search; a search grants nothing further. Recorded in `13` (*Where the mod serves reads*), where "the player" is the chunk of the select prompt's position, fixed when the prompt arrives (step W1): the MCP then knows the bounds from the prompt alone, and the player walking toward the build doesn't move what was granted. Surface snapshots are served there too (piece 10).
- **Search nearest first and stop early**: rings outward from the player, stopping once enough clusters are closed, resumable for more, so 256 is only walked on a miss.
- **Huge shapes drawn as a tinted shell** of their sections, using the overlay's existing through-blocks faces with a steady (non-fading) fill.
- **In-world outlines for the candidate in the first version**, and the work and context particle outlines replaced by overlay lines visible at distance.
- **Connectivity**: the same fill as the magic wand (`{connected}`), 26 neighbours by default in the world.
- **Defaults the agent may change**: the crosshair block as seed when there is no text; an 8-block margin for fade and context; re-read on expand and on confirm.
