import type { BlockInfo, Registry } from "../assets/registry.js";
import type { AutosketchPlugin, Category } from "../plugins/types.js";

/**
 * Groups registry blocks into material families (docs/design/03-palette.md):
 *
 *   1. alias duplicates (Rechiseled `_connecting`, `waxed_` copper)
 *   2. shape groups by suffix: X_stairs / X_slab / … attach to X (or Xs, X_planks, X_block)
 *   3. variants: plugin variant tags (Chipped, Rechiseled) + vanilla weathering prefixes
 *   4. extras: other-mod shapes that reuse a family's texture (roof pieces, vertical slabs)
 *   5. colour series: families that differ only by dye colour
 */

export const SHAPE_KINDS = [
  "stairs", "slab", "wall", "fence", "fence_gate", "door", "trapdoor", "pane", "button", "pressure_plate", "vertical_slab",
] as const;
export type ShapeKind = (typeof SHAPE_KINDS)[number];

// Longest suffixes first so "_fence_gate" wins over "_gate"-less matches.
const SUFFIXES: [string, ShapeKind][] = (
  [
    ["_fence_gate", "fence_gate"], ["_pressure_plate", "pressure_plate"], ["_vertical_slab", "vertical_slab"],
    ["_trapdoor", "trapdoor"], ["_stairs", "stairs"], ["_slab", "slab"], ["_wall", "wall"],
    ["_fence", "fence"], ["_door", "door"], ["_pane", "pane"], ["_button", "button"],
  ] as [string, ShapeKind][]
).sort((a, b) => b[0].length - a[0].length);

export interface ShapeGroup {
  base: string;
  shapes: Partial<Record<ShapeKind, string>>;
}

export interface Family extends ShapeGroup {
  id: string; // = base
  namespace: string;
  category: Category;
  buildable: boolean;
  /** Decorative variants of the material, each with its own shapes. */
  variants: ShapeGroup[];
  /** Shapes from other mods that reuse this material's texture, by namespace. */
  extras: Record<string, string[]>;
  /** Visually identical duplicates (connecting textures, waxed copper). */
  aliases: string[];
  series?: string;
  /** Why the family was excluded from default sheets. */
  excludedBy?: string;
}

export interface Series {
  id: string; // "minecraft:*_wool"
  members: string[]; // family ids, in dye order
}

export interface FamilyResult {
  families: Family[];
  series: Series[];
  /** Partial blocks that joined no family (furniture, decorations…), by namespace count. */
  looseCount: number;
}

export const DYES = [
  "white", "light_gray", "gray", "black", "brown", "red", "orange", "yellow",
  "lime", "green", "cyan", "light_blue", "blue", "purple", "magenta", "pink",
] as const;

const VARIANT_PREFIXES = ["cracked_", "mossy_", "chiseled_", "exposed_", "weathered_", "oxidized_"];

const WOOD_FORMS: [RegExp, string][] = [
  [/^stripped_(.+)_wood$/, "$1_log"],
  [/^stripped_(.+)_log$/, "$1_log"],
  [/^(.+)_wood$/, "$1_log"],
  [/^stripped_(.+)_hyphae$/, "$1_stem"],
  [/^stripped_(.+)_stem$/, "$1_stem"],
  [/^(.+)_hyphae$/, "$1_stem"],
];

export function buildFamilies(registry: Registry, plugins: readonly AutosketchPlugin[] = []): FamilyResult {
  const blocks = [...registry.all()].filter((b) => b.shape !== "none");
  const ids = new Set(blocks.map((b) => b.id));
  const info = (id: string) => registry.get(id)!;

  // 1. Aliases.
  const aliasOf = new Map<string, string>();
  for (const b of blocks) {
    if (b.id.endsWith("_connecting")) {
      const plain = b.id.slice(0, -"_connecting".length);
      if (ids.has(plain)) aliasOf.set(b.id, plain);
    }
    const [ns, path] = split(b.id);
    if (path.startsWith("waxed_") && ids.has(`${ns}:${path.slice(6)}`)) aliasOf.set(b.id, `${ns}:${path.slice(6)}`);
  }

  // 2. Shape groups. Bases are full cubes; shaped blocks attach by suffix.
  const groups = new Map<string, ShapeGroup & { aliases: string[] }>();
  const groupOf = new Map<string, string>(); // block id → group base
  for (const b of blocks) {
    if (aliasOf.has(b.id) || b.shape !== "full") continue;
    groups.set(b.id, { base: b.id, shapes: {}, aliases: [] });
    groupOf.set(b.id, b.id);
  }
  const loose: BlockInfo[] = [];
  for (const b of blocks) {
    if (aliasOf.has(b.id) || groups.has(b.id)) continue;
    const hit = shapeBase(b.id, groups);
    if (hit) {
      const g = groups.get(hit.base)!;
      if (!g.shapes[hit.kind]) g.shapes[hit.kind] = b.id;
      groupOf.set(b.id, hit.base);
    } else loose.push(b);
  }
  for (const [alias, target] of aliasOf) {
    const g = groupOf.get(target);
    if (g) groups.get(g)!.aliases.push(alias);
  }

  // 3. Variants: parent group → child groups.
  const parentOf = new Map<string, string>();
  const attach = (child: string, parent: string) => {
    if (child === parent || parentOf.has(child) || !groups.has(child) || !groups.has(parent)) return;
    let p: string | undefined = parent;
    while (p) {
      if (p === child) return; // would create a cycle
      p = parentOf.get(p);
    }
    parentOf.set(child, parent);
  };

  const variantNs = new Set(plugins.flatMap((p) => p.variantTagNamespaces ?? []));
  if (variantNs.size) {
    const tagMembers = new Map<string, string[]>();
    for (const b of blocks)
      for (const t of b.tags) {
        if (!variantNs.has(t.slice(0, t.indexOf(":")))) continue;
        let l = tagMembers.get(t);
        if (!l) tagMembers.set(t, (l = []));
        l.push(b.id);
      }
    for (const [tag, members] of tagMembers) {
      let base = variantTagBase(tag, groupOf, aliasOf);
      if (!base) {
        // A mod-only group (no base block): head it with the first member.
        const own = members.map((m) => groupOf.get(aliasOf.get(m) ?? m)).filter((g): g is string => !!g).sort();
        if (own.length < 2) continue;
        base = own[0]!;
      }
      const parent = groupOf.get(base)!;
      for (const m of members) {
        const g = groupOf.get(aliasOf.get(m) ?? m);
        if (g && g !== parent) attach(g, parent);
      }
    }
  }
  for (const base of groups.keys()) {
    const [ns, path] = split(base);
    for (const pre of VARIANT_PREFIXES) {
      if (!path.startsWith(pre)) continue;
      const parent = `${ns}:${path.slice(pre.length)}`;
      if (groups.has(parent)) attach(base, parent);
    }
    // Wood forms: X_wood, stripped_X_log, stripped_X_wood → X_log (and stem/hyphae for nether woods).
    for (const [re, to] of WOOD_FORMS) {
      if (!re.test(path)) continue;
      const parent = `${ns}:${path.replace(re, to)}`;
      if (parent !== base && groups.has(parent)) {
        attach(base, parent);
        break;
      }
    }
  }
  // Numbered variants (`zane_block_0` … `zane_block_15`): group under the lowest number.
  const numbered = new Map<string, { n: number; id: string }[]>();
  for (const base of groups.keys()) {
    const m = /^(.*)_(\d+)$/.exec(base);
    if (!m) continue;
    let l = numbered.get(m[1]!);
    if (!l) numbered.set(m[1]!, (l = []));
    l.push({ n: Number(m[2]), id: base });
  }
  for (const [stem, list] of numbered) {
    if (list.length < 3) continue;
    list.sort((a, b) => a.n - b.n);
    const head = groups.has(stem) ? stem : list[0]!.id;
    for (const { id } of list) if (id !== head) attach(id, head);
  }
  const rootOf = (g: string): string => {
    let r = g;
    for (let p = parentOf.get(r); p; p = parentOf.get(r)) r = p;
    return r;
  };

  // Assemble families from root groups.
  const families = new Map<string, Family>();
  for (const [base, g] of groups) {
    if (parentOf.has(base)) continue;
    const b = info(base);
    families.set(base, {
      id: base,
      base,
      namespace: b.namespace,
      shapes: g.shapes,
      variants: [],
      extras: {},
      aliases: [...g.aliases],
      category: "decor",
      buildable: true,
    });
  }
  for (const [child] of parentOf) {
    const fam = families.get(rootOf(child))!;
    const g = groups.get(child)!;
    fam.variants.push({ base: g.base, shapes: g.shapes });
    fam.aliases.push(...g.aliases);
  }
  for (const f of families.values()) f.variants.sort((a, b) => (a.base < b.base ? -1 : 1));

  // 4. Extras: loose shaped blocks that reuse a family's main texture.
  const byTexture = new Map<string, string>();
  for (const f of families.values()) {
    const t = mainTexture(info(f.base));
    if (t && !byTexture.has(t)) byTexture.set(t, f.id);
  }
  let looseCount = 0;
  for (const b of loose) {
    const t = mainTexture(b);
    const fid = t && byTexture.get(t);
    if (fid) (families.get(fid)!.extras[b.namespace] ??= []).push(b.id);
    else looseCount++;
  }

  // Classification.
  const pluginFor = new Map<string, AutosketchPlugin[]>();
  for (const p of plugins) for (const ns of p.namespaces) pluginFor.set(ns, [...(pluginFor.get(ns) ?? []), p]);
  for (const f of families.values()) {
    const b = info(f.base);
    f.category = categorize(b);
    const why = exclusionReason(b);
    if (why) {
      f.buildable = false;
      f.excludedBy = why;
    }
    for (const p of pluginFor.get(b.namespace) ?? []) {
      const c = p.classify?.(b);
      if (c?.category) f.category = c.category;
      if (c?.buildable !== undefined) {
        f.buildable = c.buildable;
        if (!c.buildable) f.excludedBy = `plugin:${p.id}`;
        else delete f.excludedBy;
      }
    }
  }

  // 5. Colour series.
  const seriesMap = new Map<string, { dye: number; id: string }[]>();
  for (const f of families.values()) {
    const key = seriesKey(f.base);
    if (!key) continue;
    let l = seriesMap.get(key.series);
    if (!l) seriesMap.set(key.series, (l = []));
    l.push({ dye: key.dye, id: f.id });
  }
  const series: Series[] = [];
  for (const [id, members] of seriesMap) {
    if (members.length < 8) continue;
    members.sort((a, b) => a.dye - b.dye);
    series.push({ id, members: members.map((m) => m.id) });
    for (const m of members) families.get(m.id)!.series = id;
  }
  series.sort((a, b) => (a.id < b.id ? -1 : 1));

  return { families: [...families.values()].sort((a, b) => (a.id < b.id ? -1 : 1)), series, looseCount };
}

function split(id: string): [string, string] {
  const i = id.indexOf(":");
  return [id.slice(0, i), id.slice(i + 1)];
}

function shapeBase(id: string, groups: Map<string, unknown>): { base: string; kind: ShapeKind } | undefined {
  const [ns, path] = split(id);
  for (const [suffix, kind] of SUFFIXES) {
    if (!path.endsWith(suffix)) continue;
    const stem = path.slice(0, -suffix.length);
    const candidates = [
      stem,
      `${stem}s`,
      `${stem}_planks`,
      `${stem}_block`,
      stem.replace(/_brick$/, "_bricks"),
      stem.replace(/_tile$/, "_tiles"),
      stem.replace(/^waxed_/, ""),
    ];
    for (const c of candidates) if (groups.has(`${ns}:${c}`)) return { base: `${ns}:${c}`, kind };
    return undefined;
  }
  return undefined;
}

/**
 * `chipped:andesite` → minecraft:andesite. Shape names resolve through their group
 * (`rechiseled:andesite_stairs` → andesite), aliases through their target (waxed copper → copper).
 */
function variantTagBase(tag: string, groupOf: Map<string, string>, aliasOf: Map<string, string>): string | undefined {
  const name = tag.slice(tag.indexOf(":") + 1);
  if (name.includes("/")) return undefined;
  const stems = [name, name.replace(/_block$/, ""), `${name}_block`, name.replace(/^waxed_/, ""), name.replace(/^waxed_(.*?)(_block)?$/, "$1")];
  const tagNs = tag.slice(0, tag.indexOf(":"));
  for (const ns of ["minecraft", tagNs]) {
    for (const s of stems) {
      const id = `${ns}:${s}`;
      const target = aliasOf.get(id) ?? id;
      if (groupOf.has(target)) return target;
    }
  }
  return undefined;
}

function mainTexture(b: BlockInfo): string | undefined {
  return b.faceTextures.north ?? b.faceTextures.south ?? b.faceTextures.up ?? b.textures[0];
}

function seriesKey(id: string): { series: string; dye: number } | undefined {
  const [ns, path] = split(id);
  const parts = path.split("_");
  for (let i = 0; i < parts.length; i++) {
    for (const len of [2, 1]) {
      const word = parts.slice(i, i + len).join("_");
      const dye = DYES.indexOf(word as (typeof DYES)[number]);
      if (dye >= 0 && (len === 2 || !(i + 1 < parts.length && DYES.includes(`${word}_${parts[i + 1]}` as never)))) {
        return { series: `${ns}:${[...parts.slice(0, i), "*", ...parts.slice(i + len)].join("_")}`, dye };
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------

const hasTag = (b: BlockInfo, ...tags: string[]) => tags.some((t) => b.tags.includes(t));
const token = (b: BlockInfo, re: RegExp) => re.test(b.id.slice(b.id.indexOf(":") + 1));

export function categorize(b: BlockInfo): Category {
  if ((b.light ?? 0) >= 10 || token(b, /(^|_)(lamp|lantern|glowstone|froglight|shroomlight|light)($|_)/)) return "light";
  if (hasTag(b, "c:glass_blocks", "minecraft:impermeable") || token(b, /glass/)) return "glass";
  if (token(b, /(^|_)(concrete|terracotta|wool|glazed)($|_)/)) return "colored";
  if (hasTag(b, "minecraft:logs", "minecraft:planks") || token(b, /(^|_)(planks?|log|wood|stem|hyphae|bamboo|timber|beam)($|_)/)) return "wood";
  if (hasTag(b, "minecraft:leaves", "minecraft:wool") || token(b, /(^|_)(leaves|moss|hay|wart|mushroom|coral|sponge|thatch|vine|kelp)($|_)/)) return "organic";
  if (hasTag(b, "minecraft:dirt", "c:sands", "c:gravels", "minecraft:sand") || token(b, /(^|_)(dirt|grass|sand|gravel|clay|mud|podzol|mycelium|soil|snow|ice)($|_)/) && !token(b, /sandstone|brick/))
    return "earth";
  if (token(b, /(^|_)(iron|gold|copper|zinc|brass|steel|netherite|metal|aluminum|aluminium|bronze|tin|lead|silver|nickel|osmium|uranium|platinum|titanium|cobalt|sheet|casing|plating|plate|raw|crystal|gem|diamond|emerald|amethyst|lapis|ruby|sapphire|topaz|jade|fluix|certus|coal)($|_)/))
    return "metal";
  if (hasTag(b, "c:stones", "minecraft:base_stone_overworld", "minecraft:base_stone_nether", "c:cobblestones") ||
      token(b, /(stone|brick|tile|andesite|diorite|granite|deepslate|basalt|tuff|calcite|marble|limestone|slate|sandstone|prismarine|quartz|purpur|obsidian|netherrack|cobble|rock|asurine|crimsite|ochrum|veridium|scoria|scorchia|dripstone|blackstone|paving|mosaic|pillar|polished|smooth|chalk|pietraforte|dungeon|kivi|slag|shale|gneiss|schist|travertine|dacite|rhyolite|cinder|ashlar|masonry|cut_)/))
    return "stone";
  return "decor";
}

const FUNCTIONAL = /(^|_)(machine|generator|controller|interface|terminal|port|battery|cell|crate|chest|barrel|spawner|drive|tank|assembler|reactor|turbine|furnace|smelter|smoker|crusher|pulverizer|press|engine|pump|energy|capacitor|conduit|cable|pipe|duct|bus|crafter|crafting|altar|pedestal|infuser|portal|core|command|structure|jigsaw|barrier|debug|creative|budding|infested|table|bench|station|workbench|anvil|hopper|dispenser|dropper|observer|piston|target|beehive|nest|jukebox|note|tnt|bookshelf|loom|composter|cauldron|lectern|grindstone|vault|trial|spawner|charger|cooler|heater|boiler|kiln|oven|forge|smeltery|centrifuge|enricher|condenser|refinery|extractor|injector|purifier|dissolution|separator|synthesizer|sorter|importer|exporter|storage_controller|cutter|saw|deployer|mixer|basin|depot|funnel|tunnel|belt|relay|catalyst|box|elevator|provider|induction|device|clutch|geyser|gearbox|shaft|cog|gauge|sensor|detector|emitter|receiver|transmitter|antenna|monitor|computer|printer|modem|peripheral|scanner|accumulator|coil|magnet|laser|beacon|totem|ritual|brazier|incubator|cage|trap|spikes?|teleporter|waystone)($|_)/;

/** Why a full-cube base shouldn't appear in default building sheets, or undefined if it should. */
export function exclusionReason(b: BlockInfo): string | undefined {
  if (b.renderable === "fallback") return "no-model";
  if (token(b, /(^|_)ore($|_)|_ore$|^ore_|raw_.*_block_ore/) || hasTag(b, "c:ores")) return "ore";
  if (token(b, FUNCTIONAL)) return "functional";
  const sides = [b.faceTextures.north, b.faceTextures.south, b.faceTextures.east, b.faceTextures.west];
  if (sides.every(Boolean) && new Set(sides).size > 1) return "directional"; // a front face: machines, furnaces…
  return undefined;
}
