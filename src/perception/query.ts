import type { Compound } from "prismarine-nbt";
import type { Registry } from "../assets/registry.js";
import { shortState, stateId } from "../core/blockstate.js";
import type { Mask } from "../core/mask.js";
import { boxSize, formatBox, intersectBox, isEmptyBox, type Box, type Vec3 } from "../core/region.js";
import type { Document } from "../document/document.js";
import type { PaletteIndex } from "../palette/index.js";

/**
 * Point and region queries (docs/design/06-perception.md, "Point and region queries"): exact,
 * text-only answers to "what is at X?", the cheapest perception tools (< 50 tokens for a block or
 * a column).
 */

const n = (v: number) => v.toLocaleString("en-US");

/** Components whose box contains a local position, innermost (smallest) first. */
export function componentsAt(doc: Document, x: number, y: number, z: number): string[] {
  const hits: [string, number][] = [];
  for (const id of doc.components.keys()) {
    const c = doc.componentLocal(id)!;
    const b = c.box;
    if (x >= b.min[0] && x < b.max[0] && y >= b.min[1] && y < b.max[1] && z >= b.min[2] && z < b.max[2]) {
      const s = boxSize(b);
      hits.push([id, s[0] * s[1] * s[2]]);
    }
  }
  return hits.sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)).map(([id]) => id);
}

/** One-line summary of a block entity: its id and top-level keys. */
export function summarizeNbt(nbt: Compound): string {
  const v = nbt.value as Record<string, { type: string; value: unknown }>;
  const id = v.id && v.id.type === "string" ? String(v.id.value) : undefined;
  const keys = Object.keys(v).filter((k) => !["id", "x", "y", "z"].includes(k));
  const shown = keys.slice(0, 8).map((k) => {
    const t = v[k]!;
    if (t.type === "list") return `${k}[${(t.value as { value?: unknown[] }).value?.length ?? 0}]`;
    if (t.type === "string") return `${k}="${String(t.value).slice(0, 24)}"`;
    if (t.type === "compound") return `${k}{…}`;
    return `${k}=${typeof t.value === "object" ? "…" : String(t.value)}`;
  });
  return `${id ?? "block entity"}${shown.length ? ` {${shown.join(", ")}${keys.length > 8 ? `, …+${keys.length - 8}` : ""}}` : ""}`;
}

/** query_block: state, block-entity summary and component membership at one position. */
export function queryBlock(doc: Document, registry: Registry | undefined, pos: Vec3): string {
  const [x, y, z] = pos;
  const state = doc.getState(x, y, z);
  const parts = [`(${x},${y},${z}) ${state === "minecraft:air" ? "air" : shortState(state, registry)}`];
  if (state !== "minecraft:air" && registry && !registry.has(stateId(state))) parts.push("(unknown block: kept verbatim)");
  const be = doc.getBlockEntity(x, y, z);
  if (be) parts.push(`nbt: ${summarizeNbt(be)}`);
  const comps = componentsAt(doc, x, y, z);
  if (comps.length) parts.push(`in: ${comps.join(" ⊂ ")}`);
  const b = doc.localBounds();
  if (!b || x < b.min[0] || x >= b.max[0] || y < b.min[1] || y >= b.max[1] || z < b.min[2] || z >= b.max[2]) parts.push("(outside the document bounds)");
  return parts.join(" · ");
}

/** query_column: the column at (x, z) as bottom-to-top runs over the document's height. */
export function queryColumn(doc: Document, registry: Registry | undefined, x: number, z: number): string {
  const b = doc.localBounds();
  if (!b) return "The document is empty.";
  const runs: [string, number, number][] = [];
  for (let y = b.min[1]; y < b.max[1]; y++) {
    const s = doc.getState(x, y, z);
    const last = runs[runs.length - 1];
    if (last && last[0] === s) last[2] = y;
    else runs.push([s, y, y]);
  }
  const outside = x < b.min[0] || x >= b.max[0] || z < b.min[2] || z >= b.max[2];
  if (runs.length === 1 && runs[0]![0] === "minecraft:air") return `column (${x},${z}) y ${b.min[1]}..${b.max[1] - 1}: all air${outside ? " (outside the document bounds)" : ""}`;
  const text = runs.map(([s, y0, y1]) => `${y0 === y1 ? `y${y0}` : `y${y0}-${y1}`} ${s === "minecraft:air" ? "air" : shortState(s, registry)}`);
  return `column (${x},${z}) bottom→top: ${text.join(", ")}`;
}

export interface RegionQueryContext {
  registry?: Registry;
  index?: PaletteIndex;
}

export interface RegionSummary {
  volume: number;
  solid: number;
  /** Tight box of the non-air blocks (half-open, local). */
  bbox?: Box;
  /** Counts by family id (or block id when no family is known), commonest first. */
  families: [string, number][];
  /** Counts by "palette.role", commonest first. */
  roles: [string, number][];
  /** Components fully inside the selection's bounding box, and those only touching it. */
  inside: string[];
  touching: string[];
}

/** query_region: counts by family and palette role, bounding box, and the components inside. */
export function regionSummary(doc: Document, mask: Mask, ctx: RegionQueryContext = {}): RegionSummary {
  const byBlock = new Map<string, number>();
  let solid = 0;
  let min: Vec3 | undefined, max: Vec3 | undefined;
  mask.forEach((x, y, z) => {
    const st = doc.getState(x, y, z);
    if (st === "minecraft:air") return;
    solid++;
    const id = stateId(st);
    byBlock.set(id, (byBlock.get(id) ?? 0) + 1);
    if (!min || !max) {
      min = [x, y, z];
      max = [x + 1, y + 1, z + 1];
    } else {
      min = [Math.min(min[0], x), Math.min(min[1], y), Math.min(min[2], z)];
      max = [Math.max(max[0], x + 1), Math.max(max[1], y + 1), Math.max(max[2], z + 1)];
    }
  });
  const families = new Map<string, number>();
  const familyOf = (id: string) => ctx.index?.familyOfBlock(id)?.id ?? id;
  for (const [id, c] of byBlock) {
    const f = familyOf(id);
    families.set(f, (families.get(f) ?? 0) + c);
  }
  // Palette roles: a block counts for every role whose members share its family (or block).
  const roles = new Map<string, number>();
  for (const p of doc.palettes.list())
    for (const [role, members] of Object.entries(p.roles)) {
      const fams = new Set(members.map((m) => m.family));
      const blocks = new Set(members.map((m) => m.block));
      let c = 0;
      for (const [id, k] of byBlock) if (blocks.has(id) || fams.has(familyOf(id))) c += k;
      if (c) roles.set(`${p.name}.${role}`, c);
    }
  const selBox = mask.bbox();
  const inside: string[] = [], touching: string[] = [];
  if (selBox)
    for (const id of doc.components.keys()) {
      const cb = doc.componentLocal(id)!.box;
      const ib = intersectBox(cb, selBox);
      if (isEmptyBox(ib)) continue;
      if (ib.min.every((v, i) => v === cb.min[i]) && ib.max.every((v, i) => v === cb.max[i])) inside.push(id);
      else touching.push(id);
    }
  const sorted = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return {
    volume: mask.count(),
    solid,
    ...(min && max ? { bbox: { min, max } } : {}),
    families: sorted(families),
    roles: sorted(roles),
    inside,
    touching,
  };
}

export function formatRegionSummary(s: RegionSummary, registry?: Registry, limit = 10): string {
  const short = (id: string) => shortState(id, registry);
  if (!s.solid) return `region: ${n(s.volume)} positions, all air`;
  const lines = [`region: ${n(s.volume)} positions, ${n(s.solid)} blocks (${Math.round((100 * s.solid) / s.volume)}% solid) · blocks in ${formatBox(s.bbox!)} = ${boxSize(s.bbox!).join("×")}`];
  const fam = s.families.slice(0, limit).map(([f, c]) => `${short(f)} ${n(c)}`);
  lines.push(`by family: ${fam.join(", ")}${s.families.length > limit ? ` …+${s.families.length - limit} more` : ""}`);
  if (s.roles.length) lines.push(`by role: ${s.roles.slice(0, limit).map(([r, c]) => `${r} ${n(c)}`).join(", ")}`);
  if (s.inside.length) lines.push(`components inside: ${s.inside.join(", ")}`);
  if (s.touching.length) lines.push(`components partly inside: ${s.touching.join(", ")}`);
  return lines.join("\n");
}
