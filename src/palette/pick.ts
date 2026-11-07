import { colorName } from "./color.js";
import type { Family, ShapeGroup, ShapeKind } from "./families.js";
import type { PaletteIndex } from "./index.js";
import { columnLabel, layoutSheet, parseRange, type Cell, type SheetSpec } from "./sheet.js";

/**
 * palette_pick: turns cell selections on a sheet into a named palette of roles
 * (docs/design/03-palette.md). Roles are free-form names; conventional ones get hints only.
 */

export interface RoleSelection {
  /** Cell range(s) on the sheet: "C4:F6", "B9", or a list. */
  cells: string | string[];
  /** Prefer a variant whose id contains this token (e.g. "chiseled", "bricks"). */
  variant?: string;
  /** Relative weight of this whole role's cells per cell ref, default even. */
  weights?: Record<string, number>;
}

export interface PickRequest extends SheetSpec {
  name: string;
  roles: Record<string, string | string[] | RoleSelection>;
}

export interface RoleMember {
  family: string;
  /** The chosen block of the family (its base or a variant). */
  block: string;
  weight: number;
}

export interface NamedPalette {
  name: string;
  roles: Record<string, RoleMember[]>;
  source: SheetSpec;
}

export const CONVENTIONAL_ROLES = ["wall", "trim", "roof", "floor", "accent", "glass", "light", "foundation", "pillar", "path"] as const;

export function pickPalette(index: PaletteIndex, req: PickRequest): { palette: NamedPalette; summary: string; warnings: string[] } {
  if (!req.name || !/^[a-z0-9_-]+$/i.test(req.name)) throw new Error(`palette name must be letters, digits, _ or - (got "${req.name}")`);
  const layout = layoutSheet(index, { sheet: req.sheet, page: req.page ?? 1 });
  const warnings: string[] = [];
  const roles: Record<string, RoleMember[]> = {};

  for (const [role, raw] of Object.entries(req.roles)) {
    const sel: RoleSelection = typeof raw === "string" || Array.isArray(raw) ? { cells: raw } : raw;
    const refs = (Array.isArray(sel.cells) ? sel.cells : [sel.cells]).flatMap((r) => parseRange(r).map((p) => ({ ...p, ref: `${columnLabel(p.col)}${p.row}`, range: r })));
    const members: RoleMember[] = [];
    for (const { col, row, ref, range } of refs) {
      const cell = layout.cells[row - layout.rowOffset]?.[col];
      if (!cell) {
        if (refs.length === 1) warnings.push(`${role}: ${ref} is empty`);
        continue;
      }
      const w = sel.weights?.[ref] ?? sel.weights?.[range] ?? 1;
      const picked = cellMembers(index, cell, sel.variant, warnings, role);
      for (const m of picked) members.push({ ...m, weight: (w * m.weight) / picked.reduce((s, x) => s + x.weight, 0) });
    }
    if (members.length === 0) {
      warnings.push(`${role}: no materials selected`);
      continue;
    }
    roles[role] = normalise(mergeDuplicates(members));
  }

  const palette: NamedPalette = { name: req.name, roles, source: { sheet: req.sheet, page: req.page ?? 1 } };
  return { palette, summary: describePalette(index, palette), warnings };
}

function cellMembers(index: PaletteIndex, cell: Cell, variant: string | undefined, warnings: string[], role: string): RoleMember[] {
  if (cell.kind === "series") {
    const s = index.series.get(cell.id)!;
    return s.members.map((m) => ({ family: m, block: chooseVariant(index.family(m)!, variant), weight: 1 }));
  }
  if (cell.kind === "variant") return [{ family: cell.family, block: cell.block, weight: 1 }];
  const f = index.family(cell.id);
  if (!f) return [];
  const block = chooseVariant(f, variant);
  if (variant && block === f.base) warnings.push(`${role}: ${f.id} has no "${variant}" variant; using the base block`);
  return [{ family: f.id, block, weight: 1 }];
}

function chooseVariant(f: Family, token: string | undefined): string {
  if (!token) return f.base;
  return f.variants.find((v) => v.base.includes(token))?.base ?? f.base;
}

function mergeDuplicates(ms: RoleMember[]): RoleMember[] {
  const by = new Map<string, RoleMember>();
  for (const m of ms) {
    const e = by.get(m.block);
    if (e) e.weight += m.weight;
    else by.set(m.block, { ...m });
  }
  return [...by.values()];
}

function normalise(ms: RoleMember[]): RoleMember[] {
  const total = ms.reduce((s, m) => s + m.weight, 0) || 1;
  return ms.map((m) => ({ ...m, weight: Math.round((m.weight / total) * 1000) / 1000 }));
}

// ---------------------------------------------------------------------------------------------
// Resolution (used by ops: "palette:castle.roof" for a stairs op → stairs of the roof families)
// ---------------------------------------------------------------------------------------------

export interface Resolved {
  entries: { block: string; weight: number }[];
  skipped: string[]; // families lacking the requested shape
}

/** The concrete blocks for a role and shape ("full" = the cube itself). */
export function resolveRole(index: PaletteIndex, palette: NamedPalette, role: string, shape: ShapeKind | "full" = "full"): Resolved {
  const members = palette.roles[role];
  if (!members) throw new Error(`palette "${palette.name}" has no role "${role}" (roles: ${Object.keys(palette.roles).join(", ")})`);
  const entries: Resolved["entries"] = [];
  const skipped: string[] = [];
  for (const m of members) {
    if (shape === "full") {
      entries.push({ block: m.block, weight: m.weight });
      continue;
    }
    const f = index.family(m.family);
    const group: ShapeGroup | undefined = f && (m.block === f.base ? f : f.variants.find((v) => v.base === m.block));
    const block = group?.shapes[shape] ?? f?.shapes[shape];
    if (block) entries.push({ block, weight: m.weight });
    else skipped.push(m.family);
  }
  return { entries: normalise(entries.map((e) => ({ ...e, family: "" }))).map(({ block, weight }) => ({ block, weight })), skipped };
}

/** "a 60%, b 40%" (conventions in docs/design/01-conventions.md). */
export function materialExpression(r: Resolved): string {
  if (r.entries.length === 0) throw new Error(`no blocks available${r.skipped.length ? ` (missing shape in: ${r.skipped.join(", ")})` : ""}`);
  if (r.entries.length === 1) return r.entries[0]!.block;
  const pct = r.entries.map((e) => Math.max(1, Math.round(e.weight * 100)));
  return r.entries.map((e, i) => `${e.block} ${pct[i]}%`).join(", ");
}

/** Compact text summary of a palette: per role, families, colours and available shapes. */
export function describePalette(index: PaletteIndex, palette: NamedPalette): string {
  const lines = [`palette "${palette.name}" (from ${palette.source.sheet}${(palette.source.page ?? 1) > 1 ? ` p${palette.source.page}` : ""}):`];
  for (const [role, members] of Object.entries(palette.roles)) {
    const shapeSets = members.map((m) => {
      const f = index.family(m.family);
      const g: ShapeGroup | undefined = f && (m.block === f.base ? f : f.variants.find((v) => v.base === m.block));
      return new Set(Object.keys({ ...(f?.shapes ?? {}), ...(g?.shapes ?? {}) }));
    });
    const common = ["stairs", "slab", "wall", "fence"].filter((k) => shapeSets.every((s) => s.has(k)));
    const partial = ["stairs", "slab", "wall", "fence"].filter((k) => !common.includes(k) && shapeSets.some((s) => s.has(k)));
    const items = members
      .slice(0, 8)
      .map((m) => {
        const st = index.stats(m.family);
        return `${m.block}${members.length > 1 ? ` ${Math.round(m.weight * 100)}%` : ""}${st ? ` (${colorName(st.lab)})` : ""}`;
      })
      .join(", ");
    const more = members.length > 8 ? ` …+${members.length - 8}` : "";
    const shapes = `shapes: ${common.length ? common.join(",") : "none common"}${partial.length ? `; some have ${partial.join(",")}` : ""}`;
    lines.push(`  ${role}: ${items}${more} — ${shapes}`);
  }
  lines.push(`Use as material "palette:${palette.name}.<role>"; shaped ops pick each family's matching shape.`);
  return lines.join("\n");
}

/** Per-session store of named palettes (persisted with the document later, see 04-document.md). */
export class PaletteBook {
  private readonly palettes = new Map<string, NamedPalette>();
  set(p: NamedPalette): void {
    this.palettes.set(p.name, p);
  }
  get(name: string): NamedPalette | undefined {
    return this.palettes.get(name);
  }
  list(): NamedPalette[] {
    return [...this.palettes.values()];
  }
  delete(name: string): boolean {
    return this.palettes.delete(name);
  }
  toJSON(): NamedPalette[] {
    return this.list();
  }
  static fromJSON(list: NamedPalette[]): PaletteBook {
    const b = new PaletteBook();
    for (const p of list) b.set(p);
    return b;
  }

  /** Resolves "palette:<name>.<role>" to a material expression for a shape. */
  resolveMaterial(index: PaletteIndex, ref: string, shape: ShapeKind | "full" = "full"): { expression: string; warnings: string[] } {
    const m = /^palette:([^.]+)\.(.+)$/.exec(ref);
    if (!m) throw new Error(`not a palette reference: "${ref}" (expected palette:<name>.<role>)`);
    const p = this.get(m[1]!);
    if (!p) throw new Error(`no palette "${m[1]}" (have: ${this.list().map((x) => x.name).join(", ") || "none"})`);
    const r = resolveRole(index, p, m[2]!, shape);
    const warnings = r.skipped.length ? [`${ref}: no ${shape} for ${r.skipped.join(", ")}; skipped`] : [];
    return { expression: materialExpression(r), warnings };
  }
}
