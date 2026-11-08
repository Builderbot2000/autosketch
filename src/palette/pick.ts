import { colorName } from "./color.js";
import type { Family, ShapeGroup, ShapeKind } from "./families.js";
import type { PaletteIndex } from "./index.js";
import { columnLabel, layoutSheet, parseRange, type Cell, type SheetLayout, type SheetSpec } from "./sheet.js";

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
    const members = selectRole(index, layout, role, raw, warnings);
    if (members.length === 0) {
      warnings.push(`${role}: no materials selected`);
      continue;
    }
    roles[role] = members;
  }

  const palette: NamedPalette = { name: req.name, roles, source: { sheet: req.sheet, page: req.page ?? 1 } };
  return { palette, summary: describePalette(index, palette), warnings };
}

/** The members a role selection picks on a laid-out sheet (merged and normalised), or [] when none. */
function selectRole(index: PaletteIndex, layout: SheetLayout, role: string, raw: string | string[] | RoleSelection, warnings: string[]): RoleMember[] {
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
  return members.length ? normalise(mergeDuplicates(members)) : [];
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

/**
 * The variant whose block name (without namespace, so "chiseled" doesn't match every
 * `rechiseled:` block) contains the token; whole-word matches win over substrings.
 */
export function chooseVariant(f: Family, token: string | undefined): string {
  const t = token?.trim().toLowerCase();
  if (!t) return f.base;
  const name = (id: string) => id.slice(id.indexOf(":") + 1);
  const word = (id: string) => name(id).split("_").includes(t);
  return f.variants.find((v) => word(v.base))?.base ?? f.variants.find((v) => name(v.base).includes(t))?.base ?? f.base;
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
// palette_edit (03): add or remove cells, reweight, swap or drop a role
// ---------------------------------------------------------------------------------------------

export interface PaletteEdit {
  /** Sheet the cell refs refer to (default: the sheet the palette was picked from). */
  sheet?: string;
  page?: number;
  /** Cells added to a role (created if new); weights are relative to the role's current total of 1. */
  add?: Record<string, string | string[] | RoleSelection>;
  /** Removed from a role: cell refs/ranges, block ids or family ids. */
  remove?: Record<string, string | string[]>;
  /** Replaces a role's members with these cells. */
  swap?: Record<string, string | string[] | RoleSelection>;
  /** New relative weights per role, keyed by block or family id (members not named keep theirs). */
  weights?: Record<string, Record<string, number>>;
  /** Roles to delete. */
  drop?: string[];
  /** Role renames {old: new}. */
  rename?: Record<string, string>;
}

const CELL_REF = /^[A-Z]+\d+(:[A-Z]+\d+)?$/;

/** Applies an edit to a copy of the palette. Unknown roles and ids are reported, not guessed. */
export function editPalette(index: PaletteIndex, palette: NamedPalette, edit: PaletteEdit): { palette: NamedPalette; summary: string; warnings: string[] } {
  const warnings: string[] = [];
  const roles: Record<string, RoleMember[]> = structuredClone(palette.roles);
  const spec: SheetSpec = edit.sheet ? { sheet: edit.sheet, page: edit.page ?? 1 } : { sheet: palette.source.sheet, page: edit.page ?? palette.source.page ?? 1 };
  let layout: SheetLayout | undefined;
  const lay = () => (layout ??= layoutSheet(index, spec));
  const need = (role: string) => {
    if (!roles[role]) throw new Error(`palette "${palette.name}" has no role "${role}" (roles: ${Object.keys(roles).join(", ") || "none"})`);
    return roles[role]!;
  };

  for (const [from, to] of Object.entries(edit.rename ?? {})) {
    const ms = need(from);
    if (roles[to]) throw new Error(`can't rename "${from}" to "${to}": that role exists`);
    delete roles[from];
    roles[to] = ms;
  }
  for (const role of edit.drop ?? []) {
    need(role);
    delete roles[role];
  }
  for (const [role, raw] of Object.entries(edit.swap ?? {})) {
    const ms = selectRole(index, lay(), role, raw, warnings);
    if (!ms.length) warnings.push(`${role}: swap selected nothing; role unchanged`);
    else roles[role] = ms;
  }
  for (const [role, raw] of Object.entries(edit.add ?? {})) {
    const ms = selectRole(index, lay(), role, raw, warnings);
    if (!ms.length) {
      warnings.push(`${role}: nothing to add`);
      continue;
    }
    const cur = roles[role] ?? [];
    // New cells join at the weight one cell of the existing role would have.
    const share = cur.length ? 1 / cur.length : 1;
    roles[role] = normalise(mergeDuplicates([...cur, ...ms.map((m) => ({ ...m, weight: m.weight * share * ms.length }))]));
  }
  for (const [role, raw] of Object.entries(edit.remove ?? {})) {
    const cur = need(role);
    const drop = new Set<string>();
    for (const item of Array.isArray(raw) ? raw : [raw]) {
      const t = item.trim();
      if (CELL_REF.test(t)) {
        for (const m of selectRole(index, lay(), role, t, [])) drop.add(m.block);
        continue;
      }
      const id = t.includes(":") ? t : `minecraft:${t}`;
      const hit = cur.filter((m) => m.block === id || m.family === id);
      if (!hit.length) warnings.push(`${role}: ${t} is not in the role`);
      for (const m of hit) drop.add(m.block);
    }
    const kept = cur.filter((m) => !drop.has(m.block));
    if (!kept.length) {
      delete roles[role];
      warnings.push(`${role}: every member removed; role deleted`);
    } else roles[role] = normalise(kept);
  }
  for (const [role, ws] of Object.entries(edit.weights ?? {})) {
    const cur = need(role);
    const given = new Map(Object.entries(ws).map(([k, v]) => [k.includes(":") ? k : `minecraft:${k}`, v]));
    for (const k of given.keys()) if (!cur.some((m) => m.block === k || m.family === k)) warnings.push(`${role}: ${k} is not in the role (weight ignored)`);
    // Unnamed members keep their current share, measured in the same units as the given weights.
    const named = cur.filter((m) => given.has(m.block) || given.has(m.family));
    const unit = named.length ? named.reduce((s, m) => s + (given.get(m.block) ?? given.get(m.family)!), 0) / Math.max(1e-9, named.reduce((s, m) => s + m.weight, 0)) : 1;
    for (const v of given.values()) if (!(v > 0)) throw new Error(`weights must be positive (${role})`);
    roles[role] = normalise(cur.map((m) => ({ ...m, weight: given.get(m.block) ?? given.get(m.family) ?? m.weight * unit })));
  }

  const out: NamedPalette = { ...palette, roles };
  return { palette: out, summary: describePalette(index, out), warnings };
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
export function patternExpression(r: Resolved): string {
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
  lines.push(`Use as a pattern "palette:${palette.name}.<role>"; shaped ops pick each family's matching shape.`);
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

  /** Resolves "palette:<name>.<role>" to a pattern for a shape. */
  resolveMaterial(index: PaletteIndex, ref: string, shape: ShapeKind | "full" = "full"): { expression: string; warnings: string[] } {
    const m = /^palette:([^.]+)\.(.+)$/.exec(ref);
    if (!m) throw new Error(`not a palette reference: "${ref}" (expected palette:<name>.<role>)`);
    const p = this.get(m[1]!);
    if (!p) throw new Error(`no palette "${m[1]}" (have: ${this.list().map((x) => x.name).join(", ") || "none"})`);
    const r = resolveRole(index, p, m[2]!, shape);
    const warnings = r.skipped.length ? [`${ref}: no ${shape} for ${r.skipped.join(", ")}; skipped`] : [];
    return { expression: patternExpression(r), warnings };
  }
}
