import type { Compound } from "prismarine-nbt";
import { stateId, stateProps } from "../core/blockstate.js";
import type { AutosketchPlugin } from "../plugins/types.js";
import { blockIndex, type Snapshot } from "./snapshot.js";

/**
 * Item requirements for a survival (Create Schematicannon) export (docs/design/08-formats.md).
 * The block → item mapping covers vanilla's systematic cases (wall variants, crops, multi-part
 * blocks, stacked counts). Plugins can answer for their own blocks (09: `items`). Blocks with no
 * item (fluids, portals, technical blocks) are listed separately.
 */

export interface ItemStack {
  item: string;
  count: number;
}

export interface MaterialList {
  items: ItemStack[];
  /** Block ids that need no item or can't be printed, with how many there are. */
  skipped: ItemStack[];
}

const NO_ITEM = new Set([
  "water", "lava", "bubble_column", "fire", "soul_fire", "nether_portal", "end_portal", "end_gateway", "moving_piston", "piston_head",
  "frosted_ice", "light", "barrier", "structure_void", "jigsaw", "structure_block", "command_block", "chain_command_block", "repeating_command_block",
]);

/** block path → item path, for blocks whose item has another name. */
const RENAMED: Record<string, string> = {
  redstone_wire: "redstone",
  tripwire: "string",
  cocoa: "cocoa_beans",
  carrots: "carrot",
  potatoes: "potato",
  beetroots: "beetroot_seeds",
  wheat: "wheat_seeds",
  melon_stem: "melon_seeds",
  attached_melon_stem: "melon_seeds",
  pumpkin_stem: "pumpkin_seeds",
  attached_pumpkin_stem: "pumpkin_seeds",
  torchflower_crop: "torchflower_seeds",
  pitcher_crop: "pitcher_pod",
  sweet_berry_bush: "sweet_berries",
  cave_vines: "glow_berries",
  cave_vines_plant: "glow_berries",
  kelp_plant: "kelp",
  twisting_vines_plant: "twisting_vines",
  weeping_vines_plant: "weeping_vines",
  bamboo_sapling: "bamboo",
  big_dripleaf_stem: "big_dripleaf",
  tall_seagrass: "seagrass",
  powder_snow: "powder_snow_bucket",
  farmland: "dirt",
  dirt_path: "dirt",
};

/** Items for one block (vanilla rules). An empty list means the block needs nothing. */
export function vanillaItems(state: string): ItemStack[] | "none" {
  const id = stateId(state);
  const colon = id.indexOf(":");
  const ns = id.slice(0, colon), path = id.slice(colon + 1);
  if (ns === "minecraft" && (path === "air" || path === "cave_air" || path === "void_air")) return [];
  if (ns === "minecraft" && NO_ITEM.has(path)) return "none";
  const props = state.includes("[") ? stateProps(state) : {};

  // The second half of two-block blocks comes with the first.
  if (props.half === "upper" && (path.endsWith("_door") || isTallPlant(path))) return [];
  if (props.part === "head" && path.endsWith("_bed")) return [];

  if (ns === "minecraft" && path.startsWith("potted_")) return [{ item: "minecraft:flower_pot", count: 1 }, { item: `minecraft:${path.slice(7)}`, count: 1 }];

  let item = path;
  if (ns === "minecraft" && RENAMED[path]) item = RENAMED[path]!;
  else if (path.endsWith("_wall_torch")) item = path.replace("_wall_torch", "_torch");
  else if (path === "wall_torch") item = "torch";
  else if (path.endsWith("_wall_hanging_sign")) item = path.replace("_wall_hanging_sign", "_hanging_sign");
  else if (path.endsWith("_wall_sign")) item = path.replace("_wall_sign", "_sign");
  else if (path.endsWith("_wall_banner")) item = path.replace("_wall_banner", "_banner");
  else if (path.endsWith("_wall_head")) item = path.replace("_wall_head", "_head");
  else if (path.endsWith("_wall_skull")) item = path.replace("_wall_skull", "_skull");
  else if (path.endsWith("_wall_fan")) item = path.replace("_wall_fan", "_fan");

  let count = 1;
  if (props.type === "double" && path.endsWith("_slab")) count = 2;
  else if (props.candles) count = Number(props.candles) || 1;
  else if (props.pickles) count = Number(props.pickles) || 1;
  else if (props.eggs) count = Number(props.eggs) || 1;
  else if (props.flower_amount) count = Number(props.flower_amount) || 1;
  else if (path === "snow" && props.layers) count = Number(props.layers) || 1;
  if (path === "tall_seagrass") count = 2;
  return [{ item: `${ns}:${item}`, count }];
}

function isTallPlant(path: string): boolean {
  return ["tall_grass", "large_fern", "sunflower", "lilac", "rose_bush", "peony", "pitcher_plant", "tall_seagrass", "small_dripleaf"].includes(path);
}

export function materialList(s: Snapshot, plugins: readonly AutosketchPlugin[] = []): MaterialList {
  const nbtAt = new Map<number, Compound>();
  for (const b of s.blockEntities) nbtAt.set(blockIndex(s, ...b.pos), b.nbt);
  const items = new Map<string, number>();
  const skipped = new Map<string, number>();
  const add = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);

  // Without block entities every block of one state needs the same items, so count states first.
  const byState = new Array<number>(s.palette.length).fill(0);
  const withNbt: { p: number; nbt: Compound }[] = [];
  for (let i = 0; i < s.blocks.length; i++) {
    const p = s.blocks[i]!;
    if (!p) continue;
    const be = nbtAt.get(i);
    if (be && plugins.some((pl) => pl.items)) withNbt.push({ p, nbt: be });
    else byState[p]!++;
  }
  const resolve = (state: string, nbt: Compound | undefined, n: number) => {
    for (const pl of plugins) {
      const r = pl.items?.(state, nbt);
      if (r) {
        for (const st of r) add(items, st.item, st.count * n);
        return;
      }
    }
    const r = vanillaItems(state);
    if (r === "none") add(skipped, stateId(state), n);
    else for (const st of r) add(items, st.item, st.count * n);
  };
  byState.forEach((n, p) => n && resolve(s.palette[p]!, undefined, n));
  for (const { p, nbt } of withNbt) resolve(s.palette[p]!, nbt, 1);

  const sorted = (m: Map<string, number>) => [...m].map(([item, count]) => ({ item, count })).sort((a, b) => b.count - a.count || (a.item < b.item ? -1 : 1));
  return { items: sorted(items), skipped: sorted(skipped) };
}

/** "1,234 stone_bricks (19 stacks + 18)" style lines, at most `limit` of them. */
export function formatMaterialList(m: MaterialList, limit = 40): string {
  const short = (id: string) => (id.startsWith("minecraft:") ? id.slice(10) : id);
  const stacks = (n: number) => (n >= 64 ? ` (${Math.floor(n / 64)} st${n % 64 ? ` + ${n % 64}` : ""})` : "");
  const total = m.items.reduce((a, b) => a + b.count, 0);
  const lines = [`materials: ${total} items, ${m.items.length} kinds`];
  for (const it of m.items.slice(0, limit)) lines.push(`  ${it.count} ${short(it.item)}${stacks(it.count)}`);
  if (m.items.length > limit) lines.push(`  … ${m.items.length - limit} more kinds`);
  if (m.skipped.length) lines.push(`not printable / no item: ${m.skipped.map((s) => `${s.count} ${short(s.item)}`).join(", ")}`);
  return lines.join("\n");
}
