import { z } from "zod";
import { canonicalState, formatState, isAir, parseState, stateId } from "../core/blockstate.js";
import { hash01, hashString } from "../core/rng.js";
import { forEachIn } from "./camo.js";
import type { AutosketchPlugin, PluginAction, PluginActionContext } from "./types.js";

/**
 * Chisel-style conversion (09: `chisel.pattern`, `chisel.randomize`) for Chisel, Rechiseled and
 * Chipped. A block's conversion group is read from the instance: the members of each variant tag
 * it belongs to (`chipped:bricks`, `rechiseled:andesite_stairs`…), the same groups the mods'
 * tools convert within. Blocks in no variant tag fall back to their palette family's variants
 * (vanilla cracked/mossy forms), keeping the block's shape.
 *
 * A pattern is named relative to its group: the member's path minus the group name's words, so
 * `chipped:angry_bricks` is "angry" in `chipped:bricks` and `rechiseled:andesite_bricks_stairs`
 * is "bricks" in `rechiseled:andesite_stairs`. One pattern name then converts andesite, granite
 * and diorite alike. "base" is the group's own block. A full block id also works.
 */

export interface VariantGroup {
  /** Tag path or family member path the pattern names are relative to. */
  name: string;
  members: string[];
}

const path = (id: string) => id.slice(id.indexOf(":") + 1);

/** `member`'s pattern name within a group called `group`. */
export function patternName(member: string, group: string): string {
  const words = path(member).split("_");
  for (const w of group.split("_")) {
    const i = words.indexOf(w);
    if (i >= 0) words.splice(i, 1);
  }
  return words.join("_") || "base";
}

/** The conversion groups of a block, the most specific first. */
export function variantGroups(ctx: Pick<PluginActionContext, "registry" | "family" | "variantNamespaces">, blockId: string, tagCache = new Map<string, string[]>()): VariantGroup[] {
  const groups: VariantGroup[] = [];
  const b = ctx.registry?.get(blockId);
  const ns = new Set(ctx.variantNamespaces);
  for (const t of b?.tags ?? []) {
    const tns = t.slice(0, t.indexOf(":"));
    if (!ns.has(tns) || t.includes("/")) continue;
    let members = tagCache.get(t);
    if (!members) tagCache.set(t, (members = ctx.registry!.withTag(t).map((m) => m.id).sort()));
    if (members.length > 1) groups.push({ name: path(t), members });
  }
  if (groups.length) {
    const key = (g: VariantGroup) => [patternName(blockId, g.name).length, g.name.length] as const;
    return groups.sort((a, c) => key(a)[0] - key(c)[0] || key(a)[1] - key(c)[1] || (a.name < c.name ? -1 : 1));
  }
  const fam = ctx.family?.(blockId);
  if (!fam || !fam.variants.length) return [];
  const all = [fam, ...fam.variants];
  const own = all.find((g) => g.base === blockId || Object.values(g.shapes).includes(blockId));
  if (!own) return [];
  const kind = own.base === blockId ? undefined : Object.entries(own.shapes).find(([, v]) => v === blockId)![0];
  const pick = (g: (typeof all)[number]) => (kind ? g.shapes[kind] : g.base);
  const members = all.map(pick).filter((m): m is string => !!m);
  return members.length > 1 ? [{ name: path(pick(fam) ?? fam.base), members }] : [];
}

/** The member of the block's groups that `pattern` names, or undefined. */
export function resolvePattern(groups: VariantGroup[], pattern: string): string | undefined {
  const p = pattern.trim().toLowerCase();
  for (const g of groups) for (const m of g.members) if (p.includes(":") ? m === p : patternName(m, g.name) === p) return m;
  return undefined;
}

export function patternsOf(groups: VariantGroup[]): string[] {
  return [...new Set(groups.flatMap((g) => g.members.map((m) => patternName(m, g.name))))].sort();
}

/** `target` with the properties of `from` it accepts (facing, half, axis…). */
function carryState(from: string, target: string, ctx: PluginActionContext): string {
  const info = ctx.registry?.get(target);
  if (!info) return target;
  const props: Record<string, string> = {};
  for (const [k, v] of Object.entries(parseState(from).props)) if (info.properties[k]?.includes(v)) props[k] = v;
  return canonicalState(formatState(target, props), ctx.registry).state;
}

type Chooser = (groups: VariantGroup[], x: number, y: number, z: number) => string | undefined;

function convert(ctx: PluginActionContext, sel: unknown, from: string | undefined, summary: string, choose: Chooser, wanted: string) {
  const region = ctx.region(sel);
  const match = from ? ctx.matcher(from) : undefined;
  const groupsCache = new Map<string, VariantGroup[]>();
  const tagCache = new Map<string, string[]>();
  const groupsOf = (id: string) => groupsCache.get(id) ?? groupsCache.set(id, variantGroups(ctx, id, tagCache)).get(id)!;
  return ctx.edit(summary, (tx) => {
    let converted = 0, noGroup = 0, noPattern = 0;
    let example: { id: string; patterns: string[] } | undefined;
    forEachIn(region, (x, y, z) => {
      const st = tx.get(x, y, z);
      if (isAir(st) || (match && !match(st))) return;
      const id = stateId(st);
      const groups = groupsOf(id);
      if (!groups.length) return void noGroup++;
      const target = choose(groups, x, y, z);
      if (!target) {
        noPattern++;
        example ??= { id, patterns: patternsOf(groups) };
        return;
      }
      if (target === id) return;
      tx.set(x, y, z, tx.intern(carryState(st, target, ctx)));
      converted++;
    });
    const list = (e: { id: string; patterns: string[] }) => `${e.id} has ${e.patterns.slice(0, 30).join(", ")}${e.patterns.length > 30 ? ` … (${e.patterns.length})` : ""}`;
    if (!converted && example) throw new Error(`no block in the selection has pattern ${wanted}; e.g. ${list(example)}`);
    if (noPattern && example) tx.warn(`${noPattern} block${noPattern > 1 ? "s" : ""} lack ${wanted} (left as is); e.g. ${list(example)}`);
    if (noGroup) tx.warn(`${noGroup} block${noGroup > 1 ? "s are" : " is"} in no variant group (left as is)`);
  });
}

export const chiselActions: Record<string, PluginAction> = {
  pattern: {
    description:
      'Converts blocks to another pattern of their own variant group, like the in-game chisel: "bricks", "angry", "base" (the plain block) or a full id. Groups come from the mods\' tags; an unknown pattern lists the available ones. One undo step. Text.',
    params: z.object({
      sel: z.unknown().describe("Selection (any sel expression or box)"),
      pattern: z.string().describe('Pattern name relative to each block\'s group, e.g. "bricks", or a block id'),
      from: z.string().optional().describe('Only convert blocks matching this ("andesite", "#minecraft:stone_bricks", "*")'),
    }),
    run(ctx, raw) {
      const a = raw as { sel: unknown; pattern: string; from?: string };
      return convert(ctx, a.sel, a.from, `chisel.pattern ${a.pattern}`, (groups) => resolvePattern(groups, a.pattern), `"${a.pattern}"`);
    },
  },
  randomize: {
    description: "Converts each block to a random one of the given patterns its group has (seeded, so repeatable): weathering, mixed textures. One undo step. Text.",
    params: z.object({
      sel: z.unknown().describe("Selection (any sel expression or box)"),
      patterns: z.array(z.string()).min(1).describe('Pattern names or block ids, e.g. ["base","cracked","mossy"]'),
      from: z.string().optional().describe("Only convert blocks matching this"),
      seed: z.number().int().optional().describe("Default: the document seed"),
    }),
    run(ctx, raw) {
      const a = raw as { sel: unknown; patterns: string[]; from?: string; seed?: number };
      const seed = a.seed ?? ctx.doc.meta.seed;
      const salt = hashString(a.patterns.join(","));
      const choose: Chooser = (groups, x, y, z) => {
        const opts = a.patterns.map((p) => resolvePattern(groups, p)).filter((m): m is string => !!m);
        return opts.length ? opts[Math.floor(hash01(seed, salt, x, y, z) * opts.length)] : undefined;
      };
      return convert(ctx, a.sel, a.from, `chisel.randomize ${a.patterns.join(",")}`, choose, `any of ${a.patterns.join(", ")}`);
    },
  },
};

export const chisel: AutosketchPlugin = {
  id: "chisel",
  // The ops serve every chisel-style mod; knowledge stays with each mod's own plugin.
  namespaces: ["chisel", "rechiseled", "chipped"],
  variantTagNamespaces: ["chisel"],
  actions: chiselActions,
  docs:
    'Chisel, Rechiseled and Chipped convert blocks between patterns of one material. chisel.pattern({sel, pattern:"bricks"}) does it for a whole selection, each block within its own group; chisel.randomize mixes patterns.',
};
