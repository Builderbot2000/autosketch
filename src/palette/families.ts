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
  /** Other series that look identical (folded into this one). */
  duplicates?: string[];
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

  const variantNs = new Set([...plugins.flatMap((p) => p.variantTagNamespaces ?? []), ...detectVariantTagNamespaces(registry)]);
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
  // 3b. Visual duplicates: families whose base uses identical textures fold into one. Tinted blocks
  // only fold into an untinted twin from another mod (SecurityCraft's reinforced copies are tinted in
  // code); tinted blocks sharing a texture within one mod stay apart (code-dyed sets like plastic bricks).
  const groupsBySig = new Map<string, Family[]>();
  for (const f of families.values()) {
    const sig = lookSignature(info(f.base));
    if (sig) (groupsBySig.get(sig) ?? groupsBySig.set(sig, []).get(sig)!).push(f);
  }
  const fold = (keep: Family, f: Family) => {
    keep.aliases.push(f.base, ...f.aliases);
    for (const [k, v] of Object.entries(f.shapes) as [ShapeKind, string][]) if (!keep.shapes[k]) keep.shapes[k] = v;
    else keep.aliases.push(v);
    keep.variants.push(...f.variants);
    families.delete(f.id);
  };
  for (const group of groupsBySig.values()) {
    if (group.length < 2) continue;
    const plain = group.filter((f) => !isCodeColoured(info(f.base))).sort(preferFamily);
    const keep = plain[0];
    if (!keep) continue;
    for (const f of plain.slice(1)) fold(keep, f);
    for (const f of group) if (isCodeColoured(info(f.base)) && f.namespace !== keep.namespace) fold(keep, f);
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
  const placeholders = detectPlaceholderTextures(registry);
  const pluginFor = new Map<string, AutosketchPlugin[]>();
  for (const p of plugins) for (const ns of p.namespaces) pluginFor.set(ns, [...(pluginFor.get(ns) ?? []), p]);
  for (const f of families.values()) {
    const b = info(f.base);
    f.category = categorize(b);
    const main = mainTexture(b);
    const why = main && placeholders.has(main) ? "placeholder-texture" : exclusionReason(b);
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
  // Mods that add extra dye colours (Dyenamics: peach_wool, aquamarine_concrete…) join by suffix:
  // any family "<colour>_<rest>" where a dye series "*_<rest>" exists.
  // Only vanilla dye-series suffixes count: a mod's own colour set (e.g. coloured planks) must not
  // pull unrelated families like oak/spruce planks into a fake series.
  const suffixes = [...new Set(series.filter((x) => x.id.startsWith("minecraft:*_")).map((x) => x.id.slice(x.id.indexOf("*") + 1)))];
  const extra = new Map<string, string[]>();
  for (const f of families.values()) {
    if (f.series) continue;
    const [ns, path] = split(f.base);
    if (ns === "minecraft") continue;
    const rest = suffixes.find((r) => path.endsWith(r) && /^[a-z]+(_[a-z]+)?$/.test(path.slice(0, -r.length)));
    if (!rest) continue;
    const key = `${ns}:*${rest}`;
    (extra.get(key) ?? extra.set(key, []).get(key)!).push(f.id);
  }
  for (const [id, members] of extra) {
    const existing = series.find((x) => x.id === id);
    if (!existing && members.length < 8) continue;
    members.sort();
    if (existing) existing.members.push(...members);
    else series.push({ id, members });
    for (const m of members) families.get(m)!.series = id;
  }
  series.sort((a, b) => (a.id < b.id ? -1 : 1));

  // Series that look identical (same textures for every member; e.g. EnderIO's fused glass in
  // light-emitting / mob-blocking / … versions) fold into the first: duplicates leave default sheets.
  const seriesBySig = new Map<string, Series>();
  for (const x of [...series].sort((a, b) => a.id.length - b.id.length || (a.id < b.id ? -1 : 1))) {
    const sig = x.members.map((m) => lookSignature(info(families.get(m)!.base)) ?? m).join(";");
    const keep = seriesBySig.get(sig);
    if (!keep) {
      seriesBySig.set(sig, x);
      continue;
    }
    (keep.duplicates ??= []).push(x.id);
    for (const m of x.members) {
      const f = families.get(m)!;
      f.buildable = false;
      f.excludedBy = `duplicate-of:${keep.id}`;
    }
  }

  // Category: dye-series members are "colored" regardless of material words.
  for (const f of families.values()) if (f.series && f.category !== "glass" && f.category !== "light") f.category = "colored";

  return { families: [...families.values()].sort((a, b) => (a.id < b.id ? -1 : 1)), series, looseCount };
}

/** Prefer vanilla, then richer families, then shorter ids, as the survivor of a duplicate fold. */
function preferFamily(a: Family, b: Family): number {
  const va = a.namespace === "minecraft" ? 0 : 1, vb = b.namespace === "minecraft" ? 0 : 1;
  if (va !== vb) return va - vb;
  const ra = Object.keys(a.shapes).length + a.variants.length, rb = Object.keys(b.shapes).length + b.variants.length;
  if (ra !== rb) return rb - ra;
  if (a.id.length !== b.id.length) return a.id.length - b.id.length;
  return a.id < b.id ? -1 : 1;
}

/** A block's textures for duplicate detection (tint handled by the caller). */
function lookSignature(b: BlockInfo): string | undefined {
  const faces = ["up", "down", "north", "south", "east", "west"] as const;
  const t = faces.map((f) => b.faceTextures[f] ?? "");
  return t.some(Boolean) ? t.join("|") : undefined;
}

const isCodeColoured = (b: BlockInfo) => b.tinted || !!b.vertexColor;

/**
 * Namespaces whose tags group decorative variants by base block, detected from data: tags named
 * after another mod's block (`chipped:andesite` ↔ minecraft:andesite) whose members are almost all
 * the tagging mod's own blocks. Chipped, Rechiseled and similar mods are found without plugins.
 */
export function detectVariantTagNamespaces(registry: Registry, minTags = 5): string[] {
  const paths = new Map<string, string>(); // path → a namespace that defines it
  for (const b of registry.all()) {
    const [ns, path] = split(b.id);
    if (!paths.has(path) || ns === "minecraft") paths.set(path, ns);
  }
  const members = new Map<string, string[]>();
  for (const b of registry.all())
    for (const t of b.tags) (members.get(t) ?? members.set(t, []).get(t)!).push(b.id);
  const score = new Map<string, number>();
  for (const [tag, ids] of members) {
    const [ns, name] = split(tag);
    if (GENERIC_TAG_NS.has(ns) || name.includes("/") || ids.length < 4) continue;
    const baseNs = paths.get(name) ?? paths.get(name.replace(/_block$/, "")) ?? paths.get(name.replace(/^waxed_/, ""));
    if (!baseNs || baseNs === ns) continue;
    const own = ids.filter((id) => id.startsWith(`${ns}:`)).length / ids.length;
    if (own >= 0.75) score.set(ns, (score.get(ns) ?? 0) + 1);
  }
  return [...score].filter(([, n]) => n >= minTags).map(([ns]) => ns).sort();
}

const GENERIC_TAG_NS = new Set(["minecraft", "c", "forge", "neoforge", "fabric", "common"]);

/**
 * Textures used as the look of many unrelated blocks in their own mod, mostly partial shapes: the
 * placeholder skin of camo/frame mods (FramedBlocks, Copycats…), whose real look comes from NBT.
 */
export function detectPlaceholderTextures(registry: Registry, minStems = 15): Set<string> {
  const use = new Map<string, BlockInfo[]>();
  for (const b of registry.all()) {
    const t = mainTexture(b);
    if (t) (use.get(t) ?? use.set(t, []).get(t)!).push(b);
  }
  const out = new Set<string>();
  for (const [tex, blocks] of use) {
    const ns = tex.slice(0, tex.indexOf(":"));
    const own = blocks.filter((b) => b.namespace === ns);
    const stems = new Set(own.map((b) => b.id.replace(/_(stairs|slab|wall|fence|fence_gate|door|trapdoor|button|pressure_plate|pane)$/, "")));
    const partial = own.filter((b) => b.shape === "partial").length / Math.max(1, own.length);
    if (stems.size >= minStems && partial >= 0.7) out.add(tex);
  }
  return out;
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

/**
 * Material category from data first: light level, glass/colour words, then the mining-tool tags that
 * nearly every mod sets (axe → wood, shovel → earth, hoe → organic, pickaxe → stone or metal).
 * Only generic English material words are used as fallbacks — no modpack-specific vocabulary.
 */
export function categorize(b: BlockInfo): Category {
  if ((b.light ?? 0) >= 10 || token(b, /(^|_)(lamp|lantern|glowstone|froglight|shroomlight|light)($|_)/)) return "light";
  if (hasTag(b, "c:glass_blocks", "minecraft:impermeable") || token(b, /glass/)) return "glass";
  if (token(b, /(^|_)(concrete|terracotta|wool|glazed)($|_)/)) return "colored";
  if (hasTag(b, "minecraft:logs", "minecraft:planks", "minecraft:mineable/axe")) return "wood";
  if (hasTag(b, "minecraft:leaves", "minecraft:wool", "minecraft:mineable/hoe")) return "organic";
  if (hasTag(b, "minecraft:dirt", "c:sands", "c:gravels", "minecraft:sand", "minecraft:mineable/shovel")) return "earth";
  const metalWords = /(^|_)(iron|gold|copper|zinc|brass|steel|netherite|metal|aluminum|aluminium|bronze|tin|lead|silver|nickel|osmium|uranium|platinum|titanium|cobalt|sheet|casing|plating|plate|raw|crystal|gem|diamond|emerald|amethyst|lapis|ruby|sapphire|coal)($|_)/;
  if (hasTag(b, "minecraft:beacon_base_blocks") || b.tags.some((t) => t.startsWith("c:storage_blocks")) || token(b, metalWords)) return "metal";
  if (hasTag(b, "minecraft:mineable/pickaxe", "c:stones", "minecraft:base_stone_overworld", "minecraft:base_stone_nether", "c:cobblestones")) return "stone";
  // No tool tags: generic words only.
  if (token(b, /(planks?|log|wood|stem|hyphae|bamboo|timber|beam)/)) return "wood";
  if (token(b, /(leaves|moss|hay|wart|mushroom|coral|sponge|thatch|vine|kelp)/)) return "organic";
  if (token(b, /(dirt|grass|sand|gravel|clay|mud|soil|snow|ice)/) && !token(b, /sandstone|brick/)) return "earth";
  if (token(b, /(stone|brick|tile|rock|marble|slate|cobble|paving|pillar|polished|smooth|masonry)/)) return "stone";
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
