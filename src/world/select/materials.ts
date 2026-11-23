import type { Registry } from "../../assets/registry.js";
import { canonicalState, parseState } from "../../core/blockstate.js";
import type { PaletteIndex } from "../../palette/index.js";
import type { Family } from "../../palette/families.js";
import { MATCH_SOLID } from "../protocol/messages.js";

/**
 * Materials for the select requests (docs/design/18-select.md, pieces 2 and 3; `13`, *Select*,
 * *Materials*). The agent turns the player's words into block ids, canonical states, families
 * (`family:<id>`) and tags (`#ns:path`); this resolves them, as given, into what the wire carries
 * (ids, canonical states and tags: the mod knows no families) and checks each against the registry.
 * It never guesses: an unknown name is an error that says what to look up.
 */

/** One material as the agent gave it, and the wire entries it became. */
export interface MaterialGroup {
  /** As given (trimmed). */
  given: string;
  /** Its wire entries that no earlier group already sent (the wire list is duplicate-free). */
  wire: string[];
  /** All its wire entries, shared ones included (a family's member count). */
  members: number;
}

export interface ResolvedMaterials {
  groups: MaterialGroup[];
  /** The wire list: every group's entries in order, each once. */
  wire: string[];
  /** For each wire entry, the index of the group it belongs to. */
  groupOf: number[];
}

export interface MaterialLookup {
  registry: Registry;
  /** The palette index, for `family:` (families are the palette's). */
  index?: PaletteIndex;
}

const AIRS = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:void_air"]);
const ns = (s: string) => (s.includes(":") ? s : `minecraft:${s}`).toLowerCase();

/** Every block id of a family: base, shapes, variants and their shapes, aliases, extras (the blocks `familyOfBlock` maps to it). */
export function familyMembers(f: Family): string[] {
  const out = new Set<string>([f.base, ...Object.values(f.shapes)]);
  for (const v of f.variants) [v.base, ...Object.values(v.shapes)].forEach((id) => out.add(id));
  f.aliases.forEach((id) => out.add(id));
  Object.values(f.extras).flat().forEach((id) => out.add(id));
  return [...out];
}

/**
 * Resolves a material list for `search` (and later `fill`): block ids (any state), canonical states,
 * `family:<id>` (the family of that block, every member id), and tags `#ns:path`; with `solid`, a
 * fill's `"solid"` (every non-air block) passes through as is. Throws one error
 * naming every material it can't resolve.
 */
export function resolveMaterials(list: readonly string[], lookup: MaterialLookup, opts: { solid?: boolean } = {}): ResolvedMaterials {
  if (!list.length) throw new Error("materials is empty: give block ids, family:<id> or #tags");
  const { registry, index } = lookup;
  const bad: string[] = [];
  const groups: MaterialGroup[] = [];
  const wire: string[] = [];
  const groupOf: number[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const given = raw.trim();
    let entries: string[] | undefined;
    try {
      entries = given === MATCH_SOLID && opts.solid ? [MATCH_SOLID] : resolveOne(given, registry, index);
    } catch (e) {
      bad.push((e as Error).message);
      continue;
    }
    if (groups.some((g) => g.given === given)) continue;
    const g: MaterialGroup = { given, wire: [], members: entries.length };
    for (const w of entries) {
      if (seen.has(w)) continue;
      seen.add(w);
      g.wire.push(w);
      wire.push(w);
      groupOf.push(groups.length);
    }
    groups.push(g);
  }
  if (bad.length) throw new Error(`${bad.join("; ")}. Look materials up with palette_sheet (sheet "family:<id>", "similar:<id>", "filter:text:<word>") or block_info; nothing was ${opts.solid ? "filled" : "searched"}`);
  return { groups, wire, groupOf };
}

function resolveOne(given: string, registry: Registry, index: PaletteIndex | undefined): string[] {
  if (!given) throw new Error("an empty material");
  if (given === "solid") throw new Error('"solid" matches every block, which a search can\'t narrow; name materials');
  if (given.startsWith("family:")) {
    const id = ns(given.slice(7).trim());
    if (!index) throw new Error(`${given}: families need the loaded palette`);
    const f = index.family(id) ?? index.familyOfBlock(id);
    if (!f) throw new Error(`${given}: no family has ${id}`);
    return familyMembers(f).filter((m) => registry.has(m));
  }
  if (given.startsWith("#")) {
    const tag = ns(given.slice(1));
    if (!registry.withTag(tag).length) throw new Error(`${given}: no block has the tag #${tag}`);
    return [`#${tag}`];
  }
  const { id } = parseState(given);
  if (AIRS.has(id)) throw new Error(`${given}: air can't be searched`);
  if (!registry.has(id)) throw new Error(`${given}: ${id} isn't a block in this instance`);
  if (!given.includes("[")) return [id];
  return [canonicalState(given, registry).state];
}
