/**
 * Pre-1.13 numeric block id + data value → modern block state, for legacy MCEdit `.schematic`
 * files (docs/design/08-formats.md). A small hand-written table, not a full flattening map: it
 * covers the vanilla blocks of 1.12 with their common variants and orientations, targeting 1.21
 * names. The importer keeps ids it doesn't know as visible `legacy:id_<id>[data=<d>]` blocks.
 *
 * A table entry is either a name (the data value carries nothing we map) or a function of the
 * data value. Functions return undefined for a data value they don't understand; the importer
 * then falls back to the block's first variant and warns.
 */

export type LegacyEntry = string | ((d: number) => string | undefined);

const COLORS = ["white", "orange", "magenta", "light_blue", "yellow", "lime", "pink", "gray", "light_gray", "cyan", "purple", "blue", "brown", "green", "red", "black"];
const WOODS = ["oak", "spruce", "birch", "jungle", "acacia", "dark_oak"];
/** Data 2..5 → facing, as chests, furnaces, ladders, wall signs and dispensers use it. */
const FACE_2_5: Record<number, string> = { 2: "north", 3: "south", 4: "west", 5: "east" };
/** Data 0..3 → facing, as pumpkins, beds, fence gates and glazed terracotta use it. */
const FACE_SWNE = ["south", "west", "north", "east"];
/** Data 0..5 → facing, as pistons, dispensers, droppers, observers and end rods use it. */
const FACE_6 = ["down", "up", "north", "south", "west", "east"];

/** Stone slab materials by data value (low 3 bits); 1.12's "stone" slab is 1.14+'s smooth stone slab. */
const SLABS = ["smooth_stone_slab", "sandstone_slab", "petrified_oak_slab", "cobblestone_slab", "brick_slab", "stone_brick_slab", "nether_brick_slab", "quartz_slab"].map((n) => `minecraft:${n}`);
const DOUBLE_PLANTS = ["sunflower", "lilac", "tall_grass", "large_fern", "rose_bush", "peony"];

const pick = (names: string[]) => (d: number) => names[d];
const colored = (suffix: string) => (d: number) => `minecraft:${COLORS[d & 15]}_${suffix}`;
const facing = (name: string, table: Record<number, string> | string[], mask = 7, extra = "") => (d: number) => {
  const f = (table as Record<number, string>)[d & mask];
  return f ? `${name}[facing=${f}${extra}]` : undefined;
};

function stairs(name: string) {
  const f = ["east", "west", "south", "north"];
  return (d: number) => `${name}[facing=${f[d & 3]},half=${d & 4 ? "top" : "bottom"}]`;
}
function slab(names: string[], double = false) {
  return (d: number) => {
    const n = names[d & 7];
    return n && `${n}[type=${double ? "double" : d & 8 ? "top" : "bottom"}]`;
  };
}
function log(names: string[]) {
  return (d: number) => {
    const n = names[d & 3];
    if (!n) return undefined;
    const a = d >> 2;
    return a === 3 ? `${n}_wood[axis=y]` : `${n}_log[axis=${["y", "x", "z"][a]}]`;
  };
}
function leaves(names: string[]) {
  return (d: number) => {
    const n = names[d & 3];
    return n && `${n}_leaves[persistent=${d & 4 ? "true" : "false"}]`;
  };
}
function axisBlock(name: string) {
  return (d: number) => `${name}[axis=${["y", "x", "z"][(d >> 2) & 3] ?? "y"}]`;
}
function torch(wall: string, floor: string, extra = "") {
  const f: Record<number, string> = { 1: "east", 2: "west", 3: "south", 4: "north" };
  return (d: number) => (d === 5 || d === 0 ? (extra ? `${floor}[${extra.slice(1)}]` : floor) : f[d] ? `${wall}[facing=${f[d]}${extra}]` : undefined);
}
function trapdoor(name: string) {
  const f = ["north", "south", "west", "east"];
  return (d: number) => `${name}[facing=${f[d & 3]},half=${d & 8 ? "top" : "bottom"},open=${d & 4 ? "true" : "false"}]`;
}
function gate(name: string) {
  return (d: number) => `${name}[facing=${FACE_SWNE[d & 3]},open=${d & 4 ? "true" : "false"}]`;
}
function button(name: string) {
  const at: Record<number, [string, string]> = { 0: ["ceiling", "north"], 1: ["wall", "east"], 2: ["wall", "west"], 3: ["wall", "south"], 4: ["wall", "north"], 5: ["floor", "north"] };
  return (d: number) => {
    const a = at[d & 7];
    return a && `${name}[face=${a[0]},facing=${a[1]},powered=${d & 8 ? "true" : "false"}]`;
  };
}
const RAIL_SHAPES = ["north_south", "east_west", "ascending_east", "ascending_west", "ascending_north", "ascending_south", "south_east", "south_west", "north_west", "north_east"];
function rail(name: string, powerable: boolean) {
  return (d: number) => {
    const s = RAIL_SHAPES[powerable ? d & 7 : d];
    if (!s || (powerable && (d & 7) > 5)) return undefined;
    return `${name}[shape=${s}${powerable ? `,powered=${d & 8 ? "true" : "false"}` : ""}]`;
  };
}
/** Doors: the lower half's data holds facing and open, the upper half's holds hinge; the importer merges them. */
function door(name: string) {
  const f = ["east", "south", "west", "north"];
  return (d: number) =>
    d & 8
      ? `${name}[half=upper,hinge=${d & 1 ? "right" : "left"},powered=${d & 2 ? "true" : "false"}]`
      : `${name}[facing=${f[d & 3]},half=lower,open=${d & 4 ? "true" : "false"}]`;
}
const age = (name: string, max: number) => (d: number) => (d <= max ? `${name}[age=${d}]` : undefined);

/** The table. Ids 0–255 as used by Minecraft 1.12; colours of beds and banners live in block entities and default here. */
export const LEGACY_BLOCKS: Record<number, LegacyEntry> = {
  0: "minecraft:air",
  1: pick(["stone", "granite", "polished_granite", "diorite", "polished_diorite", "andesite", "polished_andesite"].map((n) => `minecraft:${n}`)),
  2: "minecraft:grass_block",
  3: pick(["minecraft:dirt", "minecraft:coarse_dirt", "minecraft:podzol"]),
  4: "minecraft:cobblestone",
  5: pick(WOODS.map((w) => `minecraft:${w}_planks`)),
  6: (d) => (WOODS[d & 7] ? `minecraft:${WOODS[d & 7]}_sapling` : undefined),
  7: "minecraft:bedrock",
  8: (d) => `minecraft:water[level=${d & 15}]`,
  9: (d) => `minecraft:water[level=${d & 15}]`,
  10: (d) => `minecraft:lava[level=${d & 15}]`,
  11: (d) => `minecraft:lava[level=${d & 15}]`,
  12: pick(["minecraft:sand", "minecraft:red_sand"]),
  13: "minecraft:gravel",
  14: "minecraft:gold_ore",
  15: "minecraft:iron_ore",
  16: "minecraft:coal_ore",
  17: log(["minecraft:oak", "minecraft:spruce", "minecraft:birch", "minecraft:jungle"]),
  18: leaves(["minecraft:oak", "minecraft:spruce", "minecraft:birch", "minecraft:jungle"]),
  19: pick(["minecraft:sponge", "minecraft:wet_sponge"]),
  20: "minecraft:glass",
  21: "minecraft:lapis_ore",
  22: "minecraft:lapis_block",
  23: facing("minecraft:dispenser", FACE_6),
  24: pick(["minecraft:sandstone", "minecraft:chiseled_sandstone", "minecraft:cut_sandstone"]),
  25: "minecraft:note_block",
  26: (d) => `minecraft:red_bed[facing=${FACE_SWNE[d & 3]},part=${d & 8 ? "head" : "foot"}]`,
  27: rail("minecraft:powered_rail", true),
  28: rail("minecraft:detector_rail", true),
  29: facing("minecraft:sticky_piston", FACE_6),
  30: "minecraft:cobweb",
  31: pick(["minecraft:dead_bush", "minecraft:short_grass", "minecraft:fern"]),
  32: "minecraft:dead_bush",
  33: facing("minecraft:piston", FACE_6),
  34: (d) => (FACE_6[d & 7] ? `minecraft:piston_head[facing=${FACE_6[d & 7]},type=${d & 8 ? "sticky" : "normal"}]` : undefined),
  35: colored("wool"),
  37: "minecraft:dandelion",
  38: pick(["poppy", "blue_orchid", "allium", "azure_bluet", "red_tulip", "orange_tulip", "white_tulip", "pink_tulip", "oxeye_daisy"].map((n) => `minecraft:${n}`)),
  39: "minecraft:brown_mushroom",
  40: "minecraft:red_mushroom",
  41: "minecraft:gold_block",
  42: "minecraft:iron_block",
  43: (d) => (d === 8 ? "minecraft:smooth_stone" : d === 9 ? "minecraft:smooth_sandstone" : d === 15 ? "minecraft:smooth_quartz" : slab(SLABS, true)(d)),
  44: slab(SLABS),
  45: "minecraft:bricks",
  46: "minecraft:tnt",
  47: "minecraft:bookshelf",
  48: "minecraft:mossy_cobblestone",
  49: "minecraft:obsidian",
  50: torch("minecraft:wall_torch", "minecraft:torch"),
  51: "minecraft:fire",
  52: "minecraft:spawner",
  53: stairs("minecraft:oak_stairs"),
  54: facing("minecraft:chest", FACE_2_5),
  55: (d) => `minecraft:redstone_wire[power=${d & 15}]`,
  56: "minecraft:diamond_ore",
  57: "minecraft:diamond_block",
  58: "minecraft:crafting_table",
  59: age("minecraft:wheat", 7),
  60: (d) => `minecraft:farmland[moisture=${d & 7}]`,
  61: facing("minecraft:furnace", FACE_2_5, 7, ",lit=false"),
  62: facing("minecraft:furnace", FACE_2_5, 7, ",lit=true"),
  63: (d) => `minecraft:oak_sign[rotation=${d & 15}]`,
  64: door("minecraft:oak_door"),
  65: facing("minecraft:ladder", FACE_2_5),
  66: rail("minecraft:rail", false),
  67: stairs("minecraft:cobblestone_stairs"),
  68: facing("minecraft:oak_wall_sign", FACE_2_5),
  69: "minecraft:lever",
  70: (d) => `minecraft:stone_pressure_plate[powered=${d & 1 ? "true" : "false"}]`,
  71: door("minecraft:iron_door"),
  72: (d) => `minecraft:oak_pressure_plate[powered=${d & 1 ? "true" : "false"}]`,
  73: "minecraft:redstone_ore[lit=false]",
  74: "minecraft:redstone_ore[lit=true]",
  75: torch("minecraft:redstone_wall_torch", "minecraft:redstone_torch", ",lit=false"),
  76: torch("minecraft:redstone_wall_torch", "minecraft:redstone_torch", ",lit=true"),
  77: button("minecraft:stone_button"),
  78: (d) => `minecraft:snow[layers=${(d & 7) + 1}]`,
  79: "minecraft:ice",
  80: "minecraft:snow_block",
  81: (d) => `minecraft:cactus[age=${d & 15}]`,
  82: "minecraft:clay",
  83: (d) => `minecraft:sugar_cane[age=${d & 15}]`,
  84: "minecraft:jukebox",
  85: "minecraft:oak_fence",
  86: (d) => `minecraft:carved_pumpkin[facing=${FACE_SWNE[d & 3]}]`,
  87: "minecraft:netherrack",
  88: "minecraft:soul_sand",
  89: "minecraft:glowstone",
  90: (d) => `minecraft:nether_portal[axis=${d === 2 ? "z" : "x"}]`,
  91: (d) => `minecraft:jack_o_lantern[facing=${FACE_SWNE[d & 3]}]`,
  92: (d) => (d <= 6 ? `minecraft:cake[bites=${d}]` : undefined),
  93: (d) => `minecraft:repeater[delay=${(d >> 2) + 1},facing=${["south", "west", "north", "east"][d & 3]},powered=false]`,
  94: (d) => `minecraft:repeater[delay=${(d >> 2) + 1},facing=${["south", "west", "north", "east"][d & 3]},powered=true]`,
  95: colored("stained_glass"),
  96: trapdoor("minecraft:oak_trapdoor"),
  97: pick(["stone", "cobblestone", "stone_bricks", "mossy_stone_bricks", "cracked_stone_bricks", "chiseled_stone_bricks"].map((n) => `minecraft:infested_${n}`)),
  98: pick(["minecraft:stone_bricks", "minecraft:mossy_stone_bricks", "minecraft:cracked_stone_bricks", "minecraft:chiseled_stone_bricks"]),
  99: "minecraft:brown_mushroom_block",
  100: "minecraft:red_mushroom_block",
  101: "minecraft:iron_bars",
  102: "minecraft:glass_pane",
  103: "minecraft:melon",
  104: age("minecraft:pumpkin_stem", 7),
  105: age("minecraft:melon_stem", 7),
  106: "minecraft:vine",
  107: gate("minecraft:oak_fence_gate"),
  108: stairs("minecraft:brick_stairs"),
  109: stairs("minecraft:stone_brick_stairs"),
  110: "minecraft:mycelium",
  111: "minecraft:lily_pad",
  112: "minecraft:nether_bricks",
  113: "minecraft:nether_brick_fence",
  114: stairs("minecraft:nether_brick_stairs"),
  115: (d) => `minecraft:nether_wart[age=${d & 3}]`,
  116: "minecraft:enchanting_table",
  117: "minecraft:brewing_stand",
  118: (d) => (d & 3 ? `minecraft:water_cauldron[level=${d & 3}]` : "minecraft:cauldron"),
  119: "minecraft:end_portal",
  120: (d) => `minecraft:end_portal_frame[eye=${d & 4 ? "true" : "false"},facing=${FACE_SWNE[d & 3]}]`,
  121: "minecraft:end_stone",
  122: "minecraft:dragon_egg",
  123: "minecraft:redstone_lamp[lit=false]",
  124: "minecraft:redstone_lamp[lit=true]",
  125: slab(WOODS.map((w) => `minecraft:${w}_slab`), true),
  126: slab(WOODS.map((w) => `minecraft:${w}_slab`)),
  127: "minecraft:cocoa",
  128: stairs("minecraft:sandstone_stairs"),
  129: "minecraft:emerald_ore",
  130: facing("minecraft:ender_chest", FACE_2_5),
  131: "minecraft:tripwire_hook",
  132: "minecraft:tripwire",
  133: "minecraft:emerald_block",
  134: stairs("minecraft:spruce_stairs"),
  135: stairs("minecraft:birch_stairs"),
  136: stairs("minecraft:jungle_stairs"),
  137: "minecraft:command_block",
  138: "minecraft:beacon",
  139: pick(["minecraft:cobblestone_wall", "minecraft:mossy_cobblestone_wall"]),
  140: "minecraft:flower_pot",
  141: age("minecraft:carrots", 7),
  142: age("minecraft:potatoes", 7),
  143: button("minecraft:oak_button"),
  144: "minecraft:skeleton_skull",
  145: (d) => `minecraft:${["anvil", "chipped_anvil", "damaged_anvil"][(d >> 2) & 3] ?? "anvil"}[facing=${FACE_SWNE[d & 3]}]`,
  146: facing("minecraft:trapped_chest", FACE_2_5),
  147: (d) => `minecraft:light_weighted_pressure_plate[power=${d & 15}]`,
  148: (d) => `minecraft:heavy_weighted_pressure_plate[power=${d & 15}]`,
  149: "minecraft:comparator",
  150: "minecraft:comparator",
  151: "minecraft:daylight_detector[inverted=false]",
  152: "minecraft:redstone_block",
  153: "minecraft:nether_quartz_ore",
  154: (d) => (["down", undefined, "north", "south", "west", "east"][d & 7] ? `minecraft:hopper[facing=${["down", undefined, "north", "south", "west", "east"][d & 7]}]` : undefined),
  155: pick(["minecraft:quartz_block", "minecraft:chiseled_quartz_block", "minecraft:quartz_pillar[axis=y]", "minecraft:quartz_pillar[axis=x]", "minecraft:quartz_pillar[axis=z]"]),
  156: stairs("minecraft:quartz_stairs"),
  157: rail("minecraft:activator_rail", true),
  158: facing("minecraft:dropper", FACE_6),
  159: colored("terracotta"),
  160: colored("stained_glass_pane"),
  161: leaves(["minecraft:acacia", "minecraft:dark_oak"]),
  162: log(["minecraft:acacia", "minecraft:dark_oak"]),
  163: stairs("minecraft:acacia_stairs"),
  164: stairs("minecraft:dark_oak_stairs"),
  165: "minecraft:slime_block",
  166: "minecraft:barrier",
  167: trapdoor("minecraft:iron_trapdoor"),
  168: pick(["minecraft:prismarine", "minecraft:prismarine_bricks", "minecraft:dark_prismarine"]),
  169: "minecraft:sea_lantern",
  170: axisBlock("minecraft:hay_block"),
  171: colored("carpet"),
  172: "minecraft:terracotta",
  173: "minecraft:coal_block",
  174: "minecraft:packed_ice",
  175: (d) => (d & 8 ? "minecraft:tall_grass[half=upper]" : DOUBLE_PLANTS[d & 7] && `minecraft:${DOUBLE_PLANTS[d & 7]}[half=lower]`),
  176: (d) => `minecraft:white_banner[rotation=${d & 15}]`,
  177: facing("minecraft:white_wall_banner", FACE_2_5),
  178: "minecraft:daylight_detector[inverted=true]",
  179: pick(["minecraft:red_sandstone", "minecraft:chiseled_red_sandstone", "minecraft:cut_red_sandstone"]),
  180: stairs("minecraft:red_sandstone_stairs"),
  181: (d) => (d === 8 ? "minecraft:smooth_red_sandstone" : "minecraft:red_sandstone_slab[type=double]"),
  182: (d) => `minecraft:red_sandstone_slab[type=${d & 8 ? "top" : "bottom"}]`,
  183: gate("minecraft:spruce_fence_gate"),
  184: gate("minecraft:birch_fence_gate"),
  185: gate("minecraft:jungle_fence_gate"),
  186: gate("minecraft:dark_oak_fence_gate"),
  187: gate("minecraft:acacia_fence_gate"),
  188: "minecraft:spruce_fence",
  189: "minecraft:birch_fence",
  190: "minecraft:jungle_fence",
  191: "minecraft:dark_oak_fence",
  192: "minecraft:acacia_fence",
  193: door("minecraft:spruce_door"),
  194: door("minecraft:birch_door"),
  195: door("minecraft:jungle_door"),
  196: door("minecraft:acacia_door"),
  197: door("minecraft:dark_oak_door"),
  198: facing("minecraft:end_rod", FACE_6),
  199: "minecraft:chorus_plant",
  200: (d) => `minecraft:chorus_flower[age=${Math.min(d, 5)}]`,
  201: "minecraft:purpur_block",
  202: axisBlock("minecraft:purpur_pillar"),
  203: stairs("minecraft:purpur_stairs"),
  204: "minecraft:purpur_slab[type=double]",
  205: (d) => `minecraft:purpur_slab[type=${d & 8 ? "top" : "bottom"}]`,
  206: "minecraft:end_stone_bricks",
  207: (d) => `minecraft:beetroots[age=${d & 3}]`,
  208: "minecraft:dirt_path",
  209: "minecraft:end_gateway",
  210: "minecraft:repeating_command_block",
  211: "minecraft:chain_command_block",
  212: (d) => `minecraft:frosted_ice[age=${d & 3}]`,
  213: "minecraft:magma_block",
  214: "minecraft:nether_wart_block",
  215: "minecraft:red_nether_bricks",
  216: axisBlock("minecraft:bone_block"),
  217: "minecraft:structure_void",
  218: facing("minecraft:observer", FACE_6),
  ...Object.fromEntries(COLORS.map((c, i) => [219 + i, facing(`minecraft:${c}_shulker_box`, FACE_6)])),
  ...Object.fromEntries(COLORS.map((c, i) => [235 + i, (d: number) => `minecraft:${c}_glazed_terracotta[facing=${FACE_SWNE[d & 3]}]`])),
  251: colored("concrete"),
  252: colored("concrete_powder"),
  255: "minecraft:structure_block",
};

export interface LegacyResult {
  state: string;
  /** "exact": fully mapped; "partial": the id is known but the data value isn't; "unknown": a placeholder block. */
  quality: "exact" | "partial" | "unknown";
}

/** Maps a legacy id and data value. Unknown ids become `legacy:id_<id>[data=<d>]` (01: unknown blocks stay visible). */
export function legacyState(id: number, data: number): LegacyResult {
  const e = LEGACY_BLOCKS[id];
  if (e === undefined) return { state: `legacy:id_${id}[data=${data}]`, quality: "unknown" };
  if (typeof e === "string") return { state: e, quality: "exact" };
  const s = e(data);
  if (s) return { state: s, quality: "exact" };
  return { state: e(0) ?? `legacy:id_${id}[data=${data}]`, quality: e(0) ? "partial" : "unknown" };
}

/** Upper door halves and upper double plants carry little state of their own: fill it from the block below. */
export function mergeUpperHalf(upper: string, lower: string): string | undefined {
  const u = /^([^[]+)\[(.*)\]$/.exec(upper), l = /^([^[]+)\[(.*)\]$/.exec(lower);
  if (!u || !l) return undefined;
  const props = (s: string) => Object.fromEntries(s.split(",").map((kv) => kv.split("=") as [string, string]));
  const up = props(u[2]!), lp = props(l[2]!);
  if (up.half !== "upper" || lp.half !== "lower") return undefined;
  if (u[1]!.endsWith("_door") && u[1] === l[1]) {
    const m = { ...lp, hinge: up.hinge ?? "left", powered: up.powered ?? "false", half: "upper" };
    return `${u[1]}[${Object.keys(m).sort().map((k) => `${k}=${m[k as keyof typeof m]}`).join(",")}]`;
  }
  if (u[1] === "minecraft:tall_grass" && DOUBLE_PLANTS.some((p) => l[1] === `minecraft:${p}`)) return `${l[1]}[half=upper]`;
  return undefined;
}
