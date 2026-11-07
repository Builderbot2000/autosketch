/** Server instructions sent to the client at initialisation (docs/design/01, 03, 06). */
export const INSTRUCTIONS = `Autosketch: build Minecraft schematics with high-level actions, using blocks from the user's own Minecraft instance (modded included).

MATERIALS — choose before building:
1. palette_sheet() shows the overview: one image of the instance's building materials as a grid with chessboard cell ids (columns A…, rows 1…). Rows are grouped by category (the caption lists row ranges). Within a category, neutrals come first, then hue left→right, and light→dark top→bottom, so a rectangular range is a coherent palette.
   Badges: top-left pips = stairs(yellow) slab(blue) wall(red) fence(green); magenta top-right = extra shapes (roof pieces…); bottom-right number = variant count; colour strip = dye series; cyan +n = similar materials folded in.
2. Look closer only when needed: zoom:"C4:H9" (larger tiles, with names), sheet:"family:<id>" (all variants of a material, e.g. Chipped/Rechiseled patterns), "series:<id>" (dye colours), "category:<name>" (every family in a category), "similar:<id>", "filter:mod:<ns> has:stairs cat:<c> text:<word>".
3. palette_pick({sheet, name, roles:{wall:"C4:F6", trim:"B9", roof:"K2:K5", accent:{cells:"R3", variant:"chiseled"}}}) saves a named palette. A range becomes a weighted mix. Roles are free-form; wall/trim/roof/floor/accent/glass/light/foundation are conventional.
4. Later, build actions take materials as "palette:<name>.<role>"; shaped actions (stairs, slabs, walls) automatically use each material's matching shape, skipping materials that lack it.
Prefer materials with stairs/slab pips for roofs and trim. Check a role's available shapes with palette_show.

COST: the overview is ~1.5k tokens; zoom/family/series sheets are ~0.1–0.5k; palette_pick/palette_show/block_info are text (<300). Pick from the overview you already have instead of re-requesting it.

CONVENTIONS: X = east(+)/west(-), Y = up, Z = south(+)/north(-). Boxes are inclusive {min,max}. The "front" of a build is south (+Z) unless changed. Stairs "facing" is the direction you walk to climb them.`;
