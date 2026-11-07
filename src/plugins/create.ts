import type { BlockInfo, Registry } from "../assets/registry.js";
import type { AutosketchPlugin, FamilyHint } from "./types.js";

/**
 * Create and Create Deco (09, "Built-in plugins"; 03, open question on `createdeco` grouping).
 *
 * Generic ingestion already finds Create's stone types, windows and metal blocks. What it gets
 * wrong: casings land in "wood" (they are axe-mined), a few machines are full cubes with plain
 * faces and pass as materials, girders are partial blocks with no full base, and Create Deco's
 * metal sets (sheet metal, hull, bars, mesh fence, doors) and brick corners are named in ways the
 * suffix rules can't attach. Everything here is read from the registry by naming pattern, so ids
 * a given version lacks are simply skipped.
 */

const path = (b: BlockInfo) => b.id.slice(b.id.indexOf(":") + 1);

/** Full-cube Create blocks that are machinery, not building material. */
const CREATE_MACHINES = /(^|_)(chassis|gearshift|roller|chute|packager|repackager|copycat_base|clutch|observer|vault|encased_fan|switch|crate|depot|controller|bearing|contact|pulley|link)($|_)/;

export const create: AutosketchPlugin = {
  id: "create",
  namespaces: ["create"],
  modVersions: ">=6.0.0",
  classify(b) {
    const p = path(b);
    if (/_casing$/.test(p)) return { category: "metal", buildable: true };
    if (CREATE_MACHINES.test(p)) return { buildable: false };
    return undefined;
  },
  families(registry) {
    const hints: FamilyHint[] = [];
    if (registry.has("create:metal_girder")) hints.push({ base: "create:metal_girder", category: "metal", buildable: true });
    // Metal bars are panes of their metal block (doors and trapdoors already attach by suffix).
    for (const b of registry.all()) {
      const m = b.namespace === "create" && /^(.+)_bars$/.exec(path(b));
      if (m && registry.has(`create:${m[1]}_block`)) hints.push({ base: `create:${m[1]}_block`, shapes: { pane: b.id } });
    }
    return hints;
  },
  docs:
    "Create casings, sheet metals and girders are building materials; its machines (shafts, cogs, chassis, chutes, funnels…) are functional and left out of palette sheets. Girders are a partial-block family: use them for frames and bridges.",
};

export const createdeco: AutosketchPlugin = {
  id: "createdeco",
  namespaces: ["createdeco"],
  modVersions: ">=2.0.0",
  classify(b) {
    // Shipping containers have a front face (the directional rule excludes them) but are building blocks.
    if (/_shipping_container$/.test(path(b))) return { buildable: true };
    return undefined;
  },
  families: createdecoFamilies,
  docs:
    "Create Deco adds metal sets per metal (sheet metal, hull, bars, mesh fence, door, trapdoor, catwalks, supports) and coloured brick sets. Autosketch groups each metal set under its sheet metal and each brick colour's corner, cracked and mossy forms under its bricks.",
};

/**
 * Create Deco grouping (resolves the `createdeco` question in 03):
 * - `<metal>_sheet_metal` heads the metal set: `_door`, `_trapdoor`, `_bars` (pane) and `_mesh_fence`
 *   (fence) are its shapes, `_hull` a variant. Windows stay their own glass family.
 * - `corner_`, `cracked_` and `mossy_<colour>_bricks` are variants of `<colour>_bricks` (red ones of
 *   minecraft:bricks, which Create Deco reuses). `long_`, `short_` and `tiled_` bricks stay separate
 *   families: like other `_bricks` forms they look distinct (03).
 */
export function createdecoFamilies(registry: Registry): FamilyHint[] {
  const hints: FamilyHint[] = [];
  const has = (id: string) => registry.has(id);
  const own = [...registry.all()].filter((b) => b.namespace === "createdeco").map(path);
  for (const p of own) {
    const m = /^(.+)_sheet_metal$/.exec(p);
    if (!m) continue;
    const ns = (s: string) => `createdeco:${m[1]}_${s}`;
    const shapes: Record<string, string> = {};
    for (const [kind, suffix] of [["door", "door"], ["trapdoor", "trapdoor"], ["pane", "bars"], ["fence", "mesh_fence"]] as const) if (has(ns(suffix))) shapes[kind] = ns(suffix);
    hints.push({ base: `createdeco:${p}`, shapes, variants: has(ns("hull")) ? [ns("hull")] : [], category: "metal" });
  }
  const variantsOf = new Map<string, string[]>();
  for (const p of own) {
    const m = /^(corner|cracked|mossy)_(.+)_bricks$/.exec(p);
    if (!m) continue;
    const base = has(`createdeco:${m[2]}_bricks`) ? `createdeco:${m[2]}_bricks` : m[2] === "red" && has("minecraft:bricks") ? "minecraft:bricks" : undefined;
    if (base) (variantsOf.get(base) ?? variantsOf.set(base, []).get(base)!).push(`createdeco:${p}`);
  }
  for (const [base, variants] of variantsOf) hints.push({ base, variants: variants.sort() });
  return hints;
}
