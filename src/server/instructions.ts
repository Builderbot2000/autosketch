/** Server instructions sent to the client at initialisation (docs/design/01, 03, 06). */
export const INSTRUCTIONS = `Autosketch: build Minecraft schematics with high-level actions, using blocks from the user's own Minecraft instance (modded included).

MATERIALS — choose before building:
1. palette_sheet() shows the overview: one image of the instance's building materials as a grid with chessboard cell ids (columns A…, rows 1…). Rows are grouped by category (the caption lists row ranges). Within a category, neutrals come first, then hue left→right, and light→dark top→bottom, so a rectangular range is a coherent palette.
   Badges: top-left pips = stairs(yellow) slab(blue) wall(red) fence(green); magenta top-right = extra shapes (roof pieces…); bottom-right number = variant count; colour strip = dye series; cyan +n = similar materials folded in.
2. Look closer only when needed: zoom:"C4:H9" (larger tiles, with names), sheet:"family:<id>" (all variants of a material, e.g. Chipped/Rechiseled patterns), "series:<id>" (dye colours), "category:<name>" (every family in a category), "similar:<id>", "filter:mod:<ns> has:stairs cat:<c> text:<word>".
3. palette_pick({sheet, name, roles:{wall:"C4:F6", trim:"B9", roof:"K2:K5", accent:{cells:"R3", variant:"chiseled"}}}) saves a named palette. A range becomes a weighted mix. Roles are free-form; wall/trim/roof/floor/accent/glass/light/foundation are conventional.
4. Later, build actions take materials as "palette:<name>.<role>"; shaped actions (stairs, slabs, walls) automatically use each material's matching shape, skipping materials that lack it.
Prefer materials with stairs/slab pips for roofs and trim. Check a role's available shapes with palette_show.

BUILDING:
1. doc_new({name, size?, front?}) starts a document (saved automatically to the workspace); doc_open/doc_list reopen saved ones. One document is open at a time.
2. Shape with fill({sel, material, mode}) — mode fill|hollow|outline|walls — then add details with set_blocks. replace swaps materials (keep_states for stairs/logs). clear empties a selection.
   sel is a selection: a box {min,max}, a shape ({cylinder}, {sphere}, {polygon}…), a pick ({connected} flood fill, {similar}), a component, or a combination ({union}, {subtract}, {shell}, {expand}, {layer}, {filter}…). Shells follow the shape: fill({sel:{cylinder:{center,radius,height}}, mode:"walls"}) builds a round tower. select({sel, name}) checks what a selection covers and stores it for reuse as sel:"<name>"; "last" is the previous op's selection.
3. Every block argument takes a material: "stone_bricks", "oak_stairs[facing=east,half=top]", "a 70%, b 30%", "palette:<name>.<role>", {gradient}, {noise}, {pattern}. Mixes are deterministic per document seed.
4. Check your work. view_slice({axis:"y", at}) (plan) or axis "z"/"x" (elevations) gives exact text grids: use it for positions. render() draws the real blocks: use it for the look (proportion, gaps, materials blending together, doors and openings) after each major step, and zoom with region or cutaway:{maxY} to inspect details. doc_info summarises the document.
5. Each op is one undo step: undo/redo, checkpoint({name}) before risky multi-step work, restore({name}) to go back, history() to re-orient.
6. Deliver with export: target:"axiom" writes an Axiom blueprint (.bp, shows up in Axiom's blueprint browser), target:"create" writes a structure .nbt there (checked against Create's size limit, with a material list for survival), no target writes to the document's exports/ folder. doc_open({path}) imports an existing .bp/.schem/.nbt to edit.
Register important parts with fill(..., as:"keep") so later work can refer to them; doc_info lists components.
Coordinates never move while you edit: building below 0 (e.g. a roof overhang at x=-1) just extends the bounds into negative numbers. Exports shift the build so its minimum corner is (0,0,0).

COST: the overview is ~1.5k tokens; zoom/family/series sheets are ~0.1–0.5k; palette_pick/palette_show/block_info and all edit results are text (<300); view_slice is ~0.1–1.5k depending on size; render is ~350 tokens per 512px view (the default 4-view sheet at 768px is ~800). query_block/query_column are <50, analyze ~200–400, diff ~100–300: prefer them to another render when the question is exact. Pick from the overview you already have instead of re-requesting it.

CONVENTIONS: X = east(+)/west(-), Y = up, Z = south(+)/north(-). Boxes are inclusive {min,max}. The "front" of a build is south (+Z) unless changed. Stairs "facing" is the direction you walk to climb them.`;
