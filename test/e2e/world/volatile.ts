/**
 * Volatile-key measurement (docs/design/13, *Open questions*, "Volatile keys"; silo R). Builds a
 * small running base on the test server (Create kinetics, furnaces, a hopper line, AE2, Mekanism,
 * Functional Storage, Sophisticated Storage, brewing, campfire), links it, and snapshots it every
 * few seconds. For each block entity whose state didn't change (state changes reach the cache
 * through the tracker), a changed NBT hash would make the next patch there skip it as
 * "hand-edited": a false skip. Prints the false-skip rate with the given volatile list and the key
 * paths that changed, by block-entity type.
 *
 *   npx tsx test/e2e/world/volatile.ts [--seconds 60] [--list default|grown]
 */
import { DEFAULT_VOLATILE, nbtHash, type Compound, type VolatileList } from "../../../src/world/protocol/index.js";
import { rcon, setVolumes, startMcp, sleep, worldBlocks, type Vec3 } from "./harness.js";

const seconds = Number(process.argv[process.argv.indexOf("--seconds") + 1] ?? 60) || 60;
const X = 5000;
const Z = 1000;
const Y = -60;

/** The base: [dx, dy, dz, block with NBT]. Synthetic, built by commands. */
const BASE: [number, number, number, string][] = [
  // Create: creative motors driving a millstone, a press via shafts, a fan, a cog line.
  [1, 0, 1, "create:creative_motor[facing=up]"],
  [1, 1, 1, "create:millstone"],
  [1, 2, 1, "minecraft:hopper[facing=down]"],
  [1, 3, 1, 'minecraft:chest[facing=north]{Items:[{Slot:0b,id:"minecraft:wheat",count:64},{Slot:1b,id:"minecraft:wheat",count:64}]}'],
  [3, 0, 1, "create:creative_motor[facing=up]"],
  [3, 1, 1, "create:cogwheel[axis=y]"],
  [4, 1, 1, "create:cogwheel[axis=y]"],
  [5, 1, 1, "create:cogwheel[axis=y]"],
  [7, 0, 1, "create:creative_motor[facing=east]"],
  [8, 0, 1, "create:encased_fan[facing=west]"],
  [10, 0, 1, "create:creative_motor[facing=east]"],
  [11, 0, 1, "create:shaft[axis=x]"],
  [12, 0, 1, "create:gearbox[axis=y]"],
  [13, 0, 1, "create:shaft[axis=x]"],
  [12, 1, 1, "create:mechanical_press[facing=north]"],
  [12, -0, 3, "create:depot"],
  // Furnaces burning.
  [1, 0, 4, 'minecraft:furnace[facing=north,lit=true]{Items:[{Slot:0b,id:"minecraft:raw_iron",count:64},{Slot:1b,id:"minecraft:coal_block",count:16}]}'],
  [2, 0, 4, 'minecraft:blast_furnace[facing=north,lit=true]{Items:[{Slot:0b,id:"minecraft:raw_iron",count:64},{Slot:1b,id:"minecraft:coal_block",count:16}]}'],
  [3, 0, 4, 'minecraft:smoker[facing=north,lit=true]{Items:[{Slot:0b,id:"minecraft:beef",count:64},{Slot:1b,id:"minecraft:coal_block",count:16}]}'],
  // A hopper line: chest -> hopper -> chest (automation moving items: real content changes).
  [5, 1, 4, 'minecraft:chest[facing=north]{Items:[{Slot:0b,id:"minecraft:cobblestone",count:64},{Slot:1b,id:"minecraft:cobblestone",count:64},{Slot:2b,id:"minecraft:cobblestone",count:64}]}'],
  [5, 0, 4, "minecraft:hopper[facing=east]"],
  [6, 0, 4, "minecraft:chest[facing=north]"],
  // An empty hopper and chest: nothing should change.
  [8, 0, 4, "minecraft:hopper[facing=down]"],
  [9, 0, 4, 'minecraft:chest[facing=north]{Items:[{Slot:0b,id:"minecraft:diamond",count:3}]}'],
  // Brewing stand brewing, campfire cooking, a beacon-free lectern, a sign, a banner.
  [11, 0, 4, 'minecraft:brewing_stand{Items:[{Slot:0b,id:"minecraft:potion",count:1,components:{"minecraft:potion_contents":{potion:"minecraft:water"}}},{Slot:3b,id:"minecraft:nether_wart",count:8},{Slot:4b,id:"minecraft:blaze_powder",count:8}]}'],
  [13, 0, 4, 'minecraft:campfire[facing=north,lit=true]{Items:[{Slot:0b,id:"minecraft:beef",count:1}]}'],
  [14, 0, 4, 'minecraft:oak_sign{front_text:{messages:[\'"Autosketch"\',\'""\',\'""\',\'""\']}}'],
  [15, 0, 4, "minecraft:white_banner"],
  [1, 0, 7, "minecraft:bee_nest"],
  [2, 0, 7, "minecraft:daylight_detector"],
  [3, 0, 7, "minecraft:comparator"],
  [4, 0, 7, "minecraft:spawner"],
  [5, 0, 7, "minecraft:enchanting_table"],
  [6, 0, 7, "minecraft:jukebox"],
  [7, 0, 7, "minecraft:conduit"],
  [8, 0, 7, "minecraft:bell"],
  // AE2: a powered network with a drive and a terminal.
  [1, 0, 10, "ae2:creative_energy_cell"],
  [2, 0, 10, "ae2:controller"],
  [3, 0, 10, "ae2:drive"],
  [4, 0, 10, "ae2:fluix_block"],
  [2, 1, 10, "ae2:interface"],
  [5, 0, 10, "ae2:inscriber"],
  [6, 0, 10, "ae2:charger"],
  // Mekanism: creative cube next to machines.
  [8, 0, 10, "mekanism:creative_energy_cube"],
  [9, 0, 10, "mekanism:enrichment_chamber"],
  [10, 0, 10, "mekanism:energized_smelter"],
  [11, 0, 10, "mekanism:basic_universal_cable"],
  [12, 0, 10, "mekanism:basic_energy_cube"],
  // Storage.
  [1, 0, 13, "functionalstorage:oak_1"],
  [2, 0, 13, "functionalstorage:storage_controller"],
  [4, 0, 13, "sophisticatedstorage:chest"],
  [5, 0, 13, "sophisticatedstorage:barrel"],
  [7, 0, 13, "powah:energy_cell_basic"],
  [8, 0, 13, "powah:furnator_basic"],
];

function paths(a: unknown, b: unknown, prefix: string, out: Set<string>): void {
  const ac = a as Compound | undefined;
  const bc = b as Compound | undefined;
  if (ac?.type === "compound" && bc?.type === "compound") {
    const keys = new Set([...Object.keys(ac.value), ...Object.keys(bc.value)]);
    for (const k of keys) {
      const av = (ac.value as Record<string, unknown>)[k];
      const bv = (bc.value as Record<string, unknown>)[k];
      if (JSON.stringify(av) !== JSON.stringify(bv)) {
        const sub = (av as Compound | undefined)?.type === "compound" && (bv as Compound | undefined)?.type === "compound";
        if (sub) paths(av, bv, `${prefix}${k}/`, out);
        else out.add(`${prefix}${k}`);
      }
    }
  }
}

const idOf = (c: Compound) => String((c.value as Record<string, { value: unknown }>).id?.value ?? "?");

const r = await rcon();
const m = await startMcp({ ackWaitMs: 0 });
try {
  await r.command(`forceload add ${X - 16} ${Z - 16} ${X + 32} ${Z + 32}`);
  await r.command(`fill ${X} ${Y} ${Z} ${X + 16} ${Y + 4} ${Z + 16} minecraft:air`);
  const failed: string[] = [];
  for (const [dx, dy, dz, b] of BASE) {
    const res = await r.command(`setblock ${X + dx} ${Y + dy} ${Z + dz} ${b}`);
    if (!res.startsWith("Changed")) failed.push(`${b.split("{")[0]}: ${res.trim()}`);
  }
  const work = { min: [X, Y - 1, Z] as Vec3, max: [X + 16, Y + 4, Z + 16] as Vec3 };
  await setVolumes(r, work, undefined, m.link);
  await m.call("doc_open", { world: true });
  await sleep(5000); // let machines start
  const first = await worldBlocks(m.link, work.min, work.max);
  const furnace = ["BurnTime", "CookTime", "CookTimeTotal", "lit_time_remaining", "lit_total_time", "cooking_time_spent", "cooking_total_time"];
  /** Silo L's starting list, for comparison with the grown default. */
  const starting: VolatileList = { "minecraft:furnace": furnace, "minecraft:blast_furnace": furnace, "minecraft:smoker": furnace, "minecraft:hopper": ["TransferCooldown"], "minecraft:brewing_stand": ["BrewTime"] };
  const lists: Record<string, VolatileList> = { starting, grown: DEFAULT_VOLATILE };
  /** Positions whose only NBT change outside the volatile list is an inventory: automation moving items, a real contents change. */
  const automation = new Set<string>();
  const INVENTORY = /(^|\/)(Items|Inventory|InputInventory|OutputInventory)(\/|$)/;
  const changedPaths = new Map<string, Set<string>>();
  const falseSkips: Record<string, Set<string>> = { starting: new Set(), grown: new Set() };
  let prev = first;
  const samples = Math.max(1, Math.round(seconds / 5));
  for (let i = 0; i < samples; i++) {
    await sleep(5000);
    const now = await worldBlocks(m.link, work.min, work.max);
    for (const [pos, nbt] of now.nbt) {
      const before = prev.nbt.get(pos);
      if (!before || prev.states.get(pos) !== now.states.get(pos)) continue; // state changes are tracked
      const ps = changedPaths.get(idOf(nbt)) ?? new Set<string>();
      paths(before, nbt, "", ps);
      if (ps.size) changedPaths.set(idOf(nbt), ps);
      const own = new Set<string>();
      paths(before, nbt, "", own);
      for (const [name, list] of Object.entries(lists)) {
        if (nbtHash(before, list) === nbtHash(nbt, list)) continue;
        const listed = new Set([...((list["*"] as string[] | undefined) ?? []), ...((list[idOf(nbt)] as string[] | undefined) ?? [])]);
        const unlisted = [...own].filter((p) => !listed.has(p));
        if (unlisted.length && unlisted.every((p) => INVENTORY.test(p))) automation.add(`${idOf(nbt)} @${pos}`);
        else falseSkips[name]!.add(`${idOf(nbt)} @${pos}: ${unlisted.filter((p) => !INVENTORY.test(p)).sort().join(", ")}`);
      }
    }
    prev = now;
  }
  const total = first.nbt.size;
  const report = {
    seconds,
    blockEntities: total,
    types: [...new Set([...first.nbt.values()].map(idOf))].sort(),
    notPlaced: failed,
    changedPathsByType: Object.fromEntries([...changedPaths].map(([k, v]) => [k, [...v].sort()])),
    automationContentChanges: [...automation].sort(),
    falseSkips: Object.fromEntries(Object.entries(falseSkips).map(([k, v]) => [k, { count: v.size, rate: total ? +(v.size / total).toFixed(3) : 0, which: [...v].sort() }])),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (e) {
  process.stderr.write(`failed: ${(e as Error).stack}\n`);
} finally {
  await m.close();
  r.close();
  process.exit(0);
}
