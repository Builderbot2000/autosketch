import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { deltaE, hexToRgb, rgbToHex, rgbToLab, type Lab } from "../palette/color.js";
import type { PaletteIndex } from "../palette/index.js";
import type { NamedPalette, RoleMember } from "../palette/pick.js";
import { didYouMean } from "../palette/sheet.js";
import { walk } from "./files.js";
import { checkEntryName, writableRoot, type LibraryRoot } from "./roots.js";

/**
 * Saved palettes (docs/design/07-library.md, Palettes; 03 named palettes): `palettes/<name>.json`
 * holding roles → families + weights, plus tags. Each member may carry its colour so that a
 * palette loaded into an instance lacking a family can suggest the nearest colour instead.
 */

export interface PaletteFileMember extends RoleMember {
  /** "#rrggbb" mean colour of the family where it was saved (optional). */
  color?: string;
}

export interface PaletteFile {
  name: string;
  tags: string[];
  notes?: string;
  roles: Record<string, PaletteFileMember[]>;
  source?: NamedPalette["source"];
}

export interface LibraryPalette extends PaletteFile {
  root: string;
  file: string;
}

export async function listLibraryPalettes(roots: readonly LibraryRoot[], filter: { tags?: string[] } = {}): Promise<LibraryPalette[]> {
  const seen = new Map<string, LibraryPalette>();
  for (const root of roots) {
    if (root.kind !== "library") continue;
    const dir = join(root.path, "palettes");
    for (const rel of await walk(dir, (n) => n.endsWith(".json"), 1)) {
      const name = rel.slice(0, -5);
      if (seen.has(name)) continue;
      const file = join(dir, rel);
      try {
        seen.set(name, { ...parsePaletteFile(JSON.parse(await readFile(file, "utf8")), name), root: root.label, file });
      } catch (e) {
        seen.set(name, { name, tags: [], roles: {}, notes: `unreadable: ${(e as Error).message}`, root: root.label, file });
      }
    }
  }
  const tags = (filter.tags ?? []).map((t) => t.toLowerCase());
  return [...seen.values()].filter((p) => tags.every((t) => p.tags.includes(t)));
}

export async function findLibraryPalette(roots: readonly LibraryRoot[], name: string): Promise<LibraryPalette> {
  const all = await listLibraryPalettes(roots);
  const p = all.find((x) => x.name === name);
  if (!p) throw new Error(`no library palette "${name}"${didYouMean(name, all.map((x) => x.name))}${all.length ? ` (have: ${all.map((x) => x.name).join(", ")})` : ""}`);
  return p;
}

function parsePaletteFile(raw: unknown, fallbackName: string): PaletteFile {
  const o = raw as Partial<PaletteFile>;
  if (!o || typeof o !== "object" || !o.roles || typeof o.roles !== "object") throw new Error("expected {name, tags, roles}");
  const roles: PaletteFile["roles"] = {};
  for (const [role, ms] of Object.entries(o.roles)) {
    if (!Array.isArray(ms)) throw new Error(`role ${role} must be a list`);
    roles[role] = ms.map((m) => {
      const block = typeof m === "string" ? m : m.block;
      if (typeof block !== "string") throw new Error(`role ${role}: each member needs a block`);
      return { family: (typeof m === "object" && m.family) || block, block, weight: typeof m === "object" && typeof m.weight === "number" ? m.weight : 1, ...(typeof m === "object" && m.color ? { color: m.color } : {}) };
    });
  }
  return {
    name: typeof o.name === "string" ? o.name : fallbackName,
    tags: Array.isArray(o.tags) ? o.tags.map((t) => String(t).toLowerCase()) : [],
    ...(typeof o.notes === "string" ? { notes: o.notes } : {}),
    roles,
    ...(o.source ? { source: o.source } : {}),
  };
}

/** Writes a document palette into the first writable root, with each member's colour. */
export async function saveLibraryPalette(
  roots: readonly LibraryRoot[],
  index: PaletteIndex,
  palette: NamedPalette,
  opts: { name?: string; tags?: string[]; notes?: string; overwrite?: boolean } = {},
): Promise<{ file: string; replaced: boolean }> {
  const name = opts.name ?? palette.name;
  checkEntryName("palette", name);
  const file = join(writableRoot(roots).path, "palettes", `${name}.json`);
  let replaced = false;
  try {
    await readFile(file);
    replaced = true;
  } catch {
    /* new */
  }
  if (replaced && !opts.overwrite) throw new Error(`library palette "${name}" already exists; pass overwrite:true or another name`);
  const roles: PaletteFile["roles"] = {};
  for (const [role, ms] of Object.entries(palette.roles))
    roles[role] = ms.map((m) => {
      const st = index.stats(m.family);
      return { family: m.family, block: m.block, weight: m.weight, ...(st ? { color: rgbToHex(st.rgb) } : {}) };
    });
  const data: PaletteFile = { name, tags: (opts.tags ?? []).map((t) => t.toLowerCase()), ...(opts.notes ? { notes: opts.notes } : {}), roles, source: palette.source };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(data, null, 2) + "\n");
  await rename(`${file}.tmp`, file);
  return { file, replaced };
}

export interface MissingMember {
  role: string;
  family: string;
  block: string;
  /** Nearest-colour family present in this instance, when the saved colour is known. */
  suggestion?: { family: string; deltaE: number };
}

/**
 * Turns a saved palette into a document palette for this instance (07: "families not present
 * are reported with the nearest-colour substitute suggested, not applied silently"). Missing
 * members are left out and reported; with `substitute`, the suggestion is used and still reported.
 */
export function instantiatePalette(index: PaletteIndex, file: PaletteFile, opts: { name?: string; substitute?: boolean } = {}): { palette: NamedPalette; missing: MissingMember[]; warnings: string[] } {
  const missing: MissingMember[] = [];
  const warnings: string[] = [];
  const roles: NamedPalette["roles"] = {};
  for (const [role, ms] of Object.entries(file.roles)) {
    const out: RoleMember[] = [];
    for (const m of ms) {
      const fam = index.family(m.family) ?? index.familyOfBlock(m.block);
      if (fam && index.registry.get(m.block)) {
        out.push({ family: fam.id, block: m.block, weight: m.weight });
        continue;
      }
      if (fam) {
        // The family exists but the chosen variant doesn't: fall back to the base, and say so.
        warnings.push(`${role}: ${m.block} is not in this instance; using ${fam.base} from the same family`);
        out.push({ family: fam.id, block: fam.base, weight: m.weight });
        continue;
      }
      const near = m.color ? nearestFamily(index, rgbToLab(hexToRgb(m.color))) : undefined;
      missing.push({ role, family: m.family, block: m.block, ...(near ? { suggestion: near } : {}) });
      if (opts.substitute && near) out.push({ family: near.family, block: index.family(near.family)!.base, weight: m.weight });
    }
    if (!out.length) {
      warnings.push(`${role}: none of its materials are in this instance; role left out`);
      continue;
    }
    const total = out.reduce((s, m) => s + m.weight, 0) || 1;
    roles[role] = mergeByBlock(out).map((m) => ({ ...m, weight: Math.round((m.weight / total) * 1000) / 1000 }));
  }
  return { palette: { name: opts.name ?? file.name, roles, source: file.source ?? { sheet: "library", page: 1 } }, missing, warnings };
}

function mergeByBlock(ms: RoleMember[]): RoleMember[] {
  const by = new Map<string, RoleMember>();
  for (const m of ms) {
    const e = by.get(m.block);
    if (e) e.weight += m.weight;
    else by.set(m.block, { ...m });
  }
  return [...by.values()];
}

/** The buildable family closest in colour (CIELAB ΔE76). */
export function nearestFamily(index: PaletteIndex, lab: Lab): { family: string; deltaE: number } | undefined {
  let best: { family: string; deltaE: number } | undefined;
  for (const f of index.buildable()) {
    const st = index.stats(f.id);
    if (!st) continue;
    const d = deltaE(lab, st.lab);
    if (!best || d < best.deltaE) best = { family: f.id, deltaE: Math.round(d * 10) / 10 };
  }
  return best;
}

export function formatMissing(missing: readonly MissingMember[], substituted: boolean): string[] {
  return missing.map(
    (m) =>
      `missing: ${m.role}: ${m.family} is not in this instance` +
      (m.suggestion ? `; nearest colour ${m.suggestion.family} (ΔE ${m.suggestion.deltaE})${substituted ? " — substituted" : " — not applied (pass substitute:true, or palette_edit)"}` : "; no colour saved, so no suggestion"),
  );
}
