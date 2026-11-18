import type { KitEntry } from "./knowledge.js";
import type { Prefab } from "./prefabs.js";

/**
 * The session's component set (docs/design/17-reusable-components.md, piece 1): an ordered list
 * of library prefabs the agent uses as its vocabulary for the session, each with an optional label
 * ("corner tower") and notes. It lives in memory on the MCP session and ends with it; a kit
 * (piece 2) keeps a copy only when the player asks. Advice, never a constraint: nothing refuses or
 * rewrites an op because of the set.
 */

export type SetEntry = KitEntry;

const same = (a: string | undefined, b: string | undefined): boolean => a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

export class ComponentSet {
  private list: SetEntry[] = [];

  get entries(): readonly SetEntry[] {
    return this.list;
  }

  get size(): number {
    return this.list.length;
  }

  /**
   * Adds entries in order. An entry with the same label or the same prefab as an existing one
   * replaces it in place (both, if it matches two: the first keeps its position).
   */
  add(entries: readonly SetEntry[]): void {
    for (const e of entries) {
      const clean = tidy(e);
      const match = (x: SetEntry): boolean => same(x.prefab, clean.prefab) || same(x.label, clean.label);
      const hit = this.list.findIndex(match);
      if (hit < 0) this.list.push(clean);
      else this.list = this.list.flatMap((x, i) => (i === hit ? [clean] : match(x) ? [] : [x]));
    }
  }

  /** Removes entries by label or prefab name (case-insensitive); returns the refs that matched nothing. */
  remove(refs: readonly string[]): string[] {
    const missing: string[] = [];
    for (const r of refs) {
      const before = this.list.length;
      this.list = this.list.filter((x) => !same(x.label, r.trim()) && !same(x.prefab, r.trim()));
      if (this.list.length === before) missing.push(r);
    }
    return missing;
  }

  clear(): void {
    this.list = [];
  }

  /** Replaces the whole set (loading a kit). */
  replace(entries: readonly SetEntry[]): void {
    this.list = [];
    this.add(entries);
  }

  /** The label the set gives a prefab, if any. */
  labelFor(prefab: string): string | undefined {
    return this.list.find((x) => same(x.prefab, prefab))?.label;
  }

  /** The prefab a set label names (case-insensitive), if any. Labels only: names and cells resolve elsewhere. */
  resolve(label: string): string | undefined {
    return this.list.find((x) => same(x.label, label.trim()))?.prefab;
  }

  /** `set: corner tower = gothic_tower_a, gate_small` (piece 1, *Reminders*); "" while the set is empty. */
  reminderLine(): string {
    if (!this.list.length) return "";
    return `set: ${this.list.map((x) => (x.label ? `${x.label} = ${x.prefab}` : x.prefab)).join(", ")}`;
  }

  /** The whole set, one entry per line, as every component_set result shows it. */
  format(): string {
    if (!this.list.length) return "component set: empty";
    return [`component set (${this.list.length}):`, ...this.list.map((x, i) => `${i + 1}. ${x.label ? `${x.label} = ` : ""}${x.prefab}${x.notes ? ` — ${x.notes}` : ""}`)].join("\n");
  }
}

function tidy(e: SetEntry): SetEntry {
  const label = e.label?.trim();
  const notes = e.notes?.trim();
  return { prefab: e.prefab.trim(), ...(label ? { label } : {}), ...(notes ? { notes } : {}) };
}

/**
 * Library ids for the entries' prefab names (an id or a display name, case-insensitive, `axiom/…`
 * included). Unknown names are refused with the nearest names, so a typo never enters the set.
 */
export function canonicalEntries(all: readonly Prefab[], entries: readonly SetEntry[]): SetEntry[] {
  const bad: string[] = [];
  const out = entries.map((e) => {
    const p = lookupPrefab(all, e.prefab);
    if (!p) bad.push(unknownPrefab(all, e.prefab));
    return { ...e, prefab: p?.id ?? e.prefab };
  });
  if (bad.length) throw new Error(`${bad.join("; ")}. Nothing was changed; prefab_search shows what's there.`);
  return out;
}

/** Splits kit entries into known ones (with library ids) and warnings for the rest. */
export function knownEntries(all: readonly Prefab[], entries: readonly SetEntry[]): { entries: SetEntry[]; warnings: string[] } {
  const ok: SetEntry[] = [];
  const warnings: string[] = [];
  for (const e of entries) {
    const p = lookupPrefab(all, e.prefab);
    if (p) ok.push({ ...e, prefab: p.id });
    else warnings.push(`skipped ${unknownPrefab(all, e.prefab)}`);
  }
  return { entries: ok, warnings };
}

function lookupPrefab(all: readonly Prefab[], name: string): Prefab | undefined {
  const n = name.trim().toLowerCase();
  return all.find((x) => x.id.toLowerCase() === n) ?? all.find((x) => x.meta.name.toLowerCase() === n);
}

function unknownPrefab(all: readonly Prefab[], name: string): string {
  const near = nearestNames(name, all.map((p) => p.id));
  return `no prefab "${name}"${near.length ? ` (nearest: ${near.join(", ")})` : ""}`;
}

/**
 * Up to `max` names closest to `query`: names containing it (or contained in it) first, then by
 * edit distance, keeping only plausible typos (distance at most a third of the longer name, min 2).
 */
export function nearestNames(query: string, names: readonly string[], max = 5): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: [number, string][] = [];
  for (const name of names) {
    const n = name.toLowerCase();
    const leaf = n.split("/").pop()!;
    if (n.includes(q) || q.includes(leaf)) {
      scored.push([0, name]);
      continue;
    }
    const d = Math.min(editDistance(q, n), editDistance(q, leaf));
    if (d <= Math.max(2, Math.floor(Math.max(q.length, leaf.length) / 3))) scored.push([d, name]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length || (a[1] < b[1] ? -1 : 1));
  return scored.slice(0, max).map((x) => x[1]);
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}
